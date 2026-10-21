// Updates from the latest GitHub release: checked at startup and every 6 hours. Windows downloads
// the installer in the background (Settings → Install updates automatically) and installs it when
// the app closes or on "Restart to update"; Android offers the new APK.
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, inTauri } from "../api";
import { translate } from "../i18n";
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
  if (isMobileApp()) return void openUrl(url);
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

export function initUpdates() {
  if (!inTauri) return;
  setTimeout(() => checkForUpdates(false), 8000);
  setInterval(() => checkForUpdates(false), 6 * 3600_000);
}
