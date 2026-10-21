//! Discord Rich Presence: "Listening to YTSpot/PLEXSpot" with the song, artist, artwork and a
//! progress bar, through the local Discord client's IPC socket. Nothing to set up for users: the
//! Discord application ids are baked in at build time (`DISCORD_CLIENT_ID_YTSPOT`,
//! `DISCORD_CLIENT_ID_PLEXSPOT`, or one shared `DISCORD_CLIENT_ID`), and when Discord isn't
//! running the worker quietly retries now and then.
//!
//! Artwork must be a public https URL. YouTube thumbnails already are; Plex and local artwork
//! would need a server token, so those use the album cover from the public iTunes Search API
//! (no key) and otherwise the app icon. Tokens never leave the app.

use crate::state::Flavor;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;
/// How often to look for Discord again while something is playing and it isn't connected.
const RETRY: Duration = Duration::from_secs(20);

/// The baked-in Discord application id for this app, if the build had one.
pub fn client_id(f: Flavor) -> Option<&'static str> {
    let own = match f {
        Flavor::YouTube => option_env!("DISCORD_CLIENT_ID_YTSPOT"),
        Flavor::Plex => option_env!("DISCORD_CLIENT_ID_PLEXSPOT"),
    };
    own.or(option_env!("DISCORD_CLIENT_ID")).map(str::trim).filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether presence can work in this build: desktop only (Discord has no IPC on phones).
pub fn available(f: Flavor) -> bool {
    cfg!(desktop) && client_id(f).is_some()
}

/// What to show. `None` clears the presence.
#[derive(Debug, Clone, PartialEq)]
pub struct Presence {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    /// Public https image URL.
    pub image: Option<String>,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// "Listen on …" button.
    pub link: Option<(String, String)>,
}

static WORKER: OnceLock<Mutex<Sender<Option<Presence>>>> = OnceLock::new();

/// Show (or with `None` clear) the presence. Starts the worker thread on first use.
pub fn set(f: Flavor, p: Option<Presence>) {
    let Some(id) = client_id(f).filter(|_| cfg!(desktop)) else { return };
    let tx = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let id = id.to_string();
        let _ = std::thread::Builder::new().name("discord-presence".into()).spawn(move || worker(id, rx));
        Mutex::new(tx)
    });
    if let Ok(tx) = tx.lock() {
        let _ = tx.send(p);
    }
}

fn worker(client_id: String, rx: Receiver<Option<Presence>>) {
    let mut want: Option<Presence> = None;
    let mut conn: Option<Conn> = None;
    let mut last_try: Option<Instant> = None;
    loop {
        let changed = match rx.recv_timeout(RETRY) {
            Ok(p) => {
                // Only the newest state matters.
                let mut p = p;
                while let Ok(next) = rx.try_recv() {
                    p = next;
                }
                want = p;
                true
            }
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if conn.is_none() {
            // Nothing to show and not connected: no reason to look for Discord.
            if want.is_none() || (!changed && last_try.is_some_and(|t| t.elapsed() < RETRY)) {
                continue;
            }
            last_try = Some(Instant::now());
            conn = Conn::open(&client_id).ok();
            if conn.is_none() {
                continue;
            }
        } else if !changed {
            continue;
        }
        let activity = want.as_ref().map(activity);
        if let Some(c) = conn.as_mut() {
            if c.set_activity(activity).is_err() {
                // Discord quit or restarted; reconnect on the next update or retry tick.
                conn = None;
                last_try = None;
            }
        }
    }
}

/// Discord wants 2–128 characters per text field.
fn field(s: &str) -> String {
    let s: String = s.trim().chars().take(128).collect();
    match s.chars().count() {
        0 => "\u{2800}\u{2800}".into(),
        1 => format!("{s}\u{2800}"),
        _ => s,
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn activity(p: &Presence) -> Value {
    let start = now_ms().saturating_sub(p.position_ms);
    let mut a = json!({
        "type": 2, // Listening
        "details": field(&p.title),
        "state": field(&p.artist),
        "timestamps": if p.duration_ms > 0 { json!({ "start": start, "end": start + p.duration_ms }) } else { json!({ "start": start }) },
        "assets": { "large_text": field(p.album.as_deref().filter(|a| !a.trim().is_empty()).unwrap_or(&p.title)) },
    });
    if let Some(img) = p.image.as_deref().filter(|u| u.starts_with("https://") && u.len() <= 256) {
        a["assets"]["large_image"] = json!(img);
    }
    if let Some((label, url)) = &p.link {
        a["buttons"] = json!([{ "label": label.chars().take(32).collect::<String>(), "url": url }]);
    }
    a
}

trait Pipe: Read + Write + Send {}
impl<T: Read + Write + Send> Pipe for T {}

struct Conn {
    pipe: Box<dyn Pipe>,
    nonce: u64,
}

impl Conn {
    fn open(client_id: &str) -> std::io::Result<Conn> {
        let mut last = std::io::Error::new(std::io::ErrorKind::NotFound, "Discord is not running");
        for pipe in candidates() {
            match pipe.and_then(|p| {
                let mut c = Conn { pipe: p, nonce: 0 };
                c.handshake(client_id)?;
                Ok(c)
            }) {
                Ok(c) => return Ok(c),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    fn handshake(&mut self, client_id: &str) -> std::io::Result<()> {
        self.write(OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id }))?;
        let (op, body) = self.read()?;
        if op == OP_FRAME && body.get("evt").and_then(|e| e.as_str()) == Some("READY") {
            Ok(())
        } else {
            Err(std::io::Error::other(format!("Discord refused the connection: {body}")))
        }
    }

    fn set_activity(&mut self, activity: Option<Value>) -> std::io::Result<()> {
        self.nonce += 1;
        let cmd = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity },
            "nonce": self.nonce.to_string(),
        });
        self.write(OP_FRAME, &cmd)?;
        // Discord answers every command; read it so the pipe never fills up.
        loop {
            let (op, body) = self.read()?;
            match op {
                OP_PING => self.write(OP_PONG, &body)?,
                OP_CLOSE => return Err(std::io::Error::other("Discord closed the connection")),
                _ => return Ok(()),
            }
        }
    }

    fn write(&mut self, op: u32, v: &Value) -> std::io::Result<()> {
        let body = serde_json::to_vec(v)?;
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(&op.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        self.pipe.write_all(&frame)?;
        self.pipe.flush()
    }

    fn read(&mut self) -> std::io::Result<(u32, Value)> {
        let mut head = [0u8; 8];
        self.pipe.read_exact(&mut head)?;
        let op = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
        let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
        if len > 1 << 20 {
            return Err(std::io::Error::other("oversized Discord frame"));
        }
        let mut body = vec![0u8; len];
        self.pipe.read_exact(&mut body)?;
        Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
    }
}

/// Discord listens on `discord-ipc-0` … `discord-ipc-9` (a named pipe on Windows, a Unix socket
/// in the runtime/temp folder elsewhere, including the Flatpak and Snap builds on Linux).
fn candidates() -> impl Iterator<Item = std::io::Result<Box<dyn Pipe>>> {
    #[cfg(windows)]
    {
        (0..10).map(|i| {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(format!(r"\\.\pipe\discord-ipc-{i}"))
                .map(|f| Box::new(f) as Box<dyn Pipe>)
        })
    }
    #[cfg(unix)]
    {
        let mut dirs: Vec<std::path::PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
            .iter()
            .filter_map(|k| std::env::var_os(k).map(Into::into))
            .collect();
        dirs.push("/tmp".into());
        let mut paths = Vec::new();
        for d in dirs {
            for sub in ["", "app/com.discordapp.Discord", "snap.discord", "app/dev.vencord.Vesktop"] {
                for i in 0..10 {
                    paths.push(d.join(sub).join(format!("discord-ipc-{i}")));
                }
            }
        }
        paths.into_iter().filter(|p| p.exists()).map(|p| {
            let s = std::os::unix::net::UnixStream::connect(p)?;
            s.set_read_timeout(Some(Duration::from_secs(10)))?;
            Ok(Box::new(s) as Box<dyn Pipe>)
        })
    }
}

/// A public cover for artwork Discord can't load itself (Plex and local files): the iTunes
/// Search API's album art, remembered per album.
pub async fn public_cover(http: &reqwest::Client, artist: &str, album: Option<&str>, title: &str) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let term = format!("{artist} {}", album.filter(|a| !a.trim().is_empty()).unwrap_or(title));
    let key = term.to_lowercase();
    if let Some(hit) = cache.lock().ok()?.get(&key).cloned() {
        return hit;
    }
    let entity = if album.is_some() { "album" } else { "song" };
    let url = format!("https://itunes.apple.com/search?media=music&entity={entity}&limit=1&term={}", urlencoding::encode(term.trim()));
    let found = async {
        let v: Value = http.get(url).timeout(Duration::from_secs(6)).send().await.ok()?.json().await.ok()?;
        let art = v.pointer("/results/0/artworkUrl100")?.as_str()?;
        Some(art.replace("100x100bb", "512x512bb"))
    }
    .await;
    if let Ok(mut c) = cache.lock() {
        if c.len() > 500 {
            c.clear();
        }
        c.insert(key, found.clone());
    }
    found
}

/// The app icon, for tracks with no public artwork.
pub fn app_icon(f: Flavor) -> String {
    let name = match f {
        Flavor::YouTube => "ytspot",
        Flavor::Plex => "plexspot",
    };
    format!("https://raw.githubusercontent.com/knivesbatz/OpenMusic/main/assets/icons/{name}.png")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_fields_fit_discord_limits() {
        let p = Presence {
            title: "A".into(),
            artist: "x".repeat(300),
            album: Some(" ".into()),
            image: Some("http://insecure/img.jpg".into()),
            position_ms: 30_000,
            duration_ms: 180_000,
            link: Some(("Listen on YouTube Music right now please".into(), "https://music.youtube.com/watch?v=abc".into())),
        };
        let a = activity(&p);
        assert_eq!(a["type"], 2);
        assert_eq!(a["details"].as_str().unwrap().chars().count(), 2);
        assert_eq!(a["state"].as_str().unwrap().chars().count(), 128);
        assert_eq!(a["assets"]["large_text"], a["details"]);
        assert!(a["assets"].get("large_image").is_none(), "only https images");
        assert_eq!(a["buttons"][0]["label"].as_str().unwrap().chars().count(), 32);
        let ts = &a["timestamps"];
        assert_eq!(ts["end"].as_u64().unwrap() - ts["start"].as_u64().unwrap(), 180_000);
    }

    /// Handshake and SET_ACTIVITY framing against a fake Discord on the other end of a socket.
    #[cfg(unix)]
    #[test]
    fn talks_the_ipc_protocol() {
        let (ours, theirs) = std::os::unix::net::UnixStream::pair().unwrap();
        let fake = std::thread::spawn(move || {
            let mut d = Conn { pipe: Box::new(theirs), nonce: 0 };
            let (op, hello) = d.read().unwrap();
            assert_eq!((op, hello["client_id"].as_str()), (OP_HANDSHAKE, Some("123")));
            d.write(OP_FRAME, &json!({ "cmd": "DISPATCH", "evt": "READY" })).unwrap();
            let mut got = Vec::new();
            for _ in 0..2 {
                let (op, cmd) = d.read().unwrap();
                assert_eq!(op, OP_FRAME);
                d.write(OP_FRAME, &json!({ "cmd": "SET_ACTIVITY", "nonce": cmd["nonce"] })).unwrap();
                got.push(cmd);
            }
            got
        });
        let mut c = Conn { pipe: Box::new(ours), nonce: 0 };
        c.handshake("123").unwrap();
        let p = Presence { title: "Song".into(), artist: "Band".into(), album: None, image: None, position_ms: 0, duration_ms: 0, link: None };
        c.set_activity(Some(activity(&p))).unwrap();
        c.set_activity(None).unwrap();
        let got = fake.join().unwrap();
        assert_eq!(got[0]["cmd"], "SET_ACTIVITY");
        assert_eq!(got[0]["args"]["activity"]["details"], "Song");
        assert_eq!(got[0]["args"]["pid"], std::process::id());
        assert!(got[1]["args"]["activity"].is_null(), "None clears the presence");
    }
}
