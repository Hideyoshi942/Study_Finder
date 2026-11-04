// The search pipeline: expand → query GitHub → merge → filter → classify → score → group.
import { expandQuery } from './query.js';
import { toResource } from './resource.js';
import { classify } from './classify.js';
import { enrich } from './enrich.js';
import { parseAwesome, mineAwesome } from './awesome.js';
import { group } from './group.js';
import { RateLimitError } from './github.js';
import { slugify } from './text.js';

export const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

// Runs queries in order and merges repos by name. Stops on a rate limit or after two failures in a row.
// onQueryDone(found) runs after each query, so callers can show partial results.
export async function runQueries(github, queries, perPage, warnings, onQueryDone = null, found = new Map()) {
  // found: fullName(lower) -> { repo, foundBy:Set }
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
      onQueryDone?.(found);
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

// Repos -> scored resources, best first.
function buildResources(found, expanded, config, t) {
  const resources = [];
  const dropped = { spam: 0, irrelevant: 0, notLearning: 0 };
  for (const { repo, foundBy } of found.values()) {
    const r = toResource(repo, [...foundBy], { config, expanded, now: t });
    if (r.dropped) dropped[r.dropped]++;
    else resources.push(r.resource);
  }
  return { resources: resources.sort((a, b) => b.score - a.score), dropped };
}

// onEvent receives { type: 'queries' | 'progress' | 'partial', ... } while the search runs:
//   progress: { stage: 'search' | 'wait' | 'readme' | 'awesome', done, total, waitMs? }
//   partial:  a search object (same shape as the final one) built from what was found so far.
export function createSearcher({ config, github, readmes = null, now = Date.now }) {
  async function search(keyword, { onEvent = null } = {}) {
    const emit = (e) => { try { onEvent?.(e); } catch { /* a listener must not break the search */ } };
    const expanded = expandQuery(keyword, config);
    const warnings = [];
    const t = now();
    const base = {
      id: slugify(expanded.normalized),
      keyword: keyword.trim(),
      normalized: expanded.normalized,
      mainTerm: expanded.main,
      expandedQueries: expanded.queries.map((x) => x.q),
      createdAt: new Date(t).toISOString(),
    };
    const snapshot = (list) => {
      const g = group(list);
      return {
        ...base, resources: Object.fromEntries(list.map((r) => [r.id, r])),
        cards: g.cards, awesome: g.awesome, sites: g.sites, other: g.other, warnings: [...warnings], partial: true,
        droppedForks: g.droppedForks,
      };
    };

    emit({ type: 'queries', queries: base.expandedQueries });
    const stopWaitEvents = github.onWait?.(({ ms }) => emit({ type: 'progress', stage: 'wait', waitMs: ms }));
    let searched = 0;
    const totalQueries = () => expanded.queries.length;
    const onQueryDone = (found) => {
      emit({ type: 'progress', stage: 'search', done: ++searched, total: totalQueries() });
      emit({ type: 'partial', search: snapshot(buildResources(found, expanded, config, t).resources.slice(0, config.search.resultLimit)) });
    };
    let found;
    try {
      found = await runQueries(github, expanded.queries, config.search.perQuery, warnings, onQueryDone);

      // One follow-up query for topical courses with no results, only when the budget allows.
      const rl = github.rateLimit();
      const followUp = warnings.length ? null : followUpQuery(missingCourses(found, expanded, config), config);
      if (followUp && (!rl || rl.remaining >= 3)) {
        expanded.queries.push(followUp);
        base.expandedQueries = expanded.queries.map((x) => x.q);
        await runQueries(github, [followUp], config.search.perQuery, warnings, onQueryDone, found);
      }
    } finally {
      stopWaitEvents?.();
    }

    const { resources, dropped } = buildResources(found, expanded, config, t);
    let readmeStats = null;
    if (readmes) {
      readmeStats = await enrich(resources, {
        readmes, config, expanded, now: t,
        onProgress: (done, total) => emit({ type: 'progress', stage: 'readme', done, total }),
      });
      resources.sort((a, b) => b.score - a.score);
    }
    const top = resources.slice(0, config.search.resultLimit);

    // Course sites and video playlists from curated lists (seed lists + the best awesome lists found).
    let awesomeStats = null;
    if (readmes && config.awesome) {
      emit({ type: 'partial', search: snapshot(top) });
      emit({ type: 'progress', stage: 'awesome', done: 0, total: 1 });
      // The most relevant awesome lists, not the most starred (those can be off-topic, e.g. prompt lists).
      const fromResults = top
        .filter((r) => r.types.includes('awesome-list') && r.relevance >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, config.awesome.fromResults)
        .map((r) => r.repo.fullName);
      const lists = [...new Set([...config.awesome.seeds, ...fromResults])];
      const texts = await Promise.all(lists.map((l) => readmes.get(l)));
      const entries = lists.flatMap((l, i) => (texts[i] ? parseAwesome(texts[i], l) : []));
      const { externals, repoHits } = mineAwesome(entries, expanded, config);
      for (const r of top) if (repoHits.has(r.repo.fullName.toLowerCase()) && !r.foundBy.includes('awesome')) r.foundBy.push('awesome');
      top.push(...externals);
      awesomeStats = { lists: lists.filter((_, i) => texts[i]), entries: entries.length, externals: externals.length, repoHits: repoHits.size };
    }
    const { partial, droppedForks, ...final } = snapshot(top);
    return {
      ...final,
      stats: { fetched: found.size, kept: top.length, ...dropped, droppedForks, readmes: readmeStats, awesome: awesomeStats },
      warnings,
      rateLimit: github.rateLimit(),
    };
  }

  return { search };
}
