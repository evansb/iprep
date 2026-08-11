// Registry of every book in the library.
//
// To add a new book:
//   1. Drop its chapter markdown files in a new top-level directory (e.g. `python/`),
//      named `NN-title.md` so they sort by chapter number.
//   2. Add an entry here.
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
  {
    dir: 'hft-bootcamp',
    slug: 'hft-bootcamp',
    title: 'HFT System Engineering Bootcamp',
    subtitle: 'A preparation guide for low-latency interviews',
    description:
      'A systems-engineering guide to the hardware, operating systems, networking, and ' +
      'measurement techniques behind deterministic low-latency systems. Built for engineers ' +
      'preparing for HFT infrastructure and performance interviews.',
    badge: 'HFT',
  },
  {
    dir: 'cpp-quant-cheatsheet',
    slug: 'cpp-cheatsheet',
    title: 'The C++ Interview Cheatsheet',
    subtitle: 'C++23 recall, syntax, and blueprints for quant and HFT interviews',
    description:
      'A cheatsheet, not a tutorial: one-line recall for every rule, comprehensive syntax and ' +
      'standard-library tables with complexity and invalidation, and whiteboard-ready ' +
      'implementations of ring buffers, order books, and parsers — closing with drills and appendices.',
    badge: 'C++23',
  },
];

export const bookBySlug = (slug: string): Book | undefined =>
  books.find((b) => b.slug === slug);
