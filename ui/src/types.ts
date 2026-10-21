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

export interface AppInfo {
  flavor: "youtube" | "plex";
  name: string;
  version: string;
  capabilities: Capabilities;
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

export interface HomeData {
  shelves: Shelf[];
  recent: Track[];
  contexts: PlayContext[];
  topTracks: Track[];
  stale: boolean;
  error?: ApiError | null;
}

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
  title: string;
  artist: string;
  album: string | null;
  artwork: string | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
}
