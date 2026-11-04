# Study Finder

Search GitHub for university courses and learning materials. Type a topic, in English or Vietnamese, or a course code. Study Finder runs several GitHub searches, removes spam and software projects, detects the university and course code, ranks the results, and groups them into course cards such as **MIT 6.5840 · Distributed Systems**.

## Run

```powershell
npm start          # http://127.0.0.1:4322
```

Requires Node 24. There are no dependencies to install. `npm start` adds `--use-env-proxy`, so the app uses `HTTPS_PROXY`.

### GitHub token (recommended)

Without a token, GitHub allows **10 searches per minute per IP**. Behind the office proxy that budget is shared with everyone. A single Study Finder search uses up to 6 of them.

Create a fine-grained token with *public repositories, read-only* access, then either:

```powershell
$env:GITHUB_TOKEN = "github_pat_..."; npm start
```

or put `GITHUB_TOKEN=github_pat_...` in a `.env` file next to `package.json` (git-ignored). The token stays on the server and is never sent to the browser.

## How it works

1. **Expand the keyword** (`lib/query.js`): Vietnamese → English (`học máy` → `machine learning`), abbreviations (`os`, `ml`, `dsa`), and the course codes for the topic (`distributed systems` → `6.5840`, `6.824`, `15-440`, …).
2. **Search** (`lib/github.js`): up to 6 queries (course, lecture, general, awesome, topic, course codes). Responses are cached for 24 h and revalidated with ETags.
3. **Filter** (`lib/search.js`): drops spam (descriptions over 1,000 characters), irrelevant repos, and software projects with no learning signals.
4. **Classify** (`lib/classify.js`): university (GitHub org, known course, name, or code pattern), course code, types (course, notes, videos, assignments, solutions, book, guide, awesome list, roadmap), and level.
5. **Score** (`lib/score.js`): stars 30%, relevance 20%, university 20%, content 15%, freshness 15%, minus penalties for forks, solution-only repos and missing descriptions. Hover the ★ in the UI to see the breakdown.
6. **Group** (`lib/group.js`): course cards, awesome lists & roadmaps, other materials.

A search is saved in `data/searches/`. Searching the same keyword again opens the saved result instantly; **Refresh** runs it again. If GitHub fails, the last saved result is kept.

## Customize

Everything is in `config.json`:

- `universities`: names, GitHub orgs (`*` suffix = prefix match) and domains.
- `courses`: known course codes, aliases, titles, levels and topics. A topic links a keyword to its courses.
- `aliases`, `vietnamese`: keyword translations.
- `weights`, `penalties`, `search`: ranking and limits.
- `blockRepos`: repos to always hide.

## Develop

```powershell
npm test                                  # unit + API tests, no network
npm run smoke -- "distributed systems"    # live search, prints top results
```

API: `GET /api/search?q=&refresh=1`, `/api/searches`, `/api/searches/:id`, `/api/export/:id?format=md&hideSolutions=1&minStars=0`, `/api/rate-limit`.

## Known limits (Phase 1)

- Course cards come from GitHub repos only. Course websites and YouTube playlists linked inside awesome lists arrive in Phase 2.
- The course-code query returns 50 results, and a very popular course (MIT 6.824) can crowd out others (CMU 15-440).
- Official university repos are kept even when they are software rather than study material (for example `CMU-Perceptual-Computing-Lab/openpose`).
