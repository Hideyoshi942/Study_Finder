// Turns a user keyword into the list of GitHub search queries to run.
import { normalize, wordRegex, codeRegex } from './text.js';
import { slugify } from './store.js';

const byLengthDesc = (a, b) => b.length - a.length;

// Exact match first, then phrase replacement (longest keys first, word-bounded).
// Single long words ("network", "security") are replaced only on an exact match, so
// "neural network" does not become "neural computer networks". Abbreviations and phrases are replaced anywhere.
const replaceable = (key) => key.includes(' ') || key.length <= 4;

function translate(text, table) {
  if (table[text]) return table[text];
  let out = text;
  for (const key of Object.keys(table).filter(replaceable).sort(byLengthDesc)) {
    const re = new RegExp(wordRegex(key).source, 'gi');
    out = out.replace(re, table[key]);
  }
  return out;
}

const codesOf = (course) => [course.code, ...(course.aliases ?? [])];

export function expandQuery(keyword, config) {
  const normalized = normalize(keyword);
  if (!normalized) throw new Error('Keyword is empty');
  const { minStars, codeMinStars, maxQueries, maxCodesPerQuery } = config.search;

  // A keyword that names a course ("6.824", "cs 229") searches by that course's title too.
  const named = config.courses.filter((c) => codesOf(c).some((code) => codeRegex(code).test(normalized)));
  const isPureCode = named.length > 0 && normalized.replace(/\s+/g, '').length <= 8;

  let main = translate(translate(normalized, config.vietnamese), config.aliases);
  if (isPureCode) main = normalize(named[0].title);
  const terms = [...new Set([main, normalized])];

  // Courses whose topic is one of the terms (or is contained in a term). Primary topic matches first.
  const topical = config.courses
    .map((c) => ({ c, rank: c.topics.findIndex((t) => terms.some((term) => term === t || wordRegex(t).test(term))) }))
    .filter((x) => x.rank >= 0 && !named.includes(x.c))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.c);
  const courses = [...named, ...topical];
  const codes = [...new Set(courses.flatMap(codesOf))];

  // Query at most maxCodesPerQuery codes: every course's main code and first alias, in course order.
  const queryCodes = [...new Set(courses.flatMap((c) => codesOf(c).slice(0, 2)))].slice(0, maxCodesPerQuery);
  const stars = ` stars:>=${minStars}`;
  const queries = [
    { kind: 'course', q: `${main} course${stars}` },
    { kind: 'lecture', q: `${main} lecture${stars}` },
    { kind: 'general', q: `${main}${stars}` },
    { kind: 'awesome', q: `awesome ${main}${stars}` },
    { kind: 'topic', q: `topic:${slugify(main)}${stars}` },
  ];
  if (queryCodes.length) {
    const codeQuery = { kind: 'code', q: `${queryCodes.map((c) => `"${c}"`).join(' OR ')} stars:>=${codeMinStars}` };
    if (named.length) queries.unshift(codeQuery);
    else queries.push(codeQuery);
  }

  return {
    normalized,
    main,
    terms,
    codes,
    courses: courses.map((c) => c.code),
    queries: queries.slice(0, maxQueries),
  };
}
