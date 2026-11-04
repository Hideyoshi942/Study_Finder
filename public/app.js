// Study Finder UI. Renders a saved search and applies filters in the browser.
// All data goes into the DOM through textContent / attributes, never innerHTML.

const $ = (id) => document.getElementById(id);
const LEVELS = ['intro', 'intermediate', 'advanced', 'unknown'];
const TYPE_LABELS = {
  'course': 'Course', 'lecture-notes': 'Notes', 'videos': 'Videos', 'assignments': 'Assignments',
  'solutions': 'Solutions', 'book': 'Book', 'guide': 'Guide', 'awesome-list': 'Awesome list', 'roadmap': 'Roadmap',
};
const CARD_PREVIEW = 4;
const YEAR = 365.25 * 24 * 3600 * 1000;

let current = null; // the loaded search
const ui = { universities: new Set(), types: new Set(), levels: new Set() };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const fmtStars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
const month = (iso) => (iso ? iso.slice(0, 7) : '');

// ---------- data ----------
async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function runSearch(q, { refresh = false, push = true } = {}) {
  q = q.trim();
  if (!q) return;
  $('q').value = q;
  if (push) history.pushState({ q }, '', `?q=${encodeURIComponent(q)}`);
  document.title = `${q} · Study Finder`;
  showLoading();
  try {
    current = await api(`/api/search?q=${encodeURIComponent(q)}${refresh ? '&refresh=1' : ''}`);
    resetFilters(false);
    buildFilters();
    render();
  } catch (e) {
    current = null;
    $('toolbar').hidden = true;
    $('filters').hidden = true;
    $('queries').textContent = '';
    $('content').replaceChildren();
    $('banner').replaceChildren(h('div', { class: 'banner error' }, e.message));
  }
  loadHistory();
  loadRate();
}

async function loadHistory() {
  try {
    const list = await api('/api/searches');
    $('history').replaceChildren(...list.slice(0, 8).map((s) =>
      h('button', { type: 'button', title: `Searched ${s.createdAt.slice(0, 10)}`, onclick: () => runSearch(s.keyword) }, s.keyword)));
  } catch { /* history is optional */ }
}

async function loadRate() {
  try {
    const r = await api('/api/rate-limit');
    const el = $('rate');
    if (r.remaining == null) {
      el.textContent = r.authenticated ? 'GitHub token' : 'No GitHub token';
      el.title = r.authenticated ? '30 searches/min' : '10 searches/min, shared with everyone behind this proxy';
      return;
    }
    el.textContent = `GitHub ${r.remaining}/${r.limit}${r.authenticated ? ' · token' : ''}`;
    el.classList.toggle('low', r.remaining <= 2);
    el.title = `Search requests left until ${new Date(r.resetAt).toLocaleTimeString()}`;
  } catch { /* ignore */ }
}

// ---------- filters ----------
function filterState() {
  return {
    minStars: Math.max(0, Number($('f-stars').value) || 0),
    years: Number($('f-updated').value),
    official: $('f-official').checked,
    hideSolutions: $('f-solutions').checked,
  };
}

const solutionsOnly = (types) =>
  types.includes('solutions') && !types.some((t) => ['lecture-notes', 'videos', 'book', 'guide', 'awesome-list', 'roadmap'].includes(t));

function passes(r, f) {
  const uni = r.university ?? 'none';
  if (ui.universities.size && !ui.universities.has(uni)) return false;
  if (ui.types.size && !r.types.some((t) => ui.types.has(t))) return false;
  if (ui.levels.size && !ui.levels.has(r.level)) return false;
  if ((r.repo?.stars ?? 0) < f.minStars) return false;
  if (f.years && (!r.repo?.pushedAt || Date.now() - Date.parse(r.repo.pushedAt) > f.years * YEAR)) return false;
  if (f.official && !r.official) return false;
  if (f.hideSolutions && solutionsOnly(r.types)) return false;
  return true;
}

function checkboxGroup(container, entries, set) {
  container.replaceChildren(...entries.map(([value, label, count]) =>
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', value, checked: set.has(value), onchange: (e) => { e.target.checked ? set.add(value) : set.delete(value); render(); } }),
      label, h('span', { class: 'count' }, count))));
}

function buildFilters() {
  const all = Object.values(current.resources);
  const count = (fn) => all.reduce((m, r) => { for (const k of [].concat(fn(r))) m.set(k, (m.get(k) ?? 0) + 1); return m; }, new Map());

  const unis = count((r) => r.university ?? 'none');
  const names = new Map(all.map((r) => [r.university ?? 'none', r.universityName ?? 'No university']));
  const uniEntries = [...unis].sort((a, b) => (a[0] === 'none') - (b[0] === 'none') || b[1] - a[1]).map(([k, n]) => [k, names.get(k), n]);
  checkboxGroup($('f-university'), uniEntries, ui.universities);

  const types = count((r) => r.types);
  checkboxGroup($('f-type'), Object.keys(TYPE_LABELS).filter((t) => types.has(t)).map((t) => [t, TYPE_LABELS[t], types.get(t)]), ui.types);

  const levels = count((r) => r.level);
  checkboxGroup($('f-level'), LEVELS.filter((l) => levels.has(l)).map((l) => [l, l[0].toUpperCase() + l.slice(1), levels.get(l)]), ui.levels);
}

function resetFilters(rerender = true) {
  ui.universities.clear(); ui.types.clear(); ui.levels.clear();
  $('f-stars').value = 0; $('f-updated').value = '0'; $('f-official').checked = false; $('f-solutions').checked = true;
  if (rerender && current) { buildFilters(); render(); }
}

// ---------- rendering ----------
function sortKey(r) {
  const mode = $('sort').value;
  if (mode === 'stars') return r.repo?.stars ?? 0;
  if (mode === 'updated') return Date.parse(r.repo?.pushedAt ?? 0) || 0;
  return r.score;
}

function whyText(r) {
  const b = r.scoreBreakdown ?? {};
  const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
  const lines = [`Score ${r.score}`, `stars ${pct(b.stars)} · relevance ${pct(b.relevance)} · university ${pct(b.university)}`,
    `content ${pct(b.content)} · freshness ${pct(b.freshness)}${b.penalties ? ` · penalty −${b.penalties}` : ''}`];
  if (r.universityMatchedBy) lines.push(`University matched by ${r.universityMatchedBy}`);
  lines.push(`Found by: ${r.foundBy.join(', ')}`);
  return lines.join('\n');
}

function item(r, { showUni = false } = {}) {
  return h('li', { class: 'item' },
    h('div', { class: 'item-line' },
      h('a', { class: 'item-title', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title),
      showUni && r.universityName ? h('span', { class: 'badge' }, r.universityName) : null,
      r.official ? h('span', { class: 'badge official' }, 'official') : null,
      h('span', { class: 'meta', title: whyText(r) }, `★ ${fmtStars(r.repo?.stars ?? 0)}`, r.repo?.pushedAt ? ` · ${month(r.repo.pushedAt)}` : ''),
      h('span', { class: 'chips' }, r.types.map((t) => h('span', { class: 'badge' }, TYPE_LABELS[t] ?? t)))),
    r.description ? h('p', { class: 'desc' }, r.description) : null);
}

function card(c, members) {
  const levels = [...new Set(members.map((m) => m.level).filter((l) => l !== 'unknown'))];
  const list = h('ul', { class: 'list' }, members.slice(0, CARD_PREVIEW).map((m) => item(m)));
  const rest = members.length - CARD_PREVIEW;
  const more = rest > 0
    ? h('button', { type: 'button', class: 'link more', onclick: (e) => { list.replaceChildren(...members.map((m) => item(m))); e.target.remove(); } }, `Show ${rest} more`)
    : null;
  return h('article', { class: 'card' },
    h('div', { class: 'card-head' },
      h('span', { class: 'card-title' }, h('span', { class: 'card-uni' }, `${c.universityName} ${c.courseCode}`), ` · ${c.title}`),
      members.some((m) => m.official) ? h('span', { class: 'badge official' }, 'official') : null,
      levels.map((l) => h('span', { class: 'badge' }, l))),
    list, more);
}

function render() {
  if (!current) return;
  const f = filterState();
  const by = (a, b) => sortKey(b) - sortKey(a);
  const pick = (ids) => ids.map((id) => current.resources[id]).filter((r) => r && passes(r, f)).sort(by);

  const cards = current.cards
    .map((c) => ({ c, members: pick(c.resourceIds) }))
    .filter((x) => x.members.length)
    .sort((a, b) => ($('sort').value === 'score' ? b.c.score - a.c.score : sortKey(b.members[0]) - sortKey(a.members[0])));
  const awesome = pick(current.awesome);
  const other = pick(current.other);
  const shown = cards.reduce((n, x) => n + x.members.length, 0) + awesome.length + other.length;
  const total = Object.keys(current.resources).length;

  $('toolbar').hidden = false;
  $('filters').hidden = false;
  $('summary').textContent = `${shown} of ${total} resources${current.cached ? ` · saved ${new Date(current.createdAt).toLocaleString()}` : ''}`;
  $('queries').textContent = current.expandedQueries.length ? `Searched as: ${current.expandedQueries.join(' · ')}` : '';
  $('export').href = `/api/export/${encodeURIComponent(current.id)}?format=md&hideSolutions=${f.hideSolutions ? 1 : 0}&minStars=${f.minStars}`;
  $('banner').replaceChildren(...current.warnings.map((w) => h('div', { class: 'banner warn' }, w)));

  const sections = [];
  if (cards.length) sections.push(h('h2', { class: 'section' }, 'University courses ', h('span', { class: 'count' }, `(${cards.length})`)), cards.map((x) => card(x.c, x.members)));
  if (awesome.length) sections.push(h('h2', { class: 'section' }, 'Awesome lists & roadmaps ', h('span', { class: 'count' }, `(${awesome.length})`)), h('ul', { class: 'list flat' }, awesome.map((r) => item(r, { showUni: true }))));
  if (other.length) sections.push(h('h2', { class: 'section' }, 'Other materials ', h('span', { class: 'count' }, `(${other.length})`)), h('ul', { class: 'list flat' }, other.map((r) => item(r, { showUni: true }))));
  if (!sections.length) {
    sections.push(h('div', { class: 'empty' }, total
      ? [h('h1', {}, 'No results match these filters'), h('button', { type: 'button', onclick: () => resetFilters() }, 'Reset filters')]
      : [h('h1', {}, 'Nothing found'), h('p', {}, 'Try a broader topic, an English term, or a course code.')]));
  }
  $('content').replaceChildren(...sections.flat());
}

function showLoading() {
  $('banner').replaceChildren();
  $('queries').textContent = '';
  $('content').replaceChildren(
    h('p', { class: 'summary' }, 'Searching GitHub… a first search can take up to 20 seconds.'),
    ...Array.from({ length: 4 }, () => h('div', { class: 'skeleton' })));
}

// ---------- wiring ----------
$('search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('q').value); });
$('refresh').addEventListener('click', () => current && runSearch(current.keyword, { refresh: true, push: false }));
$('reset-filters').addEventListener('click', () => resetFilters());
$('sort').addEventListener('change', render);
for (const id of ['f-stars', 'f-updated', 'f-official', 'f-solutions']) $(id).addEventListener('input', render);
$('toggle-filters').addEventListener('click', () => $('filters').classList.toggle('open'));
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); $('q').focus(); }
});
window.addEventListener('popstate', () => {
  const q = new URLSearchParams(location.search).get('q');
  if (q) runSearch(q, { push: false });
});

const initial = new URLSearchParams(location.search).get('q');
if (initial) runSearch(initial, { push: false });
loadHistory();
loadRate();
