# Authoring challenges

One JSON file per challenge set: `cpp/challenges/<kind>.json`. The `kind` field,
the filename and the URL segment (`/challenges/<kind>/`) are all the same string.

These are **not** the per-chapter exercises in `cpp/exercises/`. An exercise asks
one question and grades one answer. A challenge shows one snippet and asks two to
four questions about it — *how many copies, which line races, which fix is right* —
and is only recorded as correct when every part is right. That difference is why
they are a separate collection, a separate app (`src/components/Challenge.astro`)
and a separate localStorage namespace (`challenge:<book>:<kind>`).

Everything here is schema-checked at build time (`src/content.config.ts`) and
compile-checked by `npm run verify:challenges`. Both must pass.

## Shape

```jsonc
{
  "kind": "optimization",
  "title": "Code Optimization",
  "blurb": "One-line description shown on the app home.",
  "items": [
    {
      "id": "opt-01",
      "title": "Short name shown in the summary",
      "difficulty": "easy" | "medium" | "hard",
      "topic": "copy elision",        // short chip, free-form
      "prompt": "The framing sentence. State any invariant the reader needs.",
      "code": "…",                    // ≤ ~30 lines, displayed with line numbers
      "parts": [ /* 2–4 */ ],
      "explain": "The overall analysis, shown once every part is graded.",
      "review": { "chapter": "07-moves-and-copies", "section": "Copy elision" },
      "check": "syntax",              // how the verifier exercises it, see below
      "probe": "…"                    // never displayed, see "Verifying"
    }
  ]
}
```

### Parts

Every part has `id` (unique within the item), `label` and `explain`.

```jsonc
{ "type": "count",  "answer": 2, "verify": "copy" }        // number input, exact match
{ "type": "lines",  "answer": [7, 12] }                    // click lines in the snippet, 1-based
{ "type": "select", "options": ["…"], "answer": [0, 2] }   // checkboxes, exact set
{ "type": "choice", "options": ["…"], "answer": 1 }        // radios
```

`verify` on a `count` part names a token the item's `probe` prints (`copy`, `move`,
`dtor`, `alloc`); the verifier then checks the number by *running* the code. Use it
on every counting part you can — a mis-stated elision answer is exactly the mistake
these items exist to teach, and it is not one to make in the answer key.

The probe is a twin of the snippet, not a copy of it: same structure, plus whatever
instrumentation the count needs, and nothing else on stdout. Two conventions:

- **copies and moves** — give the type a logging copy constructor, move
  constructor and destructor that `puts("copy")`, `puts("move")`, `puts("dtor")`.
- **leaks** — keep a `static int live` bumped in the constructor and dropped in the
  destructor, and print one `alloc` per survivor from the destructor of a static
  `Reporter` declared *before* anything else, so it runs last:

  ```cpp
  static int live = 0;
  struct Reporter { ~Reporter() { for (int i = 0; i < live; ++i) std::puts("alloc"); } };
  static Reporter reporter;
  ```

Some counts — cache lines touched, allocations inside the standard library — cannot
be printed by the program. Leave `verify` off those; the verifier warns, which is
the point.

## Rules

The `cpp/exercises/README.md` rules all apply — plausible code with a subtle trap,
two ideas in collision, a setting the chapters do not already use, and an `explain`
that says why the *tempting wrong* answer is wrong. On top of those:

- **The snippet must be readable at a glance.** A reader is counting constructions
  or hunting one defect; thirty lines is the ceiling and twenty is better.
- **One defect per item.** If a snippet has two bugs, a reader who finds the other
  one is marked wrong for being right.
- **`lines` answers must be unambiguous.** Ask for the line where the defect *is*,
  not where a fix might go, and say which in the label. When the write and the read
  of a race are on different lines, both are the answer — say "every line".
- **Counting parts state the ground rules in `prompt`**: which type logs, whether
  the build is `-O0`, and that mandatory elision is assumed (it is C++17 and later,
  so it always is).
- **Parts must be independently answerable.** Do not make part 3 unanswerable to a
  reader who got part 1 wrong.

## Verifying

```sh
npm run verify:challenges                          # every set
npm run verify:challenges cpp/challenges/memory.json
npm run build                                      # schema check + page generation
```

`check` picks how the verifier exercises the snippet:

| `check` | what runs | passes when |
|---|---|---|
| `syntax` (default) | `-fsyntax-only` | it compiles |
| `run` | compile and run | exit 0 |
| `crash` | compile and run | it exits non-zero or by a signal |
| `tsan` | `-fsanitize=thread` | ThreadSanitizer reports; silence only *warns* |
| `asan` | `-fsanitize=address` | AddressSanitizer reports; silence only *warns* |
| `leak` | `-fsanitize=address` with `detect_leaks=1` | LeakSanitizer reports |
| `deadlock` | compile and run with a short budget | the run **times out** — that is the bug |

`leak` needs Linux: LeakSanitizer is not available in Apple's clang, so on macOS
those items are reported as skipped rather than failed. Everything else works on
both.

Like `verify:exercises` and `check:novelty`, this script is a **local** gate — CI
only runs `astro build`, which is the schema check. Run it before committing.
