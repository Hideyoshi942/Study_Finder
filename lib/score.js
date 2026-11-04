// Relevance and ranking. Every factor is 0..1 and is kept in the breakdown so the rank can be explained.
import { tokenize } from './text.js';

const STOPWORDS = new Set(['and', 'of', 'for', 'the', 'to', 'in', 'a', 'an', 'with', 'from']);
const stem = (t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
const splitCamel = (s) => String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
const tokenSet = (s) => new Set(tokenize(splitCamel(s)).map(stem));
const MONTH = 30.44 * 24 * 3600 * 1000;
const CONTENT_TYPES = ['course', 'lecture-notes', 'videos', 'assignments', 'book', 'guide'];
const NON_SOLUTION_TYPES = ['lecture-notes', 'videos', 'book', 'awesome-list', 'roadmap', 'guide'];

// Share of the term's words found in the repo, weighted by where they are found. Best term wins.
export function relevance(repo, { terms, codes }, cls) {
  if (cls?.courseCode && codes?.some((c) => c.toUpperCase() === cls.courseCode.toUpperCase())) return 1;
  const fields = [
    [tokenSet(repo.name), 1.0],
    [tokenSet((repo.topics ?? []).join(' ')), 0.7],
    [tokenSet(repo.description), 0.5],
  ];
  let best = 0;
  for (const term of terms) {
    const words = tokenize(term).filter((w) => !STOPWORDS.has(w)).map(stem);
    if (!words.length) continue;
    const sum = words.reduce((acc, w) => acc + Math.max(0, ...fields.map(([set, wt]) => (set.has(w) ? wt : 0))), 0);
    best = Math.max(best, sum / words.length);
  }
  return Math.round(best * 1000) / 1000;
}

export function freshness(pushedAt, now = Date.now()) {
  if (!pushedAt) return 0.3;
  const months = (now - Date.parse(pushedAt)) / MONTH;
  if (months <= 12) return 1;
  if (months >= 72) return 0.3;
  return Math.round((1 - ((months - 12) / 60) * 0.7) * 1000) / 1000;
}

export const isSolutionsOnly = (types) =>
  types.includes('solutions') && !types.some((t) => NON_SOLUTION_TYPES.includes(t));

// readme = analyzeReadme() output when the README was read; it adds content signals and .edu links.
export function contentScore(types, readme = null) {
  let c = 0.25 * types.filter((t) => CONTENT_TYPES.includes(t)).length;
  if (readme) {
    const s = readme.signals;
    c += 0.05 * Math.min(10, s.lectures + s.assignments + s.videos + s.pdfs);
    if (readme.domains.length) c += 0.2;
  }
  return Math.min(1, c);
}

export function score(repo, cls, rel, config, now = Date.now(), readme = null) {
  const w = config.weights;
  const pen = config.penalties;
  const factors = {
    stars: Math.min(1, Math.log10((repo.stars ?? 0) + 1) / 4.5),
    relevance: rel,
    university: cls.official ? 1 : cls.university ? 0.6 : 0,
    content: contentScore(cls.types, readme),
    freshness: freshness(repo.pushedAt, now),
  };
  let penalties = 0;
  if (repo.isFork) penalties += pen.fork;
  if (isSolutionsOnly(cls.types)) penalties += pen.solutionsOnly;
  if (!repo.description?.trim()) penalties += pen.noDescription;

  const base = 100 * Object.entries(factors).reduce((acc, [k, v]) => acc + w[k] * v, 0);
  const breakdown = Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  return { score: Math.round((base - penalties) * 10) / 10, breakdown: { ...breakdown, penalties } };
}
