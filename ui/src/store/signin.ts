// Signing in to YouTube Music and Plex, shared by the Connect page and the Settings → Services
// cards. The state lives here, not in a page, so a sign-in keeps going when the page that started
// it changes: Plex's PIN poll and server list, YouTube's login window, and an Android Plex sign-in
// that navigated this webview to plex.tv and came back (resumed at startup).
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, inTauri } from "../api";
import { translate } from "../i18n";
import type { PlexServer, Provider } from "../types";
import { PROVIDERS } from "../types";
import { isMobileApp, needsConnect, onServicesChanged, refreshAuth, setLocalOnly, setService, useApp } from "./app";
import { useSettings } from "./settings";
import { confirmDialog, navigate } from "./ui";

/** Where a sign-in was started: its progress and errors show there. */
export type SignInOrigin = "connect" | "settings";

export interface SignInFlow {
  /** Waiting: PIN approval, the login window, connecting to a server. */
  busy: boolean;
  error: string | null;
  /** Plex PIN shown while waiting for approval. */
  code: string | null;
  /** Plex servers to choose from (the last step of a Plex sign-in, or "Change server"). */
  servers: PlexServer[] | null;
  /** A sign-in is in progress (also while the server list waits for a choice). */
  active: boolean;
  origin: SignInOrigin | null;
}

const idle: SignInFlow = { busy: false, error: null, code: null, servers: null, active: false, origin: null };

export const useSignIn = create<Record<Provider, SignInFlow>>(() => ({ youtube: idle, plex: idle }));

const patch = (p: Provider, f: Partial<SignInFlow>) => useSignIn.setState((s) => ({ [p]: { ...s[p], ...f } }) as Partial<Record<Provider, SignInFlow>>);
const tr = (k: Parameters<typeof translate>[1]) => translate(useSettings.getState().language, k);

/** Android: the PIN of a Plex sign-in that left this webview for plex.tv. */
const PENDING_PIN = "plex.pendingPin";

/** A sign-in started on the Connect page is still going (e.g. the Plex server list): the page
 * stays up until it ends, even when a service turned on meanwhile. */
export const connectFlowActive = () => {
  const s = useSignIn.getState();
  return PROVIDERS.some((p) => s[p].active && s[p].origin === "connect");
};
export const useConnectFlowActive = () => useSignIn((s) => PROVIDERS.some((p) => s[p].active && s[p].origin === "connect"));

export function startSignIn(p: Provider, origin: SignInOrigin): Promise<void> {
  return p === "plex" ? signInPlex(origin) : signInYouTube(origin);
}

/** Stop waiting (the PIN poll ends at its next tick) and close the server list. */
export function cancelSignIn(p: Provider) {
  if (p === "plex") pinGen++;
  useSignIn.setState({ [p]: idle } as Partial<Record<Provider, SignInFlow>>);
}

async function signInPlex(origin: SignInOrigin) {
  if (!inTauri || useSignIn.getState().plex.busy) return;
  // Android signs in inside this webview: leaving for plex.tv unloads the page and the player.
  // (Imported here: the player imports the app store, which starts this module.)
  const { usePlayer } = await import("../player/engine");
  if (isMobileApp() && usePlayer.getState().playing) {
    const ok = await confirmDialog({ title: tr("signInPlex"), body: tr("plexSignInLeaves"), confirm: tr("continueAction") });
    if (!ok) return;
  }
  patch("plex", { ...idle, busy: true, active: true, origin });
  try {
    const pin = await api.plexPinStart();
    patch("plex", { code: pin.code });
    if (isMobileApp()) {
      // No second window on Android: sign in inside the app; Plex sends the webview back here
      // and initSignIn() picks the PIN up again.
      try {
        localStorage.setItem(PENDING_PIN, JSON.stringify({ id: pin.id, code: pin.code, origin }));
      } catch {
        /* storage unavailable: the user comes back with Back and signs in again */
      }
      location.href = pin.authUrl + "&forwardUrl=" + encodeURIComponent(location.href.split("#")[0]);
      return;
    }
    await openUrl(pin.authUrl);
    await waitForPin(pin.id);
  } catch (e) {
    patch("plex", { busy: false, active: false, error: errorMessage(e) });
  }
}

/** Poll the PIN until it is approved, then show the server list. */
/** Each PIN poll's number: a new sign-in or Cancel ends the older poll. */
let pinGen = 0;

async function waitForPin(id: number) {
  const gen = ++pinGen;
  const started = Date.now();
  try {
    while (Date.now() - started < 10 * 60_000) {
      await new Promise((r) => setTimeout(r, 2000));
      if (gen !== pinGen || !useSignIn.getState().plex.active) return; // cancelled or replaced
      if (await api.plexPinPoll(id)) {
        await refreshAuth();
        await loadServers();
        return;
      }
    }
    patch("plex", { busy: false, active: false, error: tr("signInTimeout") });
  } catch (e) {
    patch("plex", { busy: false, active: false, error: errorMessage(e) });
  }
}

/** Show the Plex server list: after the PIN, for a sign-in without a server, or "Change server". */
export async function loadServers(origin?: SignInOrigin) {
  if (!inTauri) return;
  patch("plex", { busy: true, error: null, active: true, ...(origin ? { origin } : {}) });
  try {
    patch("plex", { servers: await api.plexServers(), busy: false, code: null });
  } catch (e) {
    patch("plex", { busy: false, active: false, error: errorMessage(e) });
  }
}

/** The last step of a Plex sign-in: the core turns the Plex switch on. */
export async function pickServer(server: PlexServer) {
  patch("plex", { busy: true, error: null });
  try {
    await api.plexSelectServer(server.clientIdentifier);
    await refreshAuth();
    // The core emits services-changed too; apply it now so the app doesn't flash the Connect page.
    onServicesChanged({ ...useApp.getState().services, plex: true });
    cancelSignIn("plex");
  } catch (e) {
    patch("plex", { busy: false, error: errorMessage(e) });
  }
}

async function signInYouTube(origin: SignInOrigin) {
  if (!inTauri || useSignIn.getState().youtube.busy) return;
  patch("youtube", { ...idle, busy: true, active: true, origin });
  try {
    // Desktop opens a login window; Android navigates this webview. Either way login-done or
    // login-error follows (see initSignIn).
    await api.ytLogin();
  } catch (e) {
    patch("youtube", { busy: false, active: false, error: errorMessage(e) });
  }
}

/** "Use YouTube Music without an account": YouTube on, nobody signed in. */
export function continueWithoutAccount(): Promise<void> {
  return setService("youtube", true);
}

/** "Skip — local files only": the app opens with local files and app playlists; services can be
 * turned on later in Settings. */
export function skipToLocalFiles(): Promise<void> {
  return setLocalOnly(true);
}

let initialized = false;

/** Startup: listen for the YouTube login window, and finish an Android Plex sign-in that came
 * back from plex.tv (wherever the app opens). */
export function initSignIn() {
  if (!inTauri || initialized) return;
  initialized = true;
  listen("login-done", async () => {
    await refreshAuth();
    onServicesChanged({ ...useApp.getState().services, youtube: true });
    cancelSignIn("youtube");
  });
  listen<string>("login-error", (e) => patch("youtube", { busy: false, active: false, error: String(e.payload ?? "") }));
  let pending: { id: number; code: string; origin?: SignInOrigin } | null = null;
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_PIN) ?? "null");
    localStorage.removeItem(PENDING_PIN);
  } catch {
    /* storage unavailable */
  }
  if (!pending || typeof pending.id !== "number") return;
  // Back on the Connect page when nothing is set up yet; otherwise in Settings → Services, where
  // the Plex card shows the PIN and then the server list.
  const origin: SignInOrigin = needsConnect(useApp.getState()) ? "connect" : "settings";
  if (origin === "settings") navigate({ name: "settings" });
  patch("plex", { ...idle, busy: true, active: true, origin, code: pending.code ?? null });
  void waitForPin(pending.id);
}

/**
 * One provider's sign-in for a page: its state, plus the actions. `origin` says where this page
 * is, so a flow started elsewhere shows its progress there and not here.
 */
export function useProviderSignIn(p: Provider, origin: SignInOrigin) {
  const flow = useSignIn((s) => s[p]);
  const here = flow.origin === null || flow.origin === origin;
  return {
    ...flow,
    /** This page started the flow (or none is running): show its PIN, servers and errors here. */
    here,
    start: () => startSignIn(p, origin),
    cancel: () => cancelSignIn(p),
    pickServer,
    /** Plex: choose another server (also finishes a sign-in that has no server yet). */
    changeServer: () => loadServers(origin),
  };
}
