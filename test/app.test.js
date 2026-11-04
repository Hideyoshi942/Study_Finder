import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));

let server, base, calls, dataDir, nextEmpty;

const fakeSearch = (q) => ({
  id: q.replace(/\s+/g, '-'), keyword: q, normalized: q, createdAt: '2026-11-04T00:00:00Z',
  expandedQueries: [`${q} course`], warnings: [],
  resources: nextEmpty ? {} : { a: { id: 'a', title: 'a', url: 'https://github.com/a', description: '', types: [], repo: { stars: 5 } } },
  cards: [], awesome: [], other: nextEmpty ? [] : ['a'],
});

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sf-app-'));
  const publicDir = path.join(dataDir, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>t</title>');
  calls = 0;
  const searcher = {
    search: async (q, { onEvent } = {}) => {
      calls++;
      onEvent?.({ type: 'queries', queries: [`${q} course`] });
      await new Promise((r) => setTimeout(r, 20));
      onEvent?.({ type: 'progress', stage: 'search', done: 1, total: 1 });
      onEvent?.({ type: 'partial', search: { ...fakeSearch(q), partial: true } });
      return fakeSearch(q);
    },
  };
  const github = { authenticated: false, rateLimit: () => ({ remaining: 7, limit: 10, resetAt: 1 }) };
  server = http.createServer(createApp({ config, searcher, github, dataDir: path.join(dataDir, 'data'), publicDir }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = async (p) => {
  const res = await fetch(base + p);
  const type = res.headers.get('content-type') ?? '';
  return { res, body: type.includes('json') ? await res.json() : await res.text() };
};

test('validates the keyword', async () => {
  assert.equal((await get('/api/search?q=')).res.status, 400);
  assert.equal((await get(`/api/search?q=${'x'.repeat(101)}`)).res.status, 400);
});

test('runs once, then serves the saved search; refresh re-runs; concurrent calls share one run', async () => {
  const [a, b] = await Promise.all([get('/api/search?q=distributed%20systems'), get('/api/search?q=distributed%20systems')]);
  assert.equal(calls, 1);
  assert.equal(a.body.cached, false);
  assert.equal(b.body.id, 'distributed-systems');
  const again = await get('/api/search?q=Distributed%20Systems');
  assert.equal(calls, 1);
  assert.equal(again.body.cached, true);
  await get('/api/search?q=distributed%20systems&refresh=1');
  assert.equal(calls, 2);
});

test('an empty result never overwrites a saved search', async () => {
  nextEmpty = true;
  const r = await get('/api/search?q=distributed%20systems&refresh=1');
  nextEmpty = false;
  assert.equal(r.body.cached, true);
  assert.ok(r.body.warnings.includes('Showing the last saved results.'));
  assert.ok(r.body.resources.a);
});

test('history, saved search, export and rate limit', async () => {
  await get('/api/search?q=compilers');
  const history = (await get('/api/searches')).body;
  assert.deepEqual(history.map((h) => h.id), ['compilers', 'distributed-systems']);
  assert.deepEqual(history[0].counts, { cards: 0, sites: 0, awesome: 0, other: 1 });

  assert.equal((await get('/api/searches/compilers')).body.keyword, 'compilers');
  assert.equal((await get('/api/searches/nope')).res.status, 404);
  assert.equal((await get('/api/searches/..%2Fx')).res.status, 400);

  const exp = await get('/api/export/compilers?format=md');
  assert.equal(exp.res.headers.get('content-disposition'), 'attachment; filename="compilers.md"');
  assert.match(exp.body, /^# Study resources: compilers/);
  assert.equal((await get('/api/export/compilers?format=pdf')).res.status, 400);

  assert.deepEqual((await get('/api/rate-limit')).body, { authenticated: false, remaining: 7, limit: 10, resetAt: 1 });
});

const sse = (text) => text.trim().split('\n\n').filter((b) => b.startsWith('event:')).map((b) => {
  const [, type] = b.match(/^event: (.+)$/m);
  return { type, data: JSON.parse(b.match(/^data: (.+)$/m)[1]) };
});

test('stream: events in order, then done; a saved search answers with done only', async () => {
  const first = await get('/api/search/stream?q=operating%20systems');
  assert.equal(first.res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = sse(first.body);
  assert.deepEqual(events.map((e) => e.type), ['queries', 'progress', 'partial', 'done']);
  assert.equal(events.at(-1).data.id, 'operating-systems');
  assert.ok('related' in events.at(-1).data);

  const again = sse((await get('/api/search/stream?q=operating%20systems')).body);
  assert.deepEqual(again.map((e) => e.type), ['done']);
  assert.equal(again[0].data.cached, true);
  assert.equal((await get('/api/search/stream?q=')).res.status, 400);
});

test('home and suggestion index', async () => {
  const home = (await get('/api/home')).body;
  assert.deepEqual(Object.keys(home), ['popular', 'topics', 'feed', 'recommendations']);
  assert.equal(home.feed, null);
  assert.ok(Array.isArray(home.recommendations.starter));
  const idx = (await get('/api/suggest-index')).body;
  assert.ok(idx.items.some((i) => i.kind === 'history' && i.query === 'compilers'));
});

test('static html has a CSP; unknown routes 404', async () => {
  const { res } = await get('/');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await get('/nope')).res.status, 404);
});
