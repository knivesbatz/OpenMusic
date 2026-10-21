//! Plex Media Server integration using Plex's documented/public HTTP interfaces:
//! plex.tv PIN sign-in, `/api/v2/resources` server discovery, and the server's `/library`,
//! `/hubs/search`, `/playlists` and `/:/scrobble` endpoints. Responses are requested as JSON.
//!
//! PLEXSpot never writes to Plex playlists: app playlists live in SQLite (see `db.rs`).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::model::*;

pub const PRODUCT: &str = "PLEXSpot";
const PLEX_TV: &str = "https://plex.tv";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub id: u64,
    pub code: String,
    pub auth_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub uri: String,
    pub local: bool,
    pub relay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub name: String,
    pub client_identifier: String,
    pub access_token: String,
    pub owned: bool,
    pub connections: Vec<Connection>,
}

/// The active server connection. Stored (with tokens) in the credential store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub server: Server,
    pub uri: String,
    pub relay: bool,
    pub local: bool,
    /// Music library section keys on this server.
    pub sections: Vec<String>,
}

#[derive(Clone)]
pub struct Plex {
    http: reqwest::Client,
    client_id: String,
}

fn s(v: &Value, k: &str) -> Option<String> {
    match v.get(k)? {
        Value::String(x) if !x.is_empty() => Some(x.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}
fn n(v: &Value, k: &str) -> Option<u64> {
    match v.get(k)? {
        Value::Number(n) => n.as_u64(),
        Value::String(x) => x.parse().ok(),
        _ => None,
    }
}
fn art(path: Option<String>) -> Option<String> {
    path.map(|p| format!("art://plex{}", p))
}
fn items(mc: &Value) -> Vec<Value> {
    mc.get("MediaContainer")
        .and_then(|m| m.get("Metadata"))
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default()
}

pub fn to_track(v: &Value) -> Option<Track> {
    let rk = s(v, "ratingKey")?;
    let part = v
        .get("Media")
        .and_then(|m| m.get(0))
        .and_then(|m| m.get("Part"))
        .and_then(|p| p.get(0))
        .and_then(|p| s(p, "key"));
    // `originalTitle` is the track artist when it differs from the album artist.
    let artist = s(v, "originalTitle").or_else(|| s(v, "grandparentTitle")).unwrap_or_default();
    Some(Track {
        id: format!("plex:{rk}"),
        source: Source::Plex,
        title: s(v, "title").unwrap_or_default(),
        artist,
        artist_id: s(v, "grandparentRatingKey").map(|k| format!("plex:{k}")),
        album: s(v, "parentTitle"),
        album_id: s(v, "parentRatingKey").map(|k| format!("plex:{k}")),
        duration_ms: n(v, "duration"),
        artwork: art(s(v, "parentThumb").or_else(|| s(v, "thumb")).or_else(|| s(v, "grandparentThumb"))),
        stream_key: part,
        track_number: n(v, "index").map(|x| x as u32),
        explicit: false,
        episode: false,
    })
}

pub fn to_album(v: &Value) -> Option<Album> {
    let format = v
        .get("Format")
        .and_then(|f| f.get(0))
        .and_then(|f| s(f, "tag"))
        .or_else(|| s(v, "subformat"))
        .map(|f| f.to_lowercase());
    let kind = match format.as_deref() {
        Some(f) if f.contains("single") => "single",
        Some(f) if f.contains("ep") => "ep",
        Some(f) if f.contains("compilation") => "compilation",
        _ => "album",
    };
    Some(Album {
        id: format!("plex:{}", s(v, "ratingKey")?),
        title: s(v, "title").unwrap_or_default(),
        artist: s(v, "parentTitle").unwrap_or_default(),
        artist_id: s(v, "parentRatingKey").map(|k| format!("plex:{k}")),
        year: n(v, "year").map(|y| y as u32),
        artwork: art(s(v, "thumb")),
        kind: Some(kind.into()),
    })
}

pub fn to_artist(v: &Value) -> Option<Artist> {
    Some(Artist {
        id: format!("plex:{}", s(v, "ratingKey")?),
        name: s(v, "title").unwrap_or_default(),
        artwork: art(s(v, "thumb")),
    })
}

pub fn to_playlist(v: &Value) -> Option<Playlist> {
    Some(Playlist {
        id: format!("plex:{}", s(v, "ratingKey")?),
        title: s(v, "title").unwrap_or_default(),
        description: s(v, "summary"),
        artwork: art(s(v, "thumb").or_else(|| s(v, "composite"))),
        track_count: n(v, "leafCount").map(|c| c as u32),
        owner: Some("Plex".into()),
        local: false,
    })
}

fn to_item(v: &Value) -> Option<MediaItem> {
    match v.get("type")?.as_str()? {
        "track" => to_track(v).map(MediaItem::Track),
        "album" => to_album(v).map(MediaItem::Album),
        "artist" => to_artist(v).map(MediaItem::Artist),
        "playlist" => to_playlist(v).map(MediaItem::Playlist),
        _ => None,
    }
}

pub fn rating_key(id: &str) -> &str {
    id.trim_start_matches("plex:")
}

impl Plex {
    pub fn new(http: reqwest::Client, client_id: String) -> Self {
        Plex { http, client_id }
    }

    fn headers(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        rb.header("Accept", "application/json")
            .header("X-Plex-Client-Identifier", &self.client_id)
            .header("X-Plex-Product", PRODUCT)
            .header("X-Plex-Version", env!("CARGO_PKG_VERSION"))
            .header("X-Plex-Platform", "Windows")
            .header("X-Plex-Device-Name", PRODUCT)
    }

    // ---- sign-in -------------------------------------------------------------------------

    pub async fn pin_create(&self) -> Result<Pin> {
        let v: Value = self
            .headers(self.http.post(format!("{PLEX_TV}/api/v2/pins?strong=true")))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let id = n(&v, "id").ok_or_else(|| Error::Invalid("bad pin response".into()))?;
        let code = s(&v, "code").ok_or_else(|| Error::Invalid("bad pin response".into()))?;
        let auth_url = format!(
            "https://app.plex.tv/auth#?clientID={}&code={}&context%5Bdevice%5D%5Bproduct%5D={}",
            urlencoding::encode(&self.client_id),
            urlencoding::encode(&code),
            PRODUCT
        );
        Ok(Pin { id, code, auth_url })
    }

    /// `Ok(None)` while the user hasn't approved yet.
    pub async fn pin_check(&self, id: u64) -> Result<Option<String>> {
        let v: Value = self
            .headers(self.http.get(format!("{PLEX_TV}/api/v2/pins/{id}")))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(s(&v, "authToken"))
    }

    pub async fn account_name(&self, token: &str) -> Result<String> {
        let v: Value = self
            .headers(self.http.get(format!("{PLEX_TV}/api/v2/user")))
            .header("X-Plex-Token", token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(s(&v, "username").or_else(|| s(&v, "title")).unwrap_or_default())
    }

    pub async fn servers(&self, token: &str) -> Result<Vec<Server>> {
        let resp = self
            .headers(self.http.get(format!("{PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=1")))
            .header("X-Plex-Token", token)
            .send()
            .await?;
        if resp.status().as_u16() == 401 {
            return Err(Error::AuthExpired);
        }
        let v: Value = resp.error_for_status()?.json().await?;
        let mut out = Vec::new();
        for r in v.as_array().cloned().unwrap_or_default() {
            let provides = s(&r, "provides").unwrap_or_default();
            if !provides.split(',').any(|p| p == "server") {
                continue;
            }
            let connections = r
                .get("connections")
                .and_then(|c| c.as_array())
                .map(|cs| {
                    cs.iter()
                        .filter_map(|c| {
                            Some(Connection {
                                uri: s(c, "uri")?,
                                local: c.get("local").and_then(|x| x.as_bool()).unwrap_or(false),
                                relay: c.get("relay").and_then(|x| x.as_bool()).unwrap_or(false),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.push(Server {
                name: s(&r, "name").unwrap_or_default(),
                client_identifier: s(&r, "clientIdentifier").unwrap_or_default(),
                access_token: s(&r, "accessToken").unwrap_or_else(|| token.to_string()),
                owned: r.get("owned").and_then(|x| x.as_bool()).unwrap_or(false),
                connections,
            });
        }
        Ok(out)
    }

    /// Probe every connection concurrently and pick the best reachable one:
    /// local direct > remote direct > relay.
    pub async fn connect(&self, server: &Server) -> Result<Session> {
        let mut probes = Vec::new();
        for c in server.connections.clone() {
            let this = self.clone();
            let token = server.access_token.clone();
            probes.push(tokio::spawn(async move {
                let ok = this
                    .headers(this.http.get(format!("{}/identity", c.uri)))
                    .header("X-Plex-Token", token)
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false);
                (c, ok)
            }));
        }
        let mut reachable = Vec::new();
        for p in probes {
            if let Ok((c, true)) = p.await {
                reachable.push(c);
            }
        }
        reachable.sort_by_key(|c| (c.relay, !c.local));
        let best = reachable
            .into_iter()
            .next()
            .ok_or_else(|| Error::Offline(format!("{} is not reachable", server.name)))?;
        let mut session = Session {
            server: server.clone(),
            uri: best.uri.trim_end_matches('/').to_string(),
            relay: best.relay,
            local: best.local,
            sections: vec![],
        };
        let v = self.get(&session, "/library/sections").await?;
        session.sections = v
            .get("MediaContainer")
            .and_then(|m| m.get("Directory"))
            .and_then(|d| d.as_array())
            .map(|ds| {
                ds.iter()
                    .filter(|d| d.get("type").and_then(|t| t.as_str()) == Some("artist"))
                    .filter_map(|d| s(d, "key"))
                    .collect()
            })
            .unwrap_or_default();
        Ok(session)
    }

    // ---- server requests -----------------------------------------------------------------

    pub async fn get(&self, sess: &Session, path: &str) -> Result<Value> {
        let url = format!("{}{}", sess.uri, path);
        let resp = self
            .headers(self.http.get(&url))
            .header("X-Plex-Token", &sess.server.access_token)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| if e.is_connect() || e.is_timeout() { Error::Offline(e.to_string()) } else { e.into() })?;
        match resp.status().as_u16() {
            401 => Err(Error::AuthExpired),
            404 => Err(Error::NotFound(path.into())),
            _ => Ok(resp.error_for_status()?.json().await?),
        }
    }

    async fn list(&self, sess: &Session, path: &str) -> Result<Vec<Value>> {
        Ok(items(&self.get(sess, path).await?))
    }

    /// Fetch a whole (possibly huge) list in pages of 1000.
    async fn list_all(&self, sess: &Session, path: &str) -> Result<Vec<Value>> {
        let sep = if path.contains('?') { '&' } else { '?' };
        let mut out = Vec::new();
        let mut start = 0;
        loop {
            let v = self
                .get(sess, &format!("{path}{sep}X-Plex-Container-Start={start}&X-Plex-Container-Size=1000"))
                .await?;
            let page = items(&v);
            let total = v.get("MediaContainer").and_then(|m| n(m, "totalSize")).unwrap_or(0) as usize;
            let got = page.len();
            out.extend(page);
            start += got;
            if got == 0 || start >= total {
                break;
            }
        }
        Ok(out)
    }

    async fn per_section<T>(&self, sess: &Session, q: &str, f: fn(&Value) -> Option<T>) -> Vec<T> {
        let mut out = Vec::new();
        for sid in &sess.sections {
            if let Ok(list) = self.list(sess, &format!("/library/sections/{sid}/all?{q}")).await {
                out.extend(list.iter().filter_map(f));
            }
        }
        out
    }

    /// A cheap fingerprint of library content. When it is unchanged, cached library listings are
    /// still valid and no full re-sync is needed.
    pub async fn library_fingerprint(&self, sess: &Session) -> Result<String> {
        let v = self.get(sess, "/library/sections").await?;
        let mut fp = sess.server.client_identifier.clone();
        if let Some(ds) = v.get("MediaContainer").and_then(|m| m.get("Directory")).and_then(|d| d.as_array()) {
            for d in ds.iter().filter(|d| d.get("type").and_then(|t| t.as_str()) == Some("artist")) {
                fp.push_str(&format!(
                    "|{}:{}:{}",
                    s(d, "key").unwrap_or_default(),
                    s(d, "contentChangedAt").unwrap_or_default(),
                    s(d, "updatedAt").unwrap_or_default()
                ));
            }
        }
        Ok(fp)
    }

    pub async fn home(&self, sess: &Session) -> Result<Vec<Shelf>> {
        let mut shelves = Vec::new();
        let mk = |title: &str, items: Vec<MediaItem>| Shelf { title: title.into(), subtitle: None, items };
        let recent_albums =
            self.per_section(sess, "type=9&sort=lastViewedAt:desc&viewCount>>=0&X-Plex-Container-Size=20", to_album).await;
        shelves.push(mk("recentlyPlayed", recent_albums.into_iter().map(MediaItem::Album).collect()));
        let top_artists =
            self.per_section(sess, "type=8&sort=viewCount:desc&viewCount>>=0&X-Plex-Container-Size=20", to_artist).await;
        shelves.push(mk("yourTopArtists", top_artists.into_iter().map(MediaItem::Artist).collect()));
        let playlists = self.playlists(sess).await.unwrap_or_default();
        shelves.push(mk("plexPlaylists", playlists.into_iter().map(MediaItem::Playlist).collect()));
        let added = self.per_section(sess, "type=9&sort=addedAt:desc&X-Plex-Container-Size=20", to_album).await;
        shelves.push(mk("recentlyAdded", added.into_iter().map(MediaItem::Album).collect()));
        let rediscover = self
            .per_section(sess, "type=9&sort=lastViewedAt:asc&viewCount>>=2&X-Plex-Container-Size=20", to_album)
            .await;
        shelves.push(mk("rediscover", rediscover.into_iter().map(MediaItem::Album).collect()));
        let discover =
            self.per_section(sess, "type=9&sort=random&viewCount=0&X-Plex-Container-Size=20", to_album).await;
        shelves.push(mk("discover", discover.into_iter().map(MediaItem::Album).collect()));
        let liked =
            self.per_section(sess, "type=10&userRating>>=5&sort=lastRatedAt:desc&X-Plex-Container-Size=20", to_track).await;
        shelves.push(mk("liked", liked.into_iter().map(MediaItem::Track).collect()));
        shelves.retain(|s| !s.items.is_empty());
        Ok(shelves)
    }

    pub async fn search(&self, sess: &Session, q: &str) -> Result<SearchResults> {
        let mut out = SearchResults::default();
        let q = urlencoding::encode(q);
        for sid in &sess.sections {
            let v = self.get(sess, &format!("/hubs/search?query={q}&limit=20&sectionId={sid}")).await?;
            let hubs = v.get("MediaContainer").and_then(|m| m.get("Hub")).and_then(|h| h.as_array()).cloned();
            for hub in hubs.unwrap_or_default() {
                let list = hub.get("Metadata").and_then(|m| m.as_array()).cloned().unwrap_or_default();
                for it in &list {
                    match to_item(it) {
                        Some(MediaItem::Track(t)) => out.tracks.push(t),
                        Some(MediaItem::Album(a)) => out.albums.push(a),
                        Some(MediaItem::Artist(a)) => out.artists.push(a),
                        Some(MediaItem::Playlist(p)) => out.playlists.push(p),
                        _ => {}
                    }
                }
            }
        }
        out.top = out
            .artists
            .first()
            .cloned()
            .map(MediaItem::Artist)
            .or_else(|| out.albums.first().cloned().map(MediaItem::Album))
            .or_else(|| out.tracks.first().cloned().map(MediaItem::Track));
        Ok(out)
    }

    pub async fn artist(&self, sess: &Session, id: &str) -> Result<ArtistPage> {
        let rk = rating_key(id);
        let meta = self.list(sess, &format!("/library/metadata/{rk}")).await?;
        let artist_v = meta.first().ok_or_else(|| Error::NotFound(id.into()))?;
        let section = s(artist_v, "librarySectionID");
        let mut page = ArtistPage {
            artist: to_artist(artist_v),
            description: s(artist_v, "summary"),
            ..Default::default()
        };
        for a in self.list(sess, &format!("/library/metadata/{rk}/children")).await?.iter().filter_map(to_album) {
            match a.kind.as_deref() {
                Some("single") | Some("ep") => page.singles.push(a),
                Some("compilation") => page.appears_on.push(a),
                _ => page.albums.push(a),
            }
        }
        if let Some(sid) = section {
            // ratingCount is Plex's popularity signal; fall back to play count.
            let mut top = self
                .list(sess, &format!("/library/sections/{sid}/all?type=10&artist.id={rk}&sort=ratingCount:desc&X-Plex-Container-Size=10"))
                .await
                .unwrap_or_default();
            if top.is_empty() {
                top = self
                    .list(sess, &format!("/library/sections/{sid}/all?type=10&artist.id={rk}&sort=viewCount:desc&X-Plex-Container-Size=10"))
                    .await
                    .unwrap_or_default();
            }
            page.top_tracks = top.iter().filter_map(to_track).collect();
        }
        // Similar artists that exist in this library.
        if let Some(similar) = artist_v.get("Similar").and_then(|x| x.as_array()) {
            for sim in similar.iter().take(10) {
                if let Some(name) = s(sim, "tag") {
                    if let Some(sid) = sess.sections.first() {
                        let q = urlencoding::encode(&name);
                        if let Ok(found) = self.list(sess, &format!("/library/sections/{sid}/all?type=8&title={q}")).await {
                            page.related.extend(found.iter().filter_map(to_artist).take(1));
                        }
                    }
                }
            }
        }
        Ok(page)
    }

    pub async fn album(&self, sess: &Session, id: &str) -> Result<AlbumPage> {
        let rk = rating_key(id);
        let meta = self.list(sess, &format!("/library/metadata/{rk}")).await?;
        let album = meta.first().and_then(to_album).ok_or_else(|| Error::NotFound(id.into()))?;
        let tracks = self.list(sess, &format!("/library/metadata/{rk}/children")).await?;
        Ok(AlbumPage { album, tracks: tracks.iter().filter_map(to_track).collect() })
    }

    pub async fn playlists(&self, sess: &Session) -> Result<Vec<Playlist>> {
        Ok(self.list(sess, "/playlists?playlistType=audio").await?.iter().filter_map(to_playlist).collect())
    }

    pub async fn playlist(&self, sess: &Session, id: &str) -> Result<PlaylistPage> {
        let rk = rating_key(id);
        let meta = self.list(sess, &format!("/playlists/{rk}")).await?;
        let playlist = meta.first().and_then(to_playlist).ok_or_else(|| Error::NotFound(id.into()))?;
        let tracks = self.list_all(sess, &format!("/playlists/{rk}/items")).await?;
        Ok(PlaylistPage { playlist, tracks: tracks.iter().filter_map(to_track).collect() })
    }

    pub async fn library(&self, sess: &Session) -> Result<Library> {
        let mut lib = Library::default();
        for sid in &sess.sections {
            lib.artists.extend(
                self.list_all(sess, &format!("/library/sections/{sid}/all?type=8&sort=titleSort"))
                    .await?
                    .iter()
                    .filter_map(to_artist),
            );
            lib.albums.extend(
                self.list_all(sess, &format!("/library/sections/{sid}/all?type=9&sort=titleSort"))
                    .await?
                    .iter()
                    .filter_map(to_album),
            );
        }
        lib.playlists = self.playlists(sess).await.unwrap_or_default();
        Ok(lib)
    }

    /// Candidate tracks for import matching.
    pub async fn search_tracks(&self, sess: &Session, q: &str) -> Result<Vec<Track>> {
        let mut out = Vec::new();
        let q = urlencoding::encode(q);
        for sid in &sess.sections {
            out.extend(
                self.list(sess, &format!("/library/sections/{sid}/search?type=10&query={q}&X-Plex-Container-Size=25"))
                    .await?
                    .iter()
                    .filter_map(to_track),
            );
        }
        Ok(out)
    }

    /// Direct-play URL (original file) or a server-side transcode at `kbps`.
    pub fn stream_url(&self, sess: &Session, track: &Track, kbps: Option<u32>) -> Result<String> {
        let token = urlencoding::encode(&sess.server.access_token);
        match kbps {
            None => {
                let part = track.stream_key.as_deref().ok_or_else(|| Error::NotFound("media part".into()))?;
                Ok(format!("{}{}?X-Plex-Token={}", sess.uri, part, token))
            }
            Some(kbps) => {
                let path = urlencoding::encode(&format!("/library/metadata/{}", rating_key(&track.id))).into_owned();
                Ok(format!(
                    "{}/music/:/transcode/universal/start.mp3?path={path}&mediaIndex=0&partIndex=0&protocol=http\
                     &directPlay=0&directStream=0&musicBitrate={kbps}&maxAudioBitrate={kbps}&session={}\
                     &X-Plex-Platform=Chrome&X-Plex-Product={PRODUCT}&X-Plex-Client-Identifier={}&X-Plex-Token={token}",
                    sess.uri,
                    uuid::Uuid::new_v4().simple(),
                    urlencoding::encode(&self.client_id)
                ))
            }
        }
    }

    pub fn download_url(&self, sess: &Session, track: &Track) -> Result<String> {
        Ok(format!("{}&download=1", self.stream_url(sess, track, None)?))
    }

    pub fn art_url(&self, sess: &Session, path: &str, size: u32) -> String {
        format!(
            "{}/photo/:/transcode?width={size}&height={size}&minSize=1&upscale=1&url={}&X-Plex-Token={}",
            sess.uri,
            urlencoding::encode(path),
            urlencoding::encode(&sess.server.access_token)
        )
    }

    /// Mark played on the server (keeps Plex/Plexamp listening state in sync).
    pub async fn scrobble(&self, sess: &Session, id: &str) -> Result<()> {
        self.get(sess, &format!("/:/scrobble?identifier=com.plexapp.plugins.library&key={}", rating_key(id)))
            .await
            .map(|_| ())
            .or_else(|e| match e {
                // /:/scrobble answers with an empty body.
                Error::Http(ref he) if he.is_decode() => Ok(()),
                Error::Json(_) => Ok(()),
                e => Err(e),
            })
    }

    pub async fn rate(&self, sess: &Session, id: &str, liked: bool) -> Result<()> {
        let url = format!(
            "{}/:/rate?identifier=com.plexapp.plugins.library&key={}&rating={}",
            sess.uri,
            rating_key(id),
            if liked { 10 } else { -1 }
        );
        self.headers(self.http.put(url))
            .header("X-Plex-Token", &sess.server.access_token)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_track_metadata() {
        let v = json!({"ratingKey":"42","type":"track","title":"Song","grandparentTitle":"Band",
            "grandparentRatingKey":"7","parentTitle":"Record","parentRatingKey":"9","duration":215000,
            "parentThumb":"/library/metadata/9/thumb/1","index":3,
            "Media":[{"Part":[{"key":"/library/parts/100/file.flac"}]}]});
        let t = to_track(&v).unwrap();
        assert_eq!(t.id, "plex:42");
        assert_eq!(t.artist, "Band");
        assert_eq!(t.album_id.as_deref(), Some("plex:9"));
        assert_eq!(t.stream_key.as_deref(), Some("/library/parts/100/file.flac"));
        assert_eq!(t.artwork.as_deref(), Some("art://plex/library/metadata/9/thumb/1"));
        assert_eq!(t.track_number, Some(3));
    }

    #[test]
    fn track_artist_prefers_original_title() {
        let v = json!({"ratingKey":"1","title":"x","grandparentTitle":"Various Artists","originalTitle":"Real Artist"});
        assert_eq!(to_track(&v).unwrap().artist, "Real Artist");
    }

    #[test]
    fn album_kind_from_format() {
        let v = json!({"ratingKey":"1","title":"x","Format":[{"tag":"Single"}]});
        assert_eq!(to_album(&v).unwrap().kind.as_deref(), Some("single"));
        let v = json!({"ratingKey":"1","title":"x"});
        assert_eq!(to_album(&v).unwrap().kind.as_deref(), Some("album"));
    }

    #[test]
    fn stream_urls() {
        let p = Plex::new(reqwest::Client::new(), "cid".into());
        let sess = Session {
            server: Server { name: "s".into(), client_identifier: "m".into(), access_token: "tok".into(), owned: true, connections: vec![] },
            uri: "http://10.0.0.2:32400".into(),
            relay: false,
            local: true,
            sections: vec!["1".into()],
        };
        let t = to_track(&json!({"ratingKey":"5","title":"t","Media":[{"Part":[{"key":"/library/parts/1/f.mp3"}]}]})).unwrap();
        assert_eq!(p.stream_url(&sess, &t, None).unwrap(), "http://10.0.0.2:32400/library/parts/1/f.mp3?X-Plex-Token=tok");
        let tx = p.stream_url(&sess, &t, Some(128)).unwrap();
        assert!(tx.contains("musicBitrate=128") && tx.contains("path=%2Flibrary%2Fmetadata%2F5"));
    }
}
