// Markdown export of a saved search.
import { isSolutionsOnly } from './score.js';

const fmtStars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
const esc = (s) => String(s ?? '').replace(/([\\[\]|*_`<>])/g, '\\$1').replace(/\s+/g, ' ').trim();

function line(r) {
  const meta = [`★${fmtStars(r.repo?.stars ?? 0)}`];
  if (r.repo?.pushedAt) meta.push(`updated ${r.repo.pushedAt.slice(0, 7)}`);
  if (r.types.length) meta.push(r.types.join(', '));
  let out = `- [${esc(r.title)}](${r.url}) ${meta.join(' · ')}`;
  if (r.description) out += `\n  ${esc(r.description)}`;
  return out;
}

export function toMarkdown(search, { hideSolutions = true, minStars = 0 } = {}) {
  const keep = (id) => {
    const r = search.resources[id];
    return r && (r.repo?.stars ?? 0) >= minStars && !(hideSolutions && isSolutionsOnly(r.types));
  };
  const parts = [
    `# Study resources: ${esc(search.keyword)}`,
    '',
    `_Generated ${search.createdAt.slice(0, 10)} by Study Finder. Searched as: ${search.expandedQueries.map(esc).join(' · ')}_`,
  ];

  const cards = search.cards.map((c) => ({ c, ids: c.resourceIds.filter(keep) })).filter((x) => x.ids.length);
  if (cards.length) {
    parts.push('', '## University courses');
    for (const { c, ids } of cards) {
      parts.push('', `### ${esc(c.universityName)} ${esc(c.courseCode)}: ${esc(c.title)}`);
      for (const id of ids) parts.push(line(search.resources[id]));
    }
  }
  for (const [title, list] of [['Awesome lists & roadmaps', search.awesome], ['Other materials', search.other]]) {
    const ids = list.filter(keep);
    if (!ids.length) continue;
    parts.push('', `## ${title}`, '');
    for (const id of ids) {
      const r = search.resources[id];
      parts.push(r.universityName ? line(r).replace(') ★', `) ${esc(r.universityName)} · ★`) : line(r));
    }
  }
  if (parts.length === 3) parts.push('', 'No results.');
  return parts.join('\n') + '\n';
}
