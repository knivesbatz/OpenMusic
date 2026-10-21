//! Spotify playlist import (metadata only — no Spotify audio is ever streamed).
//!
//! Uses the Authorization Code flow with PKCE against the official Web API, with a loopback
//! redirect (`http://127.0.0.1:43117/callback`). The user supplies the Client ID of their own
//! Spotify developer app, since Spotify requires every app to be registered.

use std::time::Duration;

use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{Error, Result};
use crate::matching::Wanted;

pub const REDIRECT_PORT: u16 = 43117;
pub const SCOPES: &str = "playlist-read-private playlist-read-collaborative";

pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{REDIRECT_PORT}/callback")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyPlaylist {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub track_count: u32,
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
}

pub fn pkce_pair() -> (String, String) {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn authorize_url(client_id: &str, challenge: &str, state: &str) -> String {
    format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&code_challenge_method=S256&code_challenge={}&state={}",
        urlencoding::encode(client_id),
        urlencoding::encode(SCOPES),
        urlencoding::encode(&redirect_uri()),
        challenge,
        state
    )
}

const OK_PAGE: &str = "<html><body style=\"font-family:sans-serif;background:#121212;color:#fff\"><h2>Spotify connected.</h2><p>You can close this tab and return to the app.</p></body></html>";
const FAIL_PAGE: &str = "<html><body style=\"font-family:sans-serif\"><h2>Spotify sign-in failed.</h2></body></html>";

/// Wait (up to 5 minutes) for the browser to hit the loopback redirect and return the code.
pub async fn wait_for_code(expected_state: &str) -> Result<String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).await?;
    let fut = async {
        loop {
            let (mut sock, _) = listener.accept().await?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await?;
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
            let url = url::Url::parse(&format!("http://localhost{path}")).ok();
            let get = |k: &str| url.as_ref().and_then(|u| u.query_pairs().find(|(q, _)| q == k).map(|(_, v)| v.to_string()));
            let (code, state, err) = (get("code"), get("state"), get("error"));
            let ok = code.is_some() && state.as_deref() == Some(expected_state);
            let body = if ok { OK_PAGE } else { FAIL_PAGE };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            if ok {
                return Ok::<String, Error>(code.unwrap());
            }
            if let Some(e) = err {
                return Err(Error::Invalid(format!("Spotify: {e}")));
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(300), fut).await.map_err(|_| Error::Cancelled)?
}

pub async fn exchange(http: &reqwest::Client, client_id: &str, code: &str, verifier: &str) -> Result<Token> {
    let v: Value = http
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &redirect_uri()),
            ("client_id", client_id),
            ("code_verifier", verifier),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    parse_token(&v)
}

pub async fn refresh(http: &reqwest::Client, client_id: &str, refresh_token: &str) -> Result<Token> {
    let v: Value = http
        .post("https://accounts.spotify.com/api/token")
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", client_id)])
        .send()
        .await?
        .error_for_status()
        .map_err(|_| Error::AuthExpired)?
        .json()
        .await?;
    let mut t = parse_token(&v)?;
    if t.refresh_token.is_none() {
        t.refresh_token = Some(refresh_token.into());
    }
    Ok(t)
}

fn parse_token(v: &Value) -> Result<Token> {
    Ok(Token {
        access_token: v.get("access_token").and_then(|x| x.as_str()).ok_or(Error::AuthExpired)?.into(),
        refresh_token: v.get("refresh_token").and_then(|x| x.as_str()).map(String::from),
        expires_at: crate::db::now() + v.get("expires_in").and_then(|x| x.as_i64()).unwrap_or(3600) - 60,
    })
}

async fn get_json(http: &reqwest::Client, token: &str, url: &str) -> Result<Value> {
    for _ in 0..3 {
        let r = http.get(url).bearer_auth(token).timeout(Duration::from_secs(20)).send().await?;
        match r.status().as_u16() {
            401 => return Err(Error::AuthExpired),
            404 => return Err(Error::NotFound(url.into())),
            429 => {
                let wait = r.headers().get("retry-after").and_then(|h| h.to_str().ok()).and_then(|s| s.parse().ok()).unwrap_or(2u64);
                tokio::time::sleep(Duration::from_secs(wait.min(30))).await;
            }
            _ => return Ok(r.error_for_status()?.json().await?),
        }
    }
    Err(Error::Offline("Spotify rate limit".into()))
}

pub async fn playlists(http: &reqwest::Client, token: &str) -> Result<Vec<SpotifyPlaylist>> {
    let mut out = Vec::new();
    let mut url = Some("https://api.spotify.com/v1/me/playlists?limit=50".to_string());
    while let Some(u) = url {
        let v = get_json(http, token, &u).await?;
        for p in v.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default() {
            if p.is_null() {
                continue;
            }
            let count = p
                .get("items")
                .or_else(|| p.get("tracks"))
                .and_then(|t| t.get("total"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0) as u32;
            out.push(SpotifyPlaylist {
                id: p.get("id").and_then(|x| x.as_str()).unwrap_or_default().into(),
                name: p.get("name").and_then(|x| x.as_str()).unwrap_or_default().into(),
                owner: p.get("owner").and_then(|o| o.get("display_name")).and_then(|x| x.as_str()).unwrap_or_default().into(),
                track_count: count,
                image: p.get("images").and_then(|i| i.get(0)).and_then(|i| i.get("url")).and_then(|x| x.as_str()).map(String::from),
            });
        }
        url = v.get("next").and_then(|n| n.as_str()).map(String::from);
    }
    Ok(out)
}

pub async fn playlist_tracks(http: &reqwest::Client, token: &str, id: &str) -> Result<Vec<Wanted>> {
    let mut out = Vec::new();
    // Spotify renamed the playlist "tracks" endpoint to "items"; try the new one first.
    let first_url = format!("https://api.spotify.com/v1/playlists/{id}/items?limit=100");
    let v = match get_json(http, token, &first_url).await {
        Ok(v) => v,
        Err(Error::AuthExpired) => return Err(Error::AuthExpired),
        Err(_) => get_json(http, token, &format!("https://api.spotify.com/v1/playlists/{id}/tracks?limit=100")).await?,
    };
    let mut page = Some(v);
    while let Some(v) = page {
        for it in v.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default() {
            let Some(t) = it.get("track").or_else(|| it.get("item")).filter(|t| !t.is_null()) else { continue };
            // Episodes have no catalog identity to match on.
            if t.get("type").and_then(|x| x.as_str()) == Some("episode") {
                continue;
            }
            out.push(Wanted {
                title: t.get("name").and_then(|x| x.as_str()).unwrap_or_default().into(),
                artists: t
                    .get("artists")
                    .and_then(|a| a.as_array())
                    .map(|a| a.iter().filter_map(|x| x.get("name")?.as_str().map(String::from)).collect())
                    .unwrap_or_default(),
                album: t.get("album").and_then(|a| a.get("name")).and_then(|x| x.as_str()).map(String::from),
                duration_ms: t.get("duration_ms").and_then(|x| x.as_u64()),
            });
        }
        page = match v.get("next").and_then(|n| n.as_str()) {
            Some(next) => Some(get_json(http, token, next).await?),
            None => None,
        };
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub title: String,
    pub artist: String,
    /// "imported" | "duplicate" | "ambiguous" | "skipped"
    pub status: String,
    pub matched: Option<crate::model::Track>,
    pub score: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub playlist_id: Option<String>,
    pub name: String,
    pub imported: usize,
    pub duplicates: usize,
    pub ambiguous: usize,
    pub skipped: usize,
    pub rows: Vec<ImportRow>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_sha256_of_verifier() {
        let (v, c) = pkce_pair();
        assert!(v.len() >= 43);
        let expect = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes()));
        assert_eq!(c, expect);
    }

    #[test]
    fn authorize_url_has_loopback_redirect() {
        let u = authorize_url("cid", "chal", "st");
        assert!(u.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A43117%2Fcallback"));
        assert!(u.contains("code_challenge_method=S256"));
    }
}
