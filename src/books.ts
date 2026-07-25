// Registry of every book in the library.
//
// To add a new book:
//   1. Drop its chapter markdown files in a new top-level directory (e.g. `python/`),
//      named `NN-title.md` so they sort by chapter number.
//   2. Add an entry here.
//   3. Add its glob pattern in `src/content.config.ts`.
// Everything else (routes, table of contents, navigation) is generated automatically.

export interface Book {
  /** Top-level directory holding the chapter markdown. */
  dir: string;
  /** URL segment for the book. May differ from `dir`. */
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
  {
    dir: 'system-design-notes',
    slug: 'system-design',
    title: 'System Design',
    subtitle: 'Fast-paced revision notes for staff-level interviews',
    description:
      'Concepts and component internals, no exercises — from latency arithmetic and ' +
      'consensus to caching, reliability, and deep dives on PostgreSQL, Redis, and Kafka. ' +
      'Written to work as both a first read and a ten-minute refresher.',
    badge: 'SD',
  },
];

export const bookBySlug = (slug: string): Book | undefined =>
  books.find((b) => b.slug === slug);
