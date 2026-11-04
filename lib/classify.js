// Classifies a repo: university, course code, official flag, resource types and level.
import { normalize, wordRegex, codeRegex } from './text.js';

const GENERIC_CODES = [
  // MIT "6.824", "6.S081", "mit6824"
  { re: /(?:(?<![0-9.])6\.(s?\d{3,4})|mit[\s_-]?6\.?(s?\d{3,4}))(?![0-9])/i, fmt: (m) => `6.${(m[1] ?? m[2]).toUpperCase()}`, university: 'mit' },
  // CMU "15-445", "cmu15445"
  { re: /(?:(?<![0-9-])(1[0-8])-(\d{3})|cmu[\s_-]?(1[0-8])-?(\d{3}))(?![0-9-])/i, fmt: (m) => `${m[1] ?? m[3]}-${m[2] ?? m[4]}`, university: 'cmu' },
  // "CS229", "CS 61B", "COS226", "CSE 451"
  { re: /(?<![a-z0-9])(cs|cse|cos|csci|eecs|ece|ee)[\s_-]?(\d{2,4}[a-z]?)(?![a-z0-9])/i, fmt: (m) => `${m[1]}${m[2]}`.toUpperCase(), university: null },
];

const TYPE_RULES = [
  ['course', /(?<![a-z])(courses?|class|lectures?|semester|syllabus|mooc)(?![a-z])|课程|公开课/],
  ['lecture-notes', /(?<![a-z])(notes?|slides|handouts?|cheat ?sheets?)(?![a-z])|笔记|讲义/],
  ['videos', /(?<![a-z])(videos?|youtube|playlists?|recordings?)(?![a-z])|视频/],
  ['assignments', /(?<![a-z])(assignments?|labs?|homeworks?|hw\d*|projects?|exercises?|problem sets?|psets?)(?![a-z])|作业|实验/],
  ['solutions', /(?<![a-z])(solutions?|answers?|my (implementation|code|labs?|work|notes)|implementations? (of|for)|labs? in (go|golang|rust|java|python|c\+\+|c))(?![a-z])|答案|题解/],
  ['book', /(?<![a-z])(books?|textbooks?|e-?books?)(?![a-z])/],
  ['awesome-list', /(?<![a-z])awesome(?![a-z])/],
  ['roadmap', /(?<![a-z])(roadmaps?|learning path|self[\s-]?(taught|learning|study)|study guide|curriculum)(?![a-z])/],
  ['guide', /(?<![a-z])(learn|learning (resources|materials)|tutorials?|guides?|handbook|primer|interviews?|explained|from scratch|step by step|translations?)(?![a-z])|教程|指南|学习|翻译|入门/],
];

// "MIT license" and friends must not count as a mention of MIT.
const LICENSE_PHRASES = /(?<![a-z])(mit[\s-]licen[cs]e[ds]?|under (the )?mit)(?![a-z])/g;

const compiled = new WeakMap();
function prepare(config) {
  if (compiled.has(config)) return compiled.get(config);
  const p = {
    unis: new Map(config.universities.map((u) => [u.id, u])),
    orgs: config.universities.flatMap((u) => u.orgs.map((o) => ({ id: u.id, org: o.toLowerCase() }))),
    names: config.universities.map((u) => ({ id: u.id, res: u.names.map(wordRegex) })),
    courses: config.courses.map((c) => ({ c, res: [c.code, ...(c.aliases ?? [])].map(codeRegex) })),
  };
  compiled.set(config, p);
  return p;
}

const orgMatches = (owner, pattern) =>
  pattern.endsWith('*') ? owner.startsWith(pattern.slice(0, -1)) : owner === pattern;

function levelFrom(text, course, code) {
  if (course?.level) return course.level;
  if (/(?<![a-z0-9])(intro|introduction|introductory|101|beginners?|fundamentals|basics)(?![a-z0-9])/.test(text)) return 'intro';
  if (/(?<![a-z])(advanced|graduate)(?![a-z])/.test(text)) return 'advanced';
  const cmu = code?.match(/^1[0-8]-(\d)\d\d$/);
  if (cmu) return Number(cmu[1]) <= 2 ? 'intro' : Number(cmu[1]) === 3 ? 'intermediate' : 'advanced';
  return 'unknown';
}

export function classify(repo, config) {
  const p = prepare(config);
  const text = normalize([repo.name, repo.description, ...(repo.topics ?? [])].join(' '));
  const owner = (repo.owner ?? '').toLowerCase();

  const course = p.courses.find((x) => x.res.some((re) => re.test(text)))?.c ?? null;
  let generic = null;
  for (const g of GENERIC_CODES) {
    const m = text.match(g.re);
    if (m) { generic = { code: g.fmt(m), university: g.university }; break; }
  }

  let university = null;
  let matchedBy = null;
  const org = p.orgs.find((o) => orgMatches(owner, o.org));
  if (org) [university, matchedBy] = [org.id, 'org'];
  else if (course) [university, matchedBy] = [course.university, 'course'];
  else {
    const clean = text.replace(LICENSE_PHRASES, ' ');
    const named = p.names.find((n) => n.res.some((re) => re.test(clean)));
    if (named) [university, matchedBy] = [named.id, 'name'];
    else if (generic?.university) [university, matchedBy] = [generic.university, 'code-pattern'];
  }

  const courseCode = course?.code ?? generic?.code ?? null;
  const types = TYPE_RULES.filter(([, re]) => re.test(text)).map(([t]) => t);
  if (courseCode && !types.includes('course')) types.unshift('course');
  if ((repo.topics ?? []).includes('awesome-list') && !types.includes('awesome-list')) types.push('awesome-list');

  return {
    university,
    universityName: university ? p.unis.get(university)?.name ?? university : null,
    universityMatchedBy: matchedBy,
    courseCode,
    courseTitle: course?.title ?? null,
    official: matchedBy === 'org',
    types,
    level: levelFrom(text, course, courseCode),
  };
}
