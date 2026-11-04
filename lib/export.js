// Exports of a saved search: Markdown (to read or paste), CSV (spreadsheets) and JSON (scripts).
import { isSolutionsOnly } from './score.js';

const fmtStars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
const esc = (s) => String(s ?? '').replace(/([\\[\]|*_`<>])/g, '\\$1').replace(/\s+/g, ' ').trim();

// The same filters as the UI: hide solution-only repos, and a star minimum (repos only; curated links have no stars).
function keeper(search, { hideSolutions = true, minStars = 0 } = {}) {
  return (id) => {
    const r = search.resources[id];
    return Boolean(r) && (!r.repo || r.repo.stars >= minStars) && !(hideSolutions && isSolutionsOnly(r.types));
  };
}

// Every kept resource with its section and course, in display order.
function rows(search, opts) {
  const keep = keeper(search, opts);
  const out = [];
  for (const c of search.cards) {
    for (const id of c.resourceIds.filter(keep)) out.push({ section: 'University courses', course: c, r: search.resources[id] });
  }
  for (const [section, list] of [['Course sites & videos', search.sites ?? []], ['Awesome lists & roadmaps', search.awesome], ['Other materials', search.other]]) {
    for (const id of list.filter(keep)) out.push({ section, course: null, r: search.resources[id] });
  }
  return out;
}

function line(r, showUni) {
  const meta = r.kind === 'external' ? [r.host] : [`★${fmtStars(r.repo?.stars ?? 0)}`];
  if (showUni && r.universityName) meta.unshift(esc(r.universityName));
  if (r.repo?.pushedAt) meta.push(`updated ${r.repo.pushedAt.slice(0, 7)}`);
  if (r.types.length) meta.push(r.types.join(', '));
  let out = `- [${esc(r.title)}](${r.url}) ${meta.join(' · ')}`;
  if (r.description) out += `\n  ${esc(r.description)}`;
  return out;
}

export function toMarkdown(search, opts = {}) {
  const parts = [
    `# Study resources: ${esc(search.keyword)}`,
    '',
    `_Generated ${search.createdAt.slice(0, 10)} by Study Finder. Searched as: ${search.expandedQueries.map(esc).join(' · ')}_`,
  ];
  let section = null;
  let course = null;
  for (const row of rows(search, opts)) {
    if (row.section !== section) {
      section = row.section;
      parts.push('', `## ${section}`);
      if (!row.course) parts.push('');
    }
    if (row.course && row.course !== course) {
      course = row.course;
      parts.push('', `### ${esc(course.universityName)} ${esc(course.courseCode)}: ${esc(course.title)}`);
    }
    parts.push(line(row.r, !row.course));
  }
  if (parts.length === 3) parts.push('', 'No results.');
  return parts.join('\n') + '\n';
}

function flat({ section, course, r }) {
  return {
    section,
    course: course ? `${course.universityName} ${course.courseCode}: ${course.title}` : '',
    university: r.universityName ?? '',
    courseCode: r.courseCode ?? '',
    title: r.title,
    url: r.url,
    kind: r.kind === 'external' ? 'link' : 'repo',
    stars: r.repo?.stars ?? '',
    updated: r.repo?.pushedAt?.slice(0, 10) ?? '',
    types: r.types.join(' '),
    level: r.level ?? '',
    language: r.lang ?? '',
    score: r.score,
    description: r.description ?? '',
  };
}

// Quotes when needed, and defuses spreadsheet formulas (a cell starting with = + - @).
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(search, opts = {}) {
  const items = rows(search, opts).map(flat);
  const header = ['section', 'course', 'university', 'courseCode', 'title', 'url', 'kind', 'stars', 'updated', 'types', 'level', 'language', 'score', 'description'];
  // BOM so Excel opens UTF-8 (Vietnamese, Chinese) correctly.
  return '﻿' + [header, ...items.map((i) => header.map((k) => i[k]))].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function toJson(search, opts = {}) {
  return JSON.stringify({
    keyword: search.keyword,
    createdAt: search.createdAt,
    searchedAs: search.expandedQueries,
    items: rows(search, opts).map(flat),
  }, null, 2);
}
