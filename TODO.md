# TODO / progress log

Legend: ✅ done and tested · 🟡 implemented, not verified against a real account/device · ⬜ not started

## Phase 1: Foundation
- ✅ Cargo workspace: `openmusic-core` + two Tauri app crates with separate identifiers, icons and capabilities
- ✅ SQLite with versioned migrations (unit-tested)
- ✅ Credential-store secrets with chunking for large values
- ✅ GitHub repo + CI workflow (tests + NSIS installers for both apps)
- ✅ Windows installers built by CI and published as GitHub releases (`workflow_dispatch` with `release_tag`): v0.1.0-beta.1 (pre-release), v1.0.0

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
- 🟡 Save albums / follow artists to "Your Library" (local SQLite, migration v2, DB tested): save
  button on album pages, Follow on artist pages, context menus, sidebar Albums/Artists filters.
  Never written to Plex or YouTube
- 🟡 Like state loaded from the provider (Plex rated tracks, YouTube Liked Music)

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
- 🟡 Kana → romaji for lyrics and titles/artists (tested); kanji still need a dictionary (lindera/ipadic or kuromoji, ~15–20 MB; evaluate size)
- 🟡 Translated artist names: MusicBrainz aliases in the UI language (CC0 data, exact-match only, 1 req/s,
  30-day SQLite cache, tested alias picking); original kept as tooltip; setting to turn off.
  Album titles: MusicBrainz rarely has localized release titles, so albums stay as published

## Phase 9: Polish
- 🟡 HTPC/TV mode: launch at startup (autostart plugin, `--htpc` opens fullscreen in TV mode), Gamepad API spatial navigation (A/B/X/Y, LB/RB, LT/RT, Start)
- 🟡 Sleep timer, "View credits", "Share" (copy title/link) menu items
- ✅ Playwright UI smoke tests against the production build with a mock backend (`npm run e2e`, CI job
  `e2e`): home, search, Shift-click queue range + Delete, album context menu + save, artist follow,
  fullscreen lyrics + Escape, language switch, 50k-track list
- 🟡 Large-list measurement (mock data, headless Chromium): 50,000-track playlist renders first rows in
  ~0.7–0.9 s, jump-scroll to row 40,000 in ~85 ms, 16 rows in the DOM, ~60–70 MB JS heap. Not yet
  measured inside WebView2 on Windows or against a real 50k Plex library

## Phase 10: Release
- 🟡 Code signing wired in CI: set repository secrets `WINDOWS_CERTIFICATE` (base64 .pfx) and
  `WINDOWS_CERTIFICATE_PASSWORD` and the installers are Authenticode-signed with timestamping. No
  certificate yet, so releases are unsigned
- 🟡 CI `install-test` job per app on windows-latest: installs the latest published release, upgrades it
  with the new build (silent), checks the version, launches the app and checks it's still running after
  20 s, then uninstalls and checks removal. Releases only publish when it passes
- ✅ Install, upgrade, uninstall, data locations and troubleshooting documented (`docs/INSTALL.md`)

## Fixed after beta testing (real YouTube account)
- ✅ Profile (brand-account channel) picker for YTSpot (`account/accounts_list`, `onBehalfOfUser`)
- ✅ Album cover parsed from the header's own `thumbnail` (not `straplineThumbnail`)
- ✅ Play counts never parsed as artist names; album tracks inherit the album artist
- ✅ Music videos display their song counterpart's album art and official artist (`next` endpoint,
  cached 30 days)
- ✅ MusicBrainz aliases only across scripts; search hints ignored (the "MCR" bug)
- 🟡 Fullscreen crash: OS fullscreen no longer automatic; error boundary + native crash log. Root
  cause not reproduced (no Windows desktop here); confirm on the user's machine

## 1.0.1 (crash and feedback fixes)
- 🟡 Artwork served by a local HTTP server (127.0.0.1, random port + token) instead of the async
  `art://` protocol: suspected cause of crashes on scroll/navigation (cancelled requests). Not
  reproducible here (no Windows desktop); confirm on device
- ✅ Root error boundary; UI errors and render errors appended to crash.log (`log_ui_error`)
- 🟡 YouTube crossfade/Automix/near-gapless with two IFrame players (verify on device: YouTube may
  pause one embed when another plays)
- 🟡 Plex Home user picker (`/api/v2/home/users`, `/switch` with PIN); parser tested
- ✅ Last.fm: serialized queue flush (duplicate-scrobble race), repeat-one rescrobble, official
  artist for music videos, 10-min retry, revoked session handling

## 1.0.2
- 🟡 Settings/scroll crashes: native `<select>` popups replaced by in-app dropdowns; safe mode (GPU off
  after an unclean exit, Settings switch); backdrop/fullscreen blurs removed. Root cause still not
  reproduced; crash.log from the user will confirm
- ✅ Lyrics effect keyed on track id (regression test as YTSpot with music videos)
- ✅ YouTube: song versions played/displayed instead of music videos; title cleanup (tested)
- 🟡 Spotify one-click sign-in with a built-in Client ID (`SPOTIFY_CLIENT_ID` repo secret)

## Android (started)
- 🟡 Shared codebase: same Rust core and React UI; app crates expose a `mobile_entry_point` library
- 🟡 Desktop-only features gated (`desktop`/`mobile` cfg from core build.rs; `OPENMUSIC_CHECK_MOBILE=1
  cargo check` checks the mobile paths on a desktop host): single instance, launch at startup, mini
  player window, OS keyring (Android: secrets file in app-private storage)
- 🟡 Phone layout (≤760 px): bottom tabs, mini player with progress line, full-screen queue/player,
  tap-to-play, long-press menus; checked in headless Chromium at 390×844 with touch
- 🟡 YouTube sign-in on Android navigates the main webview to Google and back (Google may refuse
  embedded sign-in; fallback: OAuth device-code flow)
- 🟡 CI `android` job builds and signs arm64 APKs (non-blocking; throwaway key unless
  `ANDROID_KEYSTORE` secret is set). Not yet run; Android SDK isn't reachable from the dev container
- ⬜ Local music folders on Android (needs Storage Access Framework), background playback service,
  media notification controls

## Known issues
- YouTube videos whose owners block embedding (errors 101/150) can't play; the engine skips them
  with a toast.
- Rust tests need GTK/WebKit dev packages on Linux (see CLAUDE.md); CI runs them on Windows.
