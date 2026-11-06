// Mock Tauri backend for the smoke tests and screenshots. Sample data, not real provider content.
//
// OpenSpot has two providers. The mock holds both: YouTube Music (`yt:` ids) and Plex (`plex:` ids),
// plus local files and app playlists. Fan-out commands (home, library, liked_tracks,
// browse_categories…) answer from the providers whose switch is on, as commands.rs does; search and
// search_kind answer for one provider (or local files + app playlists for `provider: null`).
//
// - `window.__MOCK__`: command name → value or function(args). Tests override entries.
// - `window.__STATE__`: { services, auth, kv }. services_set / sign_out change it.
// - `window.__EMIT__(event, payload)`: delivers a Tauri event to the UI's listeners.
// - `window.__setScenario("both" | "youtube" | "plex" | "fresh")`: which services are on and
//   signed in. "both" is the default. Ids and titles stay the same in every scenario.
(() => {
  const hues = [[220, 40, 60], [12, 80, 40], [150, 60, 35], [280, 50, 45], [40, 85, 50], [190, 70, 40], [330, 60, 45], [100, 40, 35]];
  const art = (i, label) => {
    const [h, s, l] = hues[i % hues.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h},${s}%,${l + 15}%)'/><stop offset='1' stop-color='hsl(${(h + 40) % 360},${s}%,${l - 15}%)'/></linearGradient></defs><rect width='300' height='300' fill='url(#g)'/><text x='24' y='270' font-family='Segoe UI,Arial' font-size='34' font-weight='800' fill='rgba(255,255,255,.85)'>${label}</text></svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  };
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

  // ---- Plex: a whole server -------------------------------------------------------------------
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
  const plexGenres = ["Music", "Podcasts", "New releases", "Pop", "Country", "Latin", "Chill", "Charts", "Hip-Hop", "Jazz"].map((t, i) => ({ id: "plex-genre:1:" + i, title: t, color: null }));

  // ---- YouTube Music: the account's own library ----------------------------------------------
  const ytAlbums = ["Blue Hour", "Cassette Summer", "Midnight Ferry", "Orbit Season"].map((t, i) => ({
    id: "yt:MPREb_alb" + i, title: t, artist: ["Luna Park", "Kite Runners", "Sora Blue", "Velvet Tram"][i], artistId: "yt:UCart" + i, year: [2019, 2023, 2017, 2021][i], artwork: art(i + 4, t.split(" ")[0]), kind: "Album",
  }));
  const ytArtists = ytAlbums.map((a, i) => ({ id: a.artistId, name: a.artist, artwork: art(i + 1, a.artist.split(" ")[0]) }));
  const ytTracks = ["Ferry Lights", "Orbit", "Cassette Heart", "Blue Hour", "Paper Sun", "Night Bus"].map((t, i) => ({
    id: "yt:vid" + i, source: "youtube", streamKey: "vid" + i, title: t, artist: ytAlbums[i % 4].artist, artistId: ytAlbums[i % 4].artistId, album: ytAlbums[i % 4].title, albumId: ytAlbums[i % 4].id,
    durationMs: 200000 + i * 9000, artwork: ytAlbums[i % 4].artwork,
  }));
  const ytPlaylists = [
    { id: "yt:VLPLmine", title: "My YouTube mix", artwork: art(1, "Mix"), trackCount: 6, owner: "Me", local: false },
    { id: "yt:VLPLrun", title: "Morning run", artwork: art(3, "Run"), trackCount: 14, owner: "Me", local: false },
    { id: "yt:VLRDTMAK5uy", title: "Supermix", artwork: art(5, "Super"), owner: "YouTube Music", local: false },
    // Liked Music is the Liked Songs page, never a playlist row.
    { id: "yt:LM", title: "Liked Music", artwork: null, trackCount: 3, owner: "Me", local: false },
  ];
  const ytCategories = ["Feel good", "Workout", "Energize", "Romance", "Party", "Sleep"].map((t, i) => ({ id: "yt:FEmusic_moods_and_genres_category" + i, title: t, color: null }));
  const show = { id: "yt:MPSPshow", title: "Conspiracy Theories", owner: "Parcast", description: "The world's most controversial events.", artwork: null, local: false };
  const eps = [1, 2, 3].map((n) => ({
    id: "yt:ep" + n, source: "youtube", streamKey: "ep" + n, title: "The Lost Tomb Pt. " + n, artist: "Parcast", episode: true,
    durationMs: 2200000, published: "Oct " + (20 + n), description: "Secret doors, a cast-off wig and mummified arms.",
  }));

  // ---- local files and app playlists ----------------------------------------------------------
  const localTrack = { ...tracks[0], id: "local:abc", source: "local", title: "Slow Lights (home demo)", artwork: null };
  const appPls = [{ id: "app:1", title: "Road trip", artwork: art(5, "Road"), trackCount: 12, local: true }, { id: "app:2", title: "Rainy day", artwork: art(6, "Rain"), trackCount: 8, local: true }];

  // ---- state ----------------------------------------------------------------------------------
  // The kv store survives a reload (sessionStorage), like the app's database.
  const kvStore = (() => {
    let saved = {};
    try {
      saved = JSON.parse(sessionStorage.getItem("__mockKv") ?? "{}");
    } catch {}
    return { "yt.profileChosen": true, "plex.profileChosen": true, ...saved };
  })();
  const persistKv = () => {
    try {
      const { ["yt.profileChosen"]: _a, ["plex.profileChosen"]: _b, ...rest } = kvStore;
      sessionStorage.setItem("__mockKv", JSON.stringify(rest));
    } catch {}
  };
  const signedInYt = { signedIn: true, account: "maya", server: null, serverConnection: null, needsServer: false };
  const signedInPlex = { signedIn: true, account: "demo", server: "Home server", serverConnection: "local", needsServer: false };
  const state = {
    services: { youtube: true, plex: true },
    auth: { youtube: { ...signedInYt }, plex: { ...signedInPlex } },
    kv: kvStore,
  };
  window.__STATE__ = state;
  const yt = () => state.services.youtube;
  const plex = () => state.services.plex && state.auth.plex.signedIn;
  const ytSignedIn = () => yt() && state.auth.youtube.signedIn;

  // ---- events ---------------------------------------------------------------------------------
  const callbacks = {};
  const listeners = [];
  let cb = 0;
  window.__CB__ = callbacks;
  window.__LISTENERS__ = listeners;
  /** Deliver a Tauri event to every UI listener of `event` (as the core's app.emit does). */
  window.__EMIT__ = (event, payload) => {
    for (const l of listeners.filter((x) => x.event === event)) {
      const fn = callbacks[l.handler];
      if (fn) fn({ event, id: l.id, payload: clone(payload) });
    }
  };
  const emitSoon = (event, payload) => setTimeout(() => window.__EMIT__(event, payload), 0);

  // ---- per-provider capabilities (commands.rs `capabilities`) -----------------------------
  const providers = {
    youtube: { downloads: false, qualityControl: false, podcasts: true, crossfade: true, gapless: true, favorites: true, discordPresence: false },
    plex: { downloads: true, qualityControl: true, podcasts: false, crossfade: true, gapless: true, favorites: true, discordPresence: false },
  };

  const plexSearch = () => ({ top: { type: "artist", ...artists[0] }, tracks: tracks.slice(0, 6), albums: albums.slice(0, 4), artists: artists.slice(0, 4), playlists: playlists.slice(0, 3), podcasts: [], episodes: [] });
  const ytSearch = () => ({ top: { type: "artist", ...ytArtists[0] }, tracks: ytTracks.slice(0, 4), albums: ytAlbums.slice(0, 3), artists: ytArtists.slice(0, 3), playlists: ytPlaylists.slice(0, 2), podcasts: [{ id: show.id, title: show.title, author: show.owner, artwork: null }], episodes: eps.slice(0, 2) });
  const localSearch = () => ({ top: null, tracks: [localTrack], albums: [], artists: [], playlists: [], podcasts: [], episodes: [] });
  const empty = () => ({ top: null, tracks: [], albums: [], artists: [], playlists: [], podcasts: [], episodes: [] });
  const disabled = (p) => ({ code: "disabled", message: `${p === "plex" ? "Plex" : "YouTube Music"} is turned off`, provider: p });
  const likedYt = ytTracks.slice(0, 3);
  const likedPlex = [tracks[5], tracks[6]];
  const queueOf = (list, context = { kind: "playlist", id: "plex:pl0", title: "autumn" }) => ({ tracks: list.map((t, i) => ({ t, m: i === 1 || i === 2 })), index: 0, context, position: 83, shuffle: false, repeat: "all" });

  const data = {
    app_info: { name: "OpenSpot", version: "2.0.0", providers, services: state.services, discordPresence: false, artBase: null, safeMode: null, selfTest: false },
    services_get: () => state.services,
    services_set: (a) => {
      const changed = a.services.youtube !== state.services.youtube || a.services.plex !== state.services.plex;
      state.services.youtube = !!a.services.youtube;
      state.services.plex = !!a.services.plex;
      if (changed) emitSoon("services-changed", state.services);
      return null;
    },
    auth_status: () => state.auth,
    auth_recover: () => true,
    sign_out: (a) => {
      if (a.provider === "plex") {
        state.auth.plex = { signedIn: false, account: null, server: null, serverConnection: null, needsServer: false };
        state.services.plex = false;
        emitSoon("services-changed", state.services);
      } else {
        // YouTube stays on, without an account.
        state.auth.youtube = { signedIn: false, account: null, server: null, serverConnection: null, needsServer: false };
      }
      emitSoon("auth-changed", { provider: a.provider });
      return null;
    },
    settings_get: {},
    kv_get: (a) => (a.key in state.kv ? state.kv[a.key] : null),
    kv_set: (a) => ((state.kv[a.key] = a.value), persistKv(), null),
    pl_list: appPls,
    library: () => ({
      artists: [...(yt() ? ytArtists : []), ...(plex() ? artists : [])],
      albums: [...(yt() ? ytAlbums : []), ...(plex() ? albums : [])],
      playlists: [...(yt() ? ytPlaylists : []), ...(plex() ? playlists : [])],
      podcasts: yt() ? [{ id: show.id, title: show.title, author: show.owner, artwork: null }] : [],
    }),
    // Plex shelves first, then YouTube's (commands.rs `home`).
    home: () => ({
      shelves: [
        ...(plex()
          ? [
              { title: "recentlyAdded", items: albums.slice(0, 7).map((a) => ({ type: "album", ...a })) },
              { title: "Made for you", subtitle: "From your library", items: playlists.map((p) => ({ type: "playlist", ...p })) },
            ]
          : []),
        ...(yt()
          ? [
              { title: "Listen again", items: [...ytAlbums.map((a) => ({ type: "album", ...a })), ...ytPlaylists.slice(0, 3).map((p) => ({ type: "playlist", ...p }))] },
              { title: "Quick picks", items: ytTracks.map((t) => ({ type: "track", ...t })) },
            ]
          : []),
      ],
      recent: [...(plex() ? tracks.slice(0, 8) : []), ...(yt() ? ytTracks.slice(0, 4) : [])],
      contexts: [
        ...(plex() ? playlists.slice(0, 4).map((p) => ({ kind: "playlist", id: p.id, title: p.title, artwork: p.artwork })) : []),
        ...(yt() ? ytPlaylists.slice(0, 2).map((p) => ({ kind: "playlist", id: p.id, title: p.title, artwork: p.artwork })) : []),
        ...appPls.map((p) => ({ kind: "playlist", id: p.id, title: p.title, artwork: p.artwork })),
      ],
      topTracks: [...(plex() ? tracks.slice(2, 10) : []), ...(yt() ? ytTracks.slice(0, 3) : [])],
      stale: false,
    }),
    queue_load: queueOf(tracks),
    album: (a) =>
      a && a.id && a.id.startsWith("yt:")
        ? { album: ytAlbums.find((x) => x.id === a.id) ?? ytAlbums[0], tracks: ytTracks.slice(0, 4) }
        : { album: albums[0], tracks: tracks.slice(0, 10).map((t) => ({ ...t, album: albums[0].title, artwork: albums[0].artwork })) },
    artist: (a) =>
      a && a.id && a.id.startsWith("yt:")
        ? { artist: ytArtists.find((x) => x.id === a.id) ?? ytArtists[0], description: "Sample YouTube Music artist.", topTracks: ytTracks, albums: ytAlbums, singles: [], appearsOn: [], related: ytArtists.slice(1), followers: "1.23M", localTracks: [], localAlbums: [] }
        : { artist: artists[0], description: "Sample artist used for UI screenshots.", topTracks: tracks.slice(0, 10), albums: albums.slice(0, 5), singles: albums.slice(5), appearsOn: albums.slice(2, 6), related: artists.slice(1),
            localTracks: [localTrack], localAlbums: [] },
    // "plex:big" is a 50,000-track playlist for the large-list performance check.
    playlist: (a) => {
      const id = a && a.id;
      if (id === "plex:big")
        return { playlist: { id: "plex:big", title: "Everything", trackCount: 50000, local: false },
          tracks: Array.from({ length: 50000 }, (_, i) => ({ ...tracks[i % tracks.length], id: "plex:big" + i, title: tracks[i % tracks.length].title + " " + i })) };
      if (id === show.id) return { playlist: show, tracks: eps };
      const ytp = ytPlaylists.find((p) => p.id === id);
      // Liked Music holds the liked songs (the same list as liked_tracks' YouTube part).
      // Morning run holds other songs than the mix (no "Already added" for the playing song).
      if (ytp) return { playlist: ytp, tracks: id === "yt:LM" ? likedYt : id === "yt:VLPLrun" ? ytTracks.slice(3) : ytTracks };
      const app = appPls.find((p) => p.id === id);
      // Road trip holds every Plex song; Rainy day only the second half (saved_in agrees).
      if (app) return { playlist: app, tracks: id === "app:2" ? tracks.slice(6) : tracks };
      return { playlist: playlists.find((p) => p.id === id) ?? playlists[0], tracks };
    },
    saved_list: { albums: [], artists: [], playlists: [], podcasts: [] },
    local_folders: [],
    local_library: { tracks: [], albums: [], artists: [] },
    download_list: [],
    liked_ids: () => [...(ytSignedIn() ? likedYt : []), ...(plex() ? likedPlex : [])].map((t) => t.id),
    // YouTube's liked songs (LM), then Plex's rated tracks (commands.rs `liked_tracks`).
    liked_tracks: () => ({ tracks: [...(ytSignedIn() ? likedYt : []), ...(plex() ? likedPlex : [])], stale: false }),
    save_text_file: (a) => ((window.__EXPORT__ = a), "C:/Users/demo/" + a.name),
    new_releases: [
      { title: "fromArtistsYouFollow", items: albums.slice(5).map((a) => ({ type: "album", ...a })) },
      { title: "latestReleases", items: albums.slice(0, 5).map((a) => ({ type: "album", ...a })) },
    ],
    profile_info: { name: "maya", photo: art(4, "M"), url: null, publicPlaylists: null },
    profile_artists: (a) => (a.kind === "top" ? artists.slice(0, 6) : artists.slice(2, 8)),
    browse_categories: () => [...(yt() ? ytCategories : []), ...(plex() ? plexGenres : [])],
    browse_art: (a) => {
      const n = Number(String(a.id).match(/(\d+)$/)?.[1] ?? 0);
      return a.id.startsWith("yt:") ? ytAlbums[n % ytAlbums.length].artwork : albums[n % albums.length].artwork;
    },
    browse_page: (a) =>
      a.id.startsWith("yt:")
        ? [{ title: "albums", items: ytAlbums.map((x) => ({ type: "album", ...x })) }, { title: "playlists", items: ytPlaylists.slice(0, 3).map((x) => ({ type: "playlist", ...x })) }]
        : [{ title: "albums", items: albums.slice(0, 6).map((x) => ({ type: "album", ...x })) }, { title: "artists", items: artists.slice(0, 4).map((x) => ({ type: "artist", ...x })) }],
    saved_in: (a) => ({
      appPlaylists: ["app:1"],
      remote: a && a.track && a.track.id.startsWith("yt:")
        ? [{ id: "yt:VLPLmine", title: "My YouTube mix", contains: ytTracks.some((x) => x.id === a.track.id) }, { id: "yt:VLPLrun", title: "Morning run", contains: false }]
        : [],
    }),
    // Every add, for the "Already added" tests: { id, tracks }.
    pl_add: (a) => ((window.__PL_ADDS__ = window.__PL_ADDS__ || []).push(a), a.tracks.length),
    yt_accounts: [{ name: "maya", selected: true, pageId: null }],
    // A Plex sign-in waits for the PIN (never approved here).
    plex_pin_start: { id: 1, code: "ABCD", authUrl: "https://app.plex.tv/auth#?code=ABCD" },
    plex_pin_poll: false,
    plex_home_users: [],
    localized_artist_names: {},
    // Stand-in translator: Japanese text gets a marked "translation", the rest is already English.
    translate_texts: (a) => a.texts.map((t) => (/[\u3040-\u30ff\u4e00-\u9fff]/.test(t) ? "[en] " + t : null)),
    // Same-artist pairs confirmed by the core (set by a test in `__ART_LINKS__`); checks are recorded.
    artist_links: (a) => (window.__ART_LINKS__ ?? []).filter(([x, y]) => a.ids.includes(x) && a.ids.includes(y)),
    artist_link_check: (a) => void (window.__LINK_CHECKS__ = [...(window.__LINK_CHECKS__ ?? []), ...a.ids]),
    // One provider's results; `provider: null` is local files and app playlists only.
    search: (a) => {
      if (a.provider === "plex") {
        if (!plex()) throw disabled("plex");
        return plexSearch();
      }
      if (a.provider === "youtube") {
        if (!yt()) throw disabled("youtube");
        return ytSearch();
      }
      return localSearch();
    },
    search_kind: (a) => {
      const base = a.provider === "plex" ? (plex() ? plexSearch() : null) : a.provider === "youtube" ? (yt() ? ytSearch() : null) : localSearch();
      if (!base) throw disabled(a.provider);
      const out = empty();
      if (a.kind === "songs") out.tracks = a.provider === "plex" ? [...tracks, ...tracks.map((t) => ({ ...t, id: t.id + "b", title: t.title + " (more)" }))] : base.tracks;
      if (a.kind === "albums") out.albums = a.provider === "plex" ? albums : base.albums;
      if (a.kind === "artists") out.artists = a.provider === "plex" ? artists : base.artists;
      if (a.kind === "playlists") out.playlists = base.playlists;
      if (a.kind === "podcasts") out.podcasts = base.podcasts;
      if (a.kind === "episodes") out.episodes = base.episodes;
      return out;
    },
    get_lyrics: { synced: true, source: "LRCLIB (sample)", lines: [
      { timeMs: 50000, text: "Headlights fold into the rain" }, { timeMs: 60000, text: "Every sign a different name" },
      { timeMs: 70000, text: "夜明けまで走り続ける" }, { timeMs: 80000, text: "Slow lights, carry me home" },
      { timeMs: 90000, text: "Through the static and the foam" }, { timeMs: 100000, text: "ひかりの中で" },
      { timeMs: 110000, text: "Slow lights, carry me home" } ] },
  };
  /** The sample data, for tests that build on it. */
  window.__FIX__ = { albums, artists, tracks, playlists, ytAlbums, ytArtists, ytTracks, ytPlaylists, localTrack, appPls, show, eps, likedYt, likedPlex };

  /** Which services are on and signed in. Called before the app starts (an init script). */
  window.__setScenario = (name) => {
    const out = { signedIn: false, account: null, server: null, serverConnection: null, needsServer: false };
    const on = { both: [true, true], youtube: [true, false], plex: [false, true], fresh: [false, false] }[name];
    if (!on) throw new Error("unknown scenario " + name);
    state.services.youtube = on[0];
    state.services.plex = on[1];
    state.auth.youtube = on[0] ? { ...signedInYt } : { ...out };
    state.auth.plex = on[1] ? { ...signedInPlex } : { ...out };
    // The restored queue holds the songs of a service that is on.
    data.queue_load = name === "youtube" ? queueOf(clone(ytTracks), { kind: "playlist", id: "yt:VLPLmine", title: "My YouTube mix" }) : queueOf(tracks);
    if (name === "fresh") data.queue_load = null;
    window.__SCENARIO__ = name;
  };

  window.__MOCK__ = data;
  window.__CALLS__ = [];
  let listenId = 0;
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__CALLS__.push(cmd);
      if (cmd === "plugin:event|listen") {
        const id = ++listenId;
        listeners.push({ event: args.event, handler: args.handler, id });
        return id;
      }
      if (cmd === "plugin:event|unlisten") {
        const i = listeners.findIndex((l) => l.event === args.event && l.id === args.eventId);
        if (i >= 0) listeners.splice(i, 1);
        return null;
      }
      if (!(cmd in data)) return null;
      // A function may answer later (a Promise), like a slow service.
      const v = await (typeof data[cmd] === "function" ? data[cmd](args) : data[cmd]);
      return clone(v);
    },
    transformCallback: (fn, once) => {
      const id = ++cb;
      callbacks[id] = once ? (x) => (delete callbacks[id], fn(x)) : fn;
      return id;
    },
    unregisterCallback: (id) => delete callbacks[id],
    convertFileSrc: (p) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event, id) => {
      const i = listeners.findIndex((l) => l.event === event && l.id === id);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
})();
