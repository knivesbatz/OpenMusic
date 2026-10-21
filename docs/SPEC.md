# Product specification (condensed from the original brief)

The original brief (`Prompt.docx`) and the visual reference (`ytspot-plexspot.pdf`) are kept out of the
repo. This file records every requirement from both so work can continue without them.

## Goal

Two polished, production-quality desktop music clients (Android is a later stretch) that reproduce
Spotify's desktop layout, navigation, library organisation, playback controls and queue, powered by
the user's own music:

1. **YTSpot**: YouTube Music library and player.
2. **PLEXSpot**: Plex Music library and player.

Both are independently installable Windows apps (separate ids, data dirs, credentials, settings and
installers) that share as much engineering as possible. They must be extremely optimized and use
Spotify's colours: **#1DB954 green** and **#191414 black**, plus charcoal/grey surfaces and white/grey text.
Use original names, icons and branding, and never present either app as an official Spotify product.
Rust is preferred, with Tauri 2 + React/TS + SQLite as the suggested stack.

## Development principles

Real working integrations beat pretty mockups. Stay responsive with tens of thousands of tracks. Make
all I/O async. Handle lost connections, expired auth, unavailable tracks and interrupted downloads
gracefully. Keep code modular and strongly typed. No placeholder controls. Never fake integration
results or claim unverified features work. Keep a prioritized task list (`TODO.md`) and test as you go.

## Layout

- **Left sidebar**: Home, Search, Your Library (saved playlists, albums, artists, user-created
  playlists), expandable/collapsible.
- **Main area**: Home recommendations, recently played music/playlists, favourite artists, saved
  albums, recommended playlists, plus artist, album, playlist, podcast and search pages.
- **Bottom player bar**: artwork, title, artist, add-to-playlist/save, favourite, previous, play/pause,
  next, shuffle, repeat, seek bar with times, quality/status, queue, volume, fullscreen, picture-in-picture.
- **Do NOT implement Spotify's "Now Playing" side view.** The queue, the custom **fullscreen player** and
  the **resizable picture-in-picture** player are all required.
- Context menu (from the PDF): Add to playlist ▸, Remove from this playlist, Add to Liked Songs, Add to
  queue, Sleep timer ▸, Go to song radio, Go to artist, Go to album, View credits, Share ▸.

## Providers

- **YTSpot**: sign in to YouTube/YouTube Music. Library (playlists, albums, artists, tracks), search,
  artwork/metadata, playback by a supported method, **podcast channels and episodes**, library sync,
  Spotify playlist import, and **permanently hide playlists** (context menu, a no-undo warning, explicit
  confirmation, persisted, excluded from search, recommendations and library, survives sync, never deletes
  anything remotely). Investigate official APIs first, isolate unofficial integrations behind an adapter,
  and document the limitations.
- **PLEXSpot**: Plex account auth, server discovery and selection, music library browse
  (artists/albums/tracks/playlists), search, streaming, artwork, **fast optimized sync** of library and
  listening state, disconnect/reconnect handling without losing local state, download availability.
  **App playlists must be separate from Plexamp playlists.**
- A common provider interface (search, browse, metadata, artwork, library, playback, playlist contents,
  sync, capabilities, downloads). Unsupported features degrade gracefully.

## Home

Recently played albums, tracks and playlists. Saved artists and favourite albums. Recommendations from
history and library. Shortcuts to frequent content. Provider recommendations where a real source exists,
otherwise local recommendations, without pretending a proprietary engine exists. Cache it so later
launches load fast.

## Search

Songs, artists, albums, playlists, plus podcasts/channels/episodes in YTSpot. Search-as-you-type with
debounce, keyboard navigation, Enter-to-search, grouping/filters, loading/empty/error/offline states,
thumbnails, context menus, playable results, cached repeat searches, and suppression of stale requests.

## Library and playlists

Saved artists, albums, playlists, app-created playlists, local files and playlists mixing them. Create,
rename and delete playlists. Add, remove and reorder tracks. Add-to-playlist controls in search, album,
artist and playlist pages, context menus and the player bar. Use stable provider-aware ids. Unavailable
tracks never corrupt playlists.

## Spotify import

Official Spotify sign-in (PKCE). Pick playlists, match tracks against the destination provider using
title, artist, album and duration with conservative matching, preserve order, and report imported,
duplicate, ambiguous and unresolved tracks. **Skip tracks not in the user's Plex library.** Never substitute
an obviously different track. Never stream Spotify audio.

## Playback engine

Centralised. Play/pause, previous/next, seek, volume, shuffle, repeat off/all/one, continuous queue
playback, quality selection, gapless where possible, **crossfade 0–12 s (required)**, Automix where
possible, accurate position/duration, persisted settings, and recovery from failures. State stays
consistent across navigation, fullscreen and PiP. Never claim gapless, crossfade, Automix or quality
selection works where the source can't support it. Quality options: **Automatic, Low, Medium, High**,
using real provider controls or explaining when the provider decides.

## Queue (PDF reference: Spotify mobile queue)

"Now Playing" row, a "Next In Queue" section with a **Clear queue** button, then "Next From: <context>".
Rows have selection circles and drag handles. View, add, play now, remove, **drag-reorder**,
**multi-select**, **Shift-click range select**, remove many at once, context menu. Virtualise long queues.
Removing from the queue never touches playlists.

## Fullscreen player (PDF reference)

Large artwork, title, artist, album, controls, seek, shuffle/repeat, queue access, add-to-playlist, and
**synced lyrics to the right of the artwork** when there's room. Responsive layout, same playback session.

## Picture-in-picture (PDF reference)

Independent, **resizable**, always-available window. A top bar with a settings icon on the left, a drag grip
in the middle and close on the right. Large artwork, bold title, artist, and a green "saved" check. The
compact form shows art, title, artist, a check, a device/speaker icon, prev, a white circular play button,
and next. It includes a progress indicator and a way back to the main window. Closing it never stops playback,
and it never spawns a second audio engine.

## Local files

Choose folders and scan supported formats asynchronously. Read tags and embedded art. Show
albums/artists/tracks. Add to playlists and play. Handle missing files and disconnected drives.
Refresh incrementally and avoid duplicates.

## Offline and caching

Download songs, playlists and albums when the provider and authorization allow it. Show progress,
completed, failed, cancel/retry, offline availability and storage use, and warn before large
downloads. No duplicates and no partial files treated as complete. Distinguish cached
metadata/artwork, local files, downloaded audio and online-only tracks. Never bypass DRM or
provider limits, and show the feature as unavailable instead.

## Last.fm

Auth, scrobbling by Last.fm rules, now-playing, correct metadata, dedupe, retry, an on/off setting
and a status display. Independent of playback.

## Localisation and Japanese support

Full **English and Japanese** UI, switchable at runtime. Show translated artist and album names where an
accurate source exists, keeping the originals as a fallback and never overwriting ids. **Romaji**
display (script / romaji / both). Synced lyrics with current-line highlight and auto-scroll, a fullscreen
lyric presentation, Japanese plus romanized lyrics, and translations only where licensed. Never fake
timestamps.

## Accessibility

Keyboard navigation, visible focus, screen-reader labels, tooltips on icon buttons, contrast,
adjustable text size, reduced motion, accessible dialogs, and keyboard-operable menus and queue.

## HTPC mode (from the PDF)

"Implement a HTPC mode that you can set to launch at startup with native Xbox, DS4, and Switch
controller support."

## Performance

Lazy views and art, virtualised lists, incremental sync, DB indexes, art caching, request
cancellation and concurrency limits, debouncing, request dedupe, bounded caches, fast startup, no
needless polling, and no full sync on every Home visit.

## Persistence

Versioned SQLite migrations: settings, library metadata, app playlists, queue, history, hidden
playlists, downloads and cache. Credentials go in the OS credential store. Clearing caches never deletes
user playlists or local files.

## Release

Two NSIS installers, separate identities and storage, icons, version info, and a repeatable build.
Document prerequisites (WebView2). Test, lint and release-build before calling a milestone done, and
record failures honestly.

## Definition of done (initial RC)

Both apps build separately. Navigation is wired to real state. Auth works with each provider. Playback
is verified. Search, library and playlists work. The queue handles selection and reorder. The player bar
stays consistent. Fullscreen and PiP work. Local files play. Spotify import reports unmatched tracks.
Offline recovers safely. Last.fm, localisation and accessibility are tested. State survives restarts.
Installers exist. Limitations are documented.
