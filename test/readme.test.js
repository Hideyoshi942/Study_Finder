import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { analyzeReadme, createReadmeFetcher } from '../lib/readme.js';
import { enrich } from '../lib/enrich.js';
import { toResource } from '../lib/resource.js';
import { expandQuery } from '../lib/query.js';
import { createSearcher, missingCourses, followUpQuery } from '../lib/search.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
const NOW = Date.parse('2026-11-04T00:00:00Z');

const repo = (fullName, description = '', stars = 100, extra = {}) => {
  const [owner, name] = fullName.split('/');
  return { fullName, owner, name, url: `https://github.com/${fullName}`, description, stars, forks: 0,
    pushedAt: '2025-06-01T00:00:00Z', archived: false, isFork: false, license: null, topics: [], language: null, ...extra };
};

const EN = `# CMU 15-440: Distributed Systems (Fall 2024)

Course page: https://www.cs.cmu.edu/~15440/  Lecture videos: https://www.youtube.com/playlist?list=abc

## Lectures
- Lecture 1 slides https://example.com/l1.pdf
- Lecture 2 slides https://example.com/l2.pdf
- Lecture 3

## Assignments
Project 1, Project 2, Lab 1, Lab 2, Lab 3, homework 1. Midterm exam.
`;
const ZH = `# 分布式系统学习笔记\n\n这是我学习分布式系统课程的笔记，包括视频、作业和实验的总结。每一讲都有详细的讲义和思考题，适合初学者阅读和复习。https://www.bilibili.com/video/x\n`;
const VI = `# Ghi chú học máy\n\nĐây là tài liệu học máy bằng tiếng Việt, gồm bài giảng, bài tập và lời giải chi tiết cho từng chương. Mỗi chương có phần tóm tắt lý thuyết và ví dụ minh họa dễ hiểu cho người mới bắt đầu học.\n`;

test('analyzeReadme: heading, signals, university domains, language', () => {
  const a = analyzeReadme(EN, config);
  assert.equal(a.heading, 'CMU 15-440: Distributed Systems (Fall 2024)');
  assert.equal(a.signals.videos, 1);
  assert.equal(a.signals.pdfs, 2);
  assert.ok(a.signals.lectures >= 4);
  assert.ok(a.signals.assignments >= 5);
  assert.equal(a.signals.exams, 2); // "Midterm exam"
  assert.deepEqual(a.domains, ['cs.cmu.edu']);
  assert.equal(a.lang, 'en');
  assert.equal(analyzeReadme(ZH, config).lang, 'zh');
  assert.equal(analyzeReadme(ZH, config).signals.videos, 1);
  assert.equal(analyzeReadme(VI, config).lang, 'vi');
  assert.equal(analyzeReadme('<h1 align="center"><img src="x.png"> My <b>Course</b></h1>', config).heading, 'My Course');
});

test('fetcher: README.md, then readme.md, caches hits and misses, retries after network errors', async () => {
  const calls = [];
  const store = new Map();
  const cache = { async get(k) { return store.has(k) ? { value: store.get(k), fresh: true } : null; }, async set(k, v) { store.set(k, v); } };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('down/')) throw new Error('ECONNRESET');
    if (url.endsWith('a/one/HEAD/readme.md')) return new Response('# lower');
    return new Response('nope', { status: 404 });
  };
  const f = createReadmeFetcher({ cache, fetchImpl });
  assert.equal(await f.get('a/one'), '# lower');
  assert.equal(calls.length, 2);
  assert.equal(await f.get('a/one'), '# lower');
  assert.equal(calls.length, 2, 'cached');
  assert.equal(await f.get('b/none'), null);
  assert.equal(await f.get('b/none'), null);
  assert.equal(calls.length, 4, 'miss cached too');
  assert.equal(await f.get('c/down'), null);
  assert.ok(!store.has('readme:c/down'), 'network errors are not cached');
});

test('enrich: README heading and domain refine classification, types and score', async () => {
  const expanded = expandQuery('distributed systems', config);
  const make = (r) => toResource(r, ['general'], { config, expanded, now: NOW }).resource;
  const vague = make(repo('someone/ds-course', 'distributed systems course materials', 40));
  const plain = make(repo('other/ds-notes', 'distributed systems notes', 40));
  const before = vague.score;
  assert.equal(vague.university, null);
  const texts = { 'someone/ds-course': EN, 'other/ds-notes': null };
  const stats = await enrich([vague, plain], { readmes: { get: async (n) => texts[n] }, config, expanded, now: NOW });
  assert.deepEqual(stats, { read: 1, missing: 1 });
  assert.equal(vague.university, 'cmu');
  assert.equal(vague.courseCode, '15-440');
  assert.ok(vague.types.includes('videos') && vague.types.includes('lecture-notes') && vague.types.includes('assignments'));
  assert.equal(vague.lang, 'en');
  assert.ok(vague.score > before);
  assert.equal(plain.readme, undefined);

  // A README that only links a university domain sets the university (matched by readme).
  const linked = make(repo('x/ds-reading', 'distributed systems reading list notes', 40));
  await enrich([linked], { readmes: { get: async () => '# Reading list\nSee https://pdos.csail.mit.edu/6.824/ notes' }, config, expanded, now: NOW });
  assert.equal(linked.university, 'mit');

  // Curated lists and READMEs linking several schools do not get a university from links.
  const list = make(repo('y/awesome-distributed-systems', 'A curated list to learn about distributed systems', 9000));
  await enrich([list], { readmes: { get: async () => '# Awesome\nhttps://pdos.csail.mit.edu/6.824/' }, config, expanded, now: NOW });
  assert.equal(list.university, null);
  const many = make(repo('z/ds-reading', 'distributed systems reading list notes', 40));
  await enrich([many], { readmes: { get: async () => '# Reading\nhttps://pdos.csail.mit.edu/x https://www.cs.cmu.edu/y' }, config, expanded, now: NOW });
  assert.equal(many.university, null);
});

test('follow-up query asks only for courses with no results', () => {
  const expanded = expandQuery('distributed systems', config);
  const found = new Map([['a/6.824', { repo: repo('a/MIT-6.824', 'MIT 6.824 labs'), foundBy: new Set(['code']) }]]);
  const missing = missingCourses(found, expanded, config).map((c) => c.code);
  assert.ok(!missing.includes('6.5840'));
  assert.ok(missing.includes('15-440'));
  const q = followUpQuery(missingCourses(found, expanded, config), config);
  assert.match(q.q, /"15-440"/);
  assert.ok(!q.q.includes('"6.5840"'));
});

test('searcher runs the follow-up when budget allows, and skips it when low', async () => {
  const mk = (remaining) => {
    const calls = [];
    return {
      calls,
      rateLimit: () => ({ remaining, limit: 10, resetAt: 0 }),
      async searchRepos(q, { perPage }) {
        calls.push({ q, perPage });
        if (q.includes('"15-440"') && !q.includes('6.5840')) return { items: [repo('cmu/15-440-labs', 'CMU 15-440 distributed systems labs', 30)] };
        return { items: [repo('a/MIT-6.824', 'MIT 6.824 distributed systems labs', 3000)] };
      },
    };
  };
  const gh = mk(9);
  const s = await createSearcher({ config, github: gh, now: () => NOW }).search('distributed systems');
  assert.equal(gh.calls.length, 7);
  assert.equal(gh.calls.find((c) => c.q.startsWith('"6.5840"')).perPage, 100);
  assert.ok(s.cards.some((c) => c.key === 'cmu:15-440'));

  const low = mk(2);
  await createSearcher({ config, github: low, now: () => NOW }).search('distributed systems');
  assert.equal(low.calls.length, 6);
});
