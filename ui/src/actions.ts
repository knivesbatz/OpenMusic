// Shared actions behind context menus and buttons, so every surface (track rows, queue, player bar,
// fullscreen, cards) offers the same behavior.
import { create } from "zustand";
import { api, errorMessage, inTauri } from "./api";
import { translate, type Key } from "./i18n";
import * as P from "./player/engine";
import { isSaved, refreshLibrary, refreshPlaylists, refreshSaved, useApp } from "./store/app";
import { useSettings } from "./store/settings";
import { confirmDialog, navigate, promptDialog, toast, useUi, type MenuItem } from "./store/ui";
import type { Album, Artist, Playlist, Podcast, Track } from "./types";
import { createFolder, deleteFolder, folderOf, putInFolder, renameFolder, takeOutOfFolder, useFolders, type Folder } from "./store/folders";
import * as I from "./components/Icons";

const t = (k: Key, v?: Record<string, string | number>) => translate(useSettings.getState().language, k, v);

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
    toast(errorMessage(e));
    return null;
  }
}

export async function addToPlaylist(pl: Playlist, tracks: Track[]) {
  try {
    await api.plAdd(pl.id, tracks);
    toast(t("addedToPlaylist", { name: pl.title }));
  } catch (e) {
    toast(errorMessage(e));
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
    toast(errorMessage(e));
  }
}

// ---- Liked Songs (one song or many, like Spotify) ------------------------------------------------

const likeable = (tracks: Track[]) => tracks.filter((x) => x.source !== "local" && !x.episode);
/** Whether any of these songs can go into Liked Songs on this provider. */
export const canLike = (tracks: Track[]) => !!useApp.getState().info?.capabilities.favorites && likeable(tracks).length > 0;

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
function likeAllItem(tracks: () => Promise<Track[]>): MenuItem[] {
  if (!useApp.getState().info?.capabilities.favorites) return [];
  return [{ label: t("saveAllToLiked"), icon: I.IHeart, onClick: async () => likeTracks(await tracks(), true) }];
}

export async function downloadTracks(tracks: Track[]) {
  const caps = useApp.getState().info?.capabilities;
  if (!caps?.downloads) return toast(t("downloadsUnsupported"));
  const eligible = tracks.filter((x) => x.source === "plex");
  if (!eligible.length) return;
  if (eligible.length > 50 && !(await confirmDialog({ title: t("download"), body: t("downloadLargeWarn", { n: eligible.length }), confirm: t("download") })))
    return;
  try {
    const n = await api.downloadTracks(eligible);
    toast(t("downloadStarted", { n }));
  } catch (e) {
    toast(errorMessage(e));
  }
}

export async function startRadio(track: Track) {
  try {
    const tracks = await api.radio(track);
    if (!tracks.length) return toast(t("empty"));
    P.playTracks([track, ...tracks.filter((x) => x.id !== track.id)], 0, { kind: "radio", id: track.id, title: track.title, artwork: track.artwork });
  } catch (e) {
    toast(errorMessage(e));
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
  queueUid?: string;
  selection?: Track[];
}

export function trackMenu(track: Track, o: TrackMenuOpts = {}): MenuItem[] {
  const sel = o.selection && o.selection.length > 1 ? o.selection : [track];
  const multi = sel.length > 1;
  const caps = useApp.getState().info?.capabilities;
  const items: MenuItem[] = [
    { label: t("addToPlaylist"), icon: I.IPlus, submenu: playlistSubmenu(sel) },
  ];
  if (o.onRemoveFromPlaylist) items.push({ label: t("removeFromPlaylist"), icon: I.ITrash, onClick: o.onRemoveFromPlaylist });
  if (o.queueUid) items.push({ label: multi ? t("removeSelected", { n: sel.length }) : t("removeFromQueue"), icon: I.IMinusCircle, onClick: () => P.removeFromQueue([o.queueUid!]) });
  if (caps?.favorites) items.push(...likeItems(sel));
  items.push({ label: t("addToQueue"), icon: I.IQueueAdd, onClick: () => (P.addToQueue(sel), toast(t("addedToQueue"))) });
  items.push({ label: t("playNext"), icon: I.IPlayNext, onClick: () => P.addNext(sel) });
  items.push({ label: t("sleepTimer"), icon: I.IMoon, submenu: sleepSubmenu() });
  items.push({ label: "", separator: true });
  if (!multi && track.source === "youtube") items.push({ label: t("goToRadio"), icon: I.IRadio, onClick: () => startRadio(track) });
  if (!multi && track.artistId) items.push({ label: t("goToArtist"), icon: I.IUser, onClick: () => navigate({ name: "artist", id: track.artistId! }) });
  if (!multi && track.albumId) items.push({ label: t("goToAlbum"), icon: I.IDisc, onClick: () => navigate({ name: "album", id: track.albumId! }) });
  if (!multi) items.push({ label: t("viewCredits"), icon: I.IInfo, onClick: () => useUi.setState({ info: track }) });
  if (caps?.downloads && sel.some((x) => x.source === "plex")) items.push({ label: t("download"), icon: I.IDownload, onClick: () => downloadTracks(sel) });
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
export const canChangeCover = (pl: Playlist) =>
  pl.local || (useApp.getState().info?.flavor === "youtube" && pl.id.startsWith("yt:") && !pl.id.startsWith("yt:MPSP"));

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
      toast(errorMessage(e));
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
    toast(errorMessage(e));
  }
}

export function playlistMenu(pl: Playlist, tracks?: () => Promise<Track[]>, onCoverChanged?: () => void): MenuItem[] {
  const flavor = useApp.getState().info?.flavor;
  const items: MenuItem[] = [];
  if (tracks) {
    items.push({ label: t("addToQueue"), icon: I.IQueueAdd, onClick: async () => P.addToQueue(await tracks()) });
    items.push(...likeAllItem(tracks));
    if (useApp.getState().info?.capabilities.downloads)
      items.push({ label: t("download"), icon: I.IDownload, onClick: async () => downloadTracks(await tracks()) });
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
  if (pl.local || flavor === "youtube") items.push({ label: "", separator: true });
  if (pl.local) items.push({ label: t("delete"), icon: I.ITrash, danger: true, onClick: () => deletePlaylist(pl) });
  else if (flavor === "youtube") items.push({ label: t("hidePlaylist"), icon: I.IEyeOff, danger: true, onClick: () => hidePlaylist(pl) });
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
    toast(errorMessage(e));
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
    ...likeAllItem(tracks),
    { label: t("addToQueue"), icon: I.IQueueAdd, onClick: async () => P.addToQueue(await tracks()) },
    { label: t("addToPlaylist"), icon: I.IPlus, onClick: async () => createPlaylist(await tracks()) },
  ];
  if (album.artistId) items.push({ label: t("goToArtist"), icon: I.IUser, onClick: () => navigate({ name: "artist", id: album.artistId! }) });
  if (useApp.getState().info?.capabilities.downloads) items.push({ label: t("download"), icon: I.IDownload, onClick: async () => downloadTracks(await tracks()) });
  return items;
}

export async function renamePlaylist(pl: Playlist) {
  const name = await promptDialog({ title: t("editDetails"), body: "", confirm: t("save"), input: { label: t("playlistName"), value: pl.title } });
  if (!name) return;
  try {
    await api.plUpdate(pl.id, name, pl.description ?? null);
    await refreshPlaylists();
  } catch (e) {
    toast(errorMessage(e));
  }
}

export async function deletePlaylist(pl: Playlist) {
  if (!(await confirmDialog({ title: t("deletePlaylistTitle"), body: t("deletePlaylistBody", { name: pl.title }), confirm: t("delete"), danger: true }))) return;
  try {
    await api.plDelete(pl.id);
    await refreshPlaylists();
    navigate({ name: "home" }, true);
  } catch (e) {
    toast(errorMessage(e));
  }
}

/** YTSpot: hide a remote playlist inside the app forever. Never touches the YouTube account. */
export async function hidePlaylist(pl: Playlist) {
  if (!(await confirmDialog({ title: t("hideWarnTitle"), body: t("hideWarnBody", { name: pl.title }), confirm: t("hide"), danger: true }))) return;
  try {
    await api.hidePlaylist(pl.id, pl.title);
    toast(t("hidden"));
    await refreshLibrary(false);
    navigate({ name: "home" }, true);
  } catch (e) {
    toast(errorMessage(e));
  }
}

export function artistMenu(artist: Artist): MenuItem[] {
  return [{ label: isSaved(artist.id) ? t("unfollow") : t("follow"), icon: isSaved(artist.id) ? I.IChecked : I.IAddCircle, onClick: () => toggleSaved({ kind: "artist", v: artist }) }];
}
