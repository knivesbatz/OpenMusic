# OpenMusic: OpenSpot

**OpenSpot** is one Spotify-style music client for YouTube Music, Plex and local files
(`apps/openspot`, identifier `app.openmusic.ytspot`). Since 2.0.0 it replaces the two 1.x apps,
YTSpot (YouTube Music) and PLEXSpot (Plex).

The product spec is in `docs/SPEC.md`. Progress and the prioritized backlog are in `TODO.md`, and the
design is in `docs/ARCHITECTURE.md`. **Read TODO.md first** when you resume work.

## Layout

```
crates/openmusic-core/   Rust: all shared logic (providers, DB, local files, Last.fm, downloads,
                         art cache, PLEXSpot import, Tauri commands). `run(ctx)` starts the app.
crates/tauri-plugin-openmusic-media/   Android media notification, widgets and self-update
                         (Kotlin namespace app.openmusic.media).
apps/openspot/src-tauri/ The app crate: main.rs/lib.rs + tauri.conf.json + icons + capabilities +
                         installer/ (NSIS art and hooks.nsh).
ui/                      React 18 + TypeScript + Vite 5 + zustand. It asks Rust `app_info` for the
                         providers, their capabilities and which services are on.
assets/icons/            Source SVG/PNG for the app icon (openspot.*; regenerate with `tauri icon`).
                         ytspot.png/plexspot.png stay: 1.x clients load them for Discord.
scripts/installer-art.py NSIS sidebar/header art from assets/icons/openspot.png.
.github/workflows/       CI: tests, the Windows installer and Android APK, install test, release.
```

## Providers and services

- Providers are `youtube` (YouTube Music) and `plex`. Local files and app playlists belong to neither.
- Each provider has a **service switch** (Settings → Services; Rust `Services`, kv `services`).
  - A provider that is off keeps its sign-in, but it is never called and is hidden everywhere.
  - YouTube Music may be on without an account (anonymous). Plex needs a sign-in.
- Commands dispatch per item with `Provider::of_id`. Fan-out commands (home, search, library, liked,
  browse) run each provider that is on, and report a failing provider in `errors[]` instead of failing.
- Errors `authExpired` / `disabled` carry the `provider`.

## Identifier (why it still says ytspot)

The identifier stays `app.openmusic.ytspot`. It is never shown to users, but Tauri derives from it:

- the data dirs;
- the WebView profile, which holds the Google cookies;
- the keyring service;
- the Android package (same signing key);
- the single-instance lock.

Keeping it lets YTSpot users upgrade in place on Windows, macOS and Android. The macOS UI port stays
47321. PLEXSpot data (`app.openmusic.plexspot`) is imported once by `migrate.rs`. Don't change the
identifier.

## Commands

```bash
# Rust unit tests (no network)
cargo test -p openmusic-core
# UI
cd ui && npm ci && npm run typecheck && npm test && npm run build
# Run the app in dev (needs Windows/macOS/Linux desktop + WebView)
cd apps/openspot/src-tauri && ../../../ui/node_modules/.bin/tauri dev
# Release installer (Windows) -> target/release/bundle/nsis/OpenSpot_<v>_x64-setup.exe
cd ui && npm run build && cd ../apps/openspot/src-tauri && ../../../ui/node_modules/.bin/tauri build
# App icon set after changing assets/icons/openspot.png
ui/node_modules/.bin/tauri icon assets/icons/openspot.png -o apps/openspot/src-tauri/icons
```

`tauri dev` uses `devUrl` http://localhost:1420. Start `npm run dev` in `ui/` first.

## Versions and releases

- One version, in three places: `Cargo.toml` `[workspace.package]`, `apps/openspot/src-tauri/tauri.conf.json`
  and `ui/package.json` (plus the top of `ui/package-lock.json`). CI fails unless they match each
  other and the release tag.
  - The updater compares against the Cargo version.
- Releases carry OpenSpot files only (`OpenSpot_<v>_…`). There are no YTSpot_/PLEXSpot_ copies, so
  1.x apps don't update themselves; their users install OpenSpot (data carries over).
- The release job never deletes v1.6.1, which is the install test's upgrade fixture.

## Working in a cloud session (Linux, no display)

- `cargo test -p openmusic-core` and every `ui` npm script work on Linux. Building the Tauri app crate
  on Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.
  The `keyring` crate also builds there.
- The Windows installer and the Android APK come from CI (`.github/workflows/build.yml`).
  - Push to `main` and download the `openspot-windows` / `openspot-android` artifacts.
  - Or push a tag `vX.Y.Z` to publish a GitHub release.
- install-test upgrades the pinned v1.6.1 YTSpot and PLEXSpot installers to the new build, and checks:
  - the old apps are uninstalled;
  - their data is kept;
  - "Launch at startup" moved over;
  - the PLEXSpot import marker is set.
- The NSIS hooks are in `apps/openspot/src-tauri/installer/hooks.nsh`. They never touch
  `app.openmusic.*` data, except PLEXSpot's folders when "Delete app data" is ticked on uninstall.
- The Mac disk image (`OpenSpot_<v>_universal.dmg`, artifact `openspot-macos`) comes from
  `.github/workflows/macos.yml`. It also runs the core tests on macOS.
  - build.yml's release job starts macos.yml with the release tag. macos.yml adds the disk image to
    that release, so a slow macOS runner never holds up a release.
  - On macOS the UI is served from `http://localhost:47321` (`ui_url`, tauri-plugin-localhost,
    `capabilities/macos.json`). Keep window URLs going through `ui_url`.
  - The app is ad-hoc signed and not notarized, so users click Open Anyway the first time.
- Real provider accounts aren't available in CI. Never claim a provider flow is verified unless it
  ran against a real account. Parser tests use recorded JSON shapes.

## Conventions

- Rust model types in `model.rs` are mirrored by hand in `ui/src/types.ts`. Change both together.
- Every Tauri command lives in `commands.rs` and is registered in `lib.rs`. Add its wrapper to
  `ui/src/api.ts`.
- Ids are provider-aware:
  - `plex:<ratingKey>`, `plex-genre:…`
  - `yt:<videoId|browseId>`
  - `local:<hash>`, `local-album:<artist>\u001f<album>`, `local-artist:<name>`
  - `app:<uuid>` (app playlists)
- Gate provider features per item (`sourceOf(id)` in the UI, `Provider::of_id` in Rust), not per app.
- Provider cache keys are prefixed `yt:` / `plex:`, so one provider's cache can be cleared alone.
- Artwork is stored as `art://plex/<path>`, `art://url/<encoded>` or `art://local/<file>`. The UI resolves
  these with `artUrl()`, and `art.rs` serves them from a disk cache. Never store tokens in metadata.
- Secrets go in the OS credential store (`secrets.rs`), never in SQLite or settings. That covers the Plex
  token/session, YouTube cookies and Last.fm keys/session.
- Playlists:
  - App playlists are SQLite-only and may mix providers.
  - **OpenSpot never writes Plex/Plexamp playlists.**
  - A remote YouTube playlist is deleted only when the user picks "Delete from YouTube" on one they own
    (checked against the page's editable header, after a confirmation).
  - "Hide playlist" is local and permanent.
- User-visible strings go through `ui/src/i18n.ts` (`en` + `ja`, typed so a missing `ja` key fails `tsc`).
  The product name is "OpenSpot".
- Spotify playlist transfer is handed off to Soundiiz (Import page); there is no Spotify API code.
- Don't add controls that do nothing. If a provider can't do something (YouTube downloads, crossfade
  between a YouTube and a Plex song), report it through `Capabilities` and say why in the UI.
