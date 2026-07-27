#!/usr/bin/env node
/**
 * Guards against exercises that are the chapter's own code played back.
 *
 * A code-reading or code-writing exercise should test whether the reader can
 * *apply* what the chapter taught, not whether they remember the listing. This
 * script tokenises every exercise snippet and every code block in the owning
 * chapter, takes overlapping n-gram shingles, and reports the fraction of the
 * snippet that already appears in the chapter.
 *
 *   node scripts/check-novelty.mjs                    # every book, default gate
 *   node scripts/check-novelty.mjs --max 30           # stricter gate
 *   node scripts/check-novelty.mjs --list cpp/exercises/02-*.json
 *
 * A high score is not automatically wrong — a chapter about `std::vector` will
 * legitimately mention `push_back` — which is why the gate is generous and the
 * `--list` view exists for judgement calls. But an item in the 60s and above is
 * almost always the listing with the identifiers renamed.
 */
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

const SHINGLE = 7;
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const MAX = Number(flag('--max', 40)) / 100;
const LIST = argv.includes('--list');
const patterns = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));

const tokens = (s) => s.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|[^\sA-Za-z0-9_]/g) ?? [];

const shingles = (code) => {
  const t = tokens(code);
  const out = new Set();
  for (let i = 0; i + SHINGLE <= t.length; i++) out.add(t.slice(i, i + SHINGLE).join(' '));
  return out;
};

const chapterCode = (md) =>
  [...md.matchAll(/```(?:cpp|c\+\+)?\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');

const files = [];
for await (const f of glob(patterns.length ? patterns : '*/exercises/[0-9][0-9]-*.json')) files.push(f);
files.sort();
if (!files.length) {
  console.error('no exercise files matched');
  process.exit(1);
}

const rows = [];
for (const file of files) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  const md = await readFile(file.replace('/exercises/', '/').replace(/\.json$/, '.md'), 'utf8').catch(() => '');
  const chapter = shingles(chapterCode(md));

  const overlap = (code) => {
    const s = shingles(code);
    if (!s.size) return 0;
    let hit = 0;
    for (const g of s) if (chapter.has(g)) hit++;
    return hit / s.size;
  };

  for (const q of data.reading ?? []) rows.push({ file, ch: data.chapter, id: q.id, kind: 'reading', pct: overlap(q.code) });
  for (const q of data.writing ?? []) rows.push({ file, ch: data.chapter, id: q.id, kind: 'writing', pct: overlap(q.solution) });
}

const pct = (x) => `${(x * 100).toFixed(0).padStart(3)}%`;
const mean = (rs) => (rs.length ? rs.reduce((a, r) => a + r.pct, 0) / rs.length : 0);

if (LIST) {
  for (const r of [...rows].sort((a, b) => b.pct - a.pct)) console.log(`${pct(r.pct)}  ${r.id.padEnd(10)} ${r.kind}`);
  console.log();
}

for (const kind of ['reading', 'writing']) {
  const rs = rows.filter((r) => r.kind === kind);
  console.log(`${kind.padEnd(8)} ${String(rs.length).padStart(3)} items · mean ${pct(mean(rs))} · max ${pct(Math.max(0, ...rs.map((r) => r.pct)))}`);
}

const over = rows.filter((r) => r.pct > MAX).sort((a, b) => b.pct - a.pct);
if (over.length) {
  console.log(`\nOver the ${(MAX * 100).toFixed(0)}% gate — these read as the chapter's listing rather than a new problem:`);
  for (const r of over) console.log(`  ${pct(r.pct)}  ${r.id.padEnd(10)} ${r.kind}  ${r.file}`);
}

console.log(`\n${rows.length} snippets from ${files.length} file(s) · ${over.length} over gate`);
process.exit(over.length ? 1 : 0);
