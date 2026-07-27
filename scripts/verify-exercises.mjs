#!/usr/bin/env node
/**
 * Compile-checks every claim the exercises make about C++.
 *
 * The exercise JSON asserts things a reader will trust: that a snippet prints
 * `4`, that another one does not compile, that a reference solution is valid.
 * This script hands each snippet to the local compiler and checks that the
 * claim holds.
 *
 *   node scripts/verify-exercises.mjs            # every book
 *   node scripts/verify-exercises.mjs cpp/exercises/02-*.json
 *
 * Rules, by snippet:
 *   reading kind=value       must compile, run, and print exactly one of accept[]
 *   reading kind=no-compile  must fail to compile
 *   reading kind=ub          must compile; flagged if the sanitizers stay quiet
 *   reading kind=crash       must compile; must exit non-zero or by signal
 *   writing solution         must at least pass a syntax check
 *   mcq code                 must pass a syntax check when it defines main
 *
 * Fragments (anything without `int main`) are only syntax-checked, never run.
 */
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { glob } from 'node:fs/promises';

const CXX = process.env.CXX || 'clang++';
const STD = process.env.CXXSTD || '-std=c++23';
// Two very different budgets. Compiling a threaded or heavily-templated snippet
// on a loaded machine can take many seconds and that says nothing about the
// exercise, so the compiler gets room. Running is where a snippet that hangs
// must be caught, and correct snippets finish in milliseconds.
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 120000);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 5000);
const CONCURRENCY = Number(process.env.VERIFY_JOBS || 8);

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) =>
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        timedOut: Boolean(err && err.killed),
        signal: err?.signal ?? null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      }),
    );
  });

/** Invoke the compiler. Never subject to the run budget. */
const compile = (args) => run(CXX, args, { timeout: COMPILE_TIMEOUT_MS });

/**
 * Execute a built snippet. On macOS the first exec of a freshly written binary
 * is scanned by the system (seconds of wall time at almost no CPU), which looks
 * exactly like a hang. A snippet that genuinely loops forever times out twice;
 * one that was merely being scanned runs immediately the second time.
 */
const execute = async (bin, opts) => {
  const first = await run(bin, [], opts);
  if (!first.timedOut) return first;
  return run(bin, [], opts);
};

async function main() {
  const probe = await run(CXX, ['--version']);
  if (probe.code !== 0) {
    console.log(`skip: no working ${CXX} on this machine — nothing verified.`);
    process.exit(0);
  }
  console.log(`${CXX} ${STD} · ${probe.stdout.split('\n')[0]}\n`);

  const patterns = process.argv.slice(2);
  const files = [];
  if (patterns.length) {
    for await (const f of glob(patterns)) files.push(f);
  } else {
    for await (const f of glob('*/exercises/[0-9][0-9]-*.json')) files.push(f);
  }
  files.sort();
  if (!files.length) {
    console.error('no exercise files matched');
    process.exit(1);
  }

  const jobs = [];
  const sectionErrors = [];
  for (const file of files) {
    const data = JSON.parse(await readFile(file, 'utf8'));

    // `section` becomes a link back into the chapter, so it has to name a real
    // `##` heading — a typo silently drops the link rather than erroring.
    const chapterFile = file.replace('/exercises/', '/').replace(/\.json$/, '.md');
    const headings = new Set(
      (await readFile(chapterFile, 'utf8').catch(() => ''))
        .split('\n')
        .filter((l) => l.startsWith('## '))
        .map((l) => l.slice(3).trim()),
    );
    if (headings.size) {
      for (const q of [...(data.mcq ?? []), ...(data.reading ?? []), ...(data.writing ?? [])]) {
        if (!headings.has(q.section)) {
          sectionErrors.push(`${file} ${q.id}: section ${JSON.stringify(q.section)} is not a heading in ${chapterFile}`);
        }
      }
    }

    for (const q of data.mcq ?? []) {
      if (q.code) jobs.push({ file, id: q.id, what: 'mcq code', code: q.code, expect: 'compiles' });
    }
    for (const q of data.reading ?? []) {
      jobs.push({
        file,
        id: q.id,
        what: 'reading',
        code: q.code,
        expect: q.kind,
        accept: q.accept ?? [],
      });
    }
    for (const q of data.writing ?? []) {
      jobs.push({ file, id: q.id, what: 'solution', code: q.solution, expect: 'compiles' });
      if (q.starter) {
        // A starter is a skeleton by design; only check it does not contain a
        // hard syntax error the reader would have to fight.
        jobs.push({ file, id: q.id, what: 'starter', code: q.starter, expect: 'lenient' });
      }
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'ex-verify-'));
  const failures = [];
  const warnings = [];
  let done = 0;

  const worker = async (queue) => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const outcome = await check(job, dir);
      done++;
      if (outcome?.level === 'fail') failures.push({ job, ...outcome });
      else if (outcome?.level === 'warn') warnings.push({ job, ...outcome });
      process.stderr.write(`\r${done}/${jobs.length} checked`);
    }
  };

  const queue = jobs.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
  process.stderr.write('\r');
  await rm(dir, { recursive: true, force: true });

  for (const e of sectionErrors) console.log(`FAIL  ${e}`);
  for (const w of warnings) {
    console.log(`WARN  ${w.job.file} ${w.job.id} (${w.job.what}) — ${w.message}`);
  }
  for (const f of failures) {
    console.log(`\nFAIL  ${f.job.file} ${f.job.id} (${f.job.what}) — ${f.message}`);
    if (f.detail) console.log(f.detail.split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n'));
  }

  console.log(
    `\n${jobs.length} snippets · ${failures.length + sectionErrors.length} failed · ${warnings.length} warned · from ${files.length} file(s)`,
  );
  process.exit(failures.length + sectionErrors.length ? 1 : 0);
}

async function check(job, dir) {
  const src = join(dir, `${job.id}-${job.what.replace(/\W/g, '')}.cpp`);
  await writeFile(src, job.code);
  const selfContained = /\bint\s+main\s*\(/.test(job.code);

  if (job.expect === 'lenient') {
    const r = await compile([STD, '-fsyntax-only', src]);
    return r.code === 0 || !selfContained
      ? null
      : { level: 'warn', message: 'starter does not compile as written', detail: r.stderr };
  }

  if (job.expect === 'no-compile') {
    const r = await compile([STD, '-fsyntax-only', src]);
    if (r.timedOut) return { level: 'fail', message: 'compiler timed out' };
    return r.code === 0
      ? { level: 'fail', message: 'claims not to compile, but it compiles cleanly' }
      : null;
  }

  // Everything else must at least be well-formed.
  const syntax = await compile([STD, '-fsyntax-only', src]);
  if (syntax.timedOut) return { level: 'fail', message: 'compiler timed out' };
  if (syntax.code !== 0) {
    return { level: 'fail', message: 'does not compile', detail: syntax.stderr };
  }
  if (job.expect === 'compiles' || !selfContained) return null;

  const bin = `${src}.out`;
  const sanitize = job.expect === 'ub' ? ['-fsanitize=address,undefined', '-g'] : [];
  const build = await compile([STD, ...sanitize, '-O0', src, '-o', bin]);
  if (build.timedOut) return { level: 'fail', message: 'compiler timed out' };
  if (build.code !== 0) return { level: 'fail', message: 'fails to link', detail: build.stderr };

  const r = await execute(bin, { env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } });

  if (job.expect === 'value') {
    if (r.timedOut) return { level: 'fail', message: 'timed out' };
    if (r.code !== 0) {
      return { level: 'fail', message: `exited ${r.signal || r.code}`, detail: r.stderr };
    }
    const got = norm(r.stdout);
    if (!job.accept.some((a) => norm(a) === got)) {
      return {
        level: 'fail',
        message: `printed ${JSON.stringify(r.stdout.trim())}, accept[] is ${JSON.stringify(job.accept)}`,
      };
    }
    // The quiz grades case-insensitively, but it *shows* accept[0] to a reader
    // who got it wrong. If that spelling is not what the program prints, the
    // feedback teaches the wrong answer.
    const exact = (x) => x.replace(/\s+/g, ' ').trim();
    if (!job.accept.some((a) => exact(a) === exact(r.stdout))) {
      return {
        level: 'warn',
        message: `accept[0] is ${JSON.stringify(job.accept[0])} but the program prints ${JSON.stringify(r.stdout.trim())} — the reader is shown accept[0]`,
      };
    }
    return null;
  }

  if (job.expect === 'crash') {
    return r.code === 0 && !r.timedOut
      ? { level: 'fail', message: 'claims to crash or hang, but exited 0' }
      : null;
  }

  // kind: "ub". The sanitizers only cover part of the space (uninitialised reads,
  // for instance, need MSan), so silence is reported but never fails the run.
  const noisy = /runtime error|AddressSanitizer|UndefinedBehaviorSanitizer/.test(r.stderr);
  return noisy || r.code !== 0
    ? null
    : { level: 'warn', message: 'claims UB, but ASan/UBSan reported nothing — confirm by hand' };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
