// Windows 95 theme "time travel": with the theme on, only music released by today's date 28 years
// ago is shown on artist pages and in What's New. The date moves forward a day each day.
import { useEffect, useState } from "react";
import type { Album, ArtistPage, Track } from "../types";
import { useSettings } from "./settings";

export const RETRO_YEARS = 28;

const pad = (n: number) => String(n).padStart(2, "0");

/** Today's local date `RETRO_YEARS` years ago, as "YYYY-MM-DD". */
export function cutoffFor(now: Date): string {
  const d = new Date(now.getFullYear() - RETRO_YEARS, now.getMonth(), now.getDate());
  // 29 February in a year that has none: 28 February (instead of rolling into March).
  if (d.getMonth() !== now.getMonth()) d.setDate(0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Whether a release was out on `cutoff`. Mirrors `retro::released_by` in Rust: a partial date
 * ("YYYY-MM" or "YYYY") counts as the end of its month or year, a year alone only counts when
 * it's before the cutoff's year, and anything with no date at all is left out (YouTube gives
 * most songs none; `releaseDates` fills in what MusicBrainz knows).
 */
export function releasedBy(r: { year?: number | null; released?: string | null }, cutoff: string): boolean {
  const rel = r.released && r.released.length >= 4 ? r.released : null;
  if (rel) {
    const full = rel.length === 4 ? `${rel}-12-31` : rel.length === 7 ? `${rel}-31` : rel;
    return full <= cutoff;
  }
  if (r.year) return r.year < Number(cutoff.slice(0, 4));
  return false;
}

/** The cutoff while the Windows 95 theme is on (null otherwise); re-renders at local midnight. */
export function useRetroCutoff(): string | null {
  const on = useSettings((s) => s.theme === "win95");
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    if (!on) return;
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    const timer = setTimeout(() => setToday(new Date()), midnight.getTime() - now.getTime());
    return () => clearTimeout(timer);
  }, [on, today]);
  return on ? cutoffFor(today) : null;
}

/**
 * Titles worth looking up release dates for (MusicBrainz, `api.releaseDates`): releases without a
 * date whose year doesn't already settle it, and songs without a year or a dated album (their
 * album's title, and their own).
 */
export function datesWanted(p: ArtistPage, cutoff: string | null): string[] {
  if (!cutoff) return [];
  const year = Number(cutoff.slice(0, 4));
  const releases = [...p.albums, ...p.singles, ...p.appearsOn, ...(p.localAlbums ?? [])];
  const byId = new Map(releases.map((a) => [a.id, a]));
  const out = new Set<string>();
  for (const a of releases) if (!a.released && (!a.year || a.year >= year)) out.add(a.title);
  for (const tr of [...p.topTracks, ...(p.localTracks ?? [])]) {
    const al = tr.albumId ? byId.get(tr.albumId) : undefined;
    if (tr.year || al?.released || (al?.year && al.year < year)) continue;
    if (tr.album) out.add(tr.album);
    out.add(tr.title);
  }
  return [...out].slice(0, 200);
}

/**
 * An artist page with only what was out on `cutoff` (no change when null). `dates`: release dates
 * by title from MusicBrainz, for releases whose provider only gives the year. Songs go by their
 * own year, else their album's date.
 */
export function retroArtist(p: ArtistPage, cutoff: string | null, dates: Record<string, string>): ArtistPage {
  if (!cutoff) return p;
  // A MusicBrainz date only narrows the provider's year down to a day: a release with the same
  // title from another year is a different release (YouTube's 2017 "Akina" is not the 1993
  // compilation "AKINA"), so it never makes a release older than the provider says.
  const dated = (a: Album): Album => {
    const d = dates[a.title];
    return a.released || !d || (a.year && Number(d.slice(0, 4)) !== a.year) ? a : { ...a, released: d };
  };
  const byId = new Map([...p.albums, ...p.singles, ...p.appearsOn, ...(p.localAlbums ?? [])].map((a) => [a.id, dated(a)]));
  const albums = (l: Album[]) => l.map(dated).filter((a) => releasedBy(a, cutoff));
  const tracks = (l: Track[]) =>
    l.filter((tr) => {
      const al = tr.albumId ? byId.get(tr.albumId) : undefined;
      const released = al?.released ?? (tr.album ? dates[tr.album] : undefined) ?? dates[tr.title];
      return releasedBy({ year: tr.year ?? al?.year, released }, cutoff);
    });
  return {
    ...p,
    topTracks: tracks(p.topTracks),
    albums: albums(p.albums),
    singles: albums(p.singles),
    appearsOn: albums(p.appearsOn),
    localAlbums: p.localAlbums && albums(p.localAlbums),
    localTracks: p.localTracks && tracks(p.localTracks),
  };
}
