// Shared actions behind context menus and buttons, so every surface (track rows, queue, player bar,
// fullscreen, cards) offers the same behavior.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, inTauri } from "./api";
import { localError, translate, type Key } from "./i18n";
import * as P from "./player/engine";
import { isSaved, refreshLibrary, refreshPlaylists, refreshSaved, useApp } from "./store/app";
import { loadProfile, openExternal, useProfile } from "./store/profile";
import { allowed, capsOf, isOn, sourceOf } from "./store/providers";
import { useSettings } from "./store/settings";
import { confirmDialog, formDialog, navigate, pickDialog, promptDialog, toast, useUi, type MenuHead, type MenuItem } from "./store/ui";
import type { Album, Artist, Playlist, Podcast, Provider, Track, YtPrivacy } from "./types";
import { PROVIDERS } from "./types";
import { serviceLabel } from "./util";
import { duplicatesIn, uniqueSongs } from "./duplicates";
import { createFolder, deleteFolder, folderOf, putInFolder, renameFolder, takeOutOfFolder, useFolders, type Folder } from "./store/folders";
import * as I from "./components/Icons";
import { displayTrack } from "./store/songmeta";
import { listDownload, setCollectionDownload, useDownloadState } from "./components/common";

const t = (k: Key, v?: Record<string, string | number>) => translate(useSettings.getState().language, k, v);

// ---- services ------------------------------------------------------------------------------------
// Every "can I do this here?" question is asked per item: its id says which service it belongs to.

/** The service an item belongs to (YouTube Music or Plex); null for local files and app playlists. */
export function providerOfId(id: string | null | undefined): Provider | null {
  const s = sourceOf(id);
  return s === "youtube" || s === "plex" ? s : null;
}

/** Signed in to the service (for Plex: with a server chosen). Says nothing about its switch. */
export function signedInTo(p: Provider): boolean {
  const a = useApp.getState().auth?.[p];
  return !!a?.signedIn && !a.needsServer;
}

/** The service can answer: on, and for Plex signed in with a server (YouTube also works without
 * an account). */
export const usableProvider = (p: Provider) => isOn(p) && (p === "youtube" || signedInTo("plex"));

/** The services that can answer right now, YouTube first. */
export const usableProviders = (): Provider[] => PROVIDERS.filter(usableProvider);

/** Shown in the app: local files and app playlists always, a service's items while it is on. */
export function visibleId(id: string | null | undefined): boolean {
  const p = providerOfId(id);
  return !p || isOn(p) || allowed(id);
}

/** The service keeps likes for this account: on, signed in, with favorites. */
export const likesOn = (p: Provider) => isOn(p) && signedInTo(p) && !!capsOf(p).favorites;

/** Liked Songs exists: some service that is on keeps likes (YouTube's liked songs, Plex ratings). */
export const likedSongsAvailable = () => PROVIDERS.some(likesOn);

/** Plex downloads can be started (Plex on with a server; the files play from disk afterwards). */
export const plexDownloads = () => usableProvider("plex") && !!capsOf("plex").downloads;

/** This song can be downloaded: a Plex song while Plex downloads work, a YouTube song while YouTube
 * Music is on (or an artist override shows it). Downloads play from disk afterwards. */
export function downloadable(track: Track): boolean {
  if (track.source === "plex") return plexDownloads();
  if (track.source === "youtube") return !!capsOf("youtube").downloads && (isOn("youtube") || allowed(track.id));
  return false;
}

/** Some download can start for items of this provider (album and playlist menus). */
export const downloadsFor = (p: Provider | "local" | "app" | null) =>
  p === "plex" ? plexDownloads() : p === "youtube" ? isOn("youtube") && !!capsOf("youtube").downloads : plexDownloads() || (isOn("youtube") && !!capsOf("youtube").downloads);

/** Account settings on the service's own site. */
export function accountUrlOf(p: Provider): string {
  return p === "plex" ? "https://app.plex.tv/desktop/#!/settings/account" : "https://myaccount.google.com/";
}

export const openAccount = (p: Provider) => openExternal(accountUrlOf(p));

/** Sign out of one service, after asking (naming it). Plex switches itself off; YouTube stays on
 * without an account. The other service and the app's own data are untouched. */
export async function signOutOf(p: Provider) {
  const service = serviceLabel(p);
  if (!(await confirmDialog({ title: t("signOutOfService", { service }), body: t("signOutOfServiceBody", { service }), confirm: t("signOut") }))) return;
  try {
    await api.signOut(p);
  } catch (e) {
    return toast(localError(e));
  }
  await api.kvSet(p === "plex" ? "plex.profileChosen" : "yt.profileChosen", false).catch(() => {});
  useProfile.setState({ info: null });
  const auth = await api.authStatus().catch(() => null);
  if (auth) useApp.setState({ auth });
  loadProfile(true);
  refreshLibrary(true);
}

export async function createPlaylist(tracks: Track[] = []): Promise<Playlist | null> {
  const name = await promptDialog({
    title: t("newPlaylist"),
    body: "",
    confirm: t("save"),
    input: { label: t("playlistName"), value: tracks.length === 1 ? tracks[0].title : `${t("playlist")} #${useApp.getState().playlists.length + 1}` },
  });
  if (!name) return null;
  try {
    const pl = await api.plCreate(name, tracks);
    await refreshPlaylists();
    if (tracks.length) toast(t("addedToPlaylist", { name }));
    return pl;
  } catch (e) {
    toast(localError(e));
    return null;
  }
}

// ---- duplicates (Spotify's "Already added") -----------------------------------------------------

/**
 * Before songs go into a playlist (app or YouTube): when it holds some of them already, ask like
 * Spotify ("Already added": Add anyway / Don't add; some of them: Add all / Add new ones).
 * Returns the songs to add (each once: repeats within `tracks` are dropped), [] for none. Asks nothing when none of them is there (or when the
 * playlist can't be read: the add goes ahead as asked).
 */
export async function skipDuplicates(playlistId: string, name: string, tracks: Track[]): Promise<Track[]> {
  // A song twice in the batch (or its YouTube and Plex copies side by side) goes in once.
  tracks = uniqueSongs(tracks);
  if (!tracks.length) return tracks;
  let existing: Track[];
  try {
    existing = (await api.playlist(playlistId)).tracks;
  } catch {
    return tracks;
  }
  const dups = new Set(duplicatesIn(existing, tracks));
  if (!dups.size) return tracks;
  if (dups.size === tracks.length) {
    const body = t(tracks.length === 1 ? "alreadyInPlaylistOne" : "alreadyInPlaylistAll", { name });
    const pick = await pickDialog({ title: t("alreadyAdded"), body, cancel: t("addAnyway"), confirm: t("dontAdd") });
    return pick === false ? tracks : [];
  }
  const pick = await pickDialog({ title: t("someAlreadyAdded"), body: t("alreadyInPlaylistSome", { name }), cancel: t("addAllAnyway"), confirm: t("addNewOnes") });
  if (pick === null) return [];
  return pick ? tracks.filter((x) => !dups.has(x)) : tracks;
}

export async function addToPlaylist(pl: Playlist, tracks: Track[]) {
  const todo = await skipDuplicates(pl.id, pl.title, tracks);
  if (!todo.length) return;
  try {
    await api.plAdd(pl.id, todo);
    toast(t("addedToPlaylist", { name: pl.title }));
  } catch (e) {
    toast(localError(e));
  }
}

export function playlistSubmenu(tracks: Track[]): MenuItem[] {
  const pls = useApp.getState().playlists;
  const liked = canLike(tracks) ? [{ label: t("likedSongs"), icon: I.IHeart, onClick: () => likeTracks(tracks, true) }] : [];
  return [
    { label: t("newPlaylist"), icon: I.IPlus, onClick: () => createPlaylist(tracks) },
    ...liked,
    ...(pls.length ? [{ label: "", separator: true }] : []),
    ...pls.map((p) => ({ label: p.title, onClick: () => addToPlaylist(p, tracks) })),
  ];
}

export async function toggleLike(track: Track) {
  const liked = useApp.getState().liked;
  const on = !liked.has(track.id);
  const next = new Set(liked);
  if (on) next.add(track.id);
  else next.delete(track.id);
  useApp.setState({ liked: next });
  try {
    if (inTauri) await api.rate(track, on);
    toast(on ? t("like") : t("unlike"));
  } catch (e) {
    useApp.setState({ liked });
    toast(localError(e));
  }
}

// ---- Liked Songs (one song or many, like Spotify) ------------------------------------------------

/** The song's own service keeps likes for this account (the heart on a row or the player). */
export function canLikeTrack(x: Track): boolean {
  const p = providerOfId(x.id) ?? (x.source === "local" ? null : x.source);
  return !!p && likesOn(p);
}

/** Songs that can go into Liked Songs, in bulk (never local files or episodes). */
const likeable = (tracks: Track[]) => tracks.filter((x) => !x.episode && canLikeTrack(x));
/** Whether any of these songs can go into Liked Songs (each on its own service). */
export const canLike = (tracks: Track[]) => likeable(tracks).length > 0;

/** Add songs to (or remove them from) Liked Songs: a selection, an album or a whole playlist. */
export async function likeTracks(tracks: Track[], on: boolean) {
  const before = useApp.getState().liked;
  const todo = likeable(tracks).filter((x) => before.has(x.id) !== on);
  if (!todo.length) return on ? toast(t("alreadyLiked")) : undefined;
  if (todo.length === 1 && tracks.length === 1) return toggleLike(todo[0]);
  if (on && todo.length > 100 && !(await confirmDialog({ title: t("likedSongs"), body: t("likeManyWarn", { n: todo.length }), confirm: t("like") }))) return;
  const next = new Set(before);
  for (const x of todo) on ? next.add(x.id) : next.delete(x.id);
  useApp.setState({ liked: next });
  const failed: Track[] = [];
  // A few at a time: one request per song, and the provider shouldn't be flooded.
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map((x) => (inTauri ? api.rate(x, on) : Promise.resolve()).catch(() => void failed.push(x))));
  }
  if (failed.length) {
    const cur = new Set(useApp.getState().liked);
    for (const x of failed) on ? cur.delete(x.id) : cur.add(x.id);
    useApp.setState({ liked: cur });
  }
  const done = todo.length - failed.length;
  toast(failed.length ? t("someLikesFailed", { n: failed.length }) : t(on ? "addedToLiked" : "removedFromLiked", { n: done }));
}

/** Menu entries for the songs of an album, playlist or selection. */
function likeItems(tracks: Track[]): MenuItem[] {
  if (!canLike(tracks)) return [];
  const liked = useApp.getState().liked;
  const ok = likeable(tracks);
  const all = ok.every((x) => liked.has(x.id));
  if (ok.length === 1) return [{ label: all ? t("unlike") : t("like"), icon: all ? I.IHeartFill : I.IHeart, onClick: () => toggleLike(ok[0]) }];
  return [
    all
      ? { label: t("removeNFromLiked", { n: ok.length }), icon: I.IHeartFill, onClick: () => likeTracks(ok, false) }
      : { label: t("saveNToLiked", { n: ok.filter((x) => !liked.has(x.id)).length }), icon: I.IHeart, onClick: () => likeTracks(ok, true) },
  ];
}

/** "Add all to Liked Songs" for an album or playlist whose songs load on click. */
function likeAllItem(tracks: () => Promise<Track[]>, id: string): MenuItem[] {
  // App playlists can hold songs of either service; a service's own album or playlist needs it.
  const p = providerOfId(id);
  if (p ? !likesOn(p) : !likedSongsAvailable()) return [];
  return [{ label: t("saveAllToLiked"), icon: I.IHeart, onClick: async () => likeTracks(await tracks(), true) }];
}

/** Download songs for offline play: Plex songs from the server, YouTube songs through ytdl.ts.
 * Local files and songs of a service that is off are left out. */
export async function downloadTracks(tracks: Track[], collectionId?: string) {
  const eligible = tracks.filter(downloadable);
  if (!eligible.length) return toast(t("downloadsUnsupported"));
  // A playlist or album downloaded as a whole shows Spotify's green mark once its songs are here.
  if (collectionId) setCollectionDownload(collectionId, eligible.map((x) => x.id));
  if (eligible.length > 50 && !(await confirmDialog({ title: t("download"), body: t("downloadLargeWarn", { n: eligible.length }), confirm: t("download") })))
    return;
  const plex = eligible.filter((x) => x.source === "plex");
  const yt = eligible.filter((x) => x.source === "youtube");
  try {
    let n = plex.length ? await api.downloadTracks(plex) : 0;
    const queued = yt.length ? await api.ytDownloadQueue(yt) : [];
    n += queued.length;
    toast(t("downloadStarted", { n }));
    if (queued.length) {
      const { downloadYouTube } = await import("./ytdl");
      const failed = await downloadYouTube(queued);
      if (failed.length) toast(t("downloadsFailed", { n: failed.length }));
    }
  } catch (e) {
    toast(localError(e));
  }
}

/** Remove downloads (after Spotify's "Remove from Downloads?"); a playlist or album loses its mark. */
export async function removeDownloads(tracks: Track[], collectionId?: string) {
  if (!(await confirmDialog({ title: t("removeDownloadTitle"), body: t("removeDownloadBody"), confirm: t("removeDownload"), danger: true }))) return;
  if (collectionId) setCollectionDownload(collectionId, null);
  const done = useDownloadState.getState().done;
  const busy = useDownloadState.getState().busy;
  for (const x of tracks.filter((x) => done.has(x.id) || busy.has(x.id))) await api.downloadRemove(x.id).catch(() => {});
}

/** The menu entry for a list of songs: Download, or Remove download once they're all here. */
function downloadItem(tracks: () => Promise<Track[]>, collectionId?: string): MenuItem {
  const marked = collectionId && useDownloadState.getState().collections[collectionId];
  if (marked && listDownload(useDownloadState.getState(), marked) === "done")
    return { label: t("removeDownload"), icon: I.IDownloaded, onClick: async () => removeDownloads(await tracks(), collectionId) };
  return { label: t("download"), icon: I.IDownload, onClick: async () => downloadTracks(await tracks(), collectionId) };
}

export async function startRadio(track: Track) {
  try {
    const tracks = await api.radio(track);
    if (!tracks.length) return toast(t("empty"));
    P.playTracks([track, ...tracks.filter((x) => x.id !== track.id)], 0, { kind: "radio", id: track.id, title: track.title, artwork: track.artwork });
  } catch (e) {
    toast(localError(e));
  }
}

// ---- sleep timer -----------------------------------------------------------------------------

let sleepTimer: ReturnType<typeof setTimeout> | undefined;
let sleepUnsub: (() => void) | undefined;
/** When the sleep timer pauses: a time (ms), "track" for the end of the song, or null when off. */
export const useSleep = create<{ until: number | "track" | null }>(() => ({ until: null }));
export function setSleepTimer(minutes: number | "track" | null) {
  clearTimeout(sleepTimer);
  sleepUnsub?.();
  sleepUnsub = undefined;
  useSleep.setState({ until: minutes === null ? null : minutes === "track" ? "track" : Date.now() + minutes * 60_000 });
  if (minutes === null) return toast(t("sleepOff"));
  if (minutes === "track") {
    const uid = P.usePlayer.getState().queue.items[P.usePlayer.getState().queue.index]?.uid;
    sleepUnsub = P.usePlayer.subscribe((s) => {
      if (s.queue.items[s.queue.index]?.uid !== uid) {
        P.pause();
        sleepUnsub?.();
        sleepUnsub = undefined;
        useSleep.setState({ until: null });
      }
    });
    return toast(t("sleepEndOfTrack"));
  }
  sleepTimer = setTimeout(() => (P.pause(), useSleep.setState({ until: null })), minutes * 60_000);
  toast(t("sleepSet", { n: minutes }));
}

export function sleepSubmenu(): MenuItem[] {
  const until = useSleep.getState().until;
  return [
    { label: t("sleepTimer"), heading: true },
    ...[5, 15, 30, 45, 60].map((n) => ({ label: t("minutes", { n }), onClick: () => setSleepTimer(n) })),
    { label: t("sleepEndOfTrack"), checked: until === "track", onClick: () => setSleepTimer("track") },
    ...(until != null ? [{ label: "", separator: true }, { label: t("sleepOff"), onClick: () => setSleepTimer(null) }] : []),
  ];
}

export function shareSubmenu(track: Track): MenuItem[] {
  const items: MenuItem[] = [{ label: t("copyInfo"), icon: I.ICopy, onClick: () => copy(`${track.title} — ${track.artist}`) }];
  if (track.source === "youtube" && track.streamKey)
    items.push({ label: t("copyLink"), icon: I.ILink, onClick: () => copy(`https://music.youtube.com/watch?v=${track.streamKey}`) });
  return items;
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast(t("copied")),
    () => toast(t("errorGeneric")),
  );
}

export interface TrackMenuOpts {
  /** App playlist the track list belongs to, enables "Remove from this playlist". */
  playlistId?: string;
  onRemoveFromPlaylist?: () => void;
  /** Label for onRemoveFromPlaylist where the list isn't a playlist (listening history). */
  removeLabel?: string;
  queueUid?: string;
  selection?: Track[];
}

/** The top of a song's ••• sheet on phones: cover, title, artist. */
export const trackHead = (track: Track): MenuHead => {
  const d = displayTrack(track);
  return { title: d.title, sub: d.artist, art: d.artwork };
};

export function trackMenu(track: Track, o: TrackMenuOpts = {}): MenuItem[] {
  const sel = o.selection && o.selection.length > 1 ? o.selection : [track];
  const multi = sel.length > 1;
  const items: MenuItem[] = [
    { label: t("addToPlaylist"), icon: I.IPlus, submenu: playlistSubmenu(sel) },
  ];
  if (o.onRemoveFromPlaylist) items.push({ label: o.removeLabel ?? t("removeFromPlaylist"), icon: I.ITrash, onClick: o.onRemoveFromPlaylist });
  if (o.queueUid) items.push({ label: multi ? t("removeSelected", { n: sel.length }) : t("removeFromQueue"), icon: I.IMinusCircle, onClick: () => P.removeFromQueue([o.queueUid!]) });
  items.push(...likeItems(sel));
  items.push({ label: t("addToQueue"), icon: I.IQueueAdd, onClick: () => (P.addToQueue(sel), toast(t("addedToQueue"))) });
  items.push({ label: t("playNext"), icon: I.IPlayNext, onClick: () => P.addNext(sel) });
  items.push({ label: t("sleepTimer"), icon: I.IMoon, submenu: sleepSubmenu() });
  items.push({ label: "", separator: true });
  if (!multi && track.source === "youtube" && isOn("youtube")) items.push({ label: t("goToRadio"), icon: I.IRadio, onClick: () => startRadio(track) });
  if (!multi && track.artistId) items.push({ label: t("goToArtist"), icon: I.IUser, onClick: () => navigate({ name: "artist", id: track.artistId! }) });
  if (!multi && track.albumId) items.push({ label: t("goToAlbum"), icon: I.IDisc, onClick: () => navigate({ name: "album", id: track.albumId! }) });
  if (!multi) items.push({ label: t("viewCredits"), icon: I.IInfo, onClick: () => useUi.setState({ info: track }) });
  if (sel.length && sel.every((x) => useDownloadState.getState().done.has(x.id)))
    items.push({ label: t("removeDownload"), icon: I.IDownloaded, onClick: () => removeDownloads(sel) });
  else if (sel.some(downloadable)) items.push({ label: t("download"), icon: I.IDownload, onClick: () => downloadTracks(sel) });
  if (!multi) items.push({ label: t("share"), icon: I.IShare, submenu: shareSubmenu(track) });
  return items;
}

export async function newFolder(withPlaylist?: string): Promise<string | null> {
  const name = await promptDialog({ title: t("createFolder"), body: "", confirm: t("save"), input: { label: t("folderName"), value: t("newFolder") } });
  if (!name) return null;
  const id = createFolder(name);
  if (withPlaylist) putInFolder(withPlaylist, id);
  return id;
}

export function folderMenu(f: Folder): MenuItem[] {
  return [
    {
      label: t("renameFolder"),
      icon: I.IEdit,
      onClick: async () => {
        const name = await promptDialog({ title: t("renameFolder"), body: "", confirm: t("save"), input: { label: t("folderName"), value: f.name } });
        if (name) renameFolder(f.id, name);
      },
    },
    {
      label: t("deleteFolder"),
      icon: I.ITrash,
      danger: true,
      onClick: async () => {
        if (await confirmDialog({ title: t("deleteFolder"), body: t("deleteFolderBody", { name: f.name }), confirm: t("delete"), danger: true })) deleteFolder(f.id);
      },
    },
  ];
}

function moveToFolderSubmenu(pl: Playlist): MenuItem[] {
  const { folders } = useFolders.getState();
  const current = folderOf(pl.id);
  return [
    { label: t("newFolder"), icon: I.IPlus, onClick: () => newFolder(pl.id) },
    ...(folders.length ? [{ label: "", separator: true }] : []),
    ...folders.map((f) => ({ label: (current?.id === f.id ? "✓ " : "") + f.name, onClick: () => putInFolder(pl.id, f.id) })),
    ...(current ? [{ label: "", separator: true }, { label: t("removeFromFolder"), icon: I.IMinusCircle, onClick: () => takeOutOfFolder(pl.id) }] : []),
  ];
}

/** Whether the app can give this playlist its own cover: app playlists, and YouTube playlists
 * (an in-app cover only; YouTube keeps its thumbnail). */
export const canChangeCover = (pl: Playlist) => pl.local || (pl.id.startsWith("yt:") && !pl.id.startsWith("yt:MPSP") && isOn("youtube"));

/** Pick an image (file picker; works on desktop and Android), crop it square, shrink it and
 * store it as the playlist's cover. */
export function changeCover(pl: Playlist, onDone?: () => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = Math.min(640, side);
      canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
      if (!blob) throw new Error(t("errorGeneric"));
      await setCover(pl, Array.from(new Uint8Array(await blob.arrayBuffer())));
      onDone?.();
    } catch (e) {
      toast(localError(e));
    }
  };
  input.click();
}

async function setCover(pl: Playlist, image: number[] | null) {
  try {
    await api.plSetCover(pl.id, image);
    refreshPlaylists();
    toast(t(image ? "coverChanged" : "coverRemoved"));
  } catch (e) {
    toast(localError(e));
  }
}

export function playlistMenu(pl: Playlist, tracks?: () => Promise<Track[]>, onCoverChanged?: () => void): MenuItem[] {
  // Decided per playlist: YouTube actions on yt: playlists, downloads where Plex songs can be.
  const source = sourceOf(pl.id);
  const yt = source === "youtube";
  const items: MenuItem[] = [];
  if (tracks) {
    items.push({ label: t("addToQueue"), icon: I.IQueueAdd, onClick: async () => P.addToQueue(await tracks()) });
    items.push(...likeAllItem(tracks, pl.id));
    if (downloadsFor(pl.local ? null : source)) items.push(downloadItem(tracks, pl.id));
  }
  items.push({ label: t("moveToFolder"), icon: I.IFolder, submenu: moveToFolderSubmenu(pl) });
  if (pl.local) items.push({ label: t("editDetails"), icon: I.IEdit, onClick: () => renamePlaylist(pl) });
  if (canChangeCover(pl)) {
    items.push({ label: t("changeCover"), icon: I.IImage, onClick: () => changeCover(pl, onCoverChanged) });
    if (pl.artwork?.startsWith("art://local/cover-"))
      items.push({ label: t(pl.local ? "removeCover" : "restoreCover"), icon: I.IUndo, onClick: () => setCover(pl, null).then(() => onCoverChanged?.()) });
  }
  if (tracks) {
    items.push({
      label: t("exportPlaylist"),
      icon: I.IShare,
      submenu: [
        { label: t("exportTxt"), icon: I.IFile, onClick: async () => exportPlaylist(pl, await tracks(), "txt") },
        { label: t("exportCsv"), icon: I.IFile, onClick: async () => exportPlaylist(pl, await tracks(), "csv") },
        { label: t("copyAsText"), icon: I.ICopy, onClick: async () => copy(playlistText(await tracks())) },
      ],
    });
  }
  const ytAccount = isOn("youtube") && signedInTo("youtube");
  if (pl.local && ytAccount) items.push({ label: t("copyToYt"), icon: I.ICloudUp, onClick: () => copyToYouTube(pl) });
  const ytId = !pl.local && yt ? ytPlaylistId(pl.id) : null;
  if (pl.local || yt) items.push({ label: "", separator: true });
  if (pl.local) items.push({ label: t("delete"), icon: I.ITrash, danger: true, onClick: () => deletePlaylist(pl) });
  else if (yt) {
    if (ytId && ytAccount) items.push({ label: t("deleteFromYt"), icon: I.ITrash, danger: true, onClick: () => deleteFromYouTube(pl) });
    items.push({ label: t("hidePlaylist"), icon: I.IEyeOff, danger: true, onClick: () => hidePlaylist(pl) });
  }
  return items;
}

// ---- export ------------------------------------------------------------------------------------

/** One "Artist - Title" line per song: the plain-text format Soundiiz and TuneMyMusic import. */
export function playlistText(tracks: Track[]): string {
  return tracks.filter((x) => !x.episode).map((x) => (x.artist ? `${x.artist} - ${x.title}` : x.title)).join("\n") + "\n";
}

/** CSV with a header row (Title, Artist, Album), quoted as RFC 4180. */
export function playlistCsv(tracks: Track[]): string {
  const q = (s: string | null | undefined) => `"${(s ?? "").replace(/"/g, '""')}"`;
  const rows = tracks.filter((x) => !x.episode).map((x) => [q(x.title), q(x.artist), q(x.album)].join(","));
  return ["Title,Artist,Album", ...rows].join("\r\n") + "\r\n";
}

async function exportPlaylist(pl: Playlist, tracks: Track[], kind: "txt" | "csv") {
  const content = kind === "txt" ? playlistText(tracks) : playlistCsv(tracks);
  const name = `${pl.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "playlist"}.${kind}`;
  try {
    const path = inTauri ? await api.saveTextFile(name, content) : null;
    if (path) toast(t("exported", { n: tracks.length }));
  } catch {
    // No file dialog (Android): the text goes to the clipboard to paste into Soundiiz instead.
    copy(kind === "txt" ? content : playlistText(tracks));
  }
}

let copying = false;

/**
 * Copy an app playlist to the user's YouTube account as a new playlist. Songs from
 * elsewhere are matched on YouTube Music by the app; the ones it can't find are listed after.
 */
export async function copyToYouTube(pl: Playlist) {
  if (copying) return toast(t("ytCopyBusy"));
  const form = await formDialog({
    title: t("copyToYt"),
    body: t("ytCopyBody"),
    confirm: t("ytCopyGo"),
    input: { label: t("playlistName"), value: pl.title },
    choice: {
      label: t("ytVisibility"),
      value: "PRIVATE",
      options: [
        { value: "PRIVATE", label: t("ytPrivate") },
        { value: "UNLISTED", label: t("ytUnlisted") },
        { value: "PUBLIC", label: t("ytPublic") },
      ],
    },
  });
  if (!form) return;
  copying = true;
  let toastId = toast(t("ytCopyStarted"));
  const stop = await listen<{ done: number; total: number }>("yt-copy-progress", ({ payload }) => {
    toastId = toast(t("ytCopyProgress", payload), toastId);
  }).catch(() => () => {});
  try {
    const r = await api.ytCopyPlaylist(pl.id, form.value, form.choice as YtPrivacy);
    toast(t("ytCopied", { n: r.added }), toastId);
    refreshLibrary(false);
    const shown = r.missing.slice(0, 20).join("\n");
    const more = r.missing.length > 20 ? "\n" + t("andMore", { n: r.missing.length - 20 }) : "";
    const body = r.missing.length ? `${t("ytCopiedSome", { n: r.added, total: r.added + r.missing.length })}\n\n${shown}${more}` : t("ytCopiedAll", { n: r.added });
    if (await confirmDialog({ title: t("ytCopiedTitle"), body, confirm: t("openPlaylist") })) navigate({ name: "playlist", id: r.playlistId });
  } catch (e) {
    toast(localError(e), toastId);
  } finally {
    stop();
    copying = false;
  }
}

/** Save or remove an album/artist from "Your Library" (local to the app). Optimistic. */
export async function toggleSaved(
  item: { kind: "album"; v: Album } | { kind: "artist"; v: Artist } | { kind: "podcast"; v: Podcast } | { kind: "episode"; v: Track },
) {
  const on = !isSaved(item.v.id);
  const prev = useApp.getState().saved;
  const key = (item.kind + "s") as "albums" | "artists" | "podcasts" | "episodes";
  const list = prev[key] as { id: string }[];
  const next = { ...prev, [key]: on ? [item.v, ...list] : list.filter((a) => a.id !== item.v.id) };
  useApp.setState({ saved: next });
  try {
    if (inTauri)
      await (item.kind === "album"
        ? api.saveAlbum(item.v, on)
        : item.kind === "artist"
          ? api.saveArtist(item.v, on)
          : item.kind === "podcast"
            ? api.savePodcast(item.v, on)
            : api.saveEpisode(item.v, on));
    toast(on ? t("savedToLibrary") : t("removedFromLibrary"));
  } catch (e) {
    useApp.setState({ saved: prev });
    toast(localError(e));
    refreshSaved();
  }
}

export function podcastMenu(p: Podcast): MenuItem[] {
  const following = isSaved(p.id);
  return [
    { label: following ? t("unfollow") : t("follow"), icon: following ? I.IChecked : I.IAddCircle, onClick: () => toggleSaved({ kind: "podcast", v: p }) },
    { label: t("open"), icon: I.IOpen, onClick: () => navigate({ name: "playlist", id: p.id }) },
  ];
}

export function albumMenu(album: Album, tracks: () => Promise<Track[]>): MenuItem[] {
  const items: MenuItem[] = [
    { label: isSaved(album.id) ? t("removeFromLibrary") : t("saveToLibrary"), icon: isSaved(album.id) ? I.IChecked : I.IAddCircle, onClick: () => toggleSaved({ kind: "album", v: album }) },
    ...likeAllItem(tracks, album.id),
    { label: t("addToQueue"), icon: I.IQueueAdd, onClick: async () => P.addToQueue(await tracks()) },
    { label: t("addToPlaylist"), icon: I.IPlus, onClick: async () => createPlaylist(await tracks()) },
  ];
  if (album.artistId) items.push({ label: t("goToArtist"), icon: I.IUser, onClick: () => navigate({ name: "artist", id: album.artistId! }) });
  if ((sourceOf(album.id) === "plex" || sourceOf(album.id) === "youtube") && downloadsFor(sourceOf(album.id))) items.push(downloadItem(tracks, album.id));
  return items;
}

/** The ••• menu of Liked Songs (songs of every service, not a playlist of its own). */
export function likedMenu(tracks: Track[]): MenuItem[] {
  const pl: Playlist = { id: "liked", title: t("likedSongs"), local: false };
  const items: MenuItem[] = [{ label: t("addToQueue"), icon: I.IQueueAdd, onClick: () => P.addToQueue(tracks) }];
  if (tracks.some(downloadable)) items.push(downloadItem(async () => tracks, "liked"));
  items.push({
    label: t("exportPlaylist"),
    icon: I.IShare,
    submenu: [
      { label: t("exportTxt"), icon: I.IFile, onClick: () => exportPlaylist(pl, tracks, "txt") },
      { label: t("exportCsv"), icon: I.IFile, onClick: () => exportPlaylist(pl, tracks, "csv") },
      { label: t("copyAsText"), icon: I.ICopy, onClick: () => copy(playlistText(tracks)) },
    ],
  });
  return items;
}

export async function renamePlaylist(pl: Playlist) {
  const name = await promptDialog({ title: t("editDetails"), body: "", confirm: t("save"), input: { label: t("playlistName"), value: pl.title } });
  if (!name) return;
  try {
    await api.plUpdate(pl.id, name, pl.description ?? null);
    await refreshPlaylists();
  } catch (e) {
    toast(localError(e));
  }
}

export async function deletePlaylist(pl: Playlist) {
  if (!(await confirmDialog({ title: t("deletePlaylistTitle"), body: t("deletePlaylistBody", { name: pl.title }), confirm: t("delete"), danger: true }))) return;
  try {
    await api.plDelete(pl.id);
    await refreshPlaylists();
    navigate({ name: "home" }, true);
  } catch (e) {
    toast(localError(e));
  }
}

/** A user-made YouTube playlist's id ("PL…"); null for Liked Music, mixes and other built-in lists. */
export function ytPlaylistId(id: string): string | null {
  const m = /^yt:(?:VL)?(PL.+)$/.exec(id);
  return m ? m[1] : null;
}

/** Delete one of your own playlists from your YouTube account, after asking (yt: playlists only;
 * the core checks that the page lets you edit it). */
export async function deleteFromYouTube(pl: Playlist) {
  if (!(await confirmDialog({ title: t("deleteFromYtTitle"), body: t("deleteFromYtBody", { name: pl.title }), confirm: t("delete"), danger: true }))) return;
  try {
    await api.ytDeletePlaylist(pl.id);
    toast(t("deletedFromYt", { name: pl.title }));
    const cur = useUi.getState().stack[useUi.getState().pos];
    if (cur.name === "playlist" && cur.id === pl.id) navigate({ name: "home" }, true);
    await refreshLibrary(false);
  } catch (e) {
    toast(localError(e));
  }
}

/** Hide a YouTube playlist inside the app forever. Never touches the YouTube account. */
export async function hidePlaylist(pl: Playlist) {
  if (!(await confirmDialog({ title: t("hideWarnTitle"), body: t("hideWarnBody", { name: pl.title }), confirm: t("hide"), danger: true }))) return;
  try {
    await api.hidePlaylist(pl.id, pl.title);
    toast(t("hidden"));
    await refreshLibrary(false);
    navigate({ name: "home" }, true);
  } catch (e) {
    toast(localError(e));
  }
}

export function artistMenu(artist: Artist): MenuItem[] {
  return [{ label: isSaved(artist.id) ? t("unfollow") : t("follow"), icon: isSaved(artist.id) ? I.IChecked : I.IAddCircle, onClick: () => toggleSaved({ kind: "artist", v: artist }) }];
}
