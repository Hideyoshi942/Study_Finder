// Study Finder UI. Renders a saved search and applies filters in the browser.
// All data goes into the DOM through textContent / attributes, never innerHTML.

import { rankSuggestions, didYouMean } from './suggest.js';

const $ = (id) => document.getElementById(id);
const LEVELS = ['intro', 'intermediate', 'advanced', 'unknown'];
const TYPE_LABELS = {
  'course': 'Course', 'lecture-notes': 'Notes', 'videos': 'Videos', 'assignments': 'Assignments',
  'solutions': 'Solutions', 'book': 'Book', 'guide': 'Guide', 'awesome-list': 'Awesome list', 'roadmap': 'Roadmap',
};
const CARD_PREVIEW = 4;
const YEAR = 365.25 * 24 * 3600 * 1000;

let current = null; // the loaded search
let suggestItems = []; // from /api/suggest-index
const ui = { universities: new Set(), types: new Set(), levels: new Set(), langs: new Set() };
const LANGS = { en: 'English', zh: 'Chinese', vi: 'Vietnamese', other: 'Other', unknown: 'Not checked' };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
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
  closeSuggestions();
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
    $('uni-pills').hidden = true;
    $('queries').textContent = '';
    $('content').replaceChildren();
    $('banner').replaceChildren(h('div', { class: 'banner error' }, e.message));
  }
  loadHistory();
  loadRate();
  loadSuggestions();
}

async function loadSuggestions() {
  try { suggestItems = (await api('/api/suggest-index')).items; } catch { /* suggestions are optional */ }
}

// ---------- suggestions (ARIA combobox) ----------
const KIND_LABELS = { history: 'Recent', popular: 'Popular', topic: 'Topic', course: 'Course', university: 'University' };
let active = -1;
let shown = [];

function openSuggestions() {
  shown = rankSuggestions(suggestItems, $('q').value, 8);
  active = -1;
  const list = $('suggestions');
  if (!shown.length) return closeSuggestions();
  list.replaceChildren(...shown.map((s, i) => h('li', {
    id: `sg-${i}`, role: 'option', class: 'suggestion', 'aria-selected': 'false',
    onmousedown: (e) => { e.preventDefault(); runSearch(s.query); },
  },
  h('span', { class: `sg-kind sg-${s.kind}` }, KIND_LABELS[s.kind]),
  h('span', { class: 'sg-label' }, s.label),
  s.sub ? h('span', { class: 'sg-sub' }, s.sub) : null)));
  list.hidden = false;
  $('q').setAttribute('aria-expanded', 'true');
  $('q').removeAttribute('aria-activedescendant');
}

function closeSuggestions() {
  $('suggestions').hidden = true;
  $('q').setAttribute('aria-expanded', 'false');
  $('q').removeAttribute('aria-activedescendant');
  active = -1;
}

function moveActive(delta) {
  if ($('suggestions').hidden) return openSuggestions();
  // Cycles through -1 (the input itself) and 0..n-1.
  active += delta;
  if (active >= shown.length) active = -1;
  else if (active < -1) active = shown.length - 1;
  [...$('suggestions').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
  if (active >= 0) {
    $('q').setAttribute('aria-activedescendant', `sg-${active}`);
    $(`sg-${active}`).scrollIntoView({ block: 'nearest' });
  } else $('q').removeAttribute('aria-activedescendant');
}

$('q').addEventListener('input', openSuggestions);
$('q').addEventListener('focus', openSuggestions);
$('q').addEventListener('blur', () => setTimeout(closeSuggestions, 100));
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
  else if (e.key === 'Escape') closeSuggestions();
  else if (e.key === 'Enter' && active >= 0 && !$('suggestions').hidden) { e.preventDefault(); runSearch(shown[active].query); }
});

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
  if (ui.langs.size && !ui.langs.has(r.lang ?? 'unknown')) return false;
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

  // Only the top results have their README read, so the rest are "Not checked".
  const langs = count((r) => r.lang ?? 'unknown');
  checkboxGroup($('f-lang'), Object.keys(LANGS).filter((l) => langs.has(l)).map((l) => [l, LANGS[l], langs.get(l)]), ui.langs);
}

function resetFilters(rerender = true) {
  ui.universities.clear(); ui.types.clear(); ui.levels.clear(); ui.langs.clear();
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

const FACTORS = [
  ['stars', 'Stars'], ['relevance', 'Relevance'], ['university', 'University'], ['content', 'Content'], ['freshness', 'Freshness'],
];
const MATCHED_BY = {
  org: 'official GitHub org', course: 'known course code', name: 'university name in the description',
  readme: 'a university link in the README', 'code-pattern': 'course code pattern',
};

function readmeNote(rd) {
  const s = rd.signals;
  const parts = [[s.lectures, 'lecture mentions'], [s.assignments, 'labs/assignments'], [s.videos, 'video links'], [s.pdfs, 'PDFs']]
    .filter(([n]) => n).map(([n, label]) => `${n} ${label}`);
  if (rd.domains.length) parts.push(`links ${rd.domains.slice(0, 2).join(', ')}`);
  return `README: ${parts.length ? parts.join(' · ') : 'no course signals'}`;
}

// "why?" panel: one bar per scoring factor, plus how the university was found.
function whyPanel(r) {
  const b = r.scoreBreakdown ?? {};
  const rows = FACTORS.map(([k, label]) => {
    const v = Math.round((b[k] ?? 0) * 100);
    return h('div', { class: 'why-row' },
      h('span', {}, label),
      h('meter', { min: '0', max: '100', value: String(v), 'aria-label': `${label} ${v}%` }),
      h('span', { class: 'why-val' }, `${v}%`));
  });
  const notes = [];
  if (b.penalties) notes.push(`Penalty −${b.penalties} (fork, solutions only, or no description)`);
  if (r.universityMatchedBy) notes.push(`${r.universityName}: matched by ${MATCHED_BY[r.universityMatchedBy] ?? r.universityMatchedBy}`);
  notes.push(r.readme ? readmeNote(r.readme) : 'README not read (only the top results are)');
  if (r.foundBy?.length) notes.push(`Found by the ${r.foundBy.join(', ')} quer${r.foundBy.length > 1 ? 'ies' : 'y'}`);
  return h('div', { class: 'why' },
    h('div', { class: 'why-score' }, `Score ${r.score}`),
    rows,
    notes.map((n) => h('p', { class: 'why-note' }, n)));
}

function item(r, { showUni = false, created = false } = {}) {
  const li = h('li', { class: 'item' });
  let panel = null;
  const whyBtn = r.scoreBreakdown ? h('button', {
    type: 'button', class: 'why-btn', 'aria-expanded': 'false',
    onclick: (e) => {
      const open = e.currentTarget.getAttribute('aria-expanded') === 'true';
      e.currentTarget.setAttribute('aria-expanded', String(!open));
      if (open) { panel?.remove(); panel = null; } else { panel = whyPanel(r); li.append(panel); }
    },
  }, 'why?') : null;
  li.append(
    h('div', { class: 'item-line' },
      h('a', { class: 'item-title', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title),
      showUni && r.universityName ? h('span', { class: 'uni-badge', 'data-uni': r.university }, r.universityName) : null,
      r.official ? h('span', { class: 'badge official' }, 'official') : null,
      h('span', { class: 'meta' }, `★ ${fmtStars(r.repo?.stars ?? 0)}`,
        created && r.repo?.createdAt ? ` · created ${ago(r.repo.createdAt)}` : r.repo?.pushedAt ? ` · ${month(r.repo.pushedAt)}` : ''),
      created && r.courseCode && r.universityName ? h('span', { class: 'badge code' }, `${r.universityName} ${r.courseCode}`) : null,
      h('span', { class: 'chips' }, r.types.map((t) => h('span', { class: 'badge' }, TYPE_LABELS[t] ?? t))),
      whyBtn),
    r.description ? h('p', { class: 'desc' }, r.description) : '');
  return li;
}

// "12 repos · ★ 3.3k top · videos · labs · notes"
function cardSummary(members) {
  const has = (t) => members.some((m) => m.types.includes(t));
  const parts = [`${members.length} repo${members.length > 1 ? 's' : ''}`, `★ ${fmtStars(Math.max(...members.map((m) => m.repo?.stars ?? 0)))} top`];
  for (const [t, label] of [['videos', 'videos'], ['lecture-notes', 'notes'], ['assignments', 'labs'], ['book', 'book']]) if (has(t)) parts.push(label);
  return parts.join(' · ');
}

function card(c, members) {
  const levels = [...new Set(members.map((m) => m.level).filter((l) => l !== 'unknown'))];
  const list = h('ul', { class: 'list' }, members.slice(0, CARD_PREVIEW).map((m) => item(m)));
  const rest = members.length - CARD_PREVIEW;
  const more = rest > 0
    ? h('button', { type: 'button', class: 'link more', onclick: (e) => { list.replaceChildren(...members.map((m) => item(m))); e.target.remove(); } }, `Show ${rest} more`)
    : null;
  return h('article', { class: 'card', 'data-uni': c.university },
    h('div', { class: 'card-head' },
      h('span', { class: 'uni-badge', 'data-uni': c.university }, c.universityName),
      h('span', { class: 'card-code' }, c.courseCode),
      h('span', { class: 'card-title' }, c.title),
      members.some((m) => m.official) ? h('span', { class: 'badge official' }, 'official') : null,
      levels.map((l) => h('span', { class: 'badge' }, l))),
    h('p', { class: 'card-summary' }, cardSummary(members)),
    list, more);
}

function uniPills() {
  const all = Object.values(current.resources);
  const counts = new Map();
  for (const r of all) if (r.university) counts.set(r.university, { name: r.universityName, n: (counts.get(r.university)?.n ?? 0) + 1 });
  const pills = [...counts].sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  const el = $('uni-pills');
  el.hidden = pills.length < 2;
  const toggle = (id) => {
    if (id === null) ui.universities.clear();
    else if (ui.universities.has(id)) ui.universities.delete(id);
    else ui.universities.add(id);
    buildFilters();
    render();
  };
  el.replaceChildren(
    h('button', { type: 'button', class: 'pill', 'aria-pressed': String(!ui.universities.size), onclick: () => toggle(null) }, 'All'),
    ...pills.map(([id, { name, n }]) => h('button', {
      type: 'button', class: 'pill', 'data-uni': id, 'aria-pressed': String(ui.universities.has(id)), onclick: () => toggle(id),
    }, name, h('span', { class: 'pill-count' }, String(n)))));
}

function relatedSection() {
  const rel = current.related;
  if (!rel?.topic || (!rel.topics.length && !rel.courses.length)) return null;
  return h('section', { class: 'related' },
    rel.topics.length ? [h('h2', { class: 'section' }, 'Related topics'),
      h('div', { class: 'chips-row left' }, rel.topics.map((t) =>
        h('button', { type: 'button', class: 'chip', onclick: () => runSearch(t.query) }, t.label, h('span', { class: 'chip-vi' }, t.vi))))] : null,
    rel.courses.length ? [h('h2', { class: 'section' }, 'Similar courses'),
      h('div', { class: 'tile-grid' }, rel.courses.map((c) => courseTile(c)))] : null);
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
  uniPills();
  if (sections.length) sections.push(relatedSection());
  if (!sections.length) {
    sections.push(h('div', { class: 'empty' }, total
      ? [h('h1', {}, 'No results match these filters'), h('button', { type: 'button', onclick: () => resetFilters() }, 'Reset filters')]
      : [h('h1', {}, 'Nothing found'), h('p', {}, 'Try a broader topic, an English term, or a course code.'), didYouMeanRow(current.keyword)]));
  }
  $('content').replaceChildren(...sections.flat().filter(Boolean));
}

// ---------- home ----------
let feedTab = 'semester';
const ago = (iso) => {
  const days = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86400_000));
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days} days ago` : `${Math.round(days / 30)} months ago`;
};

function courseTile(c, { step = null } = {}) {
  return h('button', { type: 'button', class: 'course-tile', 'data-uni': c.university, onclick: () => runSearch(c.code) },
    h('span', { class: 'tile-top' },
      step ? h('span', { class: 'step' }, String(step)) : null,
      h('span', { class: 'uni-badge', 'data-uni': c.university }, c.universityName),
      h('span', { class: 'tile-code' }, c.code)),
    h('span', { class: 'tile-title' }, c.title),
    h('span', { class: 'tile-meta' }, [c.level, c.reason].filter(Boolean).join(' · ')));
}

function feedList(feed) {
  const list = feed[feedTab] ?? [];
  if (!list.length) {
    return h('p', { class: 'muted' }, feed.status === 'refreshing' || !feed.updatedAt
      ? 'Collecting new courses from GitHub… check back in a minute.'
      : 'Nothing new here yet.');
  }
  return h('ul', { class: 'list flat' }, list.map((r) => item(r, { showUni: !r.courseCode, created: true })));
}

function section(title, ...children) {
  return h('section', { class: 'home-section' }, h('h2', { class: 'section' }, title), ...children);
}

async function renderHome() {
  current = null;
  document.title = 'Study Finder';
  $('q').value = '';
  $('toolbar').hidden = true;
  $('filters').hidden = true;
  $('uni-pills').hidden = true;
  $('queries').textContent = '';
  $('banner').replaceChildren();
  let home;
  try {
    home = await api('/api/home');
  } catch (e) {
    $('banner').replaceChildren(h('div', { class: 'banner error' }, e.message));
    return;
  }
  if (new URLSearchParams(location.search).get('q')) return; // a search started meanwhile

  const hero = h('section', { class: 'hero' },
    h('h1', {}, 'Find university courses on GitHub'),
    h('p', {}, 'Search a topic in English or Vietnamese, or a course code like 6.824 or CS231n. Results are grouped by course and ranked by quality.'),
    h('div', { class: 'chips-row' }, home.popular.map((q) => h('button', { type: 'button', class: 'chip', onclick: () => runSearch(q) }, q))));

  const rec = home.recommendations;
  const recommended = rec.courses.length
    ? section('Recommended for you',
      h('p', { class: 'muted' }, `Based on your searches: ${rec.basedOn.join(', ')}. Related topics: `,
        rec.topics.map((t, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'link', onclick: () => runSearch(t.query) }, t.label)])),
      h('div', { class: 'tile-grid' }, rec.courses.map((c) => courseTile(c))))
    : null;

  const feed = home.feed;
  let feedSection = null;
  if (feed) {
    const body = h('div', {}, feedList(feed));
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['semester', 'This semester'], ['fresh', 'New courses']].map(([id, label]) =>
      h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(feedTab === id), onclick: (e) => {
        feedTab = id;
        [...tabs.children].forEach((b) => b.setAttribute('aria-selected', String(b === e.currentTarget)));
        body.replaceChildren(feedList(feed));
      } }, label)));
    feedSection = section('New on GitHub',
      h('div', { class: 'feed-head' }, tabs,
        h('span', { class: 'muted small' }, feed.updatedAt ? `Updated ${ago(feed.updatedAt)}` : feed.status ?? '')),
      body);
  }

  const topics = section('Browse by topic',
    h('div', { class: 'topic-grid' }, home.topics.map((t) =>
      h('button', { type: 'button', class: 'topic-tile', onclick: () => runSearch(t.query) },
        h('span', { class: 'topic-label' }, t.label),
        h('span', { class: 'topic-vi' }, t.vi),
        t.courses ? h('span', { class: 'topic-count' }, `${t.courses} known course${t.courses > 1 ? 's' : ''}`) : null))));

  const starter = section('Starter path',
    h('p', { class: 'muted' }, 'A classic order for learning computer science from scratch.'),
    h('div', { class: 'tile-grid path' }, rec.starter.map((c, i) => courseTile(c, { step: i + 1 }))));

  const order = recommended ? [hero, recommended, feedSection, topics, starter] : [hero, topics, feedSection, starter];
  $('content').replaceChildren(...order.filter(Boolean));
}

function didYouMeanRow(keyword) {
  const options = didYouMean(suggestItems, keyword);
  if (!options.length) return null;
  return h('p', { class: 'did-you-mean' }, 'Did you mean ',
    options.map((o, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'link', onclick: () => runSearch(o.query) }, o.label)]), '?');
}

function showLoading() {
  $('banner').replaceChildren();
  $('uni-pills').hidden = true;
  $('queries').textContent = '';
  $('content').replaceChildren(
    h('p', { class: 'summary' }, 'Searching GitHub… a first search can take up to 20 seconds.'),
    ...Array.from({ length: 4 }, () => h('div', { class: 'skeleton' })));
}

// ---------- theme: auto → light → dark ----------
const THEMES = ['auto', 'light', 'dark'];
const THEME_ICONS = { auto: '◐', light: '☀', dark: '☾' };
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const btn = $('theme');
  btn.textContent = THEME_ICONS[t];
  btn.title = `Theme: ${t}`;
  btn.setAttribute('aria-label', `Theme: ${t}`);
}
let theme = 'auto';
try { theme = localStorage.getItem('sf-theme') ?? 'auto'; } catch { /* storage unavailable */ }
if (!THEMES.includes(theme)) theme = 'auto';
applyTheme(theme);
$('theme').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  try { localStorage.setItem('sf-theme', theme); } catch { /* ignore */ }
});

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
  else renderHome();
});

const initial = new URLSearchParams(location.search).get('q');
if (initial) runSearch(initial, { push: false });
else renderHome();
loadHistory();
loadRate();
loadSuggestions();
