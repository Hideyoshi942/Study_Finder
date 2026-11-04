// The search pipeline: expand → query GitHub → merge → filter → classify → score → group.
import { expandQuery } from './query.js';
import { toResource } from './resource.js';
import { group } from './group.js';
import { RateLimitError } from './github.js';
import { slugify } from './store.js';

export const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

// Runs queries in order and merges repos by name. Stops on a rate limit or after two failures in a row.
export async function runQueries(github, queries, perPage, warnings) {
  const found = new Map(); // fullName(lower) -> { repo, foundBy:Set }
  let failuresInARow = 0;
  for (const { q, kind } of queries) {
    try {
      const { items } = await github.searchRepos(q, { perPage });
      failuresInARow = 0;
      for (const repo of items) {
        const key = repo.fullName.toLowerCase();
        if (!found.has(key)) found.set(key, { repo, foundBy: new Set() });
        found.get(key).foundBy.add(kind);
      }
    } catch (e) {
      if (e instanceof RateLimitError) {
        warnings.push(`GitHub rate limit reached; showing partial results. Resets at ${hhmm(e.resetAt)}.`);
        break;
      }
      warnings.push(`Query "${q}" failed: ${e.message}`);
      // Each failure already includes retries; stop instead of making the user wait through all of them.
      if (++failuresInARow >= 2) {
        warnings.push('GitHub is unreachable right now (network or proxy error). Try again in a minute.');
        break;
      }
    }
  }
  return found;
}

export function createSearcher({ config, github, now = Date.now }) {
  async function search(keyword) {
    const expanded = expandQuery(keyword, config);
    const warnings = [];
    const found = await runQueries(github, expanded.queries, config.search.perQuery, warnings);

    const t = now();
    const resources = [];
    const dropped = { spam: 0, irrelevant: 0, notLearning: 0 };
    for (const { repo, foundBy } of found.values()) {
      const r = toResource(repo, [...foundBy], { config, expanded, now: t });
      if (r.dropped) dropped[r.dropped]++;
      else resources.push(r.resource);
    }
    resources.sort((a, b) => b.score - a.score);
    const top = resources.slice(0, config.search.resultLimit);
    const grouped = group(top);

    return {
      id: slugify(expanded.normalized),
      keyword: keyword.trim(),
      normalized: expanded.normalized,
      mainTerm: expanded.main,
      expandedQueries: expanded.queries.map((x) => x.q),
      createdAt: new Date(t).toISOString(),
      resources: Object.fromEntries(top.map((r) => [r.id, r])),
      cards: grouped.cards,
      awesome: grouped.awesome,
      other: grouped.other,
      stats: { fetched: found.size, kept: top.length, ...dropped, droppedForks: grouped.droppedForks },
      warnings,
      rateLimit: github.rateLimit(),
    };
  }

  return { search };
}
