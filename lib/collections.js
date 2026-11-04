// Saved lists of resources with study progress (todo / learning / done) and notes.
import { randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic } from './store.js';

export const STATUSES = ['todo', 'learning', 'done'];

export class ValidationError extends Error {}

const text = (v, max, field) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new ValidationError(`${field} is too long (max ${max})`);
  return s;
};

// Only these fields of a resource are kept, so a collection still shows after its search is gone.
export function cleanSnapshot(s) {
  if (!s || typeof s !== 'object') throw new ValidationError('snapshot is required');
  const url = text(s.url, 500, 'url');
  if (!/^https?:\/\//i.test(url)) throw new ValidationError('url must be http(s)');
  return {
    title: text(s.title, 200, 'title') || url,
    url,
    kind: s.kind === 'external' ? 'external' : 'repo',
    host: text(s.host, 120, 'host'),
    university: text(s.university, 40, 'university'),
    universityName: text(s.universityName, 80, 'universityName'),
    courseCode: text(s.courseCode, 30, 'courseCode'),
    courseTitle: text(s.courseTitle, 200, 'courseTitle'),
    stars: Number.isFinite(s.stars) ? s.stars : null,
    types: Array.isArray(s.types) ? s.types.filter((t) => typeof t === 'string').slice(0, 10) : [],
    description: text(s.description, 300, 'description'),
  };
}

export function createCollections({ file, now = Date.now }) {
  let lock = Promise.resolve();
  // Serializes read-modify-write so two quick clicks cannot lose an update.
  const update = (fn) => {
    const run = lock.then(async () => {
      const data = await readJson(file, { collections: [] });
      const result = await fn(data);
      await writeJsonAtomic(file, data);
      return result;
    });
    lock = run.catch(() => {});
    return run;
  };
  const find = (data, id) => {
    const c = data.collections.find((x) => x.id === id);
    if (!c) throw new ValidationError('Collection not found');
    return c;
  };
  const iso = () => new Date(now()).toISOString();

  return {
    list: async () => (await readJson(file, { collections: [] })).collections,

    create: (name) => update((data) => {
      const n = text(name, 60, 'name');
      if (!n) throw new ValidationError('name is required');
      if (data.collections.length >= 50) throw new ValidationError('Too many collections (max 50)');
      const c = { id: `c-${randomBytes(5).toString('hex')}`, name: n, createdAt: iso(), items: [] };
      data.collections.push(c);
      return c;
    }),

    rename: (id, name) => update((data) => {
      const n = text(name, 60, 'name');
      if (!n) throw new ValidationError('name is required');
      const c = find(data, id);
      c.name = n;
      return c;
    }),

    remove: (id) => update((data) => {
      find(data, id);
      data.collections = data.collections.filter((c) => c.id !== id);
      return { ok: true };
    }),

    // Adds the resource, or updates its status/note when it is already in the list.
    putItem: (id, { resourceId, snapshot, status, note }) => update((data) => {
      const c = find(data, id);
      const rid = text(resourceId, 300, 'resourceId');
      if (!rid) throw new ValidationError('resourceId is required');
      let item = c.items.find((i) => i.resourceId === rid);
      if (!item) {
        if (c.items.length >= 500) throw new ValidationError('Collection is full (max 500)');
        item = { resourceId: rid, snapshot: cleanSnapshot(snapshot), status: 'todo', note: '', addedAt: iso() };
        c.items.push(item);
      }
      if (status !== undefined) {
        if (!STATUSES.includes(status)) throw new ValidationError(`status must be one of ${STATUSES.join(', ')}`);
        item.status = status;
      }
      if (note !== undefined) item.note = text(note, 1000, 'note');
      item.updatedAt = iso();
      return c;
    }),

    removeItem: (id, resourceId) => update((data) => {
      const c = find(data, id);
      c.items = c.items.filter((i) => i.resourceId !== resourceId);
      return c;
    }),
  };
}
