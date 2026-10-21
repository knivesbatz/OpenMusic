//! Shared core for YTSpot and PLEXSpot. Each app crate calls [`run`] with its flavor and its own
//! Tauri context (identifier, window config, icons), so the two apps share all logic while
//! keeping separate identities, data directories and credentials.

pub mod art;
pub mod commands;
pub mod db;
pub mod downloads;
pub mod error;
pub mod lastfm;
pub mod local;
pub mod lyrics;
pub mod model;
pub mod safe_mode;
pub mod names;
pub mod plex;
pub mod secrets;
pub mod state;
pub mod ytm;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tokio::sync::{RwLock, Semaphore};

pub use state::Flavor;
use state::{AppState, Dirs};

fn init_state(app: &tauri::AppHandle, flavor: Flavor) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
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
        .user_agent(concat!("OpenMusic/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(8))
        .pool_max_idle_per_host(4)
        .build()?;
    let secrets = secrets::Secrets::new(&app.config().identifier, &dirs.data);
    let yt_cookie = if flavor == Flavor::YouTube { secrets.get_large("yt.cookie").ok().flatten() } else { None };
    let plex_session = if flavor == Flavor::Plex { secrets.get_json::<plex::Session>("plex.session").ok().flatten() } else { None };

    let mut ytm = ytm::Ytm::new(http.clone(), yt_cookie, &language);
    if flavor == Flavor::YouTube {
        ytm.page_id = db.kv_get::<String>("yt.pageId")?;
    }

    Ok(Arc::new(AppState {
        flavor,
        db: Mutex::new(db),
        plex: plex::Plex::new(http.clone(), client_id),
        ytm: RwLock::new(ytm),
        http,
        secrets,
        dirs,
        plex_session: RwLock::new(plex_session),
        downloads: Mutex::new(Default::default()),
        download_slots: Arc::new(Semaphore::new(2)),
        art_slots: Arc::new(Semaphore::new(6)),
        art_base: std::sync::OnceLock::new(),
        safe_mode: std::sync::OnceLock::new(),
        scanning: AtomicBool::new(false),
        last_yt_refresh: Mutex::new(None),
    }))
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

pub fn run(flavor: Flavor, context: tauri::Context<tauri::Wry>) {
    let state_slot: Arc<Mutex<Option<Arc<AppState>>>> = Arc::new(Mutex::new(None));
    let slot_for_protocol = state_slot.clone();

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![commands::HTPC_ARG]),
        ));
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
            let state = init_state(&handle, flavor)?;
            *state_slot.lock().unwrap() = Some(state.clone());
            if let Some(mode) = safe_mode::decide(&state.dirs.data) {
                let _ = state.safe_mode.set(mode);
            }
            // The main window is created here (not from config) so safe mode can switch the
            // webview's GPU acceleration off before it starts.
            let main_cfg = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("no main window in config")?;
            commands::with_browser_args(tauri::WebviewWindowBuilder::from_config(&handle, &main_cfg)?, &state).build()?;
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
                if st.flavor == Flavor::Plex {
                    let _ = commands::plex_reconnect(&h, &st).await;
                    let _ = h.emit("auth-changed", ());
                }
                commands::flush_scrobbles(&h, &st).await;
                let art_dir = st.dirs.art.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || art::prune(&art_dir)).await;
            });
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
            // Closing the main window quits the app (and the mini player with it); closing the
            // mini player only closes the mini player. Playback lives in the main window.
            match event {
                tauri::WindowEvent::CloseRequested { .. } if window.label() == "main" => {
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
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_set,
            commands::kv_get,
            commands::kv_set,
            commands::auth_status,
            commands::plex_pin_start,
            commands::plex_pin_poll,
            commands::plex_servers,
            commands::plex_select_server,
            commands::plex_reconnect_cmd,
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
            commands::localized_artist_names,
            commands::log_ui_error,
            commands::gpu_set,
            commands::yt_accounts,
            commands::plex_home_users,
            commands::plex_switch_user,
            commands::yt_select_account,
            commands::yt_song_meta,
            commands::saved_list,
            commands::save_album,
            commands::save_artist,
            commands::htpc_launch,
            commands::htpc_autostart_get,
            commands::htpc_autostart_set,
        ])
        .build(context)
        .expect("error while running application")
        .run(|app, event| {
            // A clean exit removes the "running" marker; a crash leaves it for the next launch.
            if let tauri::RunEvent::Exit = event {
                if let Ok(dir) = app.path().app_data_dir() {
                    safe_mode::clean_exit(&dir);
                }
            }
        });
}
