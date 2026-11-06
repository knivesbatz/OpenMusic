// Which services are on, what they can do and where an item comes from. Foundation for OpenSpot:
// every "is this YouTube or Plex?" question goes through here instead of a per-app flavor.
import type { AuthAll, Capabilities, Provider, Track } from "../types";
import { PROVIDERS } from "../types";
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

/** The provider an item belongs to, or null for local files and app playlists. */
export function providerOf(id: string | null | undefined): Provider | null {
  const s = sourceOf(id);
  return s === "youtube" || s === "plex" ? s : null;
}

/** The service's name as shown in the UI (a product name: the same in every language). */
export const serviceName = (p: Provider) => (p === "youtube" ? "YouTube Music" : "Plex");

const NONE: Capabilities = { downloads: false, qualityControl: false, podcasts: false, crossfade: false, gapless: false, favorites: false };

/** The Settings switch for a provider (non-reactive read). */
export const isOn = (p: Provider) => !!useApp.getState().services?.[p];
export const ytOn = () => isOn("youtube");
export const plexOn = () => isOn("plex");
export const anyOn = () => ytOn() || plexOn();
/** Both services on: the UI shows source badges. */
export const bothOn = () => ytOn() && plexOn();
/** The providers whose switch is on, YouTube first. */
export const onProviders = (): Provider[] => PROVIDERS.filter(isOn);

/** Signed in to the provider (for Plex: with a server chosen). Says nothing about the switch. */
export function signedIn(p: Provider): boolean {
  const a = useApp.getState().auth?.[p];
  return !!a?.signedIn && !a.needsServer;
}

/** The provider can show something: on, and for Plex signed in with a server (YouTube also works
 * without an account). */
export const usable = (p: Provider) => isOn(p) && (p === "youtube" || signedIn("plex"));

type ReconnectState = { services: Partial<Record<Provider, boolean>> | null; auth: AuthAll | null; localOnly?: boolean };

/** No provider can show anything although one is on (e.g. only Plex is on and its sign-in or its
 * server is gone): like PLEXSpot 1.6.1, the app opens on the Connect page (Plex's server list, or
 * Sign in to Plex) instead of an empty app. Not before the sign-in state is known, and not after
 * "local files only" was chosen. */
export function reconnectNeeded(s: ReconnectState): boolean {
  if (!s.auth || s.localOnly) return false;
  const on = PROVIDERS.filter((p) => s.services?.[p]);
  const plexReady = !!s.auth.plex?.signedIn && !s.auth.plex.needsServer;
  return on.length > 0 && !on.some((p) => p === "youtube" || plexReady);
}
export const needsReconnect = () => reconnectNeeded(useApp.getState());
/** needsReconnect(), re-rendering when it changes. */
export const useNeedsReconnect = () => useApp(reconnectNeeded);

/** The provider answered its last request (connection-changed / browser online events). */
export const isOnline = (p: Provider) => useApp.getState().online?.[p] !== false;

/** Every provider that is on is unreachable: the offline pill shows. Nothing on: never. */
export function allOffline(): boolean {
  const on = onProviders();
  return on.length > 0 && on.every((p) => !isOnline(p));
}

/**
 * Can this track be played right now? Local files and app-only items always; YouTube tracks while
 * YouTube is on; Plex tracks while Plex is on with a server, or when downloaded (the file plays
 * from disk with Plex off).
 */
export function playable(t: Track | null | undefined): boolean {
  if (!t) return false;
  const s = sourceOf(t.id) ?? t.source;
  if (s === "youtube") return ytOn();
  if (s === "plex") return useApp.getState().downloaded.has(t.id) || (plexOn() && signedIn("plex"));
  return true;
}

/** What the app can do right now: a capability counts when any provider that is on has it. */
export function caps(): Capabilities {
  const s = useApp.getState();
  const out = { ...NONE };
  for (const p of PROVIDERS) {
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

/** What one item's provider can do; local files and app playlists can do nothing remote. */
export function capsFor(id: string | null | undefined): Capabilities {
  const p = providerOf(id);
  return p && isOn(p) ? capsOf(p) : NONE;
}

/** Reactive versions for components. */
export const useServices = () => useApp((s) => s.services);
export const useOn = (p: Provider) => useApp((s) => !!s.services?.[p]);
export const useBothOn = () => useApp((s) => !!s.services?.youtube && !!s.services?.plex);
/** caps(), re-rendering when the switches or the app info change. */
export function useCaps(): Capabilities {
  useApp((s) => s.services);
  useApp((s) => s.info);
  return caps();
}
/** The offline pill: every provider that is on is offline. */
export const useAllOffline = () =>
  useApp((s) => {
    const on = PROVIDERS.filter((p) => s.services?.[p]);
    return on.length > 0 && on.every((p) => s.online?.[p] === false);
  });
