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
    repo('x/react-kit', 'UI kit', 50000)],
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
  assert.deepEqual(s.resources['gh:chaozh/mit-6.824'].foundBy.sort(), ['course', 'topic']);
  assert.ok(s.resources['gh:huihongxiao/mit6.824'], 'code-query result with empty description is kept');
  assert.equal(s.cards[0].key, 'mit:6.5840');
  assert.equal(s.cards[0].title, 'Distributed Systems');
  assert.equal(s.cards[0].resourceIds.length, 3);
  assert.ok(s.cards.some((c) => c.key === 'cmu:15-440'));
  assert.deepEqual(s.awesome, ['gh:theanalyst/awesome-distributed-systems']);
  assert.ok(s.other.includes('gh:pingcap/talent-plan'));
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

test('pipeline: total failure returns an empty search, not an exception', async () => {
  const s = await createSearcher({ config, github: fakeGitHub({ failOn: 'all' }), now: NOW }).search('distributed systems');
  assert.equal(Object.keys(s.resources).length, 0);
  assert.equal(s.warnings.length, 6);
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
  assert.deepEqual(g.awesome, ['c']);
  assert.deepEqual(g.other, ['d']);
});
