//! Credentials. On desktop they live in the OS credential store (Windows Credential Manager via
//! `keyring`), namespaced by the app identifier so YTSpot and PLEXSpot never see each other's
//! tokens. Android has no keyring backend, so there they are kept in a file in the app's private
//! storage, which other apps cannot read. Nothing secret goes to SQLite. The one-time PLEXSpot
//! import (migrate.rs) reads the old app's entries through a second `Secrets` for its identifier.

use crate::error::{Error, Result};

pub struct Secrets {
    #[cfg_attr(mobile, allow(dead_code))]
    service: String,
    #[cfg(mobile)]
    file: std::path::PathBuf,
    #[cfg(mobile)]
    lock: std::sync::Mutex<()>,
}

impl Secrets {
    #[cfg_attr(desktop, allow(unused_variables))]
    pub fn new(identifier: &str, data_dir: &std::path::Path) -> Self {
        Secrets {
            service: identifier.to_string(),
            #[cfg(mobile)]
            file: data_dir.join("secrets.json"),
            #[cfg(mobile)]
            lock: std::sync::Mutex::new(()),
        }
    }

    #[cfg(desktop)]
    fn entry(&self, name: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, name).map_err(|e| Error::Keyring(e.to_string()))
    }

    #[cfg(desktop)]
    pub fn get(&self, name: &str) -> Result<Option<String>> {
        match self.entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Keyring(e.to_string())),
        }
    }

    #[cfg(desktop)]
    pub fn set(&self, name: &str, value: &str) -> Result<()> {
        self.entry(name)?.set_password(value).map_err(|e| Error::Keyring(e.to_string()))
    }

    #[cfg(desktop)]
    pub fn delete(&self, name: &str) -> Result<()> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Keyring(e.to_string())),
        }
    }

    #[cfg(mobile)]
    fn load(&self) -> std::collections::BTreeMap<String, String> {
        std::fs::read(&self.file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    #[cfg(mobile)]
    fn store(&self, map: &std::collections::BTreeMap<String, String>) -> Result<()> {
        // Write-then-rename so a crash never leaves a truncated secrets file.
        let tmp = self.file.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(map)?)?;
        std::fs::rename(&tmp, &self.file).map_err(|e| Error::Keyring(e.to_string()))
    }

    #[cfg(mobile)]
    pub fn get(&self, name: &str) -> Result<Option<String>> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self.load().remove(name))
    }

    #[cfg(mobile)]
    pub fn set(&self, name: &str, value: &str) -> Result<()> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.load();
        map.insert(name.to_string(), value.to_string());
        self.store(&map)
    }

    #[cfg(mobile)]
    pub fn delete(&self, name: &str) -> Result<()> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.load();
        if map.remove(name).is_some() {
            self.store(&map)?;
        }
        Ok(())
    }

    pub fn get_json<T: serde::de::DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        Ok(self.get_large(name)?.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub fn set_json<T: serde::Serialize>(&self, name: &str, v: &T) -> Result<()> {
        self.set_large(name, &serde_json::to_string(v)?)
    }

    /// Windows credentials hold at most 2560 bytes, so larger values (cookie jars, server lists)
    /// are split across chunks, with their count stored under `name`.
    pub fn set_large(&self, name: &str, value: &str) -> Result<()> {
        set_large(self, name, value)
    }

    pub fn get_large(&self, name: &str) -> Result<Option<String>> {
        get_large(self, name)
    }

    pub fn delete_large(&self, name: &str) -> Result<()> {
        delete_large(self, name)
    }
}

/// Large values are written one at a time (a cookie refresh and a sign-in must not interleave).
static LARGE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The operations the large-value helpers (and the PLEXSpot import in migrate.rs, which copies
/// between two credential stores) need. Tests use an in-memory map.
pub(crate) trait Store {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, value: &str) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
}

impl Store for Secrets {
    fn get(&self, name: &str) -> Result<Option<String>> {
        Secrets::get(self, name)
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        Secrets::set(self, name, value)
    }
    fn delete(&self, name: &str) -> Result<()> {
        Secrets::delete(self, name)
    }
}

/// The head under `name`: "chunks:<n>" (chunks at `name#i`) or "chunks:<n>:<generation>" (chunks
/// at `name#<generation>.i`). A value short enough to fit is stored as is.
fn parse_head(head: &str) -> Option<(usize, Option<&str>)> {
    let rest = head.strip_prefix("chunks:")?;
    match rest.split_once(':') {
        Some((n, generation)) => Some((n.parse().ok()?, Some(generation))),
        None => Some((rest.parse().ok()?, None)),
    }
}

fn chunk_name(name: &str, generation: Option<&str>, i: usize) -> String {
    match generation {
        Some(g) => format!("{name}#{g}.{i}"),
        None => format!("{name}#{i}"),
    }
}

/// Writes the new chunks under a fresh generation first and switches the head to them only once
/// they are all stored, then removes the old ones. Interrupted at any point (the app closed, a
/// failed write), the stored value is the old one or the new one, never nothing: losing it would
/// sign the user out.
pub(crate) fn set_large(store: &impl Store, name: &str, value: &str) -> Result<()> {
    let _g = LARGE.lock().unwrap_or_else(|e| e.into_inner());
    const CHUNK: usize = 1200;
    let chars: Vec<char> = value.chars().collect();
    let chunks: Vec<String> = chars.chunks(CHUNK / 2).map(|c| c.iter().collect()).collect();
    let old = store.get(name)?;
    let generation = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    for (i, c) in chunks.iter().enumerate() {
        store.set(&chunk_name(name, Some(&generation), i), c)?;
    }
    store.set(name, &format!("chunks:{}:{generation}", chunks.len()))?;
    if let Some((n, g)) = old.as_deref().and_then(parse_head) {
        for i in 0..n {
            let _ = store.delete(&chunk_name(name, g, i));
        }
    }
    Ok(())
}

pub(crate) fn get_large(store: &impl Store, name: &str) -> Result<Option<String>> {
    let Some(head) = store.get(name)? else { return Ok(None) };
    let Some((n, generation)) = parse_head(&head) else { return Ok(Some(head)) };
    let mut out = String::new();
    for i in 0..n {
        match store.get(&chunk_name(name, generation, i))? {
            Some(c) => out.push_str(&c),
            None => return Ok(None),
        }
    }
    Ok(Some(out))
}

pub(crate) fn delete_large(store: &impl Store, name: &str) -> Result<()> {
    let _g = LARGE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((n, generation)) = store.get(name)?.as_deref().and_then(parse_head) {
        for i in 0..n {
            store.delete(&chunk_name(name, generation, i))?;
        }
    }
    store.delete(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Mem {
        map: RefCell<HashMap<String, String>>,
        /// Fail every write after this many (an interrupted save).
        writes_left: RefCell<Option<usize>>,
    }

    impl Store for Mem {
        fn get(&self, name: &str) -> Result<Option<String>> {
            Ok(self.map.borrow().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<()> {
            if let Some(n) = self.writes_left.borrow_mut().as_mut() {
                if *n == 0 {
                    return Err(Error::Keyring("interrupted".into()));
                }
                *n -= 1;
            }
            self.map.borrow_mut().insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<()> {
            self.map.borrow_mut().remove(name);
            Ok(())
        }
    }

    #[test]
    fn large_values_round_trip_and_replace_cleanly() {
        let m = Mem::default();
        let v1 = "a".repeat(2000);
        set_large(&m, "yt.cookie", &v1).unwrap();
        assert_eq!(get_large(&m, "yt.cookie").unwrap().as_deref(), Some(v1.as_str()));
        set_large(&m, "yt.cookie", "short").unwrap();
        assert_eq!(get_large(&m, "yt.cookie").unwrap().as_deref(), Some("short"));
        // Only the head and the current chunk are left.
        assert_eq!(m.map.borrow().len(), 2);
        delete_large(&m, "yt.cookie").unwrap();
        assert!(m.map.borrow().is_empty());
    }

    #[test]
    fn an_interrupted_save_keeps_the_old_value() {
        let m = Mem::default();
        let v1 = "old".repeat(500);
        set_large(&m, "yt.cookie", &v1).unwrap();
        *m.writes_left.borrow_mut() = Some(1);
        assert!(set_large(&m, "yt.cookie", &"new".repeat(500)).is_err());
        assert_eq!(get_large(&m, "yt.cookie").unwrap().as_deref(), Some(v1.as_str()));
    }

    #[test]
    fn reads_values_saved_by_older_versions() {
        let m = Mem::default();
        m.set("plex.session", "chunks:2").unwrap();
        m.set("plex.session#0", "{\"a\":").unwrap();
        m.set("plex.session#1", "1}").unwrap();
        assert_eq!(get_large(&m, "plex.session").unwrap().as_deref(), Some("{\"a\":1}"));
        set_large(&m, "plex.session", "{}").unwrap();
        assert!(m.get("plex.session#0").unwrap().is_none(), "old chunks removed");
        assert_eq!(get_large(&m, "plex.session").unwrap().as_deref(), Some("{}"));
    }
}
