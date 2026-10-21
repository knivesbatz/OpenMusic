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

/// Lyrics text that came with the track (a .lrc file, a tag, a Plex lyrics stream): LRC
/// timestamps make it synced, anything else is plain.
pub fn from_text(text: &str, source: &str) -> Option<Lyrics> {
    if text.trim().is_empty() {
        return None;
    }
    let synced = parse_lrc(text);
    if synced.len() > 1 {
        return Some(Lyrics { synced: true, lines: synced, source: source.into() });
    }
    Some(Lyrics { synced: false, lines: text.lines().map(|l| Line { time_ms: None, text: l.trim_end().to_string() }).collect(), source: source.into() })
}

const UA: &str = concat!("OpenMusic/", env!("CARGO_PKG_VERSION"), " (https://github.com/knivesbatz/OpenMusic)");

/// Title without release decorations that lyric databases don't carry: " - 2006 Remaster",
/// "(Remastered 2011)", "(feat. X)", "[Live]", "(Radio Edit)", "(Mono)". Real title words stay.
pub fn clean_title(title: &str) -> String {
    const NOISE: [&str; 11] = ["remaster", "live", "version", "edit", "mono", "stereo", "feat", "ft.", "bonus", "deluxe", "instrumental"];
    let noisy = |s: &str| {
        let l = s.to_lowercase();
        NOISE.iter().any(|n| l.contains(n))
    };
    let mut out = String::new();
    let mut depth = 0;
    let mut group = String::new();
    for c in title.chars() {
        match c {
            '(' | '[' => {
                depth += 1;
                group.push(c);
            }
            ')' | ']' if depth > 0 => {
                depth -= 1;
                group.push(c);
                if depth == 0 {
                    if !noisy(&group) {
                        out.push_str(&group);
                    }
                    group.clear();
                }
            }
            _ if depth > 0 => group.push(c),
            _ => out.push(c),
        }
    }
    out.push_str(&group);
    if let Some((head, tail)) = out.rsplit_once(" - ") {
        if noisy(tail) {
            out = head.to_string();
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn from_lrclib(v: &Value) -> (Option<Lyrics>, Option<Lyrics>) {
    let synced = v
        .get("syncedLyrics")
        .and_then(|s| s.as_str())
        .map(parse_lrc)
        .filter(|l| !l.is_empty())
        .map(|lines| Lyrics { synced: true, lines, source: "LRCLIB".into() });
    let plain = v.get("plainLyrics").and_then(|s| s.as_str()).filter(|s| !s.trim().is_empty()).map(|p| Lyrics {
        synced: false,
        lines: p.lines().map(|l| Line { time_ms: None, text: l.to_string() }).collect(),
        source: "LRCLIB".into(),
    });
    (synced, plain)
}

async fn lrclib_get(http: &reqwest::Client, artist: &str, title: &str, album: Option<&str>, dur: Option<u64>) -> Option<Value> {
    let mut q: Vec<(&str, String)> = vec![("artist_name", artist.to_string()), ("track_name", title.to_string())];
    if let Some(a) = album {
        q.push(("album_name", a.to_string()));
    }
    if let Some(d) = dur {
        q.push(("duration", d.to_string()));
    }
    let r = http.get("https://lrclib.net/api/get").query(&q).header("User-Agent", UA).timeout(std::time::Duration::from_secs(10)).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json().await.ok()
}

async fn lrclib_search(http: &reqwest::Client, query: &[(&str, &str)]) -> Vec<Value> {
    let Ok(r) = http.get("https://lrclib.net/api/search").query(query).header("User-Agent", UA).timeout(std::time::Duration::from_secs(10)).send().await else {
        return Vec::new();
    };
    r.json().await.unwrap_or_default()
}

/// The synced result closest to the track's length (within 5 s when the length is known).
fn best_synced(list: &[Value], dur: Option<u64>) -> Option<Lyrics> {
    list.iter()
        .filter_map(|v| {
            let (synced, _) = from_lrclib(v);
            let d = v.get("duration").and_then(|d| d.as_f64()).map(|d| d.round() as u64);
            let off = match (dur, d) {
                (Some(a), Some(b)) => a.abs_diff(b),
                _ => 0,
            };
            synced.filter(|_| off <= 5).map(|l| (off, l))
        })
        .min_by_key(|(off, _)| *off)
        .map(|(_, l)| l)
}

/// NetEase Cloud Music's public endpoints (no key): wide coverage of synced lyrics, especially
/// for Japanese, Chinese and Korean songs.
async fn netease(http: &reqwest::Client, artist: &str, title: &str, dur: Option<u64>) -> Option<Lyrics> {
    let search: Value = http
        .get("https://music.163.com/api/search/get")
        .query(&[("s", format!("{artist} {title}")), ("type", "1".into()), ("limit", "8".into())])
        .header("Referer", "https://music.163.com/")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let songs = search.pointer("/result/songs")?.as_array()?;
    let want_title = clean_title(title).to_lowercase();
    let id = songs
        .iter()
        .filter(|s| {
            let name = s.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_lowercase();
            let d = s.get("duration").and_then(|d| d.as_u64()).map(|ms| ms / 1000);
            let len_ok = match (dur, d) {
                (Some(a), Some(b)) => a.abs_diff(b) <= 5,
                _ => true,
            };
            len_ok && (name.contains(&want_title) || want_title.contains(&name))
        })
        .find_map(|s| s.get("id").and_then(|i| i.as_u64()))?;
    let lyric: Value = http
        .get("https://music.163.com/api/song/lyric")
        .query(&[("id", id.to_string()), ("lv", "1".into())])
        .header("Referer", "https://music.163.com/")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let lines = parse_lrc(lyric.pointer("/lrc/lyric")?.as_str()?);
    // Instrumentals come back as a single "pure music" line.
    (lines.len() > 2).then_some(Lyrics { synced: true, lines, source: "NetEase Cloud Music".into() })
}

/// Synced lyrics from LRCLIB (exact match, then the title without release decorations, then a
/// search matched by length) or NetEase; plain lyrics only when nobody has synced ones.
pub async fn fetch(http: &reqwest::Client, t: &Track) -> Result<Option<Lyrics>> {
    let artist = t.artist.split(", ").next().unwrap_or(&t.artist).trim().to_string();
    let dur = t.duration_ms.map(|d| d / 1000);
    let clean = clean_title(&t.title);
    let mut plain = None;

    if let Some(v) = lrclib_get(http, &artist, &t.title, t.album.as_deref(), dur).await {
        let (synced, p) = from_lrclib(&v);
        if synced.is_some() {
            return Ok(synced);
        }
        plain = p;
    }
    if clean != t.title {
        if let Some(v) = lrclib_get(http, &artist, &clean, None, dur).await {
            let (synced, p) = from_lrclib(&v);
            if synced.is_some() {
                return Ok(synced);
            }
            plain = plain.or(p);
        }
    }
    let found = lrclib_search(http, &[("track_name", clean.as_str()), ("artist_name", artist.as_str())]).await;
    if let Some(l) = best_synced(&found, dur) {
        return Ok(Some(l));
    }
    if let Some(l) = netease(http, &artist, &t.title, dur).await {
        return Ok(Some(l));
    }
    let q = format!("{artist} {clean}");
    let found = lrclib_search(http, &[("q", q.as_str())]).await;
    if let Some(l) = best_synced(&found, dur) {
        return Ok(Some(l));
    }
    Ok(plain.or_else(|| found.iter().find_map(|v| from_lrclib(v).1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_release_decorations_only() {
        assert_eq!(clean_title("A Night like This - 2006 Remaster"), "A Night like This");
        assert_eq!(clean_title("Song (Remastered 2011)"), "Song");
        assert_eq!(clean_title("Song (feat. Someone) [Live]"), "Song");
        assert_eq!(clean_title("Love (Is All You Need)"), "Love (Is All You Need)");
        assert_eq!(clean_title("時 - instrumental"), "時");
        assert_eq!(clean_title("Rock - Paper - Scissors"), "Rock - Paper - Scissors");
    }

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
