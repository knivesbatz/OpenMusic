//! Lyrics from LRCLIB (https://lrclib.net), a free, open lyrics database with a public API.
//! Synchronized lyrics are only reported as synced when LRCLIB returns real LRC timestamps;
//! plain lyrics are never given invented timings.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::model::Track;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub time_ms: Option<u64>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub synced: bool,
    pub lines: Vec<Line>,
    pub source: String,
}

/// Parse LRC text. Lines with several timestamps (`[00:10.00][00:50.00]chorus`) expand into
/// several lines. Metadata tags like `[ar:...]` are ignored.
pub fn parse_lrc(lrc: &str) -> Vec<Line> {
    let mut out = Vec::new();
    for raw in lrc.lines() {
        let mut rest = raw.trim();
        let mut times = Vec::new();
        while rest.starts_with('[') {
            let Some(end) = rest.find(']') else { break };
            let tag = &rest[1..end];
            if let Some(t) = parse_ts(tag) {
                times.push(t);
            } else if times.is_empty() {
                // metadata tag line
                rest = "";
                break;
            }
            rest = &rest[end + 1..];
        }
        for t in times {
            out.push(Line { time_ms: Some(t), text: rest.trim().to_string() });
        }
    }
    out.sort_by_key(|l| l.time_ms);
    out
}

fn parse_ts(tag: &str) -> Option<u64> {
    let (m, s) = tag.split_once(':')?;
    let m: u64 = m.trim().parse().ok()?;
    let s: f64 = s.trim().parse().ok()?;
    Some(m * 60_000 + (s * 1000.0).round() as u64)
}

pub async fn fetch(http: &reqwest::Client, t: &Track) -> Result<Option<Lyrics>> {
    let artist = t.artist.split(", ").next().unwrap_or(&t.artist);
    let mut q: Vec<(&str, String)> = vec![("artist_name", artist.to_string()), ("track_name", t.title.clone())];
    if let Some(a) = &t.album {
        q.push(("album_name", a.clone()));
    }
    if let Some(d) = t.duration_ms {
        q.push(("duration", (d / 1000).to_string()));
    }
    let ua = concat!("OpenMusic/", env!("CARGO_PKG_VERSION"), " (https://github.com/knivesbatz/OpenMusic)");
    let resp = http
        .get("https://lrclib.net/api/get")
        .query(&q)
        .header("User-Agent", ua)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;
    let v: Option<Value> = if resp.status().is_success() {
        resp.json().await.ok()
    } else {
        // Exact lookup failed: fall back to search and take the first hit with lyrics.
        let list: Vec<Value> = http
            .get("https://lrclib.net/api/search")
            .query(&[("track_name", t.title.as_str()), ("artist_name", artist)])
            .header("User-Agent", ua)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?
            .json()
            .await
            .unwrap_or_default();
        list.into_iter().find(|x| x.get("syncedLyrics").and_then(|s| s.as_str()).is_some())
    };
    let Some(v) = v else { return Ok(None) };
    if let Some(synced) = v.get("syncedLyrics").and_then(|s| s.as_str()).filter(|s| !s.trim().is_empty()) {
        let lines = parse_lrc(synced);
        if !lines.is_empty() {
            return Ok(Some(Lyrics { synced: true, lines, source: "LRCLIB".into() }));
        }
    }
    if let Some(plain) = v.get("plainLyrics").and_then(|s| s.as_str()).filter(|s| !s.trim().is_empty()) {
        return Ok(Some(Lyrics {
            synced: false,
            lines: plain.lines().map(|l| Line { time_ms: None, text: l.to_string() }).collect(),
            source: "LRCLIB".into(),
        }));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lrc() {
        let l = parse_lrc("[ar:Someone]\n[00:12.50]Hello\n[01:02.00][00:30.00]Chorus\n");
        assert_eq!(
            l,
            vec![
                Line { time_ms: Some(12_500), text: "Hello".into() },
                Line { time_ms: Some(30_000), text: "Chorus".into() },
                Line { time_ms: Some(62_000), text: "Chorus".into() },
            ]
        );
    }
}
