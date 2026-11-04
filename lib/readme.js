// READMEs from raw.githubusercontent.com (does not use the API quota) and what they tell us.

const MAX_BYTES = 1024 * 1024;
const NAMES = ['README.md', 'readme.md'];

// get(fullName) -> README text, or null when the repo has none. Misses are cached too;
// network errors are not, so the next search tries again.
export function createReadmeFetcher({ cache = null, fetchImpl = fetch } = {}) {
  return {
    async get(fullName) {
      const key = `readme:${fullName.toLowerCase()}`;
      const hit = cache ? await cache.get(key) : null;
      if (hit?.fresh) return hit.value.text;
      for (const name of NAMES) {
        let res;
        try {
          // No custom headers: in the browser they would trigger a CORS preflight.
          res = await fetchImpl(`https://raw.githubusercontent.com/${fullName}/HEAD/${name}`, {
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          return hit?.value.text ?? null;
        }
        if (res.status === 404) continue;
        if (!res.ok) return hit?.value.text ?? null;
        const text = (await res.text()).slice(0, MAX_BYTES);
        if (cache) await cache.set(key, { text });
        return text;
      }
      if (cache) await cache.set(key, { text: null });
      return null;
    },
  };
}

const count = (text, re) => (text.match(re) ?? []).length;
const VI_CHARS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu;

function detectLang(text) {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/<[^>]+>/g, ' ');
  const han = count(prose, /\p{Script=Han}/gu);
  const latin = count(prose, /[a-z]/gi);
  const vi = count(prose, VI_CHARS);
  if (han + latin < 40) return 'other';
  if (han / (han + latin) > 0.15) return 'zh';
  if (vi >= 20 && vi / latin > 0.02) return 'vi';
  if (latin > han) return 'en';
  return 'other';
}

function firstHeading(text) {
  const m = text.match(/^#\s+(.+)$/m) ?? text.match(/^(.+)\n=+\s*$/m) ?? text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return m[1]
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`]/g, '')
    .trim()
    .slice(0, 200);
}

export function analyzeReadme(text, config) {
  const lower = text.toLowerCase();
  const urls = text.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? [];
  const hosts = urls.map((u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } }).filter(Boolean);
  const uniDomains = config.universities.flatMap((u) => u.domains);
  const domains = [...new Set(hosts.filter((h) => h.endsWith('.edu') || uniDomains.some((d) => h === d || h.endsWith(`.${d}`))))];

  return {
    heading: firstHeading(text),
    signals: {
      lectures: count(lower, /\blectures?\b/g),
      assignments: count(lower, /\b(assignments?|labs?|homeworks?|problem sets?|psets?)\b/g),
      exams: count(lower, /\b(exams?|midterms?|quiz(?:zes)?)\b/g),
      slides: count(lower, /\bslides?\b/g),
      syllabus: count(lower, /\bsyllabus\b/g),
      videos: hosts.filter((h) => /(^|\.)(youtube\.com|youtu\.be|bilibili\.com)$/.test(h)).length,
      pdfs: urls.filter((u) => /\.pdf(\?|#|$)/i.test(u)).length,
    },
    domains,
    lang: detectLang(text),
  };
}
