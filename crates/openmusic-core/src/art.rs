//! `art://` protocol: artwork fetched once, cached on disk, then served locally.
//!
//! Track/album records store artwork as `art://plex/<thumb path>`, `art://url/<encoded url>` or
//! `art://local/<file>`. The webview loads these through this handler (on Windows the URL is
//! `http://art.localhost/...`), so Plex tokens never end up in stored metadata, artwork works
//! offline once seen, and repeated views never hit the network.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha1::{Digest, Sha1};
use tauri::http::{header, Request, Response, StatusCode};

use crate::state::AppState;

const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
/// Cached sizes: a request is rounded up to one of these, so each cover is stored a few times at
/// most instead of once per pixel size the UI happens to ask for.
const SIZES: [u32; 4] = [128, 300, 640, 1200];
/// Marks a cache that only holds shrunk images (older versions kept full-size originals).
const CACHE_VERSION: &str = ".v2";

fn bucket(size: u32) -> u32 {
    SIZES.into_iter().find(|&s| s >= size).unwrap_or(SIZES[SIZES.len() - 1])
}

/// YouTube Music artwork (googleusercontent / ggpht) is resized by its server: ask for the size
/// that will be shown rather than downloading the default (often 544px or larger).
fn sized_upstream(url: &str, size: u32) -> String {
    let google = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.ends_with("googleusercontent.com") || h.ends_with("ggpht.com")))
        .unwrap_or(false);
    if !google || url.contains('?') {
        return url.to_string();
    }
    let base = match url.rfind('=') {
        Some(i) if !url[i..].contains('/') => &url[..i],
        _ => url,
    };
    format!("{base}=w{size}-h{size}-l90-rj")
}

/// Shrink artwork to at most `size` px on its longer side and store it as JPEG. `None` keeps the
/// original: already small, not decodable, or not smaller after re-encoding.
fn shrink(bytes: &[u8], size: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let fits = img.width().max(img.height()) <= size;
    if fits && bytes.len() <= 96 * 1024 {
        return None;
    }
    let img = if fits { img } else { img.resize(size, size, image::imageops::FilterType::Triangle) };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&img.to_rgb8()).ok()?;
    (out.len() < bytes.len()).then_some(out)
}

/// One-time cleanup when upgrading from a cache of full-size originals. Covers are fetched
/// again (shrunk) as they're shown.
pub fn upgrade_cache(dir: &Path) {
    let marker = dir.join(CACHE_VERSION);
    if marker.exists() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        }
    }
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(marker, b"");
}

fn mime(bytes: &[u8]) -> &'static str {
    match bytes {
        [0xFF, 0xD8, ..] => "image/jpeg",
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'G', b'I', b'F', ..] => "image/gif",
        _ => "application/octet-stream",
    }
}

fn respond(bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime(&bytes))
        .header(header::CACHE_CONTROL, "max-age=604800, immutable")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap()
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap()
}

pub async fn handle(state: Arc<AppState>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = req.uri();
    match serve(state, uri.path(), uri.query().unwrap_or("")).await {
        Some(bytes) => respond(bytes),
        None => not_found(),
    }
}

/// Local HTTP server for artwork, used by the UI instead of the `art://` protocol.
///
/// WebView2 cancels image requests whenever a list scrolls or a page changes; answering
/// cancelled requests through an asynchronous custom protocol is a known source of native
/// crashes, while a cancelled HTTP request is routine. The server listens on 127.0.0.1 only, on
/// a random port, and every URL must start with a random per-launch token so other local
/// programs or web pages cannot use it to reach the user's Plex server.
pub fn start_server(state: Arc<AppState>) -> std::io::Result<String> {
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").map_err(|e| std::io::Error::other(e.to_string()))?);
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or_else(|| std::io::Error::other("no port"))?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let prefix = format!("/{token}/");
    for _ in 0..4 {
        let server = server.clone();
        let state = state.clone();
        let prefix = prefix.clone();
        std::thread::Builder::new().name("art-server".into()).spawn(move || {
            for req in server.incoming_requests() {
                let body = match route(req.url(), &prefix) {
                    Some((path, query)) if req.method() == &tiny_http::Method::Get => {
                        tauri::async_runtime::block_on(serve(state.clone(), &path, &query))
                    }
                    _ => None,
                };
                // A failed respond means the webview cancelled the request: nothing to do.
                let _ = match body {
                    Some(bytes) => {
                        let ct = mime(&bytes);
                        let headers = [
                            tiny_http::Header::from_bytes("Content-Type", ct).ok(),
                            tiny_http::Header::from_bytes("Cache-Control", "max-age=604800, immutable").ok(),
                            tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").ok(),
                        ];
                        let mut resp = tiny_http::Response::from_data(bytes);
                        for h in headers.into_iter().flatten() {
                            resp.add_header(h);
                        }
                        req.respond(resp)
                    }
                    None => req.respond(tiny_http::Response::empty(404)),
                };
            }
        })?;
    }
    Ok(format!("http://127.0.0.1:{port}/{token}"))
}

/// Split a server request URL into the artwork path and query, if it carries the token prefix.
fn route(url: &str, prefix: &str) -> Option<(String, String)> {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let rest = path.strip_prefix(prefix)?;
    Some((format!("/{rest}"), query.to_string()))
}

/// The first artwork download that fails in a session goes to crash.log (server and path only,
/// never the query, which carries the Plex token), so "covers don't load" reports have a cause.
fn note_failure(state: &AppState, upstream: &str, why: &str) {
    static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        let shown = upstream.split('?').next().unwrap_or_default();
        crate::watchdog::append(state, &format!("artwork download failed ({why}): {shown}"));
    }
}

fn cache_file(state: &AppState, path: &str, size: u32) -> PathBuf {
    let key = hex::encode(Sha1::digest(format!("{path}|{size}").as_bytes()));
    state.dirs.art.join(&key[..2]).join(&key)
}

/// Local image file for an `art://` reference or an image URL, fetched into the cache if
/// needed. For consumers outside the webview, such as the Android media notification.
pub async fn cached_file(state: Arc<AppState>, art: &str, size: u32) -> Option<PathBuf> {
    let path = match art.strip_prefix("art://") {
        Some(rest) => format!("/{rest}"),
        None if art.starts_with("https://") || art.starts_with("http://") => format!("/url/{}", urlencoding::encode(art)),
        None => return None,
    };
    let size = bucket(size.clamp(32, 1200));
    serve(state.clone(), &path, &format!("s={size}")).await?;
    let file = match path.strip_prefix("/local/") {
        Some(name) => state.dirs.local_art.join(name),
        None => cache_file(&state, &path, size),
    };
    file.exists().then_some(file)
}

/// Resolve an artwork path (`/local/<file>`, `/plex/<thumb>`, `/url/<encoded>`) to image bytes,
/// from the disk cache or upstream.
async fn serve(state: Arc<AppState>, path: &str, query: &str) -> Option<Vec<u8>> {
    let path = path.to_string();
    let size: u32 = url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == "s")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(300)
        .clamp(32, 1200);
    let size = bucket(size);

    // Local embedded artwork extracted during scans.
    if let Some(name) = path.strip_prefix("/local/") {
        if name.contains("..") || name.contains('/') || name.contains('\\') {
            return None;
        }
        return tokio::fs::read(state.dirs.local_art.join(name)).await.ok();
    }

    let file = cache_file(&state, &path, size);
    if let Ok(b) = tokio::fs::read(&file).await {
        return Some(b);
    }

    // Plex: the photo transcoder (exact size) with the stored image as fallback; on phones the
    // stored image only, since slow transcodes leave covers blank there.
    let upstreams: Vec<String> = if let Some(thumb) = path.strip_prefix("/plex") {
        match state.plex_session.read().await.as_ref() {
            Some(sess) if cfg!(mobile) => vec![state.plex.thumb_url(sess, thumb)],
            Some(sess) => vec![state.plex.art_url(sess, thumb, size), state.plex.thumb_url(sess, thumb)],
            None => return None,
        }
    } else if let Some(enc) = path.strip_prefix("/url/") {
        match urlencoding::decode(enc) {
            Ok(u) if u.starts_with("https://") || u.starts_with("http://") => vec![sized_upstream(&u, size)],
            _ => return None,
        }
    } else {
        return None;
    };

    let _permit = state.art_slots.acquire().await;
    let mut bytes = None;
    for (i, upstream) in upstreams.iter().enumerate() {
        let timeout = std::time::Duration::from_secs(if i + 1 < upstreams.len() { 8 } else { 20 });
        match state.http.get(upstream).timeout(timeout).send().await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => {
                    bytes = Some(b.to_vec());
                    break;
                }
                Err(e) => note_failure(&state, upstream, &e.to_string()),
            },
            Ok(r) => note_failure(&state, upstream, &format!("HTTP {}", r.status())),
            Err(e) => note_failure(&state, upstream, &e.to_string()),
        };
    }
    let mut bytes = bytes?;
    if mime(&bytes).starts_with("image/") {
        // Off the async workers: decoding a large cover takes a few milliseconds.
        let original = bytes.clone();
        if let Ok(Some(small)) = tokio::task::spawn_blocking(move || shrink(&original, size)).await {
            bytes = small;
        }
        if let Some(dir) = file.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        // Write-then-rename: a crash never leaves a truncated image that later "hits" the cache.
        let tmp = file.with_extension("tmp");
        if tokio::fs::write(&tmp, &bytes).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &file).await;
        }
    }
    Some(bytes)
}

pub fn dir_size(p: &Path) -> u64 {
    walkdir::WalkDir::new(p)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Keep the artwork cache bounded: delete least-recently-modified files beyond the cap.
pub fn prune(dir: &Path) {
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path().to_path_buf(), m.len(), m.modified().ok()?))
        })
        .collect();
    let total: u64 = files.iter().map(|f| f.1).sum();
    if total <= MAX_CACHE_BYTES {
        return;
    }
    files.sort_by_key(|f| f.2);
    let mut excess = total - MAX_CACHE_BYTES * 8 / 10;
    for (p, len, _) in files {
        if excess == 0 {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            excess = excess.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_round_up_to_a_few_buckets() {
        assert_eq!(bucket(32), 128);
        assert_eq!(bucket(96), 128);
        assert_eq!(bucket(240), 300);
        assert_eq!(bucket(512), 640);
        assert_eq!(bucket(2000), 1200);
    }

    #[test]
    fn youtube_artwork_is_requested_at_the_shown_size() {
        assert_eq!(sized_upstream("https://lh3.googleusercontent.com/abc=w544-h544-l90-rj", 300), "https://lh3.googleusercontent.com/abc=w300-h300-l90-rj");
        assert_eq!(sized_upstream("https://yt3.ggpht.com/xyz=s88-c-k", 128), "https://yt3.ggpht.com/xyz=w128-h128-l90-rj");
        assert_eq!(sized_upstream("https://lh3.googleusercontent.com/plain", 640), "https://lh3.googleusercontent.com/plain=w640-h640-l90-rj");
        // Other hosts and video thumbnails are left alone.
        let yt = "https://i.ytimg.com/vi/abc/hqdefault.jpg";
        assert_eq!(sized_upstream(yt, 300), yt);
    }

    #[test]
    fn large_covers_are_stored_small() {
        let mut big = Vec::new();
        let img = image::RgbImage::from_fn(1500, 1500, |x, y| image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x * y) % 239) as u8]));
        image::DynamicImage::ImageRgb8(img).write_to(&mut std::io::Cursor::new(&mut big), image::ImageFormat::Png).unwrap();
        let small = shrink(&big, 300).expect("shrunk");
        assert!(small.len() < big.len() / 4, "{} -> {}", big.len(), small.len());
        let back = image::load_from_memory(&small).unwrap();
        assert_eq!((back.width(), back.height()), (300, 300));
        // Already small: kept as is.
        assert!(shrink(&small, 640).is_none());
        assert!(shrink(b"not an image", 300).is_none());
    }

    #[test]
    fn upgrading_clears_old_full_size_cache_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("ab")).unwrap();
        std::fs::write(dir.path().join("ab").join("old"), b"x").unwrap();
        upgrade_cache(dir.path());
        assert!(!dir.path().join("ab").exists());
        std::fs::create_dir_all(dir.path().join("cd")).unwrap();
        upgrade_cache(dir.path());
        assert!(dir.path().join("cd").exists(), "only the first run clears");
    }

    #[test]
    fn server_routes_only_tokened_urls() {
        let p = "/tok123/";
        assert_eq!(route("/tok123/url/https%3A%2F%2Fx%2Fy.jpg?s=300", p), Some(("/url/https%3A%2F%2Fx%2Fy.jpg".into(), "s=300".into())));
        assert_eq!(route("/tok123/plex/library/metadata/1/thumb/2", p), Some(("/plex/library/metadata/1/thumb/2".into(), "".into())));
        assert_eq!(route("/url/https%3A%2F%2Fx", p), None);
        assert_eq!(route("/other/url/x", p), None);
    }
}

