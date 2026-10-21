# OpenMusic: YTSpot & PLEXSpot

Two Spotify-style desktop music clients built from one codebase:

- **YTSpot**: YouTube Music (`apps/ytspot`, identifier `app.openmusic.ytspot`)
- **PLEXSpot**: Plex Music (`apps/plexspot`, identifier `app.openmusic.plexspot`)

The product spec is in `docs/SPEC.md`. Progress and the prioritized backlog are in `TODO.md`, and the
design is in `docs/ARCHITECTURE.md`. **Read TODO.md first** when you resume work.

## Layout

```
crates/openmusic-core/   Rust: all shared logic (providers, DB, local files, Last.fm,
                         downloads, art cache, Tauri commands). `run(Flavor, ctx)` starts an app.
apps/{ytspot,plexspot}/src-tauri/   Thin app crates: main.rs + tauri.conf.json + icons + capabilities.
ui/                      React 18 + TypeScript + Vite 5 + zustand. One UI for both apps; it asks
                         Rust `app_info` for the flavor at startup.
assets/icons/            Source SVG/PNG for app icons (regenerate with `tauri icon`).
.github/workflows/       CI: tests and both NSIS installers on windows-latest (artifacts; release on tag v*).
```

## Commands

```bash
# Rust unit tests (no network)
cargo test -p openmusic-core
# UI
cd ui && npm ci && npm run typecheck && npm test && npm run build
# Run an app in dev (needs Windows/macOS/Linux desktop + WebView)
cd apps/plexspot/src-tauri && ../../../ui/node_modules/.bin/tauri dev
# Release installer (Windows) -> target/release/bundle/nsis/*.exe
cd ui && npm run build && cd ../apps/ytspot/src-tauri && ../../../ui/node_modules/.bin/tauri build
```

`tauri dev` uses `devUrl` http://localhost:1420. Start `npm run dev` in `ui/` first.

## Working in a cloud session (Linux, no display)

- `cargo test -p openmusic-core` and every `ui` npm script work on Linux. Building the Tauri app crates
  on Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.
  The `keyring` crate also builds there.
- Windows installers come from CI (`.github/workflows/build.yml`). Push to `main` and download the
  `ytspot-windows` / `plexspot-windows` artifacts, or push a tag `vX.Y.Z` to publish a GitHub release.
- Real provider accounts aren't available in CI. Never claim a provider flow is verified unless it
  ran against a real account. Parser tests use recorded JSON shapes.

## Conventions

- Rust model types in `model.rs` are mirrored by hand in `ui/src/types.ts`. Change both together.
- Every Tauri command lives in `commands.rs` and is registered in `lib.rs`. Add its wrapper to
  `ui/src/api.ts`.
- Ids are provider-aware: `plex:<ratingKey>`, `yt:<videoId|browseId>`, `local:<hash>`,
  `local-album:<artist>\u001f<album>`, `local-artist:<name>`, `app:<uuid>` (app playlists).
- Artwork is stored as `art://plex/<path>`, `art://url/<encoded>` or `art://local/<file>`. The UI resolves
  these with `artUrl()`, and `art.rs` serves them from a disk cache. Never store tokens in metadata.
- Secrets (Plex token/session, YouTube cookies, Last.fm keys/session) go in the OS
  credential store (`secrets.rs`), never in SQLite or settings.
- App playlists are SQLite-only. PLEXSpot never writes Plex/Plexamp playlists, and YTSpot never deletes
  remote playlists. "Hide playlist" is local and permanent.
- User-visible strings go through `ui/src/i18n.ts` (`en` + `ja`, typed so a missing `ja` key fails `tsc`).
- Spotify playlist transfer is handed off to Soundiiz (Import page); there is no Spotify API code.
- Don't add controls that do nothing. If a provider can't do something (YouTube downloads, YouTube
  crossfade), report it through `Capabilities` and say why in the UI.
