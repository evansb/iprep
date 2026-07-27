import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { books } from './books';

// One collection holds every chapter of every book. The `id` of each entry is the
// path relative to the project root without the extension, e.g. `cpp/01-a-tour-of-cpp`.
// The book slug and chapter file are derived from that id in `src/lib/chapters.ts`.
const chapters = defineCollection({
  loader: glob({
    // Chapter files follow the documented `NN-title.md` convention. Keeping the
    // filename constraint here excludes book-level files such as README.md, while
    // the non-recursive pattern excludes subdirectories such as prompts/.
    pattern: books.map((b) => `${b.dir}/[0-9][0-9]-*.md`),
    base: '.',
  }),
});

/**
 * Fields every exercise shares. `section` names the `##` heading in the owning
 * chapter that the item is drawn from — the quiz turns it into a "review" link,
 * so it must match a real heading.
 */
const base = {
  id: z.string().regex(/^c\d{2}-[mrw]\d{2}$/, 'id must look like c02-m01 / c02-r01 / c02-w01'),
  section: z.string().min(1),
};

const mcq = z.object({
  ...base,
  difficulty: z.enum(['easy', 'medium', 'hard']),
  prompt: z.string().min(1),
  code: z.string().optional(),
  choices: z.array(z.string().min(1)).length(4),
  answer: z.number().int().min(0).max(3),
  explain: z.string().min(1),
});

const reading = z.object({
  ...base,
  prompt: z.string().min(1),
  code: z.string().min(1),
  // What the snippet actually does. Anything other than `value` is answered with
  // one of the quiz's verdict buttons rather than by typing.
  kind: z.enum(['value', 'no-compile', 'ub', 'crash']),
  // Every acceptable spelling of the answer, for `kind: "value"` only.
  accept: z.array(z.string().min(1)).optional(),
  explain: z.string().min(1),
});

const writing = z.object({
  ...base,
  minutes: z.number().int().min(5).max(15),
  prompt: z.string().min(1),
  starter: z.string().optional(),
  checklist: z.array(z.string().min(1)).min(3).max(6),
  solution: z.string().min(1),
  notes: z.string().optional(),
});

// Exercises live in a per-book `exercises/` subdirectory, one JSON file per
// chapter, named to match the chapter it belongs to. The chapter glob above is
// non-recursive, so these files are not mistaken for chapters.
//
// Unlike `chapters`, this collection is schema-checked: it is the only thing
// standing between a thousand hand-authored items and a silently broken quiz.
const exercises = defineCollection({
  loader: glob({
    pattern: books.map((b) => `${b.dir}/exercises/[0-9][0-9]-*.json`),
    base: '.',
  }),
  schema: z
    .object({
      chapter: z.number().int().positive(),
      mcq: z.array(mcq).default([]),
      reading: z.array(reading).default([]),
      writing: z.array(writing).default([]),
    })
    .superRefine((data, ctx) => {
      const seen = new Set<string>();
      for (const item of [...data.mcq, ...data.reading, ...data.writing]) {
        if (seen.has(item.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate exercise id ${item.id}` });
        }
        seen.add(item.id);
      }
      for (const item of data.reading) {
        // A typed answer is only meaningful when the program actually produces a
        // value; the other kinds are answered with a verdict button.
        if (item.kind === 'value' && !item.accept?.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${item.id}: reading item of kind "value" needs a non-empty accept[]`,
          });
        }
        if (item.kind !== 'value' && item.accept?.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${item.id}: accept[] is only valid for kind "value" (got "${item.kind}")`,
          });
        }
      }
    }),
});

/* ---- Challenges -----------------------------------------------------------
   A second, separate exercise app. Where an `exercises` item asks for one
   answer, a challenge asks several questions about a single snippet — how many
   copies, which line races, which fix is right — and is only correct when every
   part is. That is why it is its own collection rather than a fourth mode of
   the quiz. Files live in `<book>/challenges/`, which matches neither glob
   above. */

/** Fields every part shares. `explain` is shown per part after grading. */
const partBase = {
  id: z.string().min(1),
  label: z.string().min(1),
  explain: z.string().min(1),
};

const countPart = z.object({
  ...partBase,
  type: z.literal('count'),
  answer: z.number().int().min(0),
  // Names a token the item's `probe` prints, so the verifier can check this
  // number by running the code instead of trusting the author.
  verify: z.enum(['copy', 'move', 'dtor', 'alloc']).optional(),
});

const linesPart = z.object({
  ...partBase,
  type: z.literal('lines'),
  /** 1-based line numbers into the item's `code`. */
  answer: z.array(z.number().int().positive()).min(1),
});

const selectPart = z.object({
  ...partBase,
  type: z.literal('select'),
  options: z.array(z.string().min(1)).min(2).max(6),
  answer: z.array(z.number().int().min(0)).min(1),
});

const choicePart = z.object({
  ...partBase,
  type: z.literal('choice'),
  options: z.array(z.string().min(1)).min(2).max(4),
  answer: z.number().int().min(0),
});

const part = z.discriminatedUnion('type', [countPart, linesPart, selectPart, choicePart]);

const challengeItem = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  /** Short free-form tag shown as a chip, e.g. "copy elision", "false sharing". */
  topic: z.string().min(1),
  prompt: z.string().min(1),
  code: z.string().min(1),
  parts: z.array(part).min(2).max(4),
  explain: z.string().min(1),
  /** Optional deep link back into the book: chapter slug + `##` heading text. */
  review: z.object({ chapter: z.string().min(1), section: z.string().min(1) }).optional(),
  /** How `npm run verify:challenges` should exercise the snippet. */
  check: z.enum(['syntax', 'run', 'crash', 'tsan', 'asan', 'leak', 'deadlock']).optional(),
  /** Never displayed: an instrumented program that proves the `count` answers. */
  probe: z.string().optional(),
});

const challenges = defineCollection({
  loader: glob({
    pattern: books.map((b) => `${b.dir}/challenges/*.json`),
    base: '.',
  }),
  schema: z
    .object({
      kind: z.string().regex(/^[a-z][a-z0-9-]*$/),
      title: z.string().min(1),
      blurb: z.string().min(1),
      items: z.array(challengeItem).min(1),
    })
    .superRefine((data, ctx) => {
      const seen = new Set<string>();
      for (const item of data.items) {
        if (seen.has(item.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate item id ${item.id}` });
        }
        seen.add(item.id);

        const lineCount = item.code.split('\n').length;
        const partIds = new Set<string>();
        for (const p of item.parts) {
          if (partIds.has(p.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${item.id}: duplicate part id ${p.id}`,
            });
          }
          partIds.add(p.id);

          // An answer that points past the end of the snippet can never be
          // given, so it is a typo rather than a hard question.
          if (p.type === 'lines') {
            const bad = p.answer.filter((n) => n > lineCount);
            if (bad.length) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${item.id}/${p.id}: line ${bad.join(', ')} is past the end of a ${lineCount}-line snippet`,
              });
            }
            if (new Set(p.answer).size !== p.answer.length) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${item.id}/${p.id}: duplicate line numbers`,
              });
            }
          }
          if (p.type === 'select' && p.answer.some((i) => i >= p.options.length)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${item.id}/${p.id}: answer index out of range`,
            });
          }
          if (p.type === 'select' && new Set(p.answer).size !== p.answer.length) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${item.id}/${p.id}: duplicate answer indices`,
            });
          }
          if (p.type === 'choice' && p.answer >= p.options.length) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${item.id}/${p.id}: answer index out of range`,
            });
          }
        }
      }
    }),
});

export const collections = { chapters, exercises, challenges };
