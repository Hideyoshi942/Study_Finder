import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, RateLimitError } from '../lib/github.js';

const item = (name, extra = {}) => ({
  full_name: `owner/${name}`, name, owner: { login: 'owner' }, html_url: `https://github.com/owner/${name}`,
  description: 'desc', stargazers_count: 10, forks_count: 1, pushed_at: '2025-01-01T00:00:00Z',
  archived: false, fork: false, license: { spdx_id: 'MIT' }, topics: ['course'], language: 'Go', ...extra,
});

function respond(status, body, { remaining = 9, reset = 2_000, etag = null } = {}) {
  const headers = { 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-limit': '10', 'x-ratelimit-reset': String(reset) };
  if (etag) headers.etag = etag;
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
}

function memoryCache(now) {
  const m = new Map();
  return {
    m,
    async get(k) { const e = m.get(k); return e ? { value: e.value, etag: e.etag, fresh: now() - e.savedAt < 1000 } : null; },
    async set(k, value, etag = null) { m.set(k, { value, etag, savedAt: now() }); },
  };
}

test('maps items and sends the token only when set', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(opts.headers); return respond(200, { total_count: 1, items: [item('a')] }); };
  const gh = createGitHub({ token: 'tok', fetchImpl, sleep: async () => {} });
  const r = await gh.searchRepos('x');
  assert.equal(r.items[0].fullName, 'owner/a');
  assert.equal(r.items[0].stars, 10);
  assert.equal(r.items[0].license, 'MIT');
  assert.equal(calls[0].Authorization, 'Bearer tok');
  assert.equal(gh.rateLimit().remaining, 9);

  const anon = createGitHub({ fetchImpl, sleep: async () => {} });
  await anon.searchRepos('x');
  assert.equal(calls[1].Authorization, undefined);
});

test('fresh cache hit makes no request; stale hit revalidates with ETag and 304', async () => {
  let t = 0;
  const cache = memoryCache(() => t);
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push(opts.headers['If-None-Match']);
    return seen.length === 1 ? respond(200, { total_count: 1, items: [item('a')] }, { etag: '"e1"' }) : respond(304);
  };
  const gh = createGitHub({ cache, fetchImpl, sleep: async () => {}, now: () => t });
  await gh.searchRepos('x');
  const again = await gh.searchRepos('x');
  assert.equal(seen.length, 1);
  assert.equal(again.fromCache, true);
  t = 5000;
  const revalidated = await gh.searchRepos('x');
  assert.deepEqual(seen, [undefined, '"e1"']);
  assert.equal(revalidated.items[0].fullName, 'owner/a');
});

test('retries 5xx then succeeds', async () => {
  let n = 0;
  const sleeps = [];
  const fetchImpl = async () => (++n < 3 ? respond(502, {}) : respond(200, { items: [item('a')] }));
  const gh = createGitHub({ fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  const r = await gh.searchRepos('x');
  assert.equal(r.items.length, 1);
  assert.deepEqual(sleeps, [1000, 3000]);
});

test('throws RateLimitError when reset is far away', async () => {
  const now = () => 1_000_000;
  const fetchImpl = async () => respond(403, { message: 'rate limit' }, { remaining: 0, reset: 1_000_000 / 1000 + 600 });
  const gh = createGitHub({ fetchImpl, sleep: async () => {}, now });
  await assert.rejects(gh.searchRepos('x'), RateLimitError);
});

test('sleeps through a short reset and then retries', async () => {
  let t = 1_000_000;
  let n = 0;
  const sleeps = [];
  const fetchImpl = async () => (++n === 1
    ? respond(403, {}, { remaining: 0, reset: (t + 10_000) / 1000 })
    : respond(200, { items: [item('a')] }));
  const gh = createGitHub({ fetchImpl, sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t });
  const r = await gh.searchRepos('x');
  assert.equal(r.items.length, 1);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 10_000);
});

test('surfaces non-retryable errors', async () => {
  const gh = createGitHub({ fetchImpl: async () => respond(422, { message: 'bad query' }), sleep: async () => {} });
  await assert.rejects(gh.searchRepos('x'), /GitHub 422/);
});
