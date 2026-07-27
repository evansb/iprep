import { getCollection, type CollectionEntry } from 'astro:content';
import { bookBySlug } from '../books';

export type ChallengeSet = CollectionEntry<'challenges'>;
export type ChallengeItem = ChallengeSet['data']['items'][number];
export type ChallengePart = ChallengeItem['parts'][number];

/** `cpp/challenges/optimization` -> `cpp`. */
export function challengeBookDir(set: ChallengeSet): string {
  return set.id.split('/')[0];
}

/**
 * The URL segment for a set. Taken from the filename rather than the `kind`
 * field so a route can never point at a file that does not exist.
 */
export function challengeKind(set: ChallengeSet): string {
  return set.id.split('/').pop() ?? set.id;
}

/**
 * All challenge sets for a book, in the order they should be worked through.
 * Takes the book's URL slug.
 */
export async function getChallengeSets(slug: string): Promise<ChallengeSet[]> {
  const dir = bookBySlug(slug)?.dir ?? slug;
  const all = await getCollection('challenges');
  return all.filter((s) => challengeBookDir(s) === dir).sort((a, b) => ORDER.indexOf(challengeKind(a)) - ORDER.indexOf(challengeKind(b)));
}

/**
 * Presentation order of the sets: cost first, then the two bug hunts. Anything
 * unlisted sorts to the front, which is loud enough to notice and harmless.
 */
const ORDER = ['optimization', 'concurrency', 'memory'];

/**
 * Every snippet in a set, keyed by the id the client script looks it up with.
 * One per item — unlike the quiz, a challenge never has a second snippet.
 */
export function snippets(set: ChallengeSet): { key: string; code: string }[] {
  return set.data.items.map((item) => ({ key: item.id, code: item.code }));
}

export function counts(set: ChallengeSet) {
  const items = set.data.items.length;
  return { items, parts: set.data.items.reduce((n, i) => n + i.parts.length, 0) };
}

/** localStorage namespace for a set. Distinct from the quiz's `quiz:` keys. */
export function storageKey(bookSlug: string, kind: string): string {
  return `challenge:${bookSlug}:${kind}`;
}
