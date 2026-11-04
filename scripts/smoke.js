// Live check: runs real searches through the pipeline and prints the top results.
// Usage: npm run smoke -- "distributed systems" "học máy"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadToken } from '../lib/config.js';
import { createCache } from '../lib/cache.js';
import { createGitHub } from '../lib/github.js';
import { createSearcher } from '../lib/search.js';
import { createReadmeFetcher } from '../lib/readme.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await loadConfig(ROOT);
const github = createGitHub({
  token: await loadToken(ROOT),
  cache: createCache({ dir: path.join(ROOT, 'data', 'cache'), ttlMs: config.cacheHours * 3600_000 }),
});
const readmes = createReadmeFetcher({ cache: createCache({ dir: path.join(ROOT, 'data', 'cache', 'readme'), ttlMs: 7 * 24 * 3600_000 }) });
const searcher = createSearcher({ config, github, readmes });
const keywords = process.argv.slice(2);
if (!keywords.length) keywords.push('distributed systems');

for (const kw of keywords) {
  const s = await searcher.search(kw);
  console.log(`\n=== ${kw}  (main term: ${s.mainTerm}; fetched ${s.stats.fetched}, kept ${s.stats.kept})`);
  for (const w of s.warnings) console.log(`  ! ${w}`);
  console.log('  Course cards:');
  for (const c of s.cards.slice(0, 6)) {
    console.log(`   ${String(c.score).padStart(5)}  ${c.universityName} ${c.courseCode}: ${c.title}  [${c.resourceIds.length} repos]`);
  }
  for (const [label, ids] of [['Sites & videos', s.sites ?? []], ['Awesome', s.awesome], ['Other', s.other]]) {
    console.log(`  ${label}: ${ids.length}`);
    for (const id of ids.slice(0, 5)) {
      const r = s.resources[id];
      const where = r.repo ? `★${r.repo.stars}` : r.host;
      console.log(`   ${String(r.score).padStart(5)}  ${where}  ${r.title}${r.universityName ? ` (${r.universityName})` : ''}`);
    }
  }
  console.log(`  Awesome mining: ${JSON.stringify(s.stats.awesome)}`);
  console.log(`  READMEs: ${JSON.stringify(s.stats.readmes)}  Queries: ${s.expandedQueries.length}`);
  console.log(`  Rate limit: ${JSON.stringify(github.rateLimit())}`);
}
