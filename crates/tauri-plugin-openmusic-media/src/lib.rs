//! Android media session for OpenMusic: a foreground service that keeps the app alive while
//! music plays, with the media notification (lock screen, headset, Bluetooth and car controls).
//! The webview stays the player; this mirrors its state and reports button presses back.
//! On other platforms every call is a no-op.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

/// What the notification shows. `artwork` is a local image file path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub artwork: Option<String>,
    pub playing: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
}

/// A control pressed outside the app: `play`, `pause`, `next`, `previous` or `seek`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAction {
    pub action: String,
    pub position_ms: Option<u64>,
}

#[cfg(target_os = "android")]
struct Media<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>(on_action: impl Fn(&AppHandle<R>, MediaAction) + Send + Sync + 'static) -> TauriPlugin<R> {
    Builder::new("openmusic-media")
        .setup(move |app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("app.openmusic.media", "MediaPlugin")?;
                let app2 = app.clone();
                let channel = tauri::ipc::Channel::<serde_json::Value>::new(move |body| {
                    if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                        if let Ok(action) = serde_json::from_str::<MediaAction>(&json) {
                            on_action(&app2, action);
                        }
                    }
                    Ok(())
                });
                handle.run_mobile_plugin::<serde_json::Value>("listen", serde_json::json!({ "channel": channel }))?;
                app.manage(Media(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api, on_action);
            Ok(())
        })
        .build()
}

/// Show or refresh the media notification. Blocks briefly; call it off the main thread.
pub fn update<R: Runtime>(app: &AppHandle<R>, now: &NowPlaying) {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        if let Some(m) = app.try_state::<Media<R>>() {
            if let Err(e) = m.0.run_mobile_plugin::<serde_json::Value>("update", now) {
                log_error(&e);
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, now);
}

/// Remove the notification and stop the service (queue cleared or signed out).
pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        if let Some(m) = app.try_state::<Media<R>>() {
            if let Err(e) = m.0.run_mobile_plugin::<serde_json::Value>("stop", ()) {
                log_error(&e);
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
}

#[cfg(target_os = "android")]
fn log_error(e: &dyn std::fmt::Display) {
    log::warn!("openmusic-media: {e}");
}
