//! Updates from the project's GitHub releases (the latest one). Windows: the matching
//! `*_x64-setup.exe` is downloaded in the background and installed when the app closes, or right
//! away with "Restart to update". Android: the APK link is offered (Android asks before installing).

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
    let suffix = if cfg!(target_os = "android") { "_android-arm64.apk" } else { "_x64-setup.exe" };
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

/// Windows: download the installer (from github.com release assets only) into `dir`.
pub async fn download(http: &reqwest::Client, url: &str, dir: &std::path::Path) -> Result<()> {
    if !url.starts_with("https://github.com/knivesbatz/OpenMusic/releases/download/") || !url.ends_with("_x64-setup.exe") {
        return Err(Error::Invalid("unexpected update URL".into()));
    }
    let bytes = http.get(url).timeout(std::time::Duration::from_secs(600)).send().await?.error_for_status()?.bytes().await?;
    // A Windows executable, not an error page.
    if bytes.len() < 1_000_000 || !bytes.starts_with(b"MZ") {
        return Err(Error::Invalid("the downloaded update is not an installer".into()));
    }
    let name = url.rsplit('/').next().unwrap_or("update-setup.exe");
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
    let args: &[&str] = if now { &["/P", "/R"] } else { &["/S"] };
    std::process::Command::new(path).args(args).spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

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
