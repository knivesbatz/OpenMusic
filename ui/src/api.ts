import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type * as T from "./types";

/** True when running inside Tauri (false in a plain browser during UI development). */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function call<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  return invoke<R>(cmd, args);
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as T.ApiError).message);
  return String(e);
}

export function errorCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) return String((e as T.ApiError).code);
  return undefined;
}

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** Resolve an `art://…` reference to a URL the webview can load (served by the Rust art cache). */
export function artUrl(ref: string | null | undefined, size = 300): string | undefined {
  if (!ref) return undefined;
  if (!ref.startsWith("art://")) return ref;
  const rest = ref.slice("art://".length);
  const base = isWindows ? "http://art.localhost/" : "art://localhost/";
  const sep = rest.includes("?") ? "&" : "?";
  return base + rest + sep + "s=" + size;
}

export const fileUrl = (path: string) => convertFileSrc(path);

export const api = {
  appInfo: () => call<T.AppInfo>("app_info"),
  settingsGet: () => call<Record<string, unknown>>("settings_get"),
  settingsSet: (settings: unknown) => call<void>("settings_set", { settings }),
  kvGet: <V>(key: string) => call<V | null>("kv_get", { key }),
  kvSet: (key: string, value: unknown) => call<void>("kv_set", { key, value }),

  authStatus: () => call<T.AuthStatus>("auth_status"),
  plexPinStart: () => call<{ id: number; code: string; authUrl: string }>("plex_pin_start"),
  plexPinPoll: (id: number) => call<boolean>("plex_pin_poll", { id }),
  plexServers: () => call<T.PlexServer[]>("plex_servers"),
  plexSelectServer: (clientIdentifier: string) => call<string>("plex_select_server", { clientIdentifier }),
  plexReconnect: () => call<void>("plex_reconnect_cmd"),
  ytLogin: () => call<void>("yt_login"),
  signOut: () => call<void>("sign_out"),

  home: (refresh: boolean) => call<T.HomeData>("home", { refresh }),
  search: (query: string) => call<T.SearchResults>("search", { query }),
  artist: (id: string) => call<T.ArtistPage>("artist", { id }),
  album: (id: string) => call<T.AlbumPage>("album", { id }),
  playlist: (id: string) => call<T.PlaylistPage>("playlist", { id }),
  library: (refresh: boolean) => call<T.Library>("library", { refresh }),
  radio: (track: T.Track) => call<T.Track[]>("radio", { track }),

  resolveStream: (track: T.Track, quality: string) => call<T.Stream>("resolve_stream", { track, quality }),
  recordPlay: (track: T.Track, context: T.PlayContext | null) => call<void>("record_play", { track, context }),
  markPlayed: (track: T.Track) => call<void>("mark_played", { track }),
  rate: (track: T.Track, liked: boolean) => call<void>("rate", { track, liked }),
  likedIds: () => call<string[]>("liked_ids"),
  savedList: () => call<T.Library>("saved_list"),
  saveAlbum: (album: T.Album, saved: boolean) => call<void>("save_album", { album, saved }),
  saveArtist: (artist: T.Artist, saved: boolean) => call<void>("save_artist", { artist, saved }),
  queueSave: (queue: unknown) => call<void>("queue_save", { queue }),
  queueLoad: () => call<unknown | null>("queue_load"),
  lyrics: (track: T.Track) => call<T.Lyrics | null>("get_lyrics", { track }),

  plList: () => call<T.Playlist[]>("pl_list"),
  plCreate: (name: string, tracks?: T.Track[]) => call<T.Playlist>("pl_create", { name, tracks }),
  plUpdate: (id: string, name: string, description?: string | null) => call<void>("pl_update", { id, name, description }),
  plDelete: (id: string) => call<void>("pl_delete", { id }),
  plAdd: (id: string, tracks: T.Track[]) => call<number>("pl_add", { id, tracks }),
  plReorder: (id: string, order: number[]) => call<void>("pl_reorder", { id, order }),
  hidePlaylist: (id: string, title: string) => call<void>("hide_playlist", { id, title }),

  localFolders: () => call<string[]>("local_folders"),
  localAddFolder: (path: string) => call<T.ScanReport>("local_add_folder", { path }),
  localRemoveFolder: (path: string) => call<T.ScanReport>("local_remove_folder", { path }),
  localScan: () => call<T.ScanReport>("local_scan"),
  localLibrary: () => call<{ tracks: T.Track[]; albums: T.Album[]; artists: T.Artist[] }>("local_library"),

  lastfmStatus: () => call<T.LastFmStatus>("lastfm_status"),
  lastfmSetKeys: (apiKey: string, secret: string) => call<void>("lastfm_set_keys", { apiKey, secret }),
  lastfmConnectStart: () => call<string>("lastfm_connect_start"),
  lastfmConnectFinish: (token: string) => call<string>("lastfm_connect_finish", { token }),
  lastfmDisconnect: () => call<void>("lastfm_disconnect"),
  lastfmNowPlaying: (track: T.Track) => call<void>("lastfm_now_playing", { track }),
  lastfmScrobble: (track: T.Track, startedAt: number) => call<boolean>("lastfm_scrobble", { track, startedAt }),

  spotifyStatus: () => call<string | null>("spotify_status"),
  spotifyConnect: (clientId: string) => call<void>("spotify_connect", { clientId }),
  spotifyDisconnect: () => call<void>("spotify_disconnect"),
  spotifyPlaylists: () => call<T.SpotifyPlaylist[]>("spotify_playlists"),
  spotifyImport: (playlistId: string, name: string) => call<T.ImportReport>("spotify_import", { playlistId, name }),
  importConfirm: (playlistId: string | null, name: string, tracks: T.Track[]) =>
    call<string>("import_confirm", { playlistId, name, tracks }),

  downloadTracks: (tracks: T.Track[]) => call<number>("download_tracks", { tracks }),
  downloadList: () => call<T.DownloadInfo[]>("download_list"),
  downloadCancel: (id: string) => call<void>("download_cancel", { id }),
  downloadRemove: (id: string) => call<void>("download_remove", { id }),
  storageUsage: () => call<{ downloadsBytes: number; artCacheBytes: number; downloadsDir: string }>("storage_usage"),
  clearCache: () => call<void>("clear_cache"),

  pipToggle: () => call<boolean>("pip_toggle"),
  focusMain: () => call<void>("focus_main"),
  htpcLaunch: () => call<boolean>("htpc_launch"),
  htpcAutostartGet: () => call<boolean>("htpc_autostart_get"),
  htpcAutostartSet: (enabled: boolean) => call<void>("htpc_autostart_set", { enabled }),
};
