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
- ✅ Spotify playlists: handed off to Soundiiz (guided Transfer page + Sync now); built-in importer removed because it needed a registered Spotify developer app
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

## After 1.0.2
- ✅ Spotify import replaced by a Soundiiz transfer guide
- ✅ Playlist folders (any playlist, local to the app) and Recents / Alphabetical / Custom order with
  drag and drop in the sidebar (store unit-tested, e2e)
- ✅ Search filter chips load the full list for that type (YouTube filtered search + 2 continuation
  pages; Plex up to 100 per type)
- ✅ Local files in search (blended into the results, no separate heading) and on provider artist
  pages when the artist name matches (case-insensitive; tested)
- ✅ Autoplay (off by default): YouTube radio / Plex `nearest` (random library tracks fallback) /
  random local tracks, prefetched near the end of the last song (`autoplay_tracks`, `Q.extend`)
- ✅ Desktop tray icon (Show, Play/Pause, Previous, Next, Quit) and Settings → Close to tray
  (`tray.rs`; tray menu sends `media-action` like the Android notification)
- 🟡 Settings/scroll crash: all commands touching SQLite/keyring/registry are `#[tauri::command(async)]`
  (they ran on the WebView's UI thread). `windows-ui` CI job drives the real app; confirm with user

## 1.2.16
- ✅ Windows 95 theme removed completely (theme-win95.css, W95FA font + licence + grid script, theme
  setting (saved value dropped in `sanitize`), title-bar caption, retro cutoff: retro.rs/retro.ts,
  `release_dates` and MusicBrainz date lookups, `new_releases(before)`, `Album.released`)
- ✅ Podcast "Oldest first" per show (`store/podcastSort.ts`, kv `podcastOldestFirst`); direction
  read from the episode dates (`publishedAt`; unit + e2e)
- ✅ Motion: one set (one easing, 120/200/280 ms, fades and small moves); no spin/spring/hover-grow
- 🟡 Android "Latest version": opens releases/latest in the default browser app via
  `OpenMusicMedia.openInBrowser` (package of the default browser, else CATEGORY_APP_BROWSER
  selector); only this project's GitHub URLs. e2e with a mocked bridge; not tried on a phone

## 1.2.15
- ✅ Android Settings → About: "Open in browser" for the newest APK (`update_check` url, else the
  releases/latest page; e2e, desktop hidden)

## 1.2.14
- ✅ Windows 95 cutoff: MusicBrainz dates only apply in the provider's own year (same-titled
  releases: YT 2017 "Akina" vs MB 1993 "AKINA", "Weezer (… Album)" vs 1994 "Weezer"; unit)

## 1.2.13
- 🟡 YTSpot "Copy to YouTube Music" for app playlists (`yt_copy_playlist`): `playlist/create` with
  the first 50 video ids, the rest via `browse/edit_playlist` in batches of 50; non-YouTube songs
  matched by a songs search (`same_song`: title key, artist overlap, ±20 s; unit); unmatched ones
  listed after (e2e). Not run against a real account
- ✅ Windows 95 theme cutoff (today − 28 years, re-rendered at local midnight; `store/retro.ts`,
  `retro.rs`): artist pages filtered in the UI (`retroArtist`), What's New built for the cutoff
  (`new_releases(before)`); `Album.released` (Plex originallyAvailableAt, MusicBrainz first release
  dates via `release_dates`: artist found by MBID incl. aliases, all release groups, plus a
  batched recording search for Popular songs). Partial dates count as their end; undated items
  are hidden (unit + e2e; MusicBrainz matching checked live for Tatsuro Yamashita)
- 🟡 Windows headset hold-to-skip: own SMTC session (`smtc.rs`) with fast-forward/rewind enabled
  (one skip per held burst, `Presses`; unit), display + timeline from `media_update`, seek from
  the flyout; WebView2's `HardwareMediaKeyHandling` off when SMTC is available
  (`safe_mode::browser_args`). Windows typecheck only; not tried with real headphones
- 🟡 Discord audio share made the music silent: process loopback records after the mixer's session
  mute. WebView2 sessions are now turned down (`quiet_level`, -60 dB float / -30 dB PCM) and the
  capture boosted back (`apply_gain`, never past full scale); the boost is chosen by measuring the
  capture at full and turned-down volume (`calibrated_gain`; unit). -0.0 counts as silence, so the
  8 s "capture hears nothing" fallback fires again. Windows typecheck only; not tried on a real PC

## 1.2.12
- 🟡 Headset buttons (Android `PlaybackService.onMediaButtonEvent`): hold play/pause = next, 1/2/3
  presses = toggle/next/previous, fast-forward/rewind/skip keys = next/previous once per press;
  HTPC-mode media keys ignore key repeats. Compiled in CI only; not tried with real headphones

## 1.2.11
- ✅ YT artist Popular: only tracks credited to the artist (`by_artist`: channel id or name), topped
  up from a songs search when under 5 (unit)

## 1.2.10
- ✅ Private session (`privateSession` setting): no record_play, Last.fm, Plex mark_played or Discord
  presence; YouTube players recreated on youtube-nocookie.com from the next song; badge in the
  player bar, Settings → Privacy, title bar menu (e2e). YouTube history exclusion relies on
  YouTube's privacy-enhanced mode, not verified with a real account

## 1.2.9
- ✅ Sessions: `auth_recover` + one retry in `api.ts` for `authExpired` (Plex reconnect, YT cookie
  refresh); `yt_session_lost` checks account_menu before emitting `auth-expired`; YT jar shared
  (`ytm::Jar`), `Set-Cookie` merged and saved (`yt_keep_session`, on exit), desktop refresh every
  12 h; Android refresh re-reads the CookieManager; `secrets::set_large` writes a new generation
  before switching the head (unit + e2e). Real-account behaviour not verified
- ✅ Space only plays/pauses (capture-phase handler, also on keyup; mini player) (e2e)

## 1.2.8
- ✅ Space never presses a clicked control (util.ts `spaceTogglesPlayback`: focus arriving from a
  pointer press is tracked; keyboard-reached controls keep Space), also in the mini player and
  queue rows; play() AbortError (pause during start) no longer counts as a playback error (e2e)

## 1.2.7
- ✅ Listening history page (`listening_history` pages of 100 from `history`, grouped by local day,
  remove/clear; Sidebar, Search tile, link from Recently played) (unit + e2e)
- 🟡 Playlist sync over Wi-Fi (`sync.rs`): receiver opens tiny_http on :47380 (fallback random) for
  10 min with a 6-digit code (5 wrong codes close it); sender POSTs app playlists (+ covers, YT
  cover overrides), imported by id so resending updates; local-file songs skipped; same app only.
  Unit + e2e for the UI; not yet tried between two real devices

## 1.2.6
- 🟡 Share audio with Discord (`shareAudio`, Windows): `audio_share.rs` captures the WebView2 process
  tree with process loopback, plays it from the app's process (default device) and mutes the
  WebView2 sessions; turns itself off if the capture stays silent while WebView2 plays. Typechecked
  for Windows and e2e for the setting; not yet confirmed with Discord on a real PC

## 1.2.5
- ✅ Windows 95 theme: `theme` setting → `html.win95`; `ui/src/theme-win95.css` (system palette, inset
  box-shadow bevels, scrollbars, menus, dialogs as captioned windows, list views, taskbar player);
  caption name in the custom title bar (e2e)
- ✅ Win95 pixel text: W95FA (OFL) snapped to whole pixels + bold by `scripts/w95fa-grid.py` →
  `ui/src/assets/fonts/w95fa-grid*.woff2`, used only at 12.5/25 px on 16/32 px lines; crisp icons
- ✅ Artist discography newest first; Compilations tab (`store/discography.ts`: provider kind,
  MusicBrainz `artist_compilations` release-group search credited to the artist only, title
  keywords). Plex compilations moved from Appears on to the tab (unit + e2e)

## 1.2.4
- ✅ Normalize volume: `track_loudness` (Plex stream `loudness`/`gain`, file ReplayGain/R128 via lofty;
  cached) → `loudness.ts` gain (turn-down only, Quiet −23 / Normal −14 / Loud −11 LUFS) on each audio
  deck; YouTube left to its own player (unit + e2e)
- ✅ Silent next song: gapless/crossfade only onto a deck whose preload has its source; no preload
  during a fade; fades time-based and advanced by deck timeupdates; volume safety net in onTime
  (e2e with throttled timers)

## 1.2.3
- 🟡 Widgets responsive: `RemoteViews(Map<SizeF, RemoteViews>)` on Android 12+ (row / square / tall
  for Now playing; header-only or 3–5 covers for Recently played), best fit from widget options
  before that; covers scale with the widget; play/pause on Recently played. Not yet run on a device

## 1.2.2
- 🟡 Android widgets (`crates/tauri-plugin-openmusic-media/android/.../Widgets.kt`, `res/`): Now playing
  (RemoteViews, cover tint, buttons → `MediaBridge.emit` while the page runs, else open the app
  with `om_action=play`) and Recently played (`widget_refresh` → `recent` with cover files; taps open
  the page via `om_kind/om_id` → `__omLaunch`/`takeLaunch`). Sizes from widget options. Page side
  covered by e2e; not yet run on a device

## 1.2.1 (versions continue from 1.2)
- ✅ Spotify-like motion layer (styles.css "motion, Spotify-like"): staggered cards, hero, player
  bar song change, play/pause swap, panel slide, menu scale, now-playing bars, paused cover;
  reduced motion turns it off
- ✅ Menu icons (`MenuItem.icon`) on song, playlist, album, artist, folder, podcast and title-bar menus
- ✅ Bulk Liked Songs: `likeTracks` (4 requests at a time, failures rolled back), selection menus,
  "Add all to Liked Songs" on albums/playlists, Liked Songs in "Add to playlist" (e2e)
- ✅ YTSpot in-app covers for YouTube playlists (`kv` "playlist.covers", applied to home, search,
  library and playlist pages; unit + e2e)

## 1.0.10
- 🟡 Android notification ↔ player without the app IPC: notification/headset buttons call
  `window.__omMedia` through `evaluateJavascript`; the page reports songs through the
  `OpenMusicMedia` JavaScript interface (Rust still adds the cover file; `seq` drops late updates).
  Fixes the notification not following song changes and Pause doing nothing in the background.
  e2e covers the page side; not yet run on a device
- 🟡 Pause on `ACTION_AUDIO_BECOMING_NOISY` (headphones unplugged, Bluetooth disconnected), Android
- ⬜ Desktop: pause when the audio device disconnects (WebView2 doesn't tell the page)
- ⬜ Android updates need the `ANDROID_KEYSTORE` / `ANDROID_KEYSTORE_PASSWORD` secrets (one last
  uninstall after the switch)

## 1.0.9
- 🟡 Windows title bar: main window undecorated on Windows (`lib.rs`), `TitleBar.tsx` with ••• menu,
  history, Home + search, actions and min/max/close (`core:window` capabilities). e2e with
  platform "windows"; not yet seen on a real Windows desktop
- 🟡 What's New (`new_releases`): saved artists' albums/singles from this year and last, plus Plex
  latest releases / recently added or YouTube's new releases feed; cached 1 h (unit + e2e)
- ✅ Multi-disc albums grouped by disc (`disc_number` from Plex `parentIndex` and local tags; e2e)
- ✅ Search inside a playlist (e2e); PLEXSpot Albums/Artists show saved items only (e2e)
- ✅ Spotify-style seek bar (handle, time bubble, remaining time) and chunkier skip icons
- ⬜ YTSpot offline downloads (needs a stream downloader; see release notes)
- ⬜ Keep Android sign-in across reinstalls: needs the `ANDROID_KEYSTORE` secrets so every APK has
  the same signature

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
  `ANDROID_KEYSTORE` secret is set). The Rust side compiles; the CLI runs through
  `apps/*/src-tauri/package.json` (`npm run tauri`) so Gradle can call it back
- 🟡 Background playback + media notification: `crates/tauri-plugin-openmusic-media` (Kotlin
  foreground service, MediaSession, notification buttons → `media-action` event; re-resumes the
  WebView after the activity pauses it). Untested on a device
- 🟡 Android artwork uses the `art://` protocol (release builds block cleartext to the localhost server)
- ⬜ Local music folders on Android (needs Storage Access Framework)

## Known issues
- YouTube videos whose owners block embedding (errors 101/150) can't play; the engine skips them
  with a toast.
- Rust tests need GTK/WebKit dev packages on Linux (see CLAUDE.md); CI runs them on Windows.

## 1.2.17
- 🟡 Podcast episodes use the show's cover (`Ytm::podcast` sets every episode's artwork to the
  header thumbnail when there is one). Older saved episodes keep the art they were saved with;
  episodes in search results still carry YouTube's thumbnail. Not checked against a live account

## 1.3.0
- 🟡 Profile page (`pages/Profile.tsx`, route `profile`): `profile_info` (YT: account_menu → channel
  id → channel page "Playlists" shelf + More; Plex: Home user / plex.tv user), `profile_artists`
  (history → `Db::history_artists`, pictures from artist pages cached a month), photo/name in kv
  `profile` (app-only). Parsers tested on recorded shapes; the account menu's channel link and
  the channel's More page aren't checked against a signed-in account
- ✅ Top bar: bell + avatar menu (Account ↗, Profile, Switch profile, Recents, Transfer playlists,
  Support ↗, Private session, Settings, Log out); Settings/transfer buttons and the account name
  link removed from the bar (self-test and e2e go through the menu)
- 🟡 Browse all: search box browse button; `browse_categories` (YT Explore + Moods & genres, Plex
  genres), `browse_page`, `browse_art` (first cover, cached a week). Moods & genres returns 404
  without sign-in, so only Explore's tiles were checked live
- ✅ Library Sort by (Recents, Recently added via kv `libraryOrg.added` first-seen times,
  Alphabetical, Creator, Custom) and View as (compact, list, compact grid, grid) menu (unit + e2e)
- ✅ Track-list sticky header uses the measured `--topbar-h` (gap on Windows' 56px bar)
- ✅ Rounder corners and a few more fades (menu rows, dialog contents, library entries, tile covers)

## 1.4.0
- 🟡 macOS: `macos.yml` workflow (started by build.yml's release job; universal dmg per app, ad-hoc signed, not notarized; core tests on
  macOS), release attaches `*.dmg`; keyring `apple-native` (it fell back to an in-memory store);
  UI served from `http://localhost:47321/47322` via tauri-plugin-localhost so YouTube's embed and
  http Plex servers work (`ui_url`, `capabilities/macos.json`); Safari user agent for Google
  sign-in; updater downloads `_universal.dmg` and swaps the bundle (hdiutil + ditto, relaunch).
  Startup: check at 2 s, auto-install + reopen when nothing plays (kv `update.autoInstall`
  guards loops). Built in CI only; not run on a Mac yet
- 🟡 YTSpot "Delete from YouTube" for own playlists (`yt_delete_playlist`: PL ids only, page must
  have the editable header, `playlist/delete`; cached library pruned). Not run against a real account

## 1.4.1
- 🟡 Android self-update (`SelfUpdate.kt`: download from GitHub releases only, PackageInstaller
  session with USER_ACTION_NOT_REQUIRED on API 31+, status receiver shows Android's confirm screen
  when needed, MY_PACKAGE_REPLACED notification). Needs the ANDROID_KEYSTORE secrets (stable key)
  and one reinstall; not run on a phone yet
- ✅ Discord hint: Activity Privacy setting when friends can't see the presence

## 1.5.0
- ✅ Phone UI after Spotify mobile (spec from reference screenshots, scratch research): Home top
  row avatar + chips, Search header + white field, Your Library header/chips/sort+grid/mixed list,
  account drawer, ••• bottom sheet (MenuHead), ⊕/✓ save button, mini player save + swipe to skip,
  song screen About the artist card. e2e 52/52 with the phone paths
- 🟡 Still unlike Spotify: playlist action row (download/share icons), pinned compact header on
  scroll, Create tab, smart shuffle, Jam

## 1.5.1
- ✅ APKs signed with the stable key (ANDROID_KEYSTORE secrets added). Release builds now fail
  instead of falling back to a throwaway key, and check the certificate's SHA-256 (a7979368…0bf9)
- 🟡 Android self-update from 1.5.1 to the next version not yet seen on a phone

## 1.6.0
- ✅ Phone: Create tab (+, panel with Playlist / Folder / Transfer playlists; ✕ while open)
- ✅ Phone playlist: Find in playlist + Sort above the cover (Sort by sheet); action buttons unchanged
  (user asked to keep them)
- ✅ Phone pinned bar on album/playlist/artist/podcast pages: cover colour, centred name, docked
  play/pause (appears when the page's play button reaches the bar)
- ✅ Classic Your Library on phones again (Music/Podcasts + Playlists/Artists/Albums tabs), default on;
  Settings → Classic Your Library off = the 1.5.0 chips layout
- ✅ Album header on phones: artist line, then "Album • year"; filled Home/Library tab icons
- ✅ Spotify chips (green when on, outlined), pin on Liked Songs / Your Episodes, "Playlist • owner" rows,
  your picture by your own playlists
- e2e 53/53 (new phone test)

## 1.6.1
- ✅ Phone library: one layout (the 1.5.0 one) with the old Playlists · Artists · Albums underlined tabs
  instead of chips (tap again = everything); Classic Your Library setting removed; Create tab removed
  (user's call). e2e 53/53

## 2.0.0 — OpenSpot
- ✅ One app (OpenSpot) for YouTube Music + Plex: Provider per id, Settings → Services switches,
  per-provider sign-in/auth/errors/cache, fan-out home/library/liked with per-provider errors,
  per-provider search merged in the UI (searchMerge.ts); visible source badges removed (data-source only)
- ✅ Merged artist pages (both services on): artist_merge.rs merges YouTube/Plex/local by artist_key
  plus a shared song or release; lists drop only pairs the core confirmed (artist_links /
  artist_link_check, store/artistLinks.ts). One service on: pages and lists as in 1.6.1
- ✅ "Already added" warning before adding duplicates to a playlist (duplicates.ts)
- ✅ Hidden playlists are left out of the Profile page; green icon restored
- ✅ Migration: identifier stays app.openmusic.ytspot (YTSpot upgrades in place); migrate.rs imports
  PLEXSpot's data dir/DB/files/secrets once on desktop; NSIS hooks retire the old apps; macOS
  bundle rename; legacy YTSpot_/PLEXSpot_ alias assets on every 2.x release
- 🟡 Not verified against real accounts or on Windows/macOS/Android devices: provider flows, the
  NSIS hooks (first run in CI), keychain import prompts, mixed-queue playback in the background on
  Android
- 🟡 Discord: rename the YTSpot Discord application to "OpenSpot" (or set DISCORD_CLIENT_ID_OPENSPOT)
