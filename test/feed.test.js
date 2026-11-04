import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { createFeed, feedQueries } from '../lib/feed.js';
import { recommend, topicOf } from '../lib/suggest.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
const NOW = Date.parse('2026-11-04T00:00:00Z');

const repo = (fullName, description, stars, extra = {}) => {
  const [owner, name] = fullName.split('/');
  return { fullName, owner, name, url: `https://github.com/${fullName}`, description, stars, forks: 0,
    pushedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-20T00:00:00Z', archived: false, isFork: false,
    license: null, topics: [], language: null, ...extra };
};

const FRESH = [
  repo('a/ai-engineering-course', 'A free and complete AI Engineering Course', 629),
  repo('b/itsgiving', 'Express yourself in meetings (with memes, of course).', 1186),
  repo('c/lecture-pdf-tool', 'Turn lecture slides into study PDFs', 201),
];
const SEMESTER = [
  repo('x/CS336Spring-2026-Learning-Notes', 'Notes for Stanford CS336 spring 2026', 82),
  repo('y/Stanford-CS336', 'Stanford CS336: Language Modeling from Scratch', 71),
  repo('z/cs336-blog', 'CS336 2026 blog posts', 16),
  repo('w/cs61asummer2026mirror', 'CS61A Summer 2026 official course site offline mirror', 21),
  repo('v/cs61a-solutions', 'My solutions to CS61A homework', 30),
];

function fakeGitHub({ remaining = 9 } = {}) {
  const calls = [];
  return {
    calls,
    rateLimit: () => ({ remaining, limit: 10, resetAt: NOW + 30_000 }),
    async searchRepos(q) {
      calls.push(q);
      return { items: q.startsWith('course OR') ? FRESH : SEMESTER };
    },
  };
}

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'sf-feed-'));

test('feed queries: one fresh + two code batches with date filters', () => {
  const q = feedQueries(config, NOW);
  assert.equal(q.length, 3);
  assert.equal(q[0].q, 'course OR lecture OR syllabus created:>2026-09-05 stars:>=15');
  assert.match(q[1].q, /^"CS336" OR "CS224N" .* created:>2026-07-07 stars:>=3$/);
  assert.ok(q.every((x) => x.q.split(' OR ').length <= 6));
});

test('refresh builds sections, filters noise, caps per course and persists', async () => {
  const dataDir = await tmp();
  const gh = fakeGitHub();
  const feed = createFeed({ config, github: gh, dataDir, now: () => NOW });
  const s = await feed.refresh();
  assert.equal(gh.calls.length, 3);
  assert.deepEqual(s.fresh.map((r) => r.repo.name), ['ai-engineering-course', 'lecture-pdf-tool']);
  const semester = s.semester.map((r) => r.repo.name);
  assert.equal(semester.filter((n) => /336/i.test(n)).length, 2, 'max two repos per course');
  assert.ok(semester.includes('cs61asummer2026mirror'));
  assert.ok(!semester.includes('cs61a-solutions'), 'solution-only repos are hidden');

  // Persisted, and not refreshed again while fresh.
  const again = createFeed({ config, github: gh, dataDir, now: () => NOW + 3600_000 });
  assert.equal((await again.refresh()).fresh.length, 2);
  assert.equal(gh.calls.length, 3);
});

test('refresh is skipped when the shared budget is low', async () => {
  const gh = fakeGitHub({ remaining: 3 });
  const feed = createFeed({ config, github: gh, dataDir: await tmp(), now: () => NOW });
  const s = await feed.refresh();
  assert.equal(gh.calls.length, 0);
  assert.match(s.status, /Waiting for GitHub budget/);
  assert.deepEqual(s.fresh, []);
});

test('topicOf maps searches, codes and vietnamese to topics', () => {
  assert.equal(topicOf('distributed systems', config).id, 'distributed-systems');
  assert.equal(topicOf('học máy', config).id, 'machine-learning');
  assert.equal(topicOf('6.824', config).id, 'distributed-systems');
  assert.equal(topicOf('xyz', config), null);
});

test('recommend: related topics and their courses, skipping what was searched', () => {
  const r = recommend(config, [{ keyword: 'distributed systems' }, { keyword: 'CS162' }]);
  assert.deepEqual(r.basedOn, ['Distributed Systems', 'Operating Systems']);
  assert.ok(r.topics.some((t) => t.id === 'database-systems'));
  assert.ok(!r.topics.some((t) => t.id === 'distributed-systems'));
  assert.ok(r.courses.some((c) => c.topic === 'Database Systems'));
  assert.ok(!r.courses.some((c) => c.code === 'CS162'), 'already searched course is skipped');
  assert.match(r.courses[0].reason, /^Because you searched /);
  assert.ok(r.courses.length <= 8);
});

test('recommend mixes courses from every past search', () => {
  const r = recommend(config, [{ keyword: 'distributed systems' }, { keyword: 'học máy' }]);
  const reasons = new Set(r.courses.map((c) => c.reason));
  assert.deepEqual([...reasons].sort(), ['Because you searched Distributed Systems', 'Because you searched Machine Learning']);
  assert.equal(r.courses[0].reason, 'Because you searched Distributed Systems');
  assert.equal(r.courses[1].reason, 'Because you searched Machine Learning');
  assert.equal(new Set(r.courses.map((c) => c.topic)).size >= 4, true, 'several related topics appear');
});

test('recommend without history returns only the starter path', () => {
  const r = recommend(config, []);
  assert.deepEqual(r.courses, []);
  assert.deepEqual(r.starter.map((c) => c.code), config.starterPath);
  assert.equal(r.starter[0].universityName, 'Harvard');
});
