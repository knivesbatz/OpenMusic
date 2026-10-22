//! Machine translation of lyrics and titles into the UI language, through Google Translate's free
//! web endpoint (the one its browser widgets use; no account or API key). Every text is cached
//! in SQLite for a year, so a song's lyrics are translated once. Provider metadata is never
//! changed: the UI shows translations next to the originals.

use std::time::Duration;

use serde_json::Value;
use sha1::{Digest, Sha1};

use crate::error::{Error, Result};
use crate::state::AppState;

const ENDPOINT: &str = "https://translate.googleapis.com/translate_a/single";
/// Characters per request (the endpoint rejects very large bodies).
const CHUNK: usize = 3500;
const TTL: i64 = 365 * 86400;

fn cache_key(target: &str, text: &str) -> String {
    format!("tr:{target}:{}", hex::encode(Sha1::digest(text.as_bytes())))
}

/// Translations of `texts` into `target` ("en" or "ja"), aligned with the input: `None` where a
/// text is empty, already in the target language, or couldn't be translated.
pub async fn translate(state: &AppState, texts: &[String], target: &str) -> Result<Vec<Option<String>>> {
    let mut out: Vec<Option<String>> = vec![None; texts.len()];
    let mut todo: Vec<usize> = Vec::new();
    {
        let db = state.db();
        for (i, t) in texts.iter().enumerate() {
            if t.trim().is_empty() {
                continue;
            }
            // Cached as a string; "" records "nothing to translate".
            match db.cache_get::<String>(&cache_key(target, t), false)? {
                Some(c) => out[i] = Some(c).filter(|c| !c.is_empty()),
                None => todo.push(i),
            }
        }
    }
    // One request per chunk of lines; identical lines are sent once.
    let mut unique: Vec<&str> = Vec::new();
    for &i in &todo {
        let t = texts[i].trim();
        if !unique.contains(&t) {
            unique.push(t);
        }
    }
    // Google detects one source language per request: a batch mixing Japanese and Korean titles,
    // or English and Japanese lyric lines, came back partly untranslated. Send each script apart.
    let mut groups: Vec<(Script, Vec<&str>)> = Vec::new();
    for t in unique {
        let sc = script(t);
        match groups.iter_mut().find(|(g, _)| *g == sc) {
            Some((_, v)) => v.push(t),
            None => groups.push((sc, vec![t])),
        }
    }
    let mut found: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    for (_, group) in &groups {
        let mut start = 0;
        while start < group.len() {
            let mut end = start;
            let mut len = 0;
            while end < group.len() && (end == start || len + group[end].len() < CHUNK) {
                len += group[end].len() + 1;
                end += 1;
            }
            let batch = &group[start..end];
            let translated = request(&state.http, batch, target).await?;
            for (src, tr) in batch.iter().zip(translated) {
                found.insert(src, tr.unwrap_or_default());
            }
            start = end;
        }
    }
    let db = state.db();
    for i in todo {
        let tr = found.get(texts[i].trim()).cloned().unwrap_or_default();
        db.cache_put(&cache_key(target, &texts[i]), &tr, TTL)?;
        out[i] = Some(tr).filter(|t| !t.is_empty());
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Script {
    Japanese,
    Korean,
    Chinese,
    Cyrillic,
    Other,
}

/// The script that decides a text's language: kana means Japanese even next to kanji or Latin.
fn script(t: &str) -> Script {
    let has = |r: std::ops::RangeInclusive<u32>| t.chars().any(|c| r.contains(&(c as u32)));
    if has(0x3040..=0x30FF) || has(0xFF66..=0xFF9F) {
        Script::Japanese
    } else if has(0xAC00..=0xD7AF) || has(0x1100..=0x11FF) {
        Script::Korean
    } else if has(0x4E00..=0x9FFF) || has(0x3400..=0x4DBF) {
        Script::Chinese
    } else if has(0x0400..=0x04FF) {
        Script::Cyrillic
    } else {
        Script::Other
    }
}

/// Translate `lines`: Google first, then Microsoft's endpoint (the one Edge's built-in
/// translator uses) when Google refuses (it answers busy networks with a captcha page).
async fn request(http: &reqwest::Client, lines: &[&str], target: &str) -> Result<Vec<Option<String>>> {
    match google(http, lines, target).await {
        Ok(v) => Ok(v),
        Err(e) => {
            log::info!("translate: Google failed ({e}), trying Microsoft");
            microsoft(http, lines, target).await
        }
    }
}

fn net_err(e: reqwest::Error) -> Error {
    if e.is_connect() || e.is_timeout() { Error::Offline(e.to_string()) } else { Error::Http(e) }
}

/// Lines go newline-separated in one request and come back the same way.
async fn google(http: &reqwest::Client, lines: &[&str], target: &str) -> Result<Vec<Option<String>>> {
    let url = format!("{ENDPOINT}?client=gtx&sl=auto&tl={target}&dt=t");
    let resp = http.post(url).form(&[("q", lines.join("\n"))]).timeout(Duration::from_secs(10)).send().await.map_err(net_err)?;
    let v: Value = resp.error_for_status()?.json().await?;
    if let Some(out) = parse(&v, lines, target) {
        return Ok(out);
    }
    // Lines merged or split in the answer: translate them one by one instead (a few at a time).
    let mut out = Vec::with_capacity(lines.len());
    for chunk in lines.chunks(4) {
        let answers = futures_util::future::join_all(chunk.iter().map(|l| google_one(http, l, target))).await;
        for a in answers {
            out.push(a?);
        }
    }
    Ok(out)
}

async fn google_one(http: &reqwest::Client, line: &str, target: &str) -> Result<Option<String>> {
    let url = format!("{ENDPOINT}?client=gtx&sl=auto&tl={target}&dt=t");
    let resp = http.post(url).form(&[("q", line)]).timeout(Duration::from_secs(10)).send().await.map_err(net_err)?;
    let v: Value = resp.error_for_status()?.json().await?;
    Ok(parse(&v, &[line], target).and_then(|mut v| v.pop()).flatten())
}

async fn microsoft(http: &reqwest::Client, lines: &[&str], target: &str) -> Result<Vec<Option<String>>> {
    // Short-lived anonymous token (10 minutes), reused while fresh.
    static TOKEN: tokio::sync::Mutex<Option<(std::time::Instant, String)>> = tokio::sync::Mutex::const_new(None);
    let token = {
        let mut t = TOKEN.lock().await;
        match t.as_ref() {
            Some((at, tok)) if at.elapsed() < Duration::from_secs(480) => tok.clone(),
            _ => {
                let tok = http
                    .get("https://edge.microsoft.com/translate/auth")
                    .timeout(Duration::from_secs(10))
                    .send()
                    .await
                    .map_err(net_err)?
                    .error_for_status()?
                    .text()
                    .await?;
                *t = Some((std::time::Instant::now(), tok.clone()));
                tok
            }
        }
    };
    let body: Vec<Value> = lines.iter().map(|l| serde_json::json!({ "Text": l })).collect();
    let mut out = Vec::with_capacity(lines.len());
    for chunk in body.chunks(100) {
        let v: Value = http
            .post(format!("https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to={target}"))
            .bearer_auth(&token)
            .json(&chunk)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(net_err)?
            .error_for_status()?
            .json()
            .await?;
        let items = v.as_array().ok_or_else(|| Error::Invalid("unexpected translation response".into()))?;
        out.extend(items.iter().map(|it| parse_microsoft(it, target)));
    }
    if out.len() != lines.len() {
        return Ok(vec![None; lines.len()]);
    }
    Ok(out.into_iter().zip(lines).map(|(tr, orig)| tr.filter(|t| !t.eq_ignore_ascii_case(orig.trim()))).collect())
}

/// One item: `{"detectedLanguage": {"language": "ja"}, "translations": [{"text": "…"}]}`.
fn parse_microsoft(it: &Value, target: &str) -> Option<String> {
    let detected = it.pointer("/detectedLanguage/language").and_then(|l| l.as_str()).unwrap_or_default();
    if detected.split('-').next() == Some(target) {
        return None;
    }
    it.pointer("/translations/0/text").and_then(|t| t.as_str()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Pick the per-line translations out of the endpoint's response
/// (`[[["translated", "original", …], …], null, "detected-language", …]`).
/// `None` when the lines came back merged or split (never shift a translation onto the wrong line).
fn parse(v: &Value, lines: &[&str], target: &str) -> Option<Vec<Option<String>>> {
    let detected = v.get(2).and_then(|d| d.as_str()).unwrap_or_default();
    if detected.split('-').next() == Some(target) {
        return Some(vec![None; lines.len()]);
    }
    let segments = v.get(0).and_then(|s| s.as_array())?;
    let text: String = segments.iter().filter_map(|s| s.get(0).and_then(|t| t.as_str())).collect();
    let parts: Vec<&str> = text.split('\n').collect();
    if parts.len() != lines.len() {
        return None;
    }
    Some(parts
        .into_iter()
        .zip(lines)
        .map(|(tr, orig)| {
            let tr = tr.trim();
            (!tr.is_empty() && !tr.eq_ignore_ascii_case(orig.trim())).then(|| tr.to_string())
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_line_by_line() {
        let v = json!([[["Under the night sky\n", "夜空の下で\n", null], ["Hello", "Hello", null]], null, "ja"]);
        assert_eq!(parse(&v, &["夜空の下で", "Hello"], "en"), Some(vec![Some("Under the night sky".to_string()), None]));
    }

    #[test]
    fn parses_microsoft_items() {
        let ja = json!({ "detectedLanguage": { "language": "ja", "score": 1.0 }, "translations": [{ "text": "Song of Dawn", "to": "en" }] });
        assert_eq!(parse_microsoft(&ja, "en").as_deref(), Some("Song of Dawn"));
        let en = json!({ "detectedLanguage": { "language": "en" }, "translations": [{ "text": "Hello" }] });
        assert_eq!(parse_microsoft(&en, "en"), None);
    }

    #[test]
    fn same_language_or_shifted_lines_give_nothing() {
        let same = json!([[["Hi\n", "Hi\n"], ["there", "there"]], null, "en"]);
        assert_eq!(parse(&same, &["Hi", "there"], "en"), Some(vec![None, None]));
        let merged = json!([[["One line only", "a\nb"]], null, "ja"]);
        assert_eq!(parse(&merged, &["a", "b"], "en"), None, "merged lines are retried one by one");
    }

    #[test]
    fn groups_by_script() {
        assert_eq!(script("スローモーション - 2012 Remaster"), Script::Japanese);
        assert_eq!(script("北ウイング"), Script::Japanese);
        assert_eq!(script("夜空"), Script::Chinese);
        assert_eq!(script("밤편지"), Script::Korean);
        assert_eq!(script("Hello"), Script::Other);
    }
}
