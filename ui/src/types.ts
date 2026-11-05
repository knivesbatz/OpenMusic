// Mirrors crates/openmusic-core/src/model.rs. Keep the two in sync.

export type Source = "plex" | "youtube" | "local";

export interface Track {
  id: string;
  source: Source;
  title: string;
  artist: string;
  artistId?: string | null;
  album?: string | null;
  albumId?: string | null;
  durationMs?: number | null;
  artwork?: string | null;
  streamKey?: string | null;
  trackNumber?: number | null;
  explicit?: boolean;
  episode?: boolean;
  /** Episodes: show notes and release date as shown ("Oct 26"). */
  description?: string | null;
  published?: string | null;
  /** Release year, where the provider knows it (Plex). */
  year?: number | null;
  /** App playlists: when the song was added (unix seconds). */
  addedAt?: number | null;
  /** Disc of a multi-disc album (Plex, local files). */
  discNumber?: number | null;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  artistId?: string | null;
  year?: number | null;
  artwork?: string | null;
  kind?: string | null;
}

export interface Artist {
  id: string;
  name: string;
  artwork?: string | null;
}

export interface Playlist {
  id: string;
  title: string;
  description?: string | null;
  artwork?: string | null;
  trackCount?: number | null;
  owner?: string | null;
  local: boolean;
}

export interface Podcast {
  id: string;
  title: string;
  author?: string | null;
  artwork?: string | null;
}

export type MediaItem =
  | ({ type: "track" } & Track)
  | ({ type: "album" } & Album)
  | ({ type: "artist" } & Artist)
  | ({ type: "playlist" } & Playlist)
  | ({ type: "podcast" } & Podcast);

export interface BrowseCategory {
  id: string;
  title: string;
  color?: string | null;
}

export interface ProfileInfo {
  name: string;
  photo?: string | null;
  url?: string | null;
  /** null: the provider can't say which playlists are public (the page lists yours). */
  publicPlaylists?: Playlist[] | null;
}

export interface Shelf {
  title: string;
  subtitle?: string | null;
  items: MediaItem[];
}

export interface SearchResults {
  top?: MediaItem | null;
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  podcasts: Podcast[];
  episodes: Track[];
  /** Providers whose part failed (set on results merged from several providers). */
  errors?: ProviderError[];
}

export interface ArtistPage {
  artist?: Artist | null;
  description?: string | null;
  topTracks: Track[];
  albums: Album[];
  singles: Album[];
  appearsOn: Album[];
  related: Artist[];
  /** Follower count as the provider words it ("1.2M"); YouTube Music subscribers. */
  followers?: string | null;
  /** Local files by an artist with the same name. */
  localTracks?: Track[];
  localAlbums?: Album[];
}

export interface AlbumPage {
  album: Album;
  tracks: Track[];
}

export interface PlaylistPage {
  playlist: Playlist;
  tracks: Track[];
}

export interface Library {
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
  podcasts: Podcast[];
  /** "Your Episodes" (saved in the app). */
  episodes?: Track[];
  /** Merged library: providers whose part failed (their part is the last one cached, if any). */
  errors?: ProviderError[];
}

export type Stream =
  | { kind: "url"; url: string; quality: string; offline: boolean }
  | { kind: "file"; path: string; quality: string; offline: boolean }
  | { kind: "youtube"; videoId: string };

export interface Capabilities {
  downloads: boolean;
  qualityControl: boolean;
  podcasts: boolean;
  crossfade: boolean;
  gapless: boolean;
  favorites: boolean;
  /** Discord Rich Presence is built in (desktop builds with a Discord application id). */
  discordPresence?: boolean;
}

/** A streaming service OpenSpot can use. Items carry it in their id prefix: `yt:` / `plex:`. */
export type Provider = "youtube" | "plex";
export const PROVIDERS: Provider[] = ["youtube", "plex"];

/** The Settings → Services switches. Off hides a service everywhere but keeps its sign-in. */
export interface Services {
  youtube: boolean;
  plex: boolean;
}

/** One provider's part of a merged (fan-out) result that failed: the rest still shows. */
export interface ProviderError {
  provider: Provider;
  /** "authExpired" | "offline" | "timeout" | "disabled" | "notSignedIn" | "network" | … */
  code: string;
  message?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  /** What each provider can do; the UI combines them with `services` (store/providers.ts caps()). */
  providers: Record<Provider, Capabilities>;
  services: Services;
  /** Discord Rich Presence is built in (desktop builds with a Discord application id). */
  discordPresence?: boolean;
  /** Local artwork server base URL; absent when it failed to start. */
  artBase?: string | null;
  /** "windows", "macos", "linux", "android", "ios". */
  platform?: string;
  /** GPU acceleration off: "auto" after an unclean exit, "manual" from Settings. */
  safeMode?: "auto" | "manual" | null;
  /** Launched with --self-test (CI): run ui/src/selftest.ts. */
  selfTest?: boolean;
}

export interface PlayContext {
  kind: string;
  id: string;
  title: string;
  artwork?: string | null;
}

/** One play in the listening history (db.rs HistoryEntry). */
export interface HistoryEntry {
  id: number;
  track: Track;
  /** Unix seconds. */
  playedAt: number;
  context: PlayContext | null;
}

/** Playlist sync between devices (sync.rs). */
export interface SyncSummary {
  playlists: number;
  songs: number;
  /** Local-file songs left out. */
  skipped: number;
}

export interface SyncReceiving {
  address: string;
  code: string;
  expiresAt: number;
}

export interface HomeData {
  shelves: Shelf[];
  recent: Track[];
  contexts: PlayContext[];
  topTracks: Track[];
  stale: boolean;
  /** Providers whose part failed or timed out (their shelves are missing or from the cache). */
  errors?: ProviderError[];
}

/** The combined Liked Songs page (`liked_tracks`): YouTube's liked songs, then Plex's rated tracks. */
export interface LikedTracks {
  tracks: Track[];
  stale: boolean;
  errors?: ProviderError[];
}

/** Sign-in state of every provider (`auth_status`). */
export type AuthAll = Record<Provider, AuthStatus>;

export interface AuthStatus {
  signedIn: boolean;
  account?: string | null;
  server?: string | null;
  serverConnection?: string | null;
  needsServer: boolean;
}

export interface PlexServer {
  name: string;
  clientIdentifier: string;
  owned: boolean;
  connections: { uri: string; local: boolean; relay: boolean }[];
}

export interface ApiError {
  code: string;
  message: string;
  /** Which provider refused (authExpired, disabled); absent for errors of no provider. */
  provider?: Provider;
}

export interface Lyrics {
  synced: boolean;
  lines: { timeMs?: number | null; text: string }[];
  source: string;
}

export interface DownloadInfo {
  track: Track;
  status: "queued" | "downloading" | "done" | "failed" | "cancelled";
  bytes: number;
  total?: number | null;
  error?: string | null;
}

export interface ScanReport {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  failed: number;
}

export interface LastFmStatus {
  hasKeys: boolean;
  connected: boolean;
  user?: string | null;
  pending: number;
}

export interface YtAccount {
  name: string;
  handle?: string | null;
  photo?: string | null;
  /** Brand-account page id; null for the primary account. */
  pageId?: string | null;
  selected: boolean;
}

export interface SongMeta {
  /** Song (audio track) version played instead of the music video. */
  videoId?: string | null;
  /** Title of the song version, without "(Official Video)" etc. */
  title?: string | null;
  artwork?: string | null;
  artist?: string | null;
  artistId?: string | null;
  album?: string | null;
  albumId?: string | null;
}

export interface PlexUser {
  uuid: string;
  title: string;
  thumb?: string | null;
  admin: boolean;
  /** Switching needs the user's PIN. */
  protected: boolean;
  selected: boolean;
}


/** Android media notification state (mirrors `NowPlaying` in tauri-plugin-openmusic-media). */
export interface NowPlaying {
  id: string;
  /** Increases with every update; the notification ignores older ones arriving late. */
  seq: number;
  title: string;
  artist: string;
  album: string | null;
  artwork: string | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
}

/** YouTube playlist visibility (`yt_copy_playlist`). */
export type YtPrivacy = "PRIVATE" | "UNLISTED" | "PUBLIC";

/** Mirrors `commands::YtCopyResult`. */
export interface YtCopyResult {
  playlistId: string;
  added: number;
  /** "Artist - Title" of songs not found on YouTube Music. */
  missing: string[];
}
