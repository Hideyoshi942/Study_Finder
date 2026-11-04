// Static build for GitHub Pages: runs the real search pipeline for popular topics, then writes a
// self-contained site to dist/. The page searches any other keyword live from the browser, without a token.
//
//   node --use-env-proxy build.js            (STATIC_LIMIT=3 builds only 3 topics, for a quick local test)
//
// The token (GITHUB_TOKEN from GitHub Actions, or .env locally) is only used here, on the build machine.
// The last step scans every output file and fails the build if anything looks like a token.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadToken } from './lib/config.js';
import { createCache } from './lib/cache.js';
import { createGitHub } from './lib/github.js';
import { createSearcher } from './lib/search.js';
import { createReadmeFetcher } from './lib/readme.js';
import { createFeed } from './lib/feed.js';
import { buildSuggestIndex } from './lib/suggest.js';
import { normalize, slugify } from './lib/text.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, 'data', 'cache');

// lib/ files the browser needs (static-backend.js imports them). None may import node:* modules.
const BROWSER_LIB = ['text', 'query', 'classify', 'score', 'resource', 'group', 'enrich', 'readme', 'awesome', 'github', 'search', 'suggest', 'export'];
const PUBLIC = ['index.html', 'app.js', 'suggest.js', 'styles.css', 'static-backend.js'];
const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;

const config = await loadConfig(ROOT);
const token = await loadToken(ROOT);
console.log(`[build] GitHub token: ${token ? 'yes' : 'no (slow: 10 searches/min)'}`);

const github = createGitHub({ token, cache: createCache({ dir: CACHE, ttlMs: 3 * 3600_000 }) });
const readmes = createReadmeFetcher({ cache: createCache({ dir: path.join(CACHE, 'readme'), ttlMs: 7 * 24 * 3600_000 }) });
const searcher = createSearcher({ config, github, readmes });

await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, 'data', 'searches'), { recursive: true });
await mkdir(path.join(DIST, 'lib'), { recursive: true });
const write = (rel, data) => writeFile(path.join(DIST, rel), typeof data === 'string' ? data : JSON.stringify(data));

// 1. Prebuilt searches: every topic tile plus the popular searches.
const keywords = [];
const seen = new Set();
for (const k of [...config.popularSearches, ...config.topics.map((t) => t.query)]) {
  const id = slugify(normalize(k));
  if (!seen.has(id)) { seen.add(id); keywords.push(k); }
}
const limit = Number(process.env.STATIC_LIMIT) || keywords.length;
const built = [];
for (const [i, k] of keywords.slice(0, limit).entries()) {
  const started = Date.now();
  try {
    const s = await searcher.search(k);
    const n = Object.keys(s.resources).length;
    if (!n) { console.warn(`[build] ${i + 1}/${limit} "${k}": no results (${s.warnings.join(' | ')})`); continue; }
    await write(`data/searches/${s.id}.json`, { ...s, rateLimit: undefined });
    built.push({ id: s.id, keyword: s.keyword, createdAt: s.createdAt, counts: { cards: s.cards.length, sites: s.sites.length, awesome: s.awesome.length, other: s.other.length } });
    console.log(`[build] ${i + 1}/${limit} "${k}": ${n} resources, ${s.cards.length} course cards (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  } catch (e) {
    console.warn(`[build] ${i + 1}/${limit} "${k}" failed: ${e.message}`);
  }
}
if (!built.length) {
  console.error('[build] every search failed - not publishing an empty site');
  process.exit(1);
}

// 2. Feed and home page.
const feed = createFeed({ config, github, dataDir: path.join(ROOT, 'data', 'build') });
const feedData = await feed.refresh({ force: true });
console.log(`[build] feed: ${feedData.semester.length} this semester, ${feedData.fresh.length} new courses${feedData.status ? ` (${feedData.status})` : ''}`);
await write('data/home.json', {
  popular: config.popularSearches,
  topics: config.topics.map((t) => ({ id: t.id, label: t.label, vi: t.vi, query: t.query, courses: config.courses.filter((c) => c.topics.includes(t.query)).length })),
  feed: feedData,
  recommendations: null, // computed in the browser from the visitor's own history
  watches: [],
});
await write('data/suggest-index.json', buildSuggestIndex(config, []));
const builtAt = new Date().toISOString();
await write('data/index.json', { builtAt, searches: built });
await write('static.json', { static: true, builtAt });
await write('.nojekyll', '');

// 3. Page, browser-safe lib files and config.
for (const f of PUBLIC) await copyFile(path.join(ROOT, 'public', f), path.join(DIST, f));
for (const f of BROWSER_LIB) {
  const src = await readFile(path.join(ROOT, 'lib', `${f}.js`), 'utf8');
  if (/from ['"]node:/.test(src)) throw new Error(`lib/${f}.js imports a Node module and cannot run in the browser`);
  await writeFile(path.join(DIST, 'lib', `${f}.js`), src);
}
await copyFile(path.join(ROOT, 'config.json'), path.join(DIST, 'config.json'));

// 4. Token guard: nothing in dist/ may contain a token.
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
let files = 0;
for await (const file of walk(DIST)) {
  files++;
  const text = await readFile(file, 'utf8');
  if (TOKEN_PATTERN.test(text) || (token && text.includes(token))) {
    console.error(`[build] TOKEN FOUND in ${path.relative(ROOT, file)} - refusing to publish`);
    await rm(DIST, { recursive: true, force: true });
    process.exit(1);
  }
}
console.log(`[build] token check passed (${files} files). Wrote ${built.length} searches to ${DIST}`);
