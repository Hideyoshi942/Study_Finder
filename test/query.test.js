import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { expandQuery } from '../lib/query.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
const kinds = (r) => r.queries.map((q) => q.kind);

test('abbreviation expands to the full term', () => {
  const r = expandQuery('ML', config);
  assert.equal(r.main, 'machine learning');
  assert.deepEqual(r.terms, ['machine learning', 'ml']);
  assert.ok(r.codes.includes('CS229'));
  assert.equal(r.queries[0].q, 'machine learning course stars:>=20');
});

test('abbreviation inside a phrase, but long words only on exact match', () => {
  assert.equal(expandQuery('ml course', config).main, 'machine learning course');
  assert.equal(expandQuery('neural network', config).main, 'neural network');
  assert.equal(expandQuery('network', config).main, 'computer networks');
});

test('vietnamese keyword maps to english and finds course codes', () => {
  const r = expandQuery('Hệ Điều Hành', config);
  assert.equal(r.normalized, 'he dieu hanh');
  assert.equal(r.main, 'operating systems');
  assert.ok(r.codes.includes('6.1810'));
  assert.ok(r.codes.includes('CS162'));
});

test('topic keyword adds an OR query of course codes', () => {
  const r = expandQuery('distributed systems', config);
  assert.ok(r.codes.includes('6.5840') && r.codes.includes('6.824') && r.codes.includes('15-440'));
  const code = r.queries.find((q) => q.kind === 'code');
  assert.match(code.q, /^"6\.5840" OR "6\.824" OR /);
  assert.ok(code.q.endsWith('stars:>=5'));
  assert.equal(r.queries.length, 6);
  assert.deepEqual(kinds(r), ['course', 'lecture', 'general', 'awesome', 'topic', 'code']);
  const ors = code.q.split(' OR ').length - 1;
  assert.ok(ors <= 4, 'GitHub allows at most 5 boolean operators');
});

test('a course code keyword searches the code first and uses the course title', () => {
  const r = expandQuery('6.824', config);
  assert.equal(r.queries[0].kind, 'code');
  assert.match(r.queries[0].q, /"6\.5840" OR "6\.824"/);
  assert.equal(r.main, 'distributed systems');
  assert.ok(r.terms.includes('6.824'));
  assert.equal(r.queries.length, 6);
});

test('empty keyword throws', () => {
  assert.throws(() => expandQuery('   ', config), /empty/);
});
