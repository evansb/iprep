import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { books } from './books';

// One collection holds every chapter of every book. The `id` of each entry is the
// path relative to the project root without the extension, e.g. `cpp/01-a-tour-of-cpp`.
// The book slug and chapter file are derived from that id in `src/lib/chapters.ts`.
const chapters = defineCollection({
  loader: glob({
    pattern: books.map((b) => `${b.dir}/*.md`),
    base: '.',
  }),
});

export const collections = { chapters };
