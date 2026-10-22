# OpenMusic — YTSpot & PLEXSpot

Two Spotify-style music players for **Windows** and **Android**, sharing one Rust + Tauri 2 core and one React UI:

- **YTSpot**: a YouTube Music client (`apps/ytspot`)
- **PLEXSpot**: a Plex Music client (`apps/plexspot`)

**Download:** [latest release](https://github.com/knivesbatz/OpenMusic/releases/latest). It has the Windows installers (`*_x64-setup.exe`) and Android APKs (`*_android-arm64.apk`). The Windows apps update themselves from the latest release.

## Screenshots

### Windows

![PLEXSpot home](docs/screenshots/home.png)

| | |
|---|---|
| ![Your Library](docs/screenshots/library.png) Your Library: classic categories, including YTSpot podcasts | ![Artist](docs/screenshots/artist.png) Artist page |
| ![Queue](docs/screenshots/queue.png) Queue | ![Fullscreen](docs/screenshots/fullscreen.png) Fullscreen player with synced lyrics |
| ![Lyrics panel](docs/screenshots/lyrics-panel.png) Lyrics in the side panel, translated line by line | ![Saved in](docs/screenshots/saved-in.png) "Saved in": Liked Songs and playlists, including your YouTube playlists |

### Android

| | | | |
|---|---|---|---|
| ![Home](docs/screenshots/phone-home.png) | ![Library](docs/screenshots/phone-library.png) | ![Albums](docs/screenshots/phone-albums.png) | ![Song screen](docs/screenshots/phone-player.png) |
| Home | Your Library: Music / Podcasts | Albums | Song screen |

Screenshots are rendered with sample data. More are in [docs/screenshots](docs/screenshots/README.md).

## Features

- Spotify-style home, search (top result, songs, artists, albums, playlists), artist pages and playlists
- Your Library: Recently played, Albums, Artists, Podcasts and Your Episodes (YTSpot), Local files, Downloads (PLEXSpot)
- Crossfade and gapless playback, autoplay of similar songs, and a full queue editor
- Synced lyrics: embedded or from Plex first, then looked up online (LRCLIB, NetEase); no API keys needed
- Lyrics and other-script titles translated into your language (English or Japanese)
- Playlist sorting that sticks, "Saved in" checkboxes for Liked Songs and playlists, export to text for Soundiiz
- Custom playlist covers, local playlists and folders, local files
- Last.fm scrobbling (off by default) and Discord Rich Presence
- TV mode for controllers and remotes, a mini player and a tray icon on desktop
- English and Japanese

## Development

See `CLAUDE.md` for commands, `TODO.md` for the backlog and `docs/ARCHITECTURE.md` for the design.
