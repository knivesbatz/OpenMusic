//! Tauri commands: the single API surface between the UI and the core. Provider-specific
//! behaviour is dispatched on id prefixes (`app:`, `local-…`, `plex:`, `yt:`; see
//! [`Provider::of_id`]) and on the Settings → Services switches. Commands that combine both
//! providers (home, library, likes, Browse all, What's New) run each provider that is on as a
//! detached task with a time limit, so one slow or failing provider never fails the call: its part
//! comes from the cache instead and the response lists it under `errors`.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::PlayContext;
use crate::error::{Error, Result};
use crate::model::*;
use crate::state::{item_key, AppState, Provider, Services};
use crate::{art, artist_merge, downloads, lastfm, local, lyrics, plex, ytm};

type S<'a> = State<'a, Arc<AppState>>;

/// Emit an event about one provider: `{ provider }`.
fn emit_for(app: &AppHandle, event: &str, p: Provider) {
    let _ = app.emit(event, json!({ "provider": p }));
}

/// `connection-changed { provider, online }`.
fn emit_connection(app: &AppHandle, p: Provider, online: bool) {
    let _ = app.emit("connection-changed", json!({ "provider": p, "online": online }));
}

/// Remember whether a provider answered, and tell the UI when that changes.
fn note_reachability<T>(app: &AppHandle, state: &AppState, p: Provider, r: &Result<T>) {
    match r {
        Err(Error::Offline(_)) if state.mark_offline(p) => emit_connection(app, p, false),
        Ok(_) if state.mark_online(p) => emit_connection(app, p, true),
        _ => {}
    }
}

/// A failed part as the error of the whole call (when nothing else could be shown).
fn error_of(e: ProviderError) -> Error {
    match e.code.as_str() {
        "offline" | "timeout" => Error::Offline(e.message),
        "authExpired" => Error::AuthExpired(Some(e.provider)),
        _ => Error::Invalid(e.message),
    }
}

fn offline_error(p: Provider) -> Error {
    Error::Offline(format!("{} is not reachable", p.label()))
}

// ---- app / settings -------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ProviderCapabilities {
    youtube: Capabilities,
    plex: Capabilities,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    /// What each provider can do; the UI combines them with `services`.
    providers: ProviderCapabilities,
    services: Services,
    /// Discord Rich Presence is built in (desktop builds with a Discord application id).
    discord_presence: bool,
    /// Base URL of the local artwork server; the UI falls back to `art://` when absent.
    art_base: Option<String>,
    /// "windows", "macos", "linux", "android", "ios".
    platform: &'static str,
    /// "auto" (after an unclean exit) or "manual" when GPU acceleration is off; null otherwise.
    safe_mode: Option<&'static str>,
    /// Launched with `--self-test` (CI): the UI clicks through itself and logs each step.
    self_test: bool,
}

pub fn capabilities(p: Provider) -> Capabilities {
    match p {
        Provider::Plex => Capabilities {
            downloads: true,
            quality_control: true,
            podcasts: false,
            crossfade: true,
            gapless: true,
            favorites: true,
            discord_presence: crate::discord::available(),
        },
        // YouTube blends with two IFrame players (see ui/src/player/engine.ts).
        Provider::YouTube => Capabilities {
            downloads: false,
            quality_control: false,
            podcasts: true,
            crossfade: true,
            gapless: true,
            favorites: true,
            discord_presence: crate::discord::available(),
        },
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: S) -> AppInfo {
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        providers: ProviderCapabilities { youtube: capabilities(Provider::YouTube), plex: capabilities(Provider::Plex) },
        services: state.services(),
        discord_presence: crate::discord::available(),
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
        // YouTube Music answers in the UI language (localized titles where it has them): drop its
        // pages cached in the old language. Plex, translations and name aliases are kept.
        if changed {
            state.db().cache_clear_provider(Provider::YouTube)?;
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

// ---- services (Settings → Services) ---------------------------------------------------------

#[tauri::command]
pub fn services_get(state: S) -> Services {
    state.services()
}

/// Turn services on or off. Off hides a provider and stops its background work but never signs
/// out; nothing here asks anything (the self-test flips every switch).
#[tauri::command]
pub async fn services_set(app: AppHandle, state: S<'_>, services: Services) -> Result<()> {
    apply_services(&app, state.inner(), services)
}

/// Set the switches, save them, emit `services-changed` and start what a switched-on provider
/// needs: Plex re-probes its server (the address may have changed meanwhile), YouTube saves
/// cookies its responses renewed.
pub fn apply_services(app: &AppHandle, state: &Arc<AppState>, new: Services) -> Result<()> {
    let old = {
        let mut g = state.services.write().unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *g, new)
    };
    state.db().kv_set("services", &new)?;
    if old == new {
        return Ok(());
    }
    let _ = app.emit("services-changed", new);
    if new.plex && !old.plex {
        let (app, st) = (app.clone(), state.clone());
        tauri::async_runtime::spawn(async move {
            if plex_reconnect(&app, &st).await.is_ok() {
                emit_for(&app, "auth-changed", Provider::Plex);
            }
        });
    }
    if new.youtube && !old.youtube {
        let st = state.clone();
        tauri::async_runtime::spawn(async move { yt_save_refreshed(&st).await });
    }
    Ok(())
}

fn set_service(app: &AppHandle, state: &Arc<AppState>, p: Provider, on: bool) -> Result<()> {
    let mut s = state.services();
    s.set(p, on);
    apply_services(app, state, s)
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

/// Sign-in state of every provider, whether its switch is on or not.
#[derive(Serialize, Default)]
pub struct AuthAll {
    youtube: AuthStatus,
    plex: AuthStatus,
}

#[tauri::command]
pub async fn auth_status(state: S<'_>) -> Result<AuthAll> {
    // A credential store that can't be read (a denied macOS keychain prompt) reads as signed out.
    let token = state.secrets.get("plex.token").unwrap_or_else(|e| {
        log::warn!("plex.token: {e}");
        None
    });
    let sess = state.plex_session.read().await.clone();
    let (plex_account, yt_account) = {
        let db = state.db();
        (db.kv_get("plex.account")?, db.kv_get("yt.account")?)
    };
    let plex = AuthStatus {
        signed_in: token.is_some(),
        account: plex_account,
        needs_server: token.is_some() && sess.is_none(),
        server: sess.as_ref().map(|s| s.server.name.clone()),
        server_connection: sess.as_ref().map(|s| if s.relay { "relay" } else if s.local { "local" } else { "remote" }.to_string()),
    };
    let youtube = AuthStatus { signed_in: state.ytm().await.signed_in(), account: yt_account, ..Default::default() };
    Ok(AuthAll { youtube, plex })
}

#[tauri::command]
/// The UI opens `auth_url` (the browser on desktop, the app's own webview on Android).
pub async fn plex_pin_start(state: S<'_>) -> Result<plex::Pin> {
    state.plex.pin_create().await
}

/// Returns true once the PIN was approved and the token stored. The Plex switch turns on once a
/// server is chosen (`plex_select_server`).
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

/// Servers of the signed-in account. Part of signing in, so it works with the switch off.
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

/// Use this server. The last step of signing in to Plex, so it turns the Plex switch on.
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
    state.db().cache_clear_provider(Provider::Plex)?;
    state.mark_online(Provider::Plex);
    set_service(&app, state.inner(), Provider::Plex, true)?;
    emit_for(&app, "auth-changed", Provider::Plex);
    Ok(name)
}

/// Re-probe the stored server (IP changes, LAN vs remote). Called at startup, when Plex is turned
/// on, and to recover from a refused or unreachable server.
pub async fn plex_reconnect(app: &AppHandle, state: &AppState) -> Result<()> {
    if !state.on(Provider::Plex) {
        return Err(Error::Disabled(Provider::Plex));
    }
    let Some(stored) = state.secrets.get_json::<plex::Session>("plex.session")? else { return Ok(()) };
    // Refresh connection list from plex.tv when possible (addresses change), else reuse stored.
    let server = match state.secrets.get("plex.token")? {
        Some(token) => match state.plex.servers(&token).await {
            Ok(list) => list.into_iter().find(|s| s.client_identifier == stored.server.client_identifier).unwrap_or(stored.server.clone()),
            Err(Error::AuthExpired(_)) => {
                emit_for(app, "auth-expired", Provider::Plex);
                return Err(Error::AuthExpired(Some(Provider::Plex)));
            }
            Err(_) => stored.server.clone(),
        },
        None => return Ok(()),
    };
    match state.plex.connect(&server).await {
        Ok(sess) => {
            state.secrets.set_json("plex.session", &sess)?;
            *state.plex_session.write().await = Some(sess);
            state.mark_online(Provider::Plex);
            emit_connection(app, Provider::Plex, true);
            Ok(())
        }
        // Only an unreachable server is "offline"; a refused token is a sign-in problem.
        Err(e) => {
            match &e {
                Error::Offline(_) if state.mark_offline(Provider::Plex) => emit_connection(app, Provider::Plex, false),
                Error::AuthExpired(_) => emit_for(app, "auth-expired", Provider::Plex),
                _ => {}
            }
            Err(e)
        }
    }
}

/// A request was refused for its credentials. Before giving up on it the UI calls this for the
/// provider named in the error and retries once when it returns true: Plex servers hand out new
/// access tokens and addresses, and YouTube's cookies are renewed from the webview's store.
#[tauri::command]
pub async fn auth_recover(app: AppHandle, state: S<'_>, provider: Provider) -> Result<bool> {
    Ok(match provider {
        Provider::Plex => plex_reconnect(&app, &state).await.is_ok(),
        Provider::YouTube => yt_refresh_session(&app, &state).await,
    })
}

/// YouTube: save cookies the responses renewed, and renew the session in the background twice a
/// day on desktop (as an open browser tab would), so it doesn't run out between launches. The
/// loop always runs; each tick does nothing while the YouTube switch is off.
pub fn yt_keep_session(app: AppHandle, state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let mut tick = 0u64;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            tick += 1;
            if !state.on(Provider::YouTube) {
                continue;
            }
            yt_save_refreshed(&state).await;
            // Every 30 minutes (first after 2): renew when the last renewal is 12 hours old.
            if cfg!(desktop) && tick % 60 == 4 && state.ytm().await.signed_in() {
                let at: i64 = state.db().kv_get("yt.refreshedAt").ok().flatten().unwrap_or(0);
                if crate::db::now() - at > 12 * 3600 {
                    yt_refresh_session(&app, &state).await;
                }
            }
        }
    });
}

/// Saves the cookie jar if YouTube's responses renewed it.
pub async fn yt_save_refreshed(state: &Arc<AppState>) {
    if let Some(cookie) = state.ytm().await.take_refreshed() {
        let st = state.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || st.secrets.set_large("yt.cookie", &cookie)).await;
    }
}

#[tauri::command]
pub async fn plex_reconnect_cmd(app: AppHandle, state: S<'_>) -> Result<()> {
    plex_reconnect(&app, &state).await
}

const YT_LOGIN_URL: &str = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com/";
const YT_KEEP: &[&str] = ytm::SESSION_COOKIES;

/// kv entries that belong to the signed-in YouTube account (cleared at sign-in and sign-out).
const YT_ACCOUNT_KV: &[&str] = &["yt.pageId", "yt.account", "yt.refreshedAt", "ui.yt.profileChosen"];

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

/// A YouTube sign-in finished: use this account from now on (no brand-account page of a previous
/// one), drop YouTube's cached pages and turn the YouTube switch on.
async fn yt_adopt_cookie(app: &AppHandle, state: &Arc<AppState>, cookie: String) -> Result<()> {
    state.secrets.set_large("yt.cookie", &cookie)?;
    state.ytm.write().await.page_id = None;
    {
        let db = state.db();
        for k in YT_ACCOUNT_KV {
            db.kv_delete(k)?;
        }
    }
    state.ytm.read().await.set_cookie(Some(cookie));
    let y = state.ytm().await;
    if let Ok(name) = y.account_name().await {
        state.db().kv_set("yt.account", &name)?;
    }
    state.db().cache_clear_provider(Provider::YouTube)?;
    set_service(app, state, Provider::YouTube, true)?;
    emit_for(app, "auth-changed", Provider::YouTube);
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


/// The renewal in progress, shared by every caller that needs it (single flight).
type RefreshJob = futures_util::future::Shared<futures_util::future::BoxFuture<'static, bool>>;
static YT_REFRESH: std::sync::Mutex<Option<RefreshJob>> = std::sync::Mutex::new(None);

/// Google rotates short-lived session cookies. Pick up a fresh jar from the webview's own cookie
/// store (the browser profile the user signed in with) and use it from now on. Rate-limited: at
/// most once every 5 minutes. Does nothing without a stored cookie (anonymous YouTube).
///
/// The renewal runs as its own task: a caller that stops waiting (a fan-out time limit) never
/// cancels it halfway, which used to leave the hidden window open and block every later renewal.
pub async fn yt_refresh_session(app: &AppHandle, state: &AppState) -> bool {
    if !state.ytm().await.signed_in() {
        return false;
    }
    let job = {
        let mut g = YT_REFRESH.lock().unwrap_or_else(|e| e.into_inner());
        match g.as_ref() {
            Some(j) if j.peek().is_none() => j.clone(),
            _ => {
                {
                    let mut last = state.last_yt_refresh.lock().unwrap_or_else(|e| e.into_inner());
                    if last.map(|t| t.elapsed().as_secs() < 300).unwrap_or(false) {
                        return false;
                    }
                    *last = Some(std::time::Instant::now());
                }
                let Some(st) = app.try_state::<Arc<AppState>>().map(|s| s.inner().clone()) else { return false };
                let a = app.clone();
                let task = tauri::async_runtime::spawn(async move { yt_refresh_now(&a, &st).await });
                let job: RefreshJob = async move { task.await.unwrap_or(false) }.boxed().shared();
                *g = Some(job.clone());
                job
            }
        }
    };
    job.await
}

async fn yt_refresh_now(app: &AppHandle, state: &AppState) -> bool {
    let cookie = yt_fresh_cookies(app, state).await;
    if ytm::sapisid(&cookie).is_none() {
        return false;
    }
    let _ = state.db().kv_set("yt.refreshedAt", &crate::db::now());
    if state.ytm().await.cookie().as_deref() == Some(cookie.as_str()) {
        return false;
    }
    // Signed out meanwhile: don't bring the session back.
    if !state.ytm().await.signed_in() {
        return false;
    }
    let _ = state.secrets.set_large("yt.cookie", &cookie);
    state.ytm.read().await.set_cookie(Some(cookie));
    true
}

/// Android: the main webview's cookie store, where the user signed in.
#[cfg(mobile)]
async fn yt_fresh_cookies(app: &AppHandle, _state: &AppState) -> String {
    read_cookies(app, "main").await
}

/// Closes the hidden renewal window however the renewal ends.
#[cfg(desktop)]
struct CloseRefreshWindow(AppHandle);

#[cfg(desktop)]
impl Drop for CloseRefreshWindow {
    fn drop(&mut self) {
        if let Some(w) = self.0.get_webview_window("ytrefresh") {
            let _ = w.destroy();
        }
    }
}

/// Desktop: load music.youtube.com in a hidden window (same browser profile as the sign-in
/// window); its scripts renew the session cookies like an open browser tab would.
#[cfg(desktop)]
async fn yt_fresh_cookies(app: &AppHandle, state: &AppState) -> String {
    // A window an earlier renewal left behind would block this one's label.
    if let Some(w) = app.get_webview_window("ytrefresh") {
        let _ = w.destroy();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let Ok(url) = "https://music.youtube.com/".parse::<tauri::Url>() else { return String::new() };
    let built = with_browser_args(tauri::WebviewWindowBuilder::new(app, "ytrefresh", tauri::WebviewUrl::External(url)), state)
        .visible(false)
        .on_page_load(move |_w, p| {
            if p.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = tx.send(());
            }
        })
        .build();
    if built.is_err() {
        return String::new();
    }
    let _close = CloseRefreshWindow(app.clone());
    let loaded = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv()).await.is_ok();
    // Give the page's scripts a moment to renew the cookies.
    if loaded {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
    if loaded { read_cookies(app, "ytrefresh").await } else { String::new() }
}

/// After YouTube refused a request and a refresh didn't help: is the session really gone? YouTube
/// also refuses single requests for other reasons (403s when it throttles, restricted videos), and
/// signing the user out for those made them sign in again and again. Only when the account
/// itself can't be read any more does the UI ask to sign in to YouTube again. Never true (and
/// never emits) without a stored cookie: anonymous YouTube has no session to lose.
pub async fn yt_session_lost(app: &AppHandle, state: &AppState) -> bool {
    let y = state.ytm().await;
    if !y.signed_in() {
        return false;
    }
    let lost = match y.account_name().await {
        Err(Error::AuthExpired(_)) => true,
        Ok(name) => name.is_empty(),
        Err(_) => false,
    };
    if lost {
        emit_for(app, "auth-expired", Provider::YouTube);
    }
    lost
}

/// Run a YouTube call; on an auth failure refresh the cookie jar once and retry. Callers check
/// the switch (`state.yt()` or `state.yt_account()`) first.
macro_rules! yt_call {
    ($app:expr, $state:expr, |$y:ident| $body:expr) => {{
        let $y = $state.ytm().await;
        match $body.await {
            Err(Error::AuthExpired(_)) if yt_refresh_session(&$app, &$state).await => {
                let $y = $state.ytm().await;
                $body.await
            }
            Err(Error::AuthExpired(_)) if yt_session_lost(&$app, &$state).await => Err(Error::AuthExpired(Some(Provider::YouTube))),
            Err(Error::AuthExpired(_)) => Err(Error::Invalid("YouTube turned this request down. Try again in a moment.".into())),
            r => r,
        }
    }};
}

/// Sign out of one provider: its secrets, account kv entries and cached pages. Signing out of Plex
/// turns its switch off (Plex has nothing to show without an account); YouTube stays on and is
/// used anonymously.
#[tauri::command]
pub async fn sign_out(app: AppHandle, state: S<'_>, provider: Provider) -> Result<()> {
    match provider {
        Provider::Plex => {
            state.secrets.delete("plex.token")?;
            state.secrets.delete("plex.homeToken")?;
            state.secrets.delete_large("plex.session")?;
            *state.plex_session.write().await = None;
            {
                let db = state.db();
                for k in ["plex.account", "plex.userUuid", "ui.plex.profileChosen"] {
                    db.kv_delete(k)?;
                }
                // Also the cached library listing (kv plex.library).
                db.cache_clear_provider(Provider::Plex)?;
            }
            set_service(&app, state.inner(), Provider::Plex, false)?;
        }
        Provider::YouTube => {
            state.secrets.delete_large("yt.cookie")?;
            {
                let mut y = state.ytm.write().await;
                y.set_cookie(None);
                y.page_id = None;
            }
            let db = state.db();
            for k in YT_ACCOUNT_KV {
                db.kv_delete(k)?;
            }
            db.cache_clear_provider(Provider::YouTube)?;
        }
    }
    emit_for(&app, "auth-changed", provider);
    Ok(())
}

// ---- fan-out --------------------------------------------------------------------------------

/// How long a combined command waits for a provider's part (Home, Browse all, What's New).
const WAIT_SHORT: Duration = Duration::from_secs(8);
/// Whole-library listings, which can take long on big Plex servers.
const WAIT_LONG: Duration = Duration::from_secs(60);

/// Run `fut` as a detached task and wait up to `wait` for its result. The task always runs to the
/// end; when the caller has stopped waiting, `late` gets its result instead.
async fn detached<T, F>(wait: Duration, fut: F, late: impl FnOnce(T) + Send + 'static) -> Option<T>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        if let Err(r) = tx.send(fut.await) {
            late(r);
        }
    });
    match tokio::time::timeout(wait, &mut rx).await {
        Ok(r) => r.ok(),
        Err(_) => {
            // Closed first: a result that arrives from now on goes to `late`, never nowhere.
            rx.close();
            rx.try_recv().ok()
        }
    }
}

/// One provider's part of a combined result.
struct Part<T> {
    value: T,
    stale: bool,
    error: Option<ProviderError>,
}

/// Run a provider fetch; when Plex refused the session or couldn't be reached, re-probe its server
/// once and retry (YouTube renews its session inside `yt_call!`).
async fn fetch_recovering<T, F, Fut>(app: &AppHandle, state: &Arc<AppState>, p: Provider, fetch: &F) -> Result<T>
where
    F: Fn(AppHandle, Arc<AppState>) -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut r = fetch(app.clone(), state.clone()).await;
    if p == Provider::Plex && matches!(r, Err(Error::AuthExpired(_) | Error::Offline(_))) && plex_reconnect(app, state).await.is_ok() {
        r = fetch(app.clone(), state.clone()).await;
    }
    note_reachability(app, state, p, &r);
    r
}

/// One provider's part of a combined result: `None` when that provider is off or not signed in
/// (nothing to show and nothing to report). Otherwise the fresh value, or after a failure or past
/// `wait` the last cached one (`stale`) with an error. A provider that was just unreachable is
/// skipped at once. When the caller stopped waiting, `late_event` (`{provider}`) tells the UI
/// that the part has arrived since.
async fn provider_part<T, F, Fut>(
    app: &AppHandle,
    state: &Arc<AppState>,
    p: Provider,
    wait: Duration,
    late_event: Option<&'static str>,
    fetch: F,
    stale: impl Fn(&AppState) -> Option<T>,
) -> Option<Part<T>>
where
    T: Default + Send + 'static,
    F: Fn(AppHandle, Arc<AppState>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<T>> + Send + 'static,
{
    if !state.on(p) {
        return None;
    }
    let failed = |error: ProviderError| Some(Part { value: stale(state.as_ref()).unwrap_or_default(), stale: true, error: Some(error) });
    if state.is_offline(p) {
        return failed(ProviderError::of(p, &offline_error(p)));
    }
    let (a, st) = (app.clone(), state.clone());
    let task = async move { fetch_recovering(&a, &st, p, &fetch).await };
    let (a, st) = (app.clone(), state.clone());
    let gen = state.db().generation(p);
    let late = move |r: Result<T>| {
        // Not after a sign-out or account switch: that result belongs to the previous account.
        if let (Ok(_), Some(event), true) = (r, late_event, st.db().generation(p) == gen) {
            emit_for(&a, event, p);
        }
    };
    match detached(wait, task, late).await {
        Some(Ok(value)) => Some(Part { value, stale: false, error: None }),
        // Not failures: the provider has nothing to show.
        Some(Err(Error::NotSignedIn | Error::Disabled(_))) => None,
        Some(Err(e)) => failed(ProviderError::of(p, &e)),
        None => failed(ProviderError { provider: p, code: "timeout".into(), message: format!("{} is taking too long", p.label()) }),
    }
}

/// Write a fetch's result only while the provider's account is the one the fetch started with
/// (`gen` from [`Db::generation`] before the fetch): a sign-out or account switch since then
/// cleared the cache, and the previous account's data must not come back.
fn put_current(st: &AppState, p: Provider, gen: u64, write: impl FnOnce(&crate::db::Db) -> Result<()>) -> Result<()> {
    let db = st.db();
    if db.generation(p) == gen {
        write(&db)?;
    }
    Ok(())
}

/// Merge parts in order: `add` takes each value; returns whether any was stale and the errors.
fn merge_parts<T>(parts: impl IntoIterator<Item = Option<Part<T>>>, mut add: impl FnMut(T)) -> (bool, Vec<ProviderError>) {
    let mut stale = false;
    let mut errors = Vec::new();
    for part in parts.into_iter().flatten() {
        add(part.value);
        stale |= part.stale;
        errors.extend(part.error);
    }
    (stale, errors)
}

/// Read a cache entry and whether it is still fresh, in one lock.
fn cache_with_age<T: serde::de::DeserializeOwned>(state: &AppState, key: &str) -> Option<(T, bool)> {
    let db = state.db();
    let v = db.cache_get::<T>(key, true).ok().flatten()?;
    let fresh = db.cache_get::<Value>(key, false).ok().flatten().is_some();
    Some((v, fresh))
}

// ---- browsing -------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeData {
    shelves: Vec<Shelf>,
    recent: Vec<Track>,
    contexts: Vec<PlayContext>,
    top_tracks: Vec<Track>,
    /// Some part came from an old cache: the UI asks again with `refresh`.
    stale: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    errors: Vec<ProviderError>,
}

fn filter_hidden_shelves(shelves: &mut [Shelf], hidden: &std::collections::HashSet<String>) {
    for s in shelves.iter_mut() {
        s.items.retain(|i| !matches!(i, MediaItem::Playlist(p) if hidden.contains(&p.id)));
    }
}

/// One provider's Home shelves: the cached ones unless `refresh` (stale ones are marked so the UI
/// refreshes), else fetched.
async fn home_part(app: &AppHandle, state: &Arc<AppState>, p: Provider, refresh: bool) -> Option<Part<Vec<Shelf>>> {
    let key = p.key("home");
    if !refresh && state.on(p) {
        if let Some((value, fresh)) = cache_with_age::<Vec<Shelf>>(state, &key) {
            return Some(Part { value, stale: !fresh, error: None });
        }
    }
    let k = key.clone();
    let fetch = move |app: AppHandle, st: Arc<AppState>| {
        let key = k.clone();
        async move {
            let shelves = match p {
                Provider::Plex => {
                    let sess = st.plex_session().await?;
                    st.plex.home(&sess).await?
                }
                Provider::YouTube => {
                    st.yt()?;
                    yt_call!(app, st, |y| y.home())?
                }
            };
            st.db().cache_put(&key, &shelves, 30 * 60)?;
            Ok(shelves)
        }
    };
    provider_part(app, state, p, WAIT_SHORT, None, fetch, move |st| st.db().cache_get(&key, true).ok().flatten()).await
}

/// Home: Plex's shelves first (your own files), then YouTube Music's recommendations.
#[tauri::command]
pub async fn home(app: AppHandle, state: S<'_>, refresh: bool) -> Result<HomeData> {
    let (recent, contexts, top) = {
        let db = state.db();
        (db.recent_tracks(20)?, db.recent_contexts(12)?, db.top_tracks(30, 20)?.into_iter().map(|t| t.0).collect())
    };
    let st = state.inner();
    let (plex, yt) = tokio::join!(home_part(&app, st, Provider::Plex, refresh), home_part(&app, st, Provider::YouTube, refresh));
    let mut shelves = Vec::new();
    let (stale, errors) = merge_parts([plex, yt], |s| shelves.extend(s));
    let hidden = state.db().hidden_playlists()?;
    filter_hidden_shelves(&mut shelves, &hidden);
    let covers = state.db().cover_overrides()?;
    apply_covers(&covers, shelves.iter_mut().flat_map(|s| s.items.iter_mut()).filter_map(|i| match i {
        MediaItem::Playlist(p) => Some(p),
        _ => None,
    }));
    Ok(HomeData { shelves, recent, contexts, top_tracks: top, stale, errors })
}

/// One provider's search results (`kind`: one type in full, for the filter chips), cached for 10
/// minutes under that provider's key.
async fn provider_search(app: &AppHandle, state: &AppState, p: Provider, q: &str, kind: Option<&str>) -> Result<SearchResults> {
    match p {
        Provider::YouTube => state.yt()?,
        Provider::Plex if !state.on(p) => return Err(Error::Disabled(p)),
        Provider::Plex => {}
    }
    let key = match kind {
        Some(k) => p.key(&format!("search:{k}:{}", q.to_lowercase())),
        None => p.key(&format!("search:{}", q.to_lowercase())),
    };
    let cached = state.db().cache_get::<SearchResults>(&key, false)?;
    if let Some(r) = cached {
        return Ok(r);
    }
    if state.is_offline(p) {
        return Err(offline_error(p));
    }
    let r = match p {
        Provider::YouTube => match kind {
            Some(k) => yt_call!(app, state, |y| y.search_kind(q, k)),
            None => yt_call!(app, state, |y| y.search(q)),
        },
        Provider::Plex => match state.plex_session().await {
            Ok(sess) => match kind {
                Some(_) => state.plex.search_limit(&sess, q, 100).await,
                None => state.plex.search(&sess, q).await,
            },
            Err(e) => Err(e),
        },
    };
    note_reachability(app, state, p, &r);
    let r = r?;
    state.db().cache_put(&key, &r, 10 * 60)?;
    Ok(r)
}

fn app_playlists_matching(db: &crate::db::Db, q: &str) -> Result<Vec<Playlist>> {
    let ql = q.to_lowercase();
    Ok(db.playlists()?.into_iter().filter(|p| p.title.to_lowercase().contains(&ql)).collect())
}

/// Search one source: `provider` = that provider's results only (its own `top`); none = local
/// files and app playlists. The UI asks every source at once and merges as they arrive
/// (ui/src/searchMerge.ts), so a slow provider never holds up the others.
#[tauri::command]
pub async fn search(app: AppHandle, state: S<'_>, query: String, provider: Option<Provider>) -> Result<SearchResults> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResults::default());
    }
    let Some(p) = provider else {
        let db = state.db();
        return Ok(SearchResults {
            tracks: local::search(&db, q, 20)?,
            albums: local::search_albums(&db, q)?,
            artists: local::search_artists(&db, q)?,
            playlists: app_playlists_matching(&db, q)?,
            ..Default::default()
        });
    };
    let mut res = provider_search(&app, &state, p, q, None).await?;
    let hidden = state.db().hidden_playlists()?;
    res.playlists.retain(|p| !hidden.contains(&p.id));
    apply_covers(&state.db().cover_overrides()?, res.playlists.iter_mut());
    Ok(res)
}

/// Full results for one type (the filter chips on the search page), from one source as `search`.
#[tauri::command]
pub async fn search_kind(app: AppHandle, state: S<'_>, query: String, kind: String, provider: Option<Provider>) -> Result<SearchResults> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResults::default());
    }
    let Some(p) = provider else {
        let db = state.db();
        let mut res = SearchResults::default();
        match kind.as_str() {
            "songs" => res.tracks = local::search(&db, q, 200)?,
            "albums" => res.albums = local::search_albums(&db, q)?,
            "artists" => res.artists = local::search_artists(&db, q)?,
            "playlists" => res.playlists = app_playlists_matching(&db, q)?,
            _ => {}
        }
        return Ok(res);
    };
    let mut res = provider_search(&app, &state, p, q, Some(&kind)).await?;
    let hidden = state.db().hidden_playlists()?;
    res.playlists.retain(|p| !hidden.contains(&p.id));
    apply_covers(&state.db().cover_overrides()?, res.playlists.iter_mut());
    Ok(res)
}

/// The provider of an item id, with its switch on.
fn provider_of(state: &AppState, id: &str) -> Result<Provider> {
    let p = Provider::of_id(id).ok_or_else(|| Error::NotFound(id.to_string()))?;
    if !state.may_use(p, id) {
        return Err(Error::Disabled(p));
    }
    Ok(p)
}

/// Add local files by the same artist name to a provider artist page (`local_tracks` /
/// `local_albums`, listed apart), as in 1.6.1. Every artist page that isn't merged across sources
/// gets its local files this way, and so do What's New and artist cards.
fn with_local(state: &AppState, mut page: ArtistPage) -> Result<ArtistPage> {
    if let Some(name) = page.artist.as_ref().map(|a| a.name.clone()).filter(|n| !n.trim().is_empty()) {
        let db = state.db();
        page.local_tracks = local::tracks_by_artist_name(&db, &name)?;
        page.local_albums = local::albums_by_artist_name(&db, &name)?;
    }
    Ok(page)
}

/// Local files by every local artist whose name is `name` after normalizing ([`artist_merge::artist_key`]:
/// "Beatles" is "The Beatles"), each once.
fn local_by_key(db: &crate::db::Db, name: &str) -> Result<(Vec<Track>, Vec<Album>)> {
    let key = artist_merge::artist_key(name);
    let mut names = vec![name.trim().to_lowercase()];
    for a in local::artists(db)? {
        let n = a.name.trim().to_lowercase();
        if artist_merge::artist_key(&a.name) == key && !names.contains(&n) {
            names.push(n);
        }
    }
    let (mut tracks, mut albums): (Vec<Track>, Vec<Album>) = (Vec::new(), Vec::new());
    for n in &names {
        for t in local::tracks_by_artist_name(db, n)? {
            if !tracks.iter().any(|x| x.id == t.id) {
                tracks.push(t);
            }
        }
        for a in local::albums_by_artist_name(db, n)? {
            if !albums.iter().any(|x| x.id == a.id) {
                albums.push(a);
            }
        }
    }
    Ok((tracks, albums))
}

/// A merged page's local files (both services on only): a local copy of a song or release already
/// on the page takes its place (see [`artist_merge::add_local`]); the rest are listed apart.
fn with_local_merged(state: &AppState, page: ArtistPage) -> Result<ArtistPage> {
    match page.artist.as_ref().map(|a| a.name.clone()).filter(|n| !artist_merge::artist_key(n).is_empty()) {
        Some(name) => {
            let (tracks, albums) = local_by_key(&state.db(), &name)?;
            Ok(artist_merge::add_local(page, tracks, albums))
        }
        None => with_local(state, page),
    }
}

/// Artists are merged across sources (one Weezer page for YouTube Music, Plex and local files, one
/// card per artist in lists) only while both YouTube Music and Plex are on. With one service on,
/// artist pages and lists are exactly as in 1.6.1: no extra search, local files listed apart.
pub(crate) fn merging(state: &AppState) -> bool {
    Provider::ALL.into_iter().all(|p| state.on(p))
}

/// An artist page; with both services on, the same artist from the other sources is merged in.
#[tauri::command]
pub async fn artist(app: AppHandle, state: S<'_>, id: String) -> Result<ArtistPage> {
    let page = if merging(&state) {
        merged_artist(&app, state.inner(), &id).await?
    } else {
        artist_page(&app, &state, &id).await?
    };
    Ok(with_overrides(&app, state.inner(), &id, page).await)
}

// ---- Per-artist overrides ("Always show Plex albums" in the artist page's ••• menu) ----

const ARTIST_OVERRIDES: &str = "artistOverrides";

fn artist_overrides(db: &crate::db::Db) -> std::collections::HashMap<String, ArtistOverride> {
    db.kv_get(ARTIST_OVERRIDES).ok().flatten().unwrap_or_default()
}

/// The override for artists of this name.
#[tauri::command]
pub fn artist_override(state: S, name: String) -> Result<ArtistOverride> {
    let key = artist_merge::artist_key(&name);
    Ok(artist_overrides(&state.db()).get(&key).copied().unwrap_or_default())
}

/// Turn "always show `provider`'s albums" on or off for artists of this name.
#[tauri::command]
pub fn set_artist_override(state: S, name: String, provider: Provider, on: bool) -> Result<ArtistOverride> {
    set_override(&state.db(), &name, provider, on)
}

fn set_override(db: &crate::db::Db, name: &str, provider: Provider, on: bool) -> Result<ArtistOverride> {
    let key = artist_merge::artist_key(name);
    if key.is_empty() {
        return Err(Error::Invalid("This artist has no name to remember.".into()));
    }
    let mut all = artist_overrides(db);
    let mut o = all.get(&key).copied().unwrap_or_default();
    o.set(provider, on);
    if o == ArtistOverride::default() {
        all.remove(&key);
    } else {
        all.insert(key, o);
    }
    db.kv_set(ARTIST_OVERRIDES, &all)?;
    Ok(o)
}

/// Items overrides let through while their service is off (the UI shows and plays them).
#[tauri::command]
pub fn override_ids(state: S) -> Vec<String> {
    state.allowed_ids()
}

/// Whether the page lists anything from provider `p` already.
fn has_provider(page: &ArtistPage, p: Provider) -> bool {
    let of = |id: &str| Provider::of_id(id) == Some(p);
    page.albums.iter().chain(&page.singles).any(|a| of(&a.id)) || page.top_tracks.iter().any(|t| of(&t.id))
}

/// Add the albums (and songs) of each provider the artist's override asks for and the page
/// doesn't have yet: the artist of exactly this name on that provider, whether or not the
/// provider is on (Plex needs a sign-in). Any failure leaves the page as it was.
async fn with_overrides(app: &AppHandle, st: &Arc<AppState>, id: &str, mut page: ArtistPage) -> ArtistPage {
    let Some(name) = page.artist.as_ref().map(|a| a.name.clone()) else { return page };
    let key = artist_merge::artist_key(&name);
    if key.is_empty() {
        return page;
    }
    let ov = artist_overrides(&st.db()).get(&key).copied().unwrap_or_default();
    for p in Provider::ALL {
        if !ov.get(p) || Provider::of_id(id) == Some(p) || has_provider(&page, p) {
            continue;
        }
        if let Some(other) = forced_counterpart(app, st, p, &name).await {
            page = artist_merge::merge_pages(page, other);
        }
    }
    page
}

/// The artist named exactly `name` on provider `o` (no shared song needed: the user asked for
/// it), with its page; its items are let through while `o` is off.
async fn forced_counterpart(app: &AppHandle, st: &Arc<AppState>, o: Provider, name: &str) -> Option<ArtistPage> {
    if st.is_offline(o) {
        return None;
    }
    let key = o.key(&format!("ovsearch:{}", artist_merge::artist_key(name)));
    let cached = st.db().cache_get::<SearchResults>(&key, false).ok().flatten();
    let res = match cached {
        Some(r) => r,
        None => {
            let gen = st.db().generation(o);
            let r = match o {
                Provider::YouTube => yt_call!(app, st, |y| y.search_kind(name, "artists")).ok()?,
                Provider::Plex => {
                    let sess = st.plex_session_any().await.ok()?;
                    st.plex.search_limit(&sess, name, 100).await.ok()?
                }
            };
            let _ = put_current(st, o, gen, |db| db.cache_put(&key, &r, MATCH_TTL));
            r
        }
    };
    let top = match &res.top {
        Some(MediaItem::Artist(x)) => Some(x),
        _ => None,
    };
    let oid = artist_merge::find_artist(top.into_iter().chain(&res.artists), name)?.id.clone();
    st.allow([oid.clone()]);
    let page = provider_artist(app, st, &oid).await.ok()?;
    st.allow(page.albums.iter().chain(&page.singles).map(|a| a.id.clone()).chain(page.top_tracks.iter().map(|t| t.id.clone())));
    Some(page)
}

/// How long an artist page waits for the other provider's copy of the artist. Past it the page
/// shows without it; the fetch still finishes and is cached for the next visit.
const MERGE_WAIT: Duration = Duration::from_secs(6);

/// How long a match (or "no match") between two sources' artists is kept.
const MATCH_TTL: i64 = 6 * 3600;

/// Cache key of a merged artist page: both providers' ids. `Db::cache_clear_provider` clears
/// every `merged:` entry, so either provider's clear drops it.
fn merged_key(id: &str, other_id: &str) -> String {
    format!("merged:artist:{id}|{other_id}")
}

/// The artist page of `id` merged with the artist of the same (normalized, exact) name on the
/// other providers (both on): the other provider for a provider id, both for a local artist (Plex
/// first). The primary page leads; see [`artist_merge::merge_pages`]. Only called while
/// [`merging`].
pub(crate) async fn merged_artist(app: &AppHandle, state: &Arc<AppState>, id: &str) -> Result<ArtistPage> {
    let primary = Provider::of_id(id);
    let mut page = match primary {
        None => artist_page(app, state, id).await?,
        Some(_) => provider_artist(app, state, id).await?,
    };
    let Some(name) = page.artist.as_ref().map(|a| a.name.clone()).filter(|n| !artist_merge::artist_key(n).is_empty()) else {
        return finish_artist(state, primary, page);
    };
    let mut others: Vec<Provider> = Provider::ALL.into_iter().filter(|o| Some(*o) != primary && state.on(*o)).collect();
    others.sort_by_key(|o| *o != Provider::Plex);
    // One other provider: the merged page may be cached already (the match is, from before).
    let single = match (primary, others.as_slice()) {
        (Some(p), [o]) => Some((p, *o)),
        _ => None,
    };
    if let Some(c) = cached_merge(state, single.map(|(_, o)| o), id)? {
        return Ok(c);
    }
    let gens = single.map(|(p, o)| {
        let db = state.db();
        (db.generation(p), db.generation(o))
    });
    let mut merged_with = None;
    // Asked together (a local artist's page asks both providers); merged in `others`' order.
    let found = futures_util::future::join_all(others.iter().map(|o| counterpart(app, state, *o, id, &name, &page))).await;
    for (oid, other) in found.into_iter().flatten() {
        page = artist_merge::merge_pages(page, other);
        merged_with = Some(oid);
    }
    if let (Some((p, o)), Some((g1, g2)), Some(oid)) = (single, gens, merged_with) {
        let db = state.db();
        if db.generation(p) == g1 && db.generation(o) == g2 {
            db.cache_put(&merged_key(id, &oid), &page, 6 * 3600)?;
        }
    }
    finish_artist(state, primary, page)
}

/// The merged page of provider artist `id` with its match on provider `other`, from the cache
/// (local files added), when both are cached.
fn cached_merge(state: &AppState, other: Option<Provider>, id: &str) -> Result<Option<ArtistPage>> {
    let Some(o) = other else { return Ok(None) };
    // Each lookup is its own statement: the database lock must be released before
    // `with_local_merged` takes it again (a guard in an `if let` scrutinee lives through the block).
    let matched = linked(&state.db(), o, id);
    let Some(oid) = matched else { return Ok(None) };
    let hit = state.db().cache_get::<ArtistPage>(&merged_key(id, &oid), false)?;
    match hit {
        Some(c) => with_local_merged(state, c).map(Some),
        None => Ok(None),
    }
}

/// Provider pages get local files added; a local artist's page has them already.
fn finish_artist(state: &AppState, primary: Option<Provider>, page: ArtistPage) -> Result<ArtistPage> {
    match primary {
        Some(_) => with_local_merged(state, page),
        None => Ok(page),
    }
}

/// Cache key of "which artist on provider `o` is the one of `id`": the matched id once confirmed
/// (same name and a shared song or release), or null for no match. Only confirmed matches are
/// written, so these entries are the links [`artist_links`] answers from.
fn match_key(o: Provider, id: &str) -> String {
    o.key(&format!("artistmatch:{id}"))
}

/// Confirmed matches from the cache, as id pairs (unexpired, "no match" left out).
fn confirmed_links(db: &crate::db::Db) -> Vec<(String, String)> {
    Provider::ALL
        .into_iter()
        .flat_map(|o| db.cache_like::<Option<String>>(&match_key(o, "%")).unwrap_or_default())
        .filter_map(|(k, v)| Some((k.split_once("artistmatch:")?.1.to_string(), v?)))
        .collect()
}

/// The ids linked to one another by confirmed matches, directly or through a third (YouTube's
/// Weezer and Plex's are both the local Weezer's). A group with two artists of one provider is
/// left out: which of the two is meant can't be told.
fn link_groups(db: &crate::db::Db) -> Vec<Vec<String>> {
    let mut groups: Vec<Vec<String>> = Vec::new();
    for (a, b) in confirmed_links(db) {
        let ia = groups.iter().position(|g| g.contains(&a));
        let ib = groups.iter().position(|g| g.contains(&b));
        match (ia, ib) {
            (Some(i), Some(j)) if i != j => {
                let moved = groups.remove(j.max(i));
                groups[j.min(i)].extend(moved);
            }
            (Some(_), Some(_)) => {}
            (Some(i), None) => groups[i].push(b),
            (None, Some(j)) => groups[j].push(a),
            (None, None) => groups.push(vec![a, b]),
        }
    }
    groups.retain(|g| Provider::ALL.into_iter().all(|p| g.iter().filter(|x| Provider::of_id(x) == Some(p)).count() <= 1));
    groups
}

/// The artist on provider `o` that a confirmed match links to `id`, if any.
fn linked(db: &crate::db::Db, o: Provider, id: &str) -> Option<String> {
    let groups = link_groups(db);
    let g = groups.iter().find(|g| g.iter().any(|x| x == id))?;
    g.iter().find(|x| Provider::of_id(x) == Some(o)).cloned()
}

/// Pairs of `ids` that are the same artist, from confirmed matches in the cache only (nothing is
/// fetched): each pair is the first of its group in `ids` and another.
fn links_among(db: &crate::db::Db, ids: &[String]) -> Vec<[String; 2]> {
    let mut out = Vec::new();
    for g in link_groups(db) {
        let mut present: Vec<&String> = Vec::new();
        for id in ids.iter().filter(|i| g.contains(i)) {
            if !present.contains(&id) {
                present.push(id);
            }
        }
        if let Some((first, rest)) = present.split_first() {
            out.extend(rest.iter().map(|r| [(*first).clone(), (*r).clone()]));
        }
    }
    out
}

/// Which of these artists (in a list on screen) are the same artist, as pairs: only matches
/// confirmed before (an artist page visit or [`artist_link_check`]); answered from the cache.
/// Nothing while one service is off (lists are as in 1.6.1).
#[tauri::command]
pub async fn artist_links(state: S<'_>, ids: Vec<String>) -> Result<Vec<[String; 2]>> {
    Ok(artist_links_for(&state, &ids))
}

fn artist_links_for(state: &AppState, ids: &[String]) -> Vec<[String; 2]> {
    if !merging(state) {
        return Vec::new();
    }
    links_among(&state.db(), ids)
}

/// At most this many artists are checked per [`artist_link_check`] call.
const LINK_CHECK_MAX: usize = 20;

/// Artists being checked now (a list shown twice doesn't check them twice at once).
static LINK_CHECKS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Find out in the background whether artists in a list (up to 20; the UI passes only names more
/// than one source lists) are the same artist on the other sources, so the list can show each
/// once. One at a time, each answer cached for 6 hours; emits `artist-links-changed` when a new
/// match was confirmed. Does nothing while one service is off.
#[tauri::command]
pub async fn artist_link_check(app: AppHandle, state: S<'_>, ids: Vec<String>) -> Result<()> {
    let st = state.inner().clone();
    if !merging(&st) {
        return Ok(());
    }
    let ids: Vec<String> = ids.into_iter().filter(|i| i.starts_with("yt:") || i.starts_with("plex:") || i.starts_with("local-artist:")).take(LINK_CHECK_MAX).collect();
    tauri::async_runtime::spawn(async move {
        let mut changed = false;
        for id in ids {
            if !merging(&st) {
                break;
            }
            {
                let mut busy = LINK_CHECKS.lock().unwrap_or_else(|e| e.into_inner());
                if busy.contains(&id) {
                    continue;
                }
                busy.push(id.clone());
            }
            changed |= check_links(&app, &st, &id).await;
            LINK_CHECKS.lock().unwrap_or_else(|e| e.into_inner()).retain(|x| *x != id);
        }
        if changed {
            let _ = app.emit("artist-links-changed", ());
        }
    });
    Ok(())
}

/// Whether provider `o`'s artist for `id` is known already: linked, or "no match" cached.
fn match_known(db: &crate::db::Db, o: Provider, id: &str) -> bool {
    linked(db, o, id).is_some() || db.cache_get::<Option<String>>(&match_key(o, id), false).ok().flatten().is_some()
}

/// Look for `id`'s artist on each other provider not answered yet; true when one was confirmed.
async fn check_links(app: &AppHandle, st: &Arc<AppState>, id: &str) -> bool {
    let primary = Provider::of_id(id);
    let todo: Vec<Provider> = {
        let db = st.db();
        Provider::ALL.into_iter().filter(|o| Some(*o) != primary && !match_known(&db, *o, id)).collect()
    };
    if todo.is_empty() {
        return false;
    }
    let page = match primary {
        None => artist_page(app, st, id).await,
        Some(_) => provider_artist(app, st, id).await,
    };
    let Some(name) = page.as_ref().ok().and_then(|p| p.artist.as_ref()).map(|a| a.name.clone()) else { return false };
    let page = page.unwrap_or_default();
    let mut found = false;
    for o in todo {
        found |= find_match(app, st, o, id, &name, &page).await.is_some();
    }
    found
}

/// [`find_match`], waited for up to [`MERGE_WAIT`] (it still finishes and is cached afterwards).
async fn counterpart(app: &AppHandle, state: &Arc<AppState>, o: Provider, id: &str, name: &str, page: &ArtistPage) -> Option<(String, ArtistPage)> {
    let (a, st, id, name, mine) = (app.clone(), state.clone(), id.to_string(), name.to_string(), page.clone());
    let work = async move { find_match(&a, &st, o, &id, &name, &mine).await };
    detached(MERGE_WAIT, work, |_| {}).await.flatten()
}

/// The artist on provider `o` that is the artist of `id` (whose page is `mine`), with its page: a
/// match confirmed before (see [`linked`]), or else the one artist of exactly this name in `o`'s
/// search (see [`artist_merge::find_artist`]) that shares a song or release with `mine` (Japan's
/// Ghost is not Sweden's, see [`artist_merge::corroborated`]). The answer, "no match" included,
/// is cached for 6 hours. Any failure means no match (and nothing cached).
async fn find_match(app: &AppHandle, st: &Arc<AppState>, o: Provider, id: &str, name: &str, mine: &ArtistPage) -> Option<(String, ArtistPage)> {
    let key = match_key(o, id);
    let known = {
        let db = st.db();
        match linked(&db, o, id) {
            Some(oid) => Some(Some(oid)),
            None => db.cache_get::<Option<String>>(&key, false).ok().flatten(),
        }
    };
    let offline_without = |oid: &str| st.is_offline(o) && st.db().cache_get::<ArtistPage>(&item_key("artist", oid), false).ok().flatten().is_none();
    match known {
        Some(Some(oid)) => {
            if offline_without(&oid) {
                return None;
            }
            let page = provider_artist(app, st, &oid).await.ok()?;
            return Some((oid, page));
        }
        Some(None) => return None,
        None if st.is_offline(o) => return None,
        None => {}
    }
    let gen = st.db().generation(o);
    // YouTube's general search lists few artists; its artist filter lists more.
    let kind = (o == Provider::YouTube).then_some("artists");
    let res = provider_search(app, st, o, name, kind).await.ok()?;
    let top = match &res.top {
        Some(MediaItem::Artist(x)) => Some(x),
        _ => None,
    };
    let Some(oid) = artist_merge::find_artist(top.into_iter().chain(&res.artists), name).map(|x| x.id.clone()) else {
        let _ = put_current(st, o, gen, |db| db.cache_put(&key, &None::<String>, MATCH_TTL));
        return None;
    };
    let page = provider_artist(app, st, &oid).await.ok()?;
    let same = artist_merge::corroborated(mine, &page);
    let _ = put_current(st, o, gen, |db| db.cache_put(&key, &same.then(|| oid.clone()), MATCH_TTL));
    same.then_some((oid, page))
}

pub(crate) async fn artist_page(app: &AppHandle, state: &AppState, id: &str) -> Result<ArtistPage> {
    if id.starts_with("local-artist:") {
        let db = state.db();
        let tracks = local::artist_tracks(&db, id)?;
        let name = id.trim_start_matches("local-artist:").to_string();
        let albums = local::albums(&db)?.into_iter().filter(|a| a.artist == name).collect();
        return Ok(ArtistPage {
            artist: Some(Artist { id: id.to_string(), name, artwork: tracks.first().and_then(|t| t.artwork.clone()) }),
            top_tracks: tracks.into_iter().take(10).collect(),
            albums,
            ..Default::default()
        });
    }
    let page = provider_artist(app, state, id).await?;
    with_local(state, page)
}

/// A provider's artist page as the provider has it (no local files, nothing merged), cached for
/// 6 hours.
async fn provider_artist(app: &AppHandle, state: &AppState, id: &str) -> Result<ArtistPage> {
    let p = provider_of(state, id)?;
    let key = item_key("artist", id);
    let cached = state.db().cache_get::<ArtistPage>(&key, false)?;
    if let Some(page) = cached {
        return Ok(page);
    }
    let gen = state.db().generation(p);
    let page = match p {
        Provider::Plex => {
            let sess = state.plex_session_for(id).await?;
            state.plex.artist(&sess, id).await?
        }
        Provider::YouTube => yt_call!(app, state, |y| y.artist(id))?,
    };
    put_current(state, p, gen, |db| db.cache_put(&key, &page, 6 * 3600))?;
    Ok(page)
}

/// Recent albums and singles from these artists (released this year or last), newest first.
pub(crate) fn recent_releases(pages: Vec<ArtistPage>, this_year: u32) -> Vec<Album> {
    let mut out: Vec<Album> = Vec::new();
    for page in pages {
        let name = page.artist.map(|a| a.name).unwrap_or_default();
        for mut al in page.albums.into_iter().chain(page.singles) {
            if al.year.is_some_and(|y| y + 1 >= this_year) && !out.iter().any(|x| x.id == al.id) {
                if al.artist.is_empty() {
                    al.artist = name.clone();
                }
                out.push(al);
            }
        }
    }
    // Stable: within a year, artists keep the order they were followed in.
    out.sort_by_key(|a| std::cmp::Reverse(a.year));
    out.truncate(40);
    out
}

fn current_year() -> u32 {
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86400).unwrap_or(0);
    // Close enough for "this year": off by at most a day around New Year.
    (1970.0 + days as f64 / 365.2425) as u32
}

/// Whether an item of this id can be shown now: local and app items always, provider items while
/// their switch is on.
fn usable(state: &AppState, id: &str) -> bool {
    Provider::of_id(id).is_none_or(|p| state.on(p))
}

/// "From artists you follow": recent releases of followed artists whose provider is on. Cached
/// for an hour per combination of switches.
async fn followed_releases(app: &AppHandle, state: &Arc<AppState>, refresh: bool) -> Vec<Album> {
    let s = state.services();
    let key = format!("newreleases:followed:{}{}", s.youtube as u8, s.plex as u8);
    if !refresh {
        if let Some(c) = state.db().cache_get::<Vec<Album>>(&key, false).ok().flatten() {
            return c;
        }
    }
    let followed: Vec<Artist> = state.db().saved_items("artist").unwrap_or_default();
    let followed: Vec<Artist> = followed.into_iter().filter(|a| usable(state, &a.id)).take(30).collect();
    let (a, st) = (app.clone(), state.clone());
    let work = async move {
        let mut pages = Vec::new();
        // A few at a time: artist pages are cached for 6 hours, so this is quick after the first visit.
        for chunk in followed.chunks(5) {
            let got = futures_util::future::join_all(chunk.iter().map(|ar| artist_page(&a, &st, &ar.id))).await;
            pages.extend(got.into_iter().filter_map(|r| r.ok()));
        }
        let mine = recent_releases(pages, current_year());
        let _ = st.db().cache_put(&key, &mine, 3600);
        mine
    };
    detached(WAIT_SHORT, work, |_| {}).await.unwrap_or_default()
}

/// What's New: recent releases from followed artists, then each provider's own feed (for Plex,
/// the library's newest releases and additions; YouTube Music's New releases). Each part is cached
/// for an hour.
#[tauri::command]
pub async fn new_releases(app: AppHandle, state: S<'_>, refresh: bool) -> Result<Vec<Shelf>> {
    let st = state.inner();
    let part = |p: Provider| {
        let key = p.key("newreleases");
        let cached = if refresh { None } else { st.db().cache_get::<Vec<Shelf>>(&key, false).ok().flatten() };
        let k = key.clone();
        let fetch = move |app: AppHandle, st: Arc<AppState>| {
            let key = k.clone();
            async move {
                let gen = st.db().generation(p);
                let shelves = match p {
                    Provider::Plex => {
                        let sess = st.plex_session().await?;
                        let mut shelves = Vec::new();
                        let latest = st.plex.latest_releases(&sess).await?;
                        if !latest.is_empty() {
                            shelves.push(Shelf { title: "latestReleases".into(), subtitle: None, items: latest.into_iter().map(MediaItem::Album).collect() });
                        }
                        let added = st.plex.recently_added(&sess).await?;
                        if !added.is_empty() {
                            shelves.push(Shelf { title: "recentlyAdded".into(), subtitle: None, items: added.into_iter().map(MediaItem::Album).collect() });
                        }
                        shelves
                    }
                    Provider::YouTube => {
                        st.yt()?;
                        yt_call!(app, st, |y| y.new_releases())?
                    }
                };
                put_current(&st, p, gen, |db| db.cache_put(&key, &shelves, 3600))?;
                Ok(shelves)
            }
        };
        let app = app.clone();
        async move {
            if let (Some(c), true) = (cached, st.on(p)) {
                return Some(Part { value: c, stale: false, error: None });
            }
            provider_part(&app, st, p, WAIT_SHORT, None, fetch, move |st| st.db().cache_get(&key, true).ok().flatten()).await
        }
    };
    let (mine, plex, yt) = tokio::join!(followed_releases(&app, st, refresh), part(Provider::Plex), part(Provider::YouTube));
    let mut shelves = Vec::new();
    if !mine.is_empty() {
        shelves.push(Shelf { title: "fromArtistsYouFollow".into(), subtitle: None, items: mine.into_iter().map(MediaItem::Album).collect() });
    }
    merge_parts([plex, yt], |s| shelves.extend(s));
    Ok(shelves)
}

#[tauri::command]
pub async fn album(app: AppHandle, state: S<'_>, id: String) -> Result<AlbumPage> {
    if id.starts_with("local-album:") {
        let db = state.db();
        let tracks = local::album_tracks(&db, &id)?;
        let album = local::albums(&db)?.into_iter().find(|a| a.id == id).ok_or_else(|| Error::NotFound(id.clone()))?;
        return Ok(AlbumPage { album, tracks });
    }
    let p = provider_of(&state, &id)?;
    let key = item_key("album", &id);
    let cached = state.db().cache_get::<AlbumPage>(&key, false)?;
    let page = match cached {
        Some(page) => page,
        None => {
            let page = match p {
                Provider::Plex => {
                    let sess = state.plex_session_for(&id).await?;
                    state.plex.album(&sess, &id).await?
                }
                Provider::YouTube => yt_call!(app, state, |y| y.album(&id))?,
            };
            state.db().cache_put(&key, &page, 24 * 3600)?;
            page
        }
    };
    // An album an override shows: its songs play while the service is off.
    if !state.on(p) {
        state.allow(page.tracks.iter().map(|t| t.id.clone()));
    }
    Ok(page)
}

/// YouTube's Liked Music playlist (account only).
fn is_yt_liked(id: &str) -> bool {
    matches!(id, "yt:LM" | "yt:VLLM")
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
    let page = match provider_of(&state, &id)? {
        Provider::Plex => {
            let sess = state.plex_session().await?;
            state.plex.playlist(&sess, &id).await?
        }
        Provider::YouTube if id.starts_with("yt:MPSP") => yt_call!(app, state, |y| y.podcast(&id))?,
        Provider::YouTube => {
            if is_yt_liked(&id) {
                state.yt_account().await?;
            }
            yt_call!(app, state, |y| y.playlist(&id))?
        }
    };
    let mut page = page;
    apply_covers(&state.db().cover_overrides()?, std::iter::once(&mut page.playlist));
    Ok(page)
}

/// One provider's library listing (see [`library`]).
async fn library_part(app: &AppHandle, state: &Arc<AppState>, p: Provider, refresh: bool) -> Option<Part<Library>> {
    match p {
        Provider::YouTube => {
            if !refresh && state.on(p) {
                if let Some(l) = state.db().cache_get::<Library>("yt:library", false).ok().flatten() {
                    return Some(Part { value: l, stale: false, error: None });
                }
            }
            let fetch = |app: AppHandle, st: Arc<AppState>| async move {
                let gen = st.db().generation(Provider::YouTube);
                st.yt_account().await?;
                let l = yt_call!(app, st, |y| y.library())?;
                put_current(&st, Provider::YouTube, gen, |db| db.cache_put("yt:library", &l, 15 * 60))?;
                Ok(l)
            };
            provider_part(app, state, p, WAIT_LONG, Some("library-changed"), fetch, |st| st.db().cache_get("yt:library", true).ok().flatten()).await
        }
        Provider::Plex => {
            let fetch = move |_app: AppHandle, st: Arc<AppState>| async move {
                let gen = st.db().generation(Provider::Plex);
                let sess = st.plex_session().await?;
                // Incremental sync: reuse the cached library while the server's content
                // fingerprint is unchanged.
                let fp = st.plex.library_fingerprint(&sess).await.ok();
                let cached: Option<(String, Library)> = st.db().kv_get("plex.library")?;
                Ok(match cached {
                    Some((cfp, lib)) if !refresh && fp.as_deref().map(|f| f == cfp).unwrap_or(true) => lib,
                    _ => {
                        let lib = st.plex.library(&sess).await?;
                        if let Some(fp) = fp {
                            put_current(&st, Provider::Plex, gen, |db| db.kv_set("plex.library", &(fp, &lib)))?;
                        }
                        lib
                    }
                })
            };
            let stale = |st: &AppState| st.db().kv_get::<(String, Library)>("plex.library").ok().flatten().map(|(_, l)| l);
            provider_part(app, state, p, WAIT_LONG, Some("library-changed"), fetch, stale).await
        }
    }
}

/// Your Library: the union of every provider that is on (YouTube's library, the Plex server's
/// listing). A provider that fails or takes longer than a minute shows its last listing and is
/// named in `errors`; `library-changed {provider}` follows when its listing arrives.
#[tauri::command]
pub async fn library(app: AppHandle, state: S<'_>, refresh: bool) -> Result<Library> {
    let hidden = state.db().hidden_playlists()?;
    let st = state.inner();
    let (plex, yt) = tokio::join!(library_part(&app, st, Provider::Plex, refresh), library_part(&app, st, Provider::YouTube, refresh));
    let mut lib = Library::default();
    let (_, errors) = merge_parts([yt, plex], |l| {
        lib.artists.extend(l.artists);
        lib.albums.extend(l.albums);
        lib.playlists.extend(l.playlists);
        lib.podcasts.extend(l.podcasts);
        lib.episodes.extend(l.episodes);
    });
    lib.errors = errors;
    lib.playlists.retain(|p| !hidden.contains(&p.id));
    apply_covers(&state.db().cover_overrides()?, lib.playlists.iter_mut());
    Ok(lib)
}

#[tauri::command]
pub async fn radio(app: AppHandle, state: S<'_>, track: Track) -> Result<Vec<Track>> {
    match track.source {
        Source::Youtube => {
            state.yt()?;
            let vid = track.stream_key.clone().unwrap_or_default();
            yt_call!(app, state, |y| y.radio(&vid))
        }
        _ => Ok(vec![]),
    }
}

/// Songs to keep playing when the queue runs out (Settings → Autoplay), seeded by the last
/// track: YouTube Music radio, Plex sonically similar tracks (random library tracks when the
/// server has no sonic analysis), or random local files (also when the seed's provider is off).
/// Skips anything in `exclude`.
#[tauri::command]
pub async fn autoplay_tracks(app: AppHandle, state: S<'_>, track: Track, exclude: Vec<String>) -> Result<Vec<Track>> {
    let provider = Provider::of_source(track.source).filter(|p| state.on(*p));
    let mut tracks = match provider {
        Some(Provider::YouTube) => {
            let vid = track.stream_key.clone().unwrap_or_default();
            yt_call!(app, state, |y| y.radio(&vid))?
        }
        Some(Provider::Plex) => {
            let sess = state.plex_session().await?;
            state.plex.autoplay(&sess, &track.id).await?
        }
        None => local::random_tracks(&state.db(), &track.artist, 50)?,
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
    let key = Provider::YouTube.key(&format!("songmeta:{video_id}"));
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

/// How to play a track. A downloaded Plex track plays from its file even while Plex is off.
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
            let sess = state.plex_session_for(&track.id).await?;
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
            if !state.may_use(Provider::YouTube, &track.id) {
                state.yt()?;
            }
            let vid = track.stream_key.clone().ok_or_else(|| Error::NotFound(track.title.clone()))?;
            Ok(Stream::Youtube { video_id: song_version(&state, &vid, &track).await.unwrap_or(vid) })
        }
    }
}

/// A track's loudness in LUFS for volume normalization: Plex's loudness analysis, or the file's
/// ReplayGain/R128 tag (local files and downloads). None for YouTube (its player evens out loudness
/// itself) and for tracks nobody has analysed. Cached.
#[tauri::command]
pub async fn track_loudness(state: S<'_>, track: Track) -> Result<Option<f32>> {
    let key = item_key("loud", &track.id);
    // Stored as a list: empty means "no loudness known".
    let cached = state.db().cache_get::<Vec<f32>>(&key, false)?;
    if let Some(v) = cached {
        return Ok(v.first().copied());
    }
    let from_file = |state: &AppState| -> Option<f32> {
        let path = match track.source {
            Source::Local => local::path_for(&state.db(), &track.id).ok().flatten().map(|(p, _)| p),
            _ => downloads::offline_path(state, &track.id),
        };
        path.and_then(|p| local::file_loudness(&p))
    };
    let lufs = match track.source {
        Source::Youtube => None,
        Source::Local => from_file(&state),
        Source::Plex => {
            let server = match state.plex_session().await {
                Ok(sess) => state.plex.loudness(&sess, &track.id).await,
                Err(_) => None,
            };
            server.or_else(|| from_file(&state))
        }
    };
    let ttl = if lufs.is_some() { 180 * 86400 } else { 86400 };
    state.db().cache_put(&key, &lufs.into_iter().collect::<Vec<f32>>(), ttl)?;
    Ok(lufs)
}

#[tauri::command]
pub async fn record_play(state: S<'_>, track: Track, context: Option<PlayContext>) -> Result<()> {
    state.db().record_play(&track, context.as_ref())
}

/// Listening history, newest play first, 100 at a time (`before`: the last id of the page shown).
#[tauri::command(async)]
pub fn listening_history(state: S, before: Option<i64>) -> Result<Vec<crate::db::HistoryEntry>> {
    state.db().history_page(before, 100)
}

#[tauri::command(async)]
pub fn history_remove(state: S, ids: Vec<i64>) -> Result<()> {
    state.db().history_remove(&ids)
}

#[tauri::command(async)]
pub fn history_clear(state: S) -> Result<()> {
    state.db().history_clear()
}

/// Called when a track finished (or was played past the scrobble point). Plex play counts only
/// while Plex is on.
#[tauri::command]
pub async fn mark_played(state: S<'_>, track: Track) -> Result<()> {
    if track.source == Source::Plex {
        if let Ok(sess) = state.plex_session().await {
            let _ = state.plex.scrobble(&sess, &track.id).await;
        }
    }
    Ok(())
}

/// Like or unlike a song on its provider (Plex rating, YouTube like; YouTube needs an account).
#[tauri::command]
pub async fn rate(app: AppHandle, state: S<'_>, track: Track, liked: bool) -> Result<()> {
    let p = match Provider::of_source(track.source) {
        Some(p) => p,
        None => return Err(Error::Unsupported("local files".into())),
    };
    match p {
        Provider::Plex => {
            let sess = state.plex_session().await?;
            state.plex.rate(&sess, &track.id, liked).await?;
        }
        Provider::YouTube => {
            state.yt_account().await?;
            let vid = track.stream_key.clone().unwrap_or_default();
            yt_call!(app, state, |y| y.rate(&vid, liked))?;
        }
    }
    // Liked Songs reloads with the change.
    state.db().cache_delete(&p.key("liked"))?;
    Ok(())
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
        // Plex lyrics come from the server, only while Plex is on.
        Source::Plex => match state.plex_session().await {
            Ok(sess) => state.plex.lyrics(&sess, &track.id).await,
            Err(_) => None,
        },
        Source::Youtube => None,
    };
    if let Some(l) = embedded.and_then(|t| lyrics::from_text(&t, if track.source == Source::Plex { "Plex" } else { "the file" })) {
        return Ok(Some(l));
    }
    let key = item_key("lyrics", &track.id);
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

/// Set (or with `image: None`, remove) a playlist's cover. The UI sends a small JPEG/PNG
/// (cropped and scaled in the webview); it is stored with the local artwork. App playlists keep
/// it in their row; YouTube playlists get an in-app cover that is never sent to YouTube.
#[tauri::command(async)]
pub fn pl_set_cover(app: AppHandle, state: S, id: String, image: Option<Vec<u8>>) -> Result<()> {
    let remote = id.starts_with("yt:") && !id.starts_with("yt:MPSP");
    if !id.starts_with("app:") && !remote {
        return Err(Error::Invalid("this playlist's cover can't be changed".into()));
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
    if remote {
        let old = state.db().set_cover_override(&id, cover.as_deref())?;
        if let Some(file) = old.as_deref().and_then(|o| o.strip_prefix("art://local/")) {
            let _ = std::fs::remove_file(state.dirs.local_art.join(file));
        }
    } else {
        state.db().playlist_set_cover(&id, cover.as_deref())?;
    }
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

/// Show in-app covers on provider playlists.
fn apply_covers<'a>(covers: &std::collections::HashMap<String, String>, playlists: impl IntoIterator<Item = &'a mut Playlist>) {
    if covers.is_empty() {
        return;
    }
    for p in playlists {
        if let Some(c) = covers.get(&p.id) {
            p.artwork = Some(c.clone());
        }
    }
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

/// Where a song is saved, for the "Saved in" checkboxes: app playlists holding it, and for a
/// YouTube song the user's own playlists from YouTube Music's "Save to playlist" list.
#[tauri::command]
pub async fn saved_in(app: AppHandle, state: S<'_>, track: Track) -> Result<SavedIn> {
    let app_playlists = state.db().playlists_containing(&track.id)?;
    let mut remote = Vec::new();
    // YouTube off, signed out or refused: just no YouTube section (no network call without an account).
    if track.source == Source::Youtube && !track.episode && state.yt_account().await.is_ok() {
        if let Some(vid) = track.stream_key.clone() {
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
    if track.source != Source::Youtube {
        return Err(Error::Unsupported("adding to YouTube playlists".into()));
    }
    state.yt_account().await?;
    let vid = track.stream_key.clone().ok_or_else(|| Error::Invalid("no video id".into()))?;
    yt_call!(app, state, |y| y.edit_playlist(&playlist_id, &vid, add))
}

/// What "Copy to YouTube Music" did: the new playlist, how many songs it holds, and the songs
/// that couldn't be found on YouTube Music ("Artist - Title").
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtCopyResult {
    pub playlist_id: String,
    pub added: usize,
    pub missing: Vec<String>,
}

/// Copy an app playlist to the user's YouTube account as a new playlist. YouTube songs go over
/// as they are; other songs (local files) are matched by a YouTube Music song search and left
/// out when there's no confident match. Emits `yt-copy-progress` {done, total} while matching.
#[tauri::command]
pub async fn yt_copy_playlist(app: AppHandle, state: S<'_>, id: String, title: String, privacy: String) -> Result<YtCopyResult> {
    state.yt_account().await?;
    let (pl, tracks) = {
        let db = state.db();
        let pl = db.playlist_get(&id)?.ok_or_else(|| Error::Invalid("playlist not found".into()))?;
        (pl, db.playlist_tracks(&id)?)
    };
    let title = match title.trim() {
        "" => pl.title.clone(),
        t => t.chars().take(150).collect(),
    };
    let total = tracks.len();
    let mut ids = Vec::new();
    let mut missing = Vec::new();
    for (i, t) in tracks.iter().enumerate() {
        let vid = match (&t.source, &t.stream_key) {
            (Source::Youtube, Some(v)) => Some(v.clone()),
            _ => match yt_call!(app, state, |y| y.find_song(&t.title, &t.artist, t.duration_ms)) {
                Ok(found) => found.and_then(|f| f.stream_key),
                Err(e @ Error::AuthExpired(_)) => return Err(e),
                Err(_) => None,
            },
        };
        match vid {
            Some(v) => ids.push(v),
            None if t.artist.is_empty() => missing.push(t.title.clone()),
            None => missing.push(format!("{} - {}", t.artist, t.title)),
        }
        let _ = app.emit("yt-copy-progress", serde_json::json!({ "done": i + 1, "total": total }));
    }
    if ids.is_empty() {
        return Err(Error::Invalid("None of these songs were found on YouTube Music, so no playlist was created.".into()));
    }
    let description = pl.description.clone().unwrap_or_default();
    let playlist_id = yt_call!(app, state, |y| y.create_playlist(&title, &description, &privacy, &ids))?;
    Ok(YtCopyResult { playlist_id, added: ids.len(), missing })
}

/// Save a text export (a playlist as "Artist - Title" lines) where the user picks. Returns the
/// path, or `None` when the dialog was cancelled. Only .txt/.csv names are written.
#[tauri::command]
pub async fn save_text_file(app: AppHandle, name: String, content: String) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(&name).add_filter("Text", &["txt", "csv"]).save_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(picked) = rx.await.ok().flatten() else { return Ok(None) };
    let path = picked.into_path().map_err(|e| Error::Invalid(e.to_string()))?;
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !matches!(ext.as_deref(), Some("txt") | Some("csv")) {
        return Err(Error::Invalid("exports are saved as .txt or .csv".into()));
    }
    // A BOM so Excel and Windows tools read Japanese titles as UTF-8.
    std::fs::write(&path, format!("\u{feff}{content}"))?;
    Ok(Some(path.display().to_string()))
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
    if let Some(p) = Provider::of_id(&id) {
        db.cache_clear_provider(p)?;
    }
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
    with_browser_args(tauri::WebviewWindowBuilder::new(&app, "pip", crate::ui_url("index.html#pip")), &state)
        // Named after the app so it is easy to pick in Discord's and OBS's window lists.
        .title(format!("{} mini player", app.package_info().name))
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

/// One provider's liked songs: YouTube's Liked Music (account only), the Plex server's rated
/// tracks. Cached under `<provider>:liked`; `rate` drops it.
async fn liked_part(app: &AppHandle, state: &Arc<AppState>, p: Provider, refresh: bool) -> Option<Part<Vec<Track>>> {
    let key = p.key("liked");
    if !refresh {
        if let Some(t) = liked_cached(state, p) {
            return Some(Part { value: t, stale: false, error: None });
        }
    }
    let k = key.clone();
    let fetch = move |app: AppHandle, st: Arc<AppState>| {
        let key = k.clone();
        async move {
            let gen = st.db().generation(p);
            let tracks = match p {
                Provider::Plex => {
                    let sess = st.plex_session().await?;
                    // Fallible: an outage is an error (stale cache shown, reconnect tried), never
                    // an empty list cached for 15 minutes.
                    st.plex.liked_tracks(&sess).await?
                }
                Provider::YouTube => {
                    st.yt_account().await?;
                    // "LM" is the account's Liked Music playlist.
                    yt_call!(app, st, |y| y.playlist("yt:LM"))?.tracks
                }
            };
            put_current(&st, p, gen, |db| db.cache_put(&key, &tracks, 15 * 60))?;
            Ok(tracks)
        }
    };
    provider_part(app, state, p, WAIT_LONG, Some("liked-changed"), fetch, move |st| st.db().cache_get(&key, true).ok().flatten()).await
}

/// A provider's fresh cached liked songs (`<provider>:liked`), while its switch is on.
fn liked_cached(state: &AppState, p: Provider) -> Option<Vec<Track>> {
    if !state.on(p) {
        return None;
    }
    state.db().cache_get::<Vec<Track>>(&p.key("liked"), false).ok().flatten()
}

/// Liked Songs from every provider that is on: YouTube's first (newest like first), then Plex's.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LikedTracks {
    tracks: Vec<Track>,
    stale: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    errors: Vec<ProviderError>,
}

async fn liked_merged(app: &AppHandle, state: &Arc<AppState>, refresh: bool) -> LikedTracks {
    let (yt, plex) = tokio::join!(liked_part(app, state, Provider::YouTube, refresh), liked_part(app, state, Provider::Plex, refresh));
    let mut tracks = Vec::new();
    let (stale, errors) = merge_parts([yt, plex], |t| tracks.extend(t));
    LikedTracks { tracks, stale, errors }
}

/// The combined Liked Songs page (the UI's `liked` route).
#[tauri::command]
pub async fn liked_tracks(app: AppHandle, state: S<'_>, refresh: bool) -> Result<LikedTracks> {
    Ok(liked_merged(&app, state.inner(), refresh).await)
}

/// Track ids the user has liked on the providers that are on, so the UI can show the like state.
/// Served from the `<provider>:liked` cache (`rate` drops it): the UI calls this on every
/// `liked-changed`, which a late fetch emits after filling that cache, so refetching here would
/// start the same slow fetch again and again.
#[tauri::command]
pub async fn liked_ids(app: AppHandle, state: S<'_>) -> Result<Vec<String>> {
    Ok(liked_merged(&app, state.inner(), false).await.tracks.into_iter().map(|t| t.id).collect())
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
/// Titles of the artist's compilations according to MusicBrainz, for the Compilations tab on
/// artist pages. Cached for a month (an empty list too); empty when MusicBrainz can't be reached.
#[tauri::command]
pub async fn artist_compilations(state: S<'_>, name: String) -> Result<Vec<String>> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Ok(Vec::new());
    }
    let key = format!("mbcomp:{}", name.to_lowercase());
    let cached = state.db().cache_get::<Vec<String>>(&key, false)?;
    if let Some(titles) = cached {
        return Ok(titles);
    }
    match crate::names::compilation_titles(&state.http, &name).await {
        Ok(titles) => {
            state.db().cache_put(&key, &titles, 30 * 86400)?;
            Ok(titles)
        }
        Err(e) => {
            log::info!("MusicBrainz compilations for {name}: {e}");
            Ok(Vec::new())
        }
    }
}

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

// ---- Browse all and the profile page --------------------------------------------------------

/// "Browse all" tiles: YouTube Music's sections, moods and genres, then Plex's genres (the UI
/// groups them by id). Each provider's list is cached a day. Fails only when every provider that
/// is on failed with nothing cached.
#[tauri::command]
pub async fn browse_categories(app: AppHandle, state: S<'_>, refresh: bool) -> Result<Vec<BrowseCategory>> {
    let st = state.inner();
    let part = |p: Provider| {
        let key = p.key("browseCategories");
        let app = app.clone();
        async move {
            if !refresh && st.on(p) {
                if let Some(c) = st.db().cache_get::<Vec<BrowseCategory>>(&key, false).ok().flatten() {
                    return Some(Part { value: c, stale: false, error: None });
                }
            }
            let k = key.clone();
            let fetch = move |app: AppHandle, st: Arc<AppState>| {
                let key = k.clone();
                async move {
                    let list = match p {
                        Provider::Plex => {
                            let sess = st.plex_session().await?;
                            st.plex.genres(&sess).await?
                        }
                        Provider::YouTube => {
                            st.yt()?;
                            yt_call!(app, st, |y| y.categories())?
                        }
                    };
                    st.db().cache_put(&key, &list, 86400)?;
                    Ok(list)
                }
            };
            provider_part(&app, st, p, WAIT_SHORT, None, fetch, move |st| st.db().cache_get(&key, true).ok().flatten()).await
        }
    };
    let (yt, plex) = tokio::join!(part(Provider::YouTube), part(Provider::Plex));
    let mut list = Vec::new();
    let (_, errors) = merge_parts([yt, plex], |l| list.extend(l));
    match errors.into_iter().next() {
        Some(e) if list.is_empty() => Err(error_of(e)),
        _ => Ok(list),
    }
}

/// The page behind a "Browse all" tile (a `yt:` section or a `plex-genre:`). Cached for an hour.
#[tauri::command]
pub async fn browse_page(app: AppHandle, state: S<'_>, id: String) -> Result<Vec<Shelf>> {
    browse_shelves(&app, &state, &id).await
}

async fn browse_shelves(app: &AppHandle, state: &AppState, id: &str) -> Result<Vec<Shelf>> {
    let p = provider_of(state, id)?;
    let key = item_key("browsePage", id);
    let cached = state.db().cache_get::<Vec<Shelf>>(&key, false)?;
    if let Some(c) = cached {
        return Ok(c);
    }
    let shelves = match p {
        Provider::Plex => {
            let sess = state.plex_session().await?;
            state.plex.genre_page(&sess, id).await?
        }
        Provider::YouTube => yt_call!(app, state, |y| y.browse_page(id))?,
    };
    state.db().cache_put(&key, &shelves, 3600)?;
    Ok(shelves)
}

/// A cover for a "Browse all" tile: the first artwork on its page. Kept a week (a miss a day).
#[tauri::command]
pub async fn browse_art(app: AppHandle, state: S<'_>, id: String) -> Result<Option<String>> {
    provider_of(&state, &id)?;
    let key = item_key("browseArt", &id);
    let cached = state.db().cache_get::<Option<String>>(&key, false)?;
    if let Some(c) = cached {
        return Ok(c);
    }
    let shelves = browse_shelves(&app, &state, &id).await?;
    let art = shelves.iter().flat_map(|s| s.items.iter()).find_map(|it| match it {
        MediaItem::Track(t) => t.artwork.clone(),
        MediaItem::Album(a) => a.artwork.clone(),
        MediaItem::Artist(a) => a.artwork.clone(),
        MediaItem::Playlist(p) => p.artwork.clone(),
        MediaItem::Podcast(p) => p.artwork.clone(),
    });
    state.db().cache_put(&key, &art, if art.is_some() { 7 * 86400 } else { 86400 })?;
    Ok(art)
}

/// Who is signed in, for the Profile page: the YouTube channel (name, photo, public page and
/// public playlists) when YouTube is on with an account, otherwise the Plex account.
#[tauri::command]
pub async fn profile_info(app: AppHandle, state: S<'_>) -> Result<ProfileInfo> {
    let yt_err = match state.yt_account().await {
        Ok(_) => match yt_call!(app, state, |y| y.profile()) {
            Ok(mut p) => {
                // Playlists hidden in the app stay hidden on the profile too.
                if let Some(pls) = p.public_playlists.as_mut() {
                    let hidden = state.db().hidden_playlists()?;
                    pls.retain(|pl| !hidden.contains(&pl.id));
                }
                return Ok(p);
            }
            Err(e) => e,
        },
        Err(e) => e,
    };
    match plex_profile(&state).await {
        Ok(p) => Ok(p),
        // Neither has a profile: the more telling reason (a YouTube failure beats "Plex is off").
        Err(Error::NotSignedIn | Error::Disabled(_)) => Err(yt_err),
        Err(e) => Err(e),
    }
}

async fn plex_profile(state: &AppState) -> Result<ProfileInfo> {
    if !state.on(Provider::Plex) {
        return Err(Error::Disabled(Provider::Plex));
    }
    let token = state.secrets.get("plex.token")?.ok_or(Error::NotSignedIn)?;
    let users = home_users(state).await.unwrap_or_default();
    let me = users.into_iter().find(|u| u.selected);
    let (name, photo) = match me {
        Some(u) => (u.title, u.thumb),
        None => state.plex.account_profile(&token).await?,
    };
    // Plex playlists are private to the server: there's no "public" to count.
    Ok(ProfileInfo { name, photo, url: None, public_playlists: None })
}

/// Artists from your listening history: `top` (most played in the last 4 weeks) or `recent`
/// (most recently played), of providers that are on. Pictures and names come from the artist
/// pages, kept for a month; artists whose page doesn't arrive within a few seconds show as played.
#[tauri::command]
pub async fn profile_artists(app: AppHandle, state: S<'_>, kind: String, limit: usize) -> Result<Vec<Artist>> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let top = kind == "top";
    let list = state.db().history_artists(if top { now - 28 * 86400 } else { 0 }, top, 50)?;
    let list: Vec<Artist> = list.into_iter().filter(|a| usable(&state, &a.id)).take(limit.min(50)).collect();
    let (a, st, l) = (app.clone(), state.inner().clone(), list.clone());
    let work = async move {
        let mut out = Vec::new();
        for chunk in l.chunks(5) {
            let got = futures_util::future::join_all(chunk.iter().map(|ar| artist_card(&a, &st, ar.clone()))).await;
            out.extend(got);
        }
        out
    };
    if let Some(out) = detached(WAIT_SHORT, work, |_| {}).await {
        return Ok(out);
    }
    // Too slow: what is cached now (the rest keeps loading for next time).
    let db = state.db();
    Ok(list.into_iter().map(|a| db.cache_get::<Artist>(&item_key("artistCard", &a.id), false).ok().flatten().unwrap_or(a)).collect())
}

async fn artist_card(app: &AppHandle, state: &AppState, a: Artist) -> Artist {
    let key = item_key("artistCard", &a.id);
    let cached = state.db().cache_get::<Artist>(&key, false).ok().flatten();
    if let Some(c) = cached {
        return c;
    }
    match artist_page(app, state, &a.id).await.ok().and_then(|p| p.artist) {
        Some(page) => {
            let card = Artist { id: a.id, name: if page.name.is_empty() { a.name } else { page.name }, artwork: page.artwork };
            let _ = state.db().cache_put(&key, &card, 30 * 86400);
            card
        }
        None => a,
    }
}

/// Delete one of your own playlists from your YouTube account (the UI asks first). The library is
/// reloaded afterwards so it disappears everywhere.
#[tauri::command]
pub async fn yt_delete_playlist(app: AppHandle, state: S<'_>, id: String) -> Result<()> {
    state.yt_account().await?;
    yt_call!(app, state, |y| y.delete_playlist(&id))?;
    // Take it out of the cached library too, so the reload doesn't bring it back for 15 minutes.
    let cached: Option<Library> = state.db().cache_get("yt:library", true)?;
    if let Some(mut lib) = cached {
        let gone = ytm::playlist_id_of(&id);
        lib.playlists.retain(|p| ytm::playlist_id_of(&p.id) != gone);
        state.db().cache_put("yt:library", &lib, 15 * 60)?;
    }
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

/// Channels the signed-in Google account can use: the personal one and brand accounts.
#[tauri::command]
pub async fn yt_accounts(app: AppHandle, state: S<'_>) -> Result<Vec<YtAccount>> {
    state.yt_account().await?;
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
    state.yt_account().await?;
    state.ytm.write().await.page_id = page_id.clone();
    {
        let db = state.db();
        match &page_id {
            Some(id) => db.kv_set("yt.pageId", id)?,
            None => db.kv_delete("yt.pageId")?,
        }
        db.kv_set("yt.account", &name)?;
        db.cache_clear_provider(Provider::YouTube)?;
    }
    emit_for(&app, "auth-changed", Provider::YouTube);
    Ok(())
}

/// Square album art and the official artist/album for YouTube music videos (from the video's
/// song counterpart), cached for 30 days. At most 12 uncached lookups per call, 4 at a time.
/// Needs the YouTube switch (an account isn't needed).
#[tauri::command]
pub async fn yt_song_meta(
    app: AppHandle,
    state: S<'_>,
    video_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, SongMeta>> {
    state.yt()?;
    let mut out = std::collections::HashMap::new();
    let mut todo = Vec::new();
    for vid in video_ids.into_iter().take(100) {
        let cached = state.db().cache_get::<SongMeta>(&Provider::YouTube.key(&format!("songmeta:{vid}")), false)?;
        match cached {
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
                state.db().cache_put(&Provider::YouTube.key(&format!("songmeta:{vid}")), &m, 30 * 86400)?;
                out.insert(vid, m);
            }
            Err(Error::AuthExpired(_)) => {
                yt_session_lost(&app, &state).await;
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
    if !state.on(Provider::Plex) {
        return Err(Error::Disabled(Provider::Plex));
    }
    home_users(&state).await
}

async fn home_users(state: &AppState) -> Result<Vec<PlexUser>> {
    let token = plex_home_token(state)?;
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
    if !state.on(Provider::Plex) {
        return Err(Error::Disabled(Provider::Plex));
    }
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
        // Only Plex's pages (and its library listing): YouTube's stay.
        db.cache_clear_provider(Provider::Plex)?;
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
    emit_for(&app, "auth-changed", Provider::Plex);
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
    return b.additional_browser_args(&crate::safe_mode::browser_args(state.safe_mode.get().is_some(), crate::smtc::available()));
    // macOS: present as Safari. Google turns sign-in down in web views that don't name a browser
    // ("This browser or app may not be secure"), and the sign-in window shares this setting.
    #[cfg(target_os = "macos")]
    {
        let _ = state;
        return b.user_agent(MAC_USER_AGENT);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = state;
        b
    }
}

#[cfg(target_os = "macos")]
const MAC_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

/// Turn the webview's GPU acceleration on or off; takes effect after a restart.
#[tauri::command(async)]
pub fn gpu_set(state: S, enabled: bool) -> Result<()> {
    crate::safe_mode::set_gpu(&state.dirs.data, enabled)?;
    Ok(())
}


// ---- playlist sync between devices (sync.rs) ----------------------------------------------------

/// Let another device on the same Wi-Fi send its playlists here for the next ten minutes.
#[tauri::command(async)]
pub fn sync_receive_start(app: AppHandle, state: S) -> Result<crate::sync::Receiving> {
    crate::sync::receive_start(app, state.inner().clone())
}

#[tauri::command]
pub fn sync_receive_stop() {
    crate::sync::receive_stop();
}

/// Send this device's app playlists to the one showing `address` and `code`.
#[tauri::command]
pub async fn sync_send(state: S<'_>, address: String, code: String) -> Result<crate::sync::Summary> {
    crate::sync::send(state.inner().clone(), &address, &code).await
}

/// "Share audio with Discord": play the app's audio from its own process, where Discord's Go Live
/// and other per-app audio capture look for it (Windows; see audio_share.rs).
#[tauri::command]
pub async fn audio_share_set(app: AppHandle, enabled: bool) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || crate::audio_share::set(app, enabled))
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?
}

/// Mirror the player in the Android media notification, and on Windows in the app's own media
/// controls (`smtc`). `artwork` arrives as the track's `art://` reference.
#[tauri::command]
pub async fn media_update(app: AppHandle, state: S<'_>, mut now: tauri_plugin_openmusic_media::NowPlaying) -> Result<()> {
    let art = match now.artwork.take() {
        Some(a) if cfg!(any(mobile, windows)) => art::cached_file(state.inner().clone(), &a, 512).await.map(|p| p.to_string_lossy().into_owned()),
        _ => None,
    };
    #[cfg(mobile)]
    {
        now.artwork = art;
        let _ = tauri::async_runtime::spawn_blocking(move || tauri_plugin_openmusic_media::update(&app, &now)).await;
    }
    #[cfg(windows)]
    {
        let _ = &app;
        let _ = tauri::async_runtime::spawn_blocking(move || crate::smtc::update(&now, art)).await;
    }
    #[cfg(not(any(mobile, windows)))]
    let _ = (&app, &now, art);
    Ok(())
}

/// Android home screen widgets: recently played albums and playlists, with their covers as files.
#[tauri::command]
pub async fn widget_refresh(app: AppHandle, state: S<'_>) -> Result<()> {
    if cfg!(mobile) {
        let contexts = state.db().recent_contexts(6)?;
        let mut items = Vec::with_capacity(contexts.len());
        for c in contexts {
            let art = match c.artwork.as_deref() {
                Some(a) => art::cached_file(state.inner().clone(), a, 300).await.map(|p| p.to_string_lossy().into_owned()),
                None => None,
            };
            items.push(tauri_plugin_openmusic_media::WidgetItem { kind: c.kind, id: c.id, title: c.title, art });
        }
        let _ = tauri::async_runtime::spawn_blocking(move || tauri_plugin_openmusic_media::recent(&app, &items)).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn media_stop(app: AppHandle) -> Result<()> {
    #[cfg(mobile)]
    let _ = tauri::async_runtime::spawn_blocking(move || tauri_plugin_openmusic_media::stop(&app)).await;
    #[cfg(windows)]
    {
        let _ = &app;
        let _ = tauri::async_runtime::spawn_blocking(crate::smtc::stop).await;
    }
    #[cfg(not(any(mobile, windows)))]
    let _ = &app;
    Ok(())
}

/// Discord Rich Presence for the playing track (desktop). `now.artwork` is the track's `art://`
/// reference; only public image URLs are passed on. `link` is the track's public page, if any.
#[tauri::command]
pub async fn presence_update(state: S<'_>, now: tauri_plugin_openmusic_media::NowPlaying, link: Option<String>) -> Result<()> {
    if !crate::discord::available() {
        return Ok(());
    }
    if !now.playing {
        crate::discord::set(None);
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
    .or_else(|| Some(crate::discord::app_icon()));
    let link = link.filter(|l| l.starts_with("https://music.youtube.com/")).map(|l| ("Listen on YouTube Music".to_string(), l));
    crate::discord::set(
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
pub fn presence_clear() {
    crate::discord::set(None);
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
pub async fn update_check(state: S<'_>) -> Result<crate::updater::UpdateInfo> {
    crate::updater::check(&state.http).await
}

/// Windows and macOS: fetch the new installer / disk image in the background; it installs when the
/// app closes or on "Restart to update".
#[tauri::command]
pub async fn update_download(state: S<'_>, url: String) -> Result<()> {
    crate::updater::download(&state.http, &url, &state.dirs.data.join("updates")).await
}

/// "Restart to update": run the downloaded installer (progress window, relaunches the app).
#[tauri::command]
pub fn update_restart(app: AppHandle) -> Result<()> {
    if !crate::updater::run_pending(true) {
        return Err(Error::Invalid(
            "The update couldn't be installed. Download the new version from the release page on GitHub.".into(),
        ));
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_releases_from_followed_artists() {
        let al = |id: &str, year: Option<u32>| Album { id: id.into(), title: id.into(), artist: String::new(), artist_id: None, year, artwork: None, kind: None };
        let page = |name: &str, albums: Vec<Album>, singles: Vec<Album>| ArtistPage {
            artist: Some(Artist { id: name.into(), name: name.into(), artwork: None }),
            albums,
            singles,
            ..Default::default()
        };
        let got = recent_releases(
            vec![
                page("A", vec![al("old", Some(2019)), al("last", Some(2025))], vec![al("single", Some(2026))]),
                page("B", vec![al("dup", Some(2026)), al("noyear", None)], vec![al("dup", Some(2026))]),
            ],
            2026,
        );
        let ids: Vec<_> = got.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["single", "dup", "last"]);
        assert_eq!(got[0].artist, "A", "the artist's name fills in when the album has none");
        assert!(current_year() >= 2025);
    }

    #[test]
    fn merges_parts_in_order_with_their_errors() {
        let err = ProviderError { provider: Provider::Plex, code: "timeout".into(), message: "slow".into() };
        let parts = vec![
            Some(Part { value: vec![1, 2], stale: false, error: None }),
            None,
            Some(Part { value: vec![3], stale: true, error: Some(err.clone()) }),
        ];
        let mut all = Vec::new();
        let (stale, errors) = merge_parts(parts, |v| all.extend(v));
        assert_eq!(all, [1, 2, 3]);
        assert!(stale);
        assert_eq!(errors, std::slice::from_ref(&err));
        assert!(matches!(error_of(err), Error::Offline(_)));
        let expired = ProviderError { provider: Provider::YouTube, code: "authExpired".into(), message: String::new() };
        assert!(matches!(error_of(expired), Error::AuthExpired(Some(Provider::YouTube))));
    }

    fn switches(state: &AppState, youtube: bool, plex: bool) {
        *state.services.write().unwrap() = Services { youtube, plex };
    }

    /// A Weezer page from YouTube with "Buddy Holly" and a 2026 album "Blue", and the same song
    /// and album (no year) as local files.
    fn weezer_with_local_copies() -> (AppState, ArtistPage) {
        let state = crate::state::test_state();
        state
            .db()
            .conn
            .execute(
                "INSERT INTO local_tracks(id,path,folder,mtime,size,title,artist,album,album_artist,missing) VALUES('local:1','/m/1.mp3','f',0,0,'Buddy Holly','Weezer','Blue',NULL,0)",
                [],
            )
            .unwrap();
        let yt = |id: &str, title: &str| -> Track { serde_json::from_value(json!({ "id": id, "source": "youtube", "title": title, "artist": "Weezer" })).unwrap() };
        let page = ArtistPage {
            artist: Some(Artist { id: "yt:UC1".into(), name: "Weezer".into(), artwork: None }),
            top_tracks: vec![yt("yt:a", "Buddy Holly"), yt("yt:b", "Say It Ain't So")],
            albums: vec![Album { id: "yt:A".into(), title: "Blue".into(), artist: "Weezer".into(), artist_id: None, year: Some(2026), artwork: None, kind: None }],
            ..Default::default()
        };
        (state, page)
    }

    fn ids_of<T>(xs: &[T], id: impl Fn(&T) -> &str) -> Vec<String> {
        xs.iter().map(|x| id(x).to_string()).collect()
    }

    #[test]
    fn with_one_service_on_local_files_are_listed_apart_as_in_1_6_1() {
        let (state, page) = weezer_with_local_copies();
        for (youtube, plex) in [(true, false), (false, true), (false, false)] {
            switches(&state, youtube, plex);
            assert!(!merging(&state), "no merging with one service on");
            let p = with_local(&state, page.clone()).unwrap();
            assert_eq!(ids_of(&p.top_tracks, |t| &t.id), ["yt:a", "yt:b"], "the YouTube song stays");
            assert_eq!(ids_of(&p.albums, |a| &a.id), ["yt:A"]);
            assert_eq!(ids_of(&p.local_tracks, |t| &t.id), ["local:1"], "the local copy is listed apart");
            assert_eq!(p.local_albums.len(), 1);
            assert!(artist_links_for(&state, &["yt:UC1".into(), "local-artist:Weezer".into()]).is_empty());
        }
        // Both on: the merged page plays the local copy in the YouTube song's place.
        switches(&state, true, true);
        assert!(merging(&state));
        let p = with_local_merged(&state, page).unwrap();
        assert_eq!(ids_of(&p.top_tracks, |t| &t.id), ["local:1", "yt:b"]);
        assert!(p.local_tracks.is_empty());
    }

    #[test]
    fn whats_new_uses_the_plain_artist_page() {
        let (state, page) = weezer_with_local_copies();
        switches(&state, true, true);
        // followed_releases reads artist_page, which adds local files apart (with_local): the
        // YouTube album stays, even with both services on.
        let plain = with_local(&state, page.clone()).unwrap();
        assert_eq!(ids_of(&recent_releases(vec![plain], 2026), |a| &a.id), ["yt:A"]);
        // The merged page would have swapped in the local album (no year): the release would be lost.
        let merged = with_local_merged(&state, page).unwrap();
        assert!(recent_releases(vec![merged], 2026).is_empty());
        // And neither path reaches the merge: artist_page and followed_releases stay plain.
        let src = include_str!("commands.rs");
        let body = |from: &str, to: &str| {
            let start = src.find(from).unwrap();
            &src[start..start + src[start..].find(to).unwrap()]
        };
        for f in [body("async fn followed_releases(", "\n}\n"), body("pub(crate) async fn artist_page(", "\n}\n"), body("async fn artist_card(", "\n}\n")] {
            assert!(f.contains("artist_page(") || f.contains("with_local(state, page)"), "{f}");
            assert!(!f.contains("merged") && !f.contains("add_local"), "{f}");
        }
    }

    #[test]
    fn artist_overrides_are_kept_per_artist_name() {
        let state = crate::state::test_state();
        let db = state.db();
        assert_eq!(set_override(&db, "The Weezer", Provider::Plex, true).unwrap(), ArtistOverride { plex: true, youtube: false });
        assert_eq!(set_override(&db, "weezer", Provider::YouTube, true).unwrap(), ArtistOverride { plex: true, youtube: true });
        assert_eq!(artist_overrides(&db).get("weezer"), Some(&ArtistOverride { plex: true, youtube: true }));
        set_override(&db, "Weezer", Provider::Plex, false).unwrap();
        set_override(&db, "Weezer", Provider::YouTube, false).unwrap();
        assert!(artist_overrides(&db).is_empty(), "an override with nothing on is dropped");
        assert!(set_override(&db, "!!!", Provider::Plex, true).is_err());
    }

    #[test]
    fn overrides_let_their_items_through_while_the_service_is_off() {
        let state = crate::state::test_state();
        switches(&state, true, false);
        assert!(matches!(provider_of(&state, "plex:42"), Err(Error::Disabled(Provider::Plex))));
        state.allow(["plex:42".to_string()]);
        assert_eq!(provider_of(&state, "plex:42").unwrap(), Provider::Plex);
        assert!(provider_of(&state, "plex:43").is_err(), "only the items the override showed");
        // Kept across restarts (kv), and listed for the UI.
        let ids: Vec<String> = state.db().kv_get(crate::state::OVERRIDE_IDS).unwrap().unwrap();
        assert_eq!(ids, ["plex:42"]);
        assert_eq!(state.allowed_ids(), ["plex:42"]);
    }

    #[test]
    fn has_provider_looks_at_albums_singles_and_songs() {
        let page = ArtistPage { albums: vec![Album { id: "plex:1".into(), title: "Blue".into(), artist: "Weezer".into(), artist_id: None, year: None, artwork: None, kind: None }], ..Default::default() };
        assert!(has_provider(&page, Provider::Plex));
        assert!(!has_provider(&page, Provider::YouTube));
    }

    #[test]
    fn artist_links_come_from_confirmed_matches_in_the_cache_only() {
        let state = crate::state::test_state();
        switches(&state, true, true);
        {
            let db = state.db();
            let put = |o: Provider, id: &str, v: Option<&str>, ttl: i64| db.cache_put(&match_key(o, id), &v.map(String::from), ttl).unwrap();
            // YouTube's Weezer is Plex's; the local Weezer is YouTube's (so Plex's too).
            put(Provider::Plex, "yt:UC1", Some("plex:9"), 600);
            put(Provider::YouTube, "local-artist:Weezer", Some("yt:UC1"), 600);
            // Ghost: no match (a namesake). Expired: not known any more.
            put(Provider::Plex, "yt:G", None, 600);
            put(Provider::Plex, "yt:X", Some("plex:X"), -1);
            // Two YouTube artists on one Plex artist: can't tell which, so neither.
            put(Provider::Plex, "yt:N1", Some("plex:N"), 600);
            put(Provider::Plex, "yt:N2", Some("plex:N"), 600);
        }
        let ids: Vec<String> = ["plex:9", "yt:UC1", "local-artist:Weezer", "yt:G", "plex:G", "yt:X", "plex:X", "yt:N1", "yt:N2", "plex:N", "plex:9"].map(String::from).into();
        assert_eq!(
            artist_links_for(&state, &ids),
            [["plex:9".to_string(), "yt:UC1".to_string()], ["plex:9".to_string(), "local-artist:Weezer".to_string()]]
        );
        // Only ids on the list are paired; an artist on its own has nothing.
        assert!(artist_links_for(&state, &["yt:UC1".into()]).is_empty());
        assert_eq!(artist_links_for(&state, &["local-artist:Weezer".into(), "plex:9".into()]), [["local-artist:Weezer".to_string(), "plex:9".to_string()]]);
        let db = state.db();
        assert_eq!(linked(&db, Provider::Plex, "local-artist:Weezer").as_deref(), Some("plex:9"), "through YouTube's");
        assert_eq!(linked(&db, Provider::YouTube, "plex:9").as_deref(), Some("yt:UC1"), "either direction");
        assert!(linked(&db, Provider::Plex, "yt:G").is_none() && match_known(&db, Provider::Plex, "yt:G"), "no match is known");
        assert!(!match_known(&db, Provider::Plex, "yt:X"), "expired");
        assert!(linked(&db, Provider::YouTube, "plex:N").is_none());
        drop(db);
        switches(&state, true, false);
        assert!(artist_links_for(&state, &ids).is_empty(), "one service on: nothing is linked");
    }

    #[test]
    fn a_cached_merged_artist_page_comes_back_without_locking_up() {
        // with_local takes the database lock again: the lookup must not still hold it.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let state = crate::state::test_state();
            let id = "yt:UC1";
            assert!(cached_merge(&state, Some(Provider::Plex), id).unwrap().is_none(), "nothing cached yet");
            assert!(cached_merge(&state, None, id).unwrap().is_none());
            {
                let db = state.db();
                db.cache_put(&match_key(Provider::Plex, id), &Some("plex:9".to_string()), 600).unwrap();
                let page = ArtistPage { artist: Some(Artist { id: id.into(), name: "Weezer".into(), artwork: None }), ..Default::default() };
                db.cache_put(&merged_key(id, "plex:9"), &page, 600).unwrap();
            }
            let got = cached_merge(&state, Some(Provider::Plex), id).unwrap().map(|p| p.artist.unwrap().id);
            // "No match" cached: nothing merged to show.
            state.db().cache_put(&match_key(Provider::Plex, "yt:UC2"), &None::<String>, 600).unwrap();
            let none = cached_merge(&state, Some(Provider::Plex), "yt:UC2").unwrap().is_none();
            tx.send((got, none)).unwrap();
        });
        let (got, none) = rx.recv_timeout(Duration::from_secs(10)).expect("cached_merge deadlocked on the database lock");
        assert_eq!(got.as_deref(), Some("yt:UC1"));
        assert!(none);
    }

    #[tokio::test]
    async fn detached_work_finishes_after_the_caller_stops_waiting() {
        let fast = detached(Duration::from_secs(5), async { 1 }, |_| {}).await;
        assert_eq!(fast, Some(1));
        let (tx, rx) = std::sync::mpsc::channel();
        let slow = detached(
            Duration::from_millis(20),
            async {
                tokio::time::sleep(Duration::from_millis(150)).await;
                2
            },
            move |v| tx.send(v).unwrap(),
        )
        .await;
        assert_eq!(slow, None, "the caller gave up");
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 2, "the result still arrives");
    }

    #[test]
    fn writes_skip_after_an_account_change() {
        let st = crate::state::test_state();
        let gen = st.db().generation(Provider::Plex);
        put_current(&st, Provider::Plex, gen, |db| db.cache_put("plex:liked", &1, 600)).unwrap();
        assert_eq!(st.db().cache_get::<i32>("plex:liked", false).unwrap(), Some(1));
        // A Home user switch while the fetch ran: its result is not written back.
        st.db().cache_clear_provider(Provider::Plex).unwrap();
        put_current(&st, Provider::Plex, gen, |db| db.cache_put("plex:liked", &2, 600)).unwrap();
        assert_eq!(st.db().cache_get::<i32>("plex:liked", true).unwrap(), None);
        // YouTube's fetches are not affected by a Plex change.
        let yt = st.db().generation(Provider::YouTube);
        put_current(&st, Provider::YouTube, yt, |db| db.cache_put("yt:liked", &3, 600)).unwrap();
        assert_eq!(st.db().cache_get::<i32>("yt:liked", false).unwrap(), Some(3));
    }

    #[test]
    fn liked_ids_are_served_from_the_cache() {
        // liked_ids reads with refresh=false: what a late fetch just cached ends the
        // liked-changed -> liked_ids round, instead of starting the same fetch again.
        let st = crate::state::test_state();
        let tracks: Vec<Track> = serde_json::from_value(json!([{ "id": "yt:a", "source": "youtube", "title": "a", "artist": "A" }])).unwrap();
        st.db().cache_put("yt:liked", &tracks, 600).unwrap();
        assert!(liked_cached(&st, Provider::YouTube).is_none(), "switch off: nothing");
        st.services.write().unwrap().youtube = true;
        assert_eq!(liked_cached(&st, Provider::YouTube).unwrap()[0].id, "yt:a");
        assert!(liked_cached(&st, Provider::Plex).is_none());
    }

    #[test]
    fn liked_music_ids() {
        assert!(is_yt_liked("yt:LM") && is_yt_liked("yt:VLLM"));
        assert!(!is_yt_liked("yt:PLx") && !is_yt_liked("plex:LM"));
    }

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
