// Builds the search-suggestion index sent to the browser (matching happens client-side in public/suggest.js),
// and course recommendations for the home page.
import { normalize } from './text.js';
import { expandQuery } from './query.js';

const courseView = (c, unis, extra = {}) => ({
  code: c.code, title: c.title, level: c.level, university: c.university,
  universityName: unis.get(c.university)?.name ?? c.university, ...extra,
});

// The topic a past search belongs to, or null.
export function topicOf(keyword, config) {
  let main;
  try { main = expandQuery(keyword, config).main; } catch { return null; }
  const topics = config.topics ?? [];
  return topics.find((t) => t.query === main)
    ?? topics.find((t) => main.includes(t.query))
    ?? null;
}

// Related topics of recent searches that were not searched yet, and their known courses.
// With no usable history, returns the starter path only.
export function recommend(config, history = []) {
  const unis = new Map(config.universities.map((u) => [u.id, u]));
  const byId = new Map((config.topics ?? []).map((t) => [t.id, t]));
  const starter = (config.starterPath ?? [])
    .map((code) => config.courses.find((c) => c.code === code))
    .filter(Boolean)
    .map((c) => courseView(c, unis));

  const searched = [];
  for (const h of history.slice(0, 10)) {
    const t = topicOf(h.keyword, config);
    if (t && !searched.includes(t)) searched.push(t);
  }
  const searchedQueries = new Set(history.map((h) => normalize(h.keyword)));

  const topics = [];
  for (const t of searched) {
    for (const id of t.related) {
      const r = byId.get(id);
      if (r && !searched.includes(r) && !topics.some((x) => x.topic === r)) topics.push({ topic: r, because: t });
    }
  }

  // Round-robin over the related topics so every past search contributes, not just the first one.
  const queues = topics.map(({ topic, because }) => config.courses
    .filter((c) => c.topics.includes(topic.query) && !searchedQueries.has(normalize(c.code)))
    .map((c) => courseView(c, unis, { topic: topic.label, reason: `Because you searched ${because.label}` })));
  const byBecause = new Map();
  topics.forEach(({ because }, i) => byBecause.set(because, [...(byBecause.get(because) ?? []), queues[i]]));
  const courses = [];
  const groups = [...byBecause.values()];
  for (let round = 0; courses.length < 8 && groups.some((g) => g.some((q) => q.length)); round++) {
    for (const g of groups) {
      const q = g.find((x) => x.length);
      if (!q) continue;
      // Rotate within a search's related topics too.
      g.push(g.splice(g.indexOf(q), 1)[0]);
      const c = q.shift();
      if (!courses.some((x) => x.code === c.code)) courses.push(c);
      if (courses.length >= 8) break;
    }
  }

  return {
    basedOn: searched.map((t) => t.label),
    topics: topics.slice(0, 6).map(({ topic, because }) => ({ id: topic.id, label: topic.label, vi: topic.vi, query: topic.query, because: because.label })),
    courses,
    starter,
  };
}

const compact = (s) => normalize(s).replace(/[^a-z0-9]/g, '');

export function buildSuggestIndex(config, history = []) {
  const unis = new Map(config.universities.map((u) => [u.id, u]));
  const items = [];

  for (const h of history.slice(0, 20)) {
    items.push({ kind: 'history', label: h.keyword, sub: '', query: h.keyword, keys: normalize(h.keyword) });
  }
  for (const q of config.popularSearches ?? []) {
    items.push({ kind: 'popular', label: q, sub: '', query: q, keys: normalize(q) });
  }

  for (const t of config.topics ?? []) {
    const aliases = Object.entries(config.aliases).filter(([, v]) => v === t.query).map(([k]) => k);
    const viKeys = Object.entries(config.vietnamese).filter(([, v]) => v === t.query).map(([k]) => k);
    const courses = config.courses.filter((c) => c.topics.includes(t.query)).length;
    items.push({
      kind: 'topic',
      label: t.label,
      sub: `${t.vi}${courses ? ` · ${courses} known course${courses > 1 ? 's' : ''}` : ''}`,
      query: t.query,
      keys: normalize([t.label, t.vi, t.query, ...aliases, ...viKeys].join(' ')),
    });
  }

  for (const c of config.courses) {
    const u = unis.get(c.university);
    const codes = [c.code, ...(c.aliases ?? [])];
    items.push({
      kind: 'course',
      label: `${c.code} · ${c.title}`,
      sub: [u?.name, c.aliases?.length ? `also ${c.aliases.join(', ')}` : null].filter(Boolean).join(' · '),
      query: c.code,
      keys: normalize([...codes, ...codes.map(compact), c.title, u?.name, u?.id].join(' ')),
      codes: codes.map(compact),
    });
  }

  for (const u of config.universities) {
    const n = config.courses.filter((c) => c.university === u.id).length;
    items.push({
      kind: 'university',
      label: u.name,
      sub: n ? `${n} known course${n > 1 ? 's' : ''}` : 'University',
      query: u.name,
      keys: normalize([u.name, u.id, ...u.names].join(' ')),
    });
  }
  return { items };
}
