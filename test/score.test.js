import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { classify } from '../lib/classify.js';
import { relevance, score, freshness, isSolutionsOnly } from '../lib/score.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
const NOW = Date.parse('2026-11-04T00:00:00Z');
const q = { terms: ['distributed systems'], codes: ['6.5840', '6.824', '15-440'] };

const repo = (fullName, description, extra = {}) => {
  const [owner, name] = fullName.split('/');
  return { fullName, owner, name, description, topics: [], stars: 100, pushedAt: '2026-06-01T00:00:00Z', isFork: false, ...extra };
};
const rank = (r) => {
  const cls = classify(r, config);
  return score(r, cls, relevance(r, q, cls), config, NOW);
};

test('relevance: unrelated is 0, partial words count less, code match is 1', () => {
  const none = repo('x/react-kit', 'UI components');
  assert.equal(relevance(none, q, classify(none, config)), 0);
  const one = repo('x/systems-programming', 'low level stuff');
  assert.equal(relevance(one, q, classify(one, config)), 0.5);
  const camel = repo('x/DistributedSystem', '');
  assert.equal(relevance(camel, q, classify(camel, config)), 1);
  const code = repo('x/6.824-golabs', '');
  assert.equal(relevance(code, q, classify(code, config)), 1);
});

test('an official, relevant course outranks a more-starred loosely related repo', () => {
  const official = repo('mit-pdos/6.5840-labs', 'MIT 6.5840 distributed systems labs', { stars: 800 });
  const popular = repo('x/systems-design', 'distributed design primer', { stars: 40000 });
  assert.ok(rank(official).score > rank(popular).score);
});

test('fork, solutions-only and missing description are penalized', () => {
  const base = repo('x/6.824', 'MIT 6.824 lecture notes');
  const fork = { ...base, isFork: true };
  assert.equal(Math.round(rank(base).score - rank(fork).score), 15);
  assert.ok(isSolutionsOnly(['course', 'assignments', 'solutions']));
  assert.ok(!isSolutionsOnly(['solutions', 'lecture-notes']));
  assert.equal(rank(repo('x/6.824', '')).breakdown.penalties, 5);
});

test('freshness has a floor so classic courses keep value', () => {
  assert.equal(freshness('2026-01-01T00:00:00Z', NOW), 1);
  assert.equal(freshness('2015-01-01T00:00:00Z', NOW), 0.3);
  const mid = freshness('2022-11-04T00:00:00Z', NOW);
  assert.ok(mid > 0.3 && mid < 1);
  assert.equal(freshness(null, NOW), 0.3);
});

test('breakdown is exposed', () => {
  const r = rank(repo('mit-pdos/xv6', 'MIT 6.5840 distributed systems'));
  assert.deepEqual(Object.keys(r.breakdown), ['stars', 'relevance', 'university', 'content', 'freshness', 'penalties']);
  assert.equal(r.breakdown.university, 1);
});
