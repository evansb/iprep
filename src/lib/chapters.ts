import { getCollection, type CollectionEntry } from 'astro:content';
import { bookBySlug } from '../books';

export type Chapter = CollectionEntry<'chapters'>;

/**
 * The source directory is the first path segment of the entry id
 * (`cpp/01-...` -> `cpp`). This is the book's `dir`, which is not necessarily
 * its URL `slug` — see `src/books.ts`.
 */
export function bookDir(ch: Chapter): string {
  return ch.id.split('/')[0];
}

/** The chapter's URL slug is everything after the book directory (`cpp/01-a-tour` -> `01-a-tour`). */
export function chapterSlug(ch: Chapter): string {
  return ch.id.split('/').slice(1).join('/');
}

/** Leading number in the filename, used for ordering (`01-a-tour-of-cpp` -> 1). */
export function chapterNumber(ch: Chapter): number {
  const m = chapterSlug(ch).match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Human title, taken from the markdown H1 with any leading chapter number
 * stripped — the number is rendered separately in the sidebar and table of
 * contents. Handles both house styles: `# 1. A Tour of C++` and
 * `# Lecture 1 — Physical and Statistical Foundations`.
 */
export function chapterTitle(ch: Chapter): string {
  const m = ch.body?.match(/^#\s+(.+?)\s*$/m);
  const raw = m ? m[1] : chapterSlug(ch);
  return raw
    .replace(/^\d+\.\s*/, '')
    .replace(/^(?:Lecture|Chapter|Part)\s+\d+\s*[—–-]\s*/i, '')
    .trim();
}

/** All chapters of a book, ordered by chapter number. Takes the book's URL slug. */
export async function getBookChapters(slug: string): Promise<Chapter[]> {
  // Chapters live under the book's `dir`, which may differ from its URL slug.
  const dir = bookBySlug(slug)?.dir ?? slug;
  const all = await getCollection('chapters');
  return all
    .filter((c) => bookDir(c) === dir)
    .sort((a, b) => chapterNumber(a) - chapterNumber(b));
}
