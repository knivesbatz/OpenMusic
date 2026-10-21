//! Stall detector. Every second it checks that the main (window) thread, the async runtime and
//! the database lock are all making progress; when one of them is stuck for more than 5 s it
//! writes which one, and the last commands the UI sent, to `crash.log`. Freezes otherwise leave
//! no trace, because the app never crashes. With `--self-test` a stall also ends the process so
//! CI can report it.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use crate::state::AppState;

static MAIN_TICK: AtomicU64 = AtomicU64::new(0);
static RT_TICK: AtomicU64 = AtomicU64::new(0);
static RECENT: Mutex<VecDeque<(u64, String)>> = Mutex::new(VecDeque::new());

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Called from the invoke handler for every command the UI sends.
pub fn record(command: &str) {
    if let Ok(mut r) = RECENT.lock() {
        if r.len() >= 25 {
            r.pop_front();
        }
        r.push_back((now_ms(), command.to_string()));
    }
}

fn recent(now: u64) -> String {
    RECENT
        .lock()
        .map(|r| r.iter().map(|(t, c)| format!("{c} ({:.1}s ago)", (now - t) as f64 / 1000.0)).collect::<Vec<_>>().join(", "))
        .unwrap_or_default()
}

pub fn start(app: AppHandle, state: Arc<AppState>) {
    let self_test = std::env::args().any(|a| a == "--self-test");
    let started = now_ms();
    MAIN_TICK.store(started, Ordering::Relaxed);
    RT_TICK.store(started, Ordering::Relaxed);
    std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || {
            let mut db_locked_since: Option<u64> = None;
            let mut reported = false;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let _ = app.run_on_main_thread(|| MAIN_TICK.store(now_ms(), Ordering::Relaxed));
                tauri::async_runtime::spawn(async { RT_TICK.store(now_ms(), Ordering::Relaxed) });
                let now = now_ms();
                match state.db.try_lock() {
                    Err(std::sync::TryLockError::WouldBlock) => {
                        db_locked_since.get_or_insert(now);
                    }
                    _ => db_locked_since = None,
                }
                let main_age = now.saturating_sub(MAIN_TICK.load(Ordering::Relaxed));
                let rt_age = now.saturating_sub(RT_TICK.load(Ordering::Relaxed));
                let db_age = db_locked_since.map(|t| now - t).unwrap_or(0);
                let stalled = main_age > 5000 || rt_age > 5000 || db_age > 5000;
                if stalled && !reported {
                    reported = true;
                    let line = format!(
                        "watchdog: app stalled. main thread {:.1}s, async runtime {:.1}s, database lock held {:.1}s. Last commands: {}",
                        main_age as f64 / 1000.0,
                        rt_age as f64 / 1000.0,
                        db_age as f64 / 1000.0,
                        recent(now)
                    );
                    log::error!("{line}");
                    append(&state, &line);
                    if self_test {
                        append_self_test(&state, &line);
                        std::process::exit(3);
                    }
                } else if !stalled && reported {
                    reported = false;
                    append(&state, "watchdog: app responsive again");
                }
            }
        })
        .ok();
}

pub(crate) fn append(state: &AppState, line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(state.dirs.data.join("crash.log")) {
        let _ = writeln!(f, "[{}] v{} {line}", crate::db::now(), env!("CARGO_PKG_VERSION"));
    }
}

fn append_self_test(state: &AppState, line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(state.dirs.data.join("selftest.log")) {
        let _ = writeln!(f, "[{}] {line}", crate::db::now());
    }
}

#[cfg(test)]
mod tests {
    /// `state.db()` returns a std MutexGuard. A temporary guard lives until the end of its whole
    /// statement, so a second `.db()` in the same statement (e.g. two fields of one struct
    /// literal) deadlocks the thread. This froze the app on opening Settings; keep it out.
    #[test]
    fn no_second_db_lock_within_one_statement() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let src: String = std::fs::read_to_string(&path)
                .unwrap()
                .lines()
                .map(|l| l.split("//").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n");
            let needle = concat!(".db", "()");
            let hits: Vec<usize> = src.match_indices(needle).map(|(i, _)| i).collect();
            for &a in &hits {
                let mut depth = 0i32;
                let mut end = src.len();
                for (i, c) in src[a..].char_indices() {
                    match c {
                        '(' | '[' | '{' => depth += 1,
                        ')' | ']' | '}' => {
                            depth -= 1;
                            if depth < 0 {
                                end = a + i;
                                break;
                            }
                        }
                        ';' if depth == 0 => {
                            end = a + i;
                            break;
                        }
                        _ => {}
                    }
                }
                if hits.iter().any(|&b| b > a && b < end) {
                    let line = src[..a].matches('\n').count() + 1;
                    found.push(format!("{}:{line}", path.file_name().unwrap().to_string_lossy()));
                }
            }
        }
        assert!(found.is_empty(), "second database lock in the same statement (self-deadlock): {found:?}");
    }
}
