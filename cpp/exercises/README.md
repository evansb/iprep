# Authoring exercises

One JSON file per chapter, named to match the chapter file it belongs to:
`cpp/exercises/NN-same-slug-as-the-chapter.json`. The chapter glob in
`src/content.config.ts` is non-recursive, so nothing in this directory is
mistaken for a chapter — and this README matches neither glob.

Everything here is schema-checked at build time (`src/content.config.ts`) and
compile-checked by `npm run verify:exercises`. Both must pass.

## Shape

```jsonc
{
  "chapter": 2,
  "mcq":     [ /* 20–30 items */ ],
  "reading": [ /* 5–10 items  */ ],
  "writing": [ /* 5–10 items  */ ]
}
```

Ids are `c<NN>-m<NN>` / `-r<NN>` / `-w<NN>` and must be unique within the file.
`section` must be the **exact text of a `##` heading** in the owning chapter —
the quiz turns it into a "Review …" link, and the verifier fails the run on a
typo rather than silently dropping the link.

### `mcq`

```jsonc
{
  "id": "c02-m01",
  "section": "Promotions and the usual arithmetic conversions",
  "difficulty": "easy" | "medium" | "hard",
  "prompt": "…",
  "code": "…",            // optional
  "choices": ["…", "…", "…", "…"],   // exactly four
  "answer": 2,                        // index of the correct choice
  "explain": "…"
}
```

### `reading`

```jsonc
{
  "id": "c02-r01",
  "section": "…",
  "prompt": "What does this print?",
  "code": "…",                        // ≤ ~25 lines, self-contained, C++23
  "kind": "value" | "no-compile" | "ub" | "crash",
  "accept": ["44"],                   // required iff kind == "value", forbidden otherwise
  "explain": "…"
}
```

`accept` holds every acceptable spelling. Matching is case-insensitive, ignores
surrounding and repeated whitespace and a trailing period, and treats
`true/yes/1` and `false/no/0` as equivalent — so list only genuinely different
answers. Anything other than `kind: "value"` is answered with one of the quiz's
verdict buttons instead of by typing.

### `writing`

```jsonc
{
  "id": "c02-w01",
  "section": "…",
  "minutes": 10,                      // 5–15
  "prompt": "…",
  "starter": "…",                     // optional; pre-filled in the editor
  "checklist": ["…"],                 // 3–6 objective criteria
  "solution": "…",
  "notes": "…"                        // optional commentary on the solution
}
```

## Counts

Scale to chapter length:

| Chapter lines | MCQ | Reading | Writing |
|---|---:|---:|---:|
| ≥ 900 | 30 | 10 | 10 |
| 600–900 | 25 | 8 | 8 |
| < 600 | 20 | 6 | 6 |

## Rules

- **Answerable from that chapter alone.** No forward references to material a
  reader has not reached.
- **Cover the chapter proportionally.** Roughly two MCQ per `##` section, more
  for the long ones. Tag every item with the section it came from.
- **Distractors must be real misconceptions**, not filler. No "all of the
  above". Vary which index is correct. Mix recall, apply and diagnose.
- **`explain` says why the right answer is right *and* why the tempting wrong
  one is wrong.** That is the part the reader learns from.
- **Reading snippets must be deterministic** where `kind` is `value` — no
  addresses, no unspecified evaluation order, no implementation-defined widths
  in the printed result.
- **Keep a real mix of `no-compile` and `ub`** so the verdict buttons carry
  weight. Never state "prints X" for undefined behaviour.
- **Writing tasks must be buildable from memory** in the stated time, and the
  checklist criteria must be objective enough to grade yourself honestly.

## Verifying

```sh
npm run verify:exercises                       # every book
npm run verify:exercises cpp/exercises/02-*.json
npm run build                                  # schema check + page generation
```

The verifier compiles every snippet with the local `clang++` (override with
`CXX=` / `CXXSTD=`) and checks that each claim holds: `value` items must compile,
run and print one of `accept`; `no-compile` items must fail to compile; `ub`
items are run under ASan/UBSan and *warn* if the sanitizers stay quiet — some
undefined behaviour, such as an uninitialised read, needs MemorySanitizer, so a
warning means "confirm this one by hand", not "wrong".
