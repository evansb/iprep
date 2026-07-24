import { getCollection, type CollectionEntry } from 'astro:content';

export type Chapter = CollectionEntry<'chapters'>;

/** The book slug is the first path segment of the entry id (`cpp/01-...` -> `cpp`). */
export function bookSlug(ch: Chapter): string {
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

/** Human title, taken from the markdown H1 with any leading "N. " stripped. */
export function chapterTitle(ch: Chapter): string {
  const m = ch.body?.match(/^#\s+(.+?)\s*$/m);
  const raw = m ? m[1] : chapterSlug(ch);
  return raw.replace(/^\d+\.\s*/, '').trim();
}

/** All chapters of a book, ordered by chapter number. */
export async function getBookChapters(slug: string): Promise<Chapter[]> {
  const all = await getCollection('chapters');
  return all
    .filter((c) => bookSlug(c) === slug)
    .sort((a, b) => chapterNumber(a) - chapterNumber(b));
}
