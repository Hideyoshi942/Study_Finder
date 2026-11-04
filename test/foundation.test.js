import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic, slugify } from '../lib/store.js';
import { createCache } from '../lib/cache.js';
import { normalize, tokenize, wordRegex, codeRegex } from '../lib/text.js';
import { loadConfig } from '../lib/config.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'sf-'));

test('store: round trip and missing file fallback', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'a', 'b.json');
  assert.deepEqual(await readJson(file, { empty: true }), { empty: true });
  await writeJsonAtomic(file, { x: 1 });
  assert.deepEqual(await readJson(file, null), { x: 1 });
});

test('store: corrupt file returns fallback and is moved aside', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'bad.json');
  await writeFile(file, '{not json');
  assert.deepEqual(await readJson(file, []), []);
  const names = await readdir(dir);
  assert.ok(names.some((n) => n.startsWith('bad.json.corrupt-')));
});

test('slugify handles latin, accent-stripped and non-latin keywords', () => {
  assert.equal(slugify('distributed systems'), 'distributed-systems');
  assert.equal(slugify(normalize('Hệ Điều Hành')), 'he-dieu-hanh');
  assert.match(slugify('分布式系统'), /^q-[0-9a-f]{10}$/);
});

test('cache: fresh, stale and prune', async () => {
  const dir = await tmp();
  let t = 1_000_000;
  const cache = createCache({ dir, ttlMs: 1000, now: () => t });
  assert.equal(await cache.get('k'), null);
  await cache.set('k', { v: 1 }, 'W/"e1"');
  assert.deepEqual(await cache.get('k'), { value: { v: 1 }, etag: 'W/"e1"', fresh: true });
  t += 2000;
  assert.equal((await cache.get('k')).fresh, false);

  const [name] = await readdir(dir);
  const old = new Date(Date.now() - 10 * 86400_000);
  await utimes(path.join(dir, name), old, old);
  const real = createCache({ dir, ttlMs: 1000 });
  assert.equal(await real.prune(86400_000), 1);
  assert.equal((await readdir(dir)).length, 0);
});

test('text: normalize, tokenize and word boundaries', () => {
  assert.equal(normalize('  Hệ   Điều Hành '), 'he dieu hanh');
  assert.deepEqual(tokenize('MIT 6.824: Distributed-Systems.'), ['mit', '6.824', 'distributed', 'systems']);
  assert.ok(wordRegex('mit').test('MIT 6.824 labs'));
  assert.ok(!wordRegex('mit').test('a commit linter'));
  assert.ok(wordRegex('uc berkeley').test('UC-Berkeley course'));
});

test('text: loose course code matching', () => {
  assert.ok(codeRegex('CS61B').test('berkeley cs 61b'));
  assert.ok(codeRegex('CS61B').test('CS-61B labs'));
  assert.ok(!codeRegex('CS61B').test('cs61bx'));
  assert.ok(codeRegex('6.824').test('mit6.824 labs'));
  assert.ok(!codeRegex('6.824').test('16.8241'));
  assert.ok(codeRegex('6.824').test('mit6824 raft'));
  assert.ok(!codeRegex('6.824').test('port 6824'));
  assert.ok(codeRegex('15-445').test('cmu15445 bustub'));
  assert.ok(codeRegex('6.S081').test('6.s081 xv6'));
});

test('config.json loads and is well-formed', async () => {
  const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
  const ids = new Set(config.universities.map((u) => u.id));
  for (const c of config.courses) assert.ok(ids.has(c.university), `unknown university in ${c.code}`);
  assert.equal(config.port, 4322);
});
