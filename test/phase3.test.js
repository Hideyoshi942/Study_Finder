import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { createApp } from '../lib/app.js';
import { createWatcher } from '../lib/watch.js';
import { checkLink } from '../lib/links.js';
import { writeJsonAtomic } from '../lib/store.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
let server, base, dataDir;

const fakeLinkFetch = async (url, { method }) => {
  if (url.includes('gone')) return new Response(null, { status: 404 });
  if (url.includes('nodns')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nodns.example' } });
  if (url.includes('headless') && method === 'HEAD') return new Response(null, { status: 405 });
  return new Response('ok', { status: 200 });
};

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sf-p3-'));
  const publicDir = path.join(dataDir, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html>');
  const searcher = { search: async () => { throw new Error('not used'); } };
  const github = { authenticated: false, rateLimit: () => null };
  server = http.createServer(createApp({ config, searcher, github, dataDir: path.join(dataDir, 'data'), publicDir, linkCheckOptions: { fetchImpl: fakeLinkFetch } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, p, body, headers = { 'Content-Type': 'application/json' }) => {
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

const snapshot = { title: 'chaozh/MIT-6.824', url: 'https://github.com/chaozh/MIT-6.824', universityName: 'MIT', courseCode: '6.5840', stars: 3260, types: ['course'] };

test('collections: create, add, progress, note, rename, remove item, delete', async () => {
  const c = (await call('POST', '/api/collections', { name: 'Distributed systems plan' })).body;
  assert.match(c.id, /^c-[a-f0-9]{10}$/);

  let r = await call('PUT', `/api/collections/${c.id}/items`, { resourceId: 'gh:chaozh/mit-6.824', snapshot });
  assert.equal(r.status, 200);
  assert.equal(r.body.items[0].status, 'todo');
  r = await call('PUT', `/api/collections/${c.id}/items`, { resourceId: 'gh:chaozh/mit-6.824', status: 'learning', note: 'Lab 2 next' });
  assert.equal(r.body.items.length, 1, 'same resource is updated, not duplicated');
  assert.deepEqual([r.body.items[0].status, r.body.items[0].note], ['learning', 'Lab 2 next']);

  assert.equal((await call('PATCH', `/api/collections/${c.id}`, { name: 'DS' })).body.name, 'DS');
  assert.equal((await call('GET', '/api/collections', undefined, {})).body[0].name, 'DS');
  assert.equal((await call('POST', `/api/collections/${c.id}/items/delete`, { resourceId: 'gh:chaozh/mit-6.824' })).body.items.length, 0);
  assert.deepEqual((await call('DELETE', `/api/collections/${c.id}`, {})).body, { ok: true });
  assert.deepEqual((await call('GET', '/api/collections', undefined, {})).body, []);
});

test('collections: validation and write protection', async () => {
  const c = (await call('POST', '/api/collections', { name: 'x' })).body;
  assert.equal((await call('POST', '/api/collections', { name: '' })).status, 400);
  assert.equal((await call('PUT', `/api/collections/${c.id}/items`, { resourceId: 'a', status: 'todo', snapshot: { url: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call('PUT', `/api/collections/${c.id}/items`, { resourceId: 'a', snapshot, status: 'finished' })).status, 400);
  assert.equal((await call('PUT', '/api/collections/c-0000000000/items', { resourceId: 'a', snapshot })).status, 400);
  // A plain form post (text/plain) and a foreign Origin are refused.
  assert.equal((await call('POST', '/api/collections', { name: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call('POST', '/api/collections', { name: 'x' }, { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status, 403);
  const big = await fetch(`${base}/api/collections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(70_000) }) });
  assert.equal(big.status, 413);
});

test('watcher: first run records, later runs report new results, low budget waits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-watch-'));
  let t = Date.parse('2026-11-04T00:00:00Z');
  let results = ['gh:a', 'gh:b'];
  let remaining = 9;
  const runs = [];
  const w = createWatcher({
    file: path.join(dir, 'watches.json'),
    runSearch: async (q, refresh) => { runs.push([q, refresh]); return { resources: Object.fromEntries(results.map((id) => [id, {}])) }; },
    getSaved: async () => null,
    github: { rateLimit: () => ({ remaining, resetAt: t + 30_000 }) },
    now: () => t,
  });
  const added = await w.add('distributed systems', 24);
  assert.equal(added.id, 'distributed-systems');
  assert.equal(added.knownIds, undefined, 'internal ids are not exposed');

  await w.tick();
  assert.deepEqual(runs, [['distributed systems', true]]);
  assert.equal((await w.list())[0].newCount, 0, 'first run only records');

  assert.equal(await w.tick(), null, 'not due yet');
  t += 25 * 3600_000;
  results = ['gh:a', 'gh:b', 'gh:c'];
  remaining = 3;
  assert.equal(await w.tick(), null, 'waits for budget');
  remaining = 9;
  await w.tick();
  assert.deepEqual(await w.getNew('distributed-systems'), ['gh:c']);
  assert.equal((await w.markSeen('distributed-systems')).newCount, 0);
  await w.remove('distributed-systems');
  assert.deepEqual(await w.list(), []);
});

test('watch: existing saved results are not reported as new', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-watch2-'));
  let t = Date.parse('2026-11-04T00:00:00Z');
  const w = createWatcher({
    file: path.join(dir, 'w.json'),
    runSearch: async () => ({ resources: { 'gh:a': {}, 'gh:new': {} } }),
    getSaved: async () => ({ createdAt: '2026-11-03T00:00:00Z', resources: { 'gh:a': {} } }),
    github: null,
    now: () => t,
  });
  await w.add('compilers', 12);
  await w.tick();
  assert.deepEqual(await w.getNew('compilers'), ['gh:new']);
});

test('checkLink: ok, 404, DNS failure, HEAD not allowed falls back to GET', async () => {
  const o = { fetchImpl: fakeLinkFetch };
  assert.equal((await checkLink('https://ok.example/', o)).status, 'ok');
  assert.deepEqual(await checkLink('https://gone.example/', o), { status: 'broken', code: 404 });
  assert.deepEqual(await checkLink('https://nodns.example/', o), { status: 'broken', code: 'DNS' });
  assert.equal((await checkLink('https://headless.example/', o)).status, 'ok');
  const slow = { fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } };
  assert.deepEqual(await checkLink('https://slow.example/', slow), { status: 'unknown', code: 'timeout' });
});

test('check-links route stores status on curated links of a saved search', async () => {
  const ext = (id, url) => ({ id, kind: 'external', url, title: id, types: ['course'] });
  await writeJsonAtomic(path.join(dataDir, 'data', 'searches', 'compilers.json'), {
    id: 'compilers', keyword: 'compilers', createdAt: '2026-11-04T00:00:00Z', expandedQueries: [],
    resources: { a: ext('a', 'https://ok.example/c'), b: ext('b', 'https://gone.example/c'), r: { id: 'r', repo: { stars: 1 }, url: 'https://github.com/x/y', types: [] } },
    cards: [], awesome: [], sites: ['a', 'b'], other: ['r'], warnings: [],
  });
  const r = await call('POST', '/api/check-links/compilers', {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.checked, r.body.broken], [2, 1]);
  assert.equal(r.body.search.resources.b.linkStatus.status, 'broken');
  assert.equal(r.body.search.resources.r.linkStatus, undefined, 'repos are not checked');
  const saved = (await call('GET', '/api/searches/compilers', undefined, {})).body;
  assert.equal(saved.resources.a.linkStatus.status, 'ok');
});
