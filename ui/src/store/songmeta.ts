// YouTube music videos come with 16:9 video thumbnails and sometimes the uploader as "artist".
// For display, such tracks are patched with their song counterpart's album art and official
// artist/album, looked up in batches (cached on disk by Rust). Track ids are never changed.
import { create } from "zustand";
import { api, inTauri } from "../api";
import type { SongMeta, Track } from "../types";

export const useSongMeta = create<{ map: Record<string, SongMeta | null> }>(() => ({ map: {} }));

const pending = new Set<string>();
const requested = new Set<string>();
const attempts = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** A YouTube track whose artwork is a video thumbnail rather than album art. */
export function needsSongMeta(t: Track | null | undefined): t is Track {
  return !!t && t.source === "youtube" && !!t.streamKey && !t.episode && (!t.artwork || t.artwork.includes("ytimg.com"));
}

function flush() {
  timer = undefined;
  const ids = [...pending].slice(0, 40);
  ids.forEach((id) => pending.delete(id));
  if (!ids.length) return;
  api.ytSongMeta(ids).then(
    (found) => {
      const map = { ...useSongMeta.getState().map };
      for (const id of ids) {
        if (found[id]) map[id] = found[id];
        else {
          // Not looked up this round (batch limit or a failed request): retry a few times.
          const n = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, n);
          if (n < 3) pending.add(id);
          else map[id] = null;
        }
      }
      useSongMeta.setState({ map });
      if (pending.size) timer = setTimeout(flush, 800);
    },
    () => ids.forEach((id) => requested.delete(id)),
  );
}

function request(id: string) {
  if (requested.has(id) || !inTauri) return;
  requested.add(id);
  pending.add(id);
  timer ??= setTimeout(flush, 150);
}

/** Pure: apply song metadata to a track for display. */
export function patchTrack(t: Track, m: SongMeta | null | undefined): Track {
  if (!m) return t;
  return {
    ...t,
    title: m.title || t.title,
    artwork: m.artwork ?? t.artwork,
    // Prefer the official artist only when the song counterpart names one.
    artist: m.artist ?? t.artist,
    artistId: m.artist ? m.artistId ?? t.artistId : t.artistId,
    album: t.album ?? m.album,
    albumId: t.albumId ?? m.albumId,
  };
}

/** Track with album art and official names when it is a YouTube music video. */
export function useDisplayTrack<T extends Track | null | undefined>(t: T): T {
  const id = needsSongMeta(t) ? t.streamKey! : null;
  const m = useSongMeta((s) => (id ? s.map[id] : undefined));
  if (!id || !t) return t;
  if (m === undefined) request(id);
  // null = looked up, nothing better than the original.
  return patchTrack(t, m) as T;
}

/** Non-hook variant for event handlers (mini player snapshot, media session). */
export function displayTrack(t: Track): Track {
  return needsSongMeta(t) ? patchTrack(t, useSongMeta.getState().map[t.streamKey!]) : t;
}
