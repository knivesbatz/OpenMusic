//! Provider-neutral data model shared by both apps and mirrored in `ui/src/types.ts`.
//!
//! Every playable item carries a provider-aware `id` (`plex:<ratingKey>`, `yt:<videoId>`,
//! `local:<hash>`) so tracks that share a title are never confused, plus a `streamKey` that the
//! owning provider uses to resolve the actual audio source at play time.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Plex,
    Youtube,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub source: Source,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub artist_id: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    /// `art://...` reference (resolved and cached by the art protocol) or an asset path.
    #[serde(default)]
    pub artwork: Option<String>,
    /// Provider-specific handle used to resolve audio: Plex part key, YouTube video id, file path.
    #[serde(default)]
    pub stream_key: Option<String>,
    #[serde(default)]
    pub track_number: Option<u32>,
    #[serde(default)]
    pub explicit: bool,
    /// Podcast episode rather than music.
    #[serde(default)]
    pub episode: bool,
    /// Episodes: the show notes' first lines and the release date as shown ("Oct 26").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    /// Release year, where the provider knows it (Plex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    /// App playlists: when the song was added (unix seconds), for sorting by "Recently added".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub artist_id: Option<String>,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub artwork: Option<String>,
    /// "album" | "single" | "ep" | "compilation"
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub artwork: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub artwork: Option<String>,
    #[serde(default)]
    pub track_count: Option<u32>,
    #[serde(default)]
    pub owner: Option<String>,
    /// true for playlists stored by this app (never written to the provider).
    #[serde(default)]
    pub local: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Podcast {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub artwork: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MediaItem {
    Track(Track),
    Album(Album),
    Artist(Artist),
    Playlist(Playlist),
    Podcast(Podcast),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    pub items: Vec<MediaItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub top: Option<MediaItem>,
    pub tracks: Vec<Track>,
    pub albums: Vec<Album>,
    pub artists: Vec<Artist>,
    pub playlists: Vec<Playlist>,
    pub podcasts: Vec<Podcast>,
    pub episodes: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtistPage {
    pub artist: Option<Artist>,
    pub description: Option<String>,
    pub top_tracks: Vec<Track>,
    pub albums: Vec<Album>,
    pub singles: Vec<Album>,
    pub appears_on: Vec<Album>,
    pub related: Vec<Artist>,
    /// Follower count as the provider words it ("1.2M"); YouTube Music subscribers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub followers: Option<String>,
    /// Local files whose artist matches this artist's name (not cached with the provider page).
    #[serde(default)]
    pub local_tracks: Vec<Track>,
    #[serde(default)]
    pub local_albums: Vec<Album>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPage {
    pub album: Album,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistPage {
    pub playlist: Playlist,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
    pub playlists: Vec<Playlist>,
    pub podcasts: Vec<Podcast>,
    /// "Your Episodes": podcast episodes saved in the app.
    #[serde(default)]
    pub episodes: Vec<Track>,
}

/// How the UI should play a resolved track.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Stream {
    /// A URL an `<audio>` element can play (HTTP stream or asset-protocol file).
    #[serde(rename_all = "camelCase")]
    Url { url: String, quality: String, offline: bool },
    /// A file on disk (local library or offline download), played via the asset protocol.
    #[serde(rename_all = "camelCase")]
    File { path: String, quality: String, offline: bool },
    /// Played through the official YouTube IFrame Player API.
    #[serde(rename_all = "camelCase")]
    Youtube { video_id: String },
}

/// What the active provider can do. The UI hides or disables controls the provider lacks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub downloads: bool,
    pub quality_control: bool,
    pub podcasts: bool,
    /// Crossfade/gapless: two `<audio>` decks, or two YouTube IFrame players for YouTube.
    pub crossfade: bool,
    pub gapless: bool,
    pub favorites: bool,
    /// Discord Rich Presence: desktop builds that have a Discord application id baked in.
    #[serde(default)]
    pub discord_presence: bool,
}

/// A YouTube identity the signed-in Google account can act as: the personal channel or a
/// brand-account channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YtAccount {
    pub name: String,
    pub handle: Option<String>,
    pub photo: Option<String>,
    /// Brand-account page id; `None` for the primary account.
    pub page_id: Option<String>,
    pub selected: bool,
}

/// Song (audio track) metadata for a YouTube music video: square album art and the official
/// artist/album, taken from the video's song counterpart.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SongMeta {
    /// Video id of the song (audio track) version; played instead of the music video.
    #[serde(default)]
    pub video_id: Option<String>,
    /// Title of the song version (no "(Official Video)" etc.).
    #[serde(default)]
    pub title: Option<String>,
    pub artwork: Option<String>,
    pub artist: Option<String>,
    pub artist_id: Option<String>,
    pub album: Option<String>,
    pub album_id: Option<String>,
}

/// A Plex Home user (profile) of the signed-in Plex account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlexUser {
    pub uuid: String,
    pub title: String,
    pub thumb: Option<String>,
    pub admin: bool,
    /// Switching to this user needs their PIN.
    pub protected: bool,
    pub selected: bool,
}

