//! Local music library: folder scanning, tag/artwork extraction and incremental refresh.
//!
//! A file is re-read only when its size or mtime changed, so refreshing a large, unchanged
//! library is a directory walk plus one indexed lookup per file. Files that vanish are marked
//! `missing` (not deleted) so playlists that reference them survive a disconnected drive; when
//! the drive returns, the next scan clears the flag.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::Accessor;
use rusqlite::params;
use sha1::{Digest, Sha1};

use crate::db::{now, Db};
use crate::error::Result;
use crate::model::{Album, Artist, Source, Track};

pub const AUDIO_EXTS: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "weba", "webm"];

pub fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Stable id from the normalized absolute path.
pub fn track_id(path: &Path) -> String {
    let norm = path.to_string_lossy().replace('\\', "/").to_lowercase();
    let h = Sha1::digest(norm.as_bytes());
    format!("local:{}", hex::encode(&h[..10]))
}

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scanned: usize,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub missing: usize,
    pub failed: usize,
}

#[derive(Debug, Clone)]
pub struct FileMeta {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub year: Option<u32>,
    pub duration_ms: Option<u64>,
    pub picture: Option<Vec<u8>>,
}

/// Lyrics that come with a local file: a .lrc file next to it (same name), else the lyrics tag.
pub fn embedded_lyrics(path: &Path) -> Option<String> {
    if let Ok(text) = std::fs::read_to_string(path.with_extension("lrc")) {
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    tag.get_string(&lofty::tag::ItemKey::Lyrics).map(str::to_string).filter(|s| !s.trim().is_empty())
}

pub fn read_meta(path: &Path) -> Option<FileMeta> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let tagged = match lofty::read_from_path(path) {
        Ok(t) => t,
        Err(_) => {
            return Some(FileMeta {
                title: stem,
                artist: String::new(),
                album: None,
                album_artist: None,
                track_no: None,
                disc_no: None,
                year: None,
                duration_ms: None,
                picture: None,
            })
        }
    };
    let duration_ms = Some(tagged.properties().duration().as_millis() as u64).filter(|d| *d > 0);
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let get = |f: &dyn Fn(&lofty::tag::Tag) -> Option<String>| tag.and_then(f).filter(|s| !s.trim().is_empty());
    let title = get(&|t| t.title().map(|s| s.to_string())).unwrap_or(stem);
    let artist = get(&|t| t.artist().map(|s| s.to_string())).unwrap_or_default();
    let album = get(&|t| t.album().map(|s| s.to_string()));
    let album_artist = get(&|t| t.get_string(&lofty::tag::ItemKey::AlbumArtist).map(|s| s.to_string()));
    Some(FileMeta {
        title,
        artist,
        album,
        album_artist,
        track_no: tag.and_then(|t| t.track()),
        disc_no: tag.and_then(|t| t.disk()),
        year: tag.and_then(|t| t.year()),
        duration_ms,
        picture: tag.and_then(|t| t.pictures().first().map(|p| p.data().to_vec())),
    })
}

/// Walk `folders`, updating `local_tracks`. Embedded artwork is written once per album into
/// `art_dir` as `<hash>.jpg`. DB writes are batched in transactions of 200 rows.
pub fn scan(db: &std::sync::Mutex<Db>, folders: &[PathBuf], art_dir: &Path) -> Result<ScanReport> {
    std::fs::create_dir_all(art_dir)?;
    let mut report = ScanReport::default();
    // Snapshot of known files: path -> (mtime, size)
    let known: HashMap<String, (i64, i64)> = {
        let db = db.lock().unwrap();
        let mut st = db.conn.prepare("SELECT path, mtime, size FROM local_tracks")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let mut seen: std::collections::HashSet<String> = Default::default();
    let mut batch: Vec<(PathBuf, String, i64, i64, FileMeta)> = Vec::new();

    let flush = |batch: &mut Vec<(PathBuf, String, i64, i64, FileMeta)>| -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let mut db = db.lock().unwrap();
        let tx = db.conn.transaction()?;
        for (path, folder, mtime, size, m) in batch.drain(..) {
            let id = track_id(&path);
            let art = m.picture.as_ref().and_then(|bytes| {
                let key = format!("{}|{}", m.album_artist.as_deref().unwrap_or(&m.artist), m.album.as_deref().unwrap_or(&m.title));
                let name = format!("{}.jpg", hex::encode(&Sha1::digest(key.as_bytes())[..10]));
                let p = art_dir.join(&name);
                if p.exists() || std::fs::write(&p, bytes).is_ok() {
                    Some(format!("art://local/{name}"))
                } else {
                    None
                }
            });
            tx.execute(
                "INSERT INTO local_tracks(id,path,folder,mtime,size,title,artist,album,album_artist,track_no,disc_no,year,duration_ms,artwork,missing)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0)
                 ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime,size=excluded.size,title=excluded.title,
                   artist=excluded.artist,album=excluded.album,album_artist=excluded.album_artist,track_no=excluded.track_no,
                   disc_no=excluded.disc_no,year=excluded.year,duration_ms=excluded.duration_ms,artwork=excluded.artwork,missing=0",
                params![
                    id,
                    path.to_string_lossy(),
                    folder,
                    mtime,
                    size,
                    m.title,
                    m.artist,
                    m.album,
                    m.album_artist,
                    m.track_no,
                    m.disc_no,
                    m.year,
                    m.duration_ms.map(|d| d as i64),
                    art
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    };

    for folder in folders {
        let folder_s = folder.to_string_lossy().to_string();
        if !folder.exists() {
            // Disconnected drive: leave its tracks alone (they get marked missing below only if
            // the folder is reachable).
            continue;
        }
        for entry in walkdir::WalkDir::new(folder).follow_links(true).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if !entry.file_type().is_file() || !is_audio(path) {
                continue;
            }
            report.scanned += 1;
            let ps = path.to_string_lossy().to_string();
            seen.insert(ps.clone());
            let Ok(md) = entry.metadata() else {
                report.failed += 1;
                continue;
            };
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let size = md.len() as i64;
            match known.get(&ps) {
                Some(&(m, s)) if m == mtime && s == size => {
                    report.unchanged += 1;
                    continue;
                }
                Some(_) => report.updated += 1,
                None => report.added += 1,
            }
            match read_meta(path) {
                Some(meta) => batch.push((path.to_path_buf(), folder_s.clone(), mtime, size, meta)),
                None => report.failed += 1,
            }
            if batch.len() >= 200 {
                flush(&mut batch)?;
            }
        }
    }
    flush(&mut batch)?;

    // Mark files under reachable folders that weren't seen as missing; un-mark seen ones.
    let db = db.lock().unwrap();
    for (path, _) in known.iter() {
        if seen.contains(path) {
            continue;
        }
        let under_reachable = folders.iter().any(|f| f.exists() && Path::new(path).starts_with(f));
        let removed_folder = !folders.iter().any(|f| Path::new(path).starts_with(f));
        if removed_folder {
            db.conn.execute("DELETE FROM local_tracks WHERE path=?1", [path])?;
        } else if under_reachable {
            db.conn.execute("UPDATE local_tracks SET missing=1 WHERE path=?1", [path])?;
            report.missing += 1;
        }
    }
    for p in &seen {
        db.conn.execute("UPDATE local_tracks SET missing=0 WHERE path=?1 AND missing=1", [p])?;
    }
    db.kv_set("local.lastScan", &now())?;
    Ok(report)
}

fn row_to_track(r: &rusqlite::Row) -> rusqlite::Result<Track> {
    let artist: String = r.get(2)?;
    let album: Option<String> = r.get(3)?;
    let album_artist: Option<String> = r.get(4)?;
    let aa = album_artist.clone().unwrap_or_else(|| artist.clone());
    Ok(Track {
        id: r.get(0)?,
        source: Source::Local,
        title: r.get(1)?,
        artist_id: if artist.is_empty() { None } else { Some(format!("local-artist:{}", artist)) },
        artist,
        album_id: album.as_ref().map(|a| format!("local-album:{}\u{1f}{}", aa, a)),
        album,
        duration_ms: r.get::<_, Option<i64>>(5)?.map(|d| d as u64),
        artwork: r.get(6)?,
        stream_key: Some(r.get(7)?),
        track_number: r.get(8)?,
        explicit: false,
        episode: false,
        description: None,
        published: None,
        year: None,
        added_at: None,
    })
}

const TRACK_COLS: &str = "id,title,artist,album,album_artist,duration_ms,artwork,path,track_no";

pub fn tracks(db: &Db) -> Result<Vec<Track>> {
    let mut st = db.conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM local_tracks WHERE missing=0 ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title"
    ))?;
    let rows = st.query_map([], row_to_track)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn albums(db: &Db) -> Result<Vec<Album>> {
    let mut st = db.conn.prepare(
        "SELECT COALESCE(album_artist, artist) aa, album, MAX(year), MAX(artwork) FROM local_tracks
         WHERE missing=0 AND album IS NOT NULL GROUP BY aa, album ORDER BY aa COLLATE NOCASE, album COLLATE NOCASE",
    )?;
    let rows = st.query_map([], |r| {
        let aa: String = r.get(0)?;
        let album: String = r.get(1)?;
        Ok(Album {
            id: format!("local-album:{}\u{1f}{}", aa, album),
            title: album,
            artist_id: Some(format!("local-artist:{}", aa)),
            artist: aa,
            year: r.get(2)?,
            artwork: r.get(3)?,
            kind: Some("album".into()),
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn artists(db: &Db) -> Result<Vec<Artist>> {
    let mut st = db.conn.prepare(
        "SELECT artist, MAX(artwork) FROM local_tracks WHERE missing=0 AND artist<>''
         GROUP BY artist ORDER BY artist COLLATE NOCASE",
    )?;
    let rows = st.query_map([], |r| {
        let name: String = r.get(0)?;
        Ok(Artist { id: format!("local-artist:{}", name), name, artwork: r.get(1)? })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn album_tracks(db: &Db, album_id: &str) -> Result<Vec<Track>> {
    let key = album_id.trim_start_matches("local-album:");
    let (aa, album) = key.split_once('\u{1f}').unwrap_or(("", key));
    let mut st = db.conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM local_tracks WHERE missing=0 AND COALESCE(album_artist,artist)=?1 AND album=?2
         ORDER BY disc_no, track_no, title"
    ))?;
    let rows = st.query_map(params![aa, album], row_to_track)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn artist_tracks(db: &Db, artist_id: &str) -> Result<Vec<Track>> {
    let name = artist_id.trim_start_matches("local-artist:");
    let mut st = db.conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM local_tracks WHERE missing=0 AND (artist=?1 OR album_artist=?1)
         ORDER BY album COLLATE NOCASE, disc_no, track_no"
    ))?;
    let rows = st.query_map([name], row_to_track)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Local tracks by an artist name from another source (case-insensitive, exact name).
pub fn tracks_by_artist_name(db: &Db, name: &str) -> Result<Vec<Track>> {
    let mut st = db.conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM local_tracks WHERE missing=0 AND (artist=?1 COLLATE NOCASE OR album_artist=?1 COLLATE NOCASE)
         ORDER BY album COLLATE NOCASE, disc_no, track_no"
    ))?;
    let rows = st.query_map([name.trim()], row_to_track)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Random local tracks for Autoplay, preferring the given artist's other songs first.
pub fn random_tracks(db: &Db, artist: &str, limit: usize) -> Result<Vec<Track>> {
    let mut st = db.conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM local_tracks WHERE missing=0
         ORDER BY (artist=?1 COLLATE NOCASE OR album_artist=?1 COLLATE NOCASE) DESC, RANDOM() LIMIT ?2"
    ))?;
    let rows = st.query_map(params![artist.trim(), limit as i64], row_to_track)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn albums_by_artist_name(db: &Db, name: &str) -> Result<Vec<Album>> {
    let n = name.trim().to_lowercase();
    Ok(albums(db)?.into_iter().filter(|a| a.artist.to_lowercase() == n).collect())
}

pub fn search_albums(db: &Db, q: &str) -> Result<Vec<Album>> {
    let n = q.trim().to_lowercase();
    Ok(albums(db)?.into_iter().filter(|a| a.title.to_lowercase().contains(&n) || a.artist.to_lowercase().contains(&n)).take(20).collect())
}

pub fn search_artists(db: &Db, q: &str) -> Result<Vec<Artist>> {
    let n = q.trim().to_lowercase();
    Ok(artists(db)?.into_iter().filter(|a| a.name.to_lowercase().contains(&n)).take(20).collect())
}

pub fn search(db: &Db, q: &str, limit: usize) -> Result<Vec<Track>> {
    let like = format!("%{}%", q.replace('%', "").replace('_', ""));
    let mut st = db.conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM local_tracks WHERE missing=0 AND (title LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1) LIMIT ?2"
    ))?;
    let rows = st.query_map(params![like, limit as i64], row_to_track)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn path_for(db: &Db, id: &str) -> Result<Option<(String, bool)>> {
    use rusqlite::OptionalExtension;
    Ok(db
        .conn
        .query_row("SELECT path, missing FROM local_tracks WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get::<_, i64>(1)? != 0))
        })
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn id_is_stable_and_case_insensitive() {
        assert_eq!(track_id(Path::new("C:\\Music\\A.mp3")), track_id(Path::new("c:/music/a.mp3")));
    }

    #[test]
    fn scan_is_incremental_and_tracks_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("music");
        std::fs::create_dir_all(&music).unwrap();
        // Untagged/garbage files still import with the file name as title.
        std::fs::write(music.join("one.mp3"), b"not really audio").unwrap();
        std::fs::write(music.join("two.flac"), b"x").unwrap();
        std::fs::write(music.join("notes.txt"), b"x").unwrap();
        let db = Mutex::new(Db::open_in_memory().unwrap());
        let art = dir.path().join("art");
        let r = scan(&db, &[music.clone()], &art).unwrap();
        assert_eq!((r.scanned, r.added), (2, 2));
        let r = scan(&db, &[music.clone()], &art).unwrap();
        assert_eq!((r.unchanged, r.added), (2, 0));
        std::fs::remove_file(music.join("two.flac")).unwrap();
        let r = scan(&db, &[music.clone()], &art).unwrap();
        assert_eq!(r.missing, 1);
        let t = tracks(&db.lock().unwrap()).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].title, "one");
        // Removing the folder from the library drops its rows.
        scan(&db, &[], &art).unwrap();
        assert!(tracks(&db.lock().unwrap()).unwrap().is_empty());
    }

    #[test]
    fn matches_provider_artists_by_name() {
        let db = Db::open_in_memory().unwrap();
        let ins = |id: &str, title: &str, artist: &str, album_artist: Option<&str>, album: &str, missing: i64| {
            db.conn
                .execute(
                    "INSERT INTO local_tracks(id,path,folder,mtime,size,title,artist,album,album_artist,missing) VALUES(?1,?2,'f',0,0,?3,?4,?5,?6,?7)",
                    rusqlite::params![id, format!("/m/{id}.mp3"), title, artist, album, album_artist, missing],
                )
                .unwrap();
        };
        ins("local:1", "Helena", "My Chemical Romance", None, "Three Cheers", 0);
        ins("local:2", "Feature", "Someone", Some("my chemical romance"), "Comp", 0);
        ins("local:3", "Gone", "My Chemical Romance", None, "Old", 1);
        ins("local:4", "Other", "My Chemical Romance Tribute", None, "X", 0);
        let ids: Vec<_> = tracks_by_artist_name(&db, " MY CHEMICAL ROMANCE ").unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"local:1".to_string()) && ids.contains(&"local:2".to_string()));
        let albums: Vec<_> = albums_by_artist_name(&db, "my chemical romance").unwrap().into_iter().map(|a| a.title).collect();
        assert_eq!(albums.len(), 2);
        assert_eq!(search_artists(&db, "chemical").unwrap().len(), 2);
    }
}
