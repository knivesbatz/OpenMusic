// Mock Tauri backend for screenshots only. Sample data, not real provider content.
(() => {
  const hues = [[220, 40, 60], [12, 80, 40], [150, 60, 35], [280, 50, 45], [40, 85, 50], [190, 70, 40], [330, 60, 45], [100, 40, 35]];
  const art = (i, label) => {
    const [h, s, l] = hues[i % hues.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h},${s}%,${l + 15}%)'/><stop offset='1' stop-color='hsl(${(h + 40) % 360},${s}%,${l - 15}%)'/></linearGradient></defs><rect width='300' height='300' fill='url(#g)'/><text x='24' y='270' font-family='Segoe UI,Arial' font-size='34' font-weight='800' fill='rgba(255,255,255,.85)'>${label}</text></svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  };
  const albums = ["Night Drive", "Autumn Tapes", "Glass Garden", "Low Tide", "Paper Moons", "Neon Rain", "Quiet Hours", "Summer Static"].map((t, i) => ({
    id: "plex:alb" + i, title: t, artist: ["Aster Vale", "The Lanterns", "Mika Sora", "Northbound", "Ivy Kemper", "Hollow Pines", "Kaze", "Juniper"][i], artistId: "plex:art" + i, year: 2015 + i, artwork: art(i, t.split(" ")[0]), kind: "Album",
  }));
  const artists = albums.map((a, i) => ({ id: a.artistId, name: a.artist, artwork: art(i + 3, a.artist.split(" ")[0]) }));
  const songNames = ["Slow Lights", "Halfway Home", "Paper Planes", "Static Bloom", "夜明けの歌", "Undertow", "Glasshouse", "Northern Line", "Afterglow", "Small Hours", "Driftwood", "Satellite"];
  const tracks = songNames.map((t, i) => ({
    id: "plex:t" + i, source: "plex", title: t, artist: albums[i % 8].artist, artistId: albums[i % 8].artistId, album: albums[i % 8].title, albumId: albums[i % 8].id,
    durationMs: 150000 + i * 17000, artwork: albums[i % 8].artwork, trackNumber: i + 1, explicit: i === 3,
  }));
  const playlists = ["autumn", "open", "summer", "End", "late night", "focus"].map((t, i) => ({ id: "plex:pl" + i, title: t, artwork: art(i + 2, t), trackCount: 20 + i * 7, owner: "you", local: false }));
  playlists.push({ id: "plex:big", title: "Everything", artwork: art(7, "All"), trackCount: 50000, owner: "you", local: false });
  const appPls = [{ id: "app:1", title: "Road trip", artwork: art(5, "Road"), trackCount: 12, local: true }, { id: "app:2", title: "Rainy day", artwork: art(6, "Rain"), trackCount: 8, local: true }];
  const data = {
    app_info: { flavor: "plex", name: "PLEXSpot", version: "0.1.0", capabilities: { downloads: true, qualityControl: true, podcasts: false, crossfade: true, gapless: true, favorites: true } },
    auth_status: { signedIn: true, account: "demo", server: "Home server", serverConnection: "local", needsServer: false },
    settings_get: {},
    kv_get: null,
    pl_list: appPls,
    library: { artists, albums, playlists, podcasts: [] },
    home: {
      shelves: [
        { title: "recentlyAdded", items: albums.slice(0, 7).map((a) => ({ type: "album", ...a })) },
        { title: "Made for you", subtitle: "From your library", items: playlists.map((p) => ({ type: "playlist", ...p })) },
      ],
      recent: tracks.slice(0, 8), contexts: playlists.slice(0, 4).map((p) => ({ kind: "playlist", id: p.id, title: p.title, artwork: p.artwork })).concat(appPls.map((p) => ({ kind: "playlist", id: p.id, title: p.title, artwork: p.artwork }))),
      topTracks: tracks.slice(2, 10), stale: false,
    },
    queue_load: { tracks: tracks.map((t, i) => ({ t, m: i === 1 || i === 2 })), index: 0, context: { kind: "playlist", id: "plex:pl0", title: "autumn" }, position: 83, shuffle: false, repeat: "all" },
    album: { album: albums[0], tracks: tracks.slice(0, 10).map((t) => ({ ...t, album: albums[0].title, artwork: albums[0].artwork })) },
    artist: { artist: artists[0], description: "Sample artist used for UI screenshots.", topTracks: tracks.slice(0, 10), albums: albums.slice(0, 5), singles: albums.slice(5), appearsOn: albums.slice(2, 6), related: artists.slice(1),
      localTracks: [{ ...tracks[0], id: "local:abc", source: "local", title: "Slow Lights (home demo)", artwork: null }], localAlbums: [] },
    // "plex:big" is a 50,000-track playlist for the large-list performance check.
    playlist: (args) =>
      args && args.id === "plex:big"
        ? { playlist: { id: "plex:big", title: "Everything", trackCount: 50000, local: false },
            tracks: Array.from({ length: 50000 }, (_, i) => ({ ...tracks[i % tracks.length], id: "plex:big" + i, title: tracks[i % tracks.length].title + " " + i })) }
        : { playlist: playlists[0], tracks },
    saved_list: { albums: [], artists: [], playlists: [], podcasts: [] },
    local_folders: [],
    local_library: { tracks: [], albums: [], artists: [] },
    download_list: [],
    liked_ids: [],
    localized_artist_names: {},
    search_kind: (a) => ({ top: null, tracks: a.kind === "songs" ? [...tracks, ...tracks.map((t) => ({ ...t, id: t.id + "b", title: t.title + " (more)" }))] : [], albums: a.kind === "albums" ? albums : [], artists: a.kind === "artists" ? artists : [], playlists: [], podcasts: [], episodes: [] }),
    search: { top: { type: "artist", ...artists[0] }, tracks: [...tracks.slice(0, 6), { ...tracks[0], id: "local:abc", source: "local", title: "Slow Lights (home demo)", artwork: null }], albums: albums.slice(0, 4), artists: artists.slice(0, 4), playlists: playlists.slice(0, 3), podcasts: [], episodes: [] },
    get_lyrics: { synced: true, source: "LRCLIB (sample)", lines: [
      { timeMs: 50000, text: "Headlights fold into the rain" }, { timeMs: 60000, text: "Every sign a different name" },
      { timeMs: 70000, text: "夜明けまで走り続ける" }, { timeMs: 80000, text: "Slow lights, carry me home" },
      { timeMs: 90000, text: "Through the static and the foam" }, { timeMs: 100000, text: "ひかりの中で" },
      { timeMs: 110000, text: "Slow lights, carry me home" } ] },
  };
  window.__MOCK__ = data;
  window.__CALLS__ = [];
  let cb = 0;
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__CALLS__.push(cmd);
      if (!(cmd in data)) return null;
      const v = typeof data[cmd] === "function" ? data[cmd](args) : data[cmd];
      return JSON.parse(JSON.stringify(v));
    },
    transformCallback: () => ++cb,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})();
