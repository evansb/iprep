// Prefix an internal path with the configured `base` (e.g. `/iprep`) so links work
// both locally (base `/`) and on GitHub Pages. Astro does NOT rewrite hrefs written
// in templates, so every internal link must go through this helper.
const BASE = import.meta.env.BASE_URL; // "/iprep/" in prod, "/" locally

export function href(path = '/'): string {
  const base = BASE.endsWith('/') ? BASE.slice(0, -1) : BASE;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}` || '/';
}
