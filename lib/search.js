// The search pipeline: expand → query GitHub → merge → filter → classify → score → group.
import { expandQuery } from './query.js';
import { classify } from './classify.js';
import { relevance, score } from './score.js';
import { group } from './group.js';
import { RateLimitError } from './github.js';
import { slugify } from './store.js';

const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

export function createSearcher({ config, github, now = Date.now }) {
  const blocked = new Set(config.blockRepos.map((r) => r.toLowerCase()));

  async function search(keyword) {
    const expanded = expandQuery(keyword, config);
    const warnings = [];
    const found = new Map(); // fullName(lower) -> { repo, foundBy:Set }

    let failuresInARow = 0;
    for (const { q, kind } of expanded.queries) {
      try {
        const { items } = await github.searchRepos(q, { perPage: config.search.perQuery });
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

    const t = now();
    const resources = [];
    const dropped = { spam: 0, irrelevant: 0, notLearning: 0 };
    for (const [key, { repo, foundBy }] of found) {
      // Keyword-stuffed spam repos paste whole documents into the description.
      if (blocked.has(key) || repo.description.length > config.search.maxDescriptionLength) { dropped.spam++; continue; }
      const cls = classify(repo, config);
      const rel = relevance(repo, expanded, cls);
      if (rel < config.search.minRelevance && !(foundBy.has('code') && cls.courseCode)) { dropped.irrelevant++; continue; }
      // Software projects (databases, frameworks) match topics but are not study material.
      if (!cls.university && !cls.courseCode && !cls.types.length) { dropped.notLearning++; continue; }
      const { score: s, breakdown } = score(repo, cls, rel, config, t);
      resources.push({
        id: `gh:${key}`,
        url: repo.url,
        title: repo.fullName,
        description: repo.description,
        repo,
        foundBy: [...foundBy],
        ...cls,
        relevance: rel,
        score: s,
        scoreBreakdown: breakdown,
      });
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
