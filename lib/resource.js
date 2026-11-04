// Turns a GitHub repo into a scored resource, or explains why it was dropped.
// Shared by the search pipeline and the feed.
import { classify } from './classify.js';
import { relevance, score } from './score.js';

// expanded = the expanded query for a search, or null for the feed (no relevance filter).
export function toResource(repo, foundBy, { config, expanded = null, now = Date.now() }) {
  const key = repo.fullName.toLowerCase();
  // Keyword-stuffed spam repos paste whole documents into the description.
  if (config.blockRepos.some((b) => b.toLowerCase() === key) || repo.description.length > config.search.maxDescriptionLength) {
    return { dropped: 'spam' };
  }
  const cls = classify(repo, config);
  const rel = expanded ? relevance(repo, expanded, cls) : 1;
  if (expanded && rel < config.search.minRelevance && !(foundBy.includes('code') && cls.courseCode)) return { dropped: 'irrelevant' };
  // Software projects (databases, frameworks) match topics but are not study material.
  if (!cls.university && !cls.courseCode && !cls.types.length) return { dropped: 'notLearning' };

  const { score: s, breakdown } = score(repo, cls, rel, config, now);
  return {
    resource: {
      id: `gh:${key}`,
      url: repo.url,
      title: repo.fullName,
      description: repo.description,
      repo,
      foundBy,
      ...cls,
      relevance: rel,
      score: s,
      scoreBreakdown: breakdown,
    },
  };
}
