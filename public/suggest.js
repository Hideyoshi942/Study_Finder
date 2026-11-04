// Suggestion ranking. Pure functions, shared by the browser UI and the Node tests.

export function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/đ/g, 'd').normalize('NFD')
    .replace(/\p{M}+/gu, '').replace(/\s+/g, ' ').trim();
}

const tokens = (s) => normalize(s).split(/[^a-z0-9.]+/).filter(Boolean);
const compact = (s) => normalize(s).replace(/[^a-z0-9]/g, '');

const KIND_WEIGHT = { history: 5, course: 3, topic: 3, popular: 2, university: 2 };

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Returns a score > 0 when every input word is a prefix of a key word (or the compact input
// is a prefix of a course code: "cs22" -> CS221, CS224N, CS229).
function matchScore(item, words, flat, fuzzy) {
  const keyWords = item._words ?? (item._words = tokens(item.keys));
  let codeHit = false;
  if (item.codes && flat.length >= 2) codeHit = item.codes.some((c) => c.startsWith(flat));
  const prefixHit = words.every((w) => keyWords.some((k) => k.startsWith(w)));
  if (!prefixHit && !codeHit) {
    if (!fuzzy) return 0;
    const ok = words.every((w) => keyWords.some((k) => k.startsWith(w) || (w.length >= 4 && editDistance(w, k.slice(0, w.length + 1)) <= (w.length >= 7 ? 2 : 1))));
    return ok ? 0.5 : 0;
  }
  let s = KIND_WEIGHT[item.kind] ?? 1;
  if (codeHit) s += 2;
  // The label itself starts with what was typed ("stan" -> "Stanford" beats Stanford's courses).
  const phrase = words.join(' ');
  if (normalize(item.label).startsWith(phrase)) s += 2;
  // The words appear together and in order ("hoc ma" -> "hoc may", not "mat ma hoc").
  else if (words.length > 1 && ` ${keyWords.join(' ')}`.includes(` ${phrase}`)) s += 1.5;
  return s;
}

export function rankSuggestions(items, input, limit = 8) {
  const words = tokens(input);
  if (!words.length) {
    // Empty box: recent searches, then popular ones.
    const recent = items.filter((i) => i.kind === 'history').slice(0, 5);
    const seen = new Set(recent.map((i) => normalize(i.query)));
    const popular = items.filter((i) => i.kind === 'popular' && !seen.has(normalize(i.query)));
    return [...recent, ...popular].slice(0, limit);
  }
  const flat = compact(input);
  const rank = (fuzzy) => items
    .filter((i) => i.kind !== 'popular')
    .map((item) => ({ item, s: matchScore(item, words, flat, fuzzy) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.item.label.length - b.item.label.length);

  let ranked = rank(false);
  if (!ranked.length) ranked = rank(true);
  const out = [];
  const seen = new Set();
  for (const { item } of ranked) {
    const key = normalize(item.query);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// "Did you mean": topics and courses close to a keyword that found nothing.
export function didYouMean(items, keyword, limit = 3) {
  return rankSuggestions(items.filter((i) => i.kind === 'topic' || i.kind === 'course'), keyword, limit)
    .filter((i) => normalize(i.query) !== normalize(keyword));
}
