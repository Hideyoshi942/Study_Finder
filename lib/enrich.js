// README enrichment: for the top results, read the README and refine classification and score.
import { classify } from './classify.js';
import { relevance, score } from './score.js';
import { analyzeReadme } from './readme.js';

// Adds types the README shows clearly, even when the description does not mention them.
function typesFromReadme(types, signals) {
  const out = [...types];
  const add = (t) => { if (!out.includes(t)) out.push(t); };
  if (signals.videos >= 1) add('videos');
  if (signals.slides + signals.lectures >= 3) add('lecture-notes');
  if (signals.assignments >= 3) add('assignments');
  return out;
}

// Mutates the given resources in place. Returns { read, missing }.
export async function enrich(resources, { readmes, config, expanded, now = Date.now(), limit = 30, concurrency = 6, onProgress = null }) {
  const targets = [...resources].sort((a, b) => b.score - a.score).slice(0, limit);
  let next = 0;
  let done = 0;
  const stats = { read: 0, missing: 0 };

  async function worker() {
    while (next < targets.length) {
      const r = targets[next++];
      const text = await readmes.get(r.repo.fullName);
      if (text) {
        const a = analyzeReadme(text, config);
        const cls = classify(r.repo, config, { heading: a.heading, domains: a.domains });
        cls.types = typesFromReadme(cls.types, a.signals);
        const rel = Math.max(r.relevance, relevance(r.repo, expanded, cls));
        const { score: s, breakdown } = score(r.repo, cls, rel, config, now, a);
        Object.assign(r, cls, {
          relevance: rel,
          score: s,
          scoreBreakdown: breakdown,
          lang: a.lang,
          readme: { heading: a.heading, signals: a.signals, domains: a.domains },
        });
        stats.read++;
      } else {
        stats.missing++;
      }
      onProgress?.(++done, targets.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return stats;
}
