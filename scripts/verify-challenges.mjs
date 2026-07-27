#!/usr/bin/env node
/**
 * Checks the claims the challenge sets make about C++.
 *
 * A challenge asserts two kinds of thing a reader will trust: that the snippet
 * behaves as described (it races, it deadlocks, it leaks), and — for counting
 * items — that an exact number of copies or moves runs. The second is the one
 * worth machinery: an answer key that is off by one on a copy-elision question
 * teaches the wrong lesson to precisely the readers who were paying attention.
 *
 *   node scripts/verify-challenges.mjs                          # every set
 *   node scripts/verify-challenges.mjs cpp/challenges/memory.json
 *
 * Two checks run per item:
 *
 *   `check`   how the displayed snippet is exercised — see the table in
 *             cpp/challenges/README.md. Sanitizer silence warns, never fails:
 *             the sanitizers cover part of the space, not all of it.
 *   `probe`   an instrumented program, never shown to the reader, whose printed
 *             "copy"/"move"/"dtor"/"alloc" lines are counted and compared with
 *             every `count` part that named that token in `verify`.
 */
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { glob } from 'node:fs/promises';
import { STD, announceCompiler, compile, execute, isProgram, pool, run } from './lib/cxx.mjs';

// LeakSanitizer is not built into Apple's clang, and ASan on darwin cannot be
// asked for it. Reporting those items as failures on a Mac would be a lie about
// the content, so they are reported as skipped instead.
const LEAKS_SUPPORTED = process.platform !== 'darwin';

// A deadlock is proved by *not* finishing. Its budget is deliberately short:
// every other outcome here completes in milliseconds.
const DEADLOCK_TIMEOUT_MS = Number(process.env.DEADLOCK_TIMEOUT_MS || 3000);

const TOKENS = ['copy', 'move', 'dtor', 'alloc'];

async function main() {
  if (!(await announceCompiler())) process.exit(0);

  const patterns = process.argv.slice(2);
  const files = [];
  for await (const f of glob(patterns.length ? patterns : '*/challenges/*.json')) files.push(f);
  files.sort();
  if (!files.length) {
    console.error('no challenge files matched');
    process.exit(1);
  }

  const jobs = [];
  const staticErrors = [];

  for (const file of files) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    const bookDir = file.split('/')[0];

    // `kind` names the URL segment; the route is generated from the filename,
    // so a mismatch means the two disagree about what this set is called.
    const stem = file.split('/').pop().replace(/\.json$/, '');
    if (data.kind !== stem) {
      staticErrors.push(`${file}: kind ${JSON.stringify(data.kind)} does not match the filename`);
    }

    for (const item of data.items ?? []) {
      // `review` becomes a link back into the book. A typo drops the link
      // silently at build time, so it has to fail here instead.
      if (item.review) {
        const chapterFile = `${bookDir}/${item.review.chapter}.md`;
        const md = await readFile(chapterFile, 'utf8').catch(() => null);
        if (md === null) {
          staticErrors.push(`${file} ${item.id}: review.chapter ${chapterFile} does not exist`);
        } else {
          const headings = md
            .split('\n')
            .filter((l) => l.startsWith('## '))
            .map((l) => l.slice(3).trim());
          if (!headings.includes(item.review.section)) {
            staticErrors.push(
              `${file} ${item.id}: review.section ${JSON.stringify(item.review.section)} is not a heading in ${chapterFile}`,
            );
          }
        }
      }

      // The schema already checks that a line answer is in range. What it
      // cannot see is that the range is right: an off-by-one lands on a real
      // line and reads perfectly well in the JSON. A blank line is the one
      // case that is unambiguously a mistake, so catch at least that.
      const codeLines = item.code.split('\n');
      for (const p of (item.parts ?? []).filter((x) => x.type === 'lines')) {
        for (const n of p.answer) {
          if (!codeLines[n - 1]?.trim()) {
            staticErrors.push(`${file} ${item.id}/${p.id}: line ${n} is blank`);
          }
        }
      }

      jobs.push({ file, id: item.id, what: `snippet (${item.check ?? 'syntax'})`, kind: 'snippet', item });

      const counted = (item.parts ?? []).filter((p) => p.type === 'count');
      const verified = counted.filter((p) => p.verify);
      if (item.probe) {
        if (!verified.length) {
          staticErrors.push(`${file} ${item.id}: has a probe but no count part names it in verify`);
        } else {
          jobs.push({ file, id: item.id, what: 'probe', kind: 'probe', item, parts: verified });
        }
      } else if (counted.length) {
        // Not a failure: some counts (cache lines touched, objects leaked) are
        // not things a program can print. It should still be visible.
        staticErrors.push({
          warn: `${file} ${item.id}: ${counted.length} count part(s) with no probe to check them against`,
        });
      }
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'chal-verify-'));
  const failures = [];
  const warnings = [];
  const skips = [];

  await pool(jobs, async (job) => {
    const outcome = job.kind === 'probe' ? await checkProbe(job, dir) : await checkSnippet(job, dir);
    if (outcome?.level === 'fail') failures.push({ job, ...outcome });
    else if (outcome?.level === 'warn') warnings.push({ job, ...outcome });
    else if (outcome?.level === 'skip') skips.push({ job, ...outcome });
  });
  await rm(dir, { recursive: true, force: true });

  const hardErrors = staticErrors.filter((e) => typeof e === 'string');
  for (const e of staticErrors) {
    if (typeof e === 'string') console.log(`FAIL  ${e}`);
    else console.log(`WARN  ${e.warn}`);
  }
  for (const s of skips) console.log(`SKIP  ${s.job.file} ${s.job.id} — ${s.message}`);
  for (const w of warnings) {
    console.log(`WARN  ${w.job.file} ${w.job.id} (${w.job.what}) — ${w.message}`);
  }
  for (const f of failures) {
    console.log(`\nFAIL  ${f.job.file} ${f.job.id} (${f.job.what}) — ${f.message}`);
    if (f.detail) console.log(f.detail.split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n'));
  }

  console.log(
    `\n${jobs.length} checks · ${failures.length + hardErrors.length} failed · ${warnings.length} warned · ${skips.length} skipped · from ${files.length} file(s)`,
  );
  process.exit(failures.length + hardErrors.length ? 1 : 0);
}

/** Build a snippet and confirm it misbehaves in the way the item claims. */
async function checkSnippet(job, dir) {
  const { item } = job;
  const mode = item.check ?? 'syntax';
  const src = join(dir, `${job.id}.cpp`);
  await writeFile(src, item.code);

  const syntax = await compile([STD, '-fsyntax-only', src]);
  if (syntax.timedOut) return { level: 'fail', message: 'compiler timed out' };
  if (syntax.code !== 0) return { level: 'fail', message: 'does not compile', detail: syntax.stderr };
  if (mode === 'syntax') return null;

  if (!isProgram(item.code)) {
    return { level: 'warn', message: `check "${mode}" needs a main(); only the syntax was checked` };
  }
  if (mode === 'leak' && !LEAKS_SUPPORTED) {
    return { level: 'skip', message: 'LeakSanitizer is unavailable on this platform' };
  }

  const bin = `${src}.out`;
  // A dangling *stack* object is only caught with the extra instrumentation,
  // which is off by default because it costs a shadow stack frame per call.
  const flags = {
    run: ['-O0'],
    crash: ['-O0'],
    tsan: ['-fsanitize=thread', '-g', '-O1'],
    asan: ['-fsanitize=address', '-fsanitize-address-use-after-return=always', '-g', '-O0'],
    leak: ['-fsanitize=address', '-g', '-O0'],
    deadlock: ['-O0'],
  }[mode] ?? ['-O0'];

  const build = await compile([STD, ...flags, src, '-o', bin]);
  if (build.timedOut) return { level: 'fail', message: 'compiler timed out' };
  if (build.code !== 0) return { level: 'fail', message: 'fails to link', detail: build.stderr };

  const env = {
    ...process.env,
    // Two of these are off by default on Darwin, and they are precisely the
    // checks a `new[]`/`delete` mismatch needs, so ask for them explicitly.
    ASAN_OPTIONS:
      mode === 'leak'
        ? 'detect_leaks=1'
        : 'detect_leaks=0:detect_stack_use_after_return=1:alloc_dealloc_mismatch=1:new_delete_type_mismatch=1',
    TSAN_OPTIONS: 'halt_on_error=0',
  };
  const r = await execute(bin, mode === 'deadlock' ? { env, timeout: DEADLOCK_TIMEOUT_MS } : { env });
  const out = `${r.stdout}\n${r.stderr}`;

  if (mode === 'deadlock') {
    return r.timedOut
      ? null
      : { level: 'fail', message: `claims to deadlock, but finished (exit ${r.signal || r.code})` };
  }
  if (r.timedOut) return { level: 'fail', message: 'timed out' };

  if (mode === 'run') {
    return r.code === 0
      ? null
      : { level: 'fail', message: `exited ${r.signal || r.code}`, detail: r.stderr };
  }
  if (mode === 'crash') {
    return r.code !== 0
      ? null
      : { level: 'fail', message: 'claims to crash or abort, but exited 0' };
  }
  if (mode === 'tsan') {
    return /WARNING: ThreadSanitizer/.test(out)
      ? null
      : { level: 'warn', message: 'ThreadSanitizer reported nothing — confirm the race by hand' };
  }
  // asan / leak
  const noisy = /AddressSanitizer|LeakSanitizer|detected memory leaks/.test(out);
  return noisy
    ? null
    : { level: 'warn', message: `${mode === 'leak' ? 'LeakSanitizer' : 'AddressSanitizer'} reported nothing — confirm by hand` };
}

/**
 * Run the instrumented twin of a snippet and check the counting answers against
 * what it actually printed. This is the check that earns the script its keep.
 */
async function checkProbe(job, dir) {
  const { item } = job;
  const src = join(dir, `${job.id}-probe.cpp`);
  await writeFile(src, item.probe);

  const bin = `${src}.out`;
  const build = await compile([STD, '-O0', src, '-o', bin]);
  if (build.timedOut) return { level: 'fail', message: 'compiler timed out' };
  if (build.code !== 0) return { level: 'fail', message: 'probe does not build', detail: build.stderr };

  const r = await execute(bin, { env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } });
  if (r.timedOut) return { level: 'fail', message: 'probe timed out' };
  if (r.code !== 0) {
    return { level: 'fail', message: `probe exited ${r.signal || r.code}`, detail: r.stderr };
  }

  const tally = Object.fromEntries(TOKENS.map((t) => [t, 0]));
  const stray = new Set();
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t in tally) tally[t]++;
    else stray.add(t);
  }
  if (stray.size) {
    return {
      level: 'fail',
      message: `probe printed ${[...stray].slice(0, 3).map((s) => JSON.stringify(s)).join(', ')} — it must print only ${TOKENS.join('/')}`,
    };
  }

  const wrong = job.parts
    .filter((p) => tally[p.verify] !== p.answer)
    .map((p) => `${p.id} says ${p.answer} ${p.verify}, the probe ran ${tally[p.verify]}`);
  return wrong.length ? { level: 'fail', message: wrong.join('; ') } : null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
