//! Conservative cross-service track matching for playlist imports.
//!
//! A candidate is only accepted when title *and* artist agree after normalization and the
//! duration (when both sides know it) is close. Near-misses are reported as "ambiguous" for the
//! user to review instead of being imported, so an obviously different track is never
//! substituted silently.

use crate::model::Track;

#[derive(Debug, Clone)]
pub struct Wanted {
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Match(Track, f32),
    Ambiguous(Track, f32),
    NoMatch,
}

/// Lowercase, drop bracketed qualifiers ("(Remastered 2011)", "[Live]"), "feat." credits and
/// " - Remaster" style suffixes, and collapse punctuation. Keeps non-Latin letters intact so
/// Japanese titles still compare.
pub fn normalize(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for c in s.to_lowercase().chars() {
        match c {
            '(' | '[' | '（' | '【' => depth += 1,
            ')' | ']' | '）' | '】' => depth = (depth - 1).max(0),
            _ if depth > 0 => {}
            c if c.is_alphanumeric() => out.push(c),
            '&' => out.push_str(" and "),
            _ => out.push(' '),
        }
    }
    let mut s = format!(" {} ", out.split_whitespace().collect::<Vec<_>>().join(" "));
    for cut in [" feat ", " ft ", " featuring ", " remaster", " remastered", " live at ", " mono ", " stereo "] {
        if let Some(i) = s.find(cut) {
            s.truncate(i);
        }
    }
    s.trim().to_string()
}

fn tokens(s: &str) -> std::collections::HashSet<String> {
    normalize(s).split_whitespace().map(String::from).collect()
}

fn similarity(a: &str, b: &str) -> f32 {
    let (na, nb) = (normalize(a), normalize(b));
    if na.is_empty() || nb.is_empty() {
        return 0.0;
    }
    if na == nb {
        return 1.0;
    }
    let (ta, tb) = (tokens(a), tokens(b));
    let inter = ta.intersection(&tb).count() as f32;
    let union = ta.union(&tb).count() as f32;
    let jaccard = if union > 0.0 { inter / union } else { 0.0 };
    // CJK titles have no spaces; fall back to containment.
    if na.contains(&nb) || nb.contains(&na) {
        let (s, l) = if na.chars().count() < nb.chars().count() {
            (na.chars().count(), nb.chars().count())
        } else {
            (nb.chars().count(), na.chars().count())
        };
        return jaccard.max(s as f32 / l as f32 * 0.95);
    }
    jaccard
}

fn artist_score(wanted: &[String], cand: &str) -> f32 {
    let cn = normalize(cand);
    wanted
        .iter()
        .map(|w| {
            let wn = normalize(w);
            if wn.is_empty() || cn.is_empty() {
                0.0
            } else if cn == wn || cn.contains(&wn) || wn.contains(&cn) {
                1.0
            } else {
                similarity(w, cand)
            }
        })
        .fold(0.0, f32::max)
}

pub fn score(w: &Wanted, c: &Track) -> f32 {
    let title = similarity(&w.title, &c.title);
    let artist = artist_score(&w.artists, &c.artist);
    let mut s = title * 0.55 + artist * 0.35;
    match (w.duration_ms, c.duration_ms) {
        (Some(a), Some(b)) => {
            let diff = a.abs_diff(b);
            s += if diff <= 3000 {
                0.10
            } else if diff <= 8000 {
                0.05
            } else if diff > 30_000 {
                -0.30
            } else {
                -0.05
            }
        }
        _ => s += 0.03,
    }
    if let (Some(wa), Some(ca)) = (&w.album, &c.album) {
        if normalize(wa) == normalize(ca) {
            s += 0.05;
        }
    }
    // Hard requirements: both title and artist must broadly agree.
    if title < 0.6 || artist < 0.5 {
        s = s.min(0.5);
    }
    s.clamp(0.0, 1.0)
}

pub fn best_match(w: &Wanted, candidates: &[Track]) -> Verdict {
    let mut best: Option<(f32, &Track)> = None;
    for c in candidates.iter().filter(|c| !c.episode) {
        let s = score(w, c);
        if best.map(|(b, _)| s > b).unwrap_or(true) {
            best = Some((s, c));
        }
    }
    match best {
        Some((s, t)) if s >= 0.80 => Verdict::Match(t.clone(), s),
        Some((s, t)) if s >= 0.55 => Verdict::Ambiguous(t.clone(), s),
        _ => Verdict::NoMatch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Source;

    fn t(title: &str, artist: &str, dur: u64) -> Track {
        Track {
            id: format!("x:{title}:{artist}:{dur}"),
            source: Source::Plex,
            title: title.into(),
            artist: artist.into(),
            artist_id: None,
            album: None,
            album_id: None,
            duration_ms: Some(dur),
            artwork: None,
            stream_key: None,
            track_number: None,
            explicit: false,
            episode: false,
        }
    }
    fn w(title: &str, artist: &str, dur: u64) -> Wanted {
        Wanted { title: title.into(), artists: vec![artist.into()], album: None, duration_ms: Some(dur) }
    }

    #[test]
    fn normalization() {
        assert_eq!(normalize("Help! (Remastered 2009)"), "help");
        assert_eq!(normalize("Song - Remastered 2011"), "song");
        assert_eq!(normalize("Track (feat. X) [Live]"), "track");
        assert_eq!(normalize("Hello feat. Someone"), "hello");
        assert_eq!(normalize("残酷な天使のテーゼ"), "残酷な天使のテーゼ");
    }

    #[test]
    fn matches_remaster_variant() {
        let v = best_match(&w("Help!", "The Beatles", 138_000), &[t("Help! (Remastered 2009)", "The Beatles", 139_000)]);
        assert!(matches!(v, Verdict::Match(..)));
    }

    #[test]
    fn rejects_same_title_different_artist() {
        let v = best_match(&w("Hurt", "Nine Inch Nails", 373_000), &[t("Hurt", "Johnny Cash", 218_000)]);
        assert!(!matches!(v, Verdict::Match(..)));
    }

    #[test]
    fn rejects_different_track_same_artist() {
        let v = best_match(&w("Yesterday", "The Beatles", 125_000), &[t("Let It Be", "The Beatles", 243_000)]);
        assert_eq!(v, Verdict::NoMatch);
    }

    #[test]
    fn prefers_closest_duration() {
        let cands = [t("Song", "Band", 400_000), t("Song", "Band", 200_500)];
        match best_match(&w("Song", "Band", 200_000), &cands) {
            Verdict::Match(m, _) => assert_eq!(m.duration_ms, Some(200_500)),
            v => panic!("{v:?}"),
        }
    }

    #[test]
    fn big_duration_gap_is_not_confident() {
        // e.g. a 10-minute live version vs the 3-minute studio track
        let v = best_match(&w("Song", "Band", 180_000), &[t("Song", "Band", 600_000)]);
        assert!(!matches!(v, Verdict::Match(..)));
    }

    #[test]
    fn japanese_titles_match() {
        let v = best_match(&w("残酷な天使のテーゼ", "高橋洋子", 245_000), &[t("残酷な天使のテーゼ", "高橋洋子", 246_000)]);
        assert!(matches!(v, Verdict::Match(..)));
    }
}
