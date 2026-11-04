// Shared text helpers: accent-insensitive normalization and safe word/code matching.

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Splits on anything that is not a letter, digit or an inner dot, so "6.824" stays one token.
export function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Matches a word or phrase with non-alphanumeric boundaries ("mit" matches "MIT 6.824", not "commit").
export function wordRegex(term) {
  const body = escape(normalize(term)).replace(/ /g, '[\\s_-]+');
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
}

// Matches a course code loosely: "CS61B" also matches "cs 61b" and "cs-61b"; "15-445" also matches "15445";
// "6.824" matches inside "mit6.824" but not inside "16.8241".
export function codeRegex(code) {
  const c = normalize(code).replace(/\s+/g, '');
  const m = c.match(/^([a-z]+)(\d.*)$/);
  if (m) {
    const rest = escape(m[2]).replace(/-/g, '[-\\s]?');
    return new RegExp(`(?<![a-z0-9])${escape(m[1])}[\\s_-]?${rest}(?![a-z0-9])`, 'i');
  }
  const body = escape(c).replace(/-/g, '[-\\s]?');
  // MIT codes are often written without the dot after "mit" ("mit6824").
  const mit = /^\d+\./.test(c) ? `|mit[\\s_-]?${body.replace('\\.', '\\.?')}` : '';
  return new RegExp(`(?:(?<![0-9.])${body}${mit})(?![0-9])`, 'i');
}
