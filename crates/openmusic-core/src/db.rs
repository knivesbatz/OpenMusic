//! SQLite persistence with versioned migrations (`PRAGMA user_version`).
//!
//! WAL mode + synchronous=NORMAL keeps writes cheap while staying crash-safe: a killed process can
//! lose at most the last uncommitted transaction, never corrupt the file.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use crate::error::Result;
use crate::model::{Playlist, Track};

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE playlists (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE playlist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        track_id TEXT NOT NULL,
        track_json TEXT NOT NULL,
        added_at INTEGER NOT NULL
    );
    CREATE INDEX playlist_items_pos ON playlist_items(playlist_id, position);
    CREATE TABLE hidden_playlists (id TEXT PRIMARY KEY, title TEXT, hidden_at INTEGER NOT NULL);
    CREATE TABLE history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL, track_json TEXT NOT NULL, played_at INTEGER NOT NULL,
        context_kind TEXT, context_id TEXT, context_title TEXT, context_artwork TEXT
    );
    CREATE INDEX history_played ON history(played_at DESC);
    CREATE INDEX history_track ON history(track_id);
    CREATE TABLE local_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
    CREATE TABLE local_tracks (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, folder TEXT NOT NULL,
        mtime INTEGER NOT NULL, size INTEGER NOT NULL,
        title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT, album_artist TEXT,
        track_no INTEGER, disc_no INTEGER, year INTEGER, duration_ms INTEGER, artwork TEXT,
        missing INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX local_tracks_album ON local_tracks(album_artist, album);
    CREATE TABLE downloads (
        track_id TEXT PRIMARY KEY, track_json TEXT NOT NULL, status TEXT NOT NULL,
        path TEXT, bytes INTEGER NOT NULL DEFAULT 0, total INTEGER, error TEXT,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE scrobbles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist TEXT NOT NULL, track TEXT NOT NULL, album TEXT, timestamp INTEGER NOT NULL,
        duration INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(artist, track, timestamp)
    );
    CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
    "#,
    // v2: albums and artists saved to "Your Library" inside the app (never written to the provider)
    r#"
    CREATE TABLE saved (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL
    );
    CREATE INDEX saved_kind ON saved(kind, saved_at);
    "#,
    // v3: YouTube parsing fixes (album covers, play counts, artist aliases) invalidate cached
    // responses. Only the metadata cache is cleared; playlists, downloads and settings stay.
    r#"
    DELETE FROM cache;
    DELETE FROM kv WHERE key = 'plex.library';
    "#,
    // v4: a custom cover for app playlists (art:// reference); none = the first track's art.
    // Cached artist pages are dropped so they load the full discography.
    r#"
    ALTER TABLE playlists ADD COLUMN cover TEXT;
    DELETE FROM cache WHERE key LIKE 'artist:%';
    "#,
];

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub struct Db {
    pub conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )?;
        let mut db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&mut self) -> Result<()> {
        let current: usize = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
            tx.commit()?;
        }
        Ok(())
    }

    // ---- key/value -------------------------------------------------------------------------

    pub fn kv_get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let v: Option<String> = self
            .conn
            .query_row("SELECT value FROM kv WHERE key=?1", [key], |r| r.get(0))
            .optional()?;
        Ok(match v {
            Some(s) => serde_json::from_str(&s).ok(),
            None => None,
        })
    }

    pub fn kv_set<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.conn.execute(
            "INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    pub fn kv_delete(&self, key: &str) -> Result<()> {
        self.conn.execute("DELETE FROM kv WHERE key=?1", [key])?;
        Ok(())
    }

    // ---- response cache ---------------------------------------------------------------------

    pub fn cache_get<T: DeserializeOwned>(&self, key: &str, allow_stale: bool) -> Result<Option<T>> {
        let row: Option<(String, i64)> = self
            .conn
            .query_row("SELECT value, expires_at FROM cache WHERE key=?1", [key], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        Ok(row.and_then(|(v, exp)| {
            if allow_stale || exp > now() {
                serde_json::from_str(&v).ok()
            } else {
                None
            }
        }))
    }

    pub fn cache_put<T: Serialize>(&self, key: &str, value: &T, ttl_secs: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO cache(key,value,expires_at) VALUES(?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at",
            params![key, serde_json::to_string(value)?, now() + ttl_secs],
        )?;
        Ok(())
    }

    pub fn cache_clear(&self) -> Result<()> {
        self.conn.execute("DELETE FROM cache", [])?;
        Ok(())
    }

    /// Clear the cache except entries whose keys start with one of `keep`.
    pub fn cache_clear_except(&self, keep: &[&str]) -> Result<()> {
        let rows: Vec<String> = {
            let mut st = self.conn.prepare("SELECT key FROM cache")?;
            let keys = st.query_map([], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
            keys
        };
        for k in rows.into_iter().filter(|k| !keep.iter().any(|p| k.starts_with(p))) {
            self.conn.execute("DELETE FROM cache WHERE key=?1", [&k])?;
        }
        Ok(())
    }

    /// Bounded cache: drop entries expired for more than a week.
    pub fn cache_prune(&self) -> Result<()> {
        self.conn.execute("DELETE FROM cache WHERE expires_at < ?1", [now() - 7 * 86400])?;
        Ok(())
    }

    // ---- app playlists ----------------------------------------------------------------------

    pub fn playlists(&self) -> Result<Vec<Playlist>> {
        let mut st = self.conn.prepare(
            "SELECT p.id, p.name, p.description,
                    (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id=p.id),
                    COALESCE(p.cover, (SELECT json_extract(track_json,'$.artwork') FROM playlist_items i
                      WHERE i.playlist_id=p.id ORDER BY position LIMIT 1))
             FROM playlists p ORDER BY p.updated_at DESC",
        )?;
        let rows = st.query_map([], |r| {
            Ok(Playlist {
                id: r.get(0)?,
                title: r.get(1)?,
                description: r.get(2)?,
                track_count: Some(r.get::<_, i64>(3)? as u32),
                artwork: r.get(4)?,
                owner: None,
                local: true,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn playlist_create(&self, name: &str) -> Result<Playlist> {
        let id = format!("app:{}", uuid::Uuid::new_v4().simple());
        let t = now();
        self.conn.execute(
            "INSERT INTO playlists(id,name,created_at,updated_at) VALUES(?1,?2,?3,?3)",
            params![id, name, t],
        )?;
        Ok(Playlist {
            id,
            title: name.into(),
            description: None,
            artwork: None,
            track_count: Some(0),
            owner: None,
            local: true,
        })
    }

    pub fn playlist_update(&self, id: &str, name: &str, description: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE playlists SET name=?2, description=?3, updated_at=?4 WHERE id=?1",
            params![id, name, description, now()],
        )?;
        Ok(())
    }

    pub fn playlist_set_cover(&self, id: &str, cover: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE playlists SET cover=?2, updated_at=?3 WHERE id=?1", params![id, cover, now()])?;
        Ok(())
    }

    pub fn playlist_delete(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM playlists WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn playlist_get(&self, id: &str) -> Result<Option<Playlist>> {
        Ok(self.playlists()?.into_iter().find(|p| p.id == id))
    }

    pub fn playlist_tracks(&self, id: &str) -> Result<Vec<Track>> {
        let mut st = self.conn.prepare(
            "SELECT track_json, added_at FROM playlist_items WHERE playlist_id=?1 ORDER BY position",
        )?;
        let rows = st.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (json, added) = row?;
            // A corrupt row is skipped, never allowed to break the whole playlist.
            if let Ok(mut t) = serde_json::from_str::<Track>(&json) {
                t.added_at = Some(added);
                out.push(t);
            }
        }
        Ok(out)
    }

    pub fn playlist_add(&mut self, id: &str, tracks: &[Track]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let mut pos: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position)+1,0) FROM playlist_items WHERE playlist_id=?1",
            [id],
            |r| r.get(0),
        )?;
        let t = now();
        for tr in tracks {
            tx.execute(
                "INSERT INTO playlist_items(playlist_id,position,track_id,track_json,added_at)
                 VALUES(?1,?2,?3,?4,?5)",
                params![id, pos, tr.id, serde_json::to_string(tr)?, t],
            )?;
            pos += 1;
        }
        tx.execute("UPDATE playlists SET updated_at=?2 WHERE id=?1", params![id, t])?;
        tx.commit()?;
        Ok(tracks.len())
    }

    /// App playlists that contain the track.
    pub fn playlists_containing(&self, track_id: &str) -> Result<Vec<String>> {
        let mut st = self.conn.prepare("SELECT DISTINCT playlist_id FROM playlist_items WHERE track_id=?1")?;
        let rows = st.query_map([track_id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Remove every copy of a track from a playlist; returns how many were removed.
    pub fn playlist_remove_track(&mut self, id: &str, track_id: &str) -> Result<usize> {
        let n = self.conn.execute("DELETE FROM playlist_items WHERE playlist_id=?1 AND track_id=?2", params![id, track_id])?;
        if n > 0 {
            self.conn.execute("UPDATE playlists SET updated_at=?2 WHERE id=?1", params![id, now()])?;
        }
        Ok(n)
    }

    /// Rewrite the playlist in a new order. `order` lists the current indices in their new order;
    /// indices missing from `order` are removed. Runs in one transaction so a crash mid-way can't
    /// leave a half-reordered playlist.
    pub fn playlist_reorder(&mut self, id: &str, order: &[usize]) -> Result<()> {
        let tx = self.conn.transaction()?;
        let ids: Vec<i64> = {
            let mut st = tx.prepare(
                "SELECT id FROM playlist_items WHERE playlist_id=?1 ORDER BY position",
            )?;
            let rows = st.query_map([id], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let keep: std::collections::HashSet<usize> = order.iter().copied().collect();
        for (i, row) in ids.iter().enumerate() {
            if !keep.contains(&i) {
                tx.execute("DELETE FROM playlist_items WHERE id=?1", [row])?;
            }
        }
        for (new_pos, &old) in order.iter().enumerate() {
            if let Some(row) = ids.get(old) {
                tx.execute(
                    "UPDATE playlist_items SET position=?2 WHERE id=?1",
                    params![row, new_pos as i64],
                )?;
            }
        }
        tx.execute("UPDATE playlists SET updated_at=?2 WHERE id=?1", params![id, now()])?;
        tx.commit()?;
        Ok(())
    }

    // ---- hidden playlists (YTSpot) ----------------------------------------------------------

    pub fn hide_playlist(&self, id: &str, title: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO hidden_playlists(id,title,hidden_at) VALUES(?1,?2,?3)",
            params![id, title, now()],
        )?;
        Ok(())
    }

    pub fn hidden_playlists(&self) -> Result<std::collections::HashSet<String>> {
        let mut st = self.conn.prepare("SELECT id FROM hidden_playlists")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    // ---- saved albums / artists -------------------------------------------------------------

    pub fn save_item<T: serde::Serialize>(&self, kind: &str, id: &str, item: &T) -> Result<()> {
        self.conn.execute(
            "INSERT INTO saved(id,kind,json,saved_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET json=excluded.json",
            params![id, kind, serde_json::to_string(item)?, now()],
        )?;
        Ok(())
    }

    pub fn unsave_item(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM saved WHERE id=?1", [id])?;
        Ok(())
    }

    /// Saved items of one kind, most recently saved first. Rows that no longer parse are skipped.
    pub fn saved_items<T: serde::de::DeserializeOwned>(&self, kind: &str) -> Result<Vec<T>> {
        let mut st = self.conn.prepare("SELECT json FROM saved WHERE kind=?1 ORDER BY saved_at DESC, rowid DESC")?;
        let rows = st.query_map([kind], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|j| serde_json::from_str(&j).ok()).collect())
    }

    // ---- listening history ------------------------------------------------------------------

    pub fn record_play(&self, track: &Track, ctx: Option<&PlayContext>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO history(track_id,track_json,played_at,context_kind,context_id,context_title,context_artwork)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                track.id,
                serde_json::to_string(track)?,
                now(),
                ctx.map(|c| c.kind.as_str()),
                ctx.map(|c| c.id.as_str()),
                ctx.map(|c| c.title.as_str()),
                ctx.and_then(|c| c.artwork.as_deref()),
            ],
        )?;
        // Bounded history.
        self.conn.execute(
            "DELETE FROM history WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET 5000)",
            [],
        )?;
        Ok(())
    }

    pub fn recent_tracks(&self, limit: usize) -> Result<Vec<Track>> {
        let mut st = self.conn.prepare(
            "SELECT track_json FROM history WHERE id IN
               (SELECT MAX(id) FROM history GROUP BY track_id) ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = st.query_map([limit as i64], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|j| serde_json::from_str(&j).ok()).collect())
    }

    pub fn recent_contexts(&self, limit: usize) -> Result<Vec<PlayContext>> {
        let mut st = self.conn.prepare(
            "SELECT context_kind, context_id, context_title, context_artwork FROM history
             WHERE context_id IS NOT NULL AND id IN
               (SELECT MAX(id) FROM history WHERE context_id IS NOT NULL GROUP BY context_id)
             ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = st.query_map([limit as i64], |r| {
            Ok(PlayContext {
                kind: r.get(0)?,
                id: r.get(1)?,
                title: r.get(2)?,
                artwork: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Most-played tracks in the last `days`, used for local recommendations.
    pub fn top_tracks(&self, days: i64, limit: usize) -> Result<Vec<(Track, i64)>> {
        let mut st = self.conn.prepare(
            "SELECT track_json, COUNT(*) c FROM history WHERE played_at > ?1
             GROUP BY track_id ORDER BY c DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![now() - days * 86400, limit as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        Ok(rows
            .filter_map(|r| r.ok())
            .filter_map(|(j, c)| serde_json::from_str(&j).ok().map(|t| (t, c)))
            .collect())
    }

    // ---- scrobble queue ---------------------------------------------------------------------

    /// Returns false when the identical scrobble is already queued (dedupe on artist/track/ts).
    pub fn scrobble_enqueue(&self, s: &crate::lastfm::Scrobble) -> Result<bool> {
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO scrobbles(artist,track,album,timestamp,duration) VALUES(?1,?2,?3,?4,?5)",
            params![s.artist, s.track, s.album, s.timestamp, s.duration],
        )?;
        Ok(n > 0)
    }

    pub fn scrobble_pending(&self, limit: usize) -> Result<Vec<(i64, crate::lastfm::Scrobble)>> {
        let mut st = self.conn.prepare(
            "SELECT id, artist, track, album, timestamp, duration FROM scrobbles ORDER BY timestamp LIMIT ?1",
        )?;
        let rows = st.query_map([limit as i64], |r| {
            Ok((
                r.get(0)?,
                crate::lastfm::Scrobble {
                    artist: r.get(1)?,
                    track: r.get(2)?,
                    album: r.get(3)?,
                    timestamp: r.get(4)?,
                    duration: r.get(5)?,
                },
            ))
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn scrobble_done(&self, ids: &[i64]) -> Result<()> {
        for id in ids {
            self.conn.execute("DELETE FROM scrobbles WHERE id=?1", [id])?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayContext {
    /// "album" | "playlist" | "artist" | "local"
    pub kind: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artwork: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Source;

    fn track(id: &str) -> Track {
        Track {
            id: id.into(),
            source: Source::Local,
            title: format!("Title {id}"),
            artist: "A".into(),
            artist_id: None,
            album: None,
            album_id: None,
            duration_ms: Some(1000),
            artwork: None,
            stream_key: None,
            track_number: None,
            explicit: false,
            episode: false,
            description: None,
            published: None,
            year: None,
            added_at: None,
        }
    }

    #[test]
    fn migrations_are_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.db");
        {
            let db = Db::open(&p).unwrap();
            db.kv_set("x", &5).unwrap();
        }
        let db = Db::open(&p).unwrap();
        assert_eq!(db.kv_get::<i32>("x").unwrap(), Some(5));
    }

    #[test]
    fn playlist_add_reorder_remove() {
        let mut db = Db::open_in_memory().unwrap();
        let p = db.playlist_create("Mix").unwrap();
        db.playlist_add(&p.id, &[track("a"), track("b"), track("c"), track("d")]).unwrap();
        // move d to front, drop b
        db.playlist_reorder(&p.id, &[3, 0, 2]).unwrap();
        let ids: Vec<_> = db.playlist_tracks(&p.id).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["d", "a", "c"]);
        // duplicates of the same track are allowed and kept distinct
        db.playlist_add(&p.id, &[track("a")]).unwrap();
        assert_eq!(db.playlist_tracks(&p.id).unwrap().len(), 4);
        assert_eq!(db.playlists_containing("a").unwrap(), [p.id.clone()]);
        assert!(db.playlists_containing("zz").unwrap().is_empty());
        // unchecking a song removes every copy, keeping the rest in order
        assert_eq!(db.playlist_remove_track(&p.id, "a").unwrap(), 2);
        let ids: Vec<_> = db.playlist_tracks(&p.id).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["d", "c"]);
        db.playlist_add(&p.id, &[track("a"), track("a")]).unwrap();
        assert_eq!(db.playlists().unwrap()[0].track_count, Some(4));
        db.playlist_delete(&p.id).unwrap();
        assert!(db.playlist_tracks(&p.id).unwrap().is_empty());
    }

    #[test]
    fn saved_albums_and_artists() {
        use crate::model::{Album, Artist};
        let db = Db::open_in_memory().unwrap();
        let album = |id: &str| Album { id: id.into(), title: "T".into(), artist: "A".into(), artist_id: None, year: None, artwork: None, kind: None };
        db.save_item("album", "plex:1", &album("plex:1")).unwrap();
        db.save_item("album", "plex:2", &album("plex:2")).unwrap();
        db.save_item("album", "plex:1", &album("plex:1")).unwrap(); // idempotent
        db.save_item("artist", "plex:9", &Artist { id: "plex:9".into(), name: "N".into(), artwork: None }).unwrap();
        let albums: Vec<Album> = db.saved_items("album").unwrap();
        assert_eq!(albums.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["plex:2", "plex:1"]);
        assert_eq!(db.saved_items::<Artist>("artist").unwrap().len(), 1);
        db.unsave_item("plex:2").unwrap();
        assert_eq!(db.saved_items::<Album>("album").unwrap().len(), 1);
    }

    #[test]
    fn hidden_playlists_persist() {
        let db = Db::open_in_memory().unwrap();
        db.hide_playlist("PL1", "x").unwrap();
        db.hide_playlist("PL1", "x").unwrap();
        assert!(db.hidden_playlists().unwrap().contains("PL1"));
    }

    #[test]
    fn scrobble_dedupe() {
        let db = Db::open_in_memory().unwrap();
        let s = crate::lastfm::Scrobble {
            artist: "A".into(),
            track: "T".into(),
            album: None,
            timestamp: 100,
            duration: Some(200),
        };
        assert!(db.scrobble_enqueue(&s).unwrap());
        assert!(!db.scrobble_enqueue(&s).unwrap());
        let p = db.scrobble_pending(10).unwrap();
        assert_eq!(p.len(), 1);
        db.scrobble_done(&[p[0].0]).unwrap();
        assert!(db.scrobble_pending(10).unwrap().is_empty());
    }

    #[test]
    fn history_recent_dedupes_by_track() {
        let db = Db::open_in_memory().unwrap();
        db.record_play(&track("a"), None).unwrap();
        db.record_play(&track("b"), None).unwrap();
        db.record_play(&track("a"), None).unwrap();
        let ids: Vec<_> = db.recent_tracks(10).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["a", "b"]);
    }
}
