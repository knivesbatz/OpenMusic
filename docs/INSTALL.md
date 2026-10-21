# Installing and troubleshooting YTSpot and PLEXSpot

## Requirements
- Windows 10 (1803 or later) or Windows 11, 64-bit.
- Microsoft Edge WebView2 Runtime. It ships with Windows 11 and current Windows 10; if it is missing,
  the installer downloads it (needs an internet connection during setup).
- PLEXSpot: a Plex account and a Plex Media Server with a music library you can access.
- YTSpot: a Google account. YouTube Music Premium is not required to browse or play.

## Install
1. Download `YTSpot_<version>_x64-setup.exe` and/or `PLEXSpot_<version>_x64-setup.exe` from the
   [Releases](https://github.com/knivesbatz/OpenMusic/releases) page.
2. Run the installer. It installs for the current user only (no administrator rights needed) into
   `%LOCALAPPDATA%\YTSpot` or `%LOCALAPPDATA%\PLEXSpot`, and adds Start menu shortcuts.
3. The installers are not code-signed yet, so SmartScreen may show "Windows protected your PC". Choose
   **More info → Run anyway**.

The two apps are independent: they can be installed side by side, and each has its own settings,
library database, downloads and sign-in.

## Upgrade
Run the newer installer; it replaces the program files and keeps your data (playlists, settings,
downloads, sign-in). CI installs the previous release and then the new one on a clean Windows runner
for every build, launches the app and uninstalls it again.

## Uninstall
Settings → Apps → Installed apps → YTSpot/PLEXSpot → Uninstall (or run `uninstall.exe` in the
install folder). Your data is kept in case you reinstall; delete it by hand if you want a clean slate
(see below).

## Where data lives
| What | Location |
|---|---|
| Library database (app playlists, history, hidden playlists, saved albums/artists, settings) | `%APPDATA%\app.openmusic.ytspot\library.db` / `%APPDATA%\app.openmusic.plexspot\library.db` |
| Offline downloads (PLEXSpot) | `%APPDATA%\app.openmusic.plexspot\downloads` |
| Artwork cache | `%LOCALAPPDATA%\app.openmusic.<app>\art` (bounded; Settings → Storage → Clear cache) |
| Sign-in tokens and cookies, Last.fm and Spotify keys | Windows Credential Manager → Windows Credentials, entries named `app.openmusic.<app>` |

"Clear cache" removes artwork and metadata caches only. It never deletes app playlists, downloads or
your local music files.

## TV mode (HTPC)
Settings → TV mode turns on the large controller-friendly layout. "Launch at startup in TV mode" adds a
sign-in entry (visible in Task Manager → Startup apps) that starts the app full screen.

Controller (Xbox, DualShock 4, Switch Pro; standard layout): D-pad/left stick move focus, A select,
B back/close, X queue, Y full screen, LB/RB previous/next, LT/RT seek ±10 s, Start play/pause.

## Troubleshooting

**PLEXSpot can't reach the server.** The app tests all of the server's connections at once and uses
the best one that answers: local network first, then remote, then Plex relay. Check that the server is online in Plex Web, and that remote access is enabled if you're not
on the same network. Settings → Account → Change server re-runs the connection test.

**"Your session expired. Please sign in again."** Plex tokens and YouTube cookies can be revoked (for
example after a password change). Sign in again from the prompt or Settings → Account.

**A YouTube track is skipped with "the owner does not allow playback in other apps".** Some videos
can't be played outside YouTube's own apps (embed restriction, errors 101/150). The app skips them.

**A YouTube song switches instead of crossfading.** YTSpot blends YouTube songs with two YouTube
players. If YouTube pauses one player when the other starts, that transition becomes a quick switch.

**Audio quality setting is greyed out in YTSpot.** YouTube picks the stream quality itself; third-party
players can't choose it.

**Spotify import says "INVALID_CLIENT" or the browser shows a redirect error.** In your Spotify
developer app, add the redirect URI `http://127.0.0.1:43117/callback` exactly, then paste its Client ID.

**Last.fm doesn't scrobble.** A track is scrobbled after you've listened to half of it or 4 minutes
(whichever comes first), and only tracks longer than 30 s. Scrobbles made while offline are queued and
sent later. Settings → Last.fm shows how many are waiting.

**The app closed unexpectedly.** Native crashes and UI errors are recorded in
`%APPDATA%\app.openmusic.<app>\crash.log`; please attach it when reporting the problem.

**PLEXSpot shows someone else's library.** Switch Plex Home user under Settings → Account → Switch
profile (or click your name in the top bar). Protected users need their PIN.

**YTSpot shows the wrong library.** If your Google account has several YouTube channels, pick the right
one under Settings → Account → Switch profile (or click your name in the top bar).

**Controller does nothing.** Press any button once while the app is focused; browsers only expose a
gamepad after its first input.

**Start fresh.** Uninstall, delete the two `app.openmusic.<app>` folders above, and remove the
`app.openmusic.<app>` entries from Credential Manager.

## Building from source
See the Commands section of [CLAUDE.md](../CLAUDE.md). Installers are built by
`.github/workflows/build.yml`; run it with a `release_tag` input to publish a GitHub release.
