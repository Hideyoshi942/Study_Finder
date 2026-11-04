import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadConfig(root) {
  return JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
}

// GITHUB_TOKEN from the environment first, then from a local .env file. Never logged.
export async function loadToken(root) {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  try {
    const env = await readFile(path.join(root, '.env'), 'utf8');
    const line = env.split(/\r?\n/).find((l) => /^\s*GITHUB_TOKEN\s*=/.test(l));
    const value = line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    return value || null;
  } catch {
    return null;
  }
}
