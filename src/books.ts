// Registry of every book in the library.
//
// To add a new book:
//   1. Drop its chapter markdown files in a new top-level directory (e.g. `python/`),
//      named `NN-title.md` so they sort by chapter number.
//   2. Add an entry here.
//   3. Add its glob pattern in `src/content.config.ts`.
// Everything else (routes, table of contents, navigation) is generated automatically.

export interface Book {
  /** Top-level directory holding the chapter markdown, also used as the URL slug. */
  dir: string;
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  /** Emoji or short glyph shown on the library home cards. */
  badge: string;
}

export const books: Book[] = [
  {
    dir: 'cpp',
    slug: 'cpp',
    title: 'Modern C++',
    subtitle: 'A ground-up guide for low-latency and systems programming',
    description:
      'A cost-aware tour of C++23 — from the toolchain and the type system to ownership, ' +
      'templates, the memory model, and lock-free programming. Written for engineers who ' +
      'need to know what the machine actually does.',
    badge: 'C++',
  },
];

export const bookBySlug = (slug: string): Book | undefined =>
  books.find((b) => b.slug === slug);
