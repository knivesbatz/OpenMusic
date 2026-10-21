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
    let path = uri.path().to_string();
    let query = uri.query().unwrap_or("").to_string();
    let size: u32 = url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == "s")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(300)
        .clamp(32, 1200);

    // Local embedded artwork extracted during scans.
    if let Some(name) = path.strip_prefix("/local/") {
        if name.contains("..") || name.contains('/') || name.contains('\\') {
            return not_found();
        }
        return match tokio::fs::read(state.dirs.local_art.join(name)).await {
            Ok(b) => respond(b),
            Err(_) => not_found(),
        };
    }

    let key = hex::encode(Sha1::digest(format!("{path}|{size}").as_bytes()));
    let file = state.dirs.art.join(&key[..2]).join(&key);
    if let Ok(b) = tokio::fs::read(&file).await {
        return respond(b);
    }

    let upstream = if let Some(thumb) = path.strip_prefix("/plex") {
        match state.plex_session.read().await.as_ref() {
            Some(sess) => state.plex.art_url(sess, thumb, size),
            None => return not_found(),
        }
    } else if let Some(enc) = path.strip_prefix("/url/") {
        match urlencoding::decode(enc) {
            Ok(u) if u.starts_with("https://") || u.starts_with("http://") => u.into_owned(),
            _ => return not_found(),
        }
    } else {
        return not_found();
    };

    let _permit = state.art_slots.acquire().await;
    let bytes = match state.http.get(&upstream).timeout(std::time::Duration::from_secs(20)).send().await {
        Ok(r) if r.status().is_success() => match r.bytes().await {
            Ok(b) => b.to_vec(),
            Err(_) => return not_found(),
        },
        _ => return not_found(),
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
    respond(bytes)
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
