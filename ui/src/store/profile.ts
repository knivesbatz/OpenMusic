// The Profile page's data: who is signed in (from the provider), the photo and name chosen in the
// app (kv "profile", app-only: the YouTube/Plex account is never changed), and the artists
// from your listening history.
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { api, errorMessage, inTauri } from "../api";
import { translate, type Key } from "../i18n";
import type { ProfileInfo } from "../types";
import { setLocalOnly, useApp } from "./app";
import { useSettings } from "./settings";
import { confirmDialog, toast } from "./ui";

export interface CustomProfile {
  name?: string | null;
  /** A small square JPEG as a data URL. */
  photo?: string | null;
}

interface ProfileState {
  info: ProfileInfo | null;
  error: string | null;
  custom: CustomProfile;
}

export const useProfile = create<ProfileState>(() => ({ info: null, error: null, custom: {} }));

let inflight: Promise<void> | null = null;
export function loadProfile(force = false): Promise<void> {
  if (!inTauri) return Promise.resolve();
  if (inflight && !force) return inflight;
  inflight = api
    .profileInfo()
    .then((info) => useProfile.setState({ info, error: null }))
    .catch((e) => useProfile.setState({ error: errorMessage(e) }))
    .finally(() => (inflight = null));
  return inflight;
}

export async function loadCustomProfile() {
  if (!inTauri) return;
  const c = await api.kvGet<CustomProfile>("profile").catch(() => null);
  if (c && typeof c === "object") useProfile.setState({ custom: c });
}

export async function saveCustomProfile(c: CustomProfile) {
  useProfile.setState({ custom: c });
  if (inTauri) await api.kvSet("profile", c);
}

/** The name and picture to show: what was chosen in the app, else the account's. */
export function useMe(): { name: string; photo: string | null } {
  const custom = useProfile((s) => s.custom);
  const info = useProfile((s) => s.info);
  const account = useApp((s) => s.auth?.account);
  return {
    name: custom.name?.trim() || info?.name || account || "",
    photo: custom.photo || info?.photo || null,
  };
}

/** Crop to a square and shrink, so the photo stays small in the app's settings. */
export async function pickPhoto(): Promise<string | null> {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
  if (!file) return null;
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(320, side);
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

const lang = () => useSettings.getState().language;

/** Account settings on the provider's own site. */
export function accountUrl(): string {
  return useApp.getState().info?.flavor === "plex" ? "https://app.plex.tv/desktop/#!/settings/account" : "https://myaccount.google.com/";
}

export const SUPPORT_URL = "https://github.com/knivesbatz/OpenMusic/issues";

export function openExternal(url: string) {
  if (inTauri) openUrl(url).catch((e) => toast(errorMessage(e)));
  else window.open(url, "_blank", "noopener");
}

export async function signOut() {
  const t = (k: Key) => translate(lang(), k);
  if (!(await confirmDialog({ title: t("signOut"), body: t("signOutBody"), confirm: t("signOut") }))) return;
  const yt = useApp.getState().info?.flavor === "youtube";
  await api.signOut().catch(() => {});
  await api.kvSet(yt ? "yt.profileChosen" : "plex.profileChosen", false).catch(() => {});
  await setLocalOnly(false);
  useProfile.setState({ info: null });
  useApp.setState({ auth: await api.authStatus(), library: null });
}
