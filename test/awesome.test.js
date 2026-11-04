import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { parseAwesome, mineAwesome } from '../lib/awesome.js';
import { expandQuery } from '../lib/query.js';
import { group } from '../lib/group.js';
import { toMarkdown } from '../lib/export.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
const expanded = expandQuery('distributed systems', config);

// Shapes copied from the real seed lists.
const AWESOME_COURSES = `# Awesome CS Courses [![Awesome](https://cdn.rawgit.com/badge.svg)](https://github.com/sindresorhus/awesome)
### Systems
- [CS 425](https://courses.engr.illinois.edu/cs425/fa2016/index.html) **Distributed Systems** *Univ of Illinois, Urbana-Champaign* <img src="x.png" alt="Lecture Videos" title="Lecture Videos" />
\t- Brilliant set of lectures covering vector clocks, consensus and Paxos.
- [6.824](http://css.csail.mit.edu/6.824/2014/index.html) **Distributed Systems** *MIT* <img src="a.png" alt="Assignments" /> <img src="n.png" alt="Lecture Notes" />
\t- MIT's graduate-level DS course with a focus on fault tolerance.
\t- [Assignments](http://css.csail.mit.edu/6.824/2014/labs/) - Just do git clone
\t- [Readings](http://css.csail.mit.edu/6.824/2014/schedule.html)
- [6.828](http://pdos.csail.mit.edu/6.828/2014/) **Operating Systems** *MIT*
- [Relative](#systems) **Anchor only**
### Machine Learning
- [CS 229](http://cs229.stanford.edu/) **Machine Learning** *Stanford*
`;
const VIDEO_COURSES = `- #### **Distributed Systems**
  - [6.824 Distributed Systems - Spring 2020 - MIT](https://pdos.csail.mit.edu/6.824/schedule.html) ([Youtube](https://www.youtube.com/playlist?list=PLrw6a1wE39_tb2fErI4-WkMbsvGQk9_UB))
  - [Distributed Systems Lecture Series](https://www.youtube.com/playlist?list=PLeKd45z)
  - [Raft labs on GitHub](https://github.com/someone/raft-labs)
- #### **Databases**
  - [CMU 15-445 Database Systems](https://15445.courses.cs.cmu.edu/)
`;
const OSSU = `### Core systems
| Courses | Duration |
| :-- | :-- |
| [Distributed Systems Basics](https://example.org/ds-basics) | 8 weeks |
`;

test('parseAwesome: headings, sub-item links and descriptions, image alt tags, tables', () => {
  const e = parseAwesome(AWESOME_COURSES, 'prakhar1989/awesome-courses');
  const mit = e.find((x) => x.text === '6.824');
  assert.deepEqual(mit.headings, ['Awesome CS Courses', 'Systems']);
  assert.equal(mit.rest, '6.824 Distributed Systems MIT');
  assert.equal(mit.description, "MIT's graduate-level DS course with a focus on fault tolerance.");
  assert.deepEqual(mit.links.map((l) => l.label), ['Assignments', 'Readings']);
  assert.deepEqual(mit.tags, ['assignments', 'lecture notes']);
  assert.ok(!e.some((x) => x.text === 'Relative'), 'anchor links ignored');
  assert.ok(!e.some((x) => x.text === 'Awesome'), 'heading badges are not entries');

  const v = parseAwesome(VIDEO_COURSES, 'Developer-Y/cs-video-courses');
  assert.deepEqual(v[0].headings, ['Distributed Systems']);
  assert.equal(v[0].links[0].label, 'Youtube');
  assert.deepEqual(v.at(-1).headings, ['Databases']);

  const o = parseAwesome(OSSU, 'ossu/computer-science');
  assert.equal(o[0].text, 'Distributed Systems Basics');
});

test('mineAwesome: matches by text, code or heading; classifies; finds GitHub repos', () => {
  const entries = [
    ...parseAwesome(AWESOME_COURSES, 'prakhar1989/awesome-courses'),
    ...parseAwesome(VIDEO_COURSES, 'Developer-Y/cs-video-courses'),
    ...parseAwesome(OSSU, 'ossu/computer-science'),
  ];
  const { externals, repoHits } = mineAwesome(entries, expanded, config);
  const byTitle = Object.fromEntries(externals.map((x) => [x.title, x]));

  const mit = byTitle['6.824'];
  assert.equal(mit.university, 'mit');
  assert.equal(mit.courseCode, '6.5840');
  assert.ok(mit.types.includes('assignments') && mit.types.includes('lecture-notes') && mit.types.includes('course'));
  assert.equal(mit.host, 'css.csail.mit.edu');

  const mitVideos = byTitle['6.824 Distributed Systems - Spring 2020 - MIT'];
  assert.ok(mitVideos.types.includes('videos'), 'a YouTube sub-link marks videos');

  assert.equal(byTitle['CS 425'].university, 'uiuc');
  assert.equal(byTitle['CS 425'].subject, 'Distributed Systems');
  assert.equal(byTitle['Distributed Systems Lecture Series'].subject, 'Distributed Systems Lecture Series');
  assert.equal(byTitle['6.824 Distributed Systems - Spring 2020 - MIT'].subject, 'Distributed Systems');
  assert.ok(byTitle['CS 425'].types.includes('videos'), 'alt="Lecture Videos" marks videos');
  assert.ok(byTitle['Distributed Systems Lecture Series'], 'matched by heading');
  assert.ok(byTitle['Distributed Systems Basics'], 'table row matched');
  assert.ok(!byTitle['6.828'] && !byTitle['CS 229'] && !byTitle['CMU 15-445 Database Systems'], 'unrelated entries skipped');
  assert.ok(repoHits.has('someone/raft-labs'));
  assert.ok(!externals.some((x) => x.host === 'github.com'));
  assert.equal(new Set(externals.map((x) => x.id)).size, externals.length);
});

test('externals join course cards; the rest go to sites; export lists them', () => {
  const { externals } = mineAwesome(parseAwesome(AWESOME_COURSES + VIDEO_COURSES, 'l'), expanded, config);
  const repoRes = { id: 'gh:a/6.824', title: 'a/6.824', url: 'https://github.com/a/6.824', description: '', score: 70, types: ['course'],
    university: 'mit', universityName: 'MIT', courseCode: '6.5840', courseTitle: 'Distributed Systems', repo: { name: '6.824', isFork: false, stars: 10 } };
  const g = group([repoRes, ...externals]);
  const card = g.cards.find((c) => c.key === 'mit:6.5840');
  assert.ok(card.resourceIds.includes('gh:a/6.824'));
  assert.ok(card.resourceIds.some((id) => id.startsWith('ext:https://css.csail.mit.edu')));
  assert.ok(g.sites.some((id) => id.includes('youtube.com/playlist?list=pleKd45z'.toLowerCase())));

  const search = { keyword: 'ds', createdAt: '2026-11-04T00:00:00Z', expandedQueries: [],
    resources: Object.fromEntries([repoRes, ...externals].map((r) => [r.id, r])), cards: g.cards, awesome: g.awesome, sites: g.sites, other: g.other };
  const md = toMarkdown(search);
  assert.match(md, /## Course sites & videos/);
  assert.match(md, /\[Distributed Systems Lecture Series\]\(https:\/\/www\.youtube\.com\/playlist\?list=PLeKd45z\) youtube\.com/);
});
