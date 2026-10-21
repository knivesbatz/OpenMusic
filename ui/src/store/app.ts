// App identity, sign-in state and the user's collection (library + app playlists).
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, errorCode, errorMessage, inTauri } from "../api";
import type { AppInfo, AuthStatus, Library, Playlist } from "../types";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
}));

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
  // Started by "launch at startup": go straight into TV mode, fullscreen.
  if (await api.htpcLaunch().catch(() => false)) {
    useSettings.getState().set({ htpc: true });
    getCurrentWindow().setFullscreen(true).catch(() => {});
  }
  refreshPlaylists();
  if (auth?.signedIn && !auth.needsServer) refreshLibrary(false);
  listen("auth-changed", async () => {
    const auth = await api.authStatus().catch(() => null);
    useApp.setState({ auth });
    if (auth?.signedIn && !auth.needsServer) refreshLibrary(false);
  });
  listen("auth-expired", () => {
    useApp.setState((s) => ({ auth: s.auth ? { ...s.auth, signedIn: false } : s.auth }));
    toast("Your session expired. Please sign in again.");
  });
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
    .then((library) => useApp.setState({ library, libraryError: null }))
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
