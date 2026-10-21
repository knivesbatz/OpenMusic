//! Credentials live in the Windows Credential Manager (via `keyring`), namespaced by the app
//! identifier so YTSpot and PLEXSpot never see each other's tokens. Nothing secret goes to SQLite.

use crate::error::{Error, Result};

pub struct Secrets {
    service: String,
}

impl Secrets {
    pub fn new(identifier: &str) -> Self {
        Secrets { service: identifier.to_string() }
    }

    fn entry(&self, name: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, name).map_err(|e| Error::Keyring(e.to_string()))
    }

    pub fn get(&self, name: &str) -> Result<Option<String>> {
        match self.entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Keyring(e.to_string())),
        }
    }

    pub fn set(&self, name: &str, value: &str) -> Result<()> {
        self.entry(name)?.set_password(value).map_err(|e| Error::Keyring(e.to_string()))
    }

    pub fn delete(&self, name: &str) -> Result<()> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Keyring(e.to_string())),
        }
    }

    pub fn get_json<T: serde::de::DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        Ok(self.get_large(name)?.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub fn set_json<T: serde::Serialize>(&self, name: &str, v: &T) -> Result<()> {
        self.set_large(name, &serde_json::to_string(v)?)
    }

    /// Windows credentials hold at most 2560 bytes, so larger values (cookie jars, server lists)
    /// are split across `name#0..n` with the chunk count stored under `name`.
    pub fn set_large(&self, name: &str, value: &str) -> Result<()> {
        const CHUNK: usize = 1200;
        let chars: Vec<char> = value.chars().collect();
        let chunks: Vec<String> = chars.chunks(CHUNK / 2).map(|c| c.iter().collect()).collect();
        self.delete_large(name)?;
        for (i, c) in chunks.iter().enumerate() {
            self.set(&format!("{name}#{i}"), c)?;
        }
        self.set(name, &format!("chunks:{}", chunks.len()))
    }

    pub fn get_large(&self, name: &str) -> Result<Option<String>> {
        let Some(head) = self.get(name)? else { return Ok(None) };
        let Some(n) = head.strip_prefix("chunks:").and_then(|n| n.parse::<usize>().ok()) else {
            return Ok(Some(head));
        };
        let mut out = String::new();
        for i in 0..n {
            match self.get(&format!("{name}#{i}"))? {
                Some(c) => out.push_str(&c),
                None => return Ok(None),
            }
        }
        Ok(Some(out))
    }

    pub fn delete_large(&self, name: &str) -> Result<()> {
        if let Some(head) = self.get(name)? {
            if let Some(n) = head.strip_prefix("chunks:").and_then(|n| n.parse::<usize>().ok()) {
                for i in 0..n {
                    self.delete(&format!("{name}#{i}"))?;
                }
            }
        }
        self.delete(name)
    }
}
