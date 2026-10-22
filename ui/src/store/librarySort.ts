// "Sort by" for the Albums and Artists sections of Your Library; kept in settings until changed.
import type { Album, Artist } from "../types";

export type AlbumSortKey = "recent" | "alpha" | "artist" | "year";
export type ArtistSortKey = "recent" | "alpha";
export interface LibSort<K extends string> {
  key: K;
  desc: boolean;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
// "The Beatles" files under B, like Spotify and most music players.
const sortName = (s: string | null | undefined) => (s ?? "").trim().replace(/^the\s+/i, "");

/** Albums in the chosen order. "recent" is the library's own order (newest saves first). Stable. */
export function sortAlbums(albums: Album[], sort: LibSort<AlbumSortKey>): Album[] {
  const rows = albums.map((a, i) => ({ a, i }));
  const dir = sort.desc ? -1 : 1;
  const cmp = (x: { a: Album; i: number }, y: { a: Album; i: number }): number => {
    switch (sort.key) {
      case "alpha":
        return collator.compare(sortName(x.a.title), sortName(y.a.title)) * dir;
      case "artist":
        return (
          collator.compare(sortName(x.a.artist), sortName(y.a.artist)) * dir ||
          // An artist's albums oldest first, as in a discography.
          (x.a.year ?? 9999) - (y.a.year ?? 9999) ||
          collator.compare(x.a.title, y.a.title)
        );
      case "year": {
        // Albums without a year go last either way.
        if (x.a.year == null || y.a.year == null) return x.a.year == null && y.a.year == null ? 0 : x.a.year == null ? 1 : -1;
        return (x.a.year - y.a.year) * dir;
      }
      default:
        return sort.desc ? y.i - x.i : 0;
    }
  };
  return rows.sort((x, y) => cmp(x, y) || x.i - y.i).map((r) => r.a);
}

export function sortArtists(artists: Artist[], sort: LibSort<ArtistSortKey>): Artist[] {
  if (sort.key === "recent") return sort.desc ? [...artists].reverse() : artists;
  const dir = sort.desc ? -1 : 1;
  return artists
    .map((a, i) => ({ a, i }))
    .sort((x, y) => collator.compare(sortName(x.a.name), sortName(y.a.name)) * dir || x.i - y.i)
    .map((r) => r.a);
}
