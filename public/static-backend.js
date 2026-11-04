// Static (GitHub Pages) backend. It answers the same /api/... calls as the local server, without a server:
// - prebuilt searches, the feed and the home page come from JSON files built by GitHub Actions;
// - other keywords are searched live from the browser, WITHOUT a token (GitHub allows ~10 searches/min per IP);
// - lists, watches and history are stored in this browser (localStorage).
// Only loaded on the Pages site; the lib/ files it imports are copied there by build.js.
import { createSearcher } from './lib/search.js';
import { createGitHub } from './lib/github.js';
import { createReadmeFetcher } from './lib/readme.js';
import { recommend, relatedFor } from './lib/suggest.js';
import { normalize, slugify } from './lib/text.js';
import { toMarkdown, toCsv, toJson } from './lib/export.js';

const KEYS = { history: 'sf-history', lists: 'sf-lists', watches: 'sf-watches' };
const STATUSES = ['todo', 'learning', 'done'];
const EXPORTS = {
  md: [toMarkdown, 'text/markdown'],
  csv: [toCsv, 'text/csv'],
  json: [toJson, 'application/json'],
};

async function json(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
}

// localStorage can be missing or full (private windows); everything still works for this visit.
const local = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted */ }
  },
};

const randomId = () => `c-${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

function requireText(v, max, field) {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} is too long (max ${max})`);
  return s;
}

export async function createStaticBackend() {
  const [config, meta] = await Promise.all([json('config.json'), json('data/index.json')]);
  const prebuilt = new Set(meta.searches.map((s) => s.id));

  // In-memory cache for this page session (GitHub responses and READMEs).
  const memory = new Map();
  const cache = {
    async get(k) { const e = memory.get(k); return e ? { value: e.value, etag: e.etag, fresh: true } : null; },
    async set(k, value, etag = null) { memory.set(k, { value, etag }); },
  };
  const github = createGitHub({ cache }); // no token, ever
  const searcher = createSearcher({ config, github, readmes: createReadmeFetcher({ cache }) });
  const live = new Map(); // live searches of this session, by id
  const loadedIds = new Map(); // id -> resource ids of the last loaded search (for watches)

  const history = () => local.get(KEYS.history, []);
  const lists = () => local.get(KEYS.lists, []);
  const watches = () => local.get(KEYS.watches, []);
  const watchView = (w) => ({ id: w.id, keyword: w.keyword, intervalHours: w.intervalHours, lastRunAt: w.lastRunAt, newCount: w.newIds.length });

  function recordHistory(s) {
    const entry = { id: s.id, keyword: s.keyword, createdAt: s.createdAt, counts: { cards: s.cards.length, sites: s.sites?.length ?? 0, awesome: s.awesome.length, other: s.other.length } };
    local.set(KEYS.history, [entry, ...history().filter((h) => h.id !== s.id)].slice(0, 50));
  }

  // A watch on Pages compares each visit with the last one: results not seen before are "new".
  function updateWatch(s) {
    const ids = Object.keys(s.resources);
    loadedIds.set(s.id, ids);
    const all = watches();
    const w = all.find((x) => x.id === s.id);
    if (!w) return;
    const known = new Set(w.knownIds);
    w.newIds = [...new Set([...w.newIds, ...ids.filter((id) => !known.has(id))])];
    w.lastRunAt = s.createdAt;
    local.set(KEYS.watches, all);
  }

  async function search(q, { refresh = false, onEvent = null } = {}) {
    const id = slugify(normalize(q));
    let s;
    if (!refresh && live.has(id)) s = { ...live.get(id), cached: true };
    else if (!refresh && prebuilt.has(id)) s = { ...(await json(`data/searches/${id}.json`)), cached: true, prebuilt: true };
    else {
      s = { ...(await searcher.search(q, { onEvent })), cached: false };
      if (Object.keys(s.resources).length) live.set(id, s);
      else if (prebuilt.has(id)) s = { ...(await json(`data/searches/${id}.json`)), cached: true, prebuilt: true, warnings: [...s.warnings, 'Showing the prebuilt results.'] };
    }
    if (Object.keys(s.resources).length) recordHistory(s);
    updateWatch(s);
    return { ...s, related: relatedFor(s, config) };
  }

  async function get(path) {
    if (path === '/api/suggest-index') {
      const idx = await json('data/suggest-index.json');
      const recent = history().slice(0, 20).map((h) => ({ kind: 'history', label: h.keyword, sub: '', query: h.keyword, keys: normalize(h.keyword) }));
      return { items: [...recent, ...idx.items] };
    }
    if (path === '/api/searches') return history();
    if (path === '/api/rate-limit') return { static: true, authenticated: false, ...(github.rateLimit() ?? {}) };
    if (path === '/api/home') {
      const home = await json('data/home.json');
      return { ...home, recommendations: recommend(config, history()), watches: watches().map(watchView) };
    }
    if (path === '/api/collections') return lists();
    if (path === '/api/watches') return watches().map(watchView);
    const m = path.match(/^\/api\/watches\/([a-z0-9-]+)\/new$/);
    if (m) return watches().find((w) => w.id === m[1])?.newIds ?? [];
    throw new Error(`Not available on the Pages site: ${path}`);
  }

  // Writes: the same routes as lib/app.js, stored in localStorage.
  async function send(method, path, body = {}) {
    const all = lists();
    const save = () => local.set(KEYS.lists, all);
    const find = (id) => { const c = all.find((x) => x.id === id); if (!c) throw new Error('Collection not found'); return c; };
    const now = new Date().toISOString();
    let m;

    if (path === '/api/collections' && method === 'POST') {
      const c = { id: randomId(), name: requireText(body.name, 60, 'name'), createdAt: now, items: [] };
      all.push(c); save(); return c;
    }
    if ((m = path.match(/^\/api\/collections\/(c-[a-f0-9]{10})$/))) {
      if (method === 'PATCH') { const c = find(m[1]); c.name = requireText(body.name, 60, 'name'); save(); return c; }
      if (method === 'DELETE') { find(m[1]); local.set(KEYS.lists, all.filter((c) => c.id !== m[1])); return { ok: true }; }
    }
    if ((m = path.match(/^\/api\/collections\/(c-[a-f0-9]{10})\/items$/)) && method === 'PUT') {
      const c = find(m[1]);
      let item = c.items.find((i) => i.resourceId === body.resourceId);
      if (!item) {
        if (!/^https?:\/\//i.test(body.snapshot?.url ?? '')) throw new Error('url must be http(s)');
        item = { resourceId: String(body.resourceId), snapshot: body.snapshot, status: 'todo', note: '', addedAt: now };
        c.items.push(item);
      }
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
        item.status = body.status;
      }
      if (body.note !== undefined) item.note = String(body.note).slice(0, 1000);
      item.updatedAt = now;
      save(); return c;
    }
    if ((m = path.match(/^\/api\/collections\/(c-[a-f0-9]{10})\/items\/delete$/)) && method === 'POST') {
      const c = find(m[1]);
      c.items = c.items.filter((i) => i.resourceId !== body.resourceId);
      save(); return c;
    }

    const ws = watches();
    if (path === '/api/watches' && method === 'POST') {
      const keyword = requireText(body.keyword, 100, 'keyword');
      const id = slugify(normalize(keyword));
      if (!ws.some((w) => w.id === id)) ws.push({ id, keyword, intervalHours: 24, createdAt: now, lastRunAt: now, knownIds: loadedIds.get(id) ?? [], newIds: [] });
      local.set(KEYS.watches, ws);
      return watchView(ws.find((w) => w.id === id));
    }
    if ((m = path.match(/^\/api\/watches\/([a-z0-9-]+)$/)) && method === 'DELETE') {
      local.set(KEYS.watches, ws.filter((w) => w.id !== m[1]));
      return { ok: true };
    }
    if ((m = path.match(/^\/api\/watches\/([a-z0-9-]+)\/seen$/)) && method === 'POST') {
      const w = ws.find((x) => x.id === m[1]);
      if (w) {
        w.knownIds = [...new Set([...w.knownIds, ...(loadedIds.get(w.id) ?? [])])];
        w.newIds = [];
        local.set(KEYS.watches, ws);
      }
      return w ? watchView(w) : { ok: true };
    }
    throw new Error('This action needs the local app (npm start).');
  }

  // Builds the export in the browser and downloads it.
  function download(search, format, opts) {
    const [fn, type] = EXPORTS[format];
    const blob = new Blob([fn(search, opts)], { type: `${type};charset=utf-8` });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${search.id}.${format}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { get, send, search, download, builtAt: meta.builtAt };
}
