//! One-time import of PLEXSpot 1.x data into OpenSpot (desktop only).
//!
//! OpenSpot keeps YTSpot's identifier (`app.openmusic.ytspot`), so a YTSpot install upgrades in
//! place. PLEXSpot's data lives in the sibling folder `<app data>/../app.openmusic.plexspot` and in
//! the credential store under its own service name. At startup [`run`] brings it over:
//!
//! - **db**: PLEXSpot's library.db, opened read-only (its `-wal` is read by SQLite, nothing is
//!   written there), is merged into ours: app playlists and their tracks (an id that already exists
//!   here gets a new one), listening history (re-ordered by play time), saved albums / artists /
//!   podcasts / episodes, hidden playlists, local folders and tracks, the scrobble queue, downloads,
//!   and the kv entries by the rules in [`merge_kv`]. The response cache is never copied.
//! - **files**: `local-art/*` is copied, `downloads/*` is moved (renamed, or copied and deleted
//!   across volumes) and the download rows are pointed at the new paths.
//! - **secrets**: a fixed list of entries is copied into empty slots only. On macOS each read can
//!   bring up a keychain prompt, so this step runs from [`run_secrets_later`] once the window shows.
//!
//! Each step has its own kv marker (`migrated.plexspot.db`, `.files`, `.secrets`), set only when the
//! step succeeded, so a failed step is tried again at the next start. Nothing here ever fails the
//! app's start: errors go to crash.log. After every step has succeeded, the copied PLEXSpot
//! credentials and its `updates/` folder are deleted; its library.db stays as a safety copy.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::db::{now, Db};
use crate::error::{Error, Result};
use crate::secrets::{self, Secrets, Store};

/// PLEXSpot's identifier: its data folder name and its credential-store service.
pub const PLEXSPOT_ID: &str = "app.openmusic.plexspot";

const MARK_DB: &str = "migrated.plexspot.db";
const MARK_FILES: &str = "migrated.plexspot.files";
const MARK_SECRETS: &str = "migrated.plexspot.secrets";
/// Set once every step succeeded and the leftovers were cleaned up.
const MARK_DONE: &str = "migrated.plexspot";

/// Facts about this data folder recorded before the import (the services defaults are computed
/// from them, so imported PLEXSpot settings never switch YouTube Music on).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Before {
    /// kv `settings` existed (YTSpot was used here).
    pub had_own_settings: bool,
    /// A YouTube sign-in is stored (the read succeeded and found one).
    pub had_yt_cookie: bool,
    /// The user chose "local files only" in YTSpot.
    pub had_local_only: bool,
}

pub fn before(db: &Db, ours: &Secrets) -> Before {
    before_with(db, ours)
}

fn before_with(db: &Db, ours: &impl Store) -> Before {
    Before {
        had_own_settings: matches!(db.kv_get::<Value>("settings"), Ok(Some(_))),
        had_yt_cookie: matches!(ours.get("yt.cookie"), Ok(Some(_))),
        had_local_only: matches!(db.kv_get::<bool>("ui.localOnly"), Ok(Some(true))),
    }
}

/// Imports what has not been imported yet. Infallible; skipped silently when PLEXSpot was never
/// installed. On macOS the secrets step is left to [`run_secrets_later`].
pub fn run(data_dir: &Path, db: &Db, ours: &Secrets) {
    if cfg!(mobile) {
        return;
    }
    let Some(theirs_dir) = sibling(data_dir) else { return };
    let theirs = Secrets::new(PLEXSPOT_ID, &theirs_dir);
    run_with(data_dir, &theirs_dir, db, ours, &theirs, !cfg!(target_os = "macos"));
}

/// macOS: the secrets step (and the cleanup that follows a full import), run after the main
/// window is shown, because reading PLEXSpot's keychain items asks the user. A denial only means
/// "sign in to Plex again"; it is retried at the next start. Elsewhere this does nothing.
pub fn run_secrets_later(data_dir: &Path, db: &Db, ours: &Secrets) {
    if cfg!(mobile) || !cfg!(target_os = "macos") {
        return;
    }
    let Some(theirs_dir) = sibling(data_dir) else { return };
    if plexspot_running() {
        return;
    }
    let theirs = Secrets::new(PLEXSPOT_ID, &theirs_dir);
    secrets_step(data_dir, &theirs_dir, db, ours, &theirs);
    cleanup(data_dir, &theirs_dir, db, &theirs);
}

/// PLEXSpot's data folder next to ours, if it exists (and ours is not it).
fn sibling(data_dir: &Path) -> Option<PathBuf> {
    let dir = data_dir.parent()?.join(PLEXSPOT_ID);
    (dir.is_dir() && dir != data_dir).then_some(dir)
}

fn run_with(data_dir: &Path, theirs_dir: &Path, db: &Db, ours: &impl Store, theirs: &impl Store, secrets_now: bool) {
    if marked(db, MARK_DONE) {
        return;
    }
    if plexspot_running() {
        note(data_dir, "PLEXSpot is running; its library is imported at the next start");
        return;
    }
    if !marked(db, MARK_DB) {
        match import_db(db, theirs_dir) {
            Ok(mtime) => mark(data_dir, db, MARK_DB, json!({ "at": now(), "mtime": mtime })),
            Err(e) => note(data_dir, &format!("database import failed: {e}")),
        }
    }
    // Files only after the rows: the moved downloads' rows must be here to be rewritten.
    if marked(db, MARK_DB) && !marked(db, MARK_FILES) {
        match import_files(data_dir, theirs_dir, db) {
            Ok(()) => mark(data_dir, db, MARK_FILES, json!({ "at": now() })),
            Err(e) => note(data_dir, &format!("file import failed: {e}")),
        }
    }
    if secrets_now {
        secrets_step(data_dir, theirs_dir, db, ours, theirs);
    }
    cleanup(data_dir, theirs_dir, db, theirs);
}

fn secrets_step(data_dir: &Path, theirs_dir: &Path, db: &Db, ours: &impl Store, theirs: &impl Store) {
    if marked(db, MARK_DONE) || marked(db, MARK_SECRETS) {
        return;
    }
    match import_secrets(db, theirs_dir, ours, theirs) {
        Ok(copied) => mark(data_dir, db, MARK_SECRETS, json!({ "at": now(), "copied": copied })),
        Err(e) => note(data_dir, &format!("sign-in import failed (sign in to Plex again if it persists): {e}")),
    }
}

/// After every step succeeded: delete the PLEXSpot credentials that were copied and its
/// downloaded 1.x installers. Its library.db stays. Best effort, done once.
fn cleanup(data_dir: &Path, theirs_dir: &Path, db: &Db, theirs: &impl Store) {
    if marked(db, MARK_DONE) || !(marked(db, MARK_DB) && marked(db, MARK_FILES) && marked(db, MARK_SECRETS)) {
        return;
    }
    let copied: Vec<String> = db
        .kv_get::<Value>(MARK_SECRETS)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v.get("copied")?.clone()).ok())
        .unwrap_or_default();
    for name in &copied {
        let res = if LARGE_SECRETS.contains(&name.as_str()) { secrets::delete_large(theirs, name) } else { theirs.delete(name) };
        if let Err(e) = res {
            note(data_dir, &format!("could not remove PLEXSpot's {name}: {e}"));
        }
    }
    let updates = theirs_dir.join("updates");
    if updates.exists() {
        if let Err(e) = std::fs::remove_dir_all(&updates) {
            note(data_dir, &format!("could not remove PLEXSpot's updates folder: {e}"));
        }
    }
    mark(data_dir, db, MARK_DONE, json!(true));
    log::info!("PLEXSpot data imported");
}

// ---- markers and logging ----------------------------------------------------------------------

fn marked(db: &Db, key: &str) -> bool {
    matches!(db.kv_get::<Value>(key), Ok(Some(_)))
}

fn mark(data_dir: &Path, db: &Db, key: &str, value: Value) {
    if let Err(e) = db.kv_set(key, &value) {
        note(data_dir, &format!("could not save {key}: {e}"));
    }
}

/// Failures go to crash.log (shown in Settings) like other diagnostics. Never a secret value.
fn note(data_dir: &Path, msg: &str) {
    use std::io::Write;
    log::warn!("PLEXSpot import: {msg}");
    let path = data_dir.join("crash.log");
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{}] v{} PLEXSpot import: {msg}", now(), env!("CARGO_PKG_VERSION"));
    }
}

/// macOS has no installer hook to quit PLEXSpot 1.x: importing from a live app would miss what
/// it writes afterwards, so the import waits (no marker) until it is closed.
#[cfg(target_os = "macos")]
fn plexspot_running() -> bool {
    std::process::Command::new("pgrep")
        .args(["-x", "PLEXSpot"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn plexspot_running() -> bool {
    false
}

// ---- database -------------------------------------------------------------------------------

/// Merges PLEXSpot's library.db into ours in one transaction. Returns the file's mtime (unix
/// seconds), kept in the marker. A missing database counts as imported.
fn import_db(db: &Db, theirs_dir: &Path) -> Result<Option<i64>> {
    let path = theirs_dir.join("library.db");
    if !path.exists() {
        return Ok(None);
    }
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    let src = open_theirs(&path)?;
    let tx = db.conn.unchecked_transaction()?;
    merge(db, &src)?;
    tx.commit()?;
    Ok(mtime)
}

/// Read-only: PLEXSpot's folder is left exactly as it was (no schema migration runs there).
fn open_theirs(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(std::time::Duration::from_secs(3))?;
    Ok(conn)
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut st = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = st.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(cols)
}

/// The columns both databases have (an older PLEXSpot schema may lack newer ones), minus `skip`.
fn shared_columns(src: &Connection, dst: &Connection, table: &str, skip: &[&str]) -> Result<Vec<String>> {
    let ours = columns(dst, table)?;
    Ok(columns(src, table)?.into_iter().filter(|c| ours.contains(c) && !skip.contains(&c.as_str())).collect())
}

fn read_rows(src: &Connection, table: &str, cols: &[String], order: &str) -> Result<Vec<Vec<SqlValue>>> {
    let sql = format!("SELECT {} FROM {table} {order}", cols.join(","));
    let mut st = src.prepare(&sql)?;
    let n = cols.len();
    let rows = st
        .query_map([], |r| (0..n).map(|i| r.get::<_, SqlValue>(i)).collect::<rusqlite::Result<Vec<_>>>())?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn insert_rows(dst: &Connection, table: &str, cols: &[String], rows: &[Vec<SqlValue>]) -> Result<()> {
    let marks = (1..=cols.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let mut st = dst.prepare(&format!("INSERT OR IGNORE INTO {table}({}) VALUES({marks})", cols.join(",")))?;
    for row in rows {
        st.execute(rusqlite::params_from_iter(row.iter()))?;
    }
    Ok(())
}

/// Copies a whole table, keeping our row wherever the key already exists.
fn copy_table(src: &Connection, dst: &Connection, table: &str, skip: &[&str], order: &str) -> Result<usize> {
    if columns(src, table)?.is_empty() {
        return Ok(0); // an older PLEXSpot without this table
    }
    let cols = shared_columns(src, dst, table, skip)?;
    if cols.is_empty() {
        return Ok(0);
    }
    let rows = read_rows(src, table, &cols, order)?;
    insert_rows(dst, table, &cols, &rows)?;
    Ok(rows.len())
}

fn merge(db: &Db, src: &Connection) -> Result<()> {
    let dst = &db.conn;
    let remap = merge_playlists(src, dst)?;
    for table in ["hidden_playlists", "saved", "local_folders", "local_tracks", "downloads"] {
        copy_table(src, dst, table, &[], "")?;
    }
    copy_table(src, dst, "scrobbles", &["id"], "ORDER BY id")?;
    if copy_table(src, dst, "history", &["id"], "ORDER BY id")? > 0 {
        // Ids give the history its order (newest = highest), so renumber both apps' plays by time.
        dst.execute_batch(
            "CREATE TEMP TABLE migrate_history AS
               SELECT track_id, track_json, played_at, context_kind, context_id, context_title, context_artwork
               FROM history ORDER BY played_at, id;
             DELETE FROM history;
             INSERT INTO history(track_id, track_json, played_at, context_kind, context_id, context_title, context_artwork)
               SELECT track_id, track_json, played_at, context_kind, context_id, context_title, context_artwork
               FROM migrate_history ORDER BY rowid;
             DROP TABLE migrate_history;
             DELETE FROM history WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET 5000);",
        )?;
    }
    merge_kv(db, src, &remap)
}

/// App playlists and their tracks. A PLEXSpot playlist whose id exists here (one sent between the
/// apps with "Sync") gets a new id, so neither copy is lost. Returns old id -> new id.
fn merge_playlists(src: &Connection, dst: &Connection) -> Result<HashMap<String, String>> {
    let mut remap = HashMap::new();
    if columns(src, "playlists")?.is_empty() {
        return Ok(remap);
    }
    let cols = shared_columns(src, dst, "playlists", &[])?;
    let id_at = cols.iter().position(|c| c == "id").ok_or_else(|| Error::Invalid("playlists without id".into()))?;
    let marks = (1..=cols.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let mut insert = dst.prepare(&format!("INSERT INTO playlists({}) VALUES({marks})", cols.join(",")))?;
    for mut row in read_rows(src, "playlists", &cols, "")? {
        let SqlValue::Text(id) = row[id_at].clone() else { continue };
        let taken = dst.query_row("SELECT 1 FROM playlists WHERE id=?1", [&id], |_| Ok(())).optional()?.is_some();
        if taken {
            let new = format!("app:{}", uuid::Uuid::new_v4().simple());
            row[id_at] = SqlValue::Text(new.clone());
            remap.insert(id, new);
        }
        insert.execute(rusqlite::params_from_iter(row.iter()))?;
    }
    if columns(src, "playlist_items")?.is_empty() {
        return Ok(remap);
    }
    let cols = shared_columns(src, dst, "playlist_items", &["id"])?;
    let pl_at = cols.iter().position(|c| c == "playlist_id").ok_or_else(|| Error::Invalid("playlist_items without playlist_id".into()))?;
    let mut rows = read_rows(src, "playlist_items", &cols, "ORDER BY playlist_id, position, id")?;
    for row in rows.iter_mut() {
        if let SqlValue::Text(id) = &row[pl_at] {
            if let Some(new) = remap.get(id) {
                row[pl_at] = SqlValue::Text(new.clone());
            }
        }
    }
    insert_rows(dst, "playlist_items", &cols, &rows)?;
    Ok(remap)
}

/// Kv entries that stay ours: per-app state, provider sessions the other app never had, the
/// markers, and Last.fm (moved with its session key in the secrets step).
fn kv_skipped(key: &str) -> bool {
    key.starts_with("yt.")
        || key.starts_with("ui.yt.")
        || key.starts_with("ui.update.")
        || key.starts_with("migrated.")
        || key.starts_with("lastfm.")
        || matches!(key, "services" | "local.lastScan" | "ui.localOnly")
}

/// The kv rules:
/// - `settings`: per key, ours wins.
/// - `ui.libraryOrg`: see [`merge_library_org`].
/// - `ui.playlistSort`, `ui.podcastOldestFirst`, `playlist.covers`: union by key, ours wins.
/// - `plex.*`, `ui.plex.*` and `clientId` (plex.tv knows the device by it): PLEXSpot's, unless
///   Plex is already signed in here (kv `plex.account`), then ours stay.
/// - `ui.profile`: only if ours is empty.
/// - anything else not in [`kv_skipped`]: only if ours has none.
fn merge_kv(db: &Db, src: &Connection, remap: &HashMap<String, String>) -> Result<()> {
    if columns(src, "kv")?.is_empty() {
        return Ok(());
    }
    let theirs: Vec<(String, String)> = {
        let mut st = src.prepare("SELECT key, value FROM kv")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let ours_has_plex = db.kv_get::<Value>("plex.account")?.is_some();
    for (key, raw) in theirs {
        if kv_skipped(&key) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&raw) else { continue };
        let mine = db.kv_get::<Value>(&key)?;
        let merged = match key.as_str() {
            "settings" => Some(union_objects(mine, value, &HashMap::new())),
            "ui.libraryOrg" => Some(merge_library_org(mine, value, remap)),
            "ui.playlistSort" => Some(union_objects(mine, value, remap)),
            "ui.podcastOldestFirst" | "playlist.covers" => Some(union_objects(mine, value, &HashMap::new())),
            "clientId" => (!ours_has_plex).then_some(value),
            k if k.starts_with("plex.") || k.starts_with("ui.plex.") => (!ours_has_plex).then_some(value),
            "ui.profile" => profile_empty(mine.as_ref()).then_some(value),
            _ => mine.is_none().then_some(value),
        };
        if let Some(v) = merged {
            db.kv_set(&key, &v)?;
        }
    }
    Ok(())
}

fn profile_empty(p: Option<&Value>) -> bool {
    let set = |k: &str| p.and_then(|p| p.get(k)).and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty());
    !set("name") && !set("photo")
}

/// Ours with every key of theirs it lacks (theirs' keys renamed through `remap`). When either is
/// not an object, ours wins (or theirs, if ours is missing).
fn union_objects(mine: Option<Value>, theirs: Value, remap: &HashMap<String, String>) -> Value {
    match (mine, theirs) {
        (Some(Value::Object(mut m)), Value::Object(t)) => {
            for (k, v) in t {
                let k = remap.get(&k).cloned().unwrap_or(k);
                m.entry(k).or_insert(v);
            }
            Value::Object(m)
        }
        (None, Value::Object(t)) => Value::Object(t.into_iter().map(|(k, v)| (remap.get(&k).cloned().unwrap_or(k), v)).collect()),
        (Some(m), _) => m,
        (None, t) => t,
    }
}

/// Your Library's folders and order (ui/src/store/folders.ts `LibraryOrg`):
/// - PLEXSpot's folders are added; a folder id already used here gets a new one.
/// - A playlist ours already places (in a folder or in the order) keeps our place.
/// - `order` is ours, then PLEXSpot's entries not already in it; `added` is the union.
/// - `sort` and `view` stay ours.
///
/// Remapped playlist ids and folder ids are rewritten everywhere (`folder:<id>` included).
fn merge_library_org(mine: Option<Value>, theirs: Value, remap: &HashMap<String, String>) -> Value {
    let Value::Object(t) = theirs else { return mine.unwrap_or(Value::Null) };
    let mut m = match mine {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    let strs = |v: Option<&Value>| -> Vec<String> {
        v.and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
    };
    let our_folders: Vec<Value> = m.get("folders").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    let mut our_order = strs(m.get("order"));
    let mut folder_ids: HashSet<String> = our_folders.iter().filter_map(|f| f.get("id")?.as_str().map(String::from)).collect();
    let mut placed: HashSet<String> = our_order.iter().cloned().collect();
    for f in &our_folders {
        placed.extend(strs(f.get("items")));
    }

    // Theirs' folder ids, renamed where they collide with ours.
    let mut folder_remap: HashMap<String, String> = HashMap::new();
    let their_folders: Vec<Value> = t.get("folders").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    for f in &their_folders {
        let Some(id) = f.get("id").and_then(|i| i.as_str()) else { continue };
        if folder_ids.contains(id) {
            let new = loop {
                let candidate = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
                if !folder_ids.contains(&candidate) {
                    break candidate;
                }
            };
            folder_remap.insert(id.to_string(), new.clone());
            folder_ids.insert(new);
        } else {
            folder_ids.insert(id.to_string());
        }
    }
    let rename = |entry: &str| -> String {
        if let Some(fid) = entry.strip_prefix("folder:") {
            return format!("folder:{}", folder_remap.get(fid).map(String::as_str).unwrap_or(fid));
        }
        remap.get(entry).cloned().unwrap_or_else(|| entry.to_string())
    };

    let mut folders = our_folders;
    for f in their_folders {
        let Value::Object(mut f) = f else { continue };
        let Some(id) = f.get("id").and_then(|i| i.as_str()).map(String::from) else { continue };
        let items: Vec<Value> = strs(f.get("items"))
            .iter()
            .map(|x| rename(x))
            .filter(|x| placed.insert(x.clone()))
            .map(Value::String)
            .collect();
        f.insert("id".into(), Value::String(folder_remap.get(&id).cloned().unwrap_or(id)));
        f.insert("items".into(), Value::Array(items));
        folders.push(Value::Object(f));
    }
    for entry in strs(t.get("order")) {
        let entry = rename(&entry);
        if placed.insert(entry.clone()) {
            our_order.push(entry);
        }
    }
    let mut added = m.get("added").and_then(|a| a.as_object()).cloned().unwrap_or_default();
    if let Some(theirs_added) = t.get("added").and_then(|a| a.as_object()) {
        for (k, v) in theirs_added {
            added.entry(rename(k)).or_insert_with(|| v.clone());
        }
    }
    for k in ["sort", "view"] {
        if !m.contains_key(k) {
            if let Some(v) = t.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
    }
    m.insert("folders".into(), Value::Array(folders));
    m.insert("order".into(), Value::Array(our_order.into_iter().map(Value::String).collect()));
    m.insert("added".into(), Value::Object(added));
    Value::Object(m)
}

// ---- files ----------------------------------------------------------------------------------

/// Copies local-art (artwork of local files and custom playlist covers) and moves the downloaded
/// files, pointing their rows here. A file name that exists here already is left alone.
fn import_files(data_dir: &Path, theirs_dir: &Path, db: &Db) -> Result<()> {
    let art_to = data_dir.join("local-art");
    for (from, name) in files_in(&theirs_dir.join("local-art"))? {
        let to = art_to.join(&name);
        if !to.exists() {
            std::fs::create_dir_all(&art_to)?;
            copy_atomic(&from, &to)?;
        }
    }

    let dl_from = theirs_dir.join("downloads");
    let dl_to = data_dir.join("downloads");
    for (from, name) in files_in(&dl_from)? {
        if name.to_string_lossy().ends_with(".part") {
            continue; // an interrupted download
        }
        let to = dl_to.join(&name);
        if to.exists() {
            continue;
        }
        std::fs::create_dir_all(&dl_to)?;
        if std::fs::rename(&from, &to).is_err() {
            // Another volume: copy, then remove the original.
            copy_atomic(&from, &to)?;
            std::fs::remove_file(&from)?;
        }
    }

    // Rows that still point into PLEXSpot's downloads folder, for files that are now here.
    let rows: Vec<(String, String)> = {
        let mut st = db.conn.prepare("SELECT track_id, path FROM downloads WHERE path IS NOT NULL")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (id, path) in rows {
        let p = Path::new(&path);
        if p.parent() != Some(dl_from.as_path()) {
            continue;
        }
        let Some(name) = p.file_name() else { continue };
        let moved = dl_to.join(name);
        if moved.exists() {
            db.conn.execute("UPDATE downloads SET path=?2 WHERE track_id=?1", rusqlite::params![id, moved.to_string_lossy()])?;
        }
    }
    Ok(())
}

/// The regular files directly in `dir` (none if it doesn't exist).
fn files_in(dir: &Path) -> Result<Vec<(PathBuf, std::ffi::OsString)>> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for e in rd {
        let e = e?;
        if e.file_type()?.is_file() {
            out.push((e.path(), e.file_name()));
        }
    }
    Ok(out)
}

/// Copy through a temporary name so an interrupted copy never looks finished.
fn copy_atomic(from: &Path, to: &Path) -> Result<()> {
    let mut tmp = to.as_os_str().to_owned();
    tmp.push(".import-tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::copy(from, &tmp)?;
    std::fs::rename(&tmp, to).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.into()
    })
}

// ---- secrets --------------------------------------------------------------------------------

/// Entries stored in chunks (`get_large` / `set_large`).
const LARGE_SECRETS: &[&str] = &["plex.session", "lastfm.keys"];

/// Copies the Plex sign-in and the Last.fm connection into empty slots. Each is a group, written
/// with its "present" entry (plex.token, lastfm.sk) last, so an interrupted copy is redone whole
/// at the next start. Any error fails the step. Returns the names copied.
fn import_secrets(db: &Db, theirs_dir: &Path, ours: &impl Store, theirs: &impl Store) -> Result<Vec<String>> {
    let mut copied = Vec::new();

    if ours.get("plex.token")?.is_none() {
        if let Some(token) = theirs.get("plex.token")? {
            if let Some(session) = secrets::get_large(theirs, "plex.session")? {
                secrets::set_large(ours, "plex.session", &session)?;
                copied.push("plex.session".to_string());
            }
            if let Some(home) = theirs.get("plex.homeToken")? {
                ours.set("plex.homeToken", &home)?;
                copied.push("plex.homeToken".to_string());
            }
            ours.set("plex.token", &token)?;
            copied.push("plex.token".to_string());
        }
    }

    // Only what is needed is read from PLEXSpot: on macOS each existing item it reads may ask.
    let their_sk = if ours.get("lastfm.sk")?.is_none() { theirs.get("lastfm.sk")? } else { None };
    let mut our_keys = secrets::get_large(ours, "lastfm.keys")?;
    let their_keys = if our_keys.is_none() || their_sk.is_some() { secrets::get_large(theirs, "lastfm.keys")? } else { None };
    if our_keys.is_none() {
        if let Some(k) = &their_keys {
            secrets::set_large(ours, "lastfm.keys", k)?;
            copied.push("lastfm.keys".to_string());
            our_keys = Some(k.clone());
        }
    }
    // A session key belongs to the API key it was made with.
    if let Some(sk) = their_sk.filter(|_| our_keys == their_keys) {
        let user: Option<String> = their_kv(theirs_dir, "lastfm.user")?;
        ours.set("lastfm.sk", &sk)?;
        copied.push("lastfm.sk".to_string());
        if let Some(user) = user {
            db.kv_set("lastfm.user", &user)?;
        }
    }
    Ok(copied)
}

/// One kv value from PLEXSpot's database (read-only).
fn their_kv<T: serde::de::DeserializeOwned>(theirs_dir: &Path, key: &str) -> Result<Option<T>> {
    let path = theirs_dir.join("library.db");
    if !path.exists() {
        return Ok(None);
    }
    let conn = open_theirs(&path)?;
    let raw: Option<String> = conn.query_row("SELECT value FROM kv WHERE key=?1", [key], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Source, Track};
    use std::cell::{Cell, RefCell};

    #[derive(Default)]
    struct Mem {
        map: RefCell<HashMap<String, String>>,
        fail: Cell<bool>,
    }

    impl Store for Mem {
        fn get(&self, name: &str) -> Result<Option<String>> {
            if self.fail.get() {
                return Err(Error::Keyring("denied".into()));
            }
            Ok(self.map.borrow().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<()> {
            if self.fail.get() {
                return Err(Error::Keyring("denied".into()));
            }
            self.map.borrow_mut().insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<()> {
            self.map.borrow_mut().remove(name);
            Ok(())
        }
    }

    struct Env {
        _tmp: tempfile::TempDir,
        ours_dir: PathBuf,
        theirs_dir: PathBuf,
        ours: Db,
        ours_store: Mem,
        theirs_store: Mem,
    }

    /// A data root with `app.openmusic.ytspot` (ours, opened) and `app.openmusic.plexspot`
    /// (theirs, filled by `fill` through a real Db and then closed).
    fn env(fill_ours: impl FnOnce(&mut Db, &Path), fill_theirs: impl FnOnce(&mut Db, &Path)) -> Env {
        let tmp = tempfile::tempdir().unwrap();
        let ours_dir = tmp.path().join("app.openmusic.ytspot");
        let theirs_dir = tmp.path().join(PLEXSPOT_ID);
        std::fs::create_dir_all(&ours_dir).unwrap();
        std::fs::create_dir_all(&theirs_dir).unwrap();
        {
            let mut t = Db::open(&theirs_dir.join("library.db")).unwrap();
            fill_theirs(&mut t, &theirs_dir);
        }
        let mut ours = Db::open(&ours_dir.join("library.db")).unwrap();
        fill_ours(&mut ours, &ours_dir);
        Env { _tmp: tmp, ours_dir, theirs_dir, ours, ours_store: Mem::default(), theirs_store: Mem::default() }
    }

    impl Env {
        fn run(&self, secrets_now: bool) {
            run_with(&self.ours_dir, &self.theirs_dir, &self.ours, &self.ours_store, &self.theirs_store, secrets_now);
        }
        fn kv(&self, key: &str) -> Option<Value> {
            self.ours.kv_get(key).unwrap()
        }
    }

    fn track(id: &str, source: Source) -> Track {
        serde_json::from_value(json!({ "id": id, "source": source, "title": id, "artist": "A" })).unwrap()
    }

    fn plexspot_signed_in(t: &Mem) {
        t.set("plex.token", "tok").unwrap();
        t.set("plex.homeToken", "home").unwrap();
        secrets::set_large(t, "plex.session", &"s".repeat(3000)).unwrap();
    }

    #[test]
    fn skipped_without_plexspot_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let ours_dir = tmp.path().join("app.openmusic.ytspot");
        std::fs::create_dir_all(&ours_dir).unwrap();
        assert!(sibling(&ours_dir).is_none());
        std::fs::create_dir_all(tmp.path().join(PLEXSPOT_ID)).unwrap();
        assert_eq!(sibling(&ours_dir), Some(tmp.path().join(PLEXSPOT_ID)));
        assert!(sibling(&tmp.path().join(PLEXSPOT_ID)).is_none(), "PLEXSpot's own folder never imports itself");
    }

    #[test]
    fn fresh_ytspot_dir_with_plexspot() {
        let e = env(
            |_, _| {},
            |t, _| {
                t.kv_set("settings", &json!({"language": "ja", "crossfade": 4})).unwrap();
                t.kv_set("clientId", &"plex-client").unwrap();
                t.kv_set("plex.account", &"Bob").unwrap();
                t.kv_set("ui.plex.profileChosen", &true).unwrap();
                t.kv_set("ui.localOnly", &true).unwrap();
                t.kv_set("ui.profile", &json!({"name": "Bobby"})).unwrap();
            },
        );
        e.ours.kv_set("clientId", &"yt-client").unwrap();
        plexspot_signed_in(&e.theirs_store);
        let before = before_with(&e.ours, &e.ours_store);
        assert_eq!(before, Before::default(), "nothing of ours before the import");
        e.run(true);
        // The facts were recorded before: imported settings don't count as YTSpot's.
        assert_eq!(e.kv("settings"), Some(json!({"language": "ja", "crossfade": 4})));
        assert_eq!(e.kv("clientId"), Some(json!("plex-client")));
        assert_eq!(e.kv("plex.account"), Some(json!("Bob")));
        assert_eq!(e.kv("ui.plex.profileChosen"), Some(json!(true)));
        assert_eq!(e.kv("ui.profile"), Some(json!({"name": "Bobby"})));
        assert_eq!(e.kv("ui.localOnly"), None, "local-only is this app's own choice");
        assert_eq!(e.ours_store.get("plex.token").unwrap().as_deref(), Some("tok"));
        assert_eq!(e.ours_store.get("plex.homeToken").unwrap().as_deref(), Some("home"));
        assert_eq!(secrets::get_large(&e.ours_store, "plex.session").unwrap(), Some("s".repeat(3000)));
        // Full import: PLEXSpot's copied entries are removed, its database stays.
        assert!(e.kv(MARK_DONE).is_some());
        assert!(e.theirs_store.map.borrow().is_empty(), "{:?}", e.theirs_store.map.borrow().keys());
        assert!(e.theirs_dir.join("library.db").exists());
    }

    #[test]
    fn both_apps_used_merge_with_collisions() {
        let shared = "app:shared".to_string();
        let e = env(
            |o, _| {
                o.kv_set("settings", &json!({"language": "en", "theme": "dark"})).unwrap();
                o.kv_set("clientId", &"yt-client").unwrap();
                o.kv_set("ui.profile", &json!({"name": "Me"})).unwrap();
                o.kv_set("ui.playlistSort", &json!({"app:shared": {"key": "title", "desc": false}})).unwrap();
                o.playlist_import(&shared, "Mine", None, &[track("yt:a", Source::Youtube)]).unwrap();
                o.record_play(&track("yt:a", Source::Youtube), None).unwrap();
                o.conn.execute("UPDATE history SET played_at=100", []).unwrap();
                o.save_item("album", "yt:MPRE1", &json!({"id": "yt:MPRE1"})).unwrap();
                o.hide_playlist("yt:PL1", "Hidden").unwrap();
                o.set_cover_override("yt:PL2", Some("art://local/c.jpg")).unwrap();
                o.scrobble_enqueue(&crate::lastfm::Scrobble { artist: "A".into(), track: "T".into(), album: None, timestamp: 5, duration: None }).unwrap();
            },
            |t, _| {
                t.kv_set("settings", &json!({"language": "ja", "plexQuality": "original"})).unwrap();
                t.kv_set("clientId", &"plex-client").unwrap();
                t.kv_set("ui.profile", &json!({"name": "Them"})).unwrap();
                t.kv_set("ui.playlistSort", &json!({"app:shared": {"key": "artist", "desc": true}, "plex:9": {"key": "added", "desc": true}})).unwrap();
                t.kv_set("yt.pageId", &"nope").unwrap();
                t.playlist_import("app:shared", "Theirs", Some("d"), &[track("plex:1", Source::Plex), track("plex:2", Source::Plex)]).unwrap();
                t.playlist_import("app:only", "Only", None, &[track("plex:3", Source::Plex)]).unwrap();
                t.playlist_set_cover("app:only", Some("art://local/cover.jpg")).unwrap();
                t.record_play(&track("plex:1", Source::Plex), None).unwrap();
                t.record_play(&track("plex:2", Source::Plex), None).unwrap();
                t.conn.execute("UPDATE history SET played_at = CASE track_id WHEN 'plex:1' THEN 50 ELSE 150 END", []).unwrap();
                t.save_item("album", "plex:77", &json!({"id": "plex:77"})).unwrap();
                t.save_item("album", "yt:MPRE1", &json!({"id": "yt:MPRE1", "theirs": true})).unwrap();
                t.set_cover_override("yt:PL2", Some("art://local/other.jpg")).unwrap();
                t.set_cover_override("plex:PL3", Some("art://local/p.jpg")).unwrap();
                // Same scrobble (deduped) plus a new one.
                t.scrobble_enqueue(&crate::lastfm::Scrobble { artist: "A".into(), track: "T".into(), album: None, timestamp: 5, duration: None }).unwrap();
                t.scrobble_enqueue(&crate::lastfm::Scrobble { artist: "B".into(), track: "U".into(), album: None, timestamp: 6, duration: None }).unwrap();
                t.conn.execute("INSERT INTO local_folders(path, added_at) VALUES('/music', 1)", []).unwrap();
            },
        );
        e.ours.kv_set("plex.account", &"Already").unwrap();
        e.run(true);
        let db = &e.ours;

        // Playlists: ours untouched, theirs under a new id, the other one as is (with its cover).
        assert_eq!(db.playlist_tracks(&shared).unwrap().iter().map(|t| t.id.clone()).collect::<Vec<_>>(), vec!["yt:a"]);
        let pls = db.playlists().unwrap();
        assert_eq!(pls.len(), 3);
        let moved = pls.iter().find(|p| p.title == "Theirs").unwrap();
        assert_ne!(moved.id, shared);
        assert!(moved.id.starts_with("app:"));
        assert_eq!(db.playlist_tracks(&moved.id).unwrap().iter().map(|t| t.id.clone()).collect::<Vec<_>>(), vec!["plex:1", "plex:2"]);
        assert_eq!(db.playlist_cover("app:only").unwrap().as_deref(), Some("art://local/cover.jpg"));

        // History by play time across both apps.
        let h: Vec<String> = db.history_page(None, 10).unwrap().into_iter().map(|h| h.track.id).collect();
        assert_eq!(h, vec!["plex:2", "yt:a", "plex:1"]);

        // Saved (ours wins on the same id), hidden, cover overrides (ours wins), scrobbles deduped.
        assert_eq!(db.saved_items::<Value>("album").unwrap().len(), 2);
        assert!(db.saved_items::<Value>("album").unwrap().iter().all(|v| v.get("theirs").is_none()));
        assert!(db.hidden_playlists().unwrap().contains("yt:PL1"));
        let covers = db.cover_overrides().unwrap();
        assert_eq!(covers.get("yt:PL2").map(String::as_str), Some("art://local/c.jpg"));
        assert_eq!(covers.get("plex:PL3").map(String::as_str), Some("art://local/p.jpg"));
        assert_eq!(db.scrobble_pending(10).unwrap().len(), 2);
        let folders: i64 = db.conn.query_row("SELECT COUNT(*) FROM local_folders", [], |r| r.get(0)).unwrap();
        assert_eq!(folders, 1);

        // Kv: settings per key with ours winning; playlistSort union with the remapped id.
        assert_eq!(e.kv("settings"), Some(json!({"language": "en", "theme": "dark", "plexQuality": "original"})));
        let sorts = e.kv("ui.playlistSort").unwrap();
        assert_eq!(sorts["app:shared"]["key"], "title");
        assert_eq!(sorts[moved.id.as_str()]["key"], "artist");
        assert_eq!(sorts["plex:9"]["key"], "added");
        assert_eq!(e.kv("ui.profile"), Some(json!({"name": "Me"})));
        assert_eq!(e.kv("yt.pageId"), None);
        // Plex already signed in here: our device id stays.
        assert_eq!(e.kv("clientId"), Some(json!("yt-client")));
    }

    #[test]
    fn markers_prevent_a_second_run() {
        let e = env(|_, _| {}, |t, _| {
            t.playlist_import("app:p", "P", None, &[track("plex:1", Source::Plex)]).unwrap();
        });
        e.run(true);
        for k in [MARK_DB, MARK_FILES, MARK_SECRETS, MARK_DONE] {
            assert!(e.kv(k).is_some(), "{k}");
        }
        e.ours.playlist_delete("app:p").unwrap();
        e.run(true);
        assert!(e.ours.playlists().unwrap().is_empty(), "deleted playlist not imported again");

        // A step already done is not redone even before the whole import is.
        let e = env(|_, _| {}, |t, _| {
            t.playlist_import("app:p", "P", None, &[]).unwrap();
        });
        e.theirs_store.fail.set(true);
        e.run(true);
        assert!(e.kv(MARK_DB).is_some() && e.kv(MARK_SECRETS).is_none() && e.kv(MARK_DONE).is_none());
        e.ours.playlist_delete("app:p").unwrap();
        e.run(true);
        assert!(e.ours.playlists().unwrap().is_empty());
    }

    #[test]
    fn a_failed_secret_step_is_retried() {
        let e = env(|_, _| {}, |t, _| {
            t.kv_set("lastfm.user", &"fmuser").unwrap();
        });
        plexspot_signed_in(&e.theirs_store);
        e.theirs_store.set("lastfm.sk", "sk1").unwrap();
        e.theirs_store.fail.set(true); // a denied keychain prompt
        e.run(true);
        assert!(e.kv(MARK_SECRETS).is_none());
        assert!(e.ours_store.map.borrow().is_empty());
        assert!(e.ours_dir.join("crash.log").exists());

        e.theirs_store.fail.set(false);
        e.run(true);
        assert!(e.kv(MARK_SECRETS).is_some());
        assert_eq!(e.ours_store.get("plex.token").unwrap().as_deref(), Some("tok"));
        assert_eq!(e.ours_store.get("lastfm.sk").unwrap().as_deref(), Some("sk1"));
        assert_eq!(e.kv("lastfm.user"), Some(json!("fmuser")));
        assert!(e.kv(MARK_DONE).is_some());
    }

    #[test]
    fn secrets_go_into_empty_slots_only() {
        let e = env(|_, _| {}, |t, _| {
            t.kv_set("lastfm.user", &"them").unwrap();
        });
        plexspot_signed_in(&e.theirs_store);
        e.theirs_store.set("lastfm.sk", "their-sk").unwrap();
        e.ours_store.set("plex.token", "mine").unwrap();
        e.ours_store.set("lastfm.sk", "my-sk").unwrap();
        e.ours.kv_set("lastfm.user", &"me").unwrap();
        e.run(true);
        assert_eq!(e.ours_store.get("plex.token").unwrap().as_deref(), Some("mine"));
        assert_eq!(e.ours_store.get("plex.session").unwrap(), None);
        assert_eq!(e.ours_store.get("lastfm.sk").unwrap().as_deref(), Some("my-sk"));
        assert_eq!(e.kv("lastfm.user"), Some(json!("me")));
        // Nothing was copied, so PLEXSpot's entries stay.
        assert_eq!(e.theirs_store.get("plex.token").unwrap().as_deref(), Some("tok"));
    }

    #[test]
    fn deferred_secrets_wait_for_run_secrets_later() {
        let e = env(|_, _| {}, |_, _| {});
        plexspot_signed_in(&e.theirs_store);
        e.run(false);
        assert!(e.kv(MARK_DB).is_some() && e.kv(MARK_FILES).is_some());
        assert!(e.kv(MARK_SECRETS).is_none() && e.kv(MARK_DONE).is_none());
        assert!(e.ours_store.map.borrow().is_empty());
        secrets_step(&e.ours_dir, &e.theirs_dir, &e.ours, &e.ours_store, &e.theirs_store);
        cleanup(&e.ours_dir, &e.theirs_dir, &e.ours, &e.theirs_store);
        assert_eq!(e.ours_store.get("plex.token").unwrap().as_deref(), Some("tok"));
        assert!(e.kv(MARK_DONE).is_some());
    }

    #[test]
    fn downloads_move_and_paths_rewrite() {
        let e = env(
            |o, dir| {
                std::fs::create_dir_all(dir.join("downloads")).unwrap();
                std::fs::write(dir.join("downloads/plex_2.flac"), b"ours").unwrap();
                o.conn.execute(
                    "INSERT INTO downloads(track_id,track_json,status,path,updated_at) VALUES('plex:2','{}','done',?1,1)",
                    [dir.join("downloads/plex_2.flac").to_string_lossy()],
                ).unwrap();
            },
            |t, dir| {
                std::fs::create_dir_all(dir.join("downloads")).unwrap();
                std::fs::create_dir_all(dir.join("local-art")).unwrap();
                std::fs::create_dir_all(dir.join("updates")).unwrap();
                std::fs::write(dir.join("updates/PLEXSpot_1.6.1_x64-setup.exe"), b"MZ").unwrap();
                std::fs::write(dir.join("downloads/plex_1.flac"), b"one").unwrap();
                std::fs::write(dir.join("downloads/plex_2.flac"), b"theirs").unwrap();
                std::fs::write(dir.join("downloads/plex_3.flac.part"), b"half").unwrap();
                std::fs::write(dir.join("local-art/a.jpg"), b"jpg").unwrap();
                for (id, name) in [("plex:1", "plex_1.flac"), ("plex:2", "plex_2.flac")] {
                    t.conn.execute(
                        "INSERT INTO downloads(track_id,track_json,status,path,updated_at) VALUES(?1,'{}','done',?2,1)",
                        rusqlite::params![id, dir.join("downloads").join(name).to_string_lossy()],
                    ).unwrap();
                }
            },
        );
        e.run(true);
        let path = |id: &str| -> String { e.ours.conn.query_row("SELECT path FROM downloads WHERE track_id=?1", [id], |r| r.get(0)).unwrap() };
        let moved = e.ours_dir.join("downloads/plex_1.flac");
        assert_eq!(path("plex:1"), moved.to_string_lossy());
        assert_eq!(std::fs::read(&moved).unwrap(), b"one");
        assert!(!e.theirs_dir.join("downloads/plex_1.flac").exists());
        // Ours wins on the same track: our file and row stay, theirs is left in place.
        assert_eq!(path("plex:2"), e.ours_dir.join("downloads/plex_2.flac").to_string_lossy());
        assert_eq!(std::fs::read(e.ours_dir.join("downloads/plex_2.flac")).unwrap(), b"ours");
        assert!(e.theirs_dir.join("downloads/plex_2.flac").exists());
        assert!(!e.ours_dir.join("downloads/plex_3.flac.part").exists());
        // Artwork copied (not moved); PLEXSpot's update downloads removed after the full import.
        assert_eq!(std::fs::read(e.ours_dir.join("local-art/a.jpg")).unwrap(), b"jpg");
        assert!(e.theirs_dir.join("local-art/a.jpg").exists());
        assert!(!e.theirs_dir.join("updates").exists());
    }

    #[test]
    fn library_org_merges_folders_order_and_added() {
        let mut remap = HashMap::new();
        remap.insert("app:dup".to_string(), "app:new".to_string());
        let mine = json!({
            "folders": [{"id": "f1", "name": "Rock", "items": ["yt:PL1"], "open": true}],
            "order": ["folder:f1", "app:dup"],
            "sort": "custom", "view": "grid",
            "added": {"yt:PL1": 1, "folder:f1": 2}
        });
        let theirs = json!({
            "folders": [
                {"id": "f1", "name": "Jazz", "items": ["app:dup", "yt:PL1", "plex:5"], "open": false},
                {"id": "f2", "name": "Chill", "items": [], "open": true}
            ],
            "order": ["folder:f1", "folder:f2", "plex:6", "app:x"],
            "sort": "alpha", "view": "list",
            "added": {"folder:f1": 10, "app:dup": 11, "yt:PL1": 99}
        });
        let out = merge_library_org(Some(mine), theirs, &remap);
        let folders = out["folders"].as_array().unwrap();
        assert_eq!(folders.len(), 3);
        assert_eq!(folders[0]["name"], "Rock");
        let jazz = &folders[1];
        let jazz_id = jazz["id"].as_str().unwrap();
        assert_ne!(jazz_id, "f1");
        assert_eq!(jazz["name"], "Jazz");
        assert_eq!(jazz["open"], false);
        // yt:PL1 keeps our place; the remapped playlist goes in under its new id.
        assert_eq!(jazz["items"], json!(["app:new", "plex:5"]));
        assert_eq!(folders[2]["id"], "f2");
        let jazz_key = format!("folder:{jazz_id}");
        assert_eq!(out["order"], json!(["folder:f1", "app:dup", jazz_key, "folder:f2", "plex:6", "app:x"]));
        assert_eq!(out["sort"], "custom");
        assert_eq!(out["view"], "grid");
        let added = out["added"].as_object().unwrap();
        assert_eq!(added["yt:PL1"], 1);
        assert_eq!(added["folder:f1"], 2);
        assert_eq!(added[jazz_key.as_str()], 10);
        assert_eq!(added["app:new"], 11);

        // Nothing of ours: theirs as is (sort and view included).
        let only = merge_library_org(None, json!({"folders": [], "order": ["plex:1"], "sort": "alpha", "view": "list", "added": {}}), &HashMap::new());
        assert_eq!(only["order"], json!(["plex:1"]));
        assert_eq!(only["sort"], "alpha");
    }

    #[test]
    fn library_org_kv_merges_through_the_import() {
        let e = env(
            |o, _| {
                o.kv_set("ui.libraryOrg", &json!({"folders": [{"id": "a", "name": "A", "items": [], "open": true}], "order": ["folder:a"], "sort": "recent", "view": "list", "added": {}})).unwrap();
            },
            |t, _| {
                t.kv_set("ui.libraryOrg", &json!({"folders": [{"id": "a", "name": "B", "items": ["plex:1"], "open": true}], "order": ["folder:a"], "sort": "alpha", "view": "grid", "added": {}})).unwrap();
                t.kv_set("ui.podcastOldestFirst", &json!({"plex:show": true})).unwrap();
            },
        );
        e.run(true);
        let org = e.kv("ui.libraryOrg").unwrap();
        assert_eq!(org["folders"].as_array().unwrap().len(), 2);
        assert_eq!(org["order"].as_array().unwrap().len(), 2);
        assert_eq!(org["sort"], "recent");
        assert_eq!(e.kv("ui.podcastOldestFirst"), Some(json!({"plex:show": true})));
    }

    #[test]
    fn lastfm_session_needs_matching_keys() {
        let e = env(|_, _| {}, |t, _| {
            t.kv_set("lastfm.user", &"them").unwrap();
        });
        secrets::set_large(&e.ours_store, "lastfm.keys", "{\"apiKey\":\"mine\"}").unwrap();
        e.theirs_store.set("lastfm.sk", "their-sk").unwrap();
        e.run(true);
        assert_eq!(e.ours_store.get("lastfm.sk").unwrap(), None, "their session belongs to another API key");
        assert_eq!(e.kv("lastfm.user"), None);
        assert!(e.kv(MARK_SECRETS).is_some());
    }

    #[test]
    fn reads_a_live_database_through_its_wal() {
        let tmp = tempfile::tempdir().unwrap();
        let ours_dir = tmp.path().join("app.openmusic.ytspot");
        let theirs_dir = tmp.path().join(PLEXSPOT_ID);
        std::fs::create_dir_all(&ours_dir).unwrap();
        std::fs::create_dir_all(&theirs_dir).unwrap();
        // PLEXSpot still has its database open: the rows are only in library.db-wal.
        let mut live = Db::open(&theirs_dir.join("library.db")).unwrap();
        live.playlist_import("app:w", "In the WAL", None, &[track("plex:1", Source::Plex)]).unwrap();
        assert!(theirs_dir.join("library.db-wal").exists());
        let ours = Db::open(&ours_dir.join("library.db")).unwrap();
        run_with(&ours_dir, &theirs_dir, &ours, &Mem::default(), &Mem::default(), true);
        assert_eq!(ours.playlist_tracks("app:w").unwrap().len(), 1);
        // Read-only: PLEXSpot's database was not changed.
        let n: i64 = live.conn.query_row("SELECT COUNT(*) FROM kv WHERE key LIKE 'migrated.%'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn before_reads_this_folders_own_state() {
        let db = Db::open_in_memory().unwrap();
        let store = Mem::default();
        db.kv_set("settings", &json!({})).unwrap();
        db.kv_set("ui.localOnly", &true).unwrap();
        store.set("yt.cookie", "chunks:1:ab").unwrap();
        assert_eq!(before_with(&db, &store), Before { had_own_settings: true, had_yt_cookie: true, had_local_only: true });
        store.fail.set(true);
        assert!(!before_with(&db, &store).had_yt_cookie, "a failed read is not a sign-in");
    }
}
