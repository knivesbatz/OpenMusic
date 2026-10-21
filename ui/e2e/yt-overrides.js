// Makes the mock backend behave like YTSpot: Japanese metadata, music-video tracks (16:9 thumbnails)
// that get song metadata, profiles. Used by the YouTube tests in smoke.mjs.
// Turn the mock into YTSpot with Japanese metadata and video-thumbnail tracks.
(() => {
  const d = window.__MOCK__;
  d.app_info = { flavor: "youtube", name: "YTSpot", version: "1.0.0", capabilities: { downloads: false, qualityControl: false, podcasts: true, crossfade: false, gapless: false, favorites: true } };
  const jp = ["夜明けの歌", "ひかりの中で", "トーキョー・ナイト", "さくら", "未来へ", "Black Parade"];
  for (const [i, t] of d.queue_load.tracks.entries()) {
    t.t.source = "youtube"; t.t.streamKey = "vid" + i; t.t.id = "yt:vid" + i;
    if (i % 2 === 0) t.t.artwork = "art://url/https%3A%2F%2Fi.ytimg.com%2Fvi%2Fx%2Fhq.jpg";
    t.t.title = jp[i % jp.length]; t.t.artist = i % 3 ? "宇多田ヒカル" : "My Chemical Romance";
  }
  d.yt_accounts = [{ name: "Me", selected: true, pageId: null }, { name: "Brand", selected: false, pageId: "123" }];
  d.yt_song_meta = (a) => Object.fromEntries((a.videoIds || []).map((v) => [v, { artwork: "art://url/sq", artist: "Official Artist" }]));
  d.localized_artist_names = (a) => Object.fromEntries((a.names || []).filter((n) => /[぀-ヿ一-鿿]/.test(n)).map((n) => [n, "Utada Hikaru"]));
  d.kv_get = (a) => (a.key === "yt.profileChosen" ? true : null);
  d.get_lyrics = { synced: true, source: "x", lines: [{ timeMs: 0, text: "ひかりの中で" }, { timeMs: 90000, text: "Hello" }] };
  // A podcast show with episodes, and in-app saving (follow / Your Episodes).
  const show = { id: "yt:MPSPshow", title: "Conspiracy Theories", owner: "Parcast", description: "The world's most controversial events.", artwork: null, local: false };
  const eps = [1, 2, 3].map((n) => ({
    id: "yt:ep" + n, source: "youtube", streamKey: "ep" + n, title: "The Lost Tomb Pt. " + n, artist: "Parcast", episode: true,
    durationMs: 2200000, published: "Oct " + (20 + n), description: "Secret doors, a cast-off wig and mummified arms.",
  }));
  const baseLib = typeof d.library === "function" ? d.library() : d.library;
  d.library = () => ({ ...baseLib, podcasts: [{ id: show.id, title: show.title, author: show.owner, artwork: null }] });
  const basePlaylist = d.playlist;
  d.playlist = (a) => (a.id === show.id ? { playlist: show, tracks: eps } : typeof basePlaylist === "function" ? basePlaylist(a) : basePlaylist);
  const saved = { albums: [], artists: [], playlists: [], podcasts: [], episodes: [] };
  d.saved_list = () => saved;
  d.save_podcast = (a) => ((saved.podcasts = a.saved ? [a.podcast] : []), null);
  d.save_episode = (a) => ((saved.episodes = a.saved ? [a.episode, ...saved.episodes] : saved.episodes.filter((e) => e.id !== a.episode.id)), null);
})();
