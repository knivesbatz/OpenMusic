# UI screenshots

Rendered from the production UI build in headless Chromium, with the mock backend in
`ui/e2e/mock-backend.js` standing in for the Rust commands. **The artists, albums, artwork and lyrics
are sample data, not a real Plex or YouTube Music library.**

## Windows (1440×900)

| | |
|---|---|
| ![Home](home.png) Home: shortcuts, recently played, top tracks | ![Your Library](library.png) Your Library categories (YTSpot, Podcasts) |
| ![Album](album-menu.png) Album page with the track context menu | ![Artist](artist.png) Artist page |
| ![Queue](queue.png) Queue with a Shift-click range selected | ![Fullscreen](fullscreen.png) Fullscreen player with synced lyrics |
| ![Lyrics panel](lyrics-panel.png) Lyrics side panel with translations | ![Saved in](saved-in.png) "Saved in" panel (YTSpot) |

## Android (phone)

| | | | |
|---|---|---|---|
| ![Home](phone-home.png) Home | ![Library](phone-library.png) Your Library: Music / Podcasts (YTSpot) | ![Albums](phone-albums.png) Albums | ![Song screen](phone-player.png) Song screen |

Regenerate: `cd ui && npm run build && node e2e/screenshots.mjs ../docs/screenshots`
(`CHROMIUM=/path/to/chromium` to use a preinstalled browser).
