// "New on GitHub" feed: new course repos, and new repos for well-known courses this semester.
// Refreshed in the background, and only when the shared search budget allows it.
import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';
import { toResource } from './resource.js';
import { runQueries } from './search.js';
import { isSolutionsOnly } from './score.js';

const DAY = 24 * 3600 * 1000;
const LEARNING_TYPES = ['course', 'lecture-notes', 'videos', 'assignments', 'book'];
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export function feedQueries(config, now) {
  const f = config.feed;
  return [
    { kind: 'fresh', q: `course OR lecture OR syllabus created:>${isoDate(now - f.freshDays * DAY)} stars:>=${f.freshMinStars}` },
    ...f.codeBatches.slice(0, 2).map((codes) => ({
      kind: 'semester',
      q: `${codes.map((c) => `"${c}"`).join(' OR ')} created:>${isoDate(now - f.semesterDays * DAY)} stars:>=${f.semesterMinStars}`,
    })),
  ];
}

// Builds both feed sections from merged query results.
export function buildSections(found, config, now) {
  const fresh = [];
  const semester = [];
  for (const { repo, foundBy } of found.values()) {
    const { resource: r } = toResource(repo, [...foundBy], { config, now });
    if (!r || isSolutionsOnly(r.types)) continue;
    if (foundBy.has('semester') && r.courseCode) semester.push(r);
    else if (foundBy.has('fresh') && (r.courseCode || r.types.some((t) => LEARNING_TYPES.includes(t)))) fresh.push(r);
  }
  fresh.sort((a, b) => b.repo.stars - a.repo.stars);
  semester.sort((a, b) => b.score - a.score);
  // At most two repos per course, so one popular course does not fill the list.
  const perCourse = new Map();
  const semesterTop = semester.filter((r) => {
    const n = (perCourse.get(r.courseCode) ?? 0) + 1;
    perCourse.set(r.courseCode, n);
    return n <= 2;
  });
  return { fresh: fresh.slice(0, config.feed.limit), semester: semesterTop.slice(0, config.feed.limit) };
}

export function createFeed({ config, github, dataDir, now = Date.now }) {
  const file = path.join(dataDir, 'feed.json');
  const intervalMs = config.feed.intervalHours * 3600_000;
  let state = null;
  let running = null;
  let lastStatus = null;

  async function snapshot() {
    if (!state) state = await readJson(file, { updatedAt: null, fresh: [], semester: [], warnings: [] });
    return { ...state, status: lastStatus };
  }

  async function get() {
    const s = await snapshot();
    return running ? { ...s, status: 'refreshing' } : s;
  }

  const isStale = (s) => !s.updatedAt || now() - Date.parse(s.updatedAt) >= intervalMs;

  async function doRefresh(force) {
    const current = await snapshot();
    if (!force && !isStale(current)) return current;
    const rl = github.rateLimit();
    if (rl && rl.remaining < config.feed.minBudget && rl.resetAt > now()) {
      lastStatus = `Waiting for GitHub budget (${rl.remaining} searches left)`;
      return snapshot();
    }
    const warnings = [];
    const t = now();
    const found = await runQueries(github, feedQueries(config, t), 50, warnings);
    if (!found.size) {
      lastStatus = warnings[0] ?? 'No results';
      return snapshot(); // keep the previous feed
    }
    state = { updatedAt: new Date(t).toISOString(), ...buildSections(found, config, t), warnings };
    lastStatus = null;
    await writeJsonAtomic(file, state);
    return snapshot();
  }

  function refresh({ force = false } = {}) {
    if (!running) running = doRefresh(force).finally(() => { running = null; });
    return running;
  }

  // Checks every 30 minutes; refreshes when stale. The first check waits a few seconds after startup.
  function start() {
    const tick = () => refresh().catch((e) => { lastStatus = e.message; console.error('Feed refresh failed:', e.message); });
    setTimeout(tick, 5000).unref();
    setInterval(tick, 30 * 60_000).unref();
  }

  return { get, refresh, start };
}
