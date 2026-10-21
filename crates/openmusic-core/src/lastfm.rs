//! Last.fm scrobbling (API 2.0, desktop auth flow).
//!
//! Scrobbles are written to a SQLite queue first (deduped on artist/track/timestamp) and flushed
//! in batches of up to 50, so a network failure or retry can never double-scrobble, and Last.fm
//! problems never touch playback. The API key/secret belong to the user's own Last.fm API account
//! and are kept in the OS credential store.

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};

const API: &str = "https://ws.audioscrobbler.com/2.0/";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Scrobble {
    pub artist: String,
    pub track: String,
    pub album: Option<String>,
    /// Unix seconds when playback started.
    pub timestamp: i64,
    /// Seconds.
    pub duration: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keys {
    pub api_key: String,
    pub secret: String,
}

/// Last.fm's rule: tracks longer than 30 s, scrobbled after half their length or 4 minutes.
pub fn should_scrobble(duration_ms: Option<u64>, played_ms: u64) -> bool {
    match duration_ms {
        Some(d) if d > 30_000 => played_ms >= (d / 2).min(240_000),
        Some(_) => false,
        None => played_ms >= 240_000,
    }
}

pub fn sign(params: &[(String, String)], secret: &str) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().filter(|(k, _)| k != "format" && k != "callback").collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut s = String::new();
    for (k, v) in sorted {
        s.push_str(k);
        s.push_str(v);
    }
    s.push_str(secret);
    hex::encode(Md5::digest(s.as_bytes()))
}

#[derive(Clone)]
pub struct LastFm {
    http: reqwest::Client,
    pub keys: Keys,
}

#[derive(Debug)]
pub enum CallError {
    /// Worth retrying later (network, server, rate limit).
    Temporary(String),
    /// Session invalid: the user must reconnect.
    Auth,
    Fatal(String),
}

impl LastFm {
    pub fn new(http: reqwest::Client, keys: Keys) -> Self {
        LastFm { http, keys }
    }

    async fn call(&self, method: &str, mut params: Vec<(String, String)>, signed: bool, post: bool) -> std::result::Result<Value, CallError> {
        params.push(("method".into(), method.into()));
        params.push(("api_key".into(), self.keys.api_key.clone()));
        if signed {
            let sig = sign(&params, &self.keys.secret);
            params.push(("api_sig".into(), sig));
        }
        params.push(("format".into(), "json".into()));
        let rb = if post { self.http.post(API).form(&params) } else { self.http.get(API).query(&params) };
        let resp = rb
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| CallError::Temporary(e.to_string()))?;
        let status = resp.status();
        let v: Value = resp.json().await.map_err(|e| CallError::Temporary(e.to_string()))?;
        if let Some(code) = v.get("error").and_then(|e| e.as_i64()) {
            let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
            return Err(match code {
                9 | 4 | 14 | 15 => CallError::Auth,
                8 | 11 | 16 | 29 => CallError::Temporary(msg),
                _ => CallError::Fatal(format!("{code}: {msg}")),
            });
        }
        if status.is_server_error() {
            return Err(CallError::Temporary(status.to_string()));
        }
        Ok(v)
    }

    /// Step 1: request a token and the URL where the user approves it.
    pub async fn get_token(&self) -> Result<(String, String)> {
        let v = self.call("auth.getToken", vec![], true, false).await.map_err(to_err)?;
        let token = v.get("token").and_then(|t| t.as_str()).ok_or_else(|| Error::Invalid("no token".into()))?.to_string();
        let url = format!("https://www.last.fm/api/auth/?api_key={}&token={}", self.keys.api_key, token);
        Ok((token, url))
    }

    /// Step 2: after approval, exchange the token for a permanent session key.
    pub async fn get_session(&self, token: &str) -> Result<(String, String)> {
        let v = self.call("auth.getSession", vec![("token".into(), token.into())], true, false).await.map_err(to_err)?;
        let s = v.get("session").ok_or_else(|| Error::Invalid("not approved yet".into()))?;
        Ok((
            s.get("key").and_then(|k| k.as_str()).unwrap_or_default().to_string(),
            s.get("name").and_then(|k| k.as_str()).unwrap_or_default().to_string(),
        ))
    }

    pub async fn now_playing(&self, sk: &str, s: &Scrobble) -> std::result::Result<(), CallError> {
        let mut p = vec![("artist".into(), s.artist.clone()), ("track".into(), s.track.clone()), ("sk".into(), sk.into())];
        if let Some(a) = &s.album {
            p.push(("album".into(), a.clone()));
        }
        if let Some(d) = s.duration {
            p.push(("duration".into(), d.to_string()));
        }
        self.call("track.updateNowPlaying", p, true, true).await.map(|_| ())
    }

    pub async fn scrobble_batch(&self, sk: &str, batch: &[Scrobble]) -> std::result::Result<(), CallError> {
        let mut p: Vec<(String, String)> = vec![("sk".into(), sk.into())];
        for (i, s) in batch.iter().enumerate().take(50) {
            p.push((format!("artist[{i}]"), s.artist.clone()));
            p.push((format!("track[{i}]"), s.track.clone()));
            p.push((format!("timestamp[{i}]"), s.timestamp.to_string()));
            if let Some(a) = &s.album {
                p.push((format!("album[{i}]"), a.clone()));
            }
            if let Some(d) = s.duration {
                p.push((format!("duration[{i}]"), d.to_string()));
            }
        }
        self.call("track.scrobble", p, true, true).await.map(|_| ())
    }
}

fn to_err(e: CallError) -> Error {
    match e {
        CallError::Temporary(m) => Error::Offline(m),
        CallError::Auth => Error::AuthExpired,
        CallError::Fatal(m) => Error::Invalid(m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrobble_threshold() {
        assert!(!should_scrobble(Some(20_000), 20_000));
        assert!(!should_scrobble(Some(200_000), 99_000));
        assert!(should_scrobble(Some(200_000), 100_000));
        // capped at 4 minutes for long tracks
        assert!(should_scrobble(Some(1_200_000), 240_000));
        assert!(!should_scrobble(None, 100_000));
    }

    #[test]
    fn signature_sorts_params_and_skips_format() {
        let p = vec![("b".to_string(), "2".to_string()), ("a".to_string(), "1".to_string()), ("format".to_string(), "json".to_string())];
        assert_eq!(sign(&p, "s"), hex::encode(Md5::digest(b"a1b2s")));
    }
}
