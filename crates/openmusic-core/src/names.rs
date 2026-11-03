//! Localized artist names from MusicBrainz aliases (CC0 data). Used to show, for example, the
//! Japanese name of an English-language artist when the UI is in Japanese, and the English/Latin
//! name of a Japanese artist when the UI is in English. Provider metadata is never changed: the
//! UI shows the alias alongside the original, and results are cached in SQLite.

use std::time::{Duration, Instant};

use serde_json::Value;

use crate::error::{Error, Result};

const UA: &str = concat!("OpenMusic/", env!("CARGO_PKG_VERSION"), " ( https://github.com/knivesbatz/OpenMusic )");

/// MusicBrainz allows one request per second per client.
static LAST: tokio::sync::Mutex<Option<Instant>> = tokio::sync::Mutex::const_new(None);

fn lucene_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| if "+-&|!(){}[]^\"~*?:\\/".contains(c) { vec!['\\', c] } else { vec![c] })
        .collect()
}

/// Look up `name` and return its alias for `locale` ("ja" or "en"), if MusicBrainz has one.
pub async fn artist_alias(http: &reqwest::Client, name: &str, locale: &str) -> Result<Option<String>> {
    let query = format!("artist:\"{}\"", lucene_escape(name));
    let url = format!(
        "https://musicbrainz.org/ws/2/artist/?query={}&fmt=json&limit=3",
        urlencoding::encode(&query)
    );
    Ok(pick_alias(&get(http, &url).await?, name, locale))
}

/// Titles of the compilations (best-ofs, rarities, singles collections…) MusicBrainz lists for the
/// artist `name`. Providers like YouTube Music don't mark compilations, so the artist page uses
/// these to file albums under Compilations.
pub async fn compilation_titles(http: &reqwest::Client, name: &str) -> Result<Vec<String>> {
    let query = format!("artist:\"{}\" AND secondarytype:compilation", lucene_escape(name));
    let url = format!(
        "https://musicbrainz.org/ws/2/release-group/?query={}&fmt=json&limit=100",
        urlencoding::encode(&query)
    );
    Ok(pick_compilations(&get(http, &url).await?, name))
}

/// First release dates of the artist's release groups (albums, singles, EPs, compilations)
/// credited to exactly `name`, as (title, "YYYY-MM-DD" / "YYYY-MM" / "YYYY") pairs.
pub async fn release_dates(http: &reqwest::Client, name: &str) -> Result<Vec<(String, String)>> {
    let query = format!("artist:\"{}\"", lucene_escape(name));
    let url = format!(
        "https://musicbrainz.org/ws/2/release-group/?query={}&fmt=json&limit=100",
        urlencoding::encode(&query)
    );
    Ok(pick_release_dates(&get(http, &url).await?, name))
}

/// (title, first release date) of the release groups credited to exactly `artist`.
pub fn pick_release_dates(v: &Value, artist: &str) -> Vec<(String, String)> {
    let want = norm(artist);
    let Some(groups) = v.get("release-groups").and_then(|g| g.as_array()) else { return Vec::new() };
    groups
        .iter()
        .filter(|g| {
            let credit = g.get("artist-credit").and_then(|c| c.as_array());
            credit.map(|c| c.len() == 1 && c[0].get("name").and_then(|n| n.as_str()).map(norm).as_deref() == Some(want.as_str())).unwrap_or(false)
        })
        .filter_map(|g| {
            let title = g.get("title")?.as_str()?;
            let date = g.get("first-release-date")?.as_str()?;
            (date.len() >= 4).then(|| (title.to_string(), date.to_string()))
        })
        .collect()
}

/// Letters and digits only, lowercased: "山下 達郎" and "山下達郎", "YAMASHITA Tatsuro" and
/// "Yamashita Tatsuro" compare equal.
fn loose(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The MusicBrainz id of the artist called `name`: by name, sort name ("Yamashita, Tatsuro") or
/// alias, since many artists are filed under their native-script name (山下達郎).
pub async fn artist_mbid(http: &reqwest::Client, name: &str) -> Result<Option<String>> {
    let query = format!("\"{}\"", lucene_escape(name));
    let url = format!("https://musicbrainz.org/ws/2/artist/?query={}&fmt=json&limit=5", urlencoding::encode(&query));
    Ok(pick_artist_id(&get(http, &url).await?, name))
}

pub fn pick_artist_id(v: &Value, name: &str) -> Option<String> {
    let want = loose(name);
    let artists = v.get("artists")?.as_array()?;
    artists
        .iter()
        .filter(|a| a.get("score").and_then(|s| s.as_u64()).unwrap_or(0) >= 80)
        .find(|a| {
            let str_of = |k: &str| a.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
            let sort = str_of("sort-name");
            // "Yamashita, Tatsuro" -> "Tatsuro Yamashita"
            let flipped = sort.split_once(", ").map(|(last, first)| format!("{first} {last}")).unwrap_or_default();
            let aliases = a.get("aliases").and_then(|x| x.as_array()).cloned().unwrap_or_default();
            [str_of("name"), sort, flipped]
                .into_iter()
                .chain(aliases.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(str::to_string)))
                .any(|n| !n.is_empty() && loose(&n) == want)
        })
        .and_then(|a| a.get("id")?.as_str().map(str::to_string))
}

/// First release dates of all the artist's release groups (MusicBrainz id), as (title, date).
pub async fn release_group_dates(http: &reqwest::Client, mbid: &str) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for page in 0..3 {
        let url = format!("https://musicbrainz.org/ws/2/release-group?artist={}&limit=100&offset={}&fmt=json", urlencoding::encode(mbid), page * 100);
        let v = get(http, &url).await?;
        out.extend(dated(&v, "release-groups"));
        let total = v.get("release-group-count").and_then(|c| c.as_u64()).unwrap_or(0);
        if (page as u64 + 1) * 100 >= total {
            break;
        }
    }
    Ok(out)
}

/// First release dates of the artist's recordings with these titles (one search), as (title, date).
pub async fn recording_dates(http: &reqwest::Client, mbid: &str, titles: &[String]) -> Result<Vec<(String, String)>> {
    let phrases: Vec<String> = titles.iter().filter(|t| !t.trim().is_empty()).map(|t| format!("recording:\"{}\"", lucene_escape(t.trim()))).collect();
    if phrases.is_empty() {
        return Ok(Vec::new());
    }
    let query = format!("arid:{} AND ({})", mbid, phrases.join(" OR "));
    let url = format!("https://musicbrainz.org/ws/2/recording?query={}&fmt=json&limit=100", urlencoding::encode(&query));
    Ok(dated(&get(http, &url).await?, "recordings"))
}

/// (title, first-release-date) of each entry of `list` that has a date.
pub fn dated(v: &Value, list: &str) -> Vec<(String, String)> {
    let Some(items) = v.get(list).and_then(|g| g.as_array()) else { return Vec::new() };
    items
        .iter()
        .filter_map(|g| {
            let title = g.get("title")?.as_str()?;
            let date = g.get("first-release-date")?.as_str()?;
            (date.len() >= 4).then(|| (title.to_string(), date.to_string()))
        })
        .collect()
}

/// One MusicBrainz web service request, at most one per second (their rate limit).
async fn get(http: &reqwest::Client, url: &str) -> Result<Value> {
    {
        let mut last = LAST.lock().await;
        if let Some(t) = *last {
            let wait = Duration::from_millis(1100).saturating_sub(t.elapsed());
            tokio::time::sleep(wait).await;
        }
        *last = Some(Instant::now());
    }
    let resp = http
        .get(url)
        .header(reqwest::header::USER_AGENT, UA)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| if e.is_connect() || e.is_timeout() { Error::Offline(e.to_string()) } else { Error::Http(e) })?;
    if resp.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        return Err(Error::Offline("MusicBrainz rate limit".into()));
    }
    Ok(resp.error_for_status()?.json().await?)
}

/// Compilation titles from a release-group search, only those credited to exactly `artist` (not
/// tributes or various-artists collections it merely appears on).
pub fn pick_compilations(v: &Value, artist: &str) -> Vec<String> {
    let want = norm(artist);
    let Some(groups) = v.get("release-groups").and_then(|g| g.as_array()) else { return Vec::new() };
    groups
        .iter()
        .filter(|g| {
            g.get("secondary-types")
                .and_then(|t| t.as_array())
                .map(|t| t.iter().any(|x| x.as_str() == Some("Compilation")))
                .unwrap_or(false)
        })
        .filter(|g| {
            let credit = g.get("artist-credit").and_then(|c| c.as_array());
            credit.map(|c| c.len() == 1 && c[0].get("name").and_then(|n| n.as_str()).map(norm).as_deref() == Some(want.as_str())).unwrap_or(false)
        })
        .filter_map(|g| g.get("title").and_then(|t| t.as_str()).map(str::to_string))
        .collect()
}

/// True when the text contains kana or CJK ideographs.
pub fn has_japanese(s: &str) -> bool {
    s.chars().any(|c| matches!(c as u32, 0x3040..=0x30FF | 0x31F0..=0x31FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xFF66..=0xFF9F))
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Choose the alias for `locale` from a MusicBrainz artist search response. Only an artist whose
/// name (or one of its aliases) matches `name` exactly is trusted, so a fuzzy search hit never
/// renames someone else.
pub fn pick_alias(v: &Value, name: &str, locale: &str) -> Option<String> {
    let want = norm(name);
    let artists = v.get("artists")?.as_array()?;
    let artist = artists.iter().find(|a| {
        let score = a.get("score").and_then(|s| s.as_i64()).unwrap_or(0);
        let main = a.get("name").and_then(|n| n.as_str()).map(norm);
        let alias_match = a
            .get("aliases")
            .and_then(|x| x.as_array())
            .map(|xs| xs.iter().any(|x| x.get("name").and_then(|n| n.as_str()).map(norm).as_deref() == Some(want.as_str())))
            .unwrap_or(false);
        score >= 90 && (main.as_deref() == Some(want.as_str()) || alias_match)
    })?;
    let aliases = artist.get("aliases")?.as_array()?;
    let of_locale = |primary_only: bool| {
        aliases.iter().find(|x| {
            // Search hints are misspellings and abbreviations ("MCR"), never display names.
            x.get("type").and_then(|t| t.as_str()) != Some("Search hint") &&
            x.get("locale").and_then(|l| l.as_str()).map(|l| l == locale || l.starts_with(&format!("{locale}_"))).unwrap_or(false)
                && (!primary_only || x.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
        })
    };
    let alias = of_locale(true).or_else(|| of_locale(false))?;
    let out = alias.get("name")?.as_str()?.trim().to_string();
    (!out.is_empty() && norm(&out) != want).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        serde_json::json!({
            "artists": [
                { "id": "x", "score": 100, "name": "宇多田ヒカル", "sort-name": "Utada, Hikaru",
                  "aliases": [
                      { "name": "Utada Hikaru", "locale": "en", "primary": true, "type": "Artist name" },
                      { "name": "Hikki", "locale": null, "primary": null }
                  ] },
                { "id": "y", "score": 95, "name": "The Beatles",
                  "aliases": [ { "name": "ザ・ビートルズ", "locale": "ja", "primary": true } ] }
            ]
        })
    }

    #[test]
    fn finds_artists_filed_under_another_name() {
        let v = serde_json::json!({ "artists": [
            { "id": "other", "score": 100, "name": "Tatsuro Yamashita Tribute", "sort-name": "x" },
            { "id": "tatsu", "score": 100, "name": "山下達郎", "sort-name": "Yamashita, Tatsuro", "aliases": [{ "name": "YAMASHITA Tatsuro" }] }
        ]});
        assert_eq!(pick_artist_id(&v, "Tatsuro Yamashita").as_deref(), Some("tatsu"));
        assert_eq!(pick_artist_id(&v, "山下 達郎").as_deref(), Some("tatsu"));
        assert_eq!(pick_artist_id(&v, "Mariya Takeuchi"), None);
        let dates = serde_json::json!({ "recordings": [
            { "title": "SPARKLE", "first-release-date": "1982-01-21" },
            { "title": "Sparkle", "first-release-date": "2026-10-14" },
            { "title": "No date" }
        ]});
        assert_eq!(dated(&dates, "recordings").len(), 2);
    }

    #[test]
    fn release_dates_of_the_artists_own_releases() {
        let v = serde_json::json!({ "release-groups": [
            { "title": "Spacy", "first-release-date": "1976-06-25", "artist-credit": [{ "name": "Tatsuro Yamashita" }] },
            { "title": "For You", "first-release-date": "1982-01", "artist-credit": [{ "name": "tatsuro yamashita" }] },
            { "title": "Tribute", "first-release-date": "1999-01-01", "artist-credit": [{ "name": "Various Artists" }] },
            { "title": "Duet", "first-release-date": "1990", "artist-credit": [{ "name": "Tatsuro Yamashita" }, { "name": "Mariya Takeuchi" }] },
            { "title": "Undated", "first-release-date": "", "artist-credit": [{ "name": "Tatsuro Yamashita" }] }
        ]});
        assert_eq!(
            pick_release_dates(&v, "Tatsuro Yamashita"),
            vec![("Spacy".to_string(), "1976-06-25".to_string()), ("For You".to_string(), "1982-01".to_string())]
        );
    }

    #[test]
    fn picks_locale_alias_for_exact_match() {
        assert_eq!(pick_alias(&sample(), "宇多田ヒカル", "en").as_deref(), Some("Utada Hikaru"));
        assert_eq!(pick_alias(&sample(), "the beatles", "ja").as_deref(), Some("ザ・ビートルズ"));
    }

    #[test]
    fn ignores_non_matching_artists_and_missing_locales() {
        assert_eq!(pick_alias(&sample(), "Beatles Tribute Band", "ja"), None);
        assert_eq!(pick_alias(&sample(), "宇多田ヒカル", "ja"), None);
        // Matching through an alias name is accepted.
        assert_eq!(pick_alias(&sample(), "Hikki", "en").as_deref(), Some("Utada Hikaru"));
    }

    #[test]
    fn skips_search_hints() {
        let v = serde_json::json!({ "artists": [ { "score": 100, "name": "My Chemical Romance",
            "aliases": [ { "name": "MCR", "locale": "en", "primary": null, "type": "Search hint" } ] } ] });
        assert_eq!(pick_alias(&v, "My Chemical Romance", "en"), None);
        assert!(has_japanese("宇多田ヒカル") && !has_japanese("My Chemical Romance"));
    }

    #[test]
    fn compilations_credited_to_the_artist_only() {
        let v = serde_json::json!({ "release-groups": [
            { "title": "Death to False Metal", "primary-type": "Album", "secondary-types": ["Compilation"],
              "artist-credit": [ { "name": "Weezer" } ] },
            { "title": "Pinkerton", "primary-type": "Album", "artist-credit": [ { "name": "Weezer" } ] },
            { "title": "A Tribute to Weezer", "secondary-types": ["Compilation"], "artist-credit": [ { "name": "Various Artists" } ] },
            { "title": "Split", "secondary-types": ["Compilation"], "artist-credit": [ { "name": "Weezer" }, { "name": "Someone" } ] }
        ] });
        assert_eq!(pick_compilations(&v, "weezer"), vec!["Death to False Metal".to_string()]);
        assert!(pick_compilations(&serde_json::json!({}), "Weezer").is_empty());
    }

    #[test]
    fn escapes_lucene_syntax() {
        assert_eq!(lucene_escape("AC/DC (live)"), "AC\\/DC \\(live\\)");
    }
}
