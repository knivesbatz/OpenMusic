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

const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;

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
    let size = size.clamp(32, 1200);
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

    let upstream = if let Some(thumb) = path.strip_prefix("/plex") {
        match state.plex_session.read().await.as_ref() {
            Some(sess) => state.plex.art_url(sess, thumb, size),
            None => return None,
        }
    } else if let Some(enc) = path.strip_prefix("/url/") {
        match urlencoding::decode(enc) {
            Ok(u) if u.starts_with("https://") || u.starts_with("http://") => u.into_owned(),
            _ => return None,
        }
    } else {
        return None;
    };

    let _permit = state.art_slots.acquire().await;
    let bytes = match state.http.get(&upstream).timeout(std::time::Duration::from_secs(20)).send().await {
        Ok(r) if r.status().is_success() => match r.bytes().await {
            Ok(b) => b.to_vec(),
            Err(_) => return None,
        },
        _ => return None,
    };
    if mime(&bytes).starts_with("image/") {
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
    fn server_routes_only_tokened_urls() {
        let p = "/tok123/";
        assert_eq!(route("/tok123/url/https%3A%2F%2Fx%2Fy.jpg?s=300", p), Some(("/url/https%3A%2F%2Fx%2Fy.jpg".into(), "s=300".into())));
        assert_eq!(route("/tok123/plex/library/metadata/1/thumb/2", p), Some(("/plex/library/metadata/1/thumb/2".into(), "".into())));
        assert_eq!(route("/url/https%3A%2F%2Fx", p), None);
        assert_eq!(route("/other/url/x", p), None);
    }
}

