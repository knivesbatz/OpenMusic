import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type * as T from "./types";

/** True when running inside Tauri (false in a plain browser during UI development). */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Sign-in and session commands answer for themselves; everything else gets one retry after the
// session of the provider that refused it is repaired.
const NO_RECOVER = new Set([
  "auth_recover",
  "auth_status",
  "sign_out",
  "yt_login",
  "plex_pin_poll",
  "plex_pin_start",
  "plex_servers",
  "plex_select_server",
  "services_get",
  "services_set",
]);
/** One repair per provider at a time: a YouTube refusal never waits on a Plex repair. */
const recovering: Record<T.Provider, Promise<boolean> | null> = { youtube: null, plex: null };

async function call<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  try {
    return await invoke<R>(cmd, args);
  } catch (e) {
    const provider = errorProvider(e);
    // An authExpired that names no provider (a stray 401 from elsewhere) is never "repaired".
    if (errorCode(e) !== "authExpired" || !provider || NO_RECOVER.has(cmd)) throw e;
    // A refused request is usually a stale Plex server token or an old YouTube cookie, not a
    // signed-out account: repair that provider's session (once for all the requests failing
    // together) and try again before showing an error.
    recovering[provider] ??= invoke<boolean>("auth_recover", { provider })
      .catch(() => false)
      .finally(() => setTimeout(() => (recovering[provider] = null), 10_000));
    if (!(await recovering[provider])) throw e;
    return invoke<R>(cmd, args);
  }
}

/** Gets the `errors` of every merged (fan-out) result: store/app.ts shows a per-provider notice
 * for a session the core could not repair. */
let onPartErrors: ((errors: T.ProviderError[]) => void) | null = null;
export const setPartErrorHandler = (fn: (errors: T.ProviderError[]) => void) => {
  onPartErrors = fn;
};

function noteParts<R extends { errors?: T.ProviderError[] }>(r: R): R {
  if (r?.errors?.length) onPartErrors?.(r.errors);
  return r;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as T.ApiError).message);
  return String(e);
}

export function errorCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) return String((e as T.ApiError).code);
  return undefined;
}

/** The provider an error is about ("youtube" | "plex"), when the core named one. */
export function errorProvider(e: unknown): T.Provider | undefined {
  const p = e && typeof e === "object" && "provider" in e ? (e as T.ApiError).provider : undefined;
  return p === "youtube" || p === "plex" ? p : undefined;
}

// Windows and Android webviews reach custom protocols as http://<scheme>.localhost.
const httpSchemes = typeof navigator !== "undefined" && /Windows|Android/i.test(navigator.userAgent);

/** Local artwork server (`http://127.0.0.1:<port>/<token>`), set from `app_info` at startup. */
let artBase: string | null = null;
export const setArtBase = (base: string | null | undefined) => {
  artBase = base ? base.replace(/\/$/, "") + "/" : null;
};

/** Resolve an `art://…` reference to a URL the webview can load (served by the Rust art cache). */
export function artUrl(ref: string | null | undefined, size = 300): string | undefined {
  if (!ref) return undefined;
  if (!ref.startsWith("art://")) return ref;
  const rest = ref.slice("art://".length);
  // Prefer the local HTTP server: image requests cancelled by scrolling are routine there.
  const base = artBase ?? (httpSchemes ? "http://art.localhost/" : "art://localhost/");
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

  servicesGet: () => call<T.Services>("services_get"),
  /** Turn services on or off; emits `services-changed`. Never signs out and never asks anything. */
  servicesSet: (services: T.Services) => call<void>("services_set", { services }),

  authStatus: () => call<T.AuthAll>("auth_status"),
  /** Repair one provider's session (Plex: re-probe the server; YouTube: renew the cookies). */
  authRecover: (provider: T.Provider) => call<boolean>("auth_recover", { provider }),
  plexPinStart: () => call<{ id: number; code: string; authUrl: string }>("plex_pin_start"),
  plexPinPoll: (id: number) => call<boolean>("plex_pin_poll", { id }),
  plexServers: () => call<T.PlexServer[]>("plex_servers"),
  plexSelectServer: (clientIdentifier: string) => call<string>("plex_select_server", { clientIdentifier }),
  plexReconnect: () => call<void>("plex_reconnect_cmd"),
  ytLogin: () => call<void>("yt_login"),
  /** Sign out of one provider. Plex turns its switch off; YouTube stays on (anonymous). */
  signOut: (provider: T.Provider) => call<void>("sign_out", { provider }),

  home: (refresh: boolean) => call<T.HomeData>("home", { refresh }).then(noteParts),
  newReleases: (refresh: boolean) => call<T.Shelf[]>("new_releases", { refresh }),
  /** One provider's results, or (provider null or left out) local files and app playlists only.
   * The UI asks each source in parallel and merges them (searchMerge.ts). */
  search: (query: string, provider?: T.Provider | null) => call<T.SearchResults>("search", { query, provider: provider ?? null }),
  searchKind: (query: string, kind: string, provider?: T.Provider | null) =>
    call<T.SearchResults>("search_kind", { query, kind, provider: provider ?? null }),
  artist: (id: string) => call<T.ArtistPage>("artist", { id }),
  /** Pairs of these artists confirmed to be the same artist (cache only; none unless both services are on). */
  artistLinks: (ids: string[]) => call<[string, string][]>("artist_links", { ids }),
  /** Check in the background whether these artists match across sources (emits artist-links-changed). */
  artistLinkCheck: (ids: string[]) => call<void>("artist_link_check", { ids }),
  album: (id: string) => call<T.AlbumPage>("album", { id }),
  playlist: (id: string) => call<T.PlaylistPage>("playlist", { id }),
  library: (refresh: boolean) => call<T.Library>("library", { refresh }).then(noteParts),
  radio: (track: T.Track) => call<T.Track[]>("radio", { track }),
  mediaUpdate: (now: T.NowPlaying) => call<void>("media_update", { now }),
  widgetRefresh: () => call<void>("widget_refresh"),
  /** Titles MusicBrainz lists as this artist's compilations ([] when unknown or offline). */
  artistCompilations: (name: string) => call<string[] | null>("artist_compilations", { name }).then((v) => v ?? []),
  /** LUFS from Plex's loudness analysis or the file's ReplayGain tag; null when unknown. */
  trackLoudness: (track: T.Track) => call<number | null>("track_loudness", { track }),
  mediaStop: () => call<void>("media_stop"),
  presenceUpdate: (now: T.NowPlaying, link: string | null) => call<void>("presence_update", { now, link }),
  presenceClear: () => call<void>("presence_clear"),
  updateCheck: () => call<{ available: boolean; current: string; version: string; url?: string | null; notes?: string | null; ready: boolean }>("update_check"),
  updateDownload: (url: string) => call<void>("update_download", { url }),
  updateRestart: () => call<void>("update_restart"),
  selfTestLog: (line: string) => call<void>("self_test_log", { line }),
  selfTestExit: () => call<void>("self_test_exit"),
  autoplayTracks: (track: T.Track, exclude: string[]) => call<T.Track[]>("autoplay_tracks", { track, exclude }),

  resolveStream: (track: T.Track, quality: string) => call<T.Stream>("resolve_stream", { track, quality }),
  recordPlay: (track: T.Track, context: T.PlayContext | null) => call<void>("record_play", { track, context }),
  markPlayed: (track: T.Track) => call<void>("mark_played", { track }),
  rate: (track: T.Track, liked: boolean) => call<void>("rate", { track, liked }),
  likedIds: () => call<string[]>("liked_ids"),
  /** The combined Liked Songs page (YouTube liked songs, then Plex rated tracks). */
  likedTracks: (refresh: boolean) => call<T.LikedTracks>("liked_tracks", { refresh }).then(noteParts),
  plexHomeUsers: () => call<T.PlexUser[]>("plex_home_users"),
  plexSwitchUser: (uuid: string, pin: string | null) => call<void>("plex_switch_user", { uuid, pin }),
  ytAccounts: () => call<T.YtAccount[]>("yt_accounts"),
  ytDeletePlaylist: (id: string) => call<void>("yt_delete_playlist", { id }),
  browseCategories: (refresh: boolean) => call<T.BrowseCategory[]>("browse_categories", { refresh }),
  browsePage: (id: string) => call<T.Shelf[]>("browse_page", { id }),
  browseArt: (id: string) => call<string | null>("browse_art", { id }),
  profileInfo: () => call<T.ProfileInfo>("profile_info"),
  profileArtists: (kind: "top" | "recent", limit: number) => call<T.Artist[]>("profile_artists", { kind, limit }),
  ytSelectAccount: (pageId: string | null, name: string) => call<void>("yt_select_account", { pageId, name }),
  ytSongMeta: (videoIds: string[]) => call<Record<string, T.SongMeta>>("yt_song_meta", { videoIds }),
  translateTexts: (texts: string[], locale: string) => call<(string | null)[]>("translate_texts", { texts, locale }),
  localizedArtistNames: (names: string[], locale: string) =>
    call<Record<string, string>>("localized_artist_names", { names, locale }),
  savedList: () => call<T.Library>("saved_list"),
  saveAlbum: (album: T.Album, saved: boolean) => call<void>("save_album", { album, saved }),
  saveArtist: (artist: T.Artist, saved: boolean) => call<void>("save_artist", { artist, saved }),
  savePodcast: (podcast: T.Podcast, saved: boolean) => call<void>("save_podcast", { podcast, saved }),
  saveEpisode: (episode: T.Track, saved: boolean) => call<void>("save_episode", { episode, saved }),
  queueSave: (queue: unknown) => call<void>("queue_save", { queue }),
  queueLoad: () => call<unknown | null>("queue_load"),
  lyrics: (track: T.Track) => call<T.Lyrics | null>("get_lyrics", { track }),

  plList: () => call<T.Playlist[]>("pl_list"),
  plCreate: (name: string, tracks?: T.Track[]) => call<T.Playlist>("pl_create", { name, tracks }),
  plUpdate: (id: string, name: string, description?: string | null) => call<void>("pl_update", { id, name, description }),
  plDelete: (id: string) => call<void>("pl_delete", { id }),
  plSetCover: (id: string, image: number[] | null) => call<void>("pl_set_cover", { id, image }),
  plAdd: (id: string, tracks: T.Track[]) => call<number>("pl_add", { id, tracks }),
  plReorder: (id: string, order: number[]) => call<void>("pl_reorder", { id, order }),
  saveTextFile: (name: string, content: string) => call<string | null>("save_text_file", { name, content }),
  plRemoveTrack: (id: string, trackId: string) => call<number>("pl_remove_track", { id, trackId }),
  savedIn: (track: T.Track) => call<{ appPlaylists: string[]; remote: { id: string; title: string; contains: boolean }[] }>("saved_in", { track }),
  ytPlaylistEdit: (playlistId: string, track: T.Track, add: boolean) => call<void>("yt_playlist_edit", { playlistId, track, add }),
  hidePlaylist: (id: string, title: string) => call<void>("hide_playlist", { id, title }),
  ytCopyPlaylist: (id: string, title: string, privacy: T.YtPrivacy) => call<T.YtCopyResult>("yt_copy_playlist", { id, title, privacy }),

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


  downloadTracks: (tracks: T.Track[]) => call<number>("download_tracks", { tracks }),
  downloadList: () => call<T.DownloadInfo[]>("download_list"),
  downloadCancel: (id: string) => call<void>("download_cancel", { id }),
  downloadRemove: (id: string) => call<void>("download_remove", { id }),
  storageUsage: () => call<{ downloadsBytes: number; artCacheBytes: number; downloadsDir: string }>("storage_usage"),
  clearCache: () => call<void>("clear_cache"),

  pipToggle: () => call<boolean>("pip_toggle"),
  focusMain: () => call<void>("focus_main"),
  logUiError: (message: string) => call<void>("log_ui_error", { message }),
  gpuSet: (enabled: boolean) => call<void>("gpu_set", { enabled }),
  audioShareSet: (enabled: boolean) => call<void>("audio_share_set", { enabled }),
  listeningHistory: (before: number | null) => call<T.HistoryEntry[]>("listening_history", { before }),
  historyRemove: (ids: number[]) => call<void>("history_remove", { ids }),
  historyClear: () => call<void>("history_clear"),
  syncReceiveStart: () => call<T.SyncReceiving>("sync_receive_start"),
  syncReceiveStop: () => call<void>("sync_receive_stop"),
  syncSend: (address: string, code: string) => call<T.SyncSummary>("sync_send", { address, code }),
  htpcLaunch: () => call<boolean>("htpc_launch"),
  htpcAutostartGet: () => call<boolean>("htpc_autostart_get"),
  htpcAutostartSet: (enabled: boolean) => call<void>("htpc_autostart_set", { enabled }),
};
