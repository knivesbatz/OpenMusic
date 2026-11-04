//! Updates from the project's GitHub releases (the latest one). Windows: the matching
//! `*_x64-setup.exe` is downloaded in the background and installed when the app closes, or right
//! away with "Restart to update" (the UI does that by itself at startup when nothing is playing).
//! macOS: the `*_universal.dmg` is downloaded the same way; installing copies the app out of it
//! over the running app's bundle. Android: the APK link is offered (Android asks before installing).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

const LATEST: &str = "https://api.github.com/repos/knivesbatz/OpenMusic/releases/latest";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub version: String,
    /// Download URL of this app's installer (Windows) or APK (Android) in that release.
    pub url: Option<String>,
    /// The release notes' "New in" section.
    pub notes: Option<String>,
    /// Windows: downloaded and ready to install.
    pub ready: bool,
}

/// A downloaded installer waiting to run (on exit or "Restart to update").
static PENDING: Mutex<Option<PathBuf>> = Mutex::new(None);

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next().flatten().unwrap_or(0), it.next().flatten().unwrap_or(0)))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn new_in_section(body: &str) -> Option<String> {
    let start = body.find("## New in")?;
    let rest = &body[start..];
    let after_heading = rest.find('\n').map(|i| &rest[i + 1..]).unwrap_or("");
    let end = after_heading.find("\n## ").unwrap_or(after_heading.len());
    Some(after_heading[..end].trim().chars().take(1500).collect())
}

pub async fn check(http: &reqwest::Client, product: &str) -> Result<UpdateInfo> {
    let v: Value = http
        .get(LATEST)
        .header("User-Agent", concat!("OpenMusic/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let tag = v.get("tag_name").and_then(|t| t.as_str()).unwrap_or_default();
    let current = env!("CARGO_PKG_VERSION").to_string();
    let suffix = if cfg!(target_os = "android") {
        "_android-arm64.apk"
    } else if cfg!(target_os = "macos") {
        // One disk image for Apple silicon and Intel Macs.
        "_universal.dmg"
    } else {
        "_x64-setup.exe"
    };
    let url = v.get("assets").and_then(|a| a.as_array()).and_then(|assets| {
        assets.iter().find_map(|a| {
            let name = a.get("name")?.as_str()?;
            (name.starts_with(&format!("{product}_")) && name.ends_with(suffix)).then(|| a.get("browser_download_url")?.as_str().map(str::to_string))?
        })
    });
    let available = is_newer(tag, &current) && url.is_some();
    Ok(UpdateInfo {
        available,
        current,
        version: tag.trim_start_matches('v').to_string(),
        url,
        notes: v.get("body").and_then(|b| b.as_str()).and_then(new_in_section),
        ready: PENDING.lock().map(|p| p.is_some()).unwrap_or(false),
    })
}

/// The file this platform installs updates from.
const PACKAGE_SUFFIX: &str = if cfg!(target_os = "macos") { "_universal.dmg" } else { "_x64-setup.exe" };

/// Whether `bytes` look like this platform's package, not an error page: a Windows executable
/// ("MZ"), or a disk image (UDIF images end with a 512-byte "koly" trailer).
pub fn looks_like_package(bytes: &[u8], dmg: bool) -> bool {
    if bytes.len() < 1_000_000 {
        return false;
    }
    if dmg {
        bytes[bytes.len() - 512..].starts_with(b"koly")
    } else {
        bytes.starts_with(b"MZ")
    }
}

/// Windows and macOS: download the installer or disk image (github.com release assets only) into
/// `dir`; it installs on exit or with "Restart to update".
pub async fn download(http: &reqwest::Client, url: &str, dir: &std::path::Path) -> Result<()> {
    if !url.starts_with("https://github.com/knivesbatz/OpenMusic/releases/download/") || !url.ends_with(PACKAGE_SUFFIX) {
        return Err(Error::Invalid("unexpected update URL".into()));
    }
    let bytes = http.get(url).timeout(std::time::Duration::from_secs(600)).send().await?.error_for_status()?.bytes().await?;
    if !looks_like_package(&bytes, cfg!(target_os = "macos")) {
        return Err(Error::Invalid("the downloaded update is not an installer".into()));
    }
    let name = url.rsplit('/').next().unwrap_or("update");
    std::fs::create_dir_all(dir)?;
    let path = dir.join(name);
    tokio::fs::write(&path, &bytes).await?;
    *PENDING.lock().unwrap() = Some(path);
    Ok(())
}

/// Run the downloaded installer: `now` = with a progress window and the app restarted after
/// ("Restart to update"); otherwise silently (the app is closing anyway).
pub fn run_pending(now: bool) -> bool {
    let Some(path) = PENDING.lock().ok().and_then(|mut p| p.take()) else { return false };
    #[cfg(target_os = "macos")]
    {
        match mac::install(&path) {
            Ok(bundle) => {
                if now {
                    mac::relaunch(&bundle);
                }
                true
            }
            Err(e) => {
                log::warn!("update install failed: {e}");
                false
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let args: &[&str] = if now { &["/P", "/R"] } else { &["/S"] };
        std::process::Command::new(path).args(args).spawn().is_ok()
    }
}

/// macOS: swap the running app's bundle for the one in the downloaded disk image.
#[cfg(target_os = "macos")]
mod mac {
    use std::io::{Error, ErrorKind, Result};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// `/Applications/YTSpot.app` from `/Applications/YTSpot.app/Contents/MacOS/YTSpot`.
    fn current_bundle() -> Result<PathBuf> {
        let exe = std::env::current_exe()?.canonicalize()?;
        exe.ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .map(Path::to_path_buf)
            .ok_or_else(|| Error::new(ErrorKind::NotFound, "not running from an .app bundle"))
    }

    fn run(cmd: &mut Command) -> Result<()> {
        let out = cmd.output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(Error::other(String::from_utf8_lossy(&out.stderr).trim().to_string()))
        }
    }

    /// Mount the image, copy its app next to the installed one, then swap them. Returns the
    /// bundle path. Fails (leaving the installed app as it was) when its folder isn't writable.
    pub fn install(dmg: &Path) -> Result<PathBuf> {
        let bundle = current_bundle()?;
        let parent = bundle.parent().ok_or_else(|| Error::other("no parent folder"))?;
        let name = bundle.file_name().ok_or_else(|| Error::other("no bundle name"))?.to_string_lossy().to_string();
        let mount = std::env::temp_dir().join(format!("openmusic-update-{}", std::process::id()));
        std::fs::create_dir_all(&mount)?;
        run(Command::new("hdiutil").args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"]).arg(&mount).arg(dmg))?;
        let staged = parent.join(format!(".{name}.update"));
        let copied = (|| {
            let app = std::fs::read_dir(&mount)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .find(|p| p.extension().is_some_and(|e| e == "app"))
                .ok_or_else(|| Error::new(ErrorKind::NotFound, "no app in the disk image"))?;
            let _ = std::fs::remove_dir_all(&staged);
            run(Command::new("ditto").arg(&app).arg(&staged))
        })();
        let _ = run(Command::new("hdiutil").args(["detach", "-force"]).arg(&mount));
        let _ = std::fs::remove_dir(&mount);
        copied?;
        let old = parent.join(format!(".{name}.old"));
        let _ = std::fs::remove_dir_all(&old);
        std::fs::rename(&bundle, &old)?;
        if let Err(e) = std::fs::rename(&staged, &bundle) {
            let _ = std::fs::rename(&old, &bundle);
            return Err(e);
        }
        let _ = std::fs::remove_dir_all(&old);
        let _ = std::fs::remove_file(dmg);
        Ok(bundle)
    }

    /// Open the new app once this one has quit (the single-instance check would hand a second
    /// copy straight back to this one).
    pub fn relaunch(bundle: &Path) {
        let _ = Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 1.5; /usr/bin/open \"$0\"")
            .arg(bundle)
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_packages() {
        let mut exe = vec![0u8; 1_200_000];
        exe[..2].copy_from_slice(b"MZ");
        assert!(looks_like_package(&exe, false));
        assert!(!looks_like_package(&exe, true));
        let mut dmg = vec![0u8; 1_200_000];
        let n = dmg.len();
        dmg[n - 512..n - 508].copy_from_slice(b"koly");
        assert!(looks_like_package(&dmg, true));
        assert!(!looks_like_package(b"<html>Not Found</html>", false));
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("v1.0.5", "1.0.4"));
        assert!(is_newer("v1.1.0", "1.0.9"));
        assert!(!is_newer("v1.0.4", "1.0.4"));
        assert!(!is_newer("v1.0.3", "1.0.4"));
        assert!(!is_newer("garbage", "1.0.4"));
    }

    #[test]
    fn release_notes_section() {
        let body = "# OpenMusic 1.0.5\n\nIntro\n\n## New in 1.0.5\n- A\n- B\n\n## Also in 1.0.4\n- C\n";
        assert_eq!(new_in_section(body).as_deref(), Some("- A\n- B"));
    }
}
