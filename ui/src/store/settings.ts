import type { AlbumSortKey, ArtistSortKey, LibSort } from "./librarySort";
import { create } from "zustand";
import { api, inTauri } from "../api";

export type Quality = "auto" | "low" | "medium" | "high";
export type JpMode = "original" | "romaji" | "both";

export interface Settings {
  language: "en" | "ja";
  quality: Quality;
  crossfade: number; // seconds, 0-12
  gapless: boolean;
  automix: boolean;
  /** Keep playing similar songs when the queue ends (Spotify's Autoplay). Off by default. */
  autoplaySimilar: boolean;
  /** Desktop: the close button hides the window to the tray; music keeps playing. */
  closeToTray: boolean;
  /** Download new versions from GitHub in the background and install them on close (Windows). */
  autoUpdate: boolean;
  /** Desktop: show the playing song on the user's Discord profile (Rich Presence). */
  discordPresence: boolean;
  volume: number; // 0-1
  textScale: number; // 0.85 - 1.5
  reducedMotion: boolean;
  highContrast: boolean;
  jpMode: JpMode;
  /** Names in the UI language: MusicBrainz aliases for artists, translations of titles in other scripts. */
  translateNames: boolean;
  /** Show lyrics in another language with a translation under each line. */
  translateLyrics: boolean;
  /** Playlists "View as": Compact drops the artwork column. */
  compactTracks: boolean;
  /** Your Library → Albums / Artists "Sort by". */
  albumSort: LibSort<AlbumSortKey>;
  artistSort: LibSort<ArtistSortKey>;
  /** Scrobble to Last.fm once connected. Off by default (new key, so earlier "on" defaults reset). */
  lastfmScrobble: boolean;
  sidebarCollapsed: boolean;
  /** Widths (px) of the library sidebar and the right-hand panel, set by dragging their edges. */
  sidebarWidth: number;
  panelWidth: number;
  htpc: boolean;
}

export const defaults: Settings = {
  language: typeof navigator !== "undefined" && navigator.language.startsWith("ja") ? "ja" : "en",
  quality: "auto",
  crossfade: 0,
  gapless: true,
  automix: false,
  autoplaySimilar: false,
  closeToTray: false,
  autoUpdate: true,
  discordPresence: true,
  volume: 0.8,
  textScale: 1,
  reducedMotion: false,
  highContrast: false,
  jpMode: "original",
  translateNames: true,
  translateLyrics: true,
  compactTracks: false,
  albumSort: { key: "recent", desc: false },
  artistSort: { key: "recent", desc: false },
  lastfmScrobble: false,
  sidebarCollapsed: false,
  sidebarWidth: 300,
  panelWidth: 340,
  htpc: false,
};

interface Store extends Settings {
  loaded: boolean;
  load: () => Promise<void>;
  set: (patch: Partial<Settings>) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function sanitize(raw: Record<string, unknown>): Settings {
  const s = { ...defaults, ...(raw as Partial<Settings>) };
  s.crossfade = Math.max(0, Math.min(12, Math.round(Number(s.crossfade) || 0)));
  s.volume = Math.max(0, Math.min(1, Number(s.volume)));
  if (Number.isNaN(s.volume)) s.volume = defaults.volume;
  s.textScale = Math.max(0.85, Math.min(1.5, Number(s.textScale) || 1));
  if (!["auto", "low", "medium", "high"].includes(s.quality)) s.quality = "auto";
  if (!["en", "ja"].includes(s.language)) s.language = defaults.language;
  if (!["original", "romaji", "both"].includes(s.jpMode)) s.jpMode = "original";
  s.albumSort = libSort(s.albumSort, ["recent", "alpha", "artist", "year"]);
  s.artistSort = libSort(s.artistSort, ["recent", "alpha"]);
  s.sidebarWidth = clampWidth(s.sidebarWidth, SIDEBAR_W, 300);
  s.panelWidth = clampWidth(s.panelWidth, PANEL_W, 340);
  return s;
}

function libSort<K extends string>(v: unknown, keys: K[]): LibSort<K> {
  const o = (v ?? {}) as { key?: unknown; desc?: unknown };
  return { key: keys.includes(o.key as K) ? (o.key as K) : keys[0], desc: o.desc === true };
}

export const SIDEBAR_W = { min: 220, max: 520 };
export const PANEL_W = { min: 280, max: 600 };
export const clampWidth = (v: unknown, r: { min: number; max: number }, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(Math.max(r.min, Math.min(r.max, n))) : fallback;
};

function pick(s: Store): Settings {
  const out = {} as Settings;
  for (const k of Object.keys(defaults) as (keyof Settings)[]) (out as unknown as Record<string, unknown>)[k] = s[k];
  return out;
}

export const useSettings = create<Store>((set, get) => ({
  ...defaults,
  loaded: false,
  load: async () => {
    if (!inTauri) return set({ loaded: true });
    try {
      const raw = await api.settingsGet();
      set({ ...sanitize(raw), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  set: (patch) => {
    set(patch);
    clearTimeout(saveTimer);
    // Debounced persistence: dragging the volume slider must not hammer the database.
    saveTimer = setTimeout(() => {
      if (inTauri) api.settingsSet(pick(get())).catch(() => {});
    }, 400);
  },
}));
