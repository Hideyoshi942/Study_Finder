import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { createSearcher } from '../lib/search.js';
import { group } from '../lib/group.js';
import { RateLimitError } from '../lib/github.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
const NOW = () => Date.parse('2026-11-04T00:00:00Z');

const repo = (fullName, description, stars = 100, extra = {}) => {
  const [owner, name] = fullName.split('/');
  return { fullName, owner, name, url: `https://github.com/${fullName}`, description, stars, forks: 0,
    pushedAt: '2025-06-01T00:00:00Z', archived: false, isFork: false, license: null, topics: [], language: 'Go', ...extra };
};

// Responses keyed by query kind; shaped like real results for "distributed systems".
const FIXTURE = {
  course: [repo('chaozh/MIT-6.824', 'Basic Sources for MIT 6.824 Distributed Systems Class', 3260),
    repo('x/distributed-systems-course', 'A distributed systems course with labs', 400)],
  lecture: [repo('alinush/6.824-lecture-notes', '6.824 Distributed Systems: Lecture notes', 228)],
  general: [repo('cirosantilli/china-dictatorship', 'distributed systems spam', 3310),
    repo('pingcap/talent-plan', 'open source training courses about distributed database and distributed systems', 11035),
    repo('x/react-kit', 'UI kit', 50000),
    repo('mirror/dictatroship-7', `distributed systems ${'propaganda '.repeat(200)}`, 383),
    repo('redis/redis', 'The preferred, fastest in-memory data store', 70000, { topics: ['distributed-systems', 'database'] })],
  awesome: [repo('theanalyst/awesome-distributed-systems', 'A curated list to learn about distributed systems', 9000)],
  topic: [repo('chaozh/MIT-6.824', 'Basic Sources for MIT 6.824 Distributed Systems Class', 3260)],
  code: [repo('huihongxiao/MIT6.824', '', 445), repo('someone/15-440-p1', 'project 1', 12)],
};

function fakeGitHub({ failOn = null, rateLimitOn = null } = {}) {
  const calls = [];
  return {
    calls,
    rateLimit: () => ({ remaining: 3, limit: 10, resetAt: 0 }),
    async searchRepos(q) {
      const resolved = q.startsWith('"') ? 'code' : q.startsWith('awesome') ? 'awesome' : q.startsWith('topic:') ? 'topic'
        : q.includes(' course ') ? 'course' : q.includes(' lecture ') ? 'lecture' : 'general';
      calls.push(resolved);
      if (resolved === rateLimitOn) throw new RateLimitError(NOW() + 3_600_000);
      if (resolved === failOn || failOn === 'all') throw new Error('boom');
      return { items: FIXTURE[resolved], total: FIXTURE[resolved].length };
    },
  };
}

test('pipeline: merges, filters spam and irrelevant repos, builds MIT card first', async () => {
  const s = await createSearcher({ config, github: fakeGitHub(), now: NOW }).search('distributed systems');
  assert.equal(s.id, 'distributed-systems');
  assert.equal(s.warnings.length, 0);
  assert.ok(!s.resources['gh:cirosantilli/china-dictatorship'], 'blocked repo removed');
  assert.ok(!s.resources['gh:x/react-kit'], 'irrelevant repo removed');
  assert.ok(!s.resources['gh:mirror/dictatroship-7'], 'keyword-stuffed description removed');
  assert.ok(!s.resources['gh:redis/redis'], 'software project without learning signals removed');
  assert.deepEqual([s.stats.spam, s.stats.irrelevant, s.stats.notLearning], [2, 1, 1]);
  assert.deepEqual(s.resources['gh:chaozh/mit-6.824'].foundBy.sort(), ['course', 'topic']);
  assert.ok(s.resources['gh:huihongxiao/mit6.824'], 'code-query result with empty description is kept');
  assert.equal(s.cards[0].key, 'mit:6.5840');
  assert.equal(s.cards[0].title, 'Distributed Systems');
  assert.equal(s.cards[0].resourceIds.length, 3);
  assert.ok(s.cards.some((c) => c.key === 'cmu:15-440'));
  assert.deepEqual(s.awesome, ['gh:theanalyst/awesome-distributed-systems']);
  assert.ok(s.other.includes('gh:pingcap/talent-plan'));
});

test('pipeline: emits queries, progress and partial events in order', async () => {
  const events = [];
  const s = await createSearcher({ config, github: fakeGitHub(), now: NOW }).search('distributed systems', { onEvent: (e) => events.push(e) });
  assert.equal(events[0].type, 'queries');
  assert.equal(events[0].queries.length, 6);
  const progress = events.filter((e) => e.type === 'progress' && e.stage === 'search');
  // 6 queries, plus the follow-up for courses with no results.
  assert.deepEqual(progress.map((e) => e.done), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(progress.at(-1).total, 7);
  const partials = events.filter((e) => e.type === 'partial');
  assert.equal(partials.length, 7);
  assert.ok(partials[0].search.partial);
  assert.ok(Object.keys(partials[0].search.resources).length <= Object.keys(partials.at(-1).search.resources).length);
  assert.equal(s.partial, undefined, 'the final search is not marked partial');
  // A throwing listener does not break the search.
  await createSearcher({ config, github: fakeGitHub(), now: NOW }).search('distributed systems', { onEvent: () => { throw new Error('x'); } });
});

test('pipeline: a failing query adds a warning and the rest continue', async () => {
  const s = await createSearcher({ config, github: fakeGitHub({ failOn: 'lecture' }), now: NOW }).search('distributed systems');
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /failed: boom/);
  assert.ok(s.cards.length > 0);
});

test('pipeline: rate limit stops remaining queries with partial results', async () => {
  const gh = fakeGitHub({ rateLimitOn: 'general' });
  const s = await createSearcher({ config, github: gh, now: NOW }).search('distributed systems');
  assert.deepEqual(gh.calls, ['course', 'lecture', 'general']);
  assert.match(s.warnings[0], /rate limit/);
  assert.ok(s.resources['gh:chaozh/mit-6.824']);
});

test('pipeline: two failures in a row stop the search with an empty result, not an exception', async () => {
  const gh = fakeGitHub({ failOn: 'all' });
  const s = await createSearcher({ config, github: gh, now: NOW }).search('distributed systems');
  assert.equal(Object.keys(s.resources).length, 0);
  assert.equal(gh.calls.length, 2);
  assert.match(s.warnings.at(-1), /unreachable/);
});

test('group: drops forks of present originals and routes awesome lists', () => {
  const r = (id, extra) => ({ id, score: 50, types: [], university: null, courseCode: null, repo: { name: id, isFork: false }, ...extra });
  const g = group([
    r('a', { repo: { name: 'labs', isFork: false }, university: 'mit', courseCode: '6.5840', courseTitle: 'DS', score: 70, types: ['course'] }),
    r('b', { repo: { name: 'labs', isFork: true }, university: 'mit', courseCode: '6.5840', score: 60 }),
    r('c', { types: ['awesome-list'], score: 40 }),
    r('d', { score: 90 }),
  ]);
  assert.equal(g.cards.length, 1);
  assert.deepEqual(g.cards[0].resourceIds, ['a']);
  assert.equal(g.droppedForks, 1);
  const unknown = group([r('e', { university: 'harvard', courseCode: 'CS249R', description: 'Machine Learning Systems. A book.', repo: { name: 'cs249r_book' } })]);
  assert.equal(unknown.cards[0].title, 'Machine Learning Systems');
  const long = group([r('g', { university: 'harvard', courseCode: 'CS249R', description: `Machine Learning Systems: ${'very long subtitle '.repeat(6)}• Harvard CS249r | https://mlsysbook.ai`, repo: { name: 'cs249r_book' } })]);
  assert.equal(long.cards[0].title, 'Machine Learning Systems');
  const noDesc = group([r('f', { university: 'harvard', courseCode: 'CS249R', description: '', repo: { name: 'cs249r_book' } })]);
  assert.equal(noDesc.cards[0].title, 'cs249r_book');
  assert.deepEqual(g.awesome, ['c']);
  assert.deepEqual(g.other, ['d']);
});
