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
  autoplay: boolean;
  volume: number; // 0-1
  textScale: number; // 0.85 - 1.5
  reducedMotion: boolean;
  highContrast: boolean;
  jpMode: JpMode;
  scrobble: boolean;
  sidebarCollapsed: boolean;
  htpc: boolean;
}

export const defaults: Settings = {
  language: typeof navigator !== "undefined" && navigator.language.startsWith("ja") ? "ja" : "en",
  quality: "auto",
  crossfade: 0,
  gapless: true,
  automix: false,
  autoplay: true,
  volume: 0.8,
  textScale: 1,
  reducedMotion: false,
  highContrast: false,
  jpMode: "original",
  scrobble: true,
  sidebarCollapsed: false,
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
  return s;
}

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
