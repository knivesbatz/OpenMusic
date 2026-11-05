// Which services are on, what they can do and where an item comes from. Foundation for OpenSpot:
// every "is this YouTube or Plex?" question goes through here instead of a per-app flavor.
import type { Capabilities, Provider } from "../types";
import { useApp } from "./app";

/** Where an item comes from, by its id prefix (always with the colon: `plex-genre:` is Plex too). */
export function sourceOf(id: string | null | undefined): Provider | "local" | "app" | null {
  if (!id) return null;
  if (id.startsWith("yt:")) return "youtube";
  if (id.startsWith("plex:") || id.startsWith("plex-genre:")) return "plex";
  if (id.startsWith("local")) return "local";
  if (id.startsWith("app:")) return "app";
  return null;
}

const NONE: Capabilities = { downloads: false, qualityControl: false, podcasts: false, crossfade: false, gapless: false, favorites: false };

/** The Settings switch for a provider (non-reactive read). */
export const isOn = (p: Provider) => !!useApp.getState().services?.[p];
export const ytOn = () => isOn("youtube");
export const plexOn = () => isOn("plex");
export const anyOn = () => ytOn() || plexOn();
/** Both services on: the UI shows source badges. */
export const bothOn = () => ytOn() && plexOn();

/** What the app can do right now: a capability counts when any provider that is on has it. */
export function caps(): Capabilities {
  const s = useApp.getState();
  const out = { ...NONE };
  for (const p of ["youtube", "plex"] as Provider[]) {
    if (!s.services?.[p]) continue;
    const c = s.info?.providers?.[p];
    if (!c) continue;
    for (const k of Object.keys(out) as (keyof Capabilities)[]) if (c[k]) (out as Record<string, boolean>)[k] = true;
  }
  out.discordPresence = !!s.info?.discordPresence;
  return out;
}

/** What one provider can do (for per-item gates such as Download on Plex items only). */
export function capsOf(p: Provider): Capabilities {
  return useApp.getState().info?.providers?.[p] ?? NONE;
}

/** Reactive versions for components. */
export const useServices = () => useApp((s) => s.services);
export const useOn = (p: Provider) => useApp((s) => !!s.services?.[p]);
export const useBothOn = () => useApp((s) => !!s.services?.youtube && !!s.services?.plex);
