# OpenMusic 0.1.0-alpha.1 — first runnable build

**Pre-release. Not verified against real Plex or YouTube Music accounts yet.** These installers are
for testing the shell, navigation and playback engine on Windows.

## Downloads
- `YTSpot_*_x64-setup.exe`: YouTube Music client (`app.openmusic.ytspot`)
- `PLEXSpot_*_x64-setup.exe`: Plex client (`app.openmusic.plexspot`)

They install per user, side by side, with separate data and credentials. If WebView2 is missing, the
installer downloads it.

## What's in this build
- Spotify-style shell: library sidebar (filters, search, sort, collapse), top bar with back/forward and
  search, home, search, artist (popular, discography filters, fans also like, appears on), album and
  playlist pages
- Bottom player bar: art, title/artist, save/like, add to playlist, shuffle, previous/play/next, repeat
  (off/all/one), seek, quality badge, lyrics, queue, volume, mini player, fullscreen
- Queue panel: Now playing / Next in queue / Next from…; click, Ctrl-click, Shift-click range, Ctrl+A,
  Delete removes, drag to reorder (multi-selection keeps order), clear queue
- Context menu: add to playlist (+ new), remove from this playlist, like, add to queue, play next, sleep
  timer, song radio (YouTube), go to artist/album, view credits, share (copy)
- Fullscreen player with synced lyrics (LRCLIB) beside the artwork; resizable always-on-top mini player
- Playback engine: two-deck `<audio>` with gapless preload, 0–12 s equal-power crossfade, Automix (no
  fades inside an album); YouTube through the official IFrame player
- App playlists (SQLite, separate from Plex/Plexamp), YTSpot permanent hide with no-undo confirmation
- Local files, Plex downloads page, Spotify import with report, Last.fm settings, English/日本語,
  kana→romaji for lyrics, accessibility (text size, reduced motion, contrast, keyboard), TV mode with
  Xbox/DS4/Switch controller navigation

## Please test
1. **PLEXSpot sign-in**: Plex PIN sign-in, server list, server selection, reconnect after restart.
2. **YTSpot sign-in**: Google sign-in window closes by itself and the library loads.
3. **Playback**: Plex streams at each quality; YouTube IFrame playback (some videos block embedding);
   local files; next/previous, seek, repeat and shuffle.
4. **Crossfade, gapless, Automix** on Plex/local tracks.
5. **Queue**: Shift-click ranges, drag reorder of several rows, Delete key, clear queue, restart restores
   the queue.
6. **Mini player**: resize, controls, closing it doesn't stop music.
7. **Fullscreen + lyrics**: synced highlighting, click a line to seek, Esc exits.
8. **Downloads (Plex)**: song/album/playlist downloads, cancel, retry, offline playback after restart.
9. **Spotify import**: Client ID + redirect `http://127.0.0.1:43117/callback`, the report, and adding
   "needs review" rows.
10. **Last.fm**: connect, now playing, scrobble after half the track / 4 minutes, no duplicates.
11. **Local files**: add folder, rescan, missing files.
12. **TV mode**: controller D-pad/stick focus, A/B, LB/RB, Start.

## Known gaps / not finished
- Nothing has been verified against real accounts (no Plex server or Google account in CI).
- "Launch at startup" for HTPC mode isn't wired yet (the TV-mode layout and controller input are).
- Kanji → romaji needs a dictionary; only kana is romanized for now.
- Translated artist/album names need a licensed metadata source (not started).
- No UI end-to-end tests yet (Playwright).
- Installers are unsigned, so SmartScreen will warn.
