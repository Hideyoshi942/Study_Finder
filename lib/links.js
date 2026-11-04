// Dead-link check for course sites and videos found in curated lists.

const BROKEN_CODES = new Set([404, 410]);
const DNS_ERRORS = /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|getaddrinfo/i;

// One URL -> { status: 'ok' | 'broken' | 'unknown', code }. HEAD first; some servers only answer GET.
export async function checkLink(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetchImpl(url, {
        method,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (study-finder link check)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      res.body?.cancel?.().catch(() => {});
      if (res.ok) return { status: 'ok', code: res.status };
      if (BROKEN_CODES.has(res.status)) return { status: 'broken', code: res.status };
      if (method === 'HEAD' && [403, 405, 501].includes(res.status)) continue;
      return { status: 'unknown', code: res.status }; // 403, 429, 5xx: cannot tell
    } catch (e) {
      const msg = `${e.message} ${e.cause?.code ?? ''} ${e.cause?.message ?? ''}`;
      if (DNS_ERRORS.test(msg)) return { status: 'broken', code: 'DNS' };
      return { status: 'unknown', code: e.name === 'TimeoutError' ? 'timeout' : 'error' };
    }
  }
  return { status: 'unknown', code: null };
}

export async function checkLinks(urls, { concurrency = 5, ...opts } = {}) {
  const out = new Map();
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      out.set(url, await checkLink(url, opts));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}
