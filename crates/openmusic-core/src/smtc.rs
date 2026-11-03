//! Windows media controls (System Media Transport Controls) owned by the app.
//!
//! Headphone and keyboard media buttons, the Windows media flyout and the lock screen reach an app
//! through SMTC. WebView2 has its own SMTC session, but it only handles play/pause, next and
//! previous; the fast-forward and rewind most earbuds send while a button is held were dropped,
//! so holding the button to skip did nothing. The app now runs its own session with every button
//! enabled (holding fast-forward skips one song, rewind goes back one) and WebView2's media-key
//! handling is switched off so the two don't compete. Presses go to the UI as `media-action`
//! events, like the tray menu's.

use std::time::{Duration, Instant};

/// A media control button, as SMTC reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Play,
    Pause,
    Stop,
    Next,
    Previous,
    FastForward,
    Rewind,
    Other,
}

/// Turns button presses into player actions. Fast-forward and rewind can repeat while a button is
/// held; a burst of them is one skip.
#[derive(Debug, Default)]
pub struct Presses {
    last_seek: Option<(Button, Instant)>,
}

impl Presses {
    const HELD: Duration = Duration::from_millis(1200);

    pub fn action(&mut self, button: Button, now: Instant) -> Option<&'static str> {
        match button {
            Button::Play => Some("play"),
            Button::Pause | Button::Stop => Some("pause"),
            Button::Next => Some("next"),
            Button::Previous => Some("previous"),
            Button::FastForward | Button::Rewind => {
                let repeat = self.last_seek.is_some_and(|(b, at)| b == button && now.duration_since(at) < Self::HELD);
                self.last_seek = Some((button, now));
                match (repeat, button) {
                    (true, _) => None,
                    (false, Button::FastForward) => Some("next"),
                    (false, _) => Some("previous"),
                }
            }
            Button::Other => None,
        }
    }
}

#[cfg(windows)]
pub use imp::{available, init, stop, update};

/// Whether the app can run its own media controls (and so switch WebView2's off).
#[cfg(not(windows))]
pub fn available() -> bool {
    false
}

#[cfg(windows)]
mod imp {
    use super::{Button, Presses};
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    use tauri::Emitter;
    use tauri_plugin_openmusic_media::NowPlaying;
    use windows::core::{Ref, HSTRING};
    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Media::{
        MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs, SystemMediaTransportControlsTimelineProperties,
    };
    use windows::Storage::Streams::RandomAccessStreamReference;
    use windows::Storage::StorageFile;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;

    struct Session {
        smtc: SystemMediaTransportControls,
        /// The track (id, artwork) the flyout shows, so its text and cover are set once per song.
        shown: Mutex<(String, Option<String>)>,
    }

    // SMTC objects are agile (usable from any thread).
    unsafe impl Send for Session {}
    unsafe impl Sync for Session {}

    static SESSION: OnceLock<Session> = OnceLock::new();

    fn interop() -> windows::core::Result<ISystemMediaTransportControlsInterop> {
        windows::core::factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()
    }

    pub fn available() -> bool {
        static OK: OnceLock<bool> = OnceLock::new();
        *OK.get_or_init(|| interop().is_ok())
    }

    /// Create the app's media session for its main window. Call once, on the main thread.
    pub fn init(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
        if let Err(e) = try_init(app, window) {
            log::warn!("media controls failed to start: {e}");
        }
    }

    fn try_init(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let smtc: SystemMediaTransportControls = unsafe { interop().and_then(|i| i.GetForWindow(HWND(hwnd.0))) }.map_err(|e| e.to_string())?;
        let setup = || -> windows::core::Result<()> {
            smtc.SetIsEnabled(true)?;
            smtc.SetIsPlayEnabled(true)?;
            smtc.SetIsPauseEnabled(true)?;
            smtc.SetIsStopEnabled(true)?;
            smtc.SetIsNextEnabled(true)?;
            smtc.SetIsPreviousEnabled(true)?;
            smtc.SetIsFastForwardEnabled(true)?;
            smtc.SetIsRewindEnabled(true)?;
            smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed)?;
            let presses = Mutex::new(Presses::default());
            let app2 = app.clone();
            smtc.ButtonPressed(&TypedEventHandler::new(
                move |_: Ref<SystemMediaTransportControls>, args: Ref<SystemMediaTransportControlsButtonPressedEventArgs>| {
                    let b = match args.ok()?.Button()? {
                        SystemMediaTransportControlsButton::Play => Button::Play,
                        SystemMediaTransportControlsButton::Pause => Button::Pause,
                        SystemMediaTransportControlsButton::Stop => Button::Stop,
                        SystemMediaTransportControlsButton::Next => Button::Next,
                        SystemMediaTransportControlsButton::Previous => Button::Previous,
                        SystemMediaTransportControlsButton::FastForward => Button::FastForward,
                        SystemMediaTransportControlsButton::Rewind => Button::Rewind,
                        _ => Button::Other,
                    };
                    let action = presses.lock().unwrap_or_else(|e| e.into_inner()).action(b, Instant::now());
                    if let Some(action) = action {
                        let _ = app2.emit("media-action", serde_json::json!({ "action": action }));
                    }
                    Ok(())
                },
            ))?;
            let app3 = app.clone();
            smtc.PlaybackPositionChangeRequested(&TypedEventHandler::new(
                move |_: Ref<SystemMediaTransportControls>, args: Ref<PlaybackPositionChangeRequestedEventArgs>| {
                    let ms = args.ok()?.RequestedPlaybackPosition()?.Duration / 10_000;
                    let _ = app3.emit("media-action", serde_json::json!({ "action": "seek", "positionMs": ms.max(0) }));
                    Ok(())
                },
            ))?;
            Ok(())
        };
        setup().map_err(|e| e.to_string())?;
        let _ = SESSION.set(Session { smtc, shown: Mutex::new((String::new(), None)) });
        Ok(())
    }

    /// Show the playing track; `art` is a local image file. Blocks briefly; call it off the main thread.
    pub fn update(now: &NowPlaying, art: Option<String>) {
        let Some(s) = SESSION.get() else { return };
        if let Err(e) = show(s, now, art) {
            log::warn!("media controls update failed: {e}");
        }
    }

    fn show(s: &Session, now: &NowPlaying, art: Option<String>) -> windows::core::Result<()> {
        let smtc = &s.smtc;
        smtc.SetPlaybackStatus(if now.playing { MediaPlaybackStatus::Playing } else { MediaPlaybackStatus::Paused })?;
        let mut shown = s.shown.lock().unwrap_or_else(|e| e.into_inner());
        if shown.0 != now.id || shown.1 != art {
            let d = smtc.DisplayUpdater()?;
            d.SetType(MediaPlaybackType::Music)?;
            let m = d.MusicProperties()?;
            m.SetTitle(&HSTRING::from(now.title.as_str()))?;
            m.SetArtist(&HSTRING::from(now.artist.as_str()))?;
            m.SetAlbumTitle(&HSTRING::from(now.album.as_deref().unwrap_or("")))?;
            let cover = art
                .as_deref()
                .and_then(|p| StorageFile::GetFileFromPathAsync(&HSTRING::from(p)).ok()?.join().ok())
                .and_then(|f| RandomAccessStreamReference::CreateFromFile(&f).ok());
            d.SetThumbnail(cover.as_ref())?;
            d.Update()?;
            *shown = (now.id.clone(), art);
        }
        let ticks = |ms: u64| TimeSpan { Duration: ms as i64 * 10_000 };
        let t = SystemMediaTransportControlsTimelineProperties::new()?;
        t.SetStartTime(ticks(0))?;
        t.SetMinSeekTime(ticks(0))?;
        t.SetEndTime(ticks(now.duration_ms))?;
        t.SetMaxSeekTime(ticks(now.duration_ms))?;
        t.SetPosition(ticks(now.position_ms.min(now.duration_ms)))?;
        smtc.UpdateTimelineProperties(&t)?;
        Ok(())
    }

    /// Nothing is playing any more: the flyout closes.
    pub fn stop() {
        let Some(s) = SESSION.get() else { return };
        let _ = s.smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed);
        if let Ok(d) = s.smtc.DisplayUpdater() {
            let _ = d.ClearAll();
            let _ = d.Update();
        }
        *s.shown.lock().unwrap_or_else(|e| e.into_inner()) = (String::new(), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holding_a_button_skips_once() {
        let mut p = Presses::default();
        let t = Instant::now();
        let ms = |n| t + Duration::from_millis(n);
        // Fast-forward repeating while the button is held: one skip.
        assert_eq!(p.action(Button::FastForward, ms(0)), Some("next"));
        assert_eq!(p.action(Button::FastForward, ms(300)), None);
        assert_eq!(p.action(Button::FastForward, ms(900)), None);
        // Held again later: another skip.
        assert_eq!(p.action(Button::FastForward, ms(3000)), Some("next"));
        assert_eq!(p.action(Button::Rewind, ms(3100)), Some("previous"));
        assert_eq!(p.action(Button::Rewind, ms(3200)), None);
        // Next, previous and play/pause always act.
        assert_eq!(p.action(Button::Next, ms(3250)), Some("next"));
        assert_eq!(p.action(Button::Next, ms(3260)), Some("next"));
        assert_eq!(p.action(Button::Previous, ms(3270)), Some("previous"));
        assert_eq!(p.action(Button::Play, ms(3280)), Some("play"));
        assert_eq!(p.action(Button::Stop, ms(3290)), Some("pause"));
        assert_eq!(p.action(Button::Other, ms(3300)), None);
    }
}
