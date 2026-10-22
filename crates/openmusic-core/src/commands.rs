//! Tauri commands: the single API surface between the UI and the core. Provider-specific
//! behaviour is dispatched on the app flavor and on id prefixes (`app:`, `local-…`, `plex:`,
//! `yt:`), so features one provider lacks degrade without affecting the other app.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::PlayContext;
use crate::error::{Error, Result};
use crate::model::*;
use crate::state::{AppState, Flavor};
use crate::{art, downloads, lastfm, local, lyrics, plex, ytm};

type S<'a> = State<'a, Arc<AppState>>;

// ---- app / settings -------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    flavor: Flavor,
    name: String,
    version: String,
    capabilities: Capabilities,
    /// Base URL of the local artwork server; the UI falls back to `art://` when absent.
    art_base: Option<String>,
    /// "windows", "macos", "linux", "android", "ios".
    platform: &'static str,
    /// "auto" (after an unclean exit) or "manual" when GPU acceleration is off; null otherwise.
    safe_mode: Option<&'static str>,
    /// Launched with `--self-test` (CI): the UI clicks through itself and logs each step.
    self_test: bool,
}

pub fn capabilities(f: Flavor) -> Capabilities {
    match f {
        Flavor::Plex => Capabilities {
            downloads: true,
            quality_control: true,
            podcasts: false,
            crossfade: true,
            gapless: true,
            favorites: true,
            discord_presence: crate::discord::available(f),
        },
        // YouTube blends with two IFrame players (see ui/src/player/engine.ts).
        Flavor::YouTube => Capabilities {
            downloads: false,
            quality_control: false,
            podcasts: true,
            crossfade: true,
            gapless: true,
            favorites: true,
            discord_presence: crate::discord::available(f),
        },
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: S) -> AppInfo {
    AppInfo {
        flavor: state.flavor,
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        capabilities: capabilities(state.flavor),
        art_base: state.art_base.get().cloned(),
        platform: std::env::consts::OS,
        safe_mode: state.safe_mode.get().copied(),
        self_test: std::env::args().any(|a| a == "--self-test"),
    }
}

#[tauri::command(async)]
pub fn settings_get(state: S) -> Result<Value> {
    Ok(state.db().kv_get::<Value>("settings")?.unwrap_or(Value::Object(Default::default())))
}

#[tauri::command]
pub async fn settings_set(state: S<'_>, settings: Value) -> Result<()> {
    if let Some(hl) = settings.get("language").and_then(|l| l.as_str()) {
        let changed = {
            let mut y = state.ytm.write().await;
            let changed = y.hl != hl;
            y.hl = hl.to_string();
            changed
        };
        // YouTube Music answers in the UI language (localized titles where it has them): drop
        // pages cached in the old language. Translations and name aliases are kept.
        if changed && state.flavor == Flavor::YouTube {
            state.db().cache_clear_except(&["tr:", "mbalias:"])?;
        }
    }
    state.db().kv_set("settings", &settings)
}

#[tauri::command(async)]
pub fn kv_get(state: S, key: String) -> Result<Option<Value>> {
    state.db().kv_get(&format!("ui.{key}"))
}

#[tauri::command(async)]
pub fn kv_set(state: S, key: String, value: Value) -> Result<()> {
    state.db().kv_set(&format!("ui.{key}"), &value)
}

// ---- auth -----------------------------------------------------------------------------------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    signed_in: bool,
    account: Option<String>,
    server: Option<String>,
    server_connection: Option<String>,
    needs_server: bool,
}

#[tauri::command]
pub async fn auth_status(state: S<'_>) -> Result<AuthStatus> {
    match state.flavor {
        Flavor::Plex => {
            let token = state.secrets.get("plex.token")?;
            let sess = state.plex_session.read().await.clone();
            Ok(AuthStatus {
                signed_in: token.is_some(),
                account: state.db().kv_get("plex.account")?,
                needs_server: token.is_some() && sess.is_none(),
                server: sess.as_ref().map(|s| s.server.name.clone()),
                server_connection: sess.as_ref().map(|s| if s.relay { "relay" } else if s.local { "local" } else { "remote" }.to_string()),
            })
        }
        Flavor::YouTube => {
            let y = state.ytm().await;
            Ok(AuthStatus { signed_in: y.signed_in(), account: state.db().kv_get("yt.account")?, ..Default::default() })
        }
    }
}

#[tauri::command]
/// The UI opens `auth_url` (the browser on desktop, the app's own webview on Android).
pub async fn plex_pin_start(state: S<'_>) -> Result<plex::Pin> {
    state.plex.pin_create().await
}

/// Returns true once the PIN was approved and the token stored.
#[tauri::command]
pub async fn plex_pin_poll(state: S<'_>, id: u64) -> Result<bool> {
    let Some(token) = state.plex.pin_check(id).await? else { return Ok(false) };
    state.secrets.set("plex.token", &token)?;
    state.secrets.delete("plex.homeToken")?;
    state.db().kv_delete("plex.userUuid")?;
    // A new sign-in asks for the profile again (the UI stores "ui.plex.profileChosen").
    state.db().kv_delete("ui.plex.profileChosen")?;
    if let Ok(name) = state.plex.account_name(&token).await {
        state.db().kv_set("plex.account", &name)?;
    }
    Ok(true)
}

#[tauri::command]
pub async fn plex_servers(state: S<'_>) -> Result<Vec<plex::Server>> {
    let token = state.secrets.get("plex.token")?.ok_or(Error::NotSignedIn)?;
    let mut servers = state.plex.servers(&token).await?;
    // Never send server tokens to the UI.
    for s in servers.iter_mut() {
        s.access_token = String::new();
    }
    Ok(servers)
}

#[tauri::command]
pub async fn plex_select_server(app: AppHandle, state: S<'_>, client_identifier: String) -> Result<String> {
    let token = state.secrets.get("plex.token")?.ok_or(Error::NotSignedIn)?;
    let server = state
        .plex
        .servers(&token)
        .await?
        .into_iter()
        .find(|s| s.client_identifier == client_identifier)
        .ok_or_else(|| Error::NotFound("server".into()))?;
    let sess = state.plex.connect(&server).await?;
    if sess.sections.is_empty() {
        return Err(Error::NotFound("no music libraries on this server".into()));
    }
    state.secrets.set_json("plex.session", &sess)?;
    let name = sess.server.name.clone();
    *state.plex_session.write().await = Some(sess);
    state.db().cache_clear()?;
    let _ = app.emit("auth-changed", ());
    Ok(name)
}

/// Re-probe the stored server (IP changes, LAN vs remote). Called at startup and on demand.
pub async fn plex_reconnect(app: &AppHandle, state: &AppState) -> Result<()> {
    let Some(stored) = state.secrets.get_json::<plex::Session>("plex.session")? else { return Ok(()) };
    // Refresh connection list from plex.tv when possible (addresses change), else reuse stored.
    let server = match state.secrets.get("plex.token")? {
        Some(token) => match state.plex.servers(&token).await {
            Ok(list) => list.into_iter().find(|s| s.client_identifier == stored.server.client_identifier).unwrap_or(stored.server.clone()),
            Err(Error::AuthExpired) => {
                let _ = app.emit("auth-expired", ());
                return Err(Error::AuthExpired);
            }
            Err(_) => stored.server.clone(),
        },
        None => return Ok(()),
    };
    match state.plex.connect(&server).await {
        Ok(sess) => {
            state.secrets.set_json("plex.session", &sess)?;
            *state.plex_session.write().await = Some(sess);
            let _ = app.emit("connection-changed", "online");
            Ok(())
        }
        Err(e) => {
            let _ = app.emit("connection-changed", "offline");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn plex_reconnect_cmd(app: AppHandle, state: S<'_>) -> Result<()> {
    plex_reconnect(&app, &state).await
}

const YT_LOGIN_URL: &str = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com/";
const YT_KEEP: &[&str] = &[
    "SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID", "APISID", "HSID", "SID", "SSID", "__Secure-1PSID", "__Secure-3PSID",
    "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-1PSIDCC", "__Secure-3PSIDCC", "SIDCC", "LOGIN_INFO", "PREF",
];

#[cfg(desktop)]
fn youtube_cookie_header(app: &AppHandle, label: &str) -> String {
    let Some(wv) = app.get_webview_window(label) else { return String::new() };
    let Ok(mut cookies) = wv.cookies() else { return String::new() };
    cookies.sort_by_key(|c| c.domain().unwrap_or_default().len());
    let mut jar = std::collections::BTreeMap::new();
    for c in cookies {
        let d = c.domain().unwrap_or_default().trim_start_matches('.').to_string();
        if (d == "youtube.com" || d.ends_with(".youtube.com")) && YT_KEEP.contains(&c.name()) {
            jar.insert(c.name().to_string(), c.value().to_string());
        }
    }
    jar.into_iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")
}

/// The YouTube cookies worth keeping from a `Cookie` header ("a=b; c=d"), in a stable order.
#[cfg_attr(desktop, allow(dead_code))]
fn keep_yt_cookies(header: &str) -> String {
    let jar: std::collections::BTreeMap<&str, &str> = header
        .split(';')
        .filter_map(|c| c.trim().split_once('='))
        .filter(|(k, _)| YT_KEEP.contains(k))
        .collect();
    jar.into_iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")
}

/// Android: read the webview's cookies through the app's own plugin. wry's `cookies_for_url`
/// gives up after 10 s and then panics on the UI thread when the answer finally comes, which
/// crashed the app while YouTube Music was loading right after sign-in.
#[cfg(mobile)]
async fn read_cookies(app: &AppHandle, _label: &'static str) -> String {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || keep_yt_cookies(&tauri_plugin_openmusic_media::cookies(&app, "https://music.youtube.com/")))
        .await
        .unwrap_or_default()
}

#[cfg(desktop)]
async fn read_cookies(app: &AppHandle, label: &'static str) -> String {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let a = app.clone();
    if app.run_on_main_thread(move || {
        let _ = tx.send(youtube_cookie_header(&a, label));
    }).is_err() {
        return String::new();
    }
    rx.await.unwrap_or_default()
}

async fn yt_adopt_cookie(app: &AppHandle, state: &AppState, cookie: String) -> Result<()> {
    state.secrets.set_large("yt.cookie", &cookie)?;
    state.db().kv_delete("ui.yt.profileChosen")?;
    state.ytm.write().await.cookie = Some(cookie);
    let y = state.ytm().await;
    if let Ok(name) = y.account_name().await {
        state.db().kv_set("yt.account", &name)?;
    }
    state.db().cache_clear()?;
    let _ = app.emit("auth-changed", ());
    Ok(())
}

/// Pages the main webview finished loading, for an Android sign-in in progress (generation, sender).
#[cfg(mobile)]
static LOGIN_PAGES: std::sync::Mutex<Option<(u64, tokio::sync::mpsc::UnboundedSender<tauri::Url>)>> = std::sync::Mutex::new(None);

/// Android: the main window finished loading `url` (see lib.rs). Never blocks: it runs on the UI thread.
#[cfg(mobile)]
pub fn main_page_loaded(url: &tauri::Url) {
    if let Ok(g) = LOGIN_PAGES.lock() {
        if let Some((_, tx)) = g.as_ref() {
            let _ = tx.send(url.clone());
        }
    }
}

/// Android allows a single window, so sign-in happens in the main webview: navigate it to the
/// Google sign-in page, follow its page loads until it lands on music.youtube.com with a session,
/// adopt the cookies and navigate back to the app (which then boots signed in). Page loads come
/// from events rather than polling the webview, whose calls can time out while a heavy page loads.
#[cfg(mobile)]
#[tauri::command]
pub async fn yt_login(app: AppHandle, state: S<'_>) -> Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    let w = app.get_webview_window("main").ok_or_else(|| Error::Invalid("no main window".into()))?;
    let back = w.url().map_err(|e| Error::Invalid(e.to_string()))?;
    let url: tauri::Url = YT_LOGIN_URL.parse().map_err(|_| Error::Invalid("url".into()))?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let gen = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut g) = LOGIN_PAGES.lock() {
        *g = Some((gen, tx));
    }
    w.navigate(url).map_err(|e| Error::Invalid(e.to_string()))?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        // Google's pages have no way back to the app: add a small "Back to the app" button.
        let back_btn = format!(
            "if(!document.getElementById('om-back')&&document.body){{const a=document.createElement('a');a.id='om-back';a.href={href};a.textContent='\\u2190 {name}';a.style.cssText='position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:12px 18px;border-radius:999px;background:#1ed760;color:#000;font:700 15px sans-serif;text-decoration:none;box-shadow:0 4px 16px #0008';document.body.appendChild(a)}}",
            href = serde_json::to_string(back.as_str()).unwrap_or_default(),
            name = app.package_info().name,
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
        let outcome: Option<std::result::Result<(), String>> = loop {
            if GENERATION.load(Ordering::Relaxed) != gen {
                // A newer sign-in took over.
                return;
            }
            if std::time::Instant::now() > deadline {
                break Some(Err("Sign-in timed out. Please try again.".into()));
            }
            let page = match tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await {
                Ok(Some(u)) => Some(u),
                Ok(None) => return,
                Err(_) => None,
            };
            if let Some(u) = &page {
                // Back in the app (the user pressed Back or the button): give up quietly.
                if u.origin() == back.origin() {
                    break None;
                }
                if u.host_str() == Some("music.youtube.com") {
                    // The session cookies can land a moment after the page.
                    let mut cookie = String::new();
                    for _ in 0..5 {
                        cookie = read_cookies(&app, "main").await;
                        if ytm::sapisid(&cookie).is_some() {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                    if ytm::sapisid(&cookie).is_some() {
                        break Some(yt_adopt_cookie(&app, &state, cookie).await.map_err(|e| e.to_string()));
                    }
                }
            }
            // Fire-and-forget: re-add the button on Google's single-page steps.
            let _ = w.eval(&back_btn);
        };
        if let Ok(mut g) = LOGIN_PAGES.lock() {
            if g.as_ref().is_some_and(|(n, _)| *n == gen) {
                *g = None;
            }
        }
        let Some(result) = outcome else { return };
        let _ = w.navigate(back);
        match result {
            Ok(()) => {
                let _ = app.emit("login-done", ());
            }
            Err(e) => {
                let _ = app.emit("login-error", e);
            }
        }
    });
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn yt_login(app: AppHandle, state: S<'_>) -> Result<()> {
    if let Some(w) = app.get_webview_window("ytlogin") {
        let _ = w.set_focus();
        return Ok(());
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let url: tauri::Url = YT_LOGIN_URL.parse().map_err(|_| Error::Invalid("url".into()))?;
    with_browser_args(tauri::WebviewWindowBuilder::new(&app, "ytlogin", tauri::WebviewUrl::External(url)), &state)
        .title("Sign in to YouTube Music")
        .inner_size(500.0, 720.0)
        .on_page_load(move |_w, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished && payload.url().host_str() == Some("music.youtube.com") {
                let _ = tx.send(());
            }
        })
        .build()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            for _ in 0..8 {
                let cookie = read_cookies(&app, "ytlogin").await;
                if ytm::sapisid(&cookie).is_some() {
                    match yt_adopt_cookie(&app, &state, cookie).await {
                        Ok(()) => {
                            let _ = app.emit("login-done", ());
                        }
                        Err(e) => {
                            let _ = app.emit("login-error", e.to_string());
                        }
                    }
                    if let Some(w) = app.get_webview_window("ytlogin") {
                        let _ = w.close();
                    }
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    });
    Ok(())
}

/// Google rotates short-lived session cookies. On an auth failure, load music.youtube.com in a
/// hidden window (same browser profile as the sign-in window) and pick up the fresh jar.
pub async fn yt_refresh_session(app: &AppHandle, state: &AppState) -> bool {
    // A hidden second window isn't possible on Android; there the user signs in again.
    #[cfg(mobile)]
    {
        let _ = (app, state);
        false
    }
    #[cfg(desktop)]
    {
    {
        let mut last = state.last_yt_refresh.lock().unwrap();
        if last.map(|t| t.elapsed().as_secs() < 300).unwrap_or(false) {
            return false;
        }
        *last = Some(std::time::Instant::now());
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let Ok(url) = "https://music.youtube.com/".parse::<tauri::Url>() else { return false };
    let built = with_browser_args(tauri::WebviewWindowBuilder::new(app, "ytrefresh", tauri::WebviewUrl::External(url)), state)
        .visible(false)
        .on_page_load(move |_w, p| {
            if p.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = tx.send(());
            }
        })
        .build();
    if built.is_err() {
        return false;
    }
    let loaded = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv()).await.is_ok();
    let cookie = if loaded { read_cookies(app, "ytrefresh").await } else { String::new() };
    if let Some(w) = app.get_webview_window("ytrefresh") {
        let _ = w.close();
    }
    if ytm::sapisid(&cookie).is_some() {
        let _ = state.secrets.set_large("yt.cookie", &cookie);
        state.ytm.write().await.cookie = Some(cookie);
        return true;
    }
    false
    }
}

/// Run a YouTube call; on an auth failure refresh the cookie jar once and retry.
macro_rules! yt_call {
    ($app:expr, $state:expr, |$y:ident| $body:expr) => {{
        let $y = $state.ytm().await;
        match $body.await {
            Err(Error::AuthExpired) if yt_refresh_session(&$app, &$state).await => {
                let $y = $state.ytm().await;
                $body.await
            }
            Err(Error::AuthExpired) => {
                let _ = $app.emit("auth-expired", ());
                Err(Error::AuthExpired)
            }
            r => r,
        }
    }};
}

#[tauri::command]
pub async fn sign_out(app: AppHandle, state: S<'_>) -> Result<()> {
    match state.flavor {
        Flavor::Plex => {
            state.secrets.delete("plex.token")?;
            state.secrets.delete("plex.homeToken")?;
            state.secrets.delete_large("plex.session")?;
            *state.plex_session.write().await = None;
            state.db().kv_delete("plex.account")?;
            state.db().kv_delete("plex.userUuid")?;
        }
        Flavor::YouTube => {
            state.secrets.delete_large("yt.cookie")?;
            state.ytm.write().await.cookie = None;
            state.db().kv_delete("yt.account")?;
        }
    }
    state.db().cache_clear()?;
    let _ = app.emit("auth-changed", ());
    Ok(())
}

// ---- browsing -------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeData {
    shelves: Vec<Shelf>,
    recent: Vec<Track>,
    contexts: Vec<PlayContext>,
    top_tracks: Vec<Track>,
    stale: bool,
    error: Option<Error>,
}

fn filter_hidden_shelves(shelves: &mut [Shelf], hidden: &std::collections::HashSet<String>) {
    for s in shelves.iter_mut() {
        s.items.retain(|i| !matches!(i, MediaItem::Playlist(p) if hidden.contains(&p.id)));
    }
}

async fn provider_home(app: &AppHandle, state: &AppState) -> Result<Vec<Shelf>> {
    match state.flavor {
        Flavor::Plex => {
            let sess = state.plex_session().await?;
            state.plex.home(&sess).await
        }
        Flavor::YouTube => yt_call!(app, state, |y| y.home()),
    }
}

#[tauri::command]
pub async fn home(app: AppHandle, state: S<'_>, refresh: bool) -> Result<HomeData> {
    let (recent, contexts, top) = {
        let db = state.db();
        (db.recent_tracks(20)?, db.recent_contexts(12)?, db.top_tracks(30, 20)?.into_iter().map(|t| t.0).collect())
    };
    let cached: Option<Vec<Shelf>> = if refresh { None } else { state.db().cache_get("home", true)? };
    let fresh = state.db().cache_get::<Vec<Shelf>>("home", false)?.is_some();
    let (mut shelves, stale, error) = match cached {
        Some(c) => (c, !fresh, None),
        None => match provider_home(&app, &state).await {
            Ok(s) => {
                state.db().cache_put("home", &s, 30 * 60)?;
                (s, false, None)
            }
            Err(e) => (state.db().cache_get("home", true)?.unwrap_or_default(), true, Some(e)),
        },
    };
    let hidden = state.db().hidden_playlists()?;
    filter_hidden_shelves(&mut shelves, &hidden);
    Ok(HomeData { shelves, recent, contexts, top_tracks: top, stale, error })
}

#[tauri::command]
pub async fn search(app: AppHandle, state: S<'_>, query: String) -> Result<SearchResults> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResults::default());
    }
    let key = format!("search:{}", q.to_lowercase());
    let cached = state.db().cache_get::<SearchResults>(&key, false)?;
    let mut res = match cached {
        Some(r) => r,
        None => {
            let r = match state.flavor {
                Flavor::Plex => {
                    let sess = state.plex_session().await?;
                    state.plex.search(&sess, q).await?
                }
                Flavor::YouTube => yt_call!(app, state, |y| y.search(q))?,
            };
            state.db().cache_put(&key, &r, 10 * 60)?;
            r
        }
    };
    let hidden = state.db().hidden_playlists()?;
    res.playlists.retain(|p| !hidden.contains(&p.id));
    // Local files and app playlists are searched too (the UI shows local tracks in their own
    // section, since provider songs come first).
    {
        let db = state.db();
        res.tracks.extend(local::search(&db, q, 20)?);
        res.albums.extend(local::search_albums(&db, q)?);
        res.artists.extend(local::search_artists(&db, q)?);
    }
    let ql = q.to_lowercase();
    let app_pls: Vec<Playlist> = state.db().playlists()?.into_iter().filter(|p| p.title.to_lowercase().contains(&ql)).collect();
    res.playlists.splice(0..0, app_pls);
    Ok(res)
}

/// Full results for one type (the filter chips on the search page).
#[tauri::command]
pub async fn search_kind(app: AppHandle, state: S<'_>, query: String, kind: String) -> Result<SearchResults> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResults::default());
    }
    let key = format!("search:{kind}:{}", q.to_lowercase());
    let cached = state.db().cache_get::<SearchResults>(&key, false)?;
    let mut res = match cached {
        Some(r) => r,
        None => {
            let r = match state.flavor {
                Flavor::Plex => {
                    let sess = state.plex_session().await?;
                    state.plex.search_limit(&sess, q, 100).await?
                }
                Flavor::YouTube => yt_call!(app, state, |y| y.search_kind(q, &kind))?,
            };
            state.db().cache_put(&key, &r, 10 * 60)?;
            r
        }
    };
    let hidden = state.db().hidden_playlists()?;
    res.playlists.retain(|p| !hidden.contains(&p.id));
    let db = state.db();
    match kind.as_str() {
        "songs" => res.tracks.extend(local::search(&db, q, 200)?),
        "albums" => res.albums.extend(local::search_albums(&db, q)?),
        "artists" => res.artists.extend(local::search_artists(&db, q)?),
        "playlists" => {
            let ql = q.to_lowercase();
            let app_pls: Vec<Playlist> = db.playlists()?.into_iter().filter(|p| p.title.to_lowercase().contains(&ql)).collect();
            res.playlists.splice(0..0, app_pls);
        }
        _ => {}
    }
    Ok(res)
}

/// Add local files by the same artist name to a provider artist page.
fn with_local(state: &AppState, mut page: ArtistPage) -> Result<ArtistPage> {
    if let Some(name) = page.artist.as_ref().map(|a| a.name.clone()).filter(|n| !n.trim().is_empty()) {
        let db = state.db();
        page.local_tracks = local::tracks_by_artist_name(&db, &name)?;
        page.local_albums = local::albums_by_artist_name(&db, &name)?;
    }
    Ok(page)
}

#[tauri::command]
pub async fn artist(app: AppHandle, state: S<'_>, id: String) -> Result<ArtistPage> {
    if id.starts_with("local-artist:") {
        let db = state.db();
        let tracks = local::artist_tracks(&db, &id)?;
        let name = id.trim_start_matches("local-artist:").to_string();
        let albums = local::albums(&db)?.into_iter().filter(|a| a.artist == name).collect();
        return Ok(ArtistPage {
            artist: Some(Artist { id: id.clone(), name, artwork: tracks.first().and_then(|t| t.artwork.clone()) }),
            top_tracks: tracks.into_iter().take(10).collect(),
            albums,
            ..Default::default()
        });
    }
    let key = format!("artist:{id}");
    let cached = state.db().cache_get::<ArtistPage>(&key, false)?;
    if let Some(p) = cached {
        return with_local(&state, p);
    }
    let page = match state.flavor {
        Flavor::Plex => {
            let sess = state.plex_session().await?;
            state.plex.artist(&sess, &id).await?
        }
        Flavor::YouTube => yt_call!(app, state, |y| y.artist(&id))?,
    };
    state.db().cache_put(&key, &page, 6 * 3600)?;
    with_local(&state, page)
}

#[tauri::command]
pub async fn album(app: AppHandle, state: S<'_>, id: String) -> Result<AlbumPage> {
    if id.starts_with("local-album:") {
        let db = state.db();
        let tracks = local::album_tracks(&db, &id)?;
        let album = local::albums(&db)?.into_iter().find(|a| a.id == id).ok_or_else(|| Error::NotFound(id.clone()))?;
        return Ok(AlbumPage { album, tracks });
    }
    let key = format!("album:{id}");
    if let Some(p) = state.db().cache_get(&key, false)? {
        return Ok(p);
    }
    let page = match state.flavor {
        Flavor::Plex => {
            let sess = state.plex_session().await?;
            state.plex.album(&sess, &id).await?
        }
        Flavor::YouTube => yt_call!(app, state, |y| y.album(&id))?,
    };
    state.db().cache_put(&key, &page, 24 * 3600)?;
    Ok(page)
}

#[tauri::command]
pub async fn playlist(app: AppHandle, state: S<'_>, id: String) -> Result<PlaylistPage> {
    if id.starts_with("app:") {
        let db = state.db();
        let playlist = db.playlist_get(&id)?.ok_or_else(|| Error::NotFound(id.clone()))?;
        return Ok(PlaylistPage { playlist, tracks: db.playlist_tracks(&id)? });
    }
    if state.db().hidden_playlists()?.contains(&id) {
        return Err(Error::NotFound(id));
    }
    let page = match state.flavor {
        Flavor::Plex => {
            let sess = state.plex_session().await?;
            state.plex.playlist(&sess, &id).await?
        }
        Flavor::YouTube if id.starts_with("yt:MPSP") => yt_call!(app, state, |y| y.podcast(&id))?,
        Flavor::YouTube => yt_call!(app, state, |y| y.playlist(&id))?,
    };
    Ok(page)
}

#[tauri::command]
pub async fn library(app: AppHandle, state: S<'_>, refresh: bool) -> Result<Library> {
    let hidden = state.db().hidden_playlists()?;
    let mut lib = match state.flavor {
        Flavor::Plex => {
            let sess = state.plex_session().await?;
            // Incremental sync: reuse the cached library while the server's content fingerprint
            // is unchanged.
            let fp = state.plex.library_fingerprint(&sess).await.ok();
            let cached: Option<(String, Library)> = state.db().kv_get("plex.library")?;
            match cached {
                Some((cfp, lib)) if !refresh && fp.as_deref().map(|f| f == cfp).unwrap_or(true) => lib,
                _ => {
                    let lib = state.plex.library(&sess).await?;
                    if let Some(fp) = fp {
                        state.db().kv_set("plex.library", &(fp, &lib))?;
                    }
                    lib
                }
            }
        }
        Flavor::YouTube => {
            let cached: Option<Library> = if refresh { None } else { state.db().cache_get("yt.library", false)? };
            match cached {
                Some(l) => l,
                None => match yt_call!(app, state, |y| y.library()) {
                    Ok(l) => {
                        state.db().cache_put("yt.library", &l, 15 * 60)?;
                        l
                    }
                    Err(Error::NotSignedIn) => Library::default(),
                    Err(e) => state.db().cache_get("yt.library", true)?.ok_or(e)?,
                },
            }
        }
    };
    lib.playlists.retain(|p| !hidden.contains(&p.id));
    Ok(lib)
}

#[tauri::command]
pub async fn radio(app: AppHandle, state: S<'_>, track: Track) -> Result<Vec<Track>> {
    match (state.flavor, track.source) {
        (Flavor::YouTube, Source::Youtube) => {
            let vid = track.stream_key.clone().unwrap_or_default();
            yt_call!(app, state, |y| y.radio(&vid))
        }
        _ => Ok(vec![]),
    }
}

/// Songs to keep playing when the queue runs out (Settings → Autoplay), seeded by the last
/// track: YouTube Music radio, Plex sonically similar tracks (random library tracks when the
/// server has no sonic analysis), or random local files. Skips anything in `exclude`.
#[tauri::command]
pub async fn autoplay_tracks(app: AppHandle, state: S<'_>, track: Track, exclude: Vec<String>) -> Result<Vec<Track>> {
    let mut tracks = match track.source {
        Source::Youtube => {
            let vid = track.stream_key.clone().unwrap_or_default();
            yt_call!(app, state, |y| y.radio(&vid))?
        }
        Source::Plex => {
            let sess = state.plex_session().await?;
            state.plex.autoplay(&sess, &track.id).await?
        }
        _ => local::random_tracks(&state.db(), &track.artist, 50)?,
    };
    let mut seen: std::collections::HashSet<String> = exclude.into_iter().collect();
    seen.insert(track.id.clone());
    tracks.retain(|t| seen.insert(t.id.clone()));
    tracks.truncate(25);
    Ok(tracks)
}

// ---- playback -------------------------------------------------------------------------------

/// For a YouTube music video, the video id of its song (audio track) version, so playback uses
/// the YouTube Music song rather than the video. Cached with the rest of the song metadata;
/// `None` for songs, podcasts and videos without a song version.
async fn song_version(state: &AppState, video_id: &str, track: &Track) -> Option<String> {
    let is_video = track.artwork.as_deref().map(|a| a.contains("ytimg.com")).unwrap_or(true);
    if track.episode || !is_video {
        return None;
    }
    let key = format!("songmeta:{video_id}");
    let cached = state.db().cache_get::<SongMeta>(&key, false).ok().flatten();
    let meta = match cached {
        Some(m) => m,
        None => {
            let m = state.ytm().await.song_meta(video_id).await.ok()??;
            let _ = state.db().cache_put(&key, &m, 30 * 86400);
            m
        }
    };
    meta.video_id.filter(|v| v != video_id)
}

#[tauri::command]
pub async fn resolve_stream(state: S<'_>, track: Track, quality: String) -> Result<Stream> {
    if let Some(path) = downloads::offline_path(&state, &track.id) {
        return Ok(Stream::File { path, quality: "original".into(), offline: true });
    }
    match track.source {
        Source::Local => {
            let (path, missing) = local::path_for(&state.db(), &track.id)?
                .or_else(|| track.stream_key.clone().map(|p| (p, false)))
                .ok_or_else(|| Error::NotFound(track.title.clone()))?;
            if missing || !std::path::Path::new(&path).exists() {
                return Err(Error::NotFound(format!("file missing: {path}")));
            }
            Ok(Stream::File { path, quality: "original".into(), offline: true })
        }
        Source::Plex => {
            let sess = state.plex_session().await?;
            // Automatic: original quality on LAN, 320 kbps through remote/relay connections.
            let kbps = match quality.as_str() {
                "low" => Some(128),
                "medium" => Some(320),
                "high" => None,
                _ if sess.relay || !sess.local => Some(320),
                _ => None,
            };
            let label = match kbps {
                Some(k) => format!("{k} kbps"),
                None => "original".into(),
            };
            Ok(Stream::Url { url: state.plex.stream_url(&sess, &track, kbps)?, quality: label, offline: false })
        }
        Source::Youtube => {
            let vid = track.stream_key.clone().ok_or_else(|| Error::NotFound(track.title.clone()))?;
            Ok(Stream::Youtube { video_id: song_version(&state, &vid, &track).await.unwrap_or(vid) })
        }
    }
}

#[tauri::command]
pub async fn record_play(state: S<'_>, track: Track, context: Option<PlayContext>) -> Result<()> {
    state.db().record_play(&track, context.as_ref())
}

/// Called when a track finished (or was played past the scrobble point).
#[tauri::command]
pub async fn mark_played(state: S<'_>, track: Track) -> Result<()> {
    if track.source == Source::Plex {
        if let Ok(sess) = state.plex_session().await {
            let _ = state.plex.scrobble(&sess, &track.id).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn rate(state: S<'_>, track: Track, liked: bool) -> Result<()> {
    match track.source {
        Source::Plex => {
            let sess = state.plex_session().await?;
            state.plex.rate(&sess, &track.id, liked).await
        }
        Source::Youtube => {
            let y = state.ytm().await;
            y.rate(track.stream_key.as_deref().unwrap_or_default(), liked).await
        }
        Source::Local => Err(Error::Unsupported("local files".into())),
    }
}

#[tauri::command(async)]
pub fn queue_save(state: S, queue: Value) -> Result<()> {
    state.db().kv_set("queue", &queue)
}

#[tauri::command(async)]
pub fn queue_load(state: S) -> Result<Option<Value>> {
    state.db().kv_get("queue")
}

#[tauri::command]
pub async fn get_lyrics(state: S<'_>, track: Track) -> Result<Option<lyrics::Lyrics>> {
    // Lyrics that came with the track win; online sources are only searched when there are none.
    let embedded = match track.source {
        Source::Local => {
            let path = local::path_for(&state.db(), &track.id)?.map(|(p, _)| std::path::PathBuf::from(p));
            match path {
                Some(p) => tauri::async_runtime::spawn_blocking(move || local::embedded_lyrics(&p)).await.ok().flatten(),
                None => None,
            }
        }
        Source::Plex => match state.plex_session().await {
            Ok(sess) => state.plex.lyrics(&sess, &track.id).await,
            Err(_) => None,
        },
        Source::Youtube => None,
    };
    if let Some(l) = embedded.and_then(|t| lyrics::from_text(&t, if track.source == Source::Plex { "Plex" } else { "the file" })) {
        return Ok(Some(l));
    }
    let key = format!("lyrics:{}", track.id);
    if let Some(l) = state.db().cache_get::<Option<lyrics::Lyrics>>(&key, false)? {
        return Ok(l);
    }
    let l = lyrics::fetch(&state.http, &track).await?;
    state.db().cache_put(&key, &l, if l.is_some() { 30 * 86400 } else { 86400 })?;
    Ok(l)
}

// ---- app playlists --------------------------------------------------------------------------

#[tauri::command(async)]
pub fn pl_list(state: S) -> Result<Vec<Playlist>> {
    state.db().playlists()
}

#[tauri::command(async)]
pub fn pl_create(app: AppHandle, state: S, name: String, tracks: Option<Vec<Track>>) -> Result<Playlist> {
    let mut db = state.db();
    let p = db.playlist_create(name.trim())?;
    if let Some(t) = tracks {
        db.playlist_add(&p.id, &t)?;
    }
    let _ = app.emit("playlists-changed", ());
    Ok(p)
}

#[tauri::command(async)]
pub fn pl_update(app: AppHandle, state: S, id: String, name: String, description: Option<String>) -> Result<()> {
    state.db().playlist_update(&id, name.trim(), description.as_deref())?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

/// Set (or with `image: None`, remove) an app playlist's cover. The UI sends a small JPEG/PNG
/// (cropped and scaled in the webview); it is stored with the local artwork.
#[tauri::command(async)]
pub fn pl_set_cover(app: AppHandle, state: S, id: String, image: Option<Vec<u8>>) -> Result<()> {
    if !id.starts_with("app:") {
        return Err(Error::Invalid("only app playlists have editable covers".into()));
    }
    let cover = match image {
        Some(bytes) => {
            let is_image = bytes.starts_with(&[0xFF, 0xD8, 0xFF]) || bytes.starts_with(b"\x89PNG");
            if !is_image || bytes.len() > 5_000_000 {
                return Err(Error::Invalid("not a JPEG or PNG image".into()));
            }
            std::fs::create_dir_all(&state.dirs.local_art)?;
            let name = format!("cover-{}.jpg", uuid::Uuid::new_v4().simple());
            std::fs::write(state.dirs.local_art.join(&name), &bytes)?;
            Some(format!("art://local/{name}"))
        }
        None => None,
    };
    state.db().playlist_set_cover(&id, cover.as_deref())?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

#[tauri::command(async)]
pub fn pl_delete(app: AppHandle, state: S, id: String) -> Result<()> {
    state.db().playlist_delete(&id)?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

#[tauri::command(async)]
pub fn pl_add(app: AppHandle, state: S, id: String, tracks: Vec<Track>) -> Result<usize> {
    let n = state.db().playlist_add(&id, &tracks)?;
    let _ = app.emit("playlists-changed", ());
    Ok(n)
}

/// Where a song is saved, for the "Saved in" checkboxes: app playlists holding it, and on YouTube
/// the user's own playlists from YouTube Music's "Save to playlist" list.
#[tauri::command]
pub async fn saved_in(app: AppHandle, state: S<'_>, track: Track) -> Result<SavedIn> {
    let app_playlists = state.db().playlists_containing(&track.id)?;
    let mut remote = Vec::new();
    if state.flavor == Flavor::YouTube && track.source == Source::Youtube && !track.episode {
        if let Some(vid) = track.stream_key.clone() {
            // Signed out or refused: just no YouTube section.
            remote = yt_call!(app, state, |y| y.playlist_options(&vid)).unwrap_or_default();
        }
    }
    Ok(SavedIn { app_playlists, remote })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedIn {
    app_playlists: Vec<String>,
    remote: Vec<ytm::PlaylistOption>,
}

#[tauri::command(async)]
pub fn pl_remove_track(app: AppHandle, state: S, id: String, track_id: String) -> Result<usize> {
    let n = state.db().playlist_remove_track(&id, &track_id)?;
    let _ = app.emit("playlists-changed", ());
    Ok(n)
}

/// Add a song to, or remove it from, one of the user's own YouTube playlists.
#[tauri::command]
pub async fn yt_playlist_edit(app: AppHandle, state: S<'_>, playlist_id: String, track: Track, add: bool) -> Result<()> {
    if state.flavor != Flavor::YouTube || track.source != Source::Youtube {
        return Err(Error::Unsupported("adding to YouTube playlists".into()));
    }
    let vid = track.stream_key.clone().ok_or_else(|| Error::Invalid("no video id".into()))?;
    yt_call!(app, state, |y| y.edit_playlist(&playlist_id, &vid, add))
}

#[tauri::command(async)]
pub fn pl_reorder(app: AppHandle, state: S, id: String, order: Vec<usize>) -> Result<()> {
    state.db().playlist_reorder(&id, &order)?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

#[tauri::command(async)]
pub fn hide_playlist(app: AppHandle, state: S, id: String, title: String) -> Result<()> {
    if id.starts_with("app:") {
        return Err(Error::Invalid("app playlists can be deleted instead".into()));
    }
    let db = state.db();
    db.hide_playlist(&id, &title)?;
    db.cache_clear()?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

// ---- local files ----------------------------------------------------------------------------

#[tauri::command(async)]
pub fn local_folders(state: S) -> Result<Vec<String>> {
    let db = state.db();
    let mut st = db.conn.prepare("SELECT path FROM local_folders ORDER BY path")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn allow_asset_dir(app: &AppHandle, path: &str) {
    let _ = app.asset_protocol_scope().allow_directory(path, true);
}

#[tauri::command]
pub async fn local_add_folder(app: AppHandle, state: S<'_>, path: String) -> Result<local::ScanReport> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(Error::NotFound(path));
    }
    state.db().conn.execute("INSERT OR IGNORE INTO local_folders(path, added_at) VALUES(?1, ?2)", rusqlite::params![path, crate::db::now()])?;
    allow_asset_dir(&app, &path);
    local_scan(app, state).await
}

#[tauri::command]
pub async fn local_remove_folder(app: AppHandle, state: S<'_>, path: String) -> Result<local::ScanReport> {
    state.db().conn.execute("DELETE FROM local_folders WHERE path=?1", [&path])?;
    local_scan(app, state).await
}

#[tauri::command]
pub async fn local_scan(app: AppHandle, state: S<'_>) -> Result<local::ScanReport> {
    use std::sync::atomic::Ordering;
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err(Error::Invalid("a scan is already running".into()));
    }
    let folders: Vec<std::path::PathBuf> = local_folders(state.clone())?.into_iter().map(Into::into).collect();
    let st = state.inner().clone();
    let res = tauri::async_runtime::spawn_blocking(move || local::scan(&st.db, &folders, &st.dirs.local_art))
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?;
    state.scanning.store(false, Ordering::SeqCst);
    let _ = app.emit("local-changed", ());
    res
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLibrary {
    tracks: Vec<Track>,
    albums: Vec<Album>,
    artists: Vec<Artist>,
}

#[tauri::command(async)]
pub fn local_library(state: S) -> Result<LocalLibrary> {
    let db = state.db();
    Ok(LocalLibrary { tracks: local::tracks(&db)?, albums: local::albums(&db)?, artists: local::artists(&db)? })
}

// ---- Last.fm --------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LastFmStatus {
    has_keys: bool,
    connected: bool,
    user: Option<String>,
    pending: usize,
}

/// The app's own Last.fm API account, baked in at build time from the LASTFM_API_KEY /
/// LASTFM_API_SECRET repository secrets so users only press "Connect". Keys a user entered
/// themselves take precedence.
fn builtin_lastfm_keys() -> Option<lastfm::Keys> {
    match (option_env!("LASTFM_API_KEY"), option_env!("LASTFM_API_SECRET")) {
        (Some(k), Some(s)) if !k.is_empty() && !s.is_empty() => Some(lastfm::Keys { api_key: k.into(), secret: s.into() }),
        _ => None,
    }
}

fn lastfm_keys(state: &AppState) -> Result<Option<lastfm::Keys>> {
    Ok(state.secrets.get_json("lastfm.keys")?.or_else(builtin_lastfm_keys))
}

fn lastfm_client(state: &AppState) -> Result<lastfm::LastFm> {
    let keys = lastfm_keys(state)?.ok_or_else(|| Error::Invalid("Last.fm API key not set".into()))?;
    Ok(lastfm::LastFm::new(state.http.clone(), keys))
}

#[tauri::command(async)]
pub fn lastfm_status(state: S) -> Result<LastFmStatus> {
    // One lock, released before returning. Two `state.db()` calls in the struct literal kept the
    // first guard alive while taking the second: a self-deadlock that froze the window on opening
    // Settings (1.0.1/1.0.2) and left the database locked for good in 1.0.3.
    let (user, pending) = {
        let db = state.db();
        (db.kv_get("lastfm.user")?, db.scrobble_pending(1000)?.len())
    };
    Ok(LastFmStatus {
        has_keys: lastfm_keys(&state)?.is_some(),
        connected: state.secrets.get("lastfm.sk")?.is_some(),
        user,
        pending,
    })
}

#[tauri::command(async)]
pub fn lastfm_set_keys(state: S, api_key: String, secret: String) -> Result<()> {
    state.secrets.set_json("lastfm.keys", &lastfm::Keys { api_key: api_key.trim().into(), secret: secret.trim().into() })
}

#[tauri::command]
pub async fn lastfm_connect_start(app: AppHandle, state: S<'_>) -> Result<String> {
    let (token, url) = lastfm_client(&state)?.get_token().await?;
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(&url, None::<&str>);
    Ok(token)
}

#[tauri::command]
pub async fn lastfm_connect_finish(state: S<'_>, token: String) -> Result<String> {
    let (sk, user) = lastfm_client(&state)?.get_session(&token).await?;
    state.secrets.set("lastfm.sk", &sk)?;
    state.db().kv_set("lastfm.user", &user)?;
    Ok(user)
}

#[tauri::command(async)]
pub fn lastfm_disconnect(state: S) -> Result<()> {
    state.secrets.delete("lastfm.sk")?;
    state.db().kv_delete("lastfm.user")
}

fn scrobble_of(t: &Track, started_at: i64) -> lastfm::Scrobble {
    lastfm::Scrobble {
        artist: t.artist.split(", ").next().unwrap_or(&t.artist).to_string(),
        track: t.title.clone(),
        album: t.album.clone(),
        timestamp: started_at,
        duration: t.duration_ms.map(|d| (d / 1000) as i64),
    }
}

#[tauri::command]
pub async fn lastfm_now_playing(state: S<'_>, track: Track) -> Result<()> {
    let Some(sk) = state.secrets.get("lastfm.sk")? else { return Ok(()) };
    let client = lastfm_client(&state)?;
    // Fire and forget: now-playing is best effort and must never block playback.
    tauri::async_runtime::spawn(async move {
        let _ = client.now_playing(&sk, &scrobble_of(&track, crate::db::now())).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn lastfm_scrobble(app: AppHandle, state: S<'_>, track: Track, started_at: i64) -> Result<bool> {
    if track.artist.is_empty() || state.secrets.get("lastfm.sk")?.is_none() {
        return Ok(false);
    }
    let queued = state.db().scrobble_enqueue(&scrobble_of(&track, started_at))?;
    let st = state.inner().clone();
    tauri::async_runtime::spawn(async move { flush_scrobbles(&app, &st).await });
    Ok(queued)
}

/// One flush at a time: two concurrent flushes would read the same pending batch and send it
/// twice (duplicate scrobbles).
static SCROBBLE_FLUSH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn flush_scrobbles(app: &AppHandle, state: &AppState) {
    let _one_at_a_time = SCROBBLE_FLUSH.lock().await;
    let (Ok(Some(sk)), Ok(client)) = (state.secrets.get("lastfm.sk"), lastfm_client(state)) else { return };
    loop {
        let pending = match state.db().scrobble_pending(50) {
            Ok(p) if !p.is_empty() => p,
            _ => return,
        };
        let batch: Vec<_> = pending.iter().map(|p| p.1.clone()).collect();
        match client.scrobble_batch(&sk, &batch).await {
            Ok(()) => {
                let ids: Vec<i64> = pending.iter().map(|p| p.0).collect();
                let _ = state.db().scrobble_done(&ids);
            }
            Err(lastfm::CallError::Temporary(_)) => return, // stays queued; retried later
            Err(lastfm::CallError::Auth) => {
                // The session was revoked: forget it so Settings offers "Connect" again. Queued
                // scrobbles stay and are sent after reconnecting.
                let _ = state.secrets.delete("lastfm.sk");
                let _ = app.emit("lastfm-auth-expired", ());
                return;
            }
            Err(lastfm::CallError::Fatal(e)) => {
                // A rejected batch would otherwise block the queue forever.
                log::warn!("last.fm rejected scrobbles: {e}");
                let ids: Vec<i64> = pending.iter().map(|p| p.0).collect();
                let _ = state.db().scrobble_done(&ids);
            }
        }
    }
}

// ---- downloads / storage --------------------------------------------------------------------

#[tauri::command(async)]
pub fn download_tracks(app: AppHandle, state: S, tracks: Vec<Track>) -> Result<usize> {
    let n = downloads::enqueue(app.clone(), state.inner().clone(), tracks)?;
    let _ = app.emit("downloads-changed", ());
    Ok(n)
}

#[tauri::command(async)]
pub fn download_list(state: S) -> Result<Vec<downloads::DownloadInfo>> {
    downloads::list(&state)
}

#[tauri::command]
pub fn download_cancel(state: S, id: String) {
    downloads::cancel(&state, &id)
}

#[tauri::command(async)]
pub fn download_remove(app: AppHandle, state: S, id: String) -> Result<()> {
    downloads::remove(&state, &id)?;
    let _ = app.emit("downloads-changed", ());
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    downloads_bytes: u64,
    art_cache_bytes: u64,
    downloads_dir: String,
}

#[tauri::command]
pub async fn storage_usage(state: S<'_>) -> Result<Storage> {
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || Storage {
        downloads_bytes: crate::art::dir_size(&st.dirs.downloads),
        art_cache_bytes: crate::art::dir_size(&st.dirs.art),
        downloads_dir: st.dirs.downloads.to_string_lossy().into(),
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))
}

/// Clears metadata and artwork caches. Never touches app playlists, downloads or local files.
#[tauri::command]
pub async fn clear_cache(state: S<'_>) -> Result<()> {
    state.db().cache_clear()?;
    state.db().kv_delete("plex.library")?;
    let _ = tokio::fs::remove_dir_all(&state.dirs.art).await;
    tokio::fs::create_dir_all(&state.dirs.art).await?;
    Ok(())
}

// ---- windows --------------------------------------------------------------------------------

/// The mini player is a second always-on-top window: desktop only (Android has one window).
#[cfg(mobile)]
#[tauri::command]
pub async fn pip_toggle(_app: AppHandle, _state: S<'_>) -> Result<bool> {
    Err(Error::Unsupported("mini player window".into()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn pip_toggle(app: AppHandle, state: S<'_>) -> Result<bool> {
    if let Some(w) = app.get_webview_window("pip") {
        let _ = w.close();
        return Ok(false);
    }
    with_browser_args(tauri::WebviewWindowBuilder::new(&app, "pip", tauri::WebviewUrl::App("index.html#pip".into())), &state)
        .title("Mini player")
        .inner_size(320.0, 420.0)
        .min_inner_size(220.0, 96.0)
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(false)
        .build()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    Ok(true)
}

#[tauri::command]
pub fn focus_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(desktop)]
        {
            let _ = w.unminimize();
            let _ = w.show();
        }
        let _ = w.set_focus();
    }
}

// ---- HTPC mode ------------------------------------------------------------------------------

/// Argument the OS passes when the app is launched at sign-in for TV mode.
pub const HTPC_ARG: &str = "--htpc";

/// True when this process was started by the "launch at startup" entry (TV mode).
#[tauri::command]
pub fn htpc_launch() -> bool {
    std::env::args().any(|a| a == HTPC_ARG)
}

#[cfg(desktop)]
#[tauri::command(async)]
pub fn htpc_autostart_get(app: AppHandle) -> Result<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| Error::Invalid(e.to_string()))
}

#[cfg(desktop)]
#[tauri::command(async)]
pub fn htpc_autostart_set(app: AppHandle, enabled: bool) -> Result<()> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    let r = if enabled { al.enable() } else { al.disable() };
    r.map_err(|e| Error::Invalid(e.to_string()))
}

#[cfg(mobile)]
#[tauri::command(async)]
pub fn htpc_autostart_get(_app: AppHandle) -> Result<bool> {
    Err(Error::Unsupported("launch at startup".into()))
}

#[cfg(mobile)]
#[tauri::command(async)]
pub fn htpc_autostart_set(_app: AppHandle, _enabled: bool) -> Result<()> {
    Err(Error::Unsupported("launch at startup".into()))
}

// ---- likes ----------------------------------------------------------------------------------

/// Track ids the user has liked on the provider, so the UI can show the like state.
#[tauri::command]
pub async fn liked_ids(app: AppHandle, state: S<'_>) -> Result<Vec<String>> {
    match state.flavor {
        Flavor::Plex => {
            let sess = state.plex_session().await?;
            Ok(state.plex.liked_track_ids(&sess).await)
        }
        Flavor::YouTube => {
            // "LM" is the account's Liked Music playlist.
            let page = yt_call!(app, state, |y| y.playlist("yt:LM"))?;
            Ok(page.tracks.into_iter().map(|t| t.id).collect())
        }
    }
}

// ---- saved albums / artists ("Your Library") -----------------------------------------------

/// Albums and artists the user saved in this app. Stored locally only, so saving never changes
/// the Plex server or the YouTube account.
#[tauri::command(async)]
pub fn saved_list(state: S) -> Result<Library> {
    let db = state.db();
    Ok(Library {
        albums: db.saved_items("album")?,
        artists: db.saved_items("artist")?,
        podcasts: db.saved_items("podcast")?,
        episodes: db.saved_items("episode")?,
        ..Default::default()
    })
}

/// Follow a podcast in the app (its Library section); never changed on YouTube.
#[tauri::command(async)]
pub fn save_podcast(app: AppHandle, state: S, podcast: Podcast, saved: bool) -> Result<()> {
    let db = state.db();
    if saved { db.save_item("podcast", &podcast.id, &podcast)? } else { db.unsave_item(&podcast.id)? }
    let _ = app.emit("saved-changed", ());
    Ok(())
}

/// Save an episode to "Your Episodes".
#[tauri::command(async)]
pub fn save_episode(app: AppHandle, state: S, episode: Track, saved: bool) -> Result<()> {
    let db = state.db();
    if saved { db.save_item("episode", &episode.id, &episode)? } else { db.unsave_item(&episode.id)? }
    let _ = app.emit("saved-changed", ());
    Ok(())
}

#[tauri::command(async)]
pub fn save_album(app: AppHandle, state: S, album: Album, saved: bool) -> Result<()> {
    let db = state.db();
    if saved { db.save_item("album", &album.id, &album)? } else { db.unsave_item(&album.id)? }
    let _ = app.emit("saved-changed", ());
    Ok(())
}

#[tauri::command(async)]
pub fn save_artist(app: AppHandle, state: S, artist: Artist, saved: bool) -> Result<()> {
    let db = state.db();
    if saved { db.save_item("artist", &artist.id, &artist)? } else { db.unsave_item(&artist.id)? }
    let _ = app.emit("saved-changed", ());
    Ok(())
}

// ---- localized names ------------------------------------------------------------------------

/// Localized aliases for artist names (MusicBrainz), cached for 30 days. Names without an alias
/// are left out of the result. At most 8 uncached names are looked up per call, because
/// MusicBrainz allows one request per second.
#[tauri::command]
pub async fn localized_artist_names(
    state: S<'_>,
    names: Vec<String>,
    locale: String,
) -> Result<std::collections::HashMap<String, String>> {
    if locale != "ja" && locale != "en" {
        return Err(Error::Invalid(format!("unsupported locale {locale}")));
    }
    let mut out = std::collections::HashMap::new();
    let mut lookups = 0;
    for name in names.into_iter().take(50) {
        // Only translate across scripts: Japanese names in the English UI and Latin names in the
        // Japanese UI. An English name in the English UI stays exactly as published.
        if crate::names::has_japanese(&name) == (locale == "ja") {
            continue;
        }
        let key = format!("mbalias:{locale}:{name}");
        // Cached as a string; "" records that MusicBrainz has no alias, so it isn't asked again.
        if let Some(cached) = state.db().cache_get::<String>(&key, false)? {
            if !cached.is_empty() {
                out.insert(name, cached);
            }
            continue;
        }
        if lookups >= 8 {
            continue;
        }
        lookups += 1;
        match crate::names::artist_alias(&state.http, &name, &locale).await {
            Ok(alias) => {
                let ttl = if alias.is_some() { 30 * 86400 } else { 7 * 86400 };
                state.db().cache_put(&key, &alias.clone().unwrap_or_default(), ttl)?;
                if let Some(a) = alias {
                    out.insert(name, a);
                }
            }
            // Offline or rate limited: stop for now; nothing is cached so it is retried later.
            Err(Error::Offline(_)) => break,
            Err(_) => continue,
        }
    }
    Ok(out)
}

/// Machine translations of `texts` into the UI language (lyrics lines, titles), aligned with the
/// input; `None` where a text is already in that language. Cached on disk.
#[tauri::command]
pub async fn translate_texts(state: S<'_>, texts: Vec<String>, locale: String) -> Result<Vec<Option<String>>> {
    if locale != "ja" && locale != "en" {
        return Err(Error::Invalid(format!("unsupported locale {locale}")));
    }
    if texts.len() > 400 {
        return Err(Error::Invalid("too many texts".into()));
    }
    crate::translate::translate(&state, &texts, &locale).await
}

// ---- YouTube profiles (brand accounts) ------------------------------------------------------

/// Channels the signed-in Google account can use: the personal one and brand accounts.
#[tauri::command]
pub async fn yt_accounts(app: AppHandle, state: S<'_>) -> Result<Vec<YtAccount>> {
    if state.flavor != Flavor::YouTube {
        return Err(Error::Unsupported("YouTube profiles".into()));
    }
    let mut list = yt_call!(app, state, |y| y.accounts())?;
    // The list marks the identity of the browser session; ours is whatever was picked here.
    let current = state.ytm().await.page_id;
    for a in &mut list {
        a.selected = a.page_id == current;
    }
    Ok(list)
}

/// Act as the given channel (`None` = the personal account). Cached library data from the
/// previous profile is dropped.
#[tauri::command]
pub async fn yt_select_account(app: AppHandle, state: S<'_>, page_id: Option<String>, name: String) -> Result<()> {
    state.ytm.write().await.page_id = page_id.clone();
    {
        let db = state.db();
        match &page_id {
            Some(id) => db.kv_set("yt.pageId", id)?,
            None => db.kv_delete("yt.pageId")?,
        }
        db.kv_set("yt.account", &name)?;
        db.cache_clear()?;
    }
    let _ = app.emit("auth-changed", ());
    Ok(())
}

/// Square album art and the official artist/album for YouTube music videos (from the video's
/// song counterpart), cached for 30 days. At most 12 uncached lookups per call, 4 at a time.
#[tauri::command]
pub async fn yt_song_meta(
    app: AppHandle,
    state: S<'_>,
    video_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, SongMeta>> {
    let mut out = std::collections::HashMap::new();
    let mut todo = Vec::new();
    for vid in video_ids.into_iter().take(100) {
        match state.db().cache_get::<SongMeta>(&format!("songmeta:{vid}"), false)? {
            Some(m) => {
                out.insert(vid, m);
            }
            None if todo.len() < 12 => todo.push(vid),
            None => {}
        }
    }
    let y = state.ytm().await;
    let results = futures_util::future::join_all(todo.chunks(4).map(|chunk| {
        let y = y.clone();
        let chunk = chunk.to_vec();
        async move {
            let mut r = Vec::new();
            for vid in chunk {
                r.push((vid.clone(), y.song_meta(&vid).await));
            }
            r
        }
    }))
    .await;
    for (vid, res) in results.into_iter().flatten() {
        match res {
            Ok(m) => {
                let m = m.unwrap_or_default();
                state.db().cache_put(&format!("songmeta:{vid}"), &m, 30 * 86400)?;
                out.insert(vid, m);
            }
            Err(Error::AuthExpired) => {
                let _ = app.emit("auth-expired", ());
                break;
            }
            Err(_) => {}
        }
    }
    Ok(out)
}

/// UI errors (uncaught exceptions, render errors) go to the same crash.log as native panics.
#[tauri::command(async)]
pub fn log_ui_error(state: S, message: String) -> Result<()> {
    use std::io::Write;
    let path = state.dirs.data.join("crash.log");
    // Keep the log bounded: start over past 1 MB.
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(f, "[{}] v{} ui: {}", crate::db::now(), env!("CARGO_PKG_VERSION"), message.chars().take(4000).collect::<String>())?;
    Ok(())
}

// ---- Plex Home users (profiles) -------------------------------------------------------------

/// The account token that can list and switch Plex Home users: the admin token saved before
/// the first switch, else the signed-in token.
fn plex_home_token(state: &AppState) -> Result<String> {
    match state.secrets.get("plex.homeToken")? {
        Some(t) => Ok(t),
        None => state.secrets.get("plex.token")?.ok_or(Error::NotSignedIn),
    }
}

#[tauri::command]
pub async fn plex_home_users(state: S<'_>) -> Result<Vec<PlexUser>> {
    let token = plex_home_token(&state)?;
    let mut users = state.plex.home_users(&token).await?;
    let current: Option<String> = state.db().kv_get("plex.userUuid")?;
    for u in &mut users {
        // Before any switch, the signed-in account is the admin.
        u.selected = match &current {
            Some(c) => &u.uuid == c,
            None => u.admin,
        };
    }
    Ok(users)
}

/// Switch to a Plex Home user and reconnect to the same server with their access.
#[tauri::command]
pub async fn plex_switch_user(app: AppHandle, state: S<'_>, uuid: String, pin: Option<String>) -> Result<()> {
    let home = plex_home_token(&state)?;
    let users = state.plex.home_users(&home).await?;
    let user = users.into_iter().find(|u| u.uuid == uuid).ok_or_else(|| Error::NotFound("Plex Home user".into()))?;
    let token = state.plex.switch_user(&home, &uuid, pin.as_deref()).await?;
    if state.secrets.get("plex.homeToken")?.is_none() {
        state.secrets.set("plex.homeToken", &home)?;
    }
    state.secrets.set("plex.token", &token)?;
    {
        let db = state.db();
        db.kv_set("plex.userUuid", &uuid)?;
        db.kv_set("plex.account", &user.title)?;
        db.cache_clear()?;
        db.kv_delete("plex.library")?;
    }
    // Same server if this user can reach it; otherwise they choose one.
    let previous = state.plex_session.read().await.as_ref().map(|s| s.server.client_identifier.clone());
    *state.plex_session.write().await = None;
    state.secrets.delete_large("plex.session")?;
    if let Some(id) = previous {
        if let Some(server) = state.plex.servers(&token).await?.into_iter().find(|s| s.client_identifier == id) {
            if let Ok(sess) = state.plex.connect(&server).await {
                if !sess.sections.is_empty() {
                    state.secrets.set_json("plex.session", &sess)?;
                    *state.plex_session.write().await = Some(sess);
                }
            }
        }
    }
    let _ = app.emit("auth-changed", ());
    Ok(())
}

// ---- safe mode (GPU acceleration) -----------------------------------------------------------

/// Apply safe-mode browser arguments. Every webview window in the process must use the same
/// arguments (WebView2 shares one environment), so all window builders go through this.
pub fn with_browser_args<'a, M: Manager<tauri::Wry>>(
    b: tauri::WebviewWindowBuilder<'a, tauri::Wry, M>,
    state: &AppState,
) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, M> {
    #[cfg(windows)]
    return b.additional_browser_args(if state.safe_mode.get().is_some() { crate::safe_mode::SAFE_ARGS } else { crate::safe_mode::NORMAL_ARGS });
    #[cfg(not(windows))]
    {
        let _ = state;
        b
    }
}

/// Turn the webview's GPU acceleration on or off; takes effect after a restart.
#[tauri::command(async)]
pub fn gpu_set(state: S, enabled: bool) -> Result<()> {
    crate::safe_mode::set_gpu(&state.dirs.data, enabled)?;
    Ok(())
}


/// Mirror the player in the Android media notification (no-op on desktop, where the webview's
/// Media Session already reaches the OS). `artwork` arrives as the track's `art://` reference.
#[tauri::command]
pub async fn media_update(app: AppHandle, state: S<'_>, mut now: tauri_plugin_openmusic_media::NowPlaying) -> Result<()> {
    if cfg!(mobile) {
        now.artwork = match now.artwork.take() {
            Some(a) => art::cached_file(state.inner().clone(), &a, 512).await.map(|p| p.to_string_lossy().into_owned()),
            None => None,
        };
        let _ = tauri::async_runtime::spawn_blocking(move || tauri_plugin_openmusic_media::update(&app, &now)).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn media_stop(app: AppHandle) -> Result<()> {
    if cfg!(mobile) {
        let _ = tauri::async_runtime::spawn_blocking(move || tauri_plugin_openmusic_media::stop(&app)).await;
    }
    Ok(())
}

/// Discord Rich Presence for the playing track (desktop). `now.artwork` is the track's `art://`
/// reference; only public image URLs are passed on. `link` is the track's public page, if any.
#[tauri::command]
pub async fn presence_update(state: S<'_>, now: tauri_plugin_openmusic_media::NowPlaying, link: Option<String>) -> Result<()> {
    let f = state.flavor;
    if !crate::discord::available(f) {
        return Ok(());
    }
    if !now.playing {
        crate::discord::set(f, None);
        return Ok(());
    }
    let public = now
        .artwork
        .as_deref()
        .and_then(|a| a.strip_prefix("art://url/"))
        .and_then(|enc| urlencoding::decode(enc).ok())
        .map(|u| u.into_owned())
        .filter(|u| u.starts_with("https://"));
    let image = match public {
        Some(u) => Some(u),
        None => crate::discord::public_cover(&state.http, &now.artist, now.album.as_deref(), &now.title).await,
    }
    .or_else(|| Some(crate::discord::app_icon(f)));
    let link = link.filter(|l| l.starts_with("https://music.youtube.com/")).map(|l| ("Listen on YouTube Music".to_string(), l));
    crate::discord::set(
        f,
        Some(crate::discord::Presence {
            title: now.title,
            artist: now.artist,
            album: now.album,
            image,
            position_ms: now.position_ms,
            duration_ms: now.duration_ms,
            link,
        }),
    );
    Ok(())
}

#[tauri::command]
pub fn presence_clear(state: S) {
    crate::discord::set(state.flavor, None);
}

/// Self-test progress (see ui/src/selftest.ts), appended to `selftest.log` in the data folder
/// with a timestamp so a hang or crash shows which step it happened in.
#[tauri::command(async)]
pub fn self_test_log(state: S, line: String) -> Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(state.dirs.data.join("selftest.log"))?;
    writeln!(f, "[{}] {line}", crate::db::now())?;
    Ok(())
}

#[tauri::command]
pub fn self_test_exit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn update_check(app: AppHandle, state: S<'_>) -> Result<crate::updater::UpdateInfo> {
    let product = app.config().product_name.clone().unwrap_or_default();
    crate::updater::check(&state.http, &product).await
}

/// Windows: fetch the new installer in the background; it installs when the app closes.
#[tauri::command]
pub async fn update_download(state: S<'_>, url: String) -> Result<()> {
    crate::updater::download(&state.http, &url, &state.dirs.data.join("updates")).await
}

/// "Restart to update": run the downloaded installer (progress window, relaunches the app).
#[tauri::command]
pub fn update_restart(app: AppHandle) -> Result<()> {
    if !crate::updater::run_pending(true) {
        return Err(Error::Invalid("no update has been downloaded".into()));
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_youtube_session_cookies() {
        let raw = "YSC=abc; SAPISID=s1/x; PREF=f6=40000000; SID=sid=val; __Secure-3PAPISID=p3; junk; =x";
        let kept = keep_yt_cookies(raw);
        assert!(kept.contains("SAPISID=s1/x"));
        assert!(kept.contains("SID=sid=val"), "values may contain '='");
        assert!(ytm::sapisid(&kept).is_some());
        assert_eq!(keep_yt_cookies(""), "");
    }
}
