// Updates from the latest GitHub release: checked at startup and every 6 hours. Windows downloads
// the installer in the background (Settings → Install updates automatically) and installs it when
// the app closes or on "Restart to update" (macOS likewise, from the disk image); Android offers
// the new APK. At startup, with nothing playing yet, a downloaded update installs right away.
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, inTauri } from "../api";
import { translate } from "../i18n";
import { usePlayer } from "../player/engine";
import { isMobileApp } from "./app";
import { useSettings } from "./settings";
import { toast } from "./ui";

export interface UpdateState {
  version: string | null;
  url: string | null;
  notes: string | null;
  /** "available": found (not downloaded); "downloading"; "ready": installs on restart/close. */
  status: "idle" | "checking" | "available" | "downloading" | "ready";
  dismissed: boolean;
}

export const useUpdate = create<UpdateState>(() => ({ version: null, url: null, notes: null, status: "idle", dismissed: false }));
const tr = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(useSettings.getState().language, k, v);

/** Android: the app's own installer (SelfUpdate.kt), when this build has it. */
const androidInstaller = () => (window as unknown as { OpenMusicMedia?: { installUpdate?: (url: string) => boolean } }).OpenMusicMedia?.installUpdate;

/** Older Android builds open the new APK in the browser. Windows, macOS and Android (with the
 * app's installer) download the update themselves and install it. */
export const updatesInBrowser = () => isMobileApp() && !androidInstaller();

export async function checkForUpdates(manual = false) {
  if (!inTauri) return;
  const s = useUpdate.getState();
  if (s.status === "checking" || s.status === "downloading") return;
  useUpdate.setState({ status: "checking" });
  try {
    const info = await api.updateCheck();
    if (!info.available || !info.url) {
      useUpdate.setState({ status: info.ready ? "ready" : "idle" });
      if (manual) toast(tr("upToDate", { v: info.current }));
      return;
    }
    useUpdate.setState({ version: info.version, url: info.url, notes: info.notes ?? null, status: info.ready ? "ready" : "available", dismissed: false });
    if (!info.ready && !isMobileApp() && useSettings.getState().autoUpdate) await downloadUpdate();
  } catch (e) {
    useUpdate.setState({ status: "idle" });
    if (manual) toast(errorMessage(e));
  }
}

export async function downloadUpdate() {
  const { url } = useUpdate.getState();
  if (!url) return;
  if (updatesInBrowser()) return void openUrl(url);
  if (isMobileApp()) {
    // Android downloads and installs in the background; the app closes when the update lands.
    if (!(window as unknown as { OpenMusicMedia: { installUpdate: (url: string) => boolean } }).OpenMusicMedia.installUpdate(url)) toast(tr("allowInstallUpdates"));
    else toast(tr("updatingAndroid", { v: useUpdate.getState().version ?? "" }));
    return;
  }
  useUpdate.setState({ status: "downloading" });
  try {
    await api.updateDownload(url);
    useUpdate.setState({ status: "ready", dismissed: false });
  } catch (e) {
    useUpdate.setState({ status: "available" });
    toast(errorMessage(e));
  }
}

export const restartToUpdate = () => api.updateRestart().catch((e) => toast(errorMessage(e)));

const STARTUP_WINDOW_MS = 10 * 60_000;
const startedAt = Date.now();

/** Startup: check right away; with "Install updates automatically" on, a new version downloads
 * and, while nothing is playing in the first minutes, installs and reopens the app. Once music
 * plays it waits for the app to close (or "Restart to update"). A version that was already tried
 * at a recent startup isn't tried again (so a failed install can't loop). */
export async function updateOnStart() {
  if (!inTauri || updatesInBrowser()) return;
  await checkForUpdates(false);
  const s = useUpdate.getState();
  // Android: "available" (the download happens in the installer); desktop: downloaded, "ready".
  const due = isMobileApp() ? s.status === "available" : s.status === "ready";
  if (!due || !s.version || !s.url || !useSettings.getState().autoUpdate) return;
  if (usePlayer.getState().playing || Date.now() - startedAt > STARTUP_WINDOW_MS) return;
  const tried = await api.kvGet<{ version: string; at: number }>("update.autoInstall").catch(() => null);
  if (tried && tried.version === s.version && Date.now() - tried.at < 6 * 3600_000) return;
  await api.kvSet("update.autoInstall", { version: s.version, at: Date.now() }).catch(() => {});
  if (isMobileApp()) return void downloadUpdate();
  toast(tr("updatingNow", { v: s.version }));
  await new Promise((r) => setTimeout(r, 1500));
  if (usePlayer.getState().playing) return;
  restartToUpdate();
}

export function initUpdates() {
  if (!inTauri) return;
  setTimeout(() => void updateOnStart(), 2000);
  setInterval(() => checkForUpdates(false), 6 * 3600_000);
}
