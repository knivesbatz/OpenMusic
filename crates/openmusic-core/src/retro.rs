//! Windows 95 theme "time travel": with the theme on, the UI passes a cutoff date (today's date 28
//! years ago, moving a day each day) and the app only shows releases out by then. Artist pages
//! filter in the UI; What's New is built for the cutoff here.

/// Whether a release with this year and/or date ("YYYY-MM-DD", "YYYY-MM" or "YYYY") was out on
/// `cutoff` ("YYYY-MM-DD"). A partial date counts as the end of its month or year, so nothing is
/// shown before it can have come out. Releases with no date at all are kept.
pub fn released_by(year: Option<u32>, released: Option<&str>, cutoff: &str) -> bool {
    if let Some(r) = released.filter(|r| r.len() >= 4 && r.is_char_boundary(4)) {
        let full = match r.len() {
            4 => format!("{r}-12-31"),
            7 => format!("{r}-31"),
            _ => r.to_string(),
        };
        return full.as_str() <= cutoff;
    }
    match (year, cutoff_year(cutoff)) {
        (Some(y), Some(cy)) => y < cy,
        _ => true,
    }
}

/// The year of a "YYYY-MM-DD" cutoff.
pub fn cutoff_year(cutoff: &str) -> Option<u32> {
    cutoff.get(..4)?.parse().ok()
}

/// A well-formed "YYYY-MM-DD" date (what the UI sends).
pub fn valid_cutoff(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// Order for "newest first": the release date where known, else the year.
pub fn sort_key(year: Option<u32>, released: Option<&str>) -> String {
    match (released, year) {
        (Some(r), _) => r.to_string(),
        (None, Some(y)) => format!("{y:04}"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_releases_out_by_the_cutoff_are_kept() {
        let cut = "1998-11-03";
        assert!(released_by(None, Some("1998-11-03"), cut));
        assert!(released_by(None, Some("1998-10-30"), cut));
        assert!(!released_by(None, Some("1998-11-04"), cut));
        assert!(!released_by(Some(1995), Some("2001-01-01"), cut));
        // Partial dates count as their end: November 1998 might be after the 3rd.
        assert!(!released_by(None, Some("1998-11"), cut));
        assert!(released_by(None, Some("1998-10"), cut));
        assert!(!released_by(None, Some("1998"), cut));
        assert!(released_by(None, Some("1997"), cut));
        // A year alone: only earlier years are certainly out.
        assert!(released_by(Some(1997), None, cut));
        assert!(!released_by(Some(1998), None, cut));
        assert!(!released_by(Some(2024), None, cut));
        // No date: kept.
        assert!(released_by(None, None, cut));
        // The next day, a release from that day appears.
        assert!(released_by(None, Some("1998-11-04"), "1998-11-04"));
    }

    #[test]
    fn cutoffs_are_checked() {
        assert!(valid_cutoff("1998-11-03"));
        assert!(!valid_cutoff("1998-11-3"));
        assert!(!valid_cutoff("1998/11/03"));
        assert!(!valid_cutoff("abcd-ef-gh"));
        assert_eq!(cutoff_year("1998-11-03"), Some(1998));
    }
}
