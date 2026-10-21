//! Notification-area (tray) icon on desktop: show/hide the window, playback controls and Quit.
//! With Settings → "Close to tray" on, closing the main window hides it and music keeps playing.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

fn setting(state: &AppState, key: &str) -> Option<serde_json::Value> {
    state.db().kv_get::<serde_json::Value>("settings").ok().flatten()?.get(key).cloned()
}

/// Settings → Close to tray (off by default). Runs on the window's thread when it closes, so it
/// never waits for the database: if it is busy, the window just closes.
pub fn close_to_tray(state: &AppState) -> bool {
    let Ok(db) = state.db.try_lock() else { return false };
    db.kv_get::<serde_json::Value>("settings")
        .ok()
        .flatten()
        .and_then(|s| s.get("closeToTray").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) => {
            let _ = w.hide();
        }
        _ => show_main(app),
    }
}

pub fn create(app: &AppHandle, state: &AppState) -> tauri::Result<()> {
    let ja = setting(state, "language").and_then(|v| v.as_str().map(|s| s == "ja")).unwrap_or(false);
    let l = |en: &'static str, jp: &'static str| if ja { jp } else { en };
    let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("show", l("Show", "表示"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("toggle", l("Play/Pause", "再生/一時停止"))?,
            &item("previous", l("Previous", "前の曲"))?,
            &item("next", l("Next", "次の曲"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", l("Quit", "終了"))?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(app.config().product_name.clone().unwrap_or_default())
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            // Playback lives in the webview: same event as the Android notification buttons.
            action => {
                let _ = app.emit("media-action", serde_json::json!({ "action": action }));
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
