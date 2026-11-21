# Study Finder

Search GitHub, and the best curated course lists, for university courses and learning materials. Type a topic, in English or Vietnamese, or a course code. Study Finder:
- runs several GitHub searches;
- removes spam and software projects;
- reads READMEs and awesome lists;
- detects the university and course code;
- ranks the results and groups them into course cards such as **MIT 6.5840 · Distributed Systems**, each with its course site, lecture videos and repos.

## Run

```powershell
npm start          # http://127.0.0.1:4322
```

Requires Node 24. There are no dependencies to install. `npm start` adds `--use-env-proxy`, so the app uses `HTTPS_PROXY`.

### GitHub token (recommended)

Without a token, GitHub allows **10 searches per minute per IP**. Behind the office proxy that budget is shared with everyone. A Study Finder search uses up to 7 of them. When the budget runs out, a search waits for the reset (up to a minute, shown in the progress bar).

Create a fine-grained token with *public repositories, read-only* access, then either:

```powershell
$env:GITHUB_TOKEN = "github_pat_..."; npm start
```

or put `GITHUB_TOKEN=github_pat_...` in a `.env` file next to `package.json` (git-ignored). The token stays on the server and is never sent to the browser.

## GitHub Pages (static site)

`.github/workflows/deploy.yml` builds a static copy every 6 hours, and on every push to `develop`:

- `build.js` runs the real pipeline for the popular searches and every topic tile, plus the feed, and writes `dist/`.
- On the Pages site:
  - prebuilt topics open instantly;
  - any other keyword is searched **live from the visitor's browser without a token** (about 10 searches/min per visitor);
  - lists, watches and history are stored in that browser;
  - exports are built in the browser;
  - **Check links** needs the local app, so it is hidden.

**No personal token is used on GitHub.** The workflow uses the `GITHUB_TOKEN` that Actions creates for each run (it expires with the job and is scoped to this repo). It runs with `contents: read` only, and never on pull requests. `build.js` refuses to publish when any output file contains something that looks like a token. Your own token stays in the local `.env`, which is git-ignored.

One-time setup: **Settings → Pages → Source: GitHub Actions**.

Local test of the static build: `$env:STATIC_LIMIT=3; npm run build`, then serve `dist/`.

## Features

**Search**
- Suggestions while typing:
  - topics in English or Vietnamese (accents optional);
  - course codes by prefix (`cs22` → CS221, CS224N, CS229);
  - universities and recent searches;
  - typo tolerance, and "Did you mean" when nothing is found.
- Results stream in, with a progress bar: *Searching GitHub 3/6 · Reading READMEs 12/30 · Reading awesome lists*.
- Course cards show:
  - the university's color;
  - a summary (repos, videos, labs, notes);
  - links to the **course site and lecture videos** found in curated lists;
  - the repos for that course.
- A **Course sites & videos** section for curated links that are not GitHub repos.
- Filters: university pills, type, level, README language, stars, last update, official only, hide solution repos, hide broken links.
- A **why?** panel on every result: the score breakdown, how the university was found, the README signals, and which query found it.
- Related topics and similar courses; a light/dark/auto theme.
- Export: Markdown, CSV (opens in Excel with Vietnamese intact) and JSON.

**Home page**
- Popular searches; recommendations based on your recent searches; a starter path (CS50 → … → 6.5840); 27 topic tiles.
- **New on GitHub** feed:
  - *This semester*: new repos for well-known courses;
  - *New courses*: course repos created in the last 60 days;
  - it refreshes every 6 h, and only when at least 5 searches are left.
- **Watched topics** with a "N new" count.

**Personal**
- **My lists**: save any result (☆ Save), mark it *To do / Learning / Done*, add notes, and follow progress per list.
- **Watch** a search: it is re-run every 24 h (one watch at a time, only when 7+ searches are left), and results that are new since last time get a **new** badge.
- **Check links**: tests every curated course site and video link. Broken ones (404, or a domain that does not resolve) are marked and hidden by default.

## How it works

1. **Expand the keyword** (`lib/query.js`): Vietnamese → English (`học máy` → `machine learning`), abbreviations (`os`, `ml`, `dsa`), and the course codes for the topic (`distributed systems` → `6.5840`, `6.824`, `15-440`, …).
2. **Search** (`lib/github.js`, `lib/search.js`):
   - up to 6 queries (course, lecture, general, awesome, topic, course codes);
   - one follow-up for topical courses that got no results;
   - responses are cached 24 h and revalidated with ETags.
3. **Filter** (`lib/resource.js`): drops spam (descriptions over 1,000 characters), irrelevant repos, and software projects with no learning signals.
4. **Classify** (`lib/classify.js`): university (GitHub org, known course, name, README link or code pattern), course code, types, and level.
5. **Read READMEs** (`lib/readme.js`, `lib/enrich.js`):
   - the top 30, from raw.githubusercontent.com (no API quota, cached 7 days);
   - extracts the heading, lecture/lab/video/PDF counts, university links and language.
6. **Mine awesome lists** (`lib/awesome.js`): awesome-courses, cs-video-courses, OSSU, and the 2 most relevant lists found. Matching course sites and videos become resources.
7. **Score** (`lib/score.js`): stars 30%, relevance 20%, university 20%, content 15%, freshness 15%, minus penalties for forks, solution-only repos and missing descriptions.
8. **Group** (`lib/group.js`): course cards, course sites & videos, awesome lists & roadmaps, other materials.

A search is saved in `data/searches/`. Searching the same keyword again opens the saved result instantly; **Refresh** runs it again. If GitHub fails, the last saved result is kept. Lists and watches live in `data/collections.json` and `data/watches.json`.

## Customize

Everything is in `config.json`:

- `universities`: names, GitHub orgs (`*` suffix = prefix match) and domains.
- `courses`: known course codes, aliases, titles, levels and topics. A topic links a keyword to its courses.
- `topics`: home tiles, Vietnamese labels, and related topics (used for recommendations).
- `aliases`, `vietnamese`: keyword translations.
- `awesome.seeds`: curated lists to mine. `feed`: feed queries and limits. `starterPath`, `popularSearches`.
- `weights`, `penalties`, `search`: ranking and limits. `blockRepos`: repos to always hide.

## Develop

```powershell
npm test                                  # 85 unit + API tests, no network
npm run smoke -- "distributed systems"    # live search, prints top results
```

**API.** Reads are `GET`. Writes need `Content-Type: application/json` and refuse other origins.

| Route | Purpose |
|---|---|
| `/api/search?q=&refresh=1`, `/api/search/stream?q=` (SSE) | search |
| `/api/searches`, `/api/searches/:id` | history, a saved search |
| `/api/export/:id?format=md\|csv\|json&hideSolutions=1&minStars=0` | export |
| `/api/home`, `/api/suggest-index`, `/api/rate-limit` | home data, suggestions, GitHub budget |
| `GET/POST /api/collections`, `PATCH/DELETE /api/collections/:id` | lists |
| `PUT /api/collections/:id/items`, `POST /api/collections/:id/items/delete` | list items |
| `GET/POST /api/watches`, `DELETE /api/watches/:id`, `GET …/new`, `POST …/seen` | watches |
| `POST /api/check-links/:id` | link check |

## Known limits

- The server listens on 127.0.0.1 only and is single-user. There are no accounts.
- Official university repos are kept even when they are software rather than study material (for example `CMU-Perceptual-Computing-Lab/openpose`).
- The same course listed in two curated lists with different URLs can appear twice (for example UW CSEP 552).
- Not built: AI summaries (intentionally omitted so the static GitHub Pages build stays completely key-free).
