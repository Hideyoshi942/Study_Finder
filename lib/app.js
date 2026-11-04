// HTTP request handler. Kept separate from server.js so it can be tested on an ephemeral port.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, slugify } from './store.js';
import { normalize } from './text.js';
import { toMarkdown } from './export.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'";
const ID_RE = /^[a-z0-9-]{1,120}$/;
const HISTORY_MAX = 100;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

export function createApp({ config, searcher, github, dataDir, publicDir }) {
  const searchFile = (id) => path.join(dataDir, 'searches', `${id}.json`);
  const historyFile = path.join(dataDir, 'history.json');
  const inflight = new Map();
  let historyLock = Promise.resolve();

  const checkId = (id) => { if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid id'); return id; };

  function recordHistory(s) {
    const entry = {
      id: s.id, keyword: s.keyword, createdAt: s.createdAt,
      counts: { cards: s.cards.length, awesome: s.awesome.length, other: s.other.length },
    };
    historyLock = historyLock.then(async () => {
      const list = (await readJson(historyFile, [])).filter((h) => h.id !== s.id);
      await writeJsonAtomic(historyFile, [entry, ...list].slice(0, HISTORY_MAX));
    });
    return historyLock;
  }

  async function runSearch(q, refresh) {
    const id = slugify(normalize(q));
    if (!refresh) {
      const saved = await readJson(searchFile(id), null);
      if (saved) return { ...saved, cached: true };
    }
    if (!inflight.has(id)) {
      inflight.set(id, (async () => {
        try {
          const s = await searcher.search(q);
          // Don't overwrite a good saved search with an empty one produced by a rate limit or outage.
          const hasResults = Object.keys(s.resources).length > 0;
          if (hasResults) {
            await writeJsonAtomic(searchFile(id), s);
            await recordHistory(s);
            return s;
          }
          const previous = await readJson(searchFile(id), null);
          return previous ? { ...previous, cached: true, warnings: [...s.warnings, 'Showing the last saved results.'] } : s;
        } finally {
          inflight.delete(id);
        }
      })());
    }
    return { cached: false, ...(await inflight.get(id)) };
  }

  async function route(req, res, url) {
    const p = url.pathname;
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');

    if (STATIC[p]) {
      const [file, type] = STATIC[p];
      const headers = { 'Content-Type': type };
      if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
      return send(res, 200, await readFile(path.join(publicDir, file), 'utf8'), headers);
    }
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q || q.length > 100) throw new HttpError(400, 'Keyword must be 1-100 characters');
      return send(res, 200, await runSearch(q, url.searchParams.get('refresh') === '1'));
    }
    if (p === '/api/searches') return send(res, 200, await readJson(historyFile, []));
    let m = p.match(/^\/api\/searches\/([^/]+)$/);
    if (m) {
      const saved = await readJson(searchFile(checkId(m[1])), null);
      if (!saved) throw new HttpError(404, 'Search not found');
      return send(res, 200, saved);
    }
    m = p.match(/^\/api\/export\/([^/]+)$/);
    if (m) {
      const id = checkId(m[1]);
      if ((url.searchParams.get('format') ?? 'md') !== 'md') throw new HttpError(400, 'Only format=md is supported');
      const saved = await readJson(searchFile(id), null);
      if (!saved) throw new HttpError(404, 'Search not found');
      const md = toMarkdown(saved, {
        hideSolutions: url.searchParams.get('hideSolutions') !== '0',
        minStars: Math.max(0, Number(url.searchParams.get('minStars')) || 0),
      });
      return send(res, 200, md, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${id}.md"`,
      });
    }
    if (p === '/api/rate-limit') return send(res, 200, { authenticated: Boolean(github?.authenticated), ...(github?.rateLimit() ?? {}) });
    throw new HttpError(404, 'Not found');
  }

  return async function handler(req, res) {
    try {
      await route(req, res, new URL(req.url, 'http://localhost'));
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) console.error(e);
      send(res, status, { error: e.message });
    }
  };
}
