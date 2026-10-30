// Navigation history, toasts, dialogs and context menus.
import type { ComponentType } from "react";
import { create } from "zustand";
import type { Track } from "../types";

/** Library collections, in the classic Spotify "Your Library" order. */
export type LibraryTab = "recent" | "playlists" | "albums" | "artists" | "podcasts";

export type Route =
  | { name: "home" }
  | { name: "search"; q?: string }
  | { name: "library"; tab?: LibraryTab }
  | { name: "artist"; id: string }
  | { name: "album"; id: string }
  | { name: "playlist"; id: string }
  | { name: "liked" }
  | { name: "episodes" }
  | { name: "new" }
  | { name: "history" }
  | { name: "local" }
  | { name: "downloads" }
  | { name: "import" }
  | { name: "settings" };

interface Toast {
  id: number;
  text: string;
}

export interface MenuItem {
  label: string;
  /** An icon from components/Icons, shown before the label. */
  icon?: ComponentType<{ size?: number }>;
  onClick?: () => void;
  submenu?: MenuItem[];
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** A small section title ("Sort by"), not clickable. */
  heading?: boolean;
  /** Selected option: shown green with a mark on the right (or `hint` in its place). */
  checked?: boolean;
  /** Text on the right, e.g. a sort direction arrow. */
  hint?: string;
}

interface Dialog {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  input?: { label: string; value: string };
  resolve: (ok: boolean, value?: string) => void;
}

interface UiState {
  stack: Route[];
  pos: number;
  queueOpen: boolean;
  /** Desktop: lyrics in the right-hand panel (instead of the queue). */
  lyricsPanel: boolean;
  lyricsOpen: boolean;
  fullscreen: boolean;
  toasts: Toast[];
  menu: { x: number; y: number; items: MenuItem[] } | null;
  dialog: Dialog | null;
  /** Tracks for the "View credits" style info dialog. */
  info: Track | null;
  /** The page's own name and play action, shown in the top bar once the page has scrolled. */
  pageTitle: { title: string; play?: () => void } | null;
  /** The "Saved in" panel (Liked Songs and playlists with checkboxes), anchored at a button. */
  savedIn: { x: number; y: number; track: Track } | null;
  /** How far the main view is scrolled: 0 top, 1 moved (solid top bar), 2 past the page header (title in the bar). */
  scrolled: 0 | 1 | 2;
}

export const useUi = create<UiState>(() => ({
  stack: [{ name: "home" }],
  pos: 0,
  queueOpen: false,
  lyricsPanel: false,
  lyricsOpen: false,
  fullscreen: false,
  toasts: [],
  menu: null,
  dialog: null,
  info: null,
  pageTitle: null,
  savedIn: null,
  scrolled: 0,
}));

export const route = () => {
  const s = useUi.getState();
  return s.stack[s.pos];
};

export function navigate(r: Route, replace = false) {
  const s = useUi.getState();
  const cur = s.stack[s.pos];
  if (JSON.stringify(cur) === JSON.stringify(r)) return;
  if (replace) {
    const stack = s.stack.slice();
    stack[s.pos] = r;
    useUi.setState({ stack });
  } else {
    const stack = [...s.stack.slice(Math.max(0, s.pos - 49), s.pos + 1), r];
    useUi.setState({ stack, pos: stack.length - 1 });
  }
}

export const back = () => useUi.setState((s) => ({ pos: Math.max(0, s.pos - 1) }));
export const forward = () => useUi.setState((s) => ({ pos: Math.min(s.stack.length - 1, s.pos + 1) }));

let toastId = 0;
export function toast(text: string) {
  const id = ++toastId;
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, text }] }));
  setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
}

export function openMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  useUi.setState({ menu: { x: e.clientX, y: e.clientY, items } });
}

export const closeMenu = () => useUi.setState({ menu: null });

export function confirmDialog(opts: Omit<Dialog, "resolve" | "input">): Promise<boolean> {
  return new Promise((resolve) => useUi.setState({ dialog: { ...opts, resolve: (ok) => resolve(ok) } }));
}

export function promptDialog(opts: Omit<Dialog, "resolve">): Promise<string | null> {
  return new Promise((resolve) =>
    useUi.setState({ dialog: { ...opts, resolve: (ok, v) => resolve(ok ? (v ?? "").trim() || null : null) } }),
  );
}
