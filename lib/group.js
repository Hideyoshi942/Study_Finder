// Drops duplicate forks and sorts resources into course cards, awesome lists and other materials.

const byScore = (a, b) => b.score - a.score;

export function group(resources) {
  const originals = new Set(resources.filter((r) => !r.repo?.isFork).map((r) => r.repo?.name?.toLowerCase()));
  const kept = resources.filter((r) => !(r.repo?.isFork && originals.has(r.repo.name.toLowerCase()))).sort(byScore);

  const cards = new Map();
  const awesome = [];
  const other = [];
  for (const r of kept) {
    if (r.university && r.courseCode) {
      const key = `${r.university}:${r.courseCode}`;
      if (!cards.has(key)) cards.set(key, { key, university: r.university, universityName: r.universityName, courseCode: r.courseCode, title: r.courseTitle ?? r.title, members: [] });
      cards.get(key).members.push(r);
    } else if (r.types.includes('awesome-list') || r.types.includes('roadmap')) awesome.push(r.id);
    else other.push(r.id);
  }

  const cardList = [...cards.values()].map(({ members, ...card }) => {
    const distinctTypes = new Set(members.flatMap((m) => m.types)).size;
    return {
      ...card,
      score: Math.round((members[0].score + Math.min(8, 2 * Math.max(0, distinctTypes - 1))) * 10) / 10,
      resourceIds: members.map((m) => m.id),
    };
  });

  return { cards: cardList.sort(byScore), awesome, other, droppedForks: resources.length - kept.length };
}
