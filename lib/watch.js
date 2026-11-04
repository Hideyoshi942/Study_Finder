// Watched keywords: re-run a search every N hours and remember which results are new.
import { readJson, writeJsonAtomic, slugify } from './store.js';
import { normalize } from './text.js';
import { ValidationError } from './collections.js';

const HOUR = 3600_000;
const MIN_BUDGET = 7; // one search uses up to 7 GitHub search requests

// runSearch(keyword, refresh) -> search; getSaved(keyword) -> saved search or null.
export function createWatcher({ file, runSearch, getSaved, github, now = Date.now }) {
  let lock = Promise.resolve();
  const update = (fn) => {
    const run = lock.then(async () => {
      const data = await readJson(file, { watches: [] });
      const result = await fn(data);
      await writeJsonAtomic(file, data);
      return result;
    });
    lock = run.catch(() => {});
    return run;
  };
  const view = (w) => ({ ...w, knownIds: undefined, newCount: w.newIds.length });

  async function list() {
    return (await readJson(file, { watches: [] })).watches.map(view);
  }

  async function add(keyword, intervalHours = 24) {
    const k = String(keyword ?? '').trim();
    if (!k || k.length > 100) throw new ValidationError('keyword must be 1-100 characters');
    const hours = Number(intervalHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) throw new ValidationError('intervalHours must be 1-720');
    const id = slugify(normalize(k));
    // Results that already exist are not "new"; only later additions are.
    const saved = await getSaved(k);
    return view(await update((data) => {
      let w = data.watches.find((x) => x.id === id);
      if (w) { w.intervalHours = hours; return w; }
      if (data.watches.length >= 30) throw new ValidationError('Too many watches (max 30)');
      w = {
        id, keyword: k, intervalHours: hours, createdAt: new Date(now()).toISOString(),
        lastRunAt: saved ? saved.createdAt : null, knownIds: saved ? Object.keys(saved.resources) : [], newIds: [], lastError: null,
      };
      data.watches.push(w);
      return w;
    }));
  }

  const remove = (id) => update((data) => {
    data.watches = data.watches.filter((w) => w.id !== id);
    return { ok: true };
  });

  const markSeen = (id) => update((data) => {
    const w = data.watches.find((x) => x.id === id);
    if (!w) throw new ValidationError('Watch not found');
    w.newIds = [];
    return view(w);
  });

  const getNew = async (id) => (await readJson(file, { watches: [] })).watches.find((w) => w.id === id)?.newIds ?? [];

  // Runs at most one due watch per tick, so a long list does not drain the shared budget at once.
  async function tick() {
    const { watches } = await readJson(file, { watches: [] });
    const due = watches
      .filter((w) => !w.lastRunAt || now() - Date.parse(w.lastRunAt) >= w.intervalHours * HOUR)
      .sort((a, b) => Date.parse(a.lastRunAt ?? 0) - Date.parse(b.lastRunAt ?? 0))[0];
    if (!due) return null;
    const rl = github?.rateLimit();
    if (rl && rl.remaining < MIN_BUDGET && rl.resetAt > now()) return null;

    let result = null;
    let error = null;
    try {
      result = await runSearch(due.keyword, true);
      if (result.cached) error = result.warnings?.at(-2) ?? 'Search failed; kept the last results';
    } catch (e) {
      error = e.message;
    }
    return view(await update((data) => {
      const w = data.watches.find((x) => x.id === due.id);
      if (!w) return due;
      w.lastRunAt = new Date(now()).toISOString();
      w.lastError = error;
      if (result && !error) {
        const ids = Object.keys(result.resources);
        const known = new Set(w.knownIds);
        // The first run only records what exists; later runs report additions.
        if (w.knownIds.length) for (const id of ids) if (!known.has(id) && !w.newIds.includes(id)) w.newIds.push(id);
        w.knownIds = [...new Set([...w.knownIds, ...ids])];
      }
      return w;
    }));
  }

  function start() {
    const run = () => tick().catch((e) => console.error('Watch check failed:', e.message));
    setTimeout(run, 60_000).unref();
    setInterval(run, 10 * 60_000).unref();
  }

  return { list, add, remove, markSeen, getNew, tick, start };
}
