// The Profile page's data: who is signed in (the YouTube channel when YouTube is on and signed in,
// otherwise the Plex account), the photo and name chosen in the app (kv "profile", app-only: the
// YouTube/Plex account is never changed), and the artists from your listening history.
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { api, errorMessage, inTauri } from "../api";
import { translate, type Key } from "../i18n";
import type { AuthAll, Provider, ProfileInfo, Services } from "../types";
import { refreshAuth, refreshLibrary, useApp } from "./app";
import { serviceName } from "./providers";
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

/** The account whose identity the app shows: YouTube when it is on and signed in, else Plex. */
export function identityProvider(services: Services, auth: AuthAll | null): Provider | null {
  if (services.youtube && auth?.youtube.signedIn) return "youtube";
  if (services.plex && auth?.plex.signedIn) return "plex";
  return null;
}

/** The name and picture to show: what was chosen in the app, else the account's. */
export function useMe(): { name: string; photo: string | null } {
  const custom = useProfile((s) => s.custom);
  const info = useProfile((s) => s.info);
  const account = useApp((s) => {
    const p = identityProvider(s.services, s.auth);
    return p ? s.auth?.[p].account : null;
  });
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
export function accountUrl(provider: Provider): string {
  return provider === "plex" ? "https://app.plex.tv/desktop/#!/settings/account" : "https://myaccount.google.com/";
}

export const SUPPORT_URL = "https://github.com/knivesbatz/OpenMusic/issues";

export function openExternal(url: string) {
  if (inTauri) openUrl(url).catch((e) => toast(errorMessage(e)));
  else window.open(url, "_blank", "noopener");
}

/** Sign out of one provider, after asking. Plex turns its switch off (it has nothing to show
 * without an account); YouTube stays on and plays without an account. */
export async function signOut(provider: Provider) {
  const t = (k: Key) => translate(lang(), k, { service: serviceName(provider) });
  if (!(await confirmDialog({ title: t("signOutOf"), body: t("signOutBodyFor"), confirm: t("signOut") }))) return;
  try {
    await api.signOut(provider);
  } catch (e) {
    toast(errorMessage(e));
    return;
  }
  await api.kvSet(provider === "youtube" ? "yt.profileChosen" : "plex.profileChosen", false).catch(() => {});
  useProfile.setState({ info: null });
  await refreshAuth();
  useApp.setState({ library: null });
  void refreshLibrary(true);
  void loadProfile(true);
}

// The shown identity follows the switches and sign-ins: load it again when they change (only
// once something asked for it).
useApp.subscribe((s, prev) => {
  if (s.services === prev.services && s.auth === prev.auth) return;
  if (identityProvider(s.services, s.auth) === identityProvider(prev.services, prev.auth) && s.auth === prev.auth) return;
  if (useProfile.getState().info || useProfile.getState().error) void loadProfile(true);
});
