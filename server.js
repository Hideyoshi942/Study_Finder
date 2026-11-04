// Study Finder: local web app. Start with `npm start` (adds --use-env-proxy for the corporate proxy).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadToken } from './lib/config.js';
import { createCache } from './lib/cache.js';
import { createGitHub } from './lib/github.js';
import { createSearcher } from './lib/search.js';
import { createApp } from './lib/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const config = await loadConfig(ROOT);
const token = await loadToken(ROOT);

const cache = createCache({ dir: path.join(DATA, 'cache'), ttlMs: config.cacheHours * 3600_000 });
const removed = await cache.prune(7 * 24 * 3600_000);
if (removed) console.log(`Pruned ${removed} old cache files`);

const github = createGitHub({ token, cache });
const searcher = createSearcher({ config, github });
const handler = createApp({ config, searcher, github, dataDir: DATA, publicDir: path.join(ROOT, 'public') });

const port = Number(process.env.PORT) || config.port;
const server = http.createServer(handler);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use - Study Finder is probably already running.`);
    console.error(`Open http://localhost:${port}, stop the other process, or start on another port: $env:PORT=4323; npm start`);
    process.exit(1);
  }
  throw e;
});
server.listen(port, config.host, () => {
  console.log(`Study Finder running at http://${config.host}:${port}`);
  console.log(token ? 'GitHub token: yes (30 searches/min)' : 'GitHub token: no (10 searches/min, shared with everyone behind this proxy). Set GITHUB_TOKEN for more.');
});
