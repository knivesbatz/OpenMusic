// Playlist folders and custom library order (Your Library). Local to the app: kept in the app's
// key-value store, never written to Plex or YouTube. Pure helpers are unit-tested (folders.test.ts).
import { create } from "zustand";
import { api, inTauri } from "../api";

export interface Folder {
  id: string;
  name: string;
  /** Playlist ids, in custom order. */
  items: string[];
  open: boolean;
}

export type SortMode = "recent" | "alpha" | "custom";

export interface LibraryOrg {
  folders: Folder[];
  /** Top-level custom order: playlist ids and `folder:<id>`. Unknown entries go last. */
  order: string[];
  sort: SortMode;
}

export const emptyOrg: LibraryOrg = { folders: [], order: [], sort: "recent" };
export const folderKey = (id: string) => `folder:${id}`;

export const useFolders = create<LibraryOrg & { loaded: boolean }>(() => ({ ...emptyOrg, loaded: false }));

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { folders, order, sort } = useFolders.getState();
    if (inTauri) api.kvSet("libraryOrg", { folders, order, sort }).catch(() => {});
  }, 300);
}

export async function loadFolders() {
  if (!inTauri) return useFolders.setState({ loaded: true });
  try {
    const raw = await api.kvGet<LibraryOrg>("libraryOrg");
    useFolders.setState({ ...sanitizeOrg(raw), loaded: true });
  } catch {
    useFolders.setState({ loaded: true });
  }
}

export function sanitizeOrg(raw: Partial<LibraryOrg> | null | undefined): LibraryOrg {
  const folders = Array.isArray(raw?.folders)
    ? raw!.folders.filter((f) => f && typeof f.id === "string").map((f) => ({ id: f.id, name: String(f.name ?? ""), items: Array.isArray(f.items) ? f.items.filter((x) => typeof x === "string") : [], open: f.open !== false }))
    : [];
  const order = Array.isArray(raw?.order) ? raw!.order.filter((x) => typeof x === "string") : [];
  const sort: SortMode = raw?.sort === "alpha" || raw?.sort === "custom" ? raw.sort : "recent";
  return { folders, order, sort };
}

function update(fn: (o: LibraryOrg) => LibraryOrg) {
  const s = useFolders.getState();
  useFolders.setState(fn({ folders: s.folders, order: s.order, sort: s.sort }));
  persist();
}

// ---- pure operations ----------------------------------------------------------------------

/** Remove a playlist from every folder and from the top-level order. */
export function detach(o: LibraryOrg, id: string): LibraryOrg {
  return { ...o, folders: o.folders.map((f) => ({ ...f, items: f.items.filter((x) => x !== id) })), order: o.order.filter((x) => x !== id) };
}

/** Put a playlist into a folder, before `beforeId` (or at the end). */
export function moveIntoFolder(o: LibraryOrg, id: string, folderId: string, beforeId?: string): LibraryOrg {
  const d = detach(o, id);
  return {
    ...d,
    folders: d.folders.map((f) => {
      if (f.id !== folderId) return f;
      const at = beforeId ? f.items.indexOf(beforeId) : -1;
      const items = at >= 0 ? [...f.items.slice(0, at), id, ...f.items.slice(at)] : [...f.items, id];
      return { ...f, items, open: true };
    }),
  };
}

/**
 * Move a top-level entry (playlist id or `folder:<id>`) before `beforeKey` in the custom order
 * (or to the end). A playlist moved to the top level leaves its folder. `current` is the order
 * as displayed, so entries that were never ordered keep their visible position.
 */
export function moveTopLevel(o: LibraryOrg, key: string, beforeKey: string | null, current: string[]): LibraryOrg {
  const d = key.startsWith("folder:") ? o : detach(o, key);
  const base = current.filter((k) => k !== key);
  const at = beforeKey ? base.indexOf(beforeKey) : -1;
  const order = at >= 0 ? [...base.slice(0, at), key, ...base.slice(at)] : [...base, key];
  return { ...d, order, sort: "custom" };
}

/** Top-level keys in display order for the given sort mode. */
export function arrange(o: LibraryOrg, playlists: { id: string; title: string }[]): string[] {
  const inFolder = new Set(o.folders.flatMap((f) => f.items));
  const top = playlists.filter((p) => !inFolder.has(p.id)).map((p) => p.id);
  const keys = [...o.folders.map((f) => folderKey(f.id)), ...top];
  if (o.sort === "alpha") {
    const name = (k: string) => (k.startsWith("folder:") ? o.folders.find((f) => folderKey(f.id) === k)?.name : playlists.find((p) => p.id === k)?.title) ?? "";
    return keys.sort((a, b) => name(a).localeCompare(name(b)));
  }
  if (o.sort === "custom") {
    const pos = new Map(o.order.map((k, i) => [k, i]));
    // Entries never placed keep their recent order, after the placed ones.
    return keys
      .map((k, i) => ({ k, i }))
      .sort((a, b) => (pos.get(a.k) ?? 1e9 + a.i) - (pos.get(b.k) ?? 1e9 + b.i))
      .map((x) => x.k);
  }
  return keys;
}

// ---- actions --------------------------------------------------------------------------------

export function createFolder(name: string): string {
  const id = Math.random().toString(36).slice(2, 10);
  update((o) => ({ ...o, folders: [...o.folders, { id, name, items: [], open: true }] }));
  return id;
}
export const renameFolder = (id: string, name: string) => update((o) => ({ ...o, folders: o.folders.map((f) => (f.id === id ? { ...f, name } : f)) }));
/** Deleting a folder keeps its playlists (they return to the top level). */
export const deleteFolder = (id: string) =>
  update((o) => ({ ...o, folders: o.folders.filter((f) => f.id !== id), order: o.order.filter((k) => k !== folderKey(id)) }));
export const toggleFolder = (id: string) => update((o) => ({ ...o, folders: o.folders.map((f) => (f.id === id ? { ...f, open: !f.open } : f)) }));
export const putInFolder = (playlistId: string, folderId: string, beforeId?: string) => update((o) => moveIntoFolder(o, playlistId, folderId, beforeId));
export const takeOutOfFolder = (playlistId: string) => update((o) => detach(o, playlistId));
export const moveEntry = (key: string, beforeKey: string | null, current: string[]) => update((o) => moveTopLevel(o, key, beforeKey, current));
export const setSort = (sort: SortMode) => update((o) => ({ ...o, sort }));
export const folderOf = (playlistId: string) => useFolders.getState().folders.find((f) => f.items.includes(playlistId));
