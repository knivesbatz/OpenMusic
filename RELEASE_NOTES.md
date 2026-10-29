# OpenMusic 1.2.5

An optional Windows 95 theme, and artist discographies in release order with a Compilations tab.

## New in 1.2.5
- **Windows 95 theme** (Settings → Appearance → Theme): the whole app in the classic look:
  - grey bevelled windows on a teal desktop, with a navy caption showing the app's name (Windows)
  - raised buttons that press in, latched toggle buttons, and an extra black frame on default buttons
  - sunken white text boxes and drop-downs, check boxes instead of switches, and track-bar sliders
  - 16-pixel scroll bars with a checkered track and arrow buttons
  - menus with navy highlights and etched separators, and pale yellow tooltip-style messages
  - track lists as white list views with raised column headers
  - the player bar as the taskbar
  It uses Windows' own MS Sans Serif where it's installed. The full-screen player and song screen
  stay dark. Switch back to "Default (dark)" at any time.
- **Discography in release order**: on artist pages, Albums, Singles and EPs, and Popular
  releases now list the newest release first, like Spotify (they followed the provider's order).
- **Compilations tab**: best-ofs, rarities and singles collections get their own tab next to
  Singles and EPs instead of mixing with the albums. YouTube Music doesn't say which albums are
  compilations, so the app checks MusicBrainz's list of the artist's compilations (once a month
  per artist) and titles that say so ("Greatest Hits", "Best of", "… Collection"). PLEXSpot uses
  the album type from your library too (compilations were under Appears on before).

## Also in 1.2.4
- **Normalize volume** (Settings → Playback): evens out loudness between songs, like Spotify.
  Loud songs are turned down to the level you pick: Quiet, Normal or Loud. It uses Plex's
  loudness analysis and ReplayGain/R128 tags in your files (local files and downloads); songs
  without loudness information play as they are. YouTube songs are already evened out by
  YouTube's own player, so in YTSpot it applies to your local files. Off by default.
- **Fixed: the next song sometimes played without sound.** Three causes, all fixed:
  - When a song ended or a crossfade started while the next song's stream was still being looked
    up, the player switched to a deck that had nothing loaded.
  - During a crossfade, the song after next was loaded into the deck still playing the outgoing
    song, cutting it off.
  - With the app in the background (or the window minimized), crossfades advanced only as fast as
    the system let the page's timers run, so the new song could stay nearly silent for minutes.
    Fades now follow the clock and the audio itself, and a song outside a fade is always put back
    to its proper volume.

## Also in 1.2.3
- **Widgets fit their size.** On Android 12 and later the widgets switch layouts as you resize
  them, and covers and buttons grow or shrink to fill the space:
  - **Now playing**: one row (cover, song, play/pause and next, plus previous and the app icon
    when there's room); a square card with the cover on top at about 2×2; and a big cover with
    large controls when it's wide and two rows or taller.
  - **Recently played**: just the latest album or playlist when short; otherwise three to five
    covers underneath that fill the rest of the widget.
  Older Android versions pick the layout that fits when the widget is placed or resized.
- **Play/pause on both widgets**: Now playing keeps play/pause at every size, and Recently
  played now has its own play/pause button. With the app closed, it opens the app and plays.

## Also in 1.2.2
- **Android home screen widgets** (both apps; long-press the home screen → Widgets):
  - **Now playing**: the cover, song and artist with previous, play/pause and next, on a card
    tinted with the cover's colour. Tap the song to open the app. It follows the music in the
    background, and after the app is closed it keeps the last song: play then opens the app
    and carries on.
  - **Recently played**: what you played last, with a row of your recent albums and playlists
    underneath. Tap any of them to open it in the app.
  - Both resize: a narrow Now playing widget drops the app icon, then the previous button;
    Recently played shows three to five covers depending on the size, or just the latest one
    when it's short.

## Also in 1.2.1
- **Spotify-like animations** on desktop and phones:
  - pages rise in
  - cards and shortcuts arrive one after another, and lift when you point at them
  - album and playlist headers grow in
  - play and pause swap with a little spin, and the heart pops when you like a song
  - a new song slides into the player bar
  - the queue and lyrics panels slide in
  - menus and dialogs scale in
  - the song that's playing shows bouncing bars instead of its number
  - on the phone's song screen the cover eases back while paused
  - buttons grow slightly on hover and give way when pressed; loading spinners only appear
    when loading takes a moment

  "Reduce motion" in Settings (or the system setting) turns all of it off.
- **Icons in menus**: every right-click and ••• menu (songs, playlists, albums, artists, folders,
  podcasts, the title bar menu) shows an icon next to each action.
- **Liked Songs from the menu, for many songs at once**: select songs (Shift/Ctrl-click) in a
  playlist, album or the queue and choose "Add N to Liked Songs" (or "Remove N"). Playlists and
  albums have "Add all to Liked Songs", and "Add to playlist" lists Liked Songs first.
- **YTSpot: your own cover for YouTube playlists**: click a playlist's cover (or ••• → Change
  cover) and pick an image. The cover is kept in the app only; YouTube keeps its own thumbnail,
  and "Use YouTube's cover" switches back.

## Also in 1.0.10
- **Android: the media notification follows the music in the background.** When the next song
  started with the app in the background, the notification kept showing the old song, and its
  buttons (also lock screen, headset and car controls) did nothing until you opened the app. The
  player and the notification now talk to each other directly, so song changes show right away
  and Pause, Play, Next and Previous work from anywhere.
- **Android: music pauses when headphones or a Bluetooth device disconnect**, instead of carrying
  on through the phone's speaker. Both apps.
- **Android updates** need every version signed with the same key; until now each build had a
  new one, so Android refused to install an update over the app. Once the project's signing key
  is set up, updates install over the app and keep your sign-in, downloads and settings.

## Also in 1.0.9
- **Modern title bar on Windows**: the plain Windows frame is replaced by one bar like Spotify's
  desktop app. It has a ••• menu, back and forward, Home and search in the middle, and What's New,
  playlist transfer and settings on the right, with minimize, maximize and close at the end. Drag
  any empty part to move the window; double-click it to maximize.
- **What's New**: a feed of new albums and singles from the artists you follow (this year and
  last), plus the latest releases in your Plex library or YouTube Music's new releases. Open it
  from the bell in the top bar, from Your Library, or from Search. The feed is fetched again at
  most once an hour; Sync refreshes it now.
- **Multi-disc albums are split by disc**, with a "Disc 1", "Disc 2"… heading over each disc's
  songs. Playing a song still plays on through the whole album.
- **Search inside a playlist**: the magnifier next to a playlist's sort menu filters its songs by
  title, artist or album. Esc closes it.
- **Player bar like Spotify's**: a thicker seek bar with a round handle, a time bubble while you
  hover or drag, the remaining time on the right, and chunkier skip buttons.
- **PLEXSpot: Albums and Artists show only what you saved**, not every album and artist on the
  server. Browse the whole server from Search or an artist page.

## Also in 1.0.8
- **New typeface: Figtree**, a geometric sans close to Spotify's look, bundled with the app so it
  renders the same on Windows and Android. Titles are heavier and tighter, body text is lighter,
  and times use even-width digits. Japanese text still uses the system's Japanese fonts.
- **Thicker, rounder controls**: bolder icons with rounded ends; chunkier pill buttons and chips;
  rounder menus, dialogs, cards and rows; a soft circle behind icon buttons on hover.
- **More comfortable on phones**:
  - bigger tap targets for icon buttons
  - the current tab reads bolder
  - a larger, rounded cover and a bolder title on the song screen
  - pages no longer bounce or overscroll
- **Sort albums and artists in Your Library**: Albums can be sorted by Recently added,
  Alphabetical, Artist (each artist's albums oldest first) or Release date; Artists by Recently
  added or Alphabetical. Pick the same option again to reverse it. "The" is ignored when sorting
  names, and your choice is remembered until you change it. On phones the sort button sits above
  the Albums and Artists lists; on desktop next to the filter.

## Also in 1.0.7
- **Android: leaving the app no longer pauses the song.** Swiping home or to another app paused
  the app's web view, which stopped the song (and YouTube's mobile player pauses pages that
  aren't on screen). The app now keeps its player running in the background and picks a song
  back up if it was paused on the way out. Pausing from the notification, headphones or the app
  still works as before.
- **Cleaner, more comfortable phone layout**:
  - The top bar no longer shows a search field on every page. Home and Your Library show your
    account button (Settings), and other pages a back button, plus the page's name once you scroll.
  - Home shortcuts show two-line titles instead of cutting names off.
  - Shelves use bigger covers.
  - Taps give a small press effect.
  - The mini player takes on the colour of the song's cover.
  - The tab bar fades over the content.
  - Search opens with colourful "Browse your library" tiles (also on desktop).
  - The playlist sort button is icon-only on phones.
  - The current lyric line on the song screen is quieter.
  - Settings controls move under their labels instead of squeezing them.
- **Smaller artwork cache**: covers are now shrunk to the size they're shown at and stored as
  compact JPEGs (usually many times smaller than before), YouTube Music art is downloaded at that size,
  and each cover is kept at only a few sizes. The cache limit is now 256 MB. The old cache of
  full-size images is cleared once after updating; covers download again as you browse.

## Also in 1.0.6
- **YTSpot Android: fix for the crash after entering your password.** While YouTube Music loaded
  after sign-in, the app asked the web view for its cookies and address every second; when the
  phone was busy for more than 10 seconds those requests timed out and the web view library
  crashed the app. Sign-in now follows page loads and reads cookies through the app itself.
- **Translated lyrics**: lyrics in another language get a translation under each line, in
  English or Japanese to match the app (Settings → Language, "Translate lyrics"). Free, no
  account or key; each song is translated once and remembered.
- **Names in your language**: song and album titles written in another script (e.g. Japanese
  titles in the English app) are shown translated, with the original when you hover. YTSpot
  also reloads YouTube Music in the new language when you switch.
- **Playlist sorting that sticks**: Sort by Custom order, Title, Artist, Album, Recently added,
  Release date or Duration (tap again to reverse), and View as List or Compact. Each playlist
  keeps its sort until you change it.
- **"Saved in"**: the heart likes a song in one tap; on a liked song, or with +, it opens a
  list of Liked Songs and your playlists with checks to add or remove the song. YTSpot also
  lists your own YouTube playlists, so you can add songs to them (and remove them) from here.
- **Lyrics open in a side panel** instead of jumping to fullscreen; its expand button goes
  fullscreen.
- **Sleep timer button** next to Queue (green while set; hover for the time left).
- **Resizable panels**: drag the edge of the library sidebar or the right panel (queue/lyrics);
  the width is remembered, double-click resets it.
- **Export playlists** (⋯ → Export): a text file of "Artist - Title" lines that Soundiiz and
  TuneMyMusic import, a CSV, or copy as text. The Transfer page now also explains TuneMyMusic.

## Not in this release
- **Offline downloads in YTSpot**: YouTube Music only plays through YouTube's own player, which
  can't save audio. Downloading would mean extracting streams the way unofficial downloaders
  do, which breaks often and goes against YouTube's terms, so YTSpot keeps saying why instead.
  PLEXSpot downloads are unchanged.

## Also in 1.0.5
- **Crossfade and the next song**: the next song now starts by itself (and crossfade works) on
  Windows and Android. The app's web view was blocking audio that didn't start from a click.
- **Search** works like Spotify: a top result, songs, then rows of artists, albums and playlists
  (YTSpot asks YouTube Music for each kind, so there are many more results).
- **Your Library** uses the classic Spotify categories. On desktop: Recently played, Liked Songs,
  Albums, Artists, Podcasts, Your Episodes, Local files and Downloads, then your playlists. On
  phones: **Music / Podcasts** with Playlists, Artists and Albums tabs.
- **Podcasts (YTSpot)**: follow shows, save episodes to **Your Episodes**, and a show page with
  About, episodes and dates.
- **Synced lyrics from the internet** (LRCLIB, then NetEase), no account or API key. They're only
  looked up when the song doesn't already have lyrics (embedded `.lrc`/tags or Plex lyrics).
- **Playlist covers**: click a playlist's cover (or use its menu) to pick your own image.
- **Automatic updates**: the Windows apps check GitHub for new versions, download them in the
  background and install when you close the app (or right away with "Restart now"). Settings →
  About has "Check for updates". Android shows a banner that opens the new APK.
- **YTSpot artists** show their subscriber count as followers, where Spotify shows monthly listeners.
- **Older albums on YTSpot**: artist pages load the whole discography, not only the newest releases.
- **Last.fm scrobbling is now off by default**. Turn it on in Settings after connecting Last.fm.
- **Cleaner, closer to Spotify**: heart buttons for likes, a playlist header in Spotify's style,
  the page title in the top bar when you scroll, light animations, and a playlist no longer
  starts playing when you click it.
- **Android**: covers load in PLEXSpot, the whole mini player opens the song screen, and YTSpot
  sign-in works (Google was rejecting the app's built-in browser).
- **TV mode**: arrow keys, remotes and controllers move between whole cards and rows reliably.
- "Music videos for you" and other video shelves no longer appear on YTSpot's Home.
- Fixed: the artist name overlapping the top bar when scrolling an artist page; artist circles
  stretching to giant sizes; PLEXSpot not asking which Plex Home profile to use after signing in;
  closing the app could hang.
- **New installer look**: branded installer artwork, in English or Japanese to match Windows.

## Also in 1.0.4
- **The freeze is fixed**: opening Settings asked for the Last.fm status in a way that locked the
  app's database twice and waited on itself forever. In 1.0.1/1.0.2 that froze the window; in
  1.0.3 the window survived but everything that needed the database afterwards (saving settings
  such as Crossfade or Automix, opening playlists, closing the app) waited forever. Found with
  an automated click-through of the real Windows app plus a new stall detector, which now also
  writes `crash.log` if anything ever stalls for more than 5 seconds.
- **Phone layout (Android)**: Spotify-style playlist page, song screen (color from the cover,
  current lyric line, elapsed/remaining time, lyrics card) and queue sheet (drag handles,
  Shuffle / Repeat / Sleep timer). Swipe down closes the song screen, queue and menus; swipe from
  the left edge or press Back to go back. Tapping the song in the player bar opens the song screen.
- **Android sign-in**: YouTube sign-in no longer hangs after logging in (and Google's pages get a
  "Back to the app" button); Plex sign-in happens inside the app and returns to it by itself.
- **Android**: background playback with a media notification and lock-screen controls; app icons;
  TV mode, mini player and "Fill the screen" are desktop-only.
- **TV mode** (desktop) now looks like Android TV / Google TV: top tabs, a banner, rows of large
  cards that grow when focused.
- Playlists no longer show "Synced from YouTube Music / Plex".
- Last.fm: the setup form explains the one-time API key and opens the Last.fm page. Builds made
  with the project's Last.fm key (repository secrets) show just "Connect Last.fm".

## Android preview
`YTSpot_*_android-arm64.apk` and `PLEXSpot_*_android-arm64.apk` (64-bit ARM phones). Allow
installing from your browser/files app when Android asks. Signed with a test key, so a later
build signed with the final key will need an uninstall first.

## Also in 1.0.3
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
