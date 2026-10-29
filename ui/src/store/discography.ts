// Artist discography tabs, like Spotify: Albums, Singles and EPs, and Compilations, each newest
// first. Pure, so it is unit-tested.
import type { Album } from "../types";

/** Comparable album title: lower case, without "(Deluxe Edition)"-style suffixes or punctuation. */
export function albumKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Titles that say they're a compilation even when the provider doesn't. */
const COMPILATION_TITLE =
  /\b(greatest hits|best of|the very best|the essential|essentials|anthology|rarities|b-sides|retrospective|the singles|singles collection|collection)\b/i;

/** Newest first; songs without a year last; ties keep the provider's order. */
export function newestFirst<T extends { year?: number | null }>(items: T[]): T[] {
  return items
    .map((a, i) => [a, i] as const)
    .sort(([a, i], [b, j]) => (b.year ?? -1) - (a.year ?? -1) || i - j)
    .map(([a]) => a);
}

/**
 * Split an artist's albums into albums and compilations. An album is a compilation when the
 * provider says so (Plex), MusicBrainz lists it as one of the artist's compilations, or its title
 * clearly says so ("Greatest Hits", "Best of", "… Collection").
 */
export function splitCompilations(albums: Album[], mbCompilations: string[] = []): { albums: Album[]; compilations: Album[] } {
  const known = new Set(mbCompilations.map(albumKey));
  const out = { albums: [] as Album[], compilations: [] as Album[] };
  for (const a of albums) {
    const isComp = a.kind === "compilation" || known.has(albumKey(a.title)) || COMPILATION_TITLE.test(a.title);
    (isComp ? out.compilations : out.albums).push(isComp && a.kind !== "compilation" ? { ...a, kind: "compilation" } : a);
  }
  return { albums: newestFirst(out.albums), compilations: newestFirst(out.compilations) };
}
