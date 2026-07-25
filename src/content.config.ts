import { defineCollection } from 'astro:content';
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

export const collections = { chapters };
