//! YouTube Music adapter.
//!
//! There is **no official API** for YouTube Music libraries: the YouTube Data API v3 exposes
//! neither YTM library shelves nor audio streams. This adapter therefore uses the same InnerTube
//! JSON endpoints the music.youtube.com web app uses, authenticated with the user's own browser
//! session cookies (captured from a Google sign-in window, never a password we handle). It is
//! isolated here so it can be replaced without touching the rest of the app.
//!
//! Playback does not go through InnerTube at all: the UI plays videos with the official YouTube
//! IFrame Player API, so no stream deciphering or DRM circumvention is involved.
//!
//! Parsers search for renderer objects anywhere in a response instead of walking fixed paths,
//! which keeps them working across the frequent small layout changes YouTube ships.

use serde_json::{json, Value};
use sha1::{Digest, Sha1};

use crate::error::{Error, Result};
use crate::model::*;

const BASE: &str = "https://music.youtube.com/youtubei/v1/";
const ORIGIN: &str = "https://music.youtube.com";
const CLIENT_NAME: &str = "WEB_REMIX";
const CLIENT_ID: &str = "67";
pub const DEFAULT_CLIENT_VERSION: &str = "1.20260213.01.00";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

#[derive(Clone)]
pub struct Ytm {
    http: reqwest::Client,
    pub cookie: Option<String>,
    pub hl: String,
    pub client_version: String,
    /// Brand-account channel to act as (InnerTube `onBehalfOfUser`); `None` = primary account.
    pub page_id: Option<String>,
}

pub fn sapisid(cookie: &str) -> Option<&str> {
    cookie.split(';').filter_map(|kv| kv.split_once('=')).find_map(|(k, v)| {
        matches!(k.trim(), "SAPISID" | "__Secure-3PAPISID").then(|| v.trim())
    })
}

pub fn sapisid_hash(sapisid: &str, epoch: u64) -> String {
    let digest = Sha1::digest(format!("{epoch} {sapisid} {ORIGIN}").as_bytes());
    format!("SAPISIDHASH {epoch}_{}", hex::encode(digest))
}

// ---- JSON helpers -----------------------------------------------------------------------------

pub fn find_all<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(m) => {
            for (k, child) in m {
                if k == key {
                    out.push(child);
                } else {
                    find_all(child, key, out);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|c| find_all(c, key, out)),
        _ => {}
    }
}

fn find_first<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    let mut out = Vec::new();
    find_all(v, key, &mut out);
    out.into_iter().next()
}

fn text(v: Option<&Value>) -> String {
    let Some(v) = v else { return String::new() };
    if let Some(s) = v.get("simpleText").and_then(|s| s.as_str()) {
        return s.to_string();
    }
    v.get("runs")
        .and_then(|r| r.as_array())
        .map(|runs| runs.iter().filter_map(|r| r.get("text").and_then(|t| t.as_str())).collect::<String>())
        .unwrap_or_default()
}

fn runs(v: Option<&Value>) -> Vec<&Value> {
    v.and_then(|v| v.get("runs")).and_then(|r| r.as_array()).map(|a| a.iter().collect()).unwrap_or_default()
}

fn page_type(endpoint: &Value) -> Option<&str> {
    endpoint
        .get("browseEndpoint")?
        .get("browseEndpointContextSupportedConfigs")?
        .get("browseEndpointContextMusicConfig")?
        .get("pageType")?
        .as_str()
}

fn browse_id(endpoint: &Value) -> Option<String> {
    endpoint.get("browseEndpoint")?.get("browseId")?.as_str().map(String::from)
}

/// Upgrade googleusercontent thumbnails to a size suitable for cards and the fullscreen player.
pub fn upscale_thumb(url: &str) -> String {
    if let Some(idx) = url.rfind("=w") {
        if url[idx..].contains("-h") {
            return format!("{}=w544-h544-l90-rj", &url[..idx]);
        }
    }
    url.to_string()
}

fn thumbnail(v: &Value) -> Option<String> {
    // Headers also carry `straplineThumbnail` (the artist's avatar), which a plain search could
    // find first; the object's own `thumbnail` is the cover.
    let src = v.get("thumbnail").unwrap_or(v);
    let thumbs = find_first(src, "thumbnails")?.as_array()?;
    let url = thumbs.last()?.get("url")?.as_str()?;
    let url = if url.starts_with("//") { format!("https:{url}") } else { url.to_string() };
    Some(format!("art://url/{}", urlencoding::encode(&upscale_thumb(&url))))
}

pub fn parse_duration(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.len() < 2 || parts.len() > 3 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let mut secs = 0u64;
    for p in parts {
        secs = secs * 60 + p.parse::<u64>().ok()?;
    }
    Some(secs * 1000)
}

const TYPE_WORDS: &[&str] = &["Song", "Video", "Episode", "Album", "Single", "EP", "Playlist", "Artist", "Podcast", "Profile", "Station"];

/// Details pulled from subtitle runs.
#[derive(Default)]
struct Sub {
    artists: Vec<(String, Option<String>)>,
    album: Option<(String, String)>,
    duration: Option<u64>,
    year: Option<u32>,
    kind: Option<String>,
    plain: Vec<String>,
}

/// Play/view counts shown in list rows ("1.2M plays", "4.5K views", "123万回再生").
fn is_count(t: &str) -> bool {
    let lower = t.to_lowercase();
    let suffix = ["plays", "play", "views", "view", "回再生", "回視聴", "回"]
        .iter()
        .find_map(|s| lower.strip_suffix(s).map(|r| r.trim().to_string()));
    match suffix {
        Some(num) => {
            !num.is_empty()
                && num.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
                && num.chars().all(|c| c.is_ascii_digit() || ".,KMBkmb万億千 ".contains(c))
        }
        None => false,
    }
}

fn parse_sub(rs: &[&Value]) -> Sub {
    let mut sub = Sub::default();
    for r in rs {
        let t = r.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
        if t.is_empty() || t == "•" || t == "&" || t == "," {
            continue;
        }
        if let Some(ep) = r.get("navigationEndpoint") {
            if let Some(id) = browse_id(ep) {
                if id.starts_with("MPRE") || page_type(ep) == Some("MUSIC_PAGE_TYPE_ALBUM") {
                    sub.album = Some((t.to_string(), id));
                } else if id.starts_with("UC") || matches!(page_type(ep), Some("MUSIC_PAGE_TYPE_ARTIST") | Some("MUSIC_PAGE_TYPE_USER_CHANNEL")) {
                    sub.artists.push((t.to_string(), Some(id)));
                }
                continue;
            }
        }
        if let Some(d) = parse_duration(t) {
            sub.duration = Some(d);
        } else if t.len() == 4 && t.chars().all(|c| c.is_ascii_digit()) {
            sub.year = t.parse().ok();
        } else if TYPE_WORDS.contains(&t) {
            sub.kind = Some(t.to_string());
        } else if is_count(t) {
            // "123M plays", "4.5K views", "1.2億回再生": never an artist name.
        } else {
            sub.plain.push(t.to_string());
        }
    }
    sub
}

/// Words that mark a bracketed/trailing title segment as video packaging, not part of the song
/// title. Matched against whole segments only, so a song called "Music" or "Video Games" is kept.
const VIDEO_TAGS: &[&str] = &[
    "official music video", "official video", "official audio", "official lyric video", "official lyrics video",
    "official visualizer", "official visualiser", "official mv", "official hd video", "official 4k video",
    "music video", "lyric video", "lyrics video", "lyrics", "lyric", "audio", "visualizer", "visualiser", "video",
    "mv", "m/v", "pv", "hd", "hq", "4k", "4k remaster", "official", "official performance video", "video oficial",
    "audio oficial", "clip officiel", "music video full ver.", "full ver.", "full version mv",
];

fn is_video_tag(segment: &str) -> bool {
    let s = segment.trim().trim_matches(|c: char| matches!(c, '-' | '|' | ':' | '・' | '/')).trim().to_lowercase();
    if s.is_empty() {
        return false;
    }
    if VIDEO_TAGS.contains(&s.as_str()) {
        return true;
    }
    // e.g. "official music video 2019", "【公式】MV", "mv full ver."
    let has_marker = s.contains("official") && (s.contains("video") || s.contains("audio") || s.contains("mv"))
        || s.contains("music video")
        || s.contains("lyric video")
        || (s.contains("mv") && (s.contains("full") || s.contains("公式")))
        || s.contains("ミュージックビデオ")
        || s.contains("公式");
    has_marker && s.split_whitespace().count() <= 6
}

/// Remove music-video packaging from a YouTube video title: bracketed or trailing segments such
/// as "(Official Music Video)", "[Lyric Video]", "【MV】", "- Official Audio", "| Official Video",
/// and a leading "Artist - " that repeats the channel's artist. Words that are part of the actual
/// title are never touched; if cleaning would leave nothing, the original is returned.
pub fn clean_title(title: &str, artist: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut rest = title;
    // Bracketed segments anywhere.
    while let Some((start, open)) = rest.char_indices().find(|(_, c)| matches!(c, '(' | '[' | '【' | '「' | '〔')) {
        let close = match open {
            '(' => ')',
            '[' => ']',
            '【' => '】',
            '「' => '」',
            _ => '〕',
        };
        let after = &rest[start + open.len_utf8()..];
        match after.find(close) {
            Some(end) if is_video_tag(&after[..end]) => {
                out.push_str(&rest[..start]);
                rest = &after[end + close.len_utf8()..];
            }
            Some(end) => {
                let upto = start + open.len_utf8() + end + close.len_utf8();
                out.push_str(&rest[..upto]);
                rest = &rest[upto..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    let mut t = out.split_whitespace().collect::<Vec<_>>().join(" ");
    // Trailing " - Official Video" / " | Official Audio".
    for sep in [" | ", " - ", " / "] {
        if let Some(idx) = t.rfind(sep) {
            if is_video_tag(&t[idx + sep.len()..]) {
                t.truncate(idx);
            }
        }
    }
    // Leading "Artist - " when it repeats the artist.
    if !artist.is_empty() {
        for sep in [" - ", " – ", " — "] {
            if let Some((head, tail)) = t.split_once(sep) {
                if head.trim().eq_ignore_ascii_case(artist.trim()) && !tail.trim().is_empty() {
                    t = tail.trim().to_string();
                    break;
                }
            }
        }
    }
    let t = t.trim().to_string();
    if t.is_empty() { title.trim().to_string() } else { t }
}

fn track_from(video_id: String, title: String, sub: &Sub, artwork: Option<String>, episode: bool) -> Track {
    let (artist, artist_id) = if sub.artists.is_empty() {
        // Unlinked artist names (common on uploads/episodes) appear as plain runs.
        (sub.plain.first().cloned().unwrap_or_default(), None)
    } else {
        (
            sub.artists.iter().map(|a| a.0.as_str()).collect::<Vec<_>>().join(", "),
            sub.artists.first().and_then(|a| a.1.clone()).map(|id| format!("yt:{id}")),
        )
    };
    // Music videos carry their packaging in the title; songs are already clean.
    let title = if !episode && is_video_thumb(&artwork) { clean_title(&title, &artist) } else { title };
    Track {
        id: format!("yt:{video_id}"),
        source: Source::Youtube,
        title,
        artist,
        artist_id,
        album: sub.album.as_ref().map(|a| a.0.clone()),
        album_id: sub.album.as_ref().map(|a| format!("yt:{}", a.1)),
        duration_ms: sub.duration,
        artwork,
        stream_key: Some(video_id),
        track_number: None,
        explicit: false,
        episode,
    }
}

fn item_from_browse(id: String, pt: Option<&str>, title: String, sub: &Sub, artwork: Option<String>) -> Option<MediaItem> {
    let artist = sub.artists.iter().map(|a| a.0.as_str()).collect::<Vec<_>>().join(", ");
    let artist_id = sub.artists.first().and_then(|a| a.1.clone()).map(|i| format!("yt:{i}"));
    let pt = pt.unwrap_or(if id.starts_with("MPRE") {
        "MUSIC_PAGE_TYPE_ALBUM"
    } else if id.starts_with("UC") {
        "MUSIC_PAGE_TYPE_ARTIST"
    } else if id.starts_with("VL") {
        "MUSIC_PAGE_TYPE_PLAYLIST"
    } else if id.starts_with("MPSP") {
        "MUSIC_PAGE_TYPE_PODCAST_SHOW_DETAIL_PAGE"
    } else {
        ""
    });
    Some(match pt {
        "MUSIC_PAGE_TYPE_ALBUM" | "MUSIC_PAGE_TYPE_AUDIOBOOK" => MediaItem::Album(Album {
            id: format!("yt:{id}"),
            title,
            artist: if artist.is_empty() { sub.plain.first().cloned().unwrap_or_default() } else { artist },
            artist_id,
            year: sub.year,
            artwork,
            kind: Some(match sub.kind.as_deref() {
                Some("Single") => "single",
                Some("EP") => "ep",
                _ => "album",
            }
            .into()),
        }),
        "MUSIC_PAGE_TYPE_ARTIST" | "MUSIC_PAGE_TYPE_USER_CHANNEL" | "MUSIC_PAGE_TYPE_LIBRARY_ARTIST" => {
            // Library artist rows browse to "MPLA<channelId>"; the artist page itself is the channel.
            let id = id.trim_start_matches("MPLA").to_string();
            MediaItem::Artist(Artist { id: format!("yt:{id}"), name: title, artwork })
        }
        "MUSIC_PAGE_TYPE_PLAYLIST" => MediaItem::Playlist(Playlist {
            id: format!("yt:{id}"),
            title,
            description: None,
            artwork,
            track_count: sub.plain.iter().find_map(|p| p.split_whitespace().next()?.replace(',', "").parse().ok()),
            owner: if artist.is_empty() { sub.plain.first().cloned() } else { Some(artist) },
            local: false,
        }),
        "MUSIC_PAGE_TYPE_PODCAST_SHOW_DETAIL_PAGE" => MediaItem::Podcast(Podcast {
            id: format!("yt:{id}"),
            title,
            author: if artist.is_empty() { sub.plain.first().cloned() } else { Some(artist) },
            artwork,
        }),
        _ => return None,
    })
}

pub fn parse_responsive(r: &Value) -> Option<MediaItem> {
    let cols: Vec<&Value> = r
        .get("flexColumns")?
        .as_array()?
        .iter()
        .filter_map(|c| c.get("musicResponsiveListItemFlexColumnRenderer")?.get("text"))
        .collect();
    let title_v = cols.first()?;
    let title = text(Some(title_v));
    let mut sub_runs: Vec<&Value> = cols.iter().skip(1).flat_map(|c| runs(Some(c))).collect();
    if let Some(fixed) = r.get("fixedColumns").and_then(|f| f.as_array()) {
        for f in fixed {
            sub_runs.extend(runs(f.get("musicResponsiveListItemFixedColumnRenderer").and_then(|x| x.get("text"))));
        }
    }
    let sub = parse_sub(&sub_runs);
    let art = thumbnail(r.get("thumbnail").unwrap_or(&Value::Null));
    let title_ep = runs(Some(title_v)).first().and_then(|r| r.get("navigationEndpoint")).cloned();
    let video_id = r
        .get("playlistItemData")
        .and_then(|p| p.get("videoId"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| title_ep.as_ref().and_then(|e| e.get("watchEndpoint")?.get("videoId")?.as_str().map(String::from)))
        .or_else(|| {
            r.get("overlay")
                .and_then(|o| find_first(o, "watchEndpoint"))
                .and_then(|w| w.get("videoId")?.as_str().map(String::from))
        });
    let row_ep = r.get("navigationEndpoint");
    if let Some(ep) = row_ep {
        if let Some(id) = browse_id(ep) {
            // Rows that browse somewhere are albums/artists/playlists/podcasts even if they
            // also expose a play button.
            if page_type(ep) != Some("MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE") {
                return item_from_browse(id, page_type(ep), title, &sub, art);
            }
        }
    }
    if let Some(vid) = video_id {
        let episode = sub.kind.as_deref() == Some("Episode")
            || row_ep.and_then(page_type) == Some("MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE");
        return Some(MediaItem::Track(track_from(vid, title, &sub, art, episode)));
    }
    None
}

pub fn parse_two_row(r: &Value) -> Option<MediaItem> {
    let title_v = r.get("title");
    let title = text(title_v);
    let sub = parse_sub(&runs(r.get("subtitle")));
    let art = thumbnail(r.get("thumbnailRenderer").unwrap_or(&Value::Null));
    let ep = r.get("navigationEndpoint")?;
    if let Some(w) = ep.get("watchEndpoint") {
        let vid = w.get("videoId")?.as_str()?.to_string();
        return Some(MediaItem::Track(track_from(vid, title, &sub, art, false)));
    }
    let id = browse_id(ep)?;
    item_from_browse(id, page_type(ep), title, &sub, art)
}

/// Podcast episodes.
pub fn parse_multi_row(r: &Value) -> Option<Track> {
    let title = text(r.get("title"));
    let vid = find_first(r.get("onTap").unwrap_or(r), "watchEndpoint")
        .and_then(|w| w.get("videoId")?.as_str().map(String::from))?;
    let sub = parse_sub(&runs(r.get("subtitle")));
    let art = thumbnail(r.get("thumbnail").unwrap_or(&Value::Null));
    let mut t = track_from(vid, title, &sub, art, true);
    if t.duration_ms.is_none() {
        // Episode subtitles read like "Sep 3 • 45 min".
        t.duration_ms = sub.plain.iter().find_map(|p| {
            let mut ms = 0u64;
            let mut it = p.split_whitespace();
            while let Some(num) = it.next() {
                let unit = it.next().unwrap_or("");
                if let Ok(n) = num.parse::<u64>() {
                    if unit.starts_with("hr") {
                        ms += n * 3_600_000;
                    } else if unit.starts_with("min") {
                        ms += n * 60_000;
                    } else if unit.starts_with("sec") {
                        ms += n * 1000;
                    }
                }
            }
            (ms > 0).then_some(ms)
        });
    }
    Some(t)
}

/// Every media item inside `v`, in document order.
pub fn all_items(v: &Value) -> Vec<MediaItem> {
    let mut out = Vec::new();
    collect_items(v, &mut out);
    out
}

fn collect_items(v: &Value, out: &mut Vec<MediaItem>) {
    match v {
        Value::Object(m) => {
            for (k, child) in m {
                match k.as_str() {
                    "musicResponsiveListItemRenderer" => out.extend(parse_responsive(child)),
                    "musicTwoRowItemRenderer" => out.extend(parse_two_row(child)),
                    "musicMultiRowListItemRenderer" => out.extend(parse_multi_row(child).map(MediaItem::Track)),
                    _ => collect_items(child, out),
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|c| collect_items(c, out)),
        _ => {}
    }
}

fn shelf_title(shelf: &Value) -> String {
    let h = shelf.get("header");
    let t = h
        .and_then(|h| h.get("musicCarouselShelfBasicHeaderRenderer").or_else(|| h.get("musicImmersiveCarouselShelfBasicHeaderRenderer")))
        .map(|r| text(r.get("title")))
        .unwrap_or_default();
    if t.is_empty() {
        text(shelf.get("title"))
    } else {
        t
    }
}

pub fn parse_shelves(v: &Value) -> Vec<Shelf> {
    let mut out = Vec::new();
    for key in ["musicCarouselShelfRenderer", "musicImmersiveCarouselShelfRenderer", "musicShelfRenderer"] {
        let mut found = Vec::new();
        find_all(v, key, &mut found);
        for s in found {
            let items = s.get("contents").map(all_items).unwrap_or_default();
            if !items.is_empty() {
                out.push(Shelf { title: shelf_title(s), subtitle: None, items });
            }
        }
    }
    out
}

fn split_by_kind(items: Vec<MediaItem>, out: &mut SearchResults) {
    for it in items {
        match it {
            MediaItem::Track(t) if t.episode => out.episodes.push(t),
            MediaItem::Track(t) => out.tracks.push(t),
            MediaItem::Album(a) => out.albums.push(a),
            MediaItem::Artist(a) => out.artists.push(a),
            MediaItem::Playlist(p) => out.playlists.push(p),
            MediaItem::Podcast(p) => out.podcasts.push(p),
        }
    }
}

fn dedupe<T, K: std::hash::Hash + Eq>(v: &mut Vec<T>, key: impl Fn(&T) -> K) {
    let mut seen = std::collections::HashSet::new();
    v.retain(|x| seen.insert(key(x)));
}

fn header_of(v: &Value) -> Option<&Value> {
    for k in [
        "musicResponsiveHeaderRenderer",
        "musicDetailHeaderRenderer",
        "musicImmersiveHeaderRenderer",
        "musicVisualHeaderRenderer",
        "musicEditablePlaylistDetailHeaderRenderer",
    ] {
        if let Some(h) = find_first(v, k) {
            if k == "musicEditablePlaylistDetailHeaderRenderer" {
                if let Some(inner) = h.get("header").and_then(|x| find_first(x, "musicResponsiveHeaderRenderer").or_else(|| find_first(x, "musicDetailHeaderRenderer"))) {
                    return Some(inner);
                }
            }
            return Some(h);
        }
    }
    None
}

/// Tracks of an album/playlist/podcast page: only list items inside track shelves, so
/// "you might also like" carousels never leak into the track list.
fn page_tracks(v: &Value) -> Vec<Track> {
    let mut out = Vec::new();
    for key in ["musicPlaylistShelfRenderer", "musicShelfRenderer"] {
        let mut shelves = Vec::new();
        find_all(v, key, &mut shelves);
        for s in shelves {
            for it in s.get("contents").map(all_items).unwrap_or_default() {
                if let MediaItem::Track(t) = it {
                    out.push(t);
                }
            }
        }
    }
    // Podcast pages list episodes as multi-row items outside music shelves.
    if out.is_empty() {
        let mut eps = Vec::new();
        find_all(v, "musicMultiRowListItemRenderer", &mut eps);
        out.extend(eps.into_iter().filter_map(parse_multi_row));
    }
    out
}

/// Identities from `account/accounts_list`.
pub fn parse_accounts(v: &Value) -> Vec<YtAccount> {
    let mut items = Vec::new();
    find_all(v, "accountItem", &mut items);
    items
        .into_iter()
        .filter_map(|a| {
            let name = text(a.get("accountName"));
            if name.is_empty() {
                return None;
            }
            let page_id = a
                .get("serviceEndpoint")
                .and_then(|e| find_first(e, "pageIdToken"))
                .and_then(|t| t.get("pageId"))
                .and_then(|p| p.as_str())
                .map(String::from);
            Some(YtAccount {
                name,
                handle: Some(text(a.get("channelHandle"))).filter(|h| !h.is_empty()),
                photo: a.get("accountPhoto").and_then(thumbnail),
                page_id,
                selected: a.get("isSelected").and_then(|s| s.as_bool()).unwrap_or(false),
            })
        })
        .collect()
}

fn is_video_thumb(art: &Option<String>) -> bool {
    art.as_deref().map(|a| a.contains("ytimg.com")).unwrap_or(false)
}

/// Song metadata from a `next` response for a video: the song counterpart of a music video
/// when there is one (square album art, official artist and album), else the item itself.
pub fn parse_song_meta(v: &Value) -> Option<SongMeta> {
    let wrapper = find_first(v, "playlistPanelVideoWrapperRenderer");
    let counterpart = wrapper.and_then(|w| w.get("counterpart")).and_then(|c| find_first(c, "playlistPanelVideoRenderer"));
    let item = match (counterpart, wrapper) {
        (Some(c), _) => c,
        (None, Some(w)) => w.get("primaryRenderer").and_then(|p| find_first(p, "playlistPanelVideoRenderer"))?,
        (None, None) => find_first(v, "playlistPanelVideoRenderer")?,
    };
    let sub = parse_sub(&runs(item.get("longBylineText")));
    let art = thumbnail(item);
    let meta = SongMeta {
        // Only a real song counterpart replaces the video for playback and title.
        video_id: counterpart.and_then(|c| c.get("videoId")).and_then(|x| x.as_str()).map(String::from),
        title: counterpart.map(|c| text(c.get("title"))).filter(|t| !t.is_empty()),
        artwork: art.filter(|a| !is_video_thumb(&Some(a.clone()))),
        artist: (!sub.artists.is_empty()).then(|| sub.artists.iter().map(|a| a.0.as_str()).collect::<Vec<_>>().join(", ")),
        artist_id: sub.artists.first().and_then(|a| a.1.clone()).map(|i| format!("yt:{i}")),
        album: sub.album.as_ref().map(|a| a.0.clone()),
        album_id: sub.album.as_ref().map(|a| format!("yt:{}", a.1)),
    };
    Some(meta)
}

fn continuation_token(v: &Value) -> Option<(String, bool)> {
    if let Some(t) = find_first(v, "continuationCommand").and_then(|c| c.get("token")).and_then(|t| t.as_str()) {
        return Some((t.to_string(), true));
    }
    find_first(v, "nextContinuationData")
        .and_then(|c| c.get("continuation"))
        .and_then(|t| t.as_str())
        .map(|t| (t.to_string(), false))
}

impl Ytm {
    pub fn new(http: reqwest::Client, cookie: Option<String>, hl: &str) -> Self {
        Ytm { http, cookie, hl: hl.to_string(), client_version: DEFAULT_CLIENT_VERSION.into(), page_id: None }
    }

    pub fn signed_in(&self) -> bool {
        self.cookie.as_deref().and_then(sapisid).is_some()
    }

    async fn post(&self, endpoint: &str, mut body: Value, query: &str) -> Result<Value> {
        let gl = if self.hl == "ja" { "JP" } else { "US" };
        body["context"] = json!({
            "client": { "clientName": CLIENT_NAME, "clientVersion": self.client_version, "hl": self.hl, "gl": gl },
            "user": match &self.page_id {
                Some(id) => json!({ "onBehalfOfUser": id }),
                None => json!({}),
            }
        });
        let mut rb = self
            .http
            .post(format!("{BASE}{endpoint}?prettyPrint=false{query}"))
            .header("Content-Type", "application/json")
            .header("User-Agent", UA)
            .header("Origin", ORIGIN)
            .header("X-Origin", ORIGIN)
            .header("Referer", format!("{ORIGIN}/"))
            .header("X-YouTube-Client-Name", CLIENT_ID)
            .header("X-YouTube-Client-Version", &self.client_version)
            .timeout(std::time::Duration::from_secs(20))
            .json(&body);
        if let Some(cookie) = &self.cookie {
            if let Some(sid) = sapisid(cookie) {
                let epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                rb = rb
                    .header("Cookie", cookie)
                    .header("Authorization", sapisid_hash(sid, epoch))
                    .header("X-Goog-AuthUser", "0");
            }
        }
        let resp = rb.send().await.map_err(|e| if e.is_connect() || e.is_timeout() { Error::Offline(e.to_string()) } else { e.into() })?;
        match resp.status().as_u16() {
            401 | 403 => Err(Error::AuthExpired),
            404 => Err(Error::NotFound(endpoint.into())),
            _ => Ok(resp.error_for_status()?.json().await?),
        }
    }

    async fn browse(&self, browse_id: &str) -> Result<Value> {
        self.post("browse", json!({ "browseId": browse_id }), "").await
    }

    /// Browse and follow continuations, returning every response page.
    async fn browse_all(&self, browse_id: &str, max_pages: usize) -> Result<Vec<Value>> {
        let first = self.browse(browse_id).await?;
        let mut pages = vec![first];
        while pages.len() < max_pages {
            let Some((token, command)) = continuation_token(pages.last().unwrap()) else { break };
            let next = if command {
                self.post("browse", json!({ "continuation": token }), "").await
            } else {
                let t = urlencoding::encode(&token).into_owned();
                self.post("browse", json!({}), &format!("&ctoken={t}&continuation={t}&type=next")).await
            };
            match next {
                Ok(v) => pages.push(v),
                Err(_) => break,
            }
        }
        Ok(pages)
    }

    pub async fn account_name(&self) -> Result<String> {
        let v = self.post("account/account_menu", json!({}), "").await?;
        Ok(find_first(&v, "accountName").map(|a| text(Some(a))).unwrap_or_default())
    }

    /// The personal channel and any brand-account channels of the signed-in Google account.
    pub async fn accounts(&self) -> Result<Vec<YtAccount>> {
        let v = self.post("account/accounts_list", json!({}), "").await?;
        Ok(parse_accounts(&v))
    }

    pub async fn song_meta(&self, video_id: &str) -> Result<Option<SongMeta>> {
        let v = self.post("next", json!({ "videoId": video_id, "isAudioOnly": true, "enablePersistentPlaylistPanel": true }), "").await?;
        Ok(parse_song_meta(&v))
    }

    pub async fn home(&self) -> Result<Vec<Shelf>> {
        let pages = self.browse_all("FEmusic_home", 3).await?;
        Ok(pages.iter().flat_map(parse_shelves).collect())
    }

    /// Search one result type (the YouTube Music filter chips), following continuations, for the
    /// full list behind a filter. `kind`: songs, albums, artists, playlists, podcasts, episodes.
    pub async fn search_kind(&self, q: &str, kind: &str) -> Result<SearchResults> {
        // Filter params as sent by the web client (ytmusicapi's get_search_params).
        let params = match kind {
            "songs" => "EgWKAQIIAWoMEA4QChADEAQQCRAF",
            "albums" => "EgWKAQIYAWoMEA4QChADEAQQCRAF",
            "artists" => "EgWKAQIgAWoMEA4QChADEAQQCRAF",
            "playlists" => "EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D",
            "podcasts" => "EgWKAQJQAWoMEA4QChADEAQQCRAF",
            "episodes" => "EgWKAQJIAWoMEA4QChADEAQQCRAF",
            _ => return Err(Error::Invalid(format!("unknown search kind {kind}"))),
        };
        let mut pages = vec![self.post("search", json!({ "query": q, "params": params }), "").await?];
        while pages.len() < 3 {
            let Some((token, command)) = continuation_token(pages.last().unwrap()) else { break };
            let next = if command {
                self.post("search", json!({ "continuation": token }), "").await
            } else {
                let t = urlencoding::encode(&token).into_owned();
                self.post("search", json!({}), &format!("&ctoken={t}&continuation={t}&type=next")).await
            };
            match next {
                Ok(v) => pages.push(v),
                Err(_) => break,
            }
        }
        let mut out = SearchResults::default();
        for p in &pages {
            split_by_kind(all_items(p), &mut out);
        }
        dedupe(&mut out.tracks, |t| t.id.clone());
        dedupe(&mut out.albums, |t| t.id.clone());
        dedupe(&mut out.artists, |t| t.id.clone());
        dedupe(&mut out.playlists, |t| t.id.clone());
        if kind == "songs" && out.tracks.iter().any(|t| !is_video_thumb(&t.artwork)) {
            out.tracks.retain(|t| !is_video_thumb(&t.artwork));
        }
        Ok(out)
    }

    pub async fn search(&self, q: &str) -> Result<SearchResults> {
        let v = self.post("search", json!({ "query": q }), "").await?;
        let mut out = SearchResults::default();
        if let Some(card) = find_first(&v, "musicCardShelfRenderer") {
            let title = text(card.get("title"));
            let sub = parse_sub(&runs(card.get("subtitle")));
            let art = thumbnail(card.get("thumbnail").unwrap_or(&Value::Null));
            let ep = runs(card.get("title")).first().and_then(|r| r.get("navigationEndpoint")).cloned();
            out.top = ep.and_then(|ep| {
                if let Some(vid) = ep.get("watchEndpoint").and_then(|w| w.get("videoId")).and_then(|x| x.as_str()) {
                    Some(MediaItem::Track(track_from(vid.into(), title.clone(), &sub, art.clone(), false)))
                } else {
                    browse_id(&ep).and_then(|id| item_from_browse(id, page_type(&ep), title.clone(), &sub, art.clone()))
                }
            });
        }
        let mut shelves = Vec::new();
        find_all(&v, "musicShelfRenderer", &mut shelves);
        for s in shelves {
            split_by_kind(s.get("contents").map(all_items).unwrap_or_default(), &mut out);
        }
        dedupe(&mut out.tracks, |t| t.id.clone());
        // Songs only: music videos are left out unless the query matched nothing else.
        if out.tracks.iter().any(|t| !is_video_thumb(&t.artwork)) {
            out.tracks.retain(|t| !is_video_thumb(&t.artwork));
        }
        if matches!(&out.top, Some(MediaItem::Track(t)) if is_video_thumb(&t.artwork)) {
            out.top = out.tracks.first().filter(|t| !is_video_thumb(&t.artwork)).cloned().map(MediaItem::Track).or(out.top.take());
        }
        dedupe(&mut out.albums, |t| t.id.clone());
        dedupe(&mut out.artists, |t| t.id.clone());
        dedupe(&mut out.playlists, |t| t.id.clone());
        Ok(out)
    }

    pub async fn artist(&self, id: &str) -> Result<ArtistPage> {
        let bid = id.trim_start_matches("yt:");
        let v = self.browse(bid).await?;
        let header = header_of(&v);
        let mut page = ArtistPage {
            artist: Some(Artist {
                id: id.into(),
                name: header.map(|h| text(h.get("title"))).unwrap_or_default(),
                artwork: header.and_then(|h| thumbnail(h)),
            }),
            description: header.map(|h| text(h.get("description"))).filter(|d| !d.is_empty()),
            ..Default::default()
        };
        for shelf in parse_shelves(&v) {
            let lower = shelf.title.to_lowercase();
            for it in shelf.items {
                match it {
                    MediaItem::Track(t) if page.top_tracks.len() < 20 && !t.episode => page.top_tracks.push(t),
                    MediaItem::Album(a) if lower.contains("single") || matches!(a.kind.as_deref(), Some("single") | Some("ep")) => page.singles.push(a),
                    MediaItem::Album(a) if lower.contains("featured") || lower.contains("appears") => page.appears_on.push(a),
                    MediaItem::Album(a) => page.albums.push(a),
                    MediaItem::Artist(a) => page.related.push(a),
                    _ => {}
                }
            }
        }
        // Album/single cards on an artist page omit the artist name.
        let name = page.artist.as_ref().map(|a| a.name.clone()).unwrap_or_default();
        for a in page.albums.iter_mut().chain(page.singles.iter_mut()) {
            if a.artist.is_empty() {
                a.artist = name.clone();
                a.artist_id = Some(id.into());
            }
        }
        Ok(page)
    }

    pub async fn album(&self, id: &str) -> Result<AlbumPage> {
        let v = self.browse(id.trim_start_matches("yt:")).await?;
        let h = header_of(&v).ok_or_else(|| Error::NotFound(id.into()))?;
        let mut sub_runs = runs(h.get("straplineTextOne"));
        sub_runs.extend(runs(h.get("subtitle")));
        let sub = parse_sub(&sub_runs);
        let album = Album {
            id: id.into(),
            title: text(h.get("title")),
            artist: if sub.artists.is_empty() { text(h.get("straplineTextOne")) } else { sub.artists.iter().map(|a| a.0.as_str()).collect::<Vec<_>>().join(", ") },
            artist_id: sub.artists.first().and_then(|a| a.1.clone()).map(|i| format!("yt:{i}")),
            year: sub.year,
            artwork: thumbnail(h),
            kind: Some(match sub.kind.as_deref() {
                Some("Single") => "single",
                Some("EP") => "ep",
                _ => "album",
            }
            .into()),
        };
        let mut tracks = page_tracks(&v);
        for (i, t) in tracks.iter_mut().enumerate() {
            t.track_number = Some(i as u32 + 1);
            if t.artwork.is_none() {
                t.artwork = album.artwork.clone();
            }
            if t.album.is_none() {
                t.album = Some(album.title.clone());
                t.album_id = Some(album.id.clone());
            }
            if t.artist.is_empty() || (t.artist_id.is_none() && album.artist_id.is_some() && t.artist == album.artist) {
                t.artist = album.artist.clone();
                t.artist_id = album.artist_id.clone();
            }
        }
        Ok(AlbumPage { album, tracks })
    }

    pub async fn playlist(&self, id: &str) -> Result<PlaylistPage> {
        let bid = id.trim_start_matches("yt:");
        let bid = if bid.starts_with("VL") || bid.starts_with("MPSP") { bid.to_string() } else { format!("VL{bid}") };
        let pages = self.browse_all(&bid, 30).await?;
        let first = &pages[0];
        let h = header_of(first);
        let sub = parse_sub(&h.map(|h| runs(h.get("straplineTextOne"))).unwrap_or_default());
        let playlist = Playlist {
            id: id.into(),
            title: h.map(|h| text(h.get("title"))).unwrap_or_default(),
            description: h.and_then(|h| find_first(h, "description")).map(|d| text(Some(d))).filter(|d| !d.is_empty()),
            artwork: h.and_then(thumbnail),
            track_count: None,
            owner: sub.artists.first().map(|a| a.0.clone()).or_else(|| sub.plain.first().cloned()),
            local: false,
        };
        let mut tracks: Vec<Track> = page_tracks(first);
        for p in pages.iter().skip(1) {
            tracks.extend(all_items(p).into_iter().filter_map(|i| match i {
                MediaItem::Track(t) => Some(t),
                _ => None,
            }));
        }
        let artwork = playlist.artwork.clone();
        for t in tracks.iter_mut().filter(|t| t.artwork.is_none()) {
            t.artwork = artwork.clone();
        }
        Ok(PlaylistPage { playlist, tracks })
    }

    pub async fn podcast(&self, id: &str) -> Result<PlaylistPage> {
        let v = self.browse(id.trim_start_matches("yt:")).await?;
        let h = header_of(&v);
        let artwork = h.and_then(thumbnail);
        let mut tracks = page_tracks(&v);
        for t in tracks.iter_mut() {
            t.episode = true;
            if t.artwork.is_none() {
                t.artwork = artwork.clone();
            }
        }
        Ok(PlaylistPage {
            playlist: Playlist {
                id: id.into(),
                title: h.map(|h| text(h.get("title"))).unwrap_or_default(),
                description: h.and_then(|h| find_first(h, "description")).map(|d| text(Some(d))),
                artwork,
                track_count: Some(tracks.len() as u32),
                owner: h.map(|h| text(h.get("straplineTextOne"))).filter(|s| !s.is_empty()),
                local: false,
            },
            tracks,
        })
    }

    async fn library_items(&self, browse_id: &str) -> Result<Vec<MediaItem>> {
        let pages = self.browse_all(browse_id, 20).await?;
        Ok(pages.iter().flat_map(all_items).collect())
    }

    pub async fn library(&self) -> Result<Library> {
        if !self.signed_in() {
            return Err(Error::NotSignedIn);
        }
        let mut lib = Library::default();
        let mut res = SearchResults::default();
        for id in [
            "FEmusic_liked_playlists",
            "FEmusic_liked_albums",
            "FEmusic_library_corpus_artists",
            "FEmusic_library_non_music_audio_list",
        ] {
            match self.library_items(id).await {
                Ok(items) => split_by_kind(items, &mut res),
                Err(Error::AuthExpired) => return Err(Error::AuthExpired),
                Err(e) => log::warn!("library shelf {id} failed: {e}"),
            }
        }
        lib.playlists = res.playlists;
        lib.albums = res.albums;
        lib.artists = res.artists;
        lib.podcasts = res.podcasts;
        dedupe(&mut lib.playlists, |p| p.id.clone());
        dedupe(&mut lib.albums, |p| p.id.clone());
        dedupe(&mut lib.artists, |p| p.id.clone());
        dedupe(&mut lib.podcasts, |p| p.id.clone());
        Ok(lib)
    }

    pub async fn history(&self) -> Result<Vec<Track>> {
        let v = self.browse("FEmusic_history").await?;
        Ok(all_items(&v)
            .into_iter()
            .filter_map(|i| match i {
                MediaItem::Track(t) => Some(t),
                _ => None,
            })
            .collect())
    }

    /// "Up next" radio for a track, used for autoplay when the queue runs out.
    pub async fn radio(&self, video_id: &str) -> Result<Vec<Track>> {
        let v = self
            .post("next", json!({ "videoId": video_id, "playlistId": format!("RDAMVM{video_id}"), "isAudioOnly": true }), "")
            .await?;
        let mut out = Vec::new();
        let mut renderers = Vec::new();
        find_all(&v, "playlistPanelVideoRenderer", &mut renderers);
        for r in renderers {
            let Some(vid) = r.get("videoId").and_then(|x| x.as_str()) else { continue };
            let sub = parse_sub(&runs(r.get("longBylineText")));
            let mut t = track_from(vid.into(), text(r.get("title")), &sub, thumbnail(r), false);
            if t.duration_ms.is_none() {
                t.duration_ms = parse_duration(&text(r.get("lengthText")));
            }
            out.push(t);
        }
        Ok(out)
    }

    pub async fn rate(&self, video_id: &str, liked: bool) -> Result<()> {
        let ep = if liked { "like/like" } else { "like/removelike" };
        self.post(ep, json!({ "target": { "videoId": video_id } }), "").await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_parsing() {
        assert_eq!(parse_duration("3:45"), Some(225_000));
        assert_eq!(parse_duration("1:02:03"), Some(3_723_000));
        assert_eq!(parse_duration("2024"), None);
        assert_eq!(parse_duration("a:b"), None);
    }

    #[test]
    fn sapisid_hash_shape() {
        assert_eq!(sapisid("A=1; SAPISID=abc; B=2"), Some("abc"));
        assert_eq!(sapisid("__Secure-3PAPISID=x"), Some("x"));
        let h = sapisid_hash("abc", 1700000000);
        assert!(h.starts_with("SAPISIDHASH 1700000000_"));
        assert_eq!(h.len(), "SAPISIDHASH 1700000000_".len() + 40);
    }

    #[test]
    fn cleans_video_titles_but_keeps_real_words() {
        let c = |t: &str, a: &str| clean_title(t, a);
        assert_eq!(c("Welcome to the Black Parade (Official Music Video)", "My Chemical Romance"), "Welcome to the Black Parade");
        assert_eq!(c("My Chemical Romance - Helena [Official Video]", "My Chemical Romance"), "Helena");
        assert_eq!(c("Teenagers (Official Audio)", "x"), "Teenagers");
        assert_eq!(c("夜に駆ける 【MV】", "YOASOBI"), "夜に駆ける");
        assert_eq!(c("Song Title | Official Video", "x"), "Song Title");
        assert_eq!(c("Lemon - Official Lyric Video", "x"), "Lemon");
        // Real titles stay as they are.
        assert_eq!(c("Music Sounds Better with You", "Stardust"), "Music Sounds Better with You");
        assert_eq!(c("Video Games", "Lana Del Rey"), "Video Games");
        assert_eq!(c("Video Killed the Radio Star", "The Buggles"), "Video Killed the Radio Star");
        assert_eq!(c("Bohemian Rhapsody (Live Aid 1985)", "Queen"), "Bohemian Rhapsody (Live Aid 1985)");
        assert_eq!(c("Music (Remix)", "x"), "Music (Remix)");
        assert_eq!(c("(Official Video)", "x"), "(Official Video)");
    }

    #[test]
    fn counts_are_not_artists() {
        for t in ["1.2M plays", "4.5K views", "123 plays", "1.2億回再生", "350万回再生"] {
            assert!(is_count(t), "{t}");
        }
        for t in ["My Chemical Romance", "Plays", "2 Chainz", "The 1975"] {
            assert!(!is_count(t), "{t}");
        }
        let rs = [json!({"text": "123M plays"})];
        let sub = parse_sub(&rs.iter().collect::<Vec<_>>());
        assert!(sub.plain.is_empty());
    }

    #[test]
    fn header_cover_is_not_the_artist_avatar() {
        let h = json!({
            "straplineThumbnail": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [ { "url": "https://lh3.googleusercontent.com/avatar=w60-h60" } ] } } },
            "thumbnail": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [ { "url": "https://lh3.googleusercontent.com/cover=w544-h544" } ] } } }
        });
        assert!(thumbnail(&h).unwrap().contains("cover"));
    }

    #[test]
    fn parses_brand_accounts() {
        let v = json!({ "contents": [ { "accountSectionListRenderer": { "contents": [ { "accountItemSectionRenderer": { "contents": [
            { "accountItem": { "accountName": { "runs": [ { "text": "Maya" } ] }, "isSelected": true,
                "accountPhoto": { "thumbnails": [ { "url": "https://yt3.ggpht.com/a=s88" } ] },
                "channelHandle": { "runs": [ { "text": "@maya" } ] },
                "serviceEndpoint": { "selectActiveIdentityEndpoint": { "supportedTokens": [ { "accountStateToken": { "hasChannel": true } } ] } } } },
            { "accountItem": { "accountName": { "runs": [ { "text": "Maya Music" } ] }, "isSelected": false,
                "serviceEndpoint": { "selectActiveIdentityEndpoint": { "supportedTokens": [ { "pageIdToken": { "pageId": "112233445566778899000" } } ] } } } }
        ] } } ] } } ] });
        let a = parse_accounts(&v);
        assert_eq!(a.len(), 2);
        assert_eq!((a[0].name.as_str(), a[0].selected, a[0].page_id.as_deref()), ("Maya", true, None));
        assert_eq!(a[0].handle.as_deref(), Some("@maya"));
        assert_eq!(a[1].page_id.as_deref(), Some("112233445566778899000"));
    }

    #[test]
    fn song_meta_prefers_song_counterpart() {
        let byline = |artist: &str, album: Option<&str>| {
            let mut r = vec![json!({ "text": artist, "navigationEndpoint": { "browseEndpoint": { "browseId": "UCmcr" } } })];
            if let Some(al) = album {
                r.push(json!({ "text": " • " }));
                r.push(json!({ "text": al, "navigationEndpoint": { "browseEndpoint": { "browseId": "MPREb_black" } } }));
            }
            json!({ "runs": r })
        };
        let v = json!({ "playlistPanelVideoWrapperRenderer": {
            "primaryRenderer": { "playlistPanelVideoRenderer": {
                "thumbnail": { "thumbnails": [ { "url": "https://i.ytimg.com/vi/x/hqdefault.jpg" } ] },
                "longBylineText": byline("mcr", None) } },
            "counterpart": [ { "counterpartRenderer": { "playlistPanelVideoRenderer": {
                "videoId": "songId", "title": { "runs": [ { "text": "Welcome to the Black Parade" } ] },
                "thumbnail": { "thumbnails": [ { "url": "https://lh3.googleusercontent.com/black=w544-h544" } ] },
                "longBylineText": byline("My Chemical Romance", Some("The Black Parade")) } } } ]
        } });
        let m = parse_song_meta(&v).unwrap();
        assert_eq!(m.artist.as_deref(), Some("My Chemical Romance"));
        assert_eq!(m.video_id.as_deref(), Some("songId"));
        assert_eq!(m.title.as_deref(), Some("Welcome to the Black Parade"));
        assert_eq!(m.album.as_deref(), Some("The Black Parade"));
        assert_eq!(m.album_id.as_deref(), Some("yt:MPREb_black"));
        assert!(m.artwork.unwrap().contains("googleusercontent"));
    }

    #[test]
    fn thumb_upscale() {
        assert_eq!(upscale_thumb("https://lh3.googleusercontent.com/abc=w120-h120-l90-rj"), "https://lh3.googleusercontent.com/abc=w544-h544-l90-rj");
        assert_eq!(upscale_thumb("https://i.ytimg.com/vi/x/hqdefault.jpg"), "https://i.ytimg.com/vi/x/hqdefault.jpg");
    }

    fn song_row() -> Value {
        json!({"musicResponsiveListItemRenderer": {
            "thumbnail": {"musicThumbnailRenderer": {"thumbnail": {"thumbnails": [{"url": "https://lh3.googleusercontent.com/a=w60-h60-l90-rj"}]}}},
            "flexColumns": [
                {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Au Revoir",
                    "navigationEndpoint": {"watchEndpoint": {"videoId": "vid123"}}}]}}},
                {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [
                    {"text": "Song"}, {"text": " • "},
                    {"text": "Malice Mizer", "navigationEndpoint": {"browseEndpoint": {"browseId": "UCabc"}}},
                    {"text": " • "},
                    {"text": "merveilles", "navigationEndpoint": {"browseEndpoint": {"browseId": "MPREb_xyz"}}},
                    {"text": " • "}, {"text": "5:02"}]}}}
            ]
        }})
    }

    #[test]
    fn parses_song_rows() {
        let items = all_items(&json!({"contents": [song_row()]}));
        let MediaItem::Track(t) = &items[0] else { panic!("expected track") };
        assert_eq!(t.id, "yt:vid123");
        assert_eq!(t.artist, "Malice Mizer");
        assert_eq!(t.artist_id.as_deref(), Some("yt:UCabc"));
        assert_eq!(t.album.as_deref(), Some("merveilles"));
        assert_eq!(t.album_id.as_deref(), Some("yt:MPREb_xyz"));
        assert_eq!(t.duration_ms, Some(302_000));
        assert!(t.artwork.as_deref().unwrap().contains("w544-h544"));
    }

    #[test]
    fn parses_two_row_album_and_playlist() {
        let album = json!({"musicTwoRowItemRenderer": {
            "title": {"runs": [{"text": "merveilles"}]},
            "subtitle": {"runs": [{"text": "Album"}, {"text": " • "}, {"text": "1998"}]},
            "navigationEndpoint": {"browseEndpoint": {"browseId": "MPREb_xyz",
                "browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ALBUM"}}}}
        }});
        let pl = json!({"musicTwoRowItemRenderer": {
            "title": {"runs": [{"text": "My Mix"}]},
            "subtitle": {"runs": [{"text": "Playlist"}, {"text": " • "}, {"text": "42 songs"}]},
            "navigationEndpoint": {"browseEndpoint": {"browseId": "VLPL1"}}
        }});
        let items = all_items(&json!([album, pl]));
        assert!(matches!(&items[0], MediaItem::Album(a) if a.year == Some(1998) && a.kind.as_deref() == Some("album")));
        assert!(matches!(&items[1], MediaItem::Playlist(p) if p.id == "yt:VLPL1" && p.track_count == Some(42)));
    }

    #[test]
    fn shelves_have_titles() {
        let v = json!({"musicCarouselShelfRenderer": {
            "header": {"musicCarouselShelfBasicHeaderRenderer": {"title": {"runs": [{"text": "Quick picks"}]}}},
            "contents": [song_row()]
        }});
        let s = parse_shelves(&v);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].title, "Quick picks");
    }

    #[test]
    fn episode_from_multi_row() {
        let v = json!({"title": {"runs": [{"text": "Ep 1"}]},
            "subtitle": {"runs": [{"text": "Sep 3"}, {"text": " • "}, {"text": "1 hr 5 min"}]},
            "onTap": {"watchEndpoint": {"videoId": "e1"}}});
        let t = parse_multi_row(&v).unwrap();
        assert!(t.episode);
        assert_eq!(t.duration_ms, Some(3_900_000));
    }
}
