# OpenMusic 1.0.3

Settings and scrolling freeze fix, Autoplay, close to tray, playlist folders, full search results,
and local files mixed into search and artist pages.

## New in 1.0.3
- **Settings / scrolling freezes and crashes**: everything the Settings page and lists ask the app
  for (Last.fm status, launch at startup, saving settings, library data, …) now runs in the
  background. Before, some of it ran on the window's own thread; when one of those requests was
  slow, the window stopped responding and Windows closed it, without leaving a crash log.
- **Autoplay** (Settings → Playback, off by default): when your music ends, keep playing similar
  songs: YouTube Music radio in YTSpot, sonically similar tracks in PLEXSpot (random tracks from
  your library if the server hasn't analysed it), random songs for local files.
- **Close to tray** (Settings → Window, off by default): the close button hides the window and
  music keeps playing. A tray icon (always shown) has Show, Play/Pause, Previous, Next and Quit;
  clicking it shows or hides the window.
- **Playlist folders and custom order**: create folders in Your Library, drag playlists into them,
  and drag to reorder; the sort button cycles Recents / Alphabetical / Custom order.
- **Full search results**: the Songs, Albums, Artists and Playlists chips show complete result
  lists instead of the top few.
- **Local files in search and artist pages**: songs and albums from your local folders whose
  metadata matches appear inside search results, Popular and Discography.
- **Spotify playlists via Soundiiz**: Import now walks you through Soundiiz, which copies Spotify
  playlists to YouTube Music or Plex; no Spotify developer setup.
- Publisher shown as マッキニー マイヤ in Windows (Apps list, installer) and at the bottom of Settings.
- Android (preview, not released yet): background playback with a media notification and lock
  screen controls. The APK is built in CI only.

## Also in 1.0.2
- Settings dropdowns drawn by the app instead of native Windows popups.
- **Safe mode**: if the app didn't close properly, the next launch turns off the web view's GPU
  acceleration automatically and tells you (Settings → Performance → Hardware acceleration).
- Removed the live blur behind the top bar and the full-screen blur.
- **YouTube Music songs, not music videos**: music videos play their YouTube Music song version and
  show its title, album art and official artist; search leaves music videos out of song results.
  Titles of videos without a song version drop tags like "(Official Music Video)", "[Lyric Video]",
  "【MV】" or "- Official Audio", without touching words in the real title.

## Also in 1.0.1
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
- Local files, Plex downloads page, Spotify playlist transfer via Soundiiz, Last.fm settings, English/日本語,
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
9. **Spotify transfer**: Your Library → Transfer playlists opens Soundiiz; after the transfer, Sync
   now shows the playlists.
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

16. **Settings** (1.0.3 fix): click through every switch, dropdown and slider, scroll long
    lists and pages. If the app still closes, attach `crash.log` and, from Event Viewer → Windows
    Logs → Application, any error from YTSpot/PLEXSpot or msedgewebview2.
17. **Autoplay**: turn it on, play the last song of an album; similar songs follow (crossfade and
    gapless included). Turn it off: playback stops at the end.
18. **Close to tray**: turn it on, close the window; music keeps playing, the tray icon brings the
    window back, its menu controls playback and Quit exits.
19. **Playlist folders**: create, rename, drag in/out, reorder; restart keeps the order.

## Known gaps / not finished
- Nothing has been verified against real accounts (no Plex server or Google account in CI).
- Kanji → romaji needs a dictionary; only kana is romanized for now.
- Translated names cover artists that have a MusicBrainz alias; album titles stay as published.
- Installers are unsigned, so SmartScreen warns ("More info" → "Run anyway"). Signing is wired in CI
  and activates when a certificate is added as a repository secret.
- Upgrading keeps your playlists, settings, downloads and sign-in.
