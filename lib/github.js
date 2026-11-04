// GitHub search client. The only module that touches the network.
// - Responses are cached on disk; stale entries are revalidated with If-None-Match.
// - Search calls run one at a time and respect x-ratelimit-* headers.
// - 5xx and network errors are retried twice.

const API = 'https://api.github.com';
const RETRY_DELAYS = [1000, 3000];
const MAX_WAIT_MS = 60_000;

export class RateLimitError extends Error {
  constructor(resetAt) {
    super(`GitHub rate limit reached; resets at ${new Date(resetAt).toISOString()}`);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function mapRepo(item) {
  return {
    fullName: item.full_name,
    owner: item.owner?.login ?? item.full_name.split('/')[0],
    name: item.name,
    url: item.html_url,
    description: item.description ?? '',
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    pushedAt: item.pushed_at ?? null,
    archived: Boolean(item.archived),
    isFork: Boolean(item.fork),
    license: item.license?.spdx_id ?? null,
    topics: item.topics ?? [],
    language: item.language ?? null,
  };
}

export function createGitHub({ token = null, cache = null, fetchImpl = fetch, sleep = realSleep, now = Date.now } = {}) {
  let limit = null; // { remaining, limit, resetAt }
  let queue = Promise.resolve();

  const headers = (etag) => ({
    Accept: 'application/vnd.github+json',
    'User-Agent': 'study-finder',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(etag ? { 'If-None-Match': etag } : {}),
  });

  function track(res) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining == null) return;
    limit = {
      remaining: Number(remaining),
      limit: Number(res.headers.get('x-ratelimit-limit')),
      resetAt: Number(res.headers.get('x-ratelimit-reset')) * 1000,
    };
  }

  // Waits for a short reset, or throws when the reset is too far away.
  async function waitForBudget() {
    if (!limit || limit.remaining > 0) return;
    const wait = limit.resetAt - now();
    if (wait <= 0) return;
    if (wait > MAX_WAIT_MS) throw new RateLimitError(limit.resetAt);
    await sleep(wait + 500);
    limit = { ...limit, remaining: limit.limit };
  }

  async function request(url, etag) {
    for (let attempt = 0; ; attempt++) {
      await waitForBudget();
      let res;
      try {
        res = await fetchImpl(url, { headers: headers(etag), signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        if (attempt < RETRY_DELAYS.length) { await sleep(RETRY_DELAYS[attempt]); continue; }
        throw new Error(`GitHub request failed: ${e.message}`);
      }
      track(res);
      if ((res.status === 403 || res.status === 429) && limit?.remaining === 0) {
        if (limit.resetAt - now() > MAX_WAIT_MS) throw new RateLimitError(limit.resetAt);
        continue; // waitForBudget sleeps on the next loop
      }
      if (res.status >= 500 && attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      return res;
    }
  }

  async function cachedGet(url) {
    const hit = cache ? await cache.get(url) : null;
    if (hit?.fresh) return { body: hit.value, fromCache: true };
    const res = await request(url, hit?.etag);
    if (res.status === 304 && hit) {
      await cache.set(url, hit.value, hit.etag);
      return { body: hit.value, fromCache: true };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    if (cache) await cache.set(url, body, res.headers.get('etag'));
    return { body, fromCache: false };
  }

  // Serializes calls so concurrent searches share the rate budget fairly.
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  return {
    searchRepos(q, { perPage = 50 } = {}) {
      const url = `${API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
      return serial(async () => {
        const { body, fromCache } = await cachedGet(url);
        return { items: (body.items ?? []).map(mapRepo), total: body.total_count ?? 0, fromCache };
      });
    },
    rateLimit: () => limit,
    authenticated: Boolean(token),
  };
}
