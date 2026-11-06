# Installing and troubleshooting OpenSpot

## Requirements
- Windows 10 (1803 or later) or Windows 11, 64-bit.
- Microsoft Edge WebView2 Runtime. It ships with Windows 11 and current Windows 10; if it is missing,
  the installer downloads it (needs an internet connection during setup).
- For Plex: a Plex account and a Plex Media Server with a music library you can access.
- For YouTube Music: a Google account, or none (anonymous browsing and playback). YouTube Music
  Premium is not required.
- Neither is needed for your own music files.

## Install
1. Download `OpenSpot_<version>_x64-setup.exe` from the
   [Releases](https://github.com/knivesbatz/OpenMusic/releases) page.
2. Run the installer. It installs for the current user only (no administrator rights needed) into
   `%LOCALAPPDATA%\OpenSpot`, and adds Start menu and desktop shortcuts.
3. The installers are not code-signed yet, so SmartScreen may show "Windows protected your PC". Choose
   **More info → Run anyway**.

Sign in to YouTube Music, Plex or both on first start ("Connect your music"), or later under
Settings → Services. Each service has an on/off switch there.

## Upgrade
Run the newer installer; it replaces the program files and keeps your data (playlists, settings,
downloads, sign-in).

CI installs the new build on a clean Windows runner for every build, launches it and uninstalls it
again.

## Uninstall
Settings → Apps → Installed apps → OpenSpot → Uninstall (or run `uninstall.exe` in the install
folder). Your data is kept in case you reinstall, unless you tick "Delete app data". To start completely fresh, see below.

## Where data lives
| What | Location |
|---|---|
| Library database (app playlists, history, hidden playlists, saved albums/artists, settings) | `%APPDATA%\app.openmusic.ytspot\library.db` |
| Offline downloads (Plex) | `%APPDATA%\app.openmusic.ytspot\downloads` |
| Artwork cache | `%LOCALAPPDATA%\app.openmusic.ytspot\art` (bounded; Settings → Storage → Clear cache) |
| Sign-in tokens and cookies, Last.fm keys | Windows Credential Manager → Windows Credentials, entries named `app.openmusic.ytspot` |

The folder names still say `ytspot`: that's OpenSpot's internal identifier.

"Clear cache" removes artwork and metadata caches only. It never deletes app playlists, downloads or
your local music files.

## TV mode (HTPC)
Settings → TV mode turns on the large controller-friendly layout. "Launch at startup in TV mode" adds a
sign-in entry (visible in Task Manager → Startup apps) that starts the app full screen.

Controller (Xbox, DualShock 4, Switch Pro; standard layout): D-pad/left stick move focus, A select,
B back/close, X queue, Y full screen, LB/RB previous/next, LT/RT seek ±10 s, Start play/pause.

## Troubleshooting

**OpenSpot can't reach the Plex server.** The app tests all of the server's connections at once and uses
the best one that answers: local network first, then remote, then Plex relay. Check that the server is online in Plex Web, and that remote access is enabled if you're not
on the same network. Changing the server on the Plex card in Settings → Services re-runs the connection test.

**"Your session expired. Please sign in again."** Plex tokens and YouTube cookies can be revoked (for
example after a password change). Sign in to that service again from the prompt or Settings → Services. The other service keeps
working meanwhile.

**A YouTube track is skipped with "the owner does not allow playback in other apps".** Some videos
can't be played outside YouTube's own apps (embed restriction, errors 101/150). The app skips them.

**A song switches instead of crossfading.** OpenSpot blends YouTube songs with two YouTube players.
If YouTube pauses one player when the other starts, that transition becomes a quick switch. Songs
from different services (YouTube Music next to Plex or local files) never blend.

**Audio quality applies to Plex only.** YouTube picks the stream quality itself; third-party players
can't choose it.

**Moving playlists from Spotify.** Use Your Library → Transfer playlists (or the transfer button in the
top bar). It walks you through Soundiiz, which copies Spotify playlists to YouTube Music or to your
Plex server; press Sync now afterwards.

**Last.fm doesn't scrobble.** A track is scrobbled after you've listened to half of it or 4 minutes
(whichever comes first), and only tracks longer than 30 s. Scrobbles made while offline are queued and
sent later. Settings → Last.fm shows how many are waiting.

**The app closed unexpectedly.** Native crashes and UI errors are recorded in
`%APPDATA%\app.openmusic.ytspot\crash.log`; please attach it when reporting the problem.

**Plex shows someone else's library.** Switch Plex Home user on the Plex card in Settings → Services
(or click your name in the top bar → Switch profile). Protected users need their PIN.

**YouTube Music shows the wrong library.** If your Google account has several YouTube channels, pick
the right one on the YouTube Music card in Settings → Services (or click your name in the top bar →
Switch profile).

**Plex or YouTube Music content is missing.** Check that its switch is on in Settings → Services.

**Controller does nothing.** Press any button once while the app is focused; browsers only expose a
gamepad after its first input.

**Start fresh.** Uninstall, delete the `app.openmusic.ytspot` (and any `app.openmusic.plexspot`)
folders in `%APPDATA%` and `%LOCALAPPDATA%`, and remove the entries with those names from Credential
Manager.

## Building from source
See the Commands section of [CLAUDE.md](../CLAUDE.md). Installers are built by
`.github/workflows/build.yml`; run it with a `release_tag` input to publish a GitHub release.
