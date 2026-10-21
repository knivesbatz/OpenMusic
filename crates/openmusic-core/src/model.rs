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
}

/// How the UI should play a resolved track.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Stream {
    /// A URL an `<audio>` element can play (HTTP stream or asset-protocol file).
    #[serde(rename_all = "camelCase")]
    Url { url: String, quality: String, offline: bool },
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
    /// Crossfade/gapless are only possible for sources played through `<audio>`.
    pub crossfade: bool,
    pub gapless: bool,
    pub favorites: bool,
}
