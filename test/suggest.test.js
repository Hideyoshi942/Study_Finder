import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { buildSuggestIndex } from '../lib/suggest.js';
import { expandQuery } from '../lib/query.js';
import { rankSuggestions, didYouMean } from '../public/suggest.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
const history = [{ keyword: 'distributed systems' }, { keyword: 'học máy' }];
const { items } = buildSuggestIndex(config, history);
const labels = (input, n = 8) => rankSuggestions(items, input, n).map((i) => i.label);
const queries = (input, n = 8) => rankSuggestions(items, input, n).map((i) => i.query);

test('index holds every kind', () => {
  const kinds = new Set(items.map((i) => i.kind));
  assert.deepEqual([...kinds].sort(), ['course', 'history', 'popular', 'topic', 'university']);
  const ml = items.find((i) => i.kind === 'topic' && i.query === 'machine learning');
  assert.match(ml.sub, /^Học máy · \d+ known courses$/);
  assert.match(ml.keys, /\bml\b/);
});

test('every topic and course is consistent with config', () => {
  const ids = new Set(config.topics.map((t) => t.id));
  for (const t of config.topics) for (const r of t.related) assert.ok(ids.has(r), `${t.id} -> ${r}`);
  for (const code of config.starterPath) assert.ok(config.courses.some((c) => c.code === code), code);
});

test('empty input shows recent then popular searches', () => {
  const r = rankSuggestions(items, '', 6);
  assert.deepEqual(r.slice(0, 2).map((i) => i.kind), ['history', 'history']);
  assert.equal(r[2].kind, 'popular');
  assert.ok(!r.slice(2).some((i) => i.query === 'distributed systems'), 'popular skips recent duplicates');
});

test('vietnamese with or without accents', () => {
  assert.equal(queries('hoc may')[0], 'học máy'); // recent search first
  const hocMa = queries('hoc ma');
  assert.ok(hocMa.indexOf('machine learning') < hocMa.indexOf('cryptography'), 'in-order phrase ranks first');
  assert.ok(queries('hệ điều').includes('operating systems'));
  assert.ok(queries('mat ma').includes('cryptography'));
});

test('course codes by prefix, with or without spaces', () => {
  const cs22 = queries('cs22');
  for (const c of ['CS221', 'CS224N', 'CS224W', 'CS229']) assert.ok(cs22.includes(c), c);
  assert.ok(queries('cs 229').includes('CS229'));
  assert.equal(queries('6.82')[0], '6.5840');
  assert.ok(queries('15-4').includes('15-445'));
});

test('abbreviations, universities and typos', () => {
  assert.equal(queries('ml')[0], 'machine learning');
  assert.ok(labels('stan').includes('Stanford'));
  assert.ok(queries('machin lerning').includes('machine learning'));
  assert.deepEqual(rankSuggestions(items, 'zzzzqqq'), []);
});

test('did you mean offers close topics', () => {
  const r = didYouMean(items, 'distribted sistems');
  assert.equal(r[0].query, 'distributed systems');
});

test('topic vietnamese labels also work as search keywords', () => {
  assert.equal(expandQuery('Mật mã học', config).main, 'cryptography');
  assert.equal(expandQuery('Ngôn ngữ lập trình', config).main, 'programming languages');
});
