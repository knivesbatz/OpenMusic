//! Offline downloads (Plex only — the server hands out the original file to authorized users,
//! honouring its own "allow downloads" permission). YouTube audio is not downloadable through
//! any supported interface, so YTSpot reports downloads as unavailable instead of faking them.
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
    if state.flavor != crate::Flavor::Plex {
        return Err(Error::Unsupported("downloads are not available for this provider".into()));
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
