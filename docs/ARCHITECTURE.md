# Architecture

## Stack decision

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** (2.12) | Native Windows app on WebView2. Small installers (~5–10 MB vs ~100 MB Electron). Rust backend. |
| Core | **Rust** crate `openmusic-core` | Providers, persistence, scanning, downloads, auth, scrobbling. Off the UI thread. |
| UI | **React 18 + TypeScript + Vite 5 + zustand** | Mature, typed, fast. zustand selectors avoid app-wide re-renders (the playback position ticks without re-rendering lists). `@tanstack/react-virtual` handles long lists. |
| DB | **SQLite** (rusqlite, bundled) | WAL mode, versioned migrations via `PRAGMA user_version`. |
| Secrets | **Windows Credential Manager** (`keyring`) | Per-app namespace (the app identifier). Values over 2.5 KB are chunked. |

Node 18 is supported (Vite 5). CI uses Node 20.

## Two apps, one codebase

`apps/ytspot` and `apps/plexspot` each hold a `tauri.conf.json` (productName, identifier, icons, window)
and a three-line `main.rs` that calls `openmusic_core::run(Flavor::…, generate_context!())`. Because the
identifier differs, Tauri gives each app its own `%APPDATA%\app.openmusic.<app>` data dir and WebView2
profile, and `secrets.rs` namespaces credentials by identifier. The single UI build (`ui/dist`) is shared,
and the UI asks `app_info` which flavor it runs in.

## Provider model

Rust `commands.rs` dispatches on `Flavor` and on id prefixes:

- `plex.rs`: plex.tv PIN auth, `/api/v2/resources` discovery, parallel connection probing (local >
  remote > relay), library/search/playlists/hubs, stream URLs (direct or universal transcode for
  Low/Medium), `/:/scrobble` to keep Plex play state in sync, and `/:/rate` for likes.
- `ytm.rs`: InnerTube `WEB_REMIX` JSON endpoints with the user's own Google session cookies
  (SAPISIDHASH auth), captured from a Google sign-in webview. Parsers search for renderer objects
  anywhere in the response, so small layout changes don't break them. **Unofficial**: there is no
  official API for YouTube Music libraries. It's isolated in one module.
- `local.rs`: folder scanning with `lofty` and incremental refresh by (mtime, size). Missing files are
  flagged, not deleted.
- App playlists (`app:` ids) are SQLite-only, so neither provider's playlists are ever modified.

`Capabilities` (in `model.rs`) tells the UI what the active provider supports, so unsupported controls
are hidden or explained rather than faked.

## Playback

Audio plays **in the main window's webview**. There is exactly one engine (`ui/src/player/engine.ts`):

- **Plex, local and downloaded files** go through two `<audio>` elements (A/B). This allows
  **crossfade** (volume ramps over 0–12 s), **near-gapless** playback (the next track is preloaded on the
  idle element and started on `ended`; HTML media can't guarantee sample-accurate gapless), and
  **Automix** (crossfade between unrelated tracks, never inside the same album).
- **YouTube** plays through the **official YouTube IFrame Player API** in an off-screen player. No
  stream deciphering and no DRM circumvention. Limitations (documented in the UI): no crossfade or
  gapless, quality chosen by YouTube, no downloads, and some videos disallow embedding (skipped with a
  notice).
- Local and downloaded files are served through Tauri's asset protocol. Folders are added to the scope
  at runtime.
- The engine also drives the Windows media session (media keys/SMTC via `navigator.mediaSession`),
  Last.fm (now-playing plus scrobble at Last.fm's threshold), history, and Plex play-state.

The **PiP window** (`index.html#pip`) has no audio. It renders state broadcast by the main window over
Tauri events and sends commands back. Closing it never affects playback.

## Data flow and caching

- `art://` URI scheme (`art.rs`): artwork is fetched once, written atomically to a bounded disk cache
  (512 MB, LRU-pruned at startup) and served locally. Plex tokens never appear in stored metadata.
- `cache` table: Home (30 min, stale-while-revalidate), search (10 min), artist (6 h), album (24 h),
  lyrics (30 d).
- Plex library listings are cached with a fingerprint of each music section's
  `contentChangedAt`/`updatedAt`, so an unchanged server costs one request instead of a full re-sync.
- Queue state is persisted (debounced) and restored at startup without autoplay.

## Reliability

- Downloads stream to `.part` files and are renamed only after the byte count is verified.
  Interrupted downloads are marked failed at startup and their partial files deleted.
- Scrobbles are queued in SQLite with a UNIQUE(artist, track, timestamp) constraint, so retries can't
  double-scrobble.
- YouTube cookie rotation: on a 401/403, a hidden webview reloads music.youtube.com (same profile) to
  pick up a fresh cookie jar, at most once every 5 minutes. If that fails, the UI asks the user to sign
  in again.
- Plex: the stored session is used immediately at startup, then re-probed in the background (the
  server's IP may have changed). Offline falls back to cached data.

## Known limitations (provider-imposed)

| Area | Limitation |
|---|---|
| YouTube Music API | No official library API. Uses InnerTube with the user's own session, which can break when YouTube changes its web client. The client version is in `ytm.rs::DEFAULT_CLIENT_VERSION`. |
| YouTube playback | IFrame player only: no crossfade/gapless, no quality control, some videos not embeddable. |
| YouTube downloads | Not offered. No authorized offline mechanism exists for third-party apps. |
| Plex transcode | Low/Medium use `/music/:/transcode/universal`. If the server rejects it, the engine falls back to original quality. Not yet verified against a live server. |
| Spotify playlists | Reading them needs a registered Spotify developer app (and allow-listed users in development mode), so the app hands transfers off to Soundiiz, which writes to YouTube Music or Plex. |
| Last.fm | Users supply their own API key/secret (Last.fm requires one per application). |
| Lyrics | LRCLIB (open database). Coverage varies. Unsynced lyrics are shown as unsynced. |
| Romaji | Kana are romanized. Kanji need a dictionary, which isn't bundled yet (see TODO). |
