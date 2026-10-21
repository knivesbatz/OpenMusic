# UI screenshots

Rendered from the production UI build in headless Chromium, with the mock backend in
`ui/e2e/mock-backend.js` standing in for the Rust commands. **The artists, albums, artwork and lyrics
are sample data, not a real Plex or YouTube Music library.**

| | |
|---|---|
| ![Home](home.png) Home: shortcuts, recently played, top tracks | ![Queue](queue.png) Queue with a Shift-click range selected |
| ![Album](album-menu.png) Album page with the track context menu | ![Artist](artist.png) Artist page |
| ![Fullscreen](fullscreen.png) Fullscreen player with synced lyrics | |

Regenerate: `cd ui && npm run build && npx vite preview --port 4173`, then
`PLAYWRIGHT=/path/to/playwright/index.mjs CHROMIUM=/path/to/chromium node e2e/screenshots.mjs http://localhost:4173/ ../docs/screenshots e2e/mock-backend.js`.
