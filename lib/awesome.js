// Mines curated "awesome" lists for course websites and lecture-video playlists that plain repo search misses.
import { normalize, wordRegex, codeRegex } from './text.js';
import { classify } from './classify.js';
import { relevance, contentScore } from './score.js';

const LINK = /\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)[^)]*\)/g;
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|bilibili\.com|tele-task\.de|vimeo\.com)$/;

const stripMd = (s) => s
  .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_`#|]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const indentOf = (line) => line.match(/^[\t ]*/)[0].replace(/\t/g, '    ').length;

// Parses list items, table rows and headings. Indented sub-items attach their links and text to the parent entry.
export function parseAwesome(markdown, list) {
  const entries = [];
  const headings = [];
  let parent = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = raw.match(/^\s*(?:[-*]\s+)?(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      headings.splice(level - 1);
      headings[level - 1] = stripMd(heading[2]);
      parent = null;
      continue;
    }
    const links = [...raw.matchAll(LINK)].map((m) => ({ label: stripMd(m[1]), url: m[2] })).filter((l) => l.label);
    const isItem = /^\s*([-*+]|\d+\.)\s+/.test(raw) || /^\s*\|/.test(raw);
    const indent = indentOf(raw);
    const tags = [...raw.matchAll(/<img[^>]*alt="([^"]+)"/gi)].map((m) => m[1].toLowerCase());

    if (isItem && parent && indent > parent.indent) {
      // A sub-item: extra links (Assignments, Readings, Videos) or a description line.
      parent.links.push(...links);
      if (!links.length && !parent.description) parent.description = stripMd(raw.replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      continue;
    }
    if (!isItem || !links.length) { if (!raw.trim()) continue; parent = isItem ? null : parent; continue; }

    const [main, ...extra] = links;
    parent = {
      bold: stripMd(raw.match(/\*\*([^*]+)\*\*/)?.[1] ?? ''),
      text: main.label,
      url: main.url,
      rest: stripMd(raw.replace(/^\s*([-*+]|\d+\.)\s+/, '')),
      description: '',
      headings: headings.filter(Boolean),
      links: extra,
      tags,
      list,
      indent,
    };
    entries.push(parent);
  }
  return entries.map(({ indent, ...e }) => e);
}

// Course name for a card title: the bold part ("**Distributed Systems**"), else the link text
// without its course code and trailing " - Spring 2020 - MIT" parts.
function subjectOf(e) {
  if (e.bold) return e.bold;
  const s = e.text.split(/\s[-–|]\s/)[0]
    .replace(/^(?:[a-z]{1,5}[\s-]?)?\d[\w.-]*[\s:–-]+/i, '') // leading code: "6.824 ", "CS 425 ", "15-440: "
    .replace(/^[\s:–-]+|[\s:–-]+$/g, '');
  // A link that is only a course code ("6.875") has no subject; the card title then comes from the description.
  return s;
}

const githubRepo = (url) => {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/#?]+)\/([^/#?]+)\/?$/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}`.toLowerCase() : null;
};

function typesFor(e, cls) {
  const types = new Set(cls.types.filter((t) => !['awesome-list', 'roadmap', 'solutions'].includes(t)));
  const labels = [...e.links.map((l) => `${l.label} ${hostOf(l.url)}`), ...e.tags].join(' ').toLowerCase();
  const host = hostOf(e.url);
  if (VIDEO_HOSTS.test(host) || /video|youtube|lectures? videos?/.test(labels) || e.links.some((l) => VIDEO_HOSTS.test(hostOf(l.url)))) types.add('videos');
  if (/notes|slides|readings?/.test(labels)) types.add('lecture-notes');
  if (/assignments?|labs?|homework|problem sets?/.test(labels)) types.add('assignments');
  if (host.endsWith('.edu') || cls.courseCode || !types.size) types.add('course');
  return [...types];
}

// Entries whose own text, or nearest heading, mentions a search term or course code.
function matches(e, expanded) {
  const own = normalize(`${e.text} ${e.rest} ${e.description}`);
  const heading = normalize(e.headings.at(-1) ?? '');
  const termHit = (s) => expanded.terms.some((t) => wordRegex(t).test(s));
  const codeHit = (s) => expanded.codes.some((c) => codeRegex(c).test(s));
  return termHit(own) || codeHit(own) || termHit(heading);
}

// Returns { externals, repoHits }: external resources, and GitHub repos the lists point at (lower-case names).
export function mineAwesome(entries, expanded, config) {
  const externals = new Map();
  const repoHits = new Set();
  for (const e of entries) {
    if (!matches(e, expanded)) continue;
    const gh = githubRepo(e.url);
    if (gh) { repoHits.add(gh); continue; }
    if (hostOf(e.url) === 'github.com') continue;

    const host = hostOf(e.url);
    const pseudo = { name: e.text, owner: '', description: `${e.rest} ${e.description}`.trim(), topics: [] };
    const cls = classify(pseudo, config, { domains: [host] });
    const types = typesFor(e, cls);
    const rel = relevance(pseudo, expanded, cls);
    const factors = {
      stars: 0.6, // stands in for stars: someone curated this link
      relevance: rel,
      university: cls.university ? 0.6 : 0,
      content: contentScore(types),
      freshness: 0.5, // unknown
    };
    const s = 100 * Object.entries(factors).reduce((acc, [k, v]) => acc + config.weights[k] * v, 0);
    const key = e.url.replace(/^http:/, 'https:').replace(/\/$/, '').toLowerCase();
    const prev = externals.get(key);
    const resource = {
      id: `ext:${key}`,
      kind: 'external',
      url: e.url,
      title: e.text,
      subject: subjectOf(e),
      description: [e.rest !== e.text ? e.rest : '', e.description].filter(Boolean).join(' · ').slice(0, 300),
      host,
      links: e.links.filter((l) => /^https?:/.test(l.url)).slice(0, 4),
      lists: [...new Set([...(prev?.lists ?? []), e.list])],
      section: e.headings.join(' › '),
      repo: null,
      foundBy: ['awesome'],
      ...cls,
      official: false,
      types,
      relevance: rel,
      score: Math.round(s * 10) / 10,
      scoreBreakdown: { ...factors, penalties: 0 },
    };
    // The university came from the link's own domain, not from a README.
    if (resource.universityMatchedBy === 'readme') resource.universityMatchedBy = 'link';
    if (!prev || resource.score > prev.score) externals.set(key, resource);
    else prev.lists = resource.lists;
  }
  const list = [...externals.values()].sort((a, b) => b.score - a.score).slice(0, config.awesome.maxExternal);
  return { externals: list, repoHits };
}
