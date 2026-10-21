// App identity, sign-in state and the user's collection (library + app playlists).
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, errorCode, errorMessage, inTauri } from "../api";
import type { Album, AppInfo, Artist, AuthStatus, Library, Playlist } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { translate } from "../i18n";
import { useSettings } from "./settings";
import { toast } from "./ui";

interface AppStore {
  info: AppInfo | null;
  auth: AuthStatus | null;
  /** User chose "Continue with local files only" on the sign-in page. */
  localOnly: boolean;
  online: boolean;
  library: Library | null;
  libraryError: string | null;
  playlists: Playlist[];
  liked: Set<string>;
  /** Albums and artists saved to "Your Library" in this app. */
  saved: { albums: Album[]; artists: Artist[] };
  /** YTSpot profile (channel) picker is open. */
  profilePicker: boolean;
}

export const useApp = create<AppStore>(() => ({
  info: null,
  auth: null,
  localOnly: false,
  online: true,
  library: null,
  libraryError: null,
  playlists: [],
  liked: new Set(),
  saved: { albums: [], artists: [] },
  profilePicker: false,
}));

export const openProfilePicker = () => useApp.setState({ profilePicker: true });
export const closeProfilePicker = () => useApp.setState({ profilePicker: false });

/** After sign-in, ask once which profile to use when the account has several (YouTube channels
 * or Plex Home users). */
async function maybeAskProfile() {
  const s = useApp.getState();
  if (!s.auth?.signedIn || s.auth.needsServer) return;
  const key = s.info?.flavor === "plex" ? "plex.profileChosen" : "yt.profileChosen";
  if (await api.kvGet<boolean>(key).catch(() => true)) return;
  try {
    const list = s.info?.flavor === "plex" ? await api.plexHomeUsers() : await api.ytAccounts();
    if (list.length > 1) openProfilePicker();
    else await api.kvSet(key, true);
  } catch {
    /* ask again next time */
  }
}

const browserInfo: AppInfo = {
  flavor: "plex",
  name: "PLEXSpot",
  version: "dev",
  capabilities: { downloads: true, qualityControl: true, podcasts: false, crossfade: true, gapless: true, favorites: true },
};

export async function boot() {
  if (!inTauri) {
    useApp.setState({ info: browserInfo, auth: { signedIn: false, needsServer: false } });
    return;
  }
  const [info, auth] = await Promise.all([api.appInfo(), api.authStatus().catch(() => null)]);
  const localOnly = (await api.kvGet<boolean>("localOnly").catch(() => null)) ?? false;
  useApp.setState({ info, auth, localOnly });
  document.title = info.name;
  if (info.safeMode === "auto") setTimeout(() => toast(translate(useSettings.getState().language, "safeModeAuto")), 1500);
  // Started by "launch at startup": go straight into TV mode, fullscreen.
  if (await api.htpcLaunch().catch(() => false)) {
    useSettings.getState().set({ htpc: true });
    getCurrentWindow().setFullscreen(true).catch(() => {});
  }
  refreshPlaylists();
  refreshSaved();
  listen("saved-changed", refreshSaved);
  if (auth?.signedIn && !auth.needsServer) refreshLibrary(false);
  maybeAskProfile();
  listen("auth-changed", async () => {
    const auth = await api.authStatus().catch(() => null);
    useApp.setState({ auth });
    if (auth?.signedIn && !auth.needsServer) refreshLibrary(false);
    maybeAskProfile();
  });
  listen("auth-expired", () => {
    useApp.setState((s) => ({ auth: s.auth ? { ...s.auth, signedIn: false } : s.auth }));
    toast("Your session expired. Please sign in again.");
  });
  listen("lastfm-auth-expired", () => toast(translate(useSettings.getState().language, "lastfmExpired")));
  listen<string>("connection-changed", (e) => useApp.setState({ online: e.payload === "online" }));
  listen("playlists-changed", () => {
    refreshPlaylists();
    refreshLibrary(false);
  });
  window.addEventListener("online", () => useApp.setState({ online: true }));
  window.addEventListener("offline", () => useApp.setState({ online: false }));
}

export async function setLocalOnly(v: boolean) {
  useApp.setState({ localOnly: v });
  if (inTauri) await api.kvSet("localOnly", v).catch(() => {});
}

let libraryInflight: Promise<void> | null = null;
export function refreshLibrary(refresh: boolean): Promise<void> {
  if (!inTauri) return Promise.resolve();
  if (libraryInflight && !refresh) return libraryInflight;
  libraryInflight = api
    .library(refresh)
    .then((library) => {
      useApp.setState({ library, libraryError: null });
      refreshLiked();
    })
    .catch((e) => {
      if (errorCode(e) === "offline") useApp.setState({ online: false });
      useApp.setState({ libraryError: errorMessage(e) });
    })
    .finally(() => (libraryInflight = null));
  return libraryInflight;
}

export async function refreshPlaylists() {
  if (!inTauri) return;
  try {
    useApp.setState({ playlists: await api.plList() });
  } catch {
    /* keep previous */
  }
}

/** Like state comes from the provider; failures keep what we have (e.g. offline). */
export async function refreshLiked() {
  if (!inTauri || !useApp.getState().info?.capabilities.favorites) return;
  try {
    useApp.setState({ liked: new Set(await api.likedIds()) });
  } catch {
    /* keep previous */
  }
}

export async function refreshSaved() {
  if (!inTauri) return;
  try {
    const l = await api.savedList();
    useApp.setState({ saved: { albums: l.albums, artists: l.artists } });
  } catch {
    /* keep previous */
  }
}

export const isSaved = (id: string) => {
  const s = useApp.getState().saved;
  return s.albums.some((a) => a.id === id) || s.artists.some((a) => a.id === id);
};

/** Android/iOS build: no extra windows (mini player), no launch at startup, no folder picking. */
export const isMobileApp = () => {
  const p = useApp.getState().info?.platform;
  return p === "android" || p === "ios";
};

