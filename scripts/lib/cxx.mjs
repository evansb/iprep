/**
 * Talking to the local C++ compiler.
 *
 * Shared by `verify-exercises.mjs` and `verify-challenges.mjs`. Both scripts do
 * the same three things — probe for a compiler, compile a snippet, run the
 * result under a budget — and only disagree about what the outcome is supposed
 * to be, so that is all that lives in them.
 */
import { execFile } from 'node:child_process';

export const CXX = process.env.CXX || 'clang++';
export const STD = process.env.CXXSTD || '-std=c++23';

// Two very different budgets. Compiling a threaded or heavily-templated snippet
// on a loaded machine can take many seconds and that says nothing about the
// exercise, so the compiler gets room. Running is where a snippet that hangs
// must be caught, and correct snippets finish in milliseconds.
export const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 120000);
export const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 5000);
export const CONCURRENCY = Number(process.env.VERIFY_JOBS || 8);

export const run = (cmd, args, opts = {}) =>
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
export const compile = (args) => run(CXX, args, { timeout: COMPILE_TIMEOUT_MS });

/**
 * Execute a built snippet. On macOS the first exec of a freshly written binary
 * is scanned by the system (seconds of wall time at almost no CPU), which looks
 * exactly like a hang. A snippet that genuinely loops forever times out twice;
 * one that was merely being scanned runs immediately the second time.
 */
export const execute = async (bin, opts) => {
  const first = await run(bin, [], opts);
  if (!first.timedOut) return first;
  return run(bin, [], opts);
};

/**
 * Confirm there is a usable compiler, and print which one. Returns false when
 * there is not — the caller is expected to exit 0, because a machine without a
 * C++23 compiler has not found a problem with the content.
 */
export async function announceCompiler() {
  const probe = await run(CXX, ['--version']);
  if (probe.code !== 0) {
    console.log(`skip: no working ${CXX} on this machine — nothing verified.`);
    return false;
  }
  console.log(`${CXX} ${STD} · ${probe.stdout.split('\n')[0]}\n`);
  return true;
}

/** Whether a snippet is a whole program or a fragment that can only be parsed. */
export const isProgram = (code) => /\bint\s+main\s*\(/.test(code);

/** Run `jobs` through `fn` with a fixed pool, reporting progress on stderr. */
export async function pool(jobs, fn) {
  const queue = jobs.slice();
  let done = 0;
  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      await fn(job);
      done++;
      process.stderr.write(`\r${done}/${jobs.length} checked`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write('\r');
}
