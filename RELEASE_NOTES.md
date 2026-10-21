# OpenMusic 1.0.0

First full release of YTSpot and PLEXSpot. Every build passes Windows unit tests, lint, 8 UI tests, and an
automated upgrade test on a clean Windows machine (0.1.0-beta.1 → 1.0.0, launch, uninstall).

**Not yet verified against real Plex or YouTube Music accounts** (CI has no provider accounts). The
checklist below lists what to try first; please report anything that breaks. Installation and
troubleshooting: [docs/INSTALL.md](https://github.com/knivesbatz/OpenMusic/blob/main/docs/INSTALL.md).

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
- Your Library: save albums (⊕ on album pages) and follow artists (Follow on artist pages); they appear
  under Albums / Artists in the sidebar. Saved in the app only, never changed on Plex or YouTube
- Local files, Plex downloads page, Spotify import with report, Last.fm settings, English/日本語,
  kana→romaji for lyrics and titles, artist names in your language (MusicBrainz aliases), accessibility (text size, reduced motion, contrast, keyboard), TV mode with
  Xbox/DS4/Switch controller navigation and "Launch at startup in TV mode"

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
12. **Saving**: save an album and follow an artist, check the sidebar filters, restart, unsave.
    **Translated names**: in Japanese, English artists with a Japanese alias show it (and the
    reverse in English); hover shows the original; Settings can turn it off.
    **Likes**: tracks you already liked in Plex / YouTube Music show as saved; toggling syncs back.
13. **Japanese**: Settings → Japanese text → Romaji / Both changes titles, artists and lyrics.
14. **TV mode**: controller D-pad/stick focus, A (select), B (back), X (queue), Y (fullscreen),
    LB/RB (previous/next), LT/RT (seek), Start (play/pause). Turn on "Launch at startup in TV mode",
    sign out of Windows and back in: the app should open fullscreen in TV mode.
15. **Install/uninstall**: install both apps side by side, uninstall one, the other keeps working.

## Known gaps / not finished
- Nothing has been verified against real accounts (no Plex server or Google account in CI).
- Kanji → romaji needs a dictionary; only kana is romanized for now.
- Translated names cover artists that have a MusicBrainz alias; album titles stay as published.
- Installers are unsigned, so SmartScreen warns ("More info" → "Run anyway"). Signing is wired in CI
  and activates when a certificate is added as a repository secret.
- Upgrading from 0.1.0-beta.1 keeps your playlists, settings, downloads and sign-in.
