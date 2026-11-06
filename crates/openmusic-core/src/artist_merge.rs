//! One artist page from several sources. With both providers on, an artist's page (Weezer) shows
//! YouTube Music's and Plex's songs and releases together, plus local files by the same name.
//! Artists are matched by an exact normalized name, never fuzzily; songs and releases are de-
//! duplicated by a normalized title. On a duplicate the copy that plays best is kept at the
//! position of the one it replaces: a local file over a Plex file over YouTube.

use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use icu_properties::CodePointMapData;

use crate::model::{Album, Artist, ArtistPage, Source, Track};

/// Letters that keep their look after NFD, spelled out; `&` reads as "and". As the UI's `FOLD`.
fn spell(c: char) -> Option<&'static str> {
    Some(match c {
        'æ' => "ae",
        'œ' => "oe",
        'ø' => "o",
        'ß' => "ss",
        'ł' => "l",
        'đ' | 'ð' => "d",
        'þ' => "th",
        'ı' => "i",
        '&' => " and ",
        _ => return None,
    })
}

/// Lowercase, Latin/Greek/Cyrillic diacritics dropped (NFD, then U+0300–U+036F removed, then NFC
/// again), a few letters spelled out, every run of anything but letters, digits and marks one
/// space. Exactly the UI's `artistKey` before its "The" rule (`ui/src/searchMerge.ts`). Marks
/// outside that block stay: "ガ" is not "カ".
fn fold(s: &str) -> String {
    let nfd = DecomposingNormalizerBorrowed::new_nfd().normalize(&s.to_lowercase()).into_owned();
    let bare: String = nfd.chars().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
    let nfc = ComposingNormalizerBorrowed::new_nfc().normalize(&bare).into_owned();
    let gc = CodePointMapData::<GeneralCategory>::new();
    let word = |c: char| {
        let g = gc.get(c);
        GeneralCategoryGroup::Letter.contains(g) || GeneralCategoryGroup::Number.contains(g) || GeneralCategoryGroup::Mark.contains(g)
    };
    let mut out = String::with_capacity(nfc.len());
    let mut space = true;
    let mut push = |c: char| {
        if word(c) {
            out.push(c);
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    };
    for c in nfc.chars() {
        match spell(c) {
            Some(piece) => piece.chars().for_each(&mut push),
            None => push(c),
        }
    }
    out.trim_end().to_string()
}

/// An artist name for matching across sources: case, diacritics and punctuation ignored, and a
/// leading "The" optional ("The Beatles" = "Beatles" = "the beatles"). Empty when nothing is left.
pub fn artist_key(name: &str) -> String {
    let f = fold(name);
    match f.strip_prefix("the ") {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => f,
    }
}

/// Words that make a bracketed or " - …" suffix another recording, so it stays in the title:
/// "(Live)", "(Taylor's Version)", "(Extended Version)", "(10 Minute Version)", "(Radio Edit)",
/// "(Piano Version)", "(2022 Mix)", "(Re-Recorded)".
const DISTINCT: &[&str] = &[
    "live", "remix", "acoustic", "instrumental", "demo", "karaoke", "unplugged", "taylor", "extended", "radio", "orchestral", "piano",
    "edit", "mix", "minute", "recorded", "rerecorded", "recording", "session", "sessions", "cover", "reprise", "dub", "rework",
];
/// Words of suffixes that only describe the release or a reissue.
const RELEASE_WORDS: &[&str] = &["single", "ep", "remaster", "remastered", "deluxe", "edition", "anniversary", "bonus", "expanded", "mono", "stereo", "explicit", "reissue"];
/// A suffix starting with one of these is a guest credit ("feat. Piano Man"): never a recording.
const FEAT: &[&str] = &["feat", "ft", "featuring"];

/// Whether a suffix ("Remastered 2022", "Deluxe Edition", "feat. X") only describes the release.
/// "Version" alone says nothing ("(Taylor's Version)", "(Single Version)" are other recordings),
/// but a release word beside it still counts ("(Deluxe Version)", "(Remastered Version)").
fn release_note(s: &str) -> bool {
    let f = fold(s);
    let words: Vec<&str> = f.split(' ').collect();
    if words.first().is_some_and(|w| FEAT.contains(w)) {
        return true;
    }
    let has = |list: &[&str]| words.iter().any(|w| list.contains(w));
    let other_cut = ["single", "mono", "stereo"].iter().any(|w| words.contains(w)) && words.contains(&"version");
    has(RELEASE_WORDS) && !has(DISTINCT) && !other_cut
}

/// A song or release title for de-duplication: trailing "(Remastered 2022)", "[Deluxe Edition]",
/// "- Single", "(feat. X)" and the like dropped (but not "(Live)", "(Remix)" or "(Blue Album)"),
/// then folded like a name.
pub fn title_key(title: &str) -> String {
    let mut t = title.trim();
    loop {
        let before = t;
        if let Some(open) = [('(', ')'), ('[', ']'), ('{', '}')].iter().find_map(|(o, c)| t.ends_with(*c).then(|| t.rfind(*o)).flatten()) {
            if open > 0 && release_note(&t[open + 1..t.len() - 1]) {
                t = t[..open].trim_end();
            }
        }
        if let Some(dash) = t.rfind(" - ") {
            if dash > 0 && release_note(&t[dash + 3..]) {
                t = t[..dash].trim_end();
            }
        }
        if t == before {
            break;
        }
    }
    fold(t)
}

/// Which copy of a duplicate to keep for playback, lower is better; also the item's source (two
/// items of one source are never duplicates of each other).
fn rank_id(id: &str) -> u8 {
    if id.starts_with("local") {
        0
    } else if id.starts_with("plex:") {
        1
    } else {
        2
    }
}

fn track_rank(t: &Track) -> u8 {
    match t.source {
        Source::Local => 0,
        Source::Plex => 1,
        Source::Youtube => 2,
    }
}

fn album_rank(a: &Album) -> u8 {
    rank_id(&a.id)
}

/// Add `items` to `lists[0]`, skipping duplicates (`same`) of items in `lists` from another source
/// (`rank`): one source's own items never count as duplicates of each other, however alike (Peter
/// Gabriel's four self-titled albums stay four). A duplicate that plays better takes the place of
/// the copy it duplicates.
fn place<T>(lists: &mut [&mut Vec<T>], items: Vec<T>, same: impl Fn(&T, &T) -> bool, rank: impl Fn(&T) -> u8) {
    for item in items {
        let r = rank(&item);
        let found = lists
            .iter()
            .enumerate()
            .find_map(|(li, l)| l.iter().position(|x| rank(x) != r && same(x, &item)).map(|p| (li, p)));
        match found {
            Some((li, p)) => {
                if r < rank(&lists[li][p]) {
                    lists[li][p] = item;
                }
            }
            None => lists[0].push(item),
        }
    }
}

/// The same release: equal titles (see [`title_key`]) and, when both have one, the same year.
fn same_album(a: &Album, b: &Album) -> bool {
    let k = title_key(&a.title);
    !k.is_empty() && k == title_key(&b.title) && (a.year.is_none() || b.year.is_none() || a.year == b.year)
}

/// Albums by other artists: the same title by another artist is another album.
fn same_appears(a: &Album, b: &Album) -> bool {
    same_album(a, b) && artist_key(&a.artist) == artist_key(&b.artist)
}

/// How far apart two copies of one recording may run.
const SAME_LENGTH_MS: u64 = 3000;

/// The same song: equal titles (see [`title_key`]) and, when both are known, lengths within 3 s.
fn same_track(a: &Track, b: &Track) -> bool {
    let k = title_key(&a.title);
    !k.is_empty()
        && k == title_key(&b.title)
        && match (a.duration_ms, b.duration_ms) {
            (Some(x), Some(y)) => x.abs_diff(y) <= SAME_LENGTH_MS,
            _ => true,
        }
}

/// Merge `other` (the same artist from another provider) into `primary`. The primary page keeps
/// its identity, artwork, description and followers (gaps are filled from the other) and its
/// order; the other's songs and releases that aren't duplicates follow. Local files are not part
/// of either page (see [`add_local`]).
pub fn merge_pages(mut primary: ArtistPage, other: ArtistPage) -> ArtistPage {
    match (&mut primary.artist, other.artist) {
        (Some(a), Some(o)) => {
            if a.artwork.is_none() {
                a.artwork = o.artwork;
            }
        }
        (a @ None, o) => *a = o,
        _ => {}
    }
    let blank = |s: &Option<String>| s.as_deref().is_none_or(|x| x.trim().is_empty());
    if blank(&primary.description) {
        primary.description = other.description;
    }
    if blank(&primary.followers) {
        primary.followers = other.followers;
    }
    place(&mut [&mut primary.top_tracks], other.top_tracks, same_track, track_rank);
    let ArtistPage { albums, singles, appears_on, .. } = &mut primary;
    place(&mut [albums, singles], other.albums, same_album, album_rank);
    place(&mut [singles, albums], other.singles, same_album, album_rank);
    place(&mut [appears_on], other.appears_on, same_appears, album_rank);
    let me = primary.artist.as_ref().map(|a| artist_key(&a.name)).unwrap_or_default();
    let mut seen: Vec<String> = primary.related.iter().map(|a| artist_key(&a.name)).collect();
    for a in other.related {
        let k = artist_key(&a.name);
        if k != me && !seen.contains(&k) {
            seen.push(k);
            primary.related.push(a);
        }
    }
    primary
}

/// Attach local files by this artist. A local copy of a song or release already on the page takes
/// its place (the user's own file plays first) and is not listed again; a slot a local file took
/// already is not taken again. The rest go to `local_tracks` / `local_albums`, which the page
/// blends in.
pub fn add_local(mut page: ArtistPage, tracks: Vec<Track>, albums: Vec<Album>) -> ArtistPage {
    let mut rest_t = Vec::new();
    for t in tracks {
        match page.top_tracks.iter().position(|x| x.source != Source::Local && same_track(x, &t)) {
            Some(p) => page.top_tracks[p] = t,
            None => rest_t.push(t),
        }
    }
    let mut rest_a = Vec::new();
    for a in albums {
        let hit = [&mut page.albums, &mut page.singles].into_iter().find_map(|l| {
            let p = l.iter().position(|x| album_rank(x) != 0 && same_album(x, &a))?;
            Some((l, p))
        });
        match hit {
            Some((l, p)) => l[p] = a,
            None => rest_a.push(a),
        }
    }
    page.local_tracks = rest_t;
    page.local_albums = rest_a;
    page
}

/// The artist among search results whose name matches `name` exactly (normalized). None when
/// several different artists have that name: which one is meant can't be told.
pub fn find_artist<'a>(candidates: impl IntoIterator<Item = &'a Artist>, name: &str) -> Option<&'a Artist> {
    let want = artist_key(name);
    if want.is_empty() {
        return None;
    }
    let mut hits = candidates.into_iter().filter(|a| artist_key(&a.name) == want);
    let first = hits.next()?;
    // The Top result is usually listed again among the artists.
    hits.all(|a| a.id == first.id).then_some(first)
}

/// Whether `other` is the artist of `page` and not just a namesake (Japan's Ghost is not Sweden's):
/// when both pages list songs or releases, at least one title is on both.
pub fn corroborated(page: &ArtistPage, other: &ArtistPage) -> bool {
    let titles = |p: &ArtistPage| -> Vec<String> {
        let songs = p.top_tracks.iter().chain(&p.local_tracks).map(|t| title_key(&t.title));
        let releases = p.albums.iter().chain(&p.singles).chain(&p.local_albums).map(|a| title_key(&a.title));
        songs.chain(releases).filter(|k| !k.is_empty()).collect()
    };
    let (mine, theirs) = (titles(page), titles(other));
    mine.is_empty() || theirs.is_empty() || mine.iter().any(|k| theirs.contains(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr(id: &str, title: &str) -> Track {
        let source = if id.starts_with("plex:") {
            Source::Plex
        } else if id.starts_with("yt:") {
            Source::Youtube
        } else {
            Source::Local
        };
        serde_json::from_value(serde_json::json!({ "id": id, "source": source, "title": title, "artist": "Weezer" })).unwrap()
    }
    fn al(id: &str, title: &str) -> Album {
        Album { id: id.into(), title: title.into(), artist: "Weezer".into(), artist_id: None, year: None, artwork: None, kind: None }
    }
    fn ar(id: &str, name: &str) -> Artist {
        Artist { id: id.into(), name: name.into(), artwork: None }
    }
    fn ids<T>(xs: &[T], id: impl Fn(&T) -> &str) -> Vec<String> {
        xs.iter().map(|x| id(x).to_string()).collect()
    }

    #[test]
    fn artist_names_match_exactly_after_normalizing() {
        assert_eq!(artist_key("Weezer"), artist_key("WEEZER"));
        assert_eq!(artist_key("The Beatles"), artist_key("Beatles"));
        assert_eq!(artist_key("Beyoncé"), artist_key("Beyonce"));
        assert_eq!(artist_key("Sigur Rós"), "sigur ros");
        assert_eq!(artist_key("AC/DC"), artist_key("AC-DC"));
        assert_eq!(artist_key("Simon & Garfunkel"), artist_key("Simon and Garfunkel"));
        assert_eq!(artist_key("  Guns N' Roses "), artist_key("Guns N Roses"));
        assert_eq!(artist_key("The The"), "the");
        assert_eq!(artist_key("宇多田ヒカル"), "宇多田ヒカル");
        // Exact only: no fuzzy matching.
        assert_ne!(artist_key("Weezer"), artist_key("Weezer Tribute Band"));
        assert_ne!(artist_key("Muse"), artist_key("Mused"));
        assert_eq!(artist_key("!!!"), "");
    }

    #[test]
    fn titles_lose_release_suffixes_but_not_versions() {
        assert_eq!(title_key("Buddy Holly (Remastered 2022)"), "buddy holly");
        assert_eq!(title_key("Buddy Holly - Single"), "buddy holly");
        assert_eq!(title_key("Weezer (Blue Album) [Deluxe Edition]"), "weezer blue album");
        assert_ne!(title_key("Weezer (Green Album)"), title_key("Weezer (Blue Album)"));
        assert_eq!(title_key("Undone (The Sweater Song) - 2004 Remaster"), "undone the sweater song");
        assert_eq!(title_key("Pinkerton (Deluxe)"), "pinkerton");
        assert_eq!(title_key("Say It Ain't So - Remastered 2004"), "say it ain t so");
        assert_eq!(title_key("Island in the Sun - EP"), "island in the sun");
        assert_eq!(title_key("Hash Pipe (feat. Someone)"), "hash pipe");
        assert_ne!(title_key("Buddy Holly (Live)"), title_key("Buddy Holly"));
        assert_ne!(title_key("Buddy Holly (Remix)"), title_key("Buddy Holly"));
        assert_ne!(title_key("Undone - The Sweater Song"), "undone");
        assert_eq!(title_key("Pinkerton (Deluxe Version)"), "pinkerton");
        assert_eq!(title_key("Buddy Holly (Remastered Version)"), "buddy holly");
        assert_eq!(title_key("Love Story (feat. Piano Man)"), "love story", "a guest credit is not a recording");
        // A title that is only brackets keeps them.
        assert_eq!(title_key("(Intro)"), "intro");
        assert_eq!(title_key("Beverly Hills"), "beverly hills");
    }

    #[test]
    fn versions_that_are_other_recordings_keep_their_suffix() {
        let distinct = [
            ("Love Story (Taylor's Version)", "Love Story"),
            ("Fearless (Taylor's Version)", "Fearless"),
            ("All Too Well (10 Minute Version) (Taylor's Version)", "All Too Well (Taylor's Version)"),
            ("Blue Monday (Extended Version)", "Blue Monday"),
            ("Song (Radio Version)", "Song"),
            ("Song (Orchestral Version)", "Song"),
            ("Song (Piano Version)", "Song"),
            ("Song (Japanese Version)", "Song"),
            ("Song (Single Version)", "Song"),
            ("Song - Single Version", "Song"),
            ("Song (Radio Edit)", "Song"),
            ("Song (Extended Mix) [Remastered]", "Song"),
            ("Song (Re-Recorded)", "Song"),
            ("Song (Deluxe Edition) [Live]", "Song"),
        ];
        for (a, b) in distinct {
            assert_ne!(title_key(a), title_key(b), "{a} / {b}");
        }
        assert_eq!(title_key("Love Story (Taylor's Version)"), "love story taylor s version");
        assert_eq!(title_key("Blue Monday (Extended Version)"), "blue monday extended version");
        // A release word on the outside still goes; the version stays.
        assert_eq!(title_key("Love Story (Taylor's Version) [Remastered]"), title_key("Love Story (Taylor's Version)"));
    }

    #[test]
    fn taylors_version_does_not_replace_the_original() {
        let yt = ArtistPage { top_tracks: vec![tr("yt:a", "Love Story (Taylor's Version)"), tr("yt:b", "Blue (Extended Version)")], ..Default::default() };
        let plex = ArtistPage { top_tracks: vec![tr("plex:1", "Love Story"), tr("plex:2", "Blue")], ..Default::default() };
        let m = merge_pages(yt, plex);
        assert_eq!(ids(&m.top_tracks, |t| &t.id), ["yt:a", "yt:b", "plex:1", "plex:2"]);
        let page = ArtistPage { top_tracks: vec![tr("yt:a", "Love Story (Taylor's Version)")], ..Default::default() };
        let m = add_local(page, vec![tr("local:1", "Love Story")], vec![]);
        assert_eq!(ids(&m.top_tracks, |t| &t.id), ["yt:a"]);
        assert_eq!(ids(&m.local_tracks, |t| &t.id), ["local:1"]);
    }

    #[test]
    fn same_titled_albums_of_one_source_all_stay() {
        let pg = |id: &str, year: Option<u32>| Album { year, artist: "Peter Gabriel".into(), ..al(id, "Peter Gabriel") };
        let gabriel = |prefix: &str| -> Vec<Album> { [1977, 1978, 1980, 1982].iter().map(|y| pg(&format!("{prefix}{y}"), Some(*y))).collect() };
        // YouTube lists one, without a year: one Plex album takes its place, the other three follow.
        let yt = ArtistPage { albums: vec![pg("yt:A", None), al("yt:So", "So")], ..Default::default() };
        let m = merge_pages(yt, ArtistPage { albums: gabriel("plex:"), ..Default::default() });
        assert_eq!(ids(&m.albums, |a| &a.id), ["plex:1977", "yt:So", "plex:1978", "plex:1980", "plex:1982"]);
        // YouTube's has a year: only Plex's album of that year is its duplicate.
        let yt = ArtistPage { albums: vec![pg("yt:A", Some(1980))], ..Default::default() };
        let m = merge_pages(yt, ArtistPage { albums: gabriel("plex:"), ..Default::default() });
        assert_eq!(ids(&m.albums, |a| &a.id), ["plex:1980", "plex:1977", "plex:1978", "plex:1982"]);
        // Plex primary with all four, and all four as local files: each local album takes its own year's slot.
        let page = ArtistPage { albums: gabriel("plex:"), ..Default::default() };
        let m = add_local(page, vec![], gabriel("local-album:"));
        assert_eq!(ids(&m.albums, |a| &a.id), ["local-album:1977", "local-album:1978", "local-album:1980", "local-album:1982"]);
        assert!(m.local_albums.is_empty());
        // Local files without years: each takes one slot, never one another's.
        let page = ArtistPage { albums: gabriel("plex:"), ..Default::default() };
        let m = add_local(page, vec![], vec![pg("local-album:a", None), pg("local-album:b", None)]);
        assert_eq!(ids(&m.albums, |a| &a.id), ["local-album:a", "local-album:b", "plex:1980", "plex:1982"]);
        assert!(m.local_albums.is_empty());
    }

    #[test]
    fn weezers_self_titled_albums_stay_distinct() {
        let w = |id: &str, title: &str, year: u32| Album { year: Some(year), ..al(id, title) };
        let yt = ArtistPage { albums: vec![w("yt:blue", "Weezer (Blue Album)", 1994), w("yt:green", "Weezer (Green Album)", 2001)], ..Default::default() };
        // Plex tagged with MusicBrainz titles: plain "Weezer" for each colour.
        let plex = ArtistPage {
            albums: vec![w("plex:1994", "Weezer", 1994), w("plex:2001", "Weezer", 2001), w("plex:2008", "Weezer", 2008), w("plex:2016", "Weezer", 2016)],
            ..Default::default()
        };
        let m = merge_pages(yt, plex);
        assert_eq!(ids(&m.albums, |a| &a.id), ["yt:blue", "yt:green", "plex:1994", "plex:2001", "plex:2008", "plex:2016"]);
        // Same titles, different years: different albums.
        let yt = ArtistPage { albums: vec![w("yt:2008", "Weezer", 2008)], ..Default::default() };
        let plex = ArtistPage { albums: vec![w("plex:1994", "Weezer", 1994), w("plex:2008", "Weezer", 2008)], ..Default::default() };
        let m = merge_pages(yt, plex);
        assert_eq!(ids(&m.albums, |a| &a.id), ["plex:2008", "plex:1994"]);
    }

    #[test]
    fn songs_of_one_title_differ_by_length() {
        let len = |id: &str, title: &str, secs: u64| Track { duration_ms: Some(secs * 1000), ..tr(id, title) };
        let yt = ArtistPage { top_tracks: vec![len("yt:a", "All Too Well", 329), len("yt:b", "Intro", 60)], ..Default::default() };
        let plex = ArtistPage { top_tracks: vec![len("plex:1", "All Too Well", 613), len("plex:2", "Intro", 62), tr("plex:3", "All Too Well")], ..Default::default() };
        let m = merge_pages(yt, plex);
        // 613 s is another recording; 62 s is the same; no length means the title decides.
        assert_eq!(ids(&m.top_tracks, |t| &t.id), ["plex:3", "plex:2", "plex:1"]);
        // Within one source both copies stay, even once the first is on the page.
        let other = ArtistPage { top_tracks: vec![len("plex:1", "Intro", 60), len("plex:2", "Intro", 60)], ..Default::default() };
        let m = merge_pages(ArtistPage { top_tracks: vec![len("yt:a", "Outro", 60)], ..Default::default() }, other);
        assert_eq!(ids(&m.top_tracks, |t| &t.id), ["yt:a", "plex:1", "plex:2"]);
    }

    #[test]
    fn namesakes_need_a_shared_title_to_merge() {
        let page = |tracks: &[&str], albums: &[&str]| ArtistPage {
            top_tracks: tracks.iter().enumerate().map(|(i, t)| tr(&format!("yt:{i}"), t)).collect(),
            albums: albums.iter().enumerate().map(|(i, t)| al(&format!("plex:{i}"), t)).collect(),
            ..Default::default()
        };
        let sweden = page(&["Square Hammer", "Mary on a Cross", "Intro"], &["Meliora"]);
        let japan = page(&["Hazy Paradise"], &["Lama Rabi Rabi", "Snuffbox Immanence"]);
        assert!(!corroborated(&sweden, &japan));
        let plex_ghost = page(&[], &["Meliora (Deluxe Edition)", "Impera"]);
        assert!(corroborated(&sweden, &plex_ghost), "a release on both");
        assert!(corroborated(&sweden, &page(&["Square Hammer - Single"], &[])), "a song on both");
        // Nothing to compare: an empty page contradicts nothing.
        assert!(corroborated(&sweden, &ArtistPage::default()));
        assert!(corroborated(&ArtistPage::default(), &japan));
    }

    #[test]
    fn find_artist_takes_an_exact_name_only() {
        let c = [ar("plex:1", "Weezer Tribute"), ar("plex:2", "weezer")];
        assert_eq!(find_artist(&c, "Weezer").map(|a| a.id.as_str()), Some("plex:2"));
        assert!(find_artist(&c[..1], "Weezer").is_none());
        assert!(find_artist(&c, "").is_none());
        // The Top result listed again is one artist; two Nirvanas are ambiguous.
        let top = ar("plex:2", "Weezer");
        assert_eq!(find_artist(std::iter::once(&top).chain(&c), "Weezer").map(|a| a.id.as_str()), Some("plex:2"));
        let two = [ar("yt:UC1", "Nirvana"), ar("yt:UC2", "Nirvana"), ar("yt:UC3", "Nirvana Tribute")];
        assert!(find_artist(&two, "Nirvana").is_none());
    }

    /// The same vector as `ui/src/searchMerge.test.ts` ("artistKey matches Rust's artist_key"): the
    /// UI hides a same-name artist only when this page merges it.
    const SHARED_ARTIST_KEYS: &[(&str, &str)] = &[
        ("Weezer", "weezer"),
        ("The Beatles", "beatles"),
        ("The The", "the"),
        ("Beyoncé", "beyonce"),
        ("Sigur Rós", "sigur ros"),
        ("Mötley Crüe", "motley crue"),
        ("Røyksopp", "royksopp"),
        ("Sơn Tùng M-TP", "son tung m tp"),
        ("Son Tung M-TP", "son tung m tp"),
        ("Đen Vâu", "den vau"),
        ("Simon & Garfunkel", "simon and garfunkel"),
        ("AC/DC", "ac dc"),
        ("  Guns N' Roses ", "guns n roses"),
        ("Beyonce\u{301}", "beyonce"),
        ("ガガガSP", "ガガガsp"),
        ("カカカSP", "カカカsp"),
        ("宇多田ヒカル", "宇多田ヒカル"),
        ("ΣΙΓΜΑΣ", "σιγμας"),
        ("Straße", "strasse"),
        ("!!!", ""),
    ];

    #[test]
    fn artist_keys_match_the_ui() {
        for (name, key) in SHARED_ARTIST_KEYS {
            assert_eq!(artist_key(name), *key, "{name}");
        }
    }

    #[test]
    fn merge_keeps_the_primary_order_and_prefers_plex_copies() {
        let yt = ArtistPage {
            artist: Some(ar("yt:UC1", "Weezer")),
            followers: Some("2M".into()),
            top_tracks: vec![tr("yt:a", "Buddy Holly"), tr("yt:b", "Say It Ain't So"), tr("yt:c", "Beverly Hills")],
            albums: vec![al("yt:A", "Weezer (Blue Album)"), al("yt:B", "Pinkerton"), al("yt:G", "Weezer (Green Album)")],
            singles: vec![al("yt:S", "Hash Pipe - Single")],
            appears_on: vec![Album { artist: "Various".into(), ..al("yt:X", "Hits") }],
            related: vec![ar("yt:r1", "Pixies"), ar("yt:r2", "Nada Surf")],
            ..Default::default()
        };
        let plex = ArtistPage {
            artist: Some(Artist { artwork: Some("art://plex/w".into()), ..ar("plex:9", "weezer") }),
            description: Some("Band from LA".into()),
            top_tracks: vec![tr("plex:1", "Say It Ain't So (Remastered)"), tr("plex:2", "Undone - The Sweater Song")],
            albums: vec![al("plex:B", "Pinkerton (Deluxe Edition)"), al("plex:M", "Maladroit"), al("plex:H", "Hash Pipe")],
            singles: vec![],
            appears_on: vec![Album { artist: "Other".into(), ..al("plex:X", "Hits") }],
            related: vec![ar("plex:r", "The Pixies"), ar("plex:me", "Weezer"), ar("plex:r3", "Rivers Cuomo")],
            ..Default::default()
        };
        let m = merge_pages(yt, plex);
        let a = m.artist.as_ref().unwrap();
        assert_eq!((a.id.as_str(), a.name.as_str()), ("yt:UC1", "Weezer"), "the primary identity stays");
        assert_eq!(a.artwork.as_deref(), Some("art://plex/w"), "missing artwork comes from the other page");
        assert_eq!(m.description.as_deref(), Some("Band from LA"));
        assert_eq!(m.followers.as_deref(), Some("2M"));
        assert_eq!(ids(&m.top_tracks, |t| &t.id), ["yt:a", "plex:1", "yt:c", "plex:2"], "Plex's copy plays, in YouTube's place");
        assert_eq!(ids(&m.albums, |x| &x.id), ["yt:A", "plex:B", "yt:G", "plex:M"]);
        assert_eq!(ids(&m.singles, |x| &x.id), ["plex:H"], "a release is listed once across albums and singles");
        assert_eq!(ids(&m.appears_on, |x| &x.id), ["yt:X", "plex:X"], "same title by different artists stays");
        assert_eq!(ids(&m.related, |x| &x.id), ["yt:r1", "yt:r2", "plex:r3"], "related by name, never the artist itself");
    }

    #[test]
    fn merge_keeps_youtube_copies_when_plex_is_primary() {
        let plex = ArtistPage { artist: Some(ar("plex:9", "Weezer")), top_tracks: vec![tr("plex:1", "Buddy Holly")], ..Default::default() };
        let yt = ArtistPage {
            artist: Some(Artist { artwork: Some("art://url/x".into()), ..ar("yt:UC1", "Weezer") }),
            followers: Some("2M".into()),
            top_tracks: vec![tr("yt:a", "Buddy Holly"), tr("yt:b", "Island in the Sun")],
            ..Default::default()
        };
        let m = merge_pages(plex, yt);
        assert_eq!(m.artist.as_ref().unwrap().id, "plex:9");
        assert_eq!(m.followers.as_deref(), Some("2M"));
        assert_eq!(ids(&m.top_tracks, |t| &t.id), ["plex:1", "yt:b"]);
    }

    #[test]
    fn local_files_replace_their_duplicates_and_list_the_rest() {
        let page = ArtistPage {
            artist: Some(ar("yt:UC1", "Weezer")),
            top_tracks: vec![tr("yt:a", "Buddy Holly"), tr("yt:b", "Say It Ain't So")],
            albums: vec![al("yt:A", "Pinkerton")],
            singles: vec![al("yt:S", "Hash Pipe - Single")],
            ..Default::default()
        };
        let tracks = vec![tr("local:1", "Say It Ain't So"), tr("local:2", "My Name Is Jonas"), tr("local:3", "My Name Is Jonas (Remastered)")];
        let albums = vec![al("local-album:Weezer\u{1f}Pinkerton (Deluxe)", "Pinkerton (Deluxe)"), al("local-album:Weezer\u{1f}Hash Pipe", "Hash Pipe"), al("local-album:Weezer\u{1f}Maladroit", "Maladroit")];
        let m = add_local(page, tracks, albums);
        assert_eq!(ids(&m.top_tracks, |t| &t.id), ["yt:a", "local:1"]);
        // Local files are never duplicates of each other: both Jonas files stay.
        assert_eq!(ids(&m.local_tracks, |t| &t.id), ["local:2", "local:3"]);
        assert_eq!(m.albums[0].id, "local-album:Weezer\u{1f}Pinkerton (Deluxe)");
        assert_eq!(m.singles[0].id, "local-album:Weezer\u{1f}Hash Pipe");
        assert_eq!(ids(&m.local_albums, |a| &a.id), ["local-album:Weezer\u{1f}Maladroit"]);
    }
}
