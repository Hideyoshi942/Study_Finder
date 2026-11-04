// JSON file helpers. Writes are atomic (temp file + rename) so a crash cannot leave a half-written file.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function readJson(file, fallback) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const moved = `${file}.corrupt-${Date.now()}`;
    await rename(file, moved).catch(() => {});
    console.warn(`Corrupt JSON in ${file}; moved to ${moved}`);
    return fallback;
  }
}

export async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

// Kept here for existing imports; the implementation is browser-safe and lives in text.js.
export { slugify } from './text.js';
