//! Safe mode: run the webview without GPU acceleration.
//!
//! Some GPU drivers crash or hang WebView2's compositor. A marker file is written at startup and
//! removed on a clean exit; if it is still there at the next launch the previous run did not exit
//! cleanly, and that launch starts in safe mode automatically (the UI explains this and offers to
//! turn acceleration back on). Users can also turn acceleration off in Settings.

use std::path::Path;

const MARKER: &str = "running.marker";
const GPU_OFF: &str = "gpu-off";

/// Browser arguments for safe mode. They replace wry's defaults, which are repeated here.
/// WebView2 arguments. Setting our own replaces wry's defaults, so they are repeated here, plus
/// autoplay: the player starts the next song (and the crossfade's second player) without a click.
pub const NORMAL_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";
pub const SAFE_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --disable-gpu --disable-gpu-compositing";

/// Decide this launch's mode and mark the app as running. `Some("auto")` after an unclean exit,
/// `Some("manual")` when turned off in Settings, `None` otherwise.
pub fn decide(data_dir: &Path) -> Option<&'static str> {
    let _ = std::fs::create_dir_all(data_dir);
    let crashed = data_dir.join(MARKER).exists();
    let _ = std::fs::write(data_dir.join(MARKER), std::process::id().to_string());
    let off = std::fs::read_to_string(data_dir.join(GPU_OFF)).ok();
    match off.as_deref().map(str::trim) {
        Some("manual") => Some("manual"),
        Some(_) => Some("auto"),
        None if crashed => {
            let _ = std::fs::write(data_dir.join(GPU_OFF), "auto");
            Some("auto")
        }
        None => None,
    }
}

pub fn clean_exit(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(MARKER));
}

/// Turn GPU acceleration on or off for the next launch.
pub fn set_gpu(data_dir: &Path, enabled: bool) -> std::io::Result<()> {
    if enabled {
        match std::fs::remove_file(data_dir.join(GPU_OFF)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    } else {
        std::fs::write(data_dir.join(GPU_OFF), "manual")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unclean_exit_turns_on_safe_mode_until_reenabled() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        assert_eq!(decide(d), None); // first launch
        clean_exit(d);
        assert_eq!(decide(d), None); // clean restart
        // no clean_exit: simulated crash
        assert_eq!(decide(d), Some("auto"));
        clean_exit(d);
        assert_eq!(decide(d), Some("auto")); // stays until the user turns acceleration back on
        set_gpu(d, true).unwrap();
        clean_exit(d);
        assert_eq!(decide(d), None);
        set_gpu(d, false).unwrap();
        clean_exit(d);
        assert_eq!(decide(d), Some("manual"));
    }
}
