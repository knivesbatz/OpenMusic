// App identity, the Settings → Services switches, sign-in state per provider and the user's
// collection (library + app playlists).
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, errorMessage, inTauri, setPartErrorHandler } from "../api";
import type { Album, AppInfo, Artist, AuthAll, AuthStatus, Library, Playlist, Podcast, Provider, ProviderError, Services, Track } from "../types";
import { PROVIDERS } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { localError, translate } from "../i18n";
import { useSettings } from "./settings";
import { navigate, toast } from "./ui";
import { loadFolders } from "./folders";
import { caps, refreshAllowed, serviceName, signedIn } from "./providers";
import { initSignIn, startSignIn } from "./signin";

interface AppStore {
  info: AppInfo | null;
  /** Settings → Services switches (store/providers.ts reads them). */
  services: Services;
  /** Sign-in state of each provider, whether its switch is on or not. */
  auth: AuthAll | null;
  /** Onboarded without a service ("Skip — local files only"), or every service was switched off
   * later: the Connect page doesn't show again. */
  localOnly: boolean;
  /** Each provider answered its last request (connection-changed, browser online events). */
  online: Record<Provider, boolean>;
  library: Library | null;
  libraryError: string | null;
  playlists: Playlist[];
  liked: Set<string>;
  /** Albums and artists saved to "Your Library" in this app. */
  saved: { albums: Album[]; artists: Artist[]; podcasts: Podcast[]; episodes: Track[] };
  /** Track ids downloaded for offline play (Plex): they stay playable while Plex is off. */
  downloaded: Set<string>;
  /** Whose profile picker is open: YouTube channels / brand accounts or Plex Home users. */
  profilePicker: Provider | null;
  /** Goes up whenever the switches change: pages keyed on it fetch again. */
  servicesEpoch: number;
  /** Startup read the switches, sign-ins and "local files only": the first screen can show. */
  ready: boolean;
}

const signedOut: AuthStatus = { signedIn: false, needsServer: false };

export const useApp = create<AppStore>(() => ({
  info: null,
  services: { youtube: false, plex: false },
  auth: null,
  localOnly: false,
  online: { youtube: true, plex: true },
  library: null,
  libraryError: null,
  playlists: [],
  liked: new Set(),
  saved: { albums: [], artists: [], podcasts: [], episodes: [] },
  downloaded: new Set(),
  profilePicker: null,
  servicesEpoch: 0,
  ready: false,
}));

const tr = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(useSettings.getState().language, k, v);

// ---- profile pickers ---------------------------------------------------------------------------

/** Pickers waiting for the one on screen (both providers signed in at once). */
let pickerQueue: Provider[] = [];

export function openProfilePicker(provider: Provider) {
  if (useApp.getState().profilePicker) {
    if (useApp.getState().profilePicker !== provider && !pickerQueue.includes(provider)) pickerQueue.push(provider);
    return;
  }
  useApp.setState({ profilePicker: provider });
}

export function closeProfilePicker() {
  const next = pickerQueue.shift() ?? null;
  useApp.setState({ profilePicker: next });
}

const profileKey = (p: Provider) => (p === "plex" ? "plex.profileChosen" : "yt.profileChosen");

/** After sign-in, ask once which profile to use when the account has several (YouTube channels
 * or Plex Home users). */
async function maybeAskProfile(p: Provider) {
  const s = useApp.getState();
  if (!s.services[p] || !signedIn(p)) return;
  const key = profileKey(p);
  if (await api.kvGet<boolean>(key).catch(() => true)) return;
  // The profile list can fail right after sign-in (server still connecting): try a few times.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const list = p === "plex" ? await api.plexHomeUsers() : await api.ytAccounts();
      if (list.length > 1) openProfilePicker(p);
      else await api.kvSet(key, true);
      return;
    } catch (e) {
      if (attempt === 2) api.logUiError(`profile list (${p}) failed: ${errorMessage(e)}`).catch(() => {});
      else await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---- services ------------------------------------------------------------------------------------

const cacheResets = new Set<() => void>();

/**
 * Register a UI cache to empty whenever a service is switched on or off (Home, search results,
 * Browse categories, stream URLs, song metadata). Returns the unregister function.
 */
export function registerCacheReset(fn: () => void): () => void {
  cacheResets.add(fn);
  return () => cacheResets.delete(fn);
}

const sameServices = (a: Services, b: Services) => a.youtube === b.youtube && a.plex === b.plex;

/** The switches the UI's caches and lists were last loaded for. */
let applied: Services | null = null;

/**
 * The switches changed (here or in the core): forget what the UI cached from the old set of
 * services, then load the library, likes and saved items again. Pages keyed on `servicesEpoch`
 * fetch again too. Call it once the core has the new switches (it answers from them).
 */
export function onServicesChanged(services: Services) {
  if (!sameServices(services, useApp.getState().services)) useApp.setState({ services: { ...services } });
  if (applied && sameServices(services, applied)) return;
  applied = { ...services };
  useApp.setState((s) => ({ servicesEpoch: s.servicesEpoch + 1 }));
  for (const fn of cacheResets) {
    try {
      fn();
    } catch {
      /* one broken cache must not stop the others */
    }
  }
  libraryInflight = null;
  refreshLibrary(false);
  refreshSaved();
  for (const p of PROVIDERS) if (services[p]) maybeAskProfile(p);
}

/** Settings → Services switch. Off keeps the sign-in and never asks anything (the self-test flips
 * every switch). Turning the last one off keeps the app open with local files. */
export async function setService(p: Provider, on: boolean) {
  const before = useApp.getState().services;
  const next = { ...before, [p]: on };
  // The switch moves at once; the pages reload once the core has the new switches.
  useApp.setState({ services: next });
  if (!next.youtube && !next.plex) await setLocalOnly(true);
  if (inTauri) {
    try {
      await api.servicesSet(next);
    } catch (e) {
      onServicesChanged(before);
      toast(localError(e));
      return;
    }
  }
  onServicesChanged(next);
}

/** The Connect page shows: no service on and the user never chose local files only. */
export const needsConnect = (s: Pick<AppStore, "services" | "localOnly">) => !s.services.youtube && !s.services.plex && !s.localOnly;

// ---- sign-in state ------------------------------------------------------------------------------

export async function refreshAuth(): Promise<AuthAll | null> {
  if (!inTauri) return useApp.getState().auth;
  const auth = await api.authStatus().catch(() => null);
  if (auth) useApp.setState({ auth });
  return auth;
}

/** Last "session expired" notice per provider, so a burst of failures shows it once. */
const expiredShown: Partial<Record<Provider, number>> = {};

/** A provider's session is gone and could not be repaired: say so for that provider only, with
 * a Sign in action. The rest of the app keeps working. */
export function sessionExpired(p: Provider) {
  useApp.setState((s) => (s.auth ? { auth: { ...s.auth, [p]: { ...s.auth[p], signedIn: false } } } : {}));
  const now = Date.now();
  if (now - (expiredShown[p] ?? 0) < 30_000) return;
  expiredShown[p] = now;
  toast(tr("authExpiredFor", { service: serviceName(p) }), undefined, {
    label: tr("signIn"),
    onClick: () => {
      navigate({ name: "settings" });
      void startSignIn(p, "settings");
    },
  });
}

function onPartErrors(errors: ProviderError[]) {
  for (const e of errors) if (e.code === "authExpired" && useApp.getState().services[e.provider]) sessionExpired(e.provider);
}

// ---- startup -------------------------------------------------------------------------------------

const NO_CAPS = { downloads: false, qualityControl: false, podcasts: false, crossfade: false, gapless: false, favorites: false };

/** Plain browser (UI development without Tauri). */
const browserInfo: AppInfo = {
  name: "OpenSpot",
  version: "dev",
  providers: {
    youtube: { ...NO_CAPS, podcasts: true, crossfade: true, gapless: true, favorites: true },
    plex: { ...NO_CAPS, downloads: true, qualityControl: true, crossfade: true, gapless: true, favorites: true },
  },
  services: { youtube: false, plex: false },
};

export async function boot() {
  if (!inTauri) {
    useApp.setState({ info: browserInfo, services: browserInfo.services, auth: { youtube: signedOut, plex: signedOut }, ready: true });
    return;
  }
  setPartErrorHandler(onPartErrors);
  const [info, auth] = await Promise.all([api.appInfo(), api.authStatus().catch(() => null)]);
  const localOnly = (await api.kvGet<boolean>("localOnly").catch(() => null)) ?? false;
  useApp.setState({ info, auth, localOnly, services: { ...info.services }, ready: true });
  applied = { ...info.services };
  // The switches can change from elsewhere (sign-in turns a service on, Plex sign-out turns it off).
  listen<Services>("services-changed", (e) => onServicesChanged(e.payload));
  document.title = info.name;
  if (info.safeMode === "auto") setTimeout(() => toast(tr("safeModeAuto")), 1500);
  // Started by "launch at startup": go straight into TV mode, fullscreen.
  if (await api.htpcLaunch().catch(() => false)) {
    useSettings.getState().set({ htpc: true });
    getCurrentWindow().setFullscreen(true).catch(() => {});
  }
  refreshPlaylists();
  refreshSaved();
  refreshDownloaded();
  refreshAllowed();
  loadFolders();
  listen("saved-changed", refreshSaved);
  listen("downloads-changed", refreshDownloaded);
  refreshLibrary(false);
  for (const p of PROVIDERS) maybeAskProfile(p);
  listen<{ provider?: Provider }>("auth-changed", async (e) => {
    await refreshAuth();
    libraryInflight = null;
    refreshLibrary(false);
    const p = e.payload?.provider;
    if (p) maybeAskProfile(p);
    else PROVIDERS.forEach(maybeAskProfile);
  });
  listen<{ provider?: Provider }>("auth-expired", (e) => {
    const p = e.payload?.provider;
    if (p === "youtube" || p === "plex") sessionExpired(p);
  });
  // A provider's part arrived after the merged answer had stopped waiting for it.
  listen("library-changed", () => {
    libraryInflight = null;
    refreshLibrary(false);
  });
  listen("liked-changed", onLikedChanged);
  useSettings.subscribe((s, prev) => {
    if (s.privateSession !== prev.privateSession) toast(translate(s.language, s.privateSession ? "privateSessionOn" : "privateSessionOff"));
  });
  listen("lastfm-auth-expired", () => toast(tr("lastfmExpired")));
  listen<{ provider?: Provider; online?: boolean }>("connection-changed", (e) => {
    const p = e.payload?.provider;
    if (p !== "youtube" && p !== "plex") return;
    useApp.setState((s) => ({ online: { ...s.online, [p]: e.payload.online !== false } }));
  });
  listen("playlists-changed", () => {
    refreshPlaylists();
    libraryInflight = null;
    refreshLibrary(false);
  });
  window.addEventListener("online", () => useApp.setState({ online: { youtube: true, plex: true } }));
  window.addEventListener("offline", () => useApp.setState({ online: { youtube: false, plex: false } }));
  initSignIn();
}

export async function setLocalOnly(v: boolean) {
  useApp.setState({ localOnly: v });
  if (inTauri) await api.kvSet("localOnly", v).catch(() => {});
}

// ---- collection ----------------------------------------------------------------------------------

let libraryInflight: Promise<void> | null = null;
/** The merged library of every provider that is on (one that fails is named in `library.errors`). */
export function refreshLibrary(refresh: boolean): Promise<void> {
  if (!inTauri) return Promise.resolve();
  if (libraryInflight && !refresh) return libraryInflight;
  const mine = api
    .library(refresh)
    .then((library) => {
      if (libraryInflight !== mine) return;
      useApp.setState({ library, libraryError: null });
      refreshLiked();
    })
    .catch((e) => {
      if (libraryInflight === mine) useApp.setState({ libraryError: localError(e) });
    })
    .finally(() => {
      if (libraryInflight === mine) libraryInflight = null;
    });
  libraryInflight = mine;
  return mine;
}

export async function refreshPlaylists() {
  if (!inTauri) return;
  try {
    useApp.setState({ playlists: await api.plList() });
  } catch {
    /* keep previous */
  }
}

/** A like fetch this slow ran into the core's wait for a service (60 s). */
const LIKED_SLOW_MS = 45_000;
let likedInflight: Promise<void> | null = null;
let likedAgain = false;
/** The last like fetch waited out a slow service, and was itself started by "liked-changed": that
 * service's late answer comes back as another "liked-changed", which must not start the next one. */
let likedEcho = false;

/** Like state comes from the providers that are on; failures keep what we have (e.g. offline).
 * Calls made while one is on its way share it, and one more fetch follows it. */
export function refreshLiked(fromEvent = false): Promise<void> {
  if (!inTauri) return Promise.resolve();
  if (likedInflight) {
    likedAgain = true;
    return likedInflight;
  }
  const started = Date.now();
  const mine = (async () => {
    if (!caps().favorites) return useApp.setState({ liked: new Set() });
    try {
      useApp.setState({ liked: new Set(await api.likedIds()) });
    } catch {
      /* keep previous */
    }
  })().finally(() => {
    likedEcho = fromEvent && Date.now() - started > LIKED_SLOW_MS;
    likedInflight = null;
    if (likedAgain) {
      likedAgain = false;
      void refreshLiked();
    }
  });
  likedInflight = mine;
  return mine;
}


/** A service's likes arrived after the merged answer stopped waiting: fetch them, unless this is
 * the echo of a fetch that this event started (that would loop for as long as the service stays slow). */
function onLikedChanged() {
  if (likedEcho && !likedInflight) {
    likedEcho = false;
    return;
  }
  void refreshLiked(true);
}

export async function refreshSaved() {
  if (!inTauri) return;
  try {
    const l = await api.savedList();
    useApp.setState({ saved: { albums: l.albums, artists: l.artists, podcasts: l.podcasts ?? [], episodes: l.episodes ?? [] } });
  } catch {
    /* keep previous */
  }
}

/** Finished downloads (they play from disk, also with Plex off). */
export async function refreshDownloaded() {
  if (!inTauri) return;
  try {
    const list = await api.downloadList();
    useApp.setState({ downloaded: new Set(list.filter((d) => d.status === "done").map((d) => d.track.id)) });
  } catch {
    /* no downloads on this platform */
  }
}

export const isSaved = (id: string) => {
  const s = useApp.getState().saved;
  return [s.albums, s.artists, s.podcasts, s.episodes].some((list) => list.some((a) => a.id === id));
};

/** Android/iOS build: no extra windows (mini player), no launch at startup, no folder picking. */
export const isMobileApp = () => {
  const p = useApp.getState().info?.platform;
  return p === "android" || p === "ios";
};
