# OpenMusic 1.0.1

Fixes for crashes and issues reported on 1.0.0, plus YouTube crossfade and Plex profiles.

## New in 1.0.1
- **Crash fix (scrolling, opening pages, settings)**: artwork is now served by a small local web server
  inside the app (127.0.0.1 only, with a random per-launch key in every URL) instead of a custom
  protocol. Image requests cancelled while scrolling or switching pages, a likely cause of the crashes,
  are now routine. If the app still closes unexpectedly, `crash.log` in the app data folder now records
  UI errors too; please attach it.
- **No more blank window on UI errors**: the whole app, not only pages and the fullscreen player, now
  shows an error message with Retry instead of disappearing.
- **YouTube crossfade and song blending**: YTSpot now crossfades (0–12 s, equal-power) and supports
  Automix and near-gapless playback, using two YouTube players: the next song is cued silently and
  faded in. Some videos may switch instead of fading if YouTube pauses the other player.
- **Plex profiles**: PLEXSpot can switch between Plex Home users (with PIN for protected users) from the
  profile picker, Settings → Account → Switch profile, or by clicking your name in the top bar. It asks
  once after sign-in when the account has several users.
- **Last.fm fixes**: no duplicate scrobbles when two tracks finish close together; repeat-one replays are
  scrobbled; music videos scrobble the official artist (not the uploader); scrobbles that failed while
  offline are retried every 10 minutes; a revoked Last.fm session now shows a message and reconnect
  button instead of failing silently.

## Also in 1.0.0 (fixed since 0.1.0-beta.1)
- **YTSpot profiles**: Google accounts with several YouTube channels (brand accounts) can pick which
  channel's library to use: asked once after sign-in, and any time from Settings → Account →
  Switch profile or by clicking your name in the top bar.
- **Album art instead of video thumbnails**: YouTube music videos now show their song's square album
  art (and official artist/album) everywhere, including the player bar, fullscreen and mini player.
- **Correct artist names**: artist names are no longer replaced by abbreviations (e.g.
  "My Chemical Romance" showing as "MCR"); translated names only apply across scripts (Japanese ↔
  Latin) and never use MusicBrainz search hints. Music videos use the official artist.
- **Album pages**: show the album cover (not the artist photo); track rows show the artist (linked to
  the artist page) instead of the play count.
- **Fullscreen player**: no longer switches Windows into fullscreen automatically;
  the player fills the app window, with a separate "Fill the screen" button. A display error now
  shows a message with Retry/Close instead of taking down the app, and native crashes are written
  to `crash.log` in the app data folder.
- Upgrading clears cached YouTube metadata once so the fixes show immediately.

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
1. **PLEXSpot sign-in**: Plex PIN sign-in, Plex Home profile picker (and PIN), server list, server
   selection, reconnect after restart.
2. **YTSpot sign-in**: Google sign-in window closes by itself, the profile picker appears if your
   account has several channels, and the chosen channel's library loads.
3. **Playback**: Plex streams at each quality; YouTube IFrame playback (some videos block embedding);
   local files; next/previous, seek, repeat and shuffle.
4. **Crossfade, gapless, Automix** on Plex/local tracks and on YouTube songs (YTSpot).
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
- Upgrading keeps your playlists, settings, downloads and sign-in.
