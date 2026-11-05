//! Core of OpenSpot: one music app for YouTube Music, Plex and local files. The app crate
//! (`apps/openspot`) calls [`run`] with its Tauri context (identifier, window config, icons).
//! Each provider has a switch in Settings → Services (`state::Services`); items carry their
//! provider in their id (`state::Provider::of_id`).
//!
//! The identifier stays `app.openmusic.ytspot` (YTSpot 1.x installs upgrade in place: same data
//! dir, credentials and webview profile); PLEXSpot's data is imported once (`migrate.rs`).

pub mod art;
pub mod audio_share;
pub mod commands;
pub mod db;
pub mod discord;
pub mod downloads;
pub mod error;
pub mod lastfm;
pub mod local;
pub mod lyrics;
pub mod migrate;
pub mod model;
pub mod safe_mode;
pub mod names;
pub mod plex;
pub mod secrets;
pub mod smtc;
pub mod state;
pub mod sync;
pub mod translate;
#[cfg(desktop)]
mod tray;
pub mod updater;
mod watchdog;
pub mod ytm;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tokio::sync::{RwLock, Semaphore};

pub use state::{Provider, Services};
use state::{AppState, Dirs};

/// A credential read where an error (a denied or locked keychain) is logged and read as "none";
/// `errored` records it so nothing is decided for good from it.
fn read_secret<T>(r: Result<Option<T>, error::Error>, name: &str, errored: &mut bool) -> Option<T> {
    r.unwrap_or_else(|e| {
        log::warn!("{name}: {e}");
        *errored = true;
        None
    })
}

/// The saved service switches, or the defaults for this data dir ([`Services::initial`]), saved
/// only when `settled`.
fn decide_services(db: &db::Db, before: &migrate::Before, yt_cookie: bool, plex_token: bool, settled: bool) -> error::Result<Services> {
    if let Some(s) = db.kv_get::<Services>("services")? {
        return Ok(s);
    }
    let s = Services::initial(&state::InitialFacts {
        had_own_settings: before.had_own_settings,
        had_yt_cookie: before.had_yt_cookie || yt_cookie,
        had_local_only: before.had_local_only,
        yt_account: db.kv_get::<String>("yt.account")?.is_some(),
        plex_account: db.kv_get::<String>("plex.account")?.is_some(),
        plex_token,
    });
    if settled {
        db.kv_set("services", &s)?;
    }
    Ok(s)
}

fn init_state(app: &tauri::AppHandle) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
    let data = app.path().app_data_dir()?;
    let cache = app.path().app_cache_dir()?;
    let dirs = Dirs {
        art: cache.join("art"),
        local_art: data.join("local-art"),
        downloads: data.join("downloads"),
        data: data.clone(),
    };
    for d in [&dirs.data, &dirs.art, &dirs.local_art, &dirs.downloads] {
        std::fs::create_dir_all(d)?;
    }
    let db = db::Db::open(&dirs.data.join("library.db"))?;
    let secrets = secrets::Secrets::new(&app.config().identifier, &dirs.data);
    // What this data dir held before the PLEXSpot import merged anything into it.
    let before = migrate::before(&dirs.data, &db, &secrets);
    // The one-time PLEXSpot import. Never fails (each step logs and retries next start); it runs
    // before the clientId is read so Plex keeps PLEXSpot's device identity.
    migrate::run(&dirs.data, &db, &secrets);
    let _ = db.cache_prune();
    let client_id: String = match db.kv_get("clientId")? {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            db.kv_set("clientId", &id)?;
            id
        }
    };
    let language = db
        .kv_get::<serde_json::Value>("settings")?
        .and_then(|s| s.get("language").and_then(|l| l.as_str()).map(String::from))
        .unwrap_or_else(|| "en".into());
    let http = reqwest::Client::builder()
        .user_agent(concat!("OpenSpot/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(8))
        .pool_max_idle_per_host(4)
        .build()?;
    // Both providers' sign-ins load whatever their switches say; a provider that is off is
    // simply never called.
    let mut secret_error = false;
    let yt_cookie = read_secret(secrets.get_large("yt.cookie"), "yt.cookie", &mut secret_error);
    let plex_token = read_secret(secrets.get("plex.token"), "plex.token", &mut secret_error);
    let plex_session = secrets.get_json::<plex::Session>("plex.session").unwrap_or_else(|e| {
        log::warn!("plex.session: {e}");
        None
    });
    // Decided for good only from a credential store that answered and once the PLEXSpot import
    // can no longer bring a Plex sign-in in (deferred or failed); otherwise again next start.
    let settled = !secret_error && !migrate::import_pending(&dirs.data, &db);
    let services = decide_services(&db, &before, yt_cookie.is_some(), plex_token.is_some(), settled)?;

    let mut ytm = ytm::Ytm::new(http.clone(), yt_cookie, &language);
    ytm.page_id = db.kv_get::<String>("yt.pageId")?;

    Ok(Arc::new(AppState {
        db: Mutex::new(db),
        plex: plex::Plex::new(http.clone(), client_id),
        ytm: RwLock::new(ytm),
        http,
        secrets,
        dirs,
        services: std::sync::RwLock::new(services),
        plex_session: RwLock::new(plex_session),
        downloads: Mutex::new(Default::default()),
        download_slots: Arc::new(Semaphore::new(2)),
        art_slots: Arc::new(Semaphore::new(10)),
        art_base: std::sync::OnceLock::new(),
        safe_mode: std::sync::OnceLock::new(),
        scanning: AtomicBool::new(false),
        last_yt_refresh: Mutex::new(None),
        offline_until: Mutex::new([None; 2]),
    }))
}

/// macOS: the PLEXSpot sign-in comes from the keychain after the window shows, so its prompts
/// are explained by the app behind them and never hold up the start. Runs on its own database
/// connection (the prompts can wait for the user). When it brought a Plex sign-in, Plex connects.
#[cfg(target_os = "macos")]
fn import_secrets_later(app: tauri::AppHandle, state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let st = state.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || match db::Db::open(&st.dirs.data.join("library.db")) {
            Ok(db) => migrate::run_secrets_later(&st.dirs.data, &db, &st.secrets),
            Err(e) => migrate::log_note(&st.dirs.data, &format!("PLEXSpot sign-in import: {e}")),
        })
        .await;
        if state.plex_session.read().await.is_none() {
            if let Ok(Some(sess)) = state.secrets.get_json::<plex::Session>("plex.session") {
                *state.plex_session.write().await = Some(sess);
                if state.on(Provider::Plex) {
                    let _ = commands::plex_reconnect(&app, &state).await;
                }
                let _ = app.emit("auth-changed", serde_json::json!({ "provider": Provider::Plex }));
            }
        }
    });
}

/// macOS: the 1.x updater swapped the new version into `YTSpot.app` / `PLEXSpot.app`. Before any
/// window opens, rename this bundle to `OpenSpot.app` in the same folder, or when one is already
/// there, move this copy to the Trash, then start `OpenSpot.app` and quit. A 1.x "launch at
/// startup" entry is replaced by OpenSpot's on that next start. Best effort: on any error the app
/// keeps running from where it is. Returns true when this process should quit.
#[cfg(target_os = "macos")]
fn rename_bundle_once(app: &tauri::AppHandle) -> bool {
    use std::process::Command;
    let Some(bundle) = std::env::current_exe()
        .and_then(|e| e.canonicalize())
        .ok()
        .and_then(|e| e.ancestors().find(|p| p.extension().is_some_and(|x| x == "app")).map(|p| p.to_path_buf()))
    else {
        return false;
    };
    let name = bundle.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !matches!(name.as_str(), "YTSpot.app" | "PLEXSpot.app") {
        return false;
    }
    let Some(parent) = bundle.parent() else { return false };
    let target = parent.join("OpenSpot.app");
    // No logger is installed: failures go to crash.log (shown in Settings).
    let warn = |msg: String| match app.path().app_data_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            migrate::log_note(&dir, &msg)
        }
        Err(_) => log::warn!("{msg}"),
    };
    if target.exists() {
        // A second copy with the same identity: it would compete with OpenSpot.app for the
        // single-instance lock, Launch Services and updates.
        let script = format!(r#"tell application "Finder" to delete POSIX file {:?}"#, bundle.to_string_lossy());
        match Command::new("/usr/bin/osascript").args(["-e", &script]).output() {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                warn(format!("moving {name} to the Trash failed: {}", String::from_utf8_lossy(&o.stderr).trim()));
                return false;
            }
            Err(e) => {
                warn(format!("moving {name} to the Trash failed: {e}"));
                return false;
            }
        }
    } else if let Err(e) = std::fs::rename(&bundle, &target) {
        warn(format!("renaming {name} to OpenSpot.app failed: {e}"));
        return false;
    }
    // A 1.x launch-at-startup entry points at the old name: OpenSpot registers its own on the
    // next start (from the new path).
    let agents = std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/LaunchAgents"));
    let mut had_autostart = false;
    for old in ["YTSpot.plist", "PLEXSpot.plist"] {
        if let Some(path) = agents.as_ref().map(|d| d.join(old)).filter(|p| p.exists()) {
            had_autostart = true;
            let _ = std::fs::remove_file(path);
        }
    }
    if had_autostart {
        if let Ok(dir) = app.path().app_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join(AUTOSTART_MARKER), b"");
        }
    }
    // Started once this process is gone (the single-instance lock would hand it straight back).
    let _ = Command::new("/bin/sh").arg("-c").arg("sleep 1.5; /usr/bin/open \"$0\"").arg(&target).spawn();
    true
}

/// Written by `rename_bundle_once` when a 1.x launch-at-startup entry was removed.
#[cfg(target_os = "macos")]
const AUTOSTART_MARKER: &str = "autostart.reregister";

#[cfg(target_os = "macos")]
fn reregister_autostart(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let Ok(dir) = app.path().app_data_dir() else { return };
    let marker = dir.join(AUTOSTART_MARKER);
    if marker.exists() {
        if let Err(e) = app.autolaunch().enable() {
            log::warn!("launch at startup: {e}");
        }
        let _ = std::fs::remove_file(marker);
    }
}

/// Append panics to `crash.log` in the app data folder (shown in Settings) so a crash on a user's
/// machine leaves something to diagnose. The default hook still runs.
fn install_crash_log(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let path = dir.join("crash.log");
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = writeln!(f, "[{}] v{} panic: {info}", db::now(), env!("CARGO_PKG_VERSION"));
        }
        default(info);
    }));
}

#[cfg(target_os = "android")]
const ANDROID_USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

/// Records each command for the stall detector before dispatching it.
fn with_watchdog(
    handler: impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    move |invoke| {
        watchdog::record(invoke.message.command());
        handler(invoke)
    }
}

/// macOS: the app's pages are served from `http://localhost:<port>` (tauri-plugin-localhost)
/// instead of `tauri://localhost`. YouTube's embedded player refuses to play on a page without an
/// http(s) origin, and Plex servers reached over plain http would be mixed content there. Windows
/// and Android already use `http://tauri.localhost`. The port stays YTSpot's so the origin, and
/// with it the page's local storage, stays the same from launch to launch and across the upgrade.
#[cfg(target_os = "macos")]
pub const UI_PORT: u16 = 47321;

/// Where a page of the app lives: `index.html#pip` and the like.
pub fn ui_url(path: &str) -> tauri::WebviewUrl {
    #[cfg(target_os = "macos")]
    if let Ok(url) = format!("http://localhost:{UI_PORT}/{path}").parse() {
        return tauri::WebviewUrl::External(url);
    }
    tauri::WebviewUrl::App(path.into())
}

pub fn run(context: tauri::Context<tauri::Wry>) {
    let state_slot: Arc<Mutex<Option<Arc<AppState>>>> = Arc::new(Mutex::new(None));
    let slot_for_protocol = state_slot.clone();

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![commands::HTPC_ARG]),
        ));
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_localhost::Builder::new(UI_PORT).build());
    builder
        // Android: media notification and background playback; button presses go to the UI.
        .plugin(tauri_plugin_openmusic_media::init(|app, action| {
            let _ = app.emit("media-action", action);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("art", move |_ctx, request, responder| {
            let state = slot_for_protocol.lock().unwrap().clone();
            tauri::async_runtime::spawn(async move {
                let resp = match state {
                    Some(st) => art::handle(st, request).await,
                    None => tauri::http::Response::builder().status(503).body(Vec::new()).unwrap(),
                };
                responder.respond(resp);
            });
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            install_crash_log(&handle);
            #[cfg(target_os = "macos")]
            if rename_bundle_once(&handle) {
                std::process::exit(0);
            }
            #[cfg(target_os = "macos")]
            reregister_autostart(&handle);
            let state = init_state(&handle)?;
            *state_slot.lock().unwrap() = Some(state.clone());
            if let Some(mode) = safe_mode::decide(&state.dirs.data) {
                let _ = state.safe_mode.set(mode);
            }
            // The main window is created here (not from config) so safe mode can switch the
            // webview's GPU acceleration off before it starts.
            let main_cfg = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("no main window in config")?;
            #[cfg(target_os = "macos")]
            let main_cfg = tauri::utils::config::WindowConfig { url: ui_url(""), ..main_cfg };
            let main = commands::with_browser_args(tauri::WebviewWindowBuilder::from_config(&handle, &main_cfg)?, &state);
            // Android: Google refuses sign-in in anything that identifies as a WebView ("; wv"),
            // and YouTube sign-in happens in this window there. Present as mobile Chrome.
            #[cfg(target_os = "android")]
            let main = main.user_agent(ANDROID_USER_AGENT).on_page_load(|_w, p| {
                if p.event() == tauri::webview::PageLoadEvent::Finished {
                    commands::main_page_loaded(p.url());
                }
            });
            // Windows: the UI draws a Spotify-style title bar with its own window buttons.
            #[cfg(windows)]
            let main = main.decorations(false);
            let _main = main.build()?;
            #[cfg(target_os = "macos")]
            import_secrets_later(handle.clone(), state.clone());
            // Windows: headphone and media keys, the media flyout (see smtc.rs).
            #[cfg(windows)]
            smtc::init(&handle, &_main);
            // Desktop only: Android release builds block plain-HTTP requests from the webview, so
            // there the UI uses the in-process art:// protocol.
            #[cfg(desktop)]
            match art::start_server(state.clone()) {
                Ok(base) => {
                    let _ = state.art_base.set(base);
                }
                // The UI falls back to the art:// protocol.
                Err(e) => log::warn!("artwork server failed to start: {e}"),
            }
            app.manage(state.clone());
            watchdog::start(handle.clone(), state.clone());
            #[cfg(desktop)]
            if let Err(e) = tray::create(&handle, &state) {
                log::warn!("tray icon failed: {e}");
            }

            downloads::recover(&state);
            // Local folders and the downloads dir are readable through the asset protocol.
            let _ = app.asset_protocol_scope().allow_directory(&state.dirs.downloads, true);
            if let Ok(folders) = commands::local_folders(app.state()) {
                for f in folders {
                    let _ = app.asset_protocol_scope().allow_directory(&f, true);
                }
            }

            // Background housekeeping, off the UI path.
            let st = state.clone();
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                // Plex re-probes its server (addresses change); nothing while it is off.
                if st.on(Provider::Plex) {
                    let _ = commands::plex_reconnect(&h, &st).await;
                    let _ = h.emit("auth-changed", serde_json::json!({ "provider": Provider::Plex }));
                }
                commands::flush_scrobbles(&h, &st).await;
                let art_dir = st.dirs.art.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    art::upgrade_cache(&art_dir);
                    art::prune(&art_dir);
                })
                .await;
            });
            commands::yt_keep_session(handle.clone(), state.clone());
            // Scrobbles that failed while offline are retried every 10 minutes, not only when the
            // next track is scrobbled.
            let st = state.clone();
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(600)).await;
                    commands::flush_scrobbles(&h, &st).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window quits the app (and the mini player with it), or hides it to
            // the tray when that setting is on; closing the mini player only closes the mini
            // player. Playback lives in the main window.
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    #[cfg(desktop)]
                    if window.app_handle().try_state::<Arc<AppState>>().is_some_and(|s| tray::close_to_tray(&s)) {
                        api.prevent_close();
                        let _ = window.hide();
                        return;
                    }
                    #[cfg(not(desktop))]
                    let _ = api;
                    if let Some(p) = window.app_handle().get_webview_window("pip") {
                        let _ = p.close();
                    }
                }
                tauri::WindowEvent::Destroyed if window.label() == "pip" => {
                    let _ = window.app_handle().emit("pip-closed", ());
                }
                _ => {}
            }
        })
        .invoke_handler(with_watchdog(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_set,
            commands::kv_get,
            commands::kv_set,
            commands::services_get,
            commands::services_set,
            commands::auth_status,
            commands::plex_pin_start,
            commands::plex_pin_poll,
            commands::plex_servers,
            commands::plex_select_server,
            commands::plex_reconnect_cmd,
            commands::auth_recover,
            commands::yt_login,
            commands::sign_out,
            commands::home,
            commands::search,
            commands::search_kind,
            commands::artist,
            commands::album,
            commands::playlist,
            commands::library,
            commands::radio,
            commands::autoplay_tracks,
            commands::media_update,
            commands::media_stop,
            commands::track_loudness,
            commands::widget_refresh,
            commands::presence_update,
            commands::presence_clear,
            commands::translate_texts,
            commands::saved_in,
            commands::pl_remove_track,
            commands::yt_playlist_edit,
            commands::yt_copy_playlist,
            commands::save_text_file,
            commands::new_releases,
            commands::self_test_log,
            commands::update_check,
            commands::update_download,
            commands::update_restart,
            commands::self_test_exit,
            commands::resolve_stream,
            commands::record_play,
            commands::mark_played,
            commands::rate,
            commands::queue_save,
            commands::queue_load,
            commands::get_lyrics,
            commands::pl_list,
            commands::pl_create,
            commands::pl_update,
            commands::pl_delete,
            commands::pl_set_cover,
            commands::pl_add,
            commands::pl_reorder,
            commands::hide_playlist,
            commands::local_folders,
            commands::local_add_folder,
            commands::local_remove_folder,
            commands::local_scan,
            commands::local_library,
            commands::lastfm_status,
            commands::lastfm_set_keys,
            commands::lastfm_connect_start,
            commands::lastfm_connect_finish,
            commands::lastfm_disconnect,
            commands::lastfm_now_playing,
            commands::lastfm_scrobble,
            commands::download_tracks,
            commands::download_list,
            commands::download_cancel,
            commands::download_remove,
            commands::storage_usage,
            commands::clear_cache,
            commands::pip_toggle,
            commands::focus_main,
            commands::liked_ids,
            commands::liked_tracks,
            commands::localized_artist_names,
            commands::artist_compilations,
            commands::log_ui_error,
            commands::gpu_set,
            commands::audio_share_set,
            commands::listening_history,
            commands::history_remove,
            commands::history_clear,
            commands::sync_receive_start,
            commands::sync_receive_stop,
            commands::sync_send,
            commands::browse_categories,
            commands::browse_page,
            commands::browse_art,
            commands::profile_info,
            commands::profile_artists,
            commands::yt_delete_playlist,
            commands::yt_accounts,
            commands::plex_home_users,
            commands::plex_switch_user,
            commands::yt_select_account,
            commands::yt_song_meta,
            commands::saved_list,
            commands::save_album,
            commands::save_artist,
            commands::save_podcast,
            commands::save_episode,
            commands::htpc_launch,
            commands::htpc_autostart_get,
            commands::htpc_autostart_set,
        ]))
        .build(context)
        .expect("error while running application")
        .run(|app, event| {
            // A clean exit removes the "running" marker; a crash leaves it for the next launch.
            if let tauri::RunEvent::Exit = event {
                audio_share::shutdown();
                // Cookies YouTube renewed since the last save.
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    if let Some(cookie) = state.ytm.try_read().ok().and_then(|y| y.take_refreshed()) {
                        let _ = state.secrets.set_large("yt.cookie", &cookie);
                    }
                }
                if let Ok(dir) = app.path().app_data_dir() {
                    safe_mode::clean_exit(&dir);
                }
                // A downloaded update installs quietly as the app closes.
                updater::run_pending(false);
            }
        });
}
