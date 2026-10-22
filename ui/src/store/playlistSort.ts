// Per-playlist sort order (Spotify's "Sort by"), kept in the app database until changed.
import { create } from "zustand";
import { api, inTauri } from "../api";
import type { Track } from "../types";

export type SortKey = "custom" | "title" | "artist" | "album" | "added" | "year" | "duration";
export interface PlSort {
  key: SortKey;
  desc: boolean;
}

const KV = "playlistSort";
export const usePlaylistSorts = create<{ map: Record<string, PlSort> }>(() => ({ map: {} }));

let loaded = false;
export function loadPlaylistSorts() {
  if (loaded || !inTauri) return;
  loaded = true;
  api.kvGet<Record<string, PlSort>>(KV).then((m) => m && usePlaylistSorts.setState({ map: m }), () => {});
}

export function setPlaylistSort(id: string, sort: PlSort) {
  const map = { ...usePlaylistSorts.getState().map };
  if (sort.key === "custom") delete map[id];
  else map[id] = sort;
  usePlaylistSorts.setState({ map });
  if (inTauri) api.kvSet(KV, map).catch(() => {});
}

export const usePlaylistSort = (id: string): PlSort => usePlaylistSorts((s) => s.map[id]) ?? { key: "custom", desc: false };

const text = (s: string | null | undefined) => (s ?? "").trim();
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * Tracks in the chosen order, each with its index in the playlist (for removing songs while
 * sorted). Stable: equal keys keep the playlist's own order. Missing values sort last.
 */
export function sortTracks(tracks: Track[], sort: PlSort): { track: Track; index: number }[] {
  const rows = tracks.map((track, index) => ({ track, index }));
  if (sort.key === "custom") return sort.desc ? rows.reverse() : rows;
  const val = (t: Track): string | number | null => {
    switch (sort.key) {
      case "title":
        return text(t.title) || null;
      case "artist":
        return text(t.artist) || null;
      case "album":
        return text(t.album) || null;
      case "added":
        return t.addedAt ?? null;
      case "year":
        return t.year ?? null;
      case "duration":
        return t.durationMs ?? null;
      default:
        return null;
    }
  };
  const dir = sort.desc ? -1 : 1;
  return rows.sort((a, b) => {
    const x = val(a.track);
    const y = val(b.track);
    if (x == null || y == null) return x == null && y == null ? a.index - b.index : x == null ? 1 : -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
    // Same artist/album: keep album order (track number), then the playlist's.
    if (c === 0 && (sort.key === "artist" || sort.key === "album")) {
      const al = collator.compare(text(a.track.album), text(b.track.album));
      if (al) return al;
      const tn = (a.track.trackNumber ?? 0) - (b.track.trackNumber ?? 0);
      return tn || a.index - b.index;
    }
    return c * dir || a.index - b.index;
  });
}
