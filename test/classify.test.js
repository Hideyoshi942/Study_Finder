import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { classify } from '../lib/classify.js';

const config = await loadConfig(path.resolve(import.meta.dirname, '..'));
const repo = (fullName, description = '', topics = []) => {
  const [owner, name] = fullName.split('/');
  return { fullName, owner, name, description, topics };
};

const cases = [
  // [repo, expected subset]
  [repo('mit-pdos/xv6-riscv', 'Xv6 for RISC-V'), { university: 'mit', universityMatchedBy: 'org', official: true }],
  [repo('chaozh/MIT-6.824', 'Basic Sources for MIT 6.824 Distributed Systems Class'),
    { university: 'mit', universityMatchedBy: 'course', courseCode: '6.5840', courseTitle: 'Distributed Systems', level: 'advanced' }],
  [repo('Wangzhike/MIT6.824_DistributedSystem', 'MIT6.824分布式系统（2018秋）', ['mit6824', 'raft']),
    { university: 'mit', courseCode: '6.5840' }],
  [repo('cmu-db/bustub', 'The BusTub Relational Database Management System (Educational)'),
    { university: 'cmu', universityMatchedBy: 'org', official: true }],
  [repo('someone/cmu15445', 'CMU 15-445 database systems projects'),
    { university: 'cmu', courseCode: '15-445' }],
  [repo('student/cs61b', 'CS 61B data structures, UC Berkeley'), { university: 'berkeley', courseCode: 'CS61B', level: 'intro' }],
  [repo('student/cs231n-2024', 'Stanford cs231n assignments'), { university: 'stanford', courseCode: 'CS231N' }],
  [repo('x/os-course-6.999', 'an unlisted course'), { university: 'mit', universityMatchedBy: 'code-pattern', courseCode: '6.999' }],
  [repo('x/uiuc-cs225', 'UIUC CS 225 data structures'), { university: 'uiuc', universityMatchedBy: 'name', courseCode: 'CS225' }],
  [repo('x/commitlint', 'A commit linter'), { university: null, courseCode: null }],
  [repo('x/react-kit', 'React UI kit, MIT licensed'), { university: null }],
  [repo('x/ubuntu-notes', 'Ubuntu 18.04 setup notes 2018-2019'), { university: null, courseCode: null }],
];

for (const [r, expected] of cases) {
  test(`classify ${r.fullName}`, () => {
    const got = classify(r, config);
    for (const [k, v] of Object.entries(expected)) assert.deepEqual(got[k], v, `${k} for ${r.fullName}`);
  });
}

test('types', () => {
  const t = (desc, name = 'x/y', topics = []) => classify(repo(name, desc, topics), config).types;
  assert.deepEqual(t('My solutions to CS61A homework'), ['course', 'assignments', 'solutions']);
  assert.ok(t('', 'prakhar1989/awesome-courses').includes('awesome-list'));
  assert.ok(t('Lecture notes and slides').includes('lecture-notes'));
  assert.ok(t('YouTube playlist of lectures').includes('videos'));
  assert.ok(t('A self-taught roadmap').includes('roadmap'));
  assert.ok(t('MIT 6.824 labs in Go').includes('solutions'));
  assert.ok(t('free programming books').includes('book'));
  assert.deepEqual(t('a cli tool'), []);
  assert.ok(!t('Deep learning framework for machine learning').includes('guide'));
  assert.ok(t('Learn system design').includes('guide'));
  assert.ok(t('Free machine learning resources tutorial').includes('guide'));
});

test('levels from keywords', () => {
  assert.equal(classify(repo('x/y', 'An introduction to compilers'), config).level, 'intro');
  assert.equal(classify(repo('x/y', 'Advanced operating systems topics'), config).level, 'advanced');
  assert.equal(classify(repo('x/y', 'CMU 15-319 cloud computing'), config).level, 'intermediate');
});
