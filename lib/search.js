// The search pipeline: expand → query GitHub → merge → filter → classify → score → group.
import { expandQuery } from './query.js';
import { toResource } from './resource.js';
import { classify } from './classify.js';
import { enrich } from './enrich.js';
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
      // Course-code queries get more results so a popular course does not crowd out the others.
      const { items } = await github.searchRepos(q, { perPage: kind === 'code' ? 100 : perPage });
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

// Known courses for the topic that no repo matched yet (e.g. CMU 15-440 crowded out by MIT 6.824).
export function missingCourses(found, expanded, config) {
  const seen = new Set();
  for (const { repo } of found.values()) {
    const code = classify(repo, config).courseCode;
    if (code) seen.add(code);
  }
  return config.courses.filter((c) => expanded.courses.includes(c.code) && !seen.has(c.code));
}

export function followUpQuery(missing, config) {
  const codes = [...new Set(missing.flatMap((c) => [c.code, ...(c.aliases ?? []).slice(0, 1)]))].slice(0, config.search.maxCodesPerQuery);
  return codes.length ? { kind: 'code', q: `${codes.map((c) => `"${c}"`).join(' OR ')} stars:>=${config.search.codeMinStars}` } : null;
}

export function createSearcher({ config, github, readmes = null, now = Date.now }) {
  async function search(keyword) {
    const expanded = expandQuery(keyword, config);
    const warnings = [];
    const found = await runQueries(github, expanded.queries, config.search.perQuery, warnings);

    // One follow-up query for topical courses with no results, only when the budget allows.
    const rl = github.rateLimit();
    const followUp = warnings.length ? null : followUpQuery(missingCourses(found, expanded, config), config);
    if (followUp && (!rl || rl.remaining >= 3)) {
      const more = await runQueries(github, [followUp], config.search.perQuery, warnings);
      for (const [key, v] of more) {
        if (!found.has(key)) found.set(key, v);
        else for (const k of v.foundBy) found.get(key).foundBy.add(k);
      }
      expanded.queries.push(followUp);
    }

    const t = now();
    const resources = [];
    const dropped = { spam: 0, irrelevant: 0, notLearning: 0 };
    for (const { repo, foundBy } of found.values()) {
      const r = toResource(repo, [...foundBy], { config, expanded, now: t });
      if (r.dropped) dropped[r.dropped]++;
      else resources.push(r.resource);
    }
    resources.sort((a, b) => b.score - a.score);
    let readmeStats = null;
    if (readmes) {
      readmeStats = await enrich(resources, { readmes, config, expanded, now: t });
      resources.sort((a, b) => b.score - a.score);
    }
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
      stats: { fetched: found.size, kept: top.length, ...dropped, droppedForks: grouped.droppedForks, readmes: readmeStats },
      warnings,
      rateLimit: github.rateLimit(),
    };
  }

  return { search };
}
