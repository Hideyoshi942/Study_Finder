// HTTP request handler. Kept separate from server.js so it can be tested on an ephemeral port.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, slugify } from './store.js';
import { normalize } from './text.js';
import { toMarkdown, toCsv, toJson } from './export.js';
import { buildSuggestIndex, recommend, relatedFor } from './suggest.js';
import { createCollections, ValidationError } from './collections.js';
import { createWatcher } from './watch.js';
import { checkLinks } from './links.js';

const EXPORTS = {
  md: { fn: toMarkdown, type: 'text/markdown; charset=utf-8' },
  csv: { fn: toCsv, type: 'text/csv; charset=utf-8' },
  json: { fn: toJson, type: 'application/json; charset=utf-8' },
};
const MAX_BODY = 64 * 1024;
const MAX_LINK_CHECKS = 80;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/suggest.js': ['suggest.js', 'text/javascript; charset=utf-8'],
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

// Writes must be JSON from this page. A JSON content type cannot be sent cross-site without a CORS
// preflight (which this server never approves), and a foreign Origin header is refused outright.
function checkWrite(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Cross-origin request refused');
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type must be application/json');
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

export function createApp({ config, searcher, github, feed = null, dataDir, publicDir, linkCheckOptions = {} }) {
  const searchFile = (id) => path.join(dataDir, 'searches', `${id}.json`);
  const historyFile = path.join(dataDir, 'history.json');
  const inflight = new Map();
  let historyLock = Promise.resolve();
  const collections = createCollections({ file: path.join(dataDir, 'collections.json') });
  const getSaved = (q) => readJson(searchFile(slugify(normalize(q))), null);
  // runSearch is declared below; the watcher only calls it later, from its timer or a test.
  const watcher = createWatcher({ file: path.join(dataDir, 'watches.json'), runSearch: (q, refresh) => runSearch(q, refresh), getSaved, github });

  const checkId = (id) => { if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid id'); return id; };

  function recordHistory(s) {
    const entry = {
      id: s.id, keyword: s.keyword, createdAt: s.createdAt,
      counts: { cards: s.cards.length, sites: s.sites?.length ?? 0, awesome: s.awesome.length, other: s.other.length },
    };
    historyLock = historyLock.then(async () => {
      const list = (await readJson(historyFile, [])).filter((h) => h.id !== s.id);
      await writeJsonAtomic(historyFile, [entry, ...list].slice(0, HISTORY_MAX));
    });
    return historyLock;
  }

  // Runs (or joins) a search. listener, if given, receives progress/partial events; a listener that
  // joins a run already in progress first gets the latest event of each type.
  async function runSearch(q, refresh, listener = null) {
    const id = slugify(normalize(q));
    if (!refresh) {
      const saved = await readJson(searchFile(id), null);
      if (saved) return { ...saved, cached: true };
    }
    if (!inflight.has(id)) {
      const run = { listeners: new Set(), last: new Map() };
      const onEvent = (e) => {
        run.last.set(e.type, e);
        for (const fn of run.listeners) fn(e);
      };
      inflight.set(id, run);
      run.promise = (async () => {
        try {
          const s = await searcher.search(q, { onEvent });
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
      })();
    }
    const run = inflight.get(id);
    if (listener) {
      for (const e of run.last.values()) listener(e);
      run.listeners.add(listener);
    }
    try {
      return { cached: false, ...(await run.promise) };
    } finally {
      run.listeners.delete(listener);
    }
  }

  // Server-Sent Events: queries/progress/partial while searching, then done (or error).
  async function streamSearch(req, res, q, refresh) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    let closed = false;
    req.on('close', () => { closed = true; });
    const event = (type, data) => { if (!closed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15_000);
    try {
      // The search keeps running if the browser goes away, so its result is still saved.
      const s = await runSearch(q, refresh, (e) => event(e.type, e));
      event('done', { ...s, related: relatedFor(s, config) });
    } catch (e) {
      console.error(e);
      event('error', { error: e.message });
    } finally {
      clearInterval(ping);
      res.end();
    }
  }

  // Collections, watches and link checks: the routes that change data.
  async function writeRoute(req, res, p) {
    checkWrite(req);
    const body = await readBody(req);
    const M = req.method;
    let m;
    if (p === '/api/collections' && M === 'POST') return send(res, 201, await collections.create(body.name));
    if ((m = p.match(/^\/api\/collections\/(c-[a-f0-9]{10})$/))) {
      if (M === 'PATCH') return send(res, 200, await collections.rename(m[1], body.name));
      if (M === 'DELETE') return send(res, 200, await collections.remove(m[1]));
    }
    if ((m = p.match(/^\/api\/collections\/(c-[a-f0-9]{10})\/items$/)) && M === 'PUT') {
      return send(res, 200, await collections.putItem(m[1], body));
    }
    if ((m = p.match(/^\/api\/collections\/(c-[a-f0-9]{10})\/items\/delete$/)) && M === 'POST') {
      return send(res, 200, await collections.removeItem(m[1], String(body.resourceId ?? '')));
    }
    if (p === '/api/watches' && M === 'POST') return send(res, 201, await watcher.add(body.keyword, body.intervalHours ?? 24));
    if ((m = p.match(/^\/api\/watches\/([a-z0-9-]{1,120})$/)) && M === 'DELETE') return send(res, 200, await watcher.remove(m[1]));
    if ((m = p.match(/^\/api\/watches\/([a-z0-9-]{1,120})\/seen$/)) && M === 'POST') return send(res, 200, await watcher.markSeen(m[1]));
    if ((m = p.match(/^\/api\/check-links\/([a-z0-9-]{1,120})$/)) && M === 'POST') {
      return send(res, 200, await checkSearchLinks(m[1]));
    }
    throw new HttpError(404, 'Not found');
  }

  // Checks the curated links of a saved search and stores the result on each resource.
  async function checkSearchLinks(id) {
    const saved = await readJson(searchFile(id), null);
    if (!saved) throw new HttpError(404, 'Search not found');
    const externals = Object.values(saved.resources).filter((r) => r.kind === 'external').slice(0, MAX_LINK_CHECKS);
    const results = await checkLinks(externals.map((r) => r.url), linkCheckOptions);
    const checkedAt = new Date().toISOString();
    for (const r of externals) r.linkStatus = { ...results.get(r.url), checkedAt };
    await writeJsonAtomic(searchFile(id), saved);
    const broken = externals.filter((r) => r.linkStatus.status === 'broken').length;
    return { checked: externals.length, broken, search: { ...saved, cached: true, related: relatedFor(saved, config) } };
  }

  async function route(req, res, url) {
    const p = url.pathname;
    if (req.method !== 'GET') return writeRoute(req, res, p);

    if (STATIC[p]) {
      const [file, type] = STATIC[p];
      const headers = { 'Content-Type': type };
      if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
      return send(res, 200, await readFile(path.join(publicDir, file), 'utf8'), headers);
    }
    if (p === '/api/search/stream') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q || q.length > 100) throw new HttpError(400, 'Keyword must be 1-100 characters');
      return streamSearch(req, res, q, url.searchParams.get('refresh') === '1');
    }
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q || q.length > 100) throw new HttpError(400, 'Keyword must be 1-100 characters');
      const s = await runSearch(q, url.searchParams.get('refresh') === '1');
      return send(res, 200, { ...s, related: relatedFor(s, config) });
    }
    if (p === '/api/searches') return send(res, 200, await readJson(historyFile, []));
    if (p === '/api/suggest-index') return send(res, 200, buildSuggestIndex(config, await readJson(historyFile, [])));
    if (p === '/api/home') {
      const history = await readJson(historyFile, []);
      return send(res, 200, {
        popular: config.popularSearches ?? [],
        topics: (config.topics ?? []).map((t) => ({
          id: t.id, label: t.label, vi: t.vi, query: t.query,
          courses: config.courses.filter((c) => c.topics.includes(t.query)).length,
        })),
        feed: feed ? await feed.get() : null,
        recommendations: recommend(config, history),
        watches: await watcher.list(),
      });
    }
    if (p === '/api/collections') return send(res, 200, await collections.list());
    if (p === '/api/watches') return send(res, 200, await watcher.list());
    let w = p.match(/^\/api\/watches\/([a-z0-9-]{1,120})\/new$/);
    if (w) return send(res, 200, await watcher.getNew(w[1]));
    let m = p.match(/^\/api\/searches\/([^/]+)$/);
    if (m) {
      const saved = await readJson(searchFile(checkId(m[1])), null);
      if (!saved) throw new HttpError(404, 'Search not found');
      return send(res, 200, { ...saved, related: relatedFor(saved, config) });
    }
    m = p.match(/^\/api\/export\/([^/]+)$/);
    if (m) {
      const id = checkId(m[1]);
      const format = url.searchParams.get('format') ?? 'md';
      const exporter = EXPORTS[format];
      if (!exporter) throw new HttpError(400, 'format must be md, csv or json');
      const saved = await readJson(searchFile(id), null);
      if (!saved) throw new HttpError(404, 'Search not found');
      const body = exporter.fn(saved, {
        hideSolutions: url.searchParams.get('hideSolutions') !== '0',
        minStars: Math.max(0, Number(url.searchParams.get('minStars')) || 0),
      });
      return send(res, 200, body, {
        'Content-Type': exporter.type,
        'Content-Disposition': `attachment; filename="${id}.${format}"`,
      });
    }
    if (p === '/api/rate-limit') return send(res, 200, { authenticated: Boolean(github?.authenticated), ...(github?.rateLimit() ?? {}) });
    throw new HttpError(404, 'Not found');
  }

  async function handler(req, res) {
    try {
      await route(req, res, new URL(req.url, 'http://localhost'));
    } catch (e) {
      const status = e instanceof ValidationError ? 400 : e.status ?? 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e.message });
      else res.end();
    }
  }
  // Background jobs (the watch timer) start only when the real server asks, not in tests.
  handler.startBackground = () => watcher.start();
  handler.watcher = watcher;
  return handler;
}
