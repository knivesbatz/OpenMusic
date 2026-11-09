//! Offline downloads. Plex: the server hands out the original file (honouring its own "allow
//! downloads" permission). YouTube Music: the UI works out the song's audio stream URL (with its
//! PO token, see ui/src/ytdl.ts) and [`run_youtube`] fetches it in ranges, as
//! github.com/Chaitanya-Shahare/ytspot does (MIT).
//!
//! Files stream into `<id>.part` and are renamed only after the full body arrived, so an
//! interrupted download can never be mistaken for a complete one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::now;
use crate::error::{Error, Result};
use crate::model::{Source, Track};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub track: Track,
    /// queued | downloading | done | failed | cancelled
    pub status: String,
    pub bytes: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

fn safe_name(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
}

fn set_status(state: &AppState, id: &str, status: &str, bytes: u64, total: Option<u64>, error: Option<&str>, path: Option<&str>) {
    let db = state.db();
    let _ = db.conn.execute(
        "UPDATE downloads SET status=?2, bytes=?3, total=?4, error=?5, path=COALESCE(?6,path), updated_at=?7 WHERE track_id=?1",
        params![id, status, bytes as i64, total.map(|t| t as i64), error, path, now()],
    );
}

pub fn list(state: &AppState) -> Result<Vec<DownloadInfo>> {
    let db = state.db();
    let mut st = db.conn.prepare("SELECT track_json,status,bytes,total,error FROM downloads ORDER BY updated_at DESC")?;
    let rows = st.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<i64>>(3)?, r.get::<_, Option<String>>(4)?))
    })?;
    Ok(rows
        .filter_map(|r| r.ok())
        .filter_map(|(j, status, bytes, total, error)| {
            Some(DownloadInfo { track: serde_json::from_str(&j).ok()?, status, bytes: bytes as u64, total: total.map(|t| t as u64), error })
        })
        .collect())
}

/// Path of a completed download that still exists on disk.
pub fn offline_path(state: &AppState, id: &str) -> Option<String> {
    let db = state.db();
    let p: Option<String> = db
        .conn
        .query_row("SELECT path FROM downloads WHERE track_id=?1 AND status='done'", [id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    p.filter(|p| std::path::Path::new(p).exists())
}

/// Interrupted downloads from a previous run are marked failed (their partial files removed) so
/// the user can retry; they are never treated as complete.
pub fn recover(state: &AppState) {
    let db = state.db();
    let _ = db.conn.execute(
        "UPDATE downloads SET status='failed', error='interrupted' WHERE status IN ('queued','downloading')",
        [],
    );
    if let Ok(rd) = std::fs::read_dir(&state.dirs.downloads) {
        for e in rd.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) == Some("part") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

pub fn enqueue(app: AppHandle, state: Arc<AppState>, tracks: Vec<Track>) -> Result<usize> {
    // Plex items only; nothing else can be downloaded.
    if !state.on(crate::state::Provider::Plex) {
        return Err(Error::Disabled(crate::state::Provider::Plex));
    }
    let mut queued = 0;
    for t in tracks.into_iter().filter(|t| t.source == Source::Plex) {
        {
            let db = state.db();
            let existing: Option<String> = db
                .conn
                .query_row("SELECT status FROM downloads WHERE track_id=?1", [&t.id], |r| r.get(0))
                .optional()?;
            if matches!(existing.as_deref(), Some("done") | Some("queued") | Some("downloading")) {
                continue; // no duplicate downloads
            }
            db.conn.execute(
                "INSERT INTO downloads(track_id,track_json,status,bytes,updated_at) VALUES(?1,?2,'queued',0,?3)
                 ON CONFLICT(track_id) DO UPDATE SET status='queued', bytes=0, error=NULL, updated_at=excluded.updated_at",
                params![t.id, serde_json::to_string(&t)?, now()],
            )?;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        state.downloads.lock().unwrap().insert(t.id.clone(), cancel.clone());
        queued += 1;
        let (app, state) = (app.clone(), state.clone());
        tauri::async_runtime::spawn(async move {
            let id = t.id.clone();
            let result = run(&app, &state, &t, &cancel).await;
            state.downloads.lock().unwrap().remove(&id);
            match result {
                Ok(()) => {}
                Err(Error::Cancelled) => set_status(&state, &id, "cancelled", 0, None, None, None),
                Err(e) => set_status(&state, &id, "failed", 0, None, Some(&e.to_string()), None),
            }
            let _ = app.emit("downloads-changed", &id);
        });
    }
    Ok(queued)
}

async fn run(app: &AppHandle, state: &AppState, t: &Track, cancel: &AtomicBool) -> Result<()> {
    let _slot = state.download_slots.acquire().await.map_err(|_| Error::Cancelled)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::Cancelled);
    }
    let sess = state.plex_session().await?;
    let url = state.plex.download_url(&sess, t)?;
    let ext = t
        .stream_key
        .as_deref()
        .and_then(|k| k.rsplit('.').next())
        .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("audio");
    tokio::fs::create_dir_all(&state.dirs.downloads).await?;
    let final_path = state.dirs.downloads.join(format!("{}.{ext}", safe_name(&t.id)));
    let part = final_path.with_extension(format!("{ext}.part"));
    let resp = state.http.get(&url).send().await?;
    if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 {
        return Err(Error::Unsupported("the server does not allow downloads for this account".into()));
    }
    let resp = resp.error_for_status()?;
    let total = resp.content_length();
    set_status(state, &t.id, "downloading", 0, total, None, None);
    let mut file = tokio::fs::File::create(&part).await?;
    let mut stream = resp.bytes_stream();
    let mut bytes = 0u64;
    let mut last_emit = std::time::Instant::now();
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(Error::Cancelled);
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(e.into());
            }
        };
        file.write_all(&chunk).await?;
        bytes += chunk.len() as u64;
        if last_emit.elapsed().as_millis() > 400 {
            last_emit = std::time::Instant::now();
            set_status(state, &t.id, "downloading", bytes, total, None, None);
            let _ = app.emit("download-progress", serde_json::json!({ "id": t.id, "bytes": bytes, "total": total }));
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    if let Some(total) = total {
        if bytes != total {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(Error::Invalid(format!("incomplete download ({bytes} of {total} bytes)")));
        }
    }
    tokio::fs::rename(&part, &final_path).await?;
    set_status(state, &t.id, "done", bytes, Some(bytes), None, Some(&final_path.to_string_lossy()));
    Ok(())
}

/// The browser YouTube Music's web player runs in, for the media requests.
const YT_BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/// YouTube's media servers send at most this much per request (the size yt-dlp asks for).
const YT_CHUNK: u64 = 10 * 1024 * 1024;

/// Whether a stream URL the UI handed over is one of YouTube's media servers.
pub fn is_youtube_media_url(url: &str) -> bool {
    // Only https and only YouTube's media hosts: the URL comes from the web view.
    reqwest::Url::parse(url).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| h.ends_with(".googlevideo.com")))
}

/// Mark YouTube songs as queued (the UI resolves their streams one by one); returns the ones to
/// fetch, leaving out those done or already on their way.
pub fn queue_youtube(state: &AppState, tracks: &[Track]) -> Result<Vec<Track>> {
    let db = state.db();
    let mut out = Vec::new();
    for t in tracks.iter().filter(|t| t.source == Source::Youtube) {
        let existing: Option<String> = db.conn.query_row("SELECT status FROM downloads WHERE track_id=?1", [&t.id], |r| r.get(0)).optional()?;
        if matches!(existing.as_deref(), Some("done") | Some("queued") | Some("downloading")) {
            continue;
        }
        db.conn.execute(
            "INSERT INTO downloads(track_id,track_json,status,bytes,updated_at) VALUES(?1,?2,'queued',0,?3)
             ON CONFLICT(track_id) DO UPDATE SET status='queued', bytes=0, error=NULL, updated_at=excluded.updated_at",
            params![t.id, serde_json::to_string(t)?, now()],
        )?;
        out.push(t.clone());
    }
    Ok(out)
}

/// Mark a queued YouTube song failed (its stream couldn't be worked out).
pub fn fail(state: &AppState, id: &str, error: &str) {
    set_status(state, id, "failed", 0, None, Some(error), None);
}

/// Fetch a YouTube song's audio from `url` (`size` bytes, `ext` "m4a" or "webm") in ranges into
/// the downloads folder. A 403 is reported as "(403)" so the UI can retry with a fresh PO token.
pub async fn run_youtube(app: &AppHandle, state: &AppState, t: &Track, url: &str, size: u64, ext: &str) -> Result<()> {
    if !is_youtube_media_url(url) || !matches!(ext, "m4a" | "webm") || size == 0 {
        return Err(Error::Invalid("not a YouTube audio stream".into()));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    state.downloads.lock().unwrap().insert(t.id.clone(), cancel.clone());
    let r = fetch_ranges(app, state, t, url, size, ext, &cancel).await;
    state.downloads.lock().unwrap().remove(&t.id);
    match &r {
        Ok(()) => {}
        Err(Error::Cancelled) => set_status(state, &t.id, "cancelled", 0, None, None, None),
        Err(e) => set_status(state, &t.id, "failed", 0, None, Some(&e.to_string()), None),
    }
    let _ = app.emit("downloads-changed", &t.id);
    r
}

async fn fetch_ranges(app: &AppHandle, state: &AppState, t: &Track, url: &str, size: u64, ext: &str, cancel: &AtomicBool) -> Result<()> {
    let _slot = state.download_slots.acquire().await.map_err(|_| Error::Cancelled)?;
    tokio::fs::create_dir_all(&state.dirs.downloads).await?;
    let final_path = state.dirs.downloads.join(format!("{}.{ext}", safe_name(&t.id)));
    let part = final_path.with_extension(format!("{ext}.part"));
    set_status(state, &t.id, "downloading", 0, Some(size), None, None);
    let mut file = tokio::fs::File::create(&part).await?;
    let result = async {
        use tokio::io::AsyncWriteExt;
        let mut at = 0u64;
        let mut last_emit = std::time::Instant::now();
        while at < size {
            let end = (at + YT_CHUNK).min(size) - 1;
            // As YouTube Music's web player asks for it (the stream was worked out as that client).
            let resp = state
                .http
                .get(url)
                .header("Range", format!("bytes={at}-{end}"))
                .header("User-Agent", YT_BROWSER_UA)
                .header("Origin", "https://music.youtube.com")
                .header("Referer", "https://music.youtube.com/")
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await?;
            let status = resp.status().as_u16();
            if !resp.status().is_success() {
                return Err(Error::Invalid(format!("YouTube refused the download ({status})")));
            }
            let from = at;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                if cancel.load(Ordering::Relaxed) {
                    return Err(Error::Cancelled);
                }
                let chunk = chunk?;
                file.write_all(&chunk).await?;
                at += chunk.len() as u64;
                if last_emit.elapsed().as_millis() > 400 {
                    last_emit = std::time::Instant::now();
                    set_status(state, &t.id, "downloading", at, Some(size), None, None);
                    let _ = app.emit("download-progress", serde_json::json!({ "id": t.id, "bytes": at, "total": size }));
                }
            }
            // An empty answer would otherwise ask for the same bytes forever.
            if at == from {
                return Err(Error::Invalid("YouTube sent no audio".into()));
            }
        }
        if at != size {
            return Err(Error::Invalid(format!("incomplete download ({at} of {size} bytes)")));
        }
        file.flush().await?;
        file.sync_all().await?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e);
    }
    tokio::fs::rename(&part, &final_path).await?;
    set_status(state, &t.id, "done", size, Some(size), None, Some(&final_path.to_string_lossy()));
    Ok(())
}

pub fn cancel(state: &AppState, id: &str) {
    if let Some(flag) = state.downloads.lock().unwrap().get(id) {
        flag.store(true, Ordering::Relaxed);
    }
}

pub fn remove(state: &AppState, id: &str) -> Result<()> {
    cancel(state, id);
    let path: Option<String> = {
        let db = state.db();
        let p = db.conn.query_row("SELECT path FROM downloads WHERE track_id=?1", [id], |r| r.get(0)).optional()?.flatten();
        db.conn.execute("DELETE FROM downloads WHERE track_id=?1", [id])?;
        p
    };
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yt(id: &str) -> Track {
        serde_json::from_value(serde_json::json!({ "id": format!("yt:{id}"), "source": "youtube", "title": id, "streamKey": id })).unwrap()
    }

    #[test]
    fn youtube_media_urls_only() {
        assert!(is_youtube_media_url("https://rr4---sn-tt1e7nl6.googlevideo.com/videoplayback?itag=140"));
        assert!(!is_youtube_media_url("http://rr4---sn-tt1e7nl6.googlevideo.com/videoplayback"));
        assert!(!is_youtube_media_url("https://googlevideo.com.evil.example/videoplayback"));
        assert!(!is_youtube_media_url("file:///etc/passwd"));
    }

    #[test]
    fn queue_youtube_skips_songs_done_or_on_their_way() {
        let state = crate::state::test_state();
        let (a, b) = (yt("a"), yt("b"));
        assert_eq!(queue_youtube(&state, &[a.clone(), b.clone()]).unwrap().len(), 2);
        assert!(queue_youtube(&state, std::slice::from_ref(&a)).unwrap().is_empty(), "already queued");
        fail(&state, &a.id, "no network");
        assert_eq!(queue_youtube(&state, &[a.clone(), b]).unwrap().len(), 1, "a failed song can be retried");
        let listed = list(&state).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|d| d.status == "queued"));
    }
}
