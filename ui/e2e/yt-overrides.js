// Only YouTube Music on (what a YTSpot 1.x user gets): Japanese metadata, music-video tracks
// (16:9 thumbnails) that get song metadata, brand accounts. Load after mock-backend.js. Used by the
// YouTube tests in smoke.mjs and by screenshots.mjs.
(() => {
  window.__setScenario("youtube");
  const d = window.__MOCK__;
  const jp = ["夜明けの歌", "ひかりの中で", "トーキョー・ナイト", "さくら", "未来へ", "Black Parade"];
  for (const [i, t] of d.queue_load.tracks.entries()) {
    t.t.streamKey = "vid" + i;
    t.t.id = "yt:vid" + i;
    if (i % 2 === 0) t.t.artwork = "art://url/https%3A%2F%2Fi.ytimg.com%2Fvi%2Fx%2Fhq.jpg";
    t.t.title = jp[i % jp.length];
    t.t.artist = i % 3 ? "宇多田ヒカル" : "My Chemical Romance";
  }
  d.yt_accounts = [{ name: "Me", selected: true, pageId: null }, { name: "Brand", selected: false, pageId: "123" }];
  d.yt_song_meta = (a) => Object.fromEntries((a.videoIds || []).map((v) => [v, { artwork: "art://url/sq", artist: "Official Artist" }]));
  d.localized_artist_names = (a) => Object.fromEntries((a.names || []).filter((n) => /[぀-ヿ一-鿿]/.test(n)).map((n) => [n, "Utada Hikaru"]));
  d.get_lyrics = { synced: true, source: "x", lines: [{ timeMs: 0, text: "ひかりの中で" }, { timeMs: 90000, text: "Hello" }] };
  // In-app saving (follow / Your Episodes).
  const saved = { albums: [], artists: [], playlists: [], podcasts: [], episodes: [] };
  d.saved_list = () => saved;
  d.save_podcast = (a) => ((saved.podcasts = a.saved ? [a.podcast] : []), null);
  d.save_episode = (a) => ((saved.episodes = a.saved ? [a.episode, ...saved.episodes] : saved.episodes.filter((e) => e.id !== a.episode.id)), null);
})();
