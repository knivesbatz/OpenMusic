//! Playlist sync between devices on the same Wi-Fi (desktop → phone, or the other way).
//!
//! App playlists live only in each device's database. The receiving device opens a small HTTP
//! endpoint for ten minutes and shows its address and a one-time six-digit code; the sending
//! device posts its app playlists (with their covers, and YTSpot's in-app covers of YouTube
//! playlists) there. Playlists keep their ids, so sending again updates them instead of adding
//! copies. Songs from local files stay behind: their files are on the sending device.
//!
//! Nothing leaves the local network, and the endpoint takes one kind of request with the code.

use std::io::Read;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};
use crate::model::{Source, Track};
use crate::state::{AppState, Flavor};

/// The port tried first, so the address shown stays the same between sessions.
pub const PORT: u16 = 47380;
const PATH: &str = "/openmusic/sync";
const CODE_HEADER: &str = "X-OpenMusic-Code";
const LIFETIME: Duration = Duration::from_secs(10 * 60);
const MAX_BODY: u64 = 64 * 1024 * 1024;
const MAX_COVER: usize = 5_000_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    /// "youtube" or "plex": playlists only go to the same app.
    pub app: String,
    pub playlists: Vec<SyncPlaylist>,
    /// In-app covers of provider playlists (YTSpot), by playlist id.
    #[serde(default)]
    pub covers: Vec<SyncCover>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlaylist {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    /// The picked cover image, hex-encoded JPEG/PNG.
    #[serde(default)]
    pub cover: Option<String>,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCover {
    pub id: String,
    pub image: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub playlists: usize,
    pub songs: usize,
    /// Local-file songs left out.
    #[serde(default)]
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receiving {
    /// What to type on the other device, e.g. "192.168.1.23:47380".
    pub address: String,
    pub code: String,
    /// Unix seconds when the endpoint closes.
    pub expires_at: i64,
}

fn app_name(f: Flavor) -> &'static str {
    match f {
        Flavor::YouTube => "youtube",
        Flavor::Plex => "plex",
    }
}

fn is_local(t: &Track) -> bool {
    t.source == Source::Local || t.id.starts_with("local:")
}

fn read_cover(state: &AppState, art: Option<&str>) -> Option<String> {
    let file = art?.strip_prefix("art://local/")?;
    if file.contains(['/', '\\']) || file.contains("..") {
        return None;
    }
    std::fs::read(state.dirs.local_art.join(file)).ok().map(hex::encode)
}

/// Everything this device sends, and how many local-file songs were left out.
pub fn bundle(state: &AppState) -> Result<(Bundle, usize)> {
    let (lists, overrides) = {
        let db = state.db();
        let mut lists = Vec::new();
        for p in db.playlists()? {
            let tracks = db.playlist_tracks(&p.id)?;
            let cover = db.playlist_cover(&p.id)?;
            lists.push((p, tracks, cover));
        }
        (lists, db.cover_overrides()?)
    };
    let mut skipped = 0;
    let playlists = lists
        .into_iter()
        .map(|(p, tracks, cover)| {
            let before = tracks.len();
            let tracks: Vec<Track> = tracks.into_iter().filter(|t| !is_local(t)).collect();
            skipped += before - tracks.len();
            SyncPlaylist { cover: read_cover(state, cover.as_deref()), id: p.id, title: p.title, description: p.description, tracks }
        })
        .collect();
    let covers = overrides
        .into_iter()
        .filter_map(|(id, art)| read_cover(state, Some(&art)).map(|image| SyncCover { id, image }))
        .collect();
    Ok((Bundle { app: app_name(state.flavor).into(), playlists, covers }, skipped))
}

/// Stores a received cover image with the local artwork; None if it isn't a JPEG/PNG.
fn write_cover(state: &AppState, hex_image: &str) -> Option<String> {
    let bytes = hex::decode(hex_image).ok()?;
    let is_image = bytes.starts_with(&[0xFF, 0xD8, 0xFF]) || bytes.starts_with(b"\x89PNG");
    if !is_image || bytes.len() > MAX_COVER {
        return None;
    }
    std::fs::create_dir_all(&state.dirs.local_art).ok()?;
    let name = format!("cover-{}.jpg", uuid::Uuid::new_v4().simple());
    std::fs::write(state.dirs.local_art.join(&name), &bytes).ok()?;
    Some(format!("art://local/{name}"))
}

fn remove_cover(state: &AppState, old: Option<&str>) {
    if let Some(file) = old.and_then(|o| o.strip_prefix("art://local/")) {
        let _ = std::fs::remove_file(state.dirs.local_art.join(file));
    }
}

/// Adds or updates the received playlists on this device.
pub fn import(state: &AppState, b: Bundle) -> Result<Summary> {
    if b.app != app_name(state.flavor) {
        let (this, other) = match state.flavor {
            Flavor::YouTube => ("YTSpot", "PLEXSpot"),
            Flavor::Plex => ("PLEXSpot", "YTSpot"),
        };
        return Err(Error::Invalid(format!("These playlists are from {other}; send them to {other} on the other device, not {this}.")));
    }
    let mut sum = Summary::default();
    for p in b.playlists {
        if !p.id.starts_with("app:") {
            continue;
        }
        let tracks: Vec<Track> = p.tracks.into_iter().filter(|t| !is_local(t)).collect();
        let cover = p.cover.as_deref().and_then(|c| write_cover(state, c));
        let old = {
            let mut db = state.db();
            db.playlist_import(&p.id, &p.title, p.description.as_deref(), &tracks)?;
            let old = db.playlist_cover(&p.id)?;
            if cover.is_some() {
                db.playlist_set_cover(&p.id, cover.as_deref())?;
            }
            old
        };
        if cover.is_some() {
            remove_cover(state, old.as_deref());
        }
        sum.playlists += 1;
        sum.songs += tracks.len();
    }
    if state.flavor == Flavor::YouTube {
        for c in b.covers {
            if !c.id.starts_with("yt:") {
                continue;
            }
            if let Some(cover) = write_cover(state, &c.image) {
                let old = state.db().set_cover_override(&c.id, Some(&cover))?;
                remove_cover(state, old.as_deref());
            }
        }
    }
    Ok(sum)
}

// ---- receiving --------------------------------------------------------------------------------

struct Receiver {
    stop: Arc<AtomicBool>,
}

static RECEIVER: Mutex<Option<Receiver>> = Mutex::new(None);

/// This device's address on the local network (the interface its traffic leaves by).
fn local_ip() -> Option<std::net::IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    // No packet is sent: connecting a UDP socket only picks the route.
    s.connect("192.0.2.1:9").or_else(|_| s.connect("8.8.8.8:80")).ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

fn code() -> String {
    let b = uuid::Uuid::new_v4().into_bytes();
    format!("{:06}", u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000)
}

/// Opens the endpoint (closing any earlier one) and returns what the sender needs to type.
pub fn receive_start(app: AppHandle, state: Arc<AppState>) -> Result<Receiving> {
    receive_stop();
    let ip = local_ip().ok_or_else(|| Error::Invalid("Connect this device to Wi-Fi first.".into()))?;
    let server = tiny_http::Server::http(SocketAddr::new([0, 0, 0, 0].into(), PORT))
        .or_else(|_| tiny_http::Server::http("0.0.0.0:0"))
        .map_err(|e| Error::Invalid(format!("couldn't open the sync connection: {e}")))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(PORT);
    let code = code();
    let stop = Arc::new(AtomicBool::new(false));
    let expires = Instant::now() + LIFETIME;
    {
        let stop = stop.clone();
        let code = code.clone();
        std::thread::Builder::new()
            .name("playlist-sync".into())
            .spawn(move || {
                let mut wrong = 0;
                while !stop.load(Ordering::SeqCst) && Instant::now() < expires && wrong < 5 {
                    let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(500)) else { continue };
                    if !handle(req, &code, &app, &state) {
                        wrong += 1;
                    }
                }
                let _ = app.emit("sync-receive-ended", &code);
            })
            .map_err(|e| Error::Invalid(e.to_string()))?;
    }
    *RECEIVER.lock().unwrap_or_else(|e| e.into_inner()) = Some(Receiver { stop });
    let address = match ip {
        std::net::IpAddr::V6(v6) => format!("[{v6}]:{port}"),
        v4 => format!("{v4}:{port}"),
    };
    Ok(Receiving { address, code, expires_at: crate::db::now() + LIFETIME.as_secs() as i64 })
}

pub fn receive_stop() {
    if let Some(r) = RECEIVER.lock().unwrap_or_else(|e| e.into_inner()).take() {
        r.stop.store(true, Ordering::SeqCst);
    }
}

/// Answers one request. False when it carried a wrong code.
fn handle(mut req: tiny_http::Request, code: &str, app: &AppHandle, state: &AppState) -> bool {
    let reply = |req: tiny_http::Request, status: u16, body: String| {
        let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
    };
    if req.method() != &tiny_http::Method::Post || req.url() != PATH {
        reply(req, 404, String::new());
        return true;
    }
    let given = req.headers().iter().find(|h| h.field.equiv(CODE_HEADER)).map(|h| h.value.as_str().trim().to_string());
    if given.as_deref() != Some(code) {
        reply(req, 403, "wrong code".into());
        return false;
    }
    let mut body = Vec::new();
    if req.as_reader().take(MAX_BODY + 1).read_to_end(&mut body).is_err() || body.len() as u64 > MAX_BODY {
        reply(req, 413, "too large".into());
        return true;
    }
    let result = serde_json::from_slice::<Bundle>(&body).map_err(Error::from).and_then(|b| import(state, b));
    match result {
        Ok(sum) => {
            let _ = app.emit("playlists-changed", ());
            let _ = app.emit("sync-received", &sum);
            reply(req, 200, serde_json::to_string(&sum).unwrap_or_default());
        }
        Err(e) => reply(req, 409, e.to_string()),
    }
    true
}

// ---- sending ----------------------------------------------------------------------------------

/// "192.168.1.23", "192.168.1.23:47380" or a pasted URL → the endpoint's URL.
pub fn endpoint(address: &str) -> Result<String> {
    let a = address.trim().trim_start_matches("http://").trim_end_matches('/');
    let a = a.split('/').next().unwrap_or_default();
    if a.is_empty() || a.contains(char::is_whitespace) {
        return Err(Error::Invalid("Type the address shown on the other device.".into()));
    }
    let has_port = if a.starts_with('[') { a.contains("]:") } else { a.matches(':').count() == 1 };
    Ok(if has_port { format!("http://{a}{PATH}") } else { format!("http://{a}:{PORT}{PATH}") })
}

pub async fn send(state: Arc<AppState>, address: &str, code: &str) -> Result<Summary> {
    let url = endpoint(address)?;
    let st = state.clone();
    let (bundle, skipped) = tauri::async_runtime::spawn_blocking(move || bundle(&st))
        .await
        .map_err(|e| Error::Invalid(e.to_string()))??;
    let resp = state
        .http
        .post(&url)
        .header(CODE_HEADER, code.trim())
        .json(&bundle)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|_| {
            Error::Invalid(
                "Couldn't reach the other device. Check that both are on the same Wi-Fi and that its \"Receive playlists\" screen is still open.".into(),
            )
        })?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    match status {
        200 => {
            let mut sum: Summary = serde_json::from_str(&text)?;
            sum.skipped = skipped;
            Ok(sum)
        }
        403 => Err(Error::Invalid("Wrong code. Type the code shown on the other device.".into())),
        409 => Err(Error::Invalid(text)),
        _ => Err(Error::Invalid(format!("The other device answered {status}."))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints() {
        assert_eq!(endpoint("192.168.1.23").unwrap(), "http://192.168.1.23:47380/openmusic/sync");
        assert_eq!(endpoint(" 192.168.1.23:5000 ").unwrap(), "http://192.168.1.23:5000/openmusic/sync");
        assert_eq!(endpoint("http://10.0.0.4:47380/").unwrap(), "http://10.0.0.4:47380/openmusic/sync");
        assert_eq!(endpoint("[fe80::1]:47380").unwrap(), "http://[fe80::1]:47380/openmusic/sync");
        assert!(endpoint("  ").is_err());
    }

    #[test]
    fn codes_are_six_digits() {
        for _ in 0..50 {
            let c = code();
            assert_eq!(c.len(), 6);
            assert!(c.chars().all(|ch| ch.is_ascii_digit()));
        }
    }
}
