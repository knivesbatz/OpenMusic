use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, Semaphore};

use crate::db::Db;
use crate::error::{Error, Result};
use crate::model::Source;
use crate::plex::{self, Plex};
use crate::secrets::Secrets;
use crate::ytm::Ytm;

/// A streaming service OpenSpot can use. Items carry it in their id prefix (`yt:` / `plex:`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Provider {
    #[serde(rename = "youtube")]
    YouTube,
    #[serde(rename = "plex")]
    Plex,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::YouTube, Provider::Plex];

    /// Which provider an id belongs to: `yt:` is YouTube; `plex:` and `plex-genre:` are Plex.
    /// Local files (`local…`) and app playlists (`app:`) belong to none.
    pub fn of_id(id: &str) -> Option<Provider> {
        let (prefix, _) = id.split_once(':')?;
        match prefix {
            "yt" => Some(Provider::YouTube),
            "plex" | "plex-genre" => Some(Provider::Plex),
            _ => None,
        }
    }

    pub fn of_source(s: Source) -> Option<Provider> {
        match s {
            Source::Youtube => Some(Provider::YouTube),
            Source::Plex => Some(Provider::Plex),
            Source::Local => None,
        }
    }

    /// Serialized name: "youtube" / "plex".
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::YouTube => "youtube",
            Provider::Plex => "plex",
        }
    }

    /// Prefix of every cache key that belongs to this provider (see `db.cache_clear_provider`).
    pub fn cache_prefix(self) -> &'static str {
        match self {
            Provider::YouTube => "yt:",
            Provider::Plex => "plex:",
        }
    }

    /// A cache key of this provider: `yt:home`, `plex:search:<q>`…
    pub fn key(self, rest: &str) -> String {
        format!("{}{rest}", self.cache_prefix())
    }

    /// Product name, for messages (the UI shows its own localized text for known codes).
    pub fn label(self) -> &'static str {
        match self {
            Provider::YouTube => "YouTube Music",
            Provider::Plex => "Plex",
        }
    }

    pub(crate) fn index(self) -> usize {
        match self {
            Provider::YouTube => 0,
            Provider::Plex => 1,
        }
    }
}

/// Cache key for an item page (`kind` = artist, album, lyrics…): `<provider>:<kind>:<id>` for
/// provider ids, `<kind>:<id>` for local ones.
pub fn item_key(kind: &str, id: &str) -> String {
    match Provider::of_id(id) {
        Some(p) => format!("{}{kind}:{id}", p.cache_prefix()),
        None => format!("{kind}:{id}"),
    }
}

/// The Settings → Services switches, persisted at kv `services`. Off hides a provider everywhere
/// and stops its background work, but keeps its sign-in.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Services {
    pub youtube: bool,
    pub plex: bool,
}

impl Services {
    pub fn get(&self, p: Provider) -> bool {
        match p {
            Provider::YouTube => self.youtube,
            Provider::Plex => self.plex,
        }
    }

    pub fn set(&mut self, p: Provider, on: bool) {
        match p {
            Provider::YouTube => self.youtube = on,
            Provider::Plex => self.plex = on,
        }
    }

    /// The switches for a data dir that has none saved yet (first 2.0 start, or a fresh install).
    /// YouTube is on when this data dir was used before (its settings, a cookie, local-only mode or
    /// a YouTube account name). Plex is on when a Plex account or token is there.
    pub fn initial(f: &InitialFacts) -> Services {
        Services {
            youtube: f.had_own_settings || f.had_yt_cookie || f.had_local_only || f.yt_account,
            plex: f.plex_account || f.plex_token,
        }
    }
}

/// What [`Services::initial`] decides from.
#[derive(Debug, Default, Clone, Copy)]
pub struct InitialFacts {
    pub had_own_settings: bool,
    pub had_yt_cookie: bool,
    pub had_local_only: bool,
    pub yt_account: bool,
    pub plex_account: bool,
    pub plex_token: bool,
}

pub struct Dirs {
    pub data: PathBuf,
    pub art: PathBuf,
    pub local_art: PathBuf,
    pub downloads: PathBuf,
}

/// How long a provider that just failed to connect is skipped by fan-out commands.
pub const OFFLINE_SKIP: Duration = Duration::from_secs(60);

pub struct AppState {
    pub db: Mutex<Db>,
    pub http: reqwest::Client,
    pub secrets: Secrets,
    pub dirs: Dirs,
    /// The service switches. Read with [`AppState::services`] (copied out, never held).
    pub services: std::sync::RwLock<Services>,
    pub plex: Plex,
    pub plex_session: RwLock<Option<plex::Session>>,
    pub ytm: RwLock<Ytm>,
    pub downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub download_slots: Arc<Semaphore>,
    pub art_slots: Arc<Semaphore>,
    /// Base URL of the local artwork server (`http://127.0.0.1:<port>/<token>`), once started.
    pub art_base: std::sync::OnceLock<String>,
    /// Safe mode (GPU acceleration off in the webview): "auto" after an unclean exit, "manual"
    /// when turned off in Settings. Unset = normal.
    pub safe_mode: std::sync::OnceLock<&'static str>,
    pub scanning: AtomicBool,
    pub last_yt_refresh: Mutex<Option<Instant>>,
    /// Per provider: skip it in fan-out commands until then (it was just unreachable).
    pub offline_until: Mutex<[Option<Instant>; 2]>,
    /// Ids a per-artist override lets through while their service is off (kv `overrideIds`),
    /// loaded on first use. See [`AppState::allows`].
    pub allowed: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>>,
}

/// kv key of the ids per-artist overrides let through (see [`AppState::allow`]).
pub const OVERRIDE_IDS: &str = "overrideIds";
/// At most this many ids are let through by overrides.
const OVERRIDE_IDS_MAX: usize = 20_000;

impl AppState {
    pub fn db(&self) -> std::sync::MutexGuard<'_, Db> {
        // A panic while holding the lock must not brick the app: recover the guard.
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The service switches (a copy).
    pub fn services(&self) -> Services {
        *self.services.read().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether this provider's switch is on.
    pub fn on(&self, p: Provider) -> bool {
        self.services().get(p)
    }

    fn allowed_set(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
        self.allowed
            .get_or_init(|| Mutex::new(self.db().kv_get::<Vec<String>>(OVERRIDE_IDS).ok().flatten().unwrap_or_default().into_iter().collect()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// A per-artist override ("Always show Plex albums") lets this item through while its
    /// service is off. Never call while holding the database lock.
    pub fn allows(&self, id: &str) -> bool {
        self.allowed_set().contains(id)
    }

    /// Let these items through while their service is off (they're on an overridden artist's
    /// page). Kept across restarts. Never call while holding the database lock.
    pub fn allow(&self, ids: impl IntoIterator<Item = String>) {
        let all = {
            let mut s = self.allowed_set();
            let n = s.len();
            for id in ids {
                if s.len() >= OVERRIDE_IDS_MAX {
                    break;
                }
                s.insert(id);
            }
            (s.len() != n).then(|| s.iter().cloned().collect::<Vec<_>>())
        };
        if let Some(v) = all {
            let _ = self.db().kv_set(OVERRIDE_IDS, &v);
        }
    }

    /// Every id overrides let through.
    pub fn allowed_ids(&self) -> Vec<String> {
        self.allowed_set().iter().cloned().collect()
    }

    /// An override lets some of provider `p`'s items through (so its artwork may be fetched while
    /// it is off).
    pub fn allows_any(&self, p: Provider) -> bool {
        let prefix = match p {
            Provider::YouTube => "yt:",
            Provider::Plex => "plex:",
        };
        self.allowed_set().iter().any(|id| id.starts_with(prefix))
    }

    /// Provider `p` may be asked about `id`: its switch is on, or an override lets `id` through.
    pub fn may_use(&self, p: Provider, id: &str) -> bool {
        self.on(p) || self.allows(id)
    }

    /// The Plex session for item `id`: as [`AppState::plex_session`], but also while Plex is off
    /// when an override lets `id` through.
    pub async fn plex_session_for(&self, id: &str) -> Result<plex::Session> {
        if !self.may_use(Provider::Plex, id) {
            return Err(Error::Disabled(Provider::Plex));
        }
        self.plex_session_any().await
    }

    /// The Plex session whether or not Plex is on (`NotSignedIn` without a server). Only for
    /// per-artist overrides.
    pub async fn plex_session_any(&self) -> Result<plex::Session> {
        self.plex_session.read().await.clone().ok_or(Error::NotSignedIn)
    }

    /// YouTube Music may be used (switch on; anonymous is fine).
    pub fn yt(&self) -> Result<()> {
        if self.on(Provider::YouTube) {
            Ok(())
        } else {
            Err(Error::Disabled(Provider::YouTube))
        }
    }

    /// The Plex session: `Disabled` while the switch is off, `NotSignedIn` without a server.
    pub async fn plex_session(&self) -> Result<plex::Session> {
        if !self.on(Provider::Plex) {
            return Err(Error::Disabled(Provider::Plex));
        }
        self.plex_session.read().await.clone().ok_or(Error::NotSignedIn)
    }

    pub async fn ytm(&self) -> Ytm {
        self.ytm.read().await.clone()
    }

    /// YouTube for account features (library, likes, profiles, playlist edits): `Disabled` while
    /// the switch is off and `NotSignedIn` without a cookie, before any network call.
    pub async fn yt_account(&self) -> Result<Ytm> {
        self.yt()?;
        let y = self.ytm().await;
        if !y.signed_in() {
            return Err(Error::NotSignedIn);
        }
        Ok(y)
    }

    /// The provider was unreachable just now: fan-out commands skip it for a minute. Returns true
    /// when it was considered online before.
    pub fn mark_offline(&self, p: Provider) -> bool {
        let mut g = self.offline_until.lock().unwrap_or_else(|e| e.into_inner());
        let was_online = g[p.index()].is_none_or(|t| t <= Instant::now());
        g[p.index()] = Some(Instant::now() + OFFLINE_SKIP);
        was_online
    }

    /// The provider answered. Returns true when it was marked offline.
    pub fn mark_online(&self, p: Provider) -> bool {
        let mut g = self.offline_until.lock().unwrap_or_else(|e| e.into_inner());
        g[p.index()].take().is_some()
    }

    pub fn is_offline(&self, p: Provider) -> bool {
        let g = self.offline_until.lock().unwrap_or_else(|e| e.into_inner());
        g[p.index()].is_some_and(|t| t > Instant::now())
    }
}

/// An AppState over an in-memory database, for unit tests.
#[cfg(test)]
pub fn test_state() -> AppState {
    let dir = std::env::temp_dir();
    let http = reqwest::Client::new();
    AppState {
        db: Mutex::new(Db::open_in_memory().unwrap()),
        secrets: Secrets::new("app.openmusic.test", &dir),
        dirs: Dirs { data: dir.clone(), art: dir.clone(), local_art: dir.clone(), downloads: dir },
        services: std::sync::RwLock::new(Services::default()),
        plex: Plex::new(http.clone(), "test".into()),
        plex_session: RwLock::new(None),
        ytm: RwLock::new(Ytm::new(http.clone(), None, "en")),
        http,
        downloads: Mutex::new(Default::default()),
        download_slots: Arc::new(Semaphore::new(1)),
        art_slots: Arc::new(Semaphore::new(1)),
        art_base: std::sync::OnceLock::new(),
        safe_mode: std::sync::OnceLock::new(),
        scanning: AtomicBool::new(false),
        last_yt_refresh: Mutex::new(None),
        offline_until: Mutex::new([None; 2]),
        allowed: std::sync::OnceLock::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_of_id() {
        assert_eq!(Provider::of_id("yt:abc"), Some(Provider::YouTube));
        assert_eq!(Provider::of_id("yt:MPREb_x"), Some(Provider::YouTube));
        assert_eq!(Provider::of_id("plex:123"), Some(Provider::Plex));
        assert_eq!(Provider::of_id("plex-genre:5:12"), Some(Provider::Plex));
        assert_eq!(Provider::of_id("local:abc"), None);
        assert_eq!(Provider::of_id("local-album:a\u{1f}b"), None);
        assert_eq!(Provider::of_id("local-artist:x"), None);
        assert_eq!(Provider::of_id("app:123"), None);
        // Always on the colon: these are not provider ids.
        assert_eq!(Provider::of_id("ytx:1"), None);
        assert_eq!(Provider::of_id("plexy:1"), None);
        assert_eq!(Provider::of_id("yt"), None);
        assert_eq!(Provider::of_id(""), None);
    }

    #[test]
    fn provider_serializes_as_lowercase_names() {
        assert_eq!(serde_json::to_string(&Provider::YouTube).unwrap(), "\"youtube\"");
        assert_eq!(serde_json::to_string(&Provider::Plex).unwrap(), "\"plex\"");
        assert_eq!(serde_json::from_str::<Provider>("\"plex\"").unwrap(), Provider::Plex);
        let s: Services = serde_json::from_str(r#"{"youtube":true,"plex":false}"#).unwrap();
        assert!(s.get(Provider::YouTube) && !s.get(Provider::Plex));
    }

    #[test]
    fn item_keys_carry_the_provider() {
        assert_eq!(item_key("artist", "plex:12"), "plex:artist:plex:12");
        assert_eq!(item_key("browsePage", "yt:FEmusic_x"), "yt:browsePage:yt:FEmusic_x");
        assert_eq!(item_key("browsePage", "plex-genre:1:2"), "plex:browsePage:plex-genre:1:2");
        assert_eq!(item_key("lyrics", "local:abc"), "lyrics:local:abc");
        assert_eq!(Provider::YouTube.key("home"), "yt:home");
    }

    #[test]
    fn initial_services() {
        let f = |settings, cookie, local_only, yt_account, plex_account, plex_token| {
            Services::initial(&InitialFacts { had_own_settings: settings, had_yt_cookie: cookie, had_local_only: local_only, yt_account, plex_account, plex_token })
        };
        // Fresh install: both off ("Connect your music").
        assert_eq!(f(false, false, false, false, false, false), Services { youtube: false, plex: false });
        // YTSpot signed in.
        assert_eq!(f(true, true, false, true, false, false), Services { youtube: true, plex: false });
        // YTSpot anonymous (its own settings, no cookie).
        assert_eq!(f(true, false, false, false, false, false), Services { youtube: true, plex: false });
        // YTSpot local files only.
        assert_eq!(f(false, false, true, false, false, false), Services { youtube: true, plex: false });
        // Plex only.
        assert_eq!(f(false, false, false, false, true, true), Services { youtube: false, plex: true });
        // A Plex account name without a token yet is enough.
        assert_eq!(f(false, false, false, false, true, false), Services { youtube: false, plex: true });
        // Both apps.
        assert_eq!(f(true, true, false, true, true, true), Services { youtube: true, plex: true });
    }

    #[test]
    fn switches_gate_providers() {
        let st = test_state();
        assert!(matches!(st.yt(), Err(Error::Disabled(Provider::YouTube))));
        *st.services.write().unwrap() = Services { youtube: true, plex: false };
        assert!(st.yt().is_ok() && st.on(Provider::YouTube) && !st.on(Provider::Plex));
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        assert!(matches!(rt.block_on(st.plex_session()), Err(Error::Disabled(Provider::Plex))));
        assert!(matches!(rt.block_on(st.yt_account()), Err(Error::NotSignedIn)), "no cookie: no network call");
        st.services.write().unwrap().plex = true;
        assert!(matches!(rt.block_on(st.plex_session()), Err(Error::NotSignedIn)));
    }

    #[test]
    fn offline_marks() {
        let st = test_state();
        assert!(!st.is_offline(Provider::Plex));
        assert!(st.mark_offline(Provider::Plex));
        assert!(!st.mark_offline(Provider::Plex), "already offline");
        assert!(st.is_offline(Provider::Plex) && !st.is_offline(Provider::YouTube));
        assert!(st.mark_online(Provider::Plex));
        assert!(!st.is_offline(Provider::Plex));
    }
}
