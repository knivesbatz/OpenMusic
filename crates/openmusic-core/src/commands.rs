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
use crate::{downloads, lastfm, local, lyrics, matching, plex, spotify, ytm};

type S<'a> = State<'a, Arc<AppState>>;

// ---- app / settings -------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    flavor: Flavor,
    name: String,
    version: String,
    capabilities: Capabilities,
}

pub fn capabilities(f: Flavor) -> Capabilities {
    match f {
        Flavor::Plex => Capabilities { downloads: true, quality_control: true, podcasts: false, crossfade: true, gapless: true, favorites: true },
        Flavor::YouTube => Capabilities { downloads: false, quality_control: false, podcasts: true, crossfade: false, gapless: false, favorites: true },
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: S) -> AppInfo {
    AppInfo {
        flavor: state.flavor,
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        capabilities: capabilities(state.flavor),
    }
}

#[tauri::command]
pub fn settings_get(state: S) -> Result<Value> {
    Ok(state.db().kv_get::<Value>("settings")?.unwrap_or(Value::Object(Default::default())))
}

#[tauri::command]
pub async fn settings_set(state: S<'_>, settings: Value) -> Result<()> {
    if let Some(hl) = settings.get("language").and_then(|l| l.as_str()) {
        state.ytm.write().await.hl = hl.to_string();
    }
    state.db().kv_set("settings", &settings)
}

#[tauri::command]
pub fn kv_get(state: S, key: String) -> Result<Option<Value>> {
    state.db().kv_get(&format!("ui.{key}"))
}

#[tauri::command]
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
pub async fn plex_pin_start(app: AppHandle, state: S<'_>) -> Result<plex::Pin> {
    let pin = state.plex.pin_create().await?;
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(&pin.auth_url, None::<&str>);
    Ok(pin)
}

/// Returns true once the PIN was approved and the token stored.
#[tauri::command]
pub async fn plex_pin_poll(state: S<'_>, id: u64) -> Result<bool> {
    let Some(token) = state.plex.pin_check(id).await? else { return Ok(false) };
    state.secrets.set("plex.token", &token)?;
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
    state.ytm.write().await.cookie = Some(cookie);
    let y = state.ytm().await;
    if let Ok(name) = y.account_name().await {
        state.db().kv_set("yt.account", &name)?;
    }
    state.db().cache_clear()?;
    let _ = app.emit("auth-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn yt_login(app: AppHandle, state: S<'_>) -> Result<()> {
    if let Some(w) = app.get_webview_window("ytlogin") {
        let _ = w.set_focus();
        return Ok(());
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let url: tauri::Url = YT_LOGIN_URL.parse().map_err(|_| Error::Invalid("url".into()))?;
    tauri::WebviewWindowBuilder::new(&app, "ytlogin", tauri::WebviewUrl::External(url))
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
    {
        let mut last = state.last_yt_refresh.lock().unwrap();
        if last.map(|t| t.elapsed().as_secs() < 300).unwrap_or(false) {
            return false;
        }
        *last = Some(std::time::Instant::now());
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let Ok(url) = "https://music.youtube.com/".parse::<tauri::Url>() else { return false };
    let built = tauri::WebviewWindowBuilder::new(app, "ytrefresh", tauri::WebviewUrl::External(url))
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
            state.secrets.delete_large("plex.session")?;
            *state.plex_session.write().await = None;
            state.db().kv_delete("plex.account")?;
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
    // Local files and app playlists are searched too.
    let local = local::search(&state.db(), q, 20)?;
    res.tracks.extend(local);
    let ql = q.to_lowercase();
    let app_pls: Vec<Playlist> = state.db().playlists()?.into_iter().filter(|p| p.title.to_lowercase().contains(&ql)).collect();
    res.playlists.splice(0..0, app_pls);
    Ok(res)
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
    if let Some(p) = state.db().cache_get(&key, false)? {
        return Ok(p);
    }
    let page = match state.flavor {
        Flavor::Plex => {
            let sess = state.plex_session().await?;
            state.plex.artist(&sess, &id).await?
        }
        Flavor::YouTube => yt_call!(app, state, |y| y.artist(&id))?,
    };
    state.db().cache_put(&key, &page, 6 * 3600)?;
    Ok(page)
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

// ---- playback -------------------------------------------------------------------------------

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
        Source::Youtube => Ok(Stream::Youtube { video_id: track.stream_key.clone().ok_or_else(|| Error::NotFound(track.title.clone()))? }),
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

#[tauri::command]
pub fn queue_save(state: S, queue: Value) -> Result<()> {
    state.db().kv_set("queue", &queue)
}

#[tauri::command]
pub fn queue_load(state: S) -> Result<Option<Value>> {
    state.db().kv_get("queue")
}

#[tauri::command]
pub async fn get_lyrics(state: S<'_>, track: Track) -> Result<Option<lyrics::Lyrics>> {
    let key = format!("lyrics:{}", track.id);
    if let Some(l) = state.db().cache_get::<Option<lyrics::Lyrics>>(&key, false)? {
        return Ok(l);
    }
    let l = lyrics::fetch(&state.http, &track).await?;
    state.db().cache_put(&key, &l, if l.is_some() { 30 * 86400 } else { 86400 })?;
    Ok(l)
}

// ---- app playlists --------------------------------------------------------------------------

#[tauri::command]
pub fn pl_list(state: S) -> Result<Vec<Playlist>> {
    state.db().playlists()
}

#[tauri::command]
pub fn pl_create(app: AppHandle, state: S, name: String, tracks: Option<Vec<Track>>) -> Result<Playlist> {
    let mut db = state.db();
    let p = db.playlist_create(name.trim())?;
    if let Some(t) = tracks {
        db.playlist_add(&p.id, &t)?;
    }
    let _ = app.emit("playlists-changed", ());
    Ok(p)
}

#[tauri::command]
pub fn pl_update(app: AppHandle, state: S, id: String, name: String, description: Option<String>) -> Result<()> {
    state.db().playlist_update(&id, name.trim(), description.as_deref())?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

#[tauri::command]
pub fn pl_delete(app: AppHandle, state: S, id: String) -> Result<()> {
    state.db().playlist_delete(&id)?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

#[tauri::command]
pub fn pl_add(app: AppHandle, state: S, id: String, tracks: Vec<Track>) -> Result<usize> {
    let n = state.db().playlist_add(&id, &tracks)?;
    let _ = app.emit("playlists-changed", ());
    Ok(n)
}

#[tauri::command]
pub fn pl_reorder(app: AppHandle, state: S, id: String, order: Vec<usize>) -> Result<()> {
    state.db().playlist_reorder(&id, &order)?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

fn lastfm_client(state: &AppState) -> Result<lastfm::LastFm> {
    let keys: lastfm::Keys = state.secrets.get_json("lastfm.keys")?.ok_or_else(|| Error::Invalid("Last.fm API key not set".into()))?;
    Ok(lastfm::LastFm::new(state.http.clone(), keys))
}

#[tauri::command]
pub fn lastfm_status(state: S) -> Result<LastFmStatus> {
    Ok(LastFmStatus {
        has_keys: state.secrets.get_large("lastfm.keys")?.is_some(),
        connected: state.secrets.get("lastfm.sk")?.is_some(),
        user: state.db().kv_get("lastfm.user")?,
        pending: state.db().scrobble_pending(1000)?.len(),
    })
}

#[tauri::command]
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

#[tauri::command]
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

pub async fn flush_scrobbles(app: &AppHandle, state: &AppState) {
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

// ---- Spotify import -------------------------------------------------------------------------

async fn spotify_token(state: &AppState) -> Result<String> {
    let client_id: String = state.db().kv_get("spotify.clientId")?.ok_or(Error::NotSignedIn)?;
    let tok: spotify::Token = state.secrets.get_json("spotify.token")?.ok_or(Error::NotSignedIn)?;
    if tok.expires_at > crate::db::now() {
        return Ok(tok.access_token);
    }
    let rt = tok.refresh_token.ok_or(Error::AuthExpired)?;
    let fresh = spotify::refresh(&state.http, &client_id, &rt).await?;
    state.secrets.set_json("spotify.token", &fresh)?;
    Ok(fresh.access_token)
}

#[tauri::command]
pub async fn spotify_status(state: S<'_>) -> Result<Option<String>> {
    if state.secrets.get_large("spotify.token")?.is_none() {
        return Ok(None);
    }
    state.db().kv_get("spotify.clientId")
}

#[tauri::command]
pub async fn spotify_connect(app: AppHandle, state: S<'_>, client_id: String) -> Result<()> {
    let client_id = client_id.trim().to_string();
    let (verifier, challenge) = spotify::pkce_pair();
    let st = uuid::Uuid::new_v4().simple().to_string();
    let url = spotify::authorize_url(&client_id, &challenge, &st);
    let wait = tokio::spawn({
        let st = st.clone();
        async move { spotify::wait_for_code(&st).await }
    });
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(&url, None::<&str>);
    let code = wait.await.map_err(|e| Error::Invalid(e.to_string()))??;
    let tok = spotify::exchange(&state.http, &client_id, &code, &verifier).await?;
    state.secrets.set_json("spotify.token", &tok)?;
    state.db().kv_set("spotify.clientId", &client_id)?;
    Ok(())
}

#[tauri::command]
pub async fn spotify_disconnect(state: S<'_>) -> Result<()> {
    state.secrets.delete_large("spotify.token")
}

#[tauri::command]
pub async fn spotify_playlists(state: S<'_>) -> Result<Vec<spotify::SpotifyPlaylist>> {
    let token = spotify_token(&state).await?;
    spotify::playlists(&state.http, &token).await
}

#[tauri::command]
pub async fn spotify_import(app: AppHandle, state: S<'_>, playlist_id: String, name: String) -> Result<spotify::ImportReport> {
    let token = spotify_token(&state).await?;
    let wanted = spotify::playlist_tracks(&state.http, &token, &playlist_id).await?;
    let mut report = spotify::ImportReport { name: name.clone(), ..Default::default() };
    let mut seen = std::collections::HashSet::new();
    let mut matched: Vec<Track> = Vec::new();
    let total = wanted.len();
    for (i, w) in wanted.iter().enumerate() {
        let q = format!("{} {}", w.title, w.artists.first().cloned().unwrap_or_default());
        let candidates = match state.flavor {
            Flavor::Plex => {
                let sess = state.plex_session().await?;
                // Plex search is title-based; artist words would make it miss.
                let mut c = state.plex.search_tracks(&sess, &w.title).await.unwrap_or_default();
                if c.is_empty() {
                    c = state.plex.search_tracks(&sess, &matching::normalize(&w.title)).await.unwrap_or_default();
                }
                c
            }
            Flavor::YouTube => {
                let y = state.ytm().await;
                y.search_tracks(&q).await.unwrap_or_default()
            }
        };
        let mut row = spotify::ImportRow { title: w.title.clone(), artist: w.artists.join(", "), ..Default::default() };
        match matching::best_match(w, &candidates) {
            matching::Verdict::Match(t, s) => {
                row.score = Some(s);
                if seen.insert(t.id.clone()) {
                    row.status = "imported".into();
                    report.imported += 1;
                    matched.push(t.clone());
                } else {
                    row.status = "duplicate".into();
                    report.duplicates += 1;
                }
                row.matched = Some(t);
            }
            matching::Verdict::Ambiguous(t, s) => {
                row.status = "ambiguous".into();
                row.score = Some(s);
                row.matched = Some(t);
                report.ambiguous += 1;
            }
            matching::Verdict::NoMatch => {
                row.status = "skipped".into();
                report.skipped += 1;
            }
        }
        report.rows.push(row);
        let _ = app.emit("import-progress", serde_json::json!({ "done": i + 1, "total": total }));
    }
    if !matched.is_empty() {
        let mut db = state.db();
        let p = db.playlist_create(&name)?;
        db.playlist_add(&p.id, &matched)?;
        report.playlist_id = Some(p.id);
        let _ = app.emit("playlists-changed", ());
    }
    Ok(report)
}

/// Add tracks the user confirmed from the "ambiguous" list of an import report.
#[tauri::command]
pub fn import_confirm(app: AppHandle, state: S, playlist_id: Option<String>, name: String, tracks: Vec<Track>) -> Result<String> {
    let mut db = state.db();
    let id = match playlist_id {
        Some(id) => id,
        None => db.playlist_create(&name)?.id,
    };
    db.playlist_add(&id, &tracks)?;
    let _ = app.emit("playlists-changed", ());
    Ok(id)
}

// ---- downloads / storage --------------------------------------------------------------------

#[tauri::command]
pub fn download_tracks(app: AppHandle, state: S, tracks: Vec<Track>) -> Result<usize> {
    let n = downloads::enqueue(app.clone(), state.inner().clone(), tracks)?;
    let _ = app.emit("downloads-changed", ());
    Ok(n)
}

#[tauri::command]
pub fn download_list(state: S) -> Result<Vec<downloads::DownloadInfo>> {
    downloads::list(&state)
}

#[tauri::command]
pub fn download_cancel(state: S, id: String) {
    downloads::cancel(&state, &id)
}

#[tauri::command]
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

#[tauri::command]
pub async fn pip_toggle(app: AppHandle) -> Result<bool> {
    if let Some(w) = app.get_webview_window("pip") {
        let _ = w.close();
        return Ok(false);
    }
    tauri::WebviewWindowBuilder::new(&app, "pip", tauri::WebviewUrl::App("index.html#pip".into()))
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
        let _ = w.unminimize();
        let _ = w.show();
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

#[tauri::command]
pub fn htpc_autostart_get(app: AppHandle) -> Result<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| Error::Invalid(e.to_string()))
}

#[tauri::command]
pub fn htpc_autostart_set(app: AppHandle, enabled: bool) -> Result<()> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    let r = if enabled { al.enable() } else { al.disable() };
    r.map_err(|e| Error::Invalid(e.to_string()))
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
#[tauri::command]
pub fn saved_list(state: S) -> Result<Library> {
    let db = state.db();
    Ok(Library { albums: db.saved_items("album")?, artists: db.saved_items("artist")?, ..Default::default() })
}

#[tauri::command]
pub fn save_album(app: AppHandle, state: S, album: Album, saved: bool) -> Result<()> {
    let db = state.db();
    if saved { db.save_item("album", &album.id, &album)? } else { db.unsave_item(&album.id)? }
    let _ = app.emit("saved-changed", ());
    Ok(())
}

#[tauri::command]
pub fn save_artist(app: AppHandle, state: S, artist: Artist, saved: bool) -> Result<()> {
    let db = state.db();
    if saved { db.save_item("artist", &artist.id, &artist)? } else { db.unsave_item(&artist.id)? }
    let _ = app.emit("saved-changed", ());
    Ok(())
}

