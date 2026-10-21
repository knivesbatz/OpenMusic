use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tokio::sync::{RwLock, Semaphore};

use crate::db::Db;
use crate::error::{Error, Result};
use crate::plex::{self, Plex};
use crate::secrets::Secrets;
use crate::ytm::Ytm;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Flavor {
    #[serde(rename = "youtube")]
    YouTube,
    Plex,
}

pub struct Dirs {
    pub data: PathBuf,
    pub art: PathBuf,
    pub local_art: PathBuf,
    pub downloads: PathBuf,
}

pub struct AppState {
    pub flavor: Flavor,
    pub db: Mutex<Db>,
    pub http: reqwest::Client,
    pub secrets: Secrets,
    pub dirs: Dirs,
    pub plex: Plex,
    pub plex_session: RwLock<Option<plex::Session>>,
    pub ytm: RwLock<Ytm>,
    pub downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub download_slots: Arc<Semaphore>,
    pub art_slots: Arc<Semaphore>,
    /// Base URL of the local artwork server (`http://127.0.0.1:<port>/<token>`), once started.
    pub art_base: std::sync::OnceLock<String>,
    pub scanning: AtomicBool,
    pub last_yt_refresh: Mutex<Option<std::time::Instant>>,
}

impl AppState {
    pub fn db(&self) -> std::sync::MutexGuard<'_, Db> {
        // A panic while holding the lock must not brick the app: recover the guard.
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub async fn plex_session(&self) -> Result<plex::Session> {
        self.plex_session.read().await.clone().ok_or(Error::NotSignedIn)
    }

    pub async fn ytm(&self) -> Ytm {
        self.ytm.read().await.clone()
    }
}
