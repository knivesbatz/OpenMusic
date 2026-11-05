//! STUB so the core compiles on the rust-core branch. The migrate builder's real `migrate.rs`
//! (the one-time PLEXSpot import) replaces this file at merge; only the interface matters here.

use crate::db::Db;
use crate::secrets::Secrets;

/// Facts about our own data dir, taken before anything is imported.
pub struct Before {
    pub had_own_settings: bool,
    pub had_yt_cookie: bool,
    pub had_local_only: bool,
}

pub fn before(db: &Db, ours: &Secrets) -> Before {
    Before {
        had_own_settings: db.kv_get::<serde_json::Value>("settings").ok().flatten().is_some(),
        had_yt_cookie: ours.get_large("yt.cookie").ok().flatten().is_some(),
        had_local_only: db.kv_get::<bool>("ui.localOnly").ok().flatten().unwrap_or(false),
    }
}

/// The PLEXSpot import (database, files; secrets inline except on macOS). Infallible.
pub fn run(_data_dir: &std::path::Path, _db: &Db, _ours: &Secrets) {}

/// macOS: the keychain step, after the window shows. No-op elsewhere.
pub fn run_secrets_later(_data_dir: &std::path::Path, _db: &Db, _ours: &Secrets) {}
