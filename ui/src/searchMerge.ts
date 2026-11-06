// Combined search. Each source is asked on its own (YouTube Music, Plex, then local files with
// app playlists), so a slow Plex server never holds up YouTube's answer. The answers are merged
// here as they arrive:
// - every section interleaves the two providers (a, b, a, b…), starting with the provider whose
//   result became the Top result;
// - with one provider, its own Top result stays; with two, the tops are compared by how well their
//   title matches the query (exact, then prefix, then contains), and a tie goes to Plex (owned
//   files);
// - local files follow the providers' songs, albums and artists; app playlists come first among
//   the playlists, as before.
// - artists the backend confirmed to be one artist are shown once where the list is drawn
//   (dedupeArtists + store/artistLinks.ts); the page of the one kept merges the others.
import type { Artist, MediaItem, ProviderError, SearchResults } from "./types";

const FOLD: Record<string, string> = { æ: "ae", œ: "oe", ø: "o", ß: "ss", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i", "&": " and " };

/** An artist name for matching across sources, as Rust's `artist_merge::artist_key`: case,
 * diacritics and punctuation ignored, a leading "The" optional. Empty when nothing is left. */
export function artistKey(name: string): string {
  const f = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .replace(/[æœøßłđðþı&]/g, (c) => FOLD[c])
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
  const rest = f.startsWith("the ") ? f.slice(4) : "";
  return rest || f;
}

export const artistSource = (id: string) => (id.startsWith("plex:") ? "plex" : id.startsWith("yt:") ? "youtube" : "local");

/**
 * One entry per artist across sources: of two artists the backend confirmed to be the same one
 * (`links`, from `artist_links`: same name and a shared song or release), the later is dropped,
 * since the page of the one kept merges it. Nothing is dropped on a name alone (YouTube's two
 * Nirvanas stay), and with no links (one service on) the list is unchanged.
 */
export function dedupeArtists<T extends Pick<Artist, "id">>(xs: T[], links: readonly (readonly [string, string])[]): T[] {
  if (!links.length) return xs;
  // Union the linked ids; each group keeps its first artist in the list.
  const parent = new Map<string, string>();
  const root = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const [a, b] of links) {
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent.set(rb, ra);
  }
  const linked = new Set(links.flat());
  const kept = new Set<string>();
  const drop = new Set<string>();
  for (const a of xs) {
    if (!linked.has(a.id)) continue;
    const g = root(a.id);
    if (kept.has(g)) drop.add(a.id);
    else kept.add(g);
  }
  return drop.size ? xs.filter((a) => !drop.has(a.id)) : xs;
}

/** Artists worth asking the backend about: those whose name (artistKey) another source also
 * lists here. Up to 20. */
export function linkCandidates<T extends Pick<Artist, "id" | "name">>(xs: T[]): string[] {
  const srcs = new Map<string, Set<string>>();
  for (const a of xs) {
    const k = artistKey(a.name);
    if (!k) continue;
    if (!srcs.has(k)) srcs.set(k, new Set());
    srcs.get(k)!.add(artistSource(a.id));
  }
  return xs.filter((a) => (srcs.get(artistKey(a.name))?.size ?? 0) > 1).map((a) => a.id).slice(0, 20);
}

/** The parts of one search: a provider's answer, or local files + app playlists ("local"). */
export interface SearchParts {
  youtube?: SearchResults | null;
  plex?: SearchResults | null;
  local?: SearchResults | null;
}

export const emptyResults = (): SearchResults => ({ top: null, tracks: [], albums: [], artists: [], playlists: [], podcasts: [], episodes: [] });

/** How well an item's title (or artist name) matches the query: 0 exact, 1 prefix, 2 contains,
 * 3 not at all, 4 no item. Case-insensitive, surrounding spaces ignored. */
export function matchClass(item: MediaItem | null | undefined, query: string): number {
  if (!item) return 4;
  const name = (item.type === "artist" ? item.name : item.title).trim().toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 3;
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  return 3;
}

/** a0, b0, a1, b1…; the longer list's rest at the end. */
export function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/** The Top result of two providers: the better title match; Plex on a tie. */
export function pickTop(query: string, yt: MediaItem | null | undefined, plex: MediaItem | null | undefined): MediaItem | null {
  if (yt && plex) return matchClass(yt, query) < matchClass(plex, query) ? yt : plex;
  return plex ?? yt ?? null;
}

const SECTIONS = ["tracks", "albums", "artists", "podcasts", "episodes"] as const;

/** Merge whatever parts have arrived (missing ones count as empty). `errors` adds failures noticed
 * by the caller (a part whose request failed) to the ones the parts report. */
export function mergeSearch(query: string, parts: SearchParts, errors: ProviderError[] = []): SearchResults {
  const yt = parts.youtube ?? null;
  const plex = parts.plex ?? null;
  const local = parts.local ?? null;
  const top = pickTop(query, yt?.top, plex?.top) ?? local?.top ?? null;
  // The provider of the Top result leads every section; Plex when there's no Top result.
  const [a, b] = top && yt && top === yt.top ? [yt, plex] : [plex, yt];
  const out = emptyResults();
  out.top = top;
  for (const k of SECTIONS) {
    (out[k] as unknown[]) = [...interleave<unknown>(a?.[k] ?? [], b?.[k] ?? []), ...(local?.[k] ?? [])];
  }
  out.playlists = [...(local?.playlists ?? []), ...interleave(a?.playlists ?? [], b?.playlists ?? [])];
  const errs = [...partErrors(yt), ...partErrors(plex), ...errors];
  if (errs.length) (out as SearchResults & { errors?: ProviderError[] }).errors = errs;
  return out;
}

/** The per-provider failures a merged (fan-out) answer reports, if any. */
export function partErrors(x: object | null | undefined): ProviderError[] {
  const e = (x as { errors?: unknown } | null | undefined)?.errors;
  return Array.isArray(e) ? (e as ProviderError[]) : [];
}

/** Nothing found in any section. */
export function isEmptyResults(r: SearchResults): boolean {
  return !r.top && !r.tracks.length && !r.albums.length && !r.artists.length && !r.playlists.length && !r.podcasts.length && !r.episodes.length;
}
