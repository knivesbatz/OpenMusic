import type { Provider } from "./types";

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export const fmtMs = (ms?: number | null) => (ms ? fmtTime(ms / 1000) : "");

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export function totalDuration(tracks: { durationMs?: number | null }[]): number {
  return tracks.reduce((a, t) => a + (t.durationMs ?? 0), 0) / 1000;
}

export function cls(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}

/** Touch-first device (phones/tablets): taps play instead of selecting, no hover. */
export const isTouch = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;


/** A text field, where Space types a space. */
export function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file", "image"].includes(el.type);
}

/**
 * Space is the play/pause key and nothing else: it never presses the focused button, flips a
 * switch or picks a row (a clicked Next button kept focus, and Space skipped the song). Only text
 * fields keep it, for typing.
 */
export function spaceTogglesPlayback(e: KeyboardEvent): boolean {
  if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey) return false;
  return !isTextField(e.target instanceof Element ? e.target : null);
}

/** A service's name as shown in the UI (a product name: the same in every language). */
export const serviceLabel = (p: Provider) => (p === "youtube" ? "YouTube Music" : "Plex");

/** YouTube Music's own Liked Music playlist: shown as Liked Songs, never in playlist lists. */
export const isYtLiked = (id: string) => /^yt:(VL)?LM$/.test(id);

/** Window event for the F / Ctrl+F shortcut: a page with a "Search in playlist" box opens it and
 * calls preventDefault() on the event. */
export const FIND_EVENT = "openmusic:find-in-list";
