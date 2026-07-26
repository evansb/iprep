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

export const collections = { chapters, exercises };
