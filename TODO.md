# TODO / progress log

Legend: ✅ done and tested · 🟡 implemented, not verified against a real account/device · ⬜ not started

## Phase 1: Foundation
- ✅ Cargo workspace: `openmusic-core` + two Tauri app crates with separate identifiers, icons and capabilities
- ✅ SQLite with versioned migrations (unit-tested)
- ✅ Credential-store secrets with chunking for large values
- ✅ GitHub repo + CI workflow (tests + NSIS installers for both apps)
- 🟡 Windows installers built by CI and published as GitHub pre-releases (`workflow_dispatch` with `release_tag`; the session's git proxy can't push tags)

## Phase 2: Shared UI
- 🟡 App shell: sidebar (filters, in-library search, sort, collapse), top bar with history navigation, main view, bottom player bar. Renders correctly with a mock backend (docs/screenshots)
- 🟡 Home, Search, Library, Artist, Album, Playlist pages
- 🟡 Track list (virtualised) with context menu and add-to-playlist
- 🟡 Settings page (language, quality, crossfade, gapless, automix, accessibility, storage, accounts)

## Phase 3: Providers
- 🟡 Plex: PIN sign-in, server discovery and selection, connection probing, library, search, artist/album/playlist, streaming
- 🟡 YouTube Music: Google sign-in webview → cookies, InnerTube home/search/library/artist/album/playlist/podcast/radio
- ✅ Parser and mapping unit tests for both (recorded JSON shapes)
- ⬜ Verify both against real accounts (needs a Plex server and a Google account)

## Phase 4: Playback
- 🟡 Central engine: queue, shuffle, repeat off/all/one, seek, volume, persistence
- 🟡 Crossfade 0–12 s, near-gapless preload, Automix (audio element sources)
- 🟡 YouTube IFrame output
- 🟡 Media keys (navigator.mediaSession)
- ✅ Queue operations are pure (`ui/src/player/queue.ts`) and unit-tested: enqueue/play next, consume manual items, remove, multi-move, repeat, shuffle restore, Shift/Ctrl selection

## Phase 5: Library and import
- ✅ App playlists CRUD + reorder in SQLite (unit-tested)
- 🟡 Local files: folder add, incremental scan (unit-tested), playback via asset protocol
- 🟡 Spotify import with PKCE, conservative matcher (unit-tested), report UI
- 🟡 YTSpot permanent hide playlist (DB tested; UI confirm dialog)

## Phase 6: Advanced player
- 🟡 Fullscreen player with synced lyrics (LRCLIB)
- 🟡 Resizable PiP window synced over events
- 🟡 Queue: multi-select, Shift-range, Ctrl-toggle, drag reorder, bulk remove, clear

## Phase 7: Offline
- 🟡 Plex downloads (`.part` + verify + rename, recovery at startup, cancel/remove)
- 🟡 Art disk cache with LRU bound, metadata cache, Plex library fingerprint sync

## Phase 8: Integrations
- 🟡 Last.fm auth/now-playing/scrobble queue (threshold + dedupe unit-tested)
- 🟡 English/Japanese UI
- 🟡 Kana → romaji for lyrics (tested); kanji still need a dictionary (lindera/ipadic, about 20 MB; evaluate size)
- ⬜ Translated artist/album names (needs a licensed metadata source, e.g. MusicBrainz aliases)

## Phase 9: Polish
- 🟡 HTPC/TV mode: launch at startup (autostart plugin, `--htpc` opens fullscreen in TV mode), Gamepad API spatial navigation (A/B/X/Y, LB/RB, LT/RT, Start)
- 🟡 Sleep timer, "View credits", "Share" (copy title/link) menu items
- 🟡 Playwright screenshot run against a mock backend (`ui/e2e/`); no assertions yet
- ⬜ Measure startup and memory on a 50k-track library

## Phase 10: Release
- ⬜ Code signing (needs a certificate)
- ⬜ Upgrade-install test

## Known issues
- Liked state isn't loaded from the provider, so the "Save to Liked" button starts unfilled until
  you toggle it in this session.
- YouTube videos whose owners block embedding (errors 101/150) can't play; the engine skips them
  with a toast.
- Rust tests need GTK/WebKit dev packages on Linux (see CLAUDE.md); CI runs them on Windows.
