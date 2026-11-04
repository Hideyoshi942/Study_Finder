// Disk cache with TTL. One JSON file per key; stale entries are still returned (with fresh=false)
// so callers can revalidate them with an ETag.
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, sha1 } from './store.js';

export function createCache({ dir, ttlMs, now = Date.now }) {
  const fileFor = (key) => path.join(dir, `${sha1(key)}.json`);

  return {
    async get(key) {
      const entry = await readJson(fileFor(key), null);
      if (!entry || entry.key !== key) return null;
      return { value: entry.value, etag: entry.etag ?? null, fresh: now() - entry.savedAt < ttlMs };
    },

    async set(key, value, etag = null) {
      await writeJsonAtomic(fileFor(key), { key, value, etag, savedAt: now() });
    },

    // Removes files older than maxAgeMs. Returns how many were removed.
    async prune(maxAgeMs) {
      let names;
      try {
        names = await readdir(dir);
      } catch (e) {
        if (e.code === 'ENOENT') return 0;
        throw e;
      }
      let removed = 0;
      for (const name of names) {
        const file = path.join(dir, name);
        const s = await stat(file).catch(() => null);
        if (s && now() - s.mtimeMs > maxAgeMs) {
          await unlink(file).catch(() => {});
          removed++;
        }
      }
      return removed;
    },
  };
}
