// Builds the search-suggestion index sent to the browser (matching happens client-side in public/suggest.js).
import { normalize } from './text.js';

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
