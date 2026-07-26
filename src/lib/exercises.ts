import { getCollection, type CollectionEntry } from 'astro:content';
import { bookBySlug } from '../books';

export type ExerciseSet = CollectionEntry<'exercises'>;
export type Mcq = ExerciseSet['data']['mcq'][number];
export type Reading = ExerciseSet['data']['reading'][number];
export type Writing = ExerciseSet['data']['writing'][number];

/** Any single exercise, tagged with the mode the quiz should run it in. */
export type Item =
  | ({ mode: 'mcq' } & Mcq)
  | ({ mode: 'reading' } & Reading)
  | ({ mode: 'writing' } & Writing);

/**
 * How a section name is shown in the quiz. An exercise's `section` is the
 * heading's markdown *source*, so it can carry backticks and emphasis markers
 * ("`auto` and `decltype`", "Contracts **(C++26)**"). The quiz renders plain
 * text, so drop the markup rather than printing it literally.
 */
export function sectionLabel(section: string): string {
  return section
    .replace(/`/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Key used to match an exercise's `section` against a rendered chapter heading.
 * Beyond the display normalisation, this mirrors one more thing markdown does:
 * an unbackticked `<char>` in a heading is parsed as raw HTML and vanishes from
 * the rendered text, so it must vanish from both sides of the comparison too.
 */
export function sectionKey(section: string): string {
  return sectionLabel(section).replace(/<[^>\s][^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** `cpp/exercises/02-types-and-conversions` -> `cpp`. */
export function exerciseBookDir(ex: ExerciseSet): string {
  return ex.id.split('/')[0];
}

/**
 * The slug of the chapter this set belongs to — the entry id with the book
 * directory and the `exercises/` segment stripped, so it matches `chapterSlug()`
 * from `src/lib/chapters.ts` and can be used to build chapter URLs.
 */
export function exerciseChapterSlug(ex: ExerciseSet): string {
  return ex.id.split('/').slice(2).join('/');
}

/** All exercise sets for a book, ordered by chapter number. Takes the book's URL slug. */
export async function getBookExercises(slug: string): Promise<ExerciseSet[]> {
  const dir = bookBySlug(slug)?.dir ?? slug;
  const all = await getCollection('exercises');
  return all
    .filter((e) => exerciseBookDir(e) === dir)
    .sort((a, b) => a.data.chapter - b.data.chapter);
}

/** Flatten a set into a single mode-tagged list, in authored order. */
export function items(ex: ExerciseSet): Item[] {
  return [
    ...ex.data.mcq.map((q) => ({ mode: 'mcq' as const, ...q })),
    ...ex.data.reading.map((q) => ({ mode: 'reading' as const, ...q })),
    ...ex.data.writing.map((q) => ({ mode: 'writing' as const, ...q })),
  ];
}

export function counts(ex: ExerciseSet) {
  const { mcq, reading, writing } = ex.data;
  return {
    mcq: mcq.length,
    reading: reading.length,
    writing: writing.length,
    total: mcq.length + reading.length + writing.length,
  };
}

/**
 * Every code snippet in a set, keyed by the id the quiz uses to look it up.
 * Writing items contribute up to two snippets (the starter and the reference
 * solution), which is why the key is not simply the exercise id.
 */
export function snippets(ex: ExerciseSet): { key: string; code: string }[] {
  const out: { key: string; code: string }[] = [];
  for (const q of ex.data.mcq) if (q.code) out.push({ key: q.id, code: q.code });
  for (const q of ex.data.reading) out.push({ key: q.id, code: q.code });
  for (const q of ex.data.writing) {
    if (q.starter) out.push({ key: `${q.id}:starter`, code: q.starter });
    out.push({ key: `${q.id}:solution`, code: q.solution });
  }
  return out;
}
