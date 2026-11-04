import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMarkdown, toCsv, toJson } from '../lib/export.js';

const res = (id, extra = {}) => ({
  id, title: id, url: `https://github.com/${id}`, description: 'desc', types: ['course'],
  repo: { stars: 3260, pushedAt: '2025-06-01T00:00:00Z' }, universityName: null, ...extra,
});

const search = {
  keyword: 'distributed systems',
  createdAt: '2026-11-04T01:02:03Z',
  expandedQueries: ['distributed systems course stars:>=20', '"6.5840" OR "6.824" stars:>=5'],
  resources: {
    a: res('a', { universityName: 'MIT' }),
    b: res('b', { types: ['course', 'assignments', 'solutions'], repo: { stars: 12 } }),
    c: res('c|x', { title: 'c|x [weird]', types: ['awesome-list'], repo: { stars: 15000 } }),
    d: res('d', { universityName: 'CMU', types: [] }),
  },
  cards: [{ universityName: 'MIT', courseCode: '6.5840', title: 'Distributed Systems', resourceIds: ['a', 'b'] }],
  awesome: ['c'],
  other: ['d'],
};

test('renders sections, star format and escaping', () => {
  const md = toMarkdown(search);
  assert.match(md, /^# Study resources: distributed systems\n/);
  assert.match(md, /_Generated 2026-11-04 by Study Finder\. Searched as: .*"6\.5840" OR/);
  assert.match(md, /## University courses\n\n### MIT 6\.5840: Distributed Systems\n- \[a\]\(https:\/\/github\.com\/a\) ★3\.3k · updated 2025-06 · course\n  desc/);
  assert.match(md, /## Awesome lists & roadmaps\n\n- \[c\\\|x \\\[weird\\\]\]\(.*\) ★15k/);
  assert.match(md, /## Other materials\n\n- \[d\]\(https:\/\/github\.com\/d\) CMU · ★3\.3k/);
});

test('hides solutions-only repos by default and applies minStars', () => {
  assert.ok(!toMarkdown(search).includes('[b]'));
  assert.ok(toMarkdown(search, { hideSolutions: false }).includes('[b]'));
  const md = toMarkdown(search, { minStars: 5000 });
  assert.ok(!md.includes('## University courses'));
  assert.ok(md.includes('[c'));
});

test('csv: header, quoting, formula defusing, BOM; json: flat items', () => {
  const s = { ...search, resources: { ...search.resources, d: res('d', { universityName: 'CMU', types: [], description: '=HYPERLINK("x"), "quoted"' }) } };
  const csv = toCsv(s);
  assert.ok(csv.startsWith('﻿section,course,university,courseCode,title,url,kind,stars'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 1 + 3, 'header + a, c, d (b is solutions-only)');
  assert.match(lines[1], /^University courses,MIT 6\.5840: Distributed Systems,MIT,/);
  assert.ok(lines[3].endsWith(`"'=HYPERLINK(""x""), ""quoted"""`));
  const json = JSON.parse(toJson(s, { hideSolutions: false }));
  assert.equal(json.keyword, 'distributed systems');
  assert.equal(json.items.length, 4);
  assert.deepEqual(Object.keys(json.items[0]).slice(0, 4), ['section', 'course', 'university', 'courseCode']);
});

test('empty search says so', () => {
  const md = toMarkdown({ ...search, resources: {}, cards: [], awesome: [], other: [] });
  assert.match(md, /No results\.\n$/);
});
