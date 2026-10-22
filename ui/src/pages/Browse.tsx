// Home, Search and the Library grid.
import { useEffect, useMemo, useRef, useState } from "react";
import { albumMenu, artistMenu, createPlaylist, playlistMenu, podcastMenu, trackMenu } from "../actions";
import { api, artUrl, errorMessage, inTauri } from "../api";
import { Art, Card, ErrorBox, Loading, PlayFab, Shelf, itemSubtitle, openItem, useAsync, usePageTitle, usePhoneLayout } from "../components/common";
import * as I from "../components/Icons";
import { TrackList } from "../components/TrackList";
import { shelfTitle, useT } from "../i18n";
import * as P from "../player/engine";
import { refreshLibrary, useApp } from "../store/app";
import { sortAlbums, sortArtists } from "../store/librarySort";
import { useSettings } from "../store/settings";
import { navigate, openMenu, toast, useUi, type LibraryTab } from "../store/ui";
import { useDisplayTrack } from "../store/songmeta";
import type { HomeData, MediaItem, PlayContext, SearchResults, Track } from "../types";
import { cls } from "../util";

/** Play any card: tracks play directly, collections are fetched first. */
export async function playItem(item: MediaItem) {
  try {
    if (item.type === "track") return P.playTracks([item], 0, null);
    if (item.type === "album") {
      const a = await api.album(item.id);
      return P.playTracks(a.tracks, 0, { kind: "album", id: item.id, title: a.album.title, artwork: a.album.artwork });
    }
    if (item.type === "playlist" || item.type === "podcast") {
      const p = await api.playlist(item.id);
      return P.playTracks(p.tracks, 0, { kind: "playlist", id: item.id, title: p.playlist.title, artwork: p.playlist.artwork });
    }
    if (item.type === "artist") {
      const a = await api.artist(item.id);
      return P.playTracks(a.topTracks, 0, { kind: "artist", id: item.id, title: a.artist?.name ?? item.name, artwork: a.artist?.artwork });
    }
  } catch (e) {
    toast(errorMessage(e));
  }
}

export function cardMenu(e: React.MouseEvent, item: MediaItem) {
  if (item.type === "track") return openMenu(e, trackMenu(item));
  if (item.type === "album") return openMenu(e, albumMenu(item, async () => (await api.album(item.id)).tracks));
  if (item.type === "playlist") return openMenu(e, playlistMenu(item, async () => (await api.playlist(item.id)).tracks));
  if (item.type === "artist") return openMenu(e, artistMenu(item));
  if (item.type === "podcast") return openMenu(e, podcastMenu(item));
}

const homeCache: { data: HomeData | null } = { data: null };

export function Home() {
  const t = useT();
  const lang = useSettings((s) => s.language);
  const info = useApp((s) => s.info);
  const lib = useApp((s) => s.library);
  const appPls = useApp((s) => s.playlists);
  const [data, setData] = useState<HomeData | null>(homeCache.data);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "music" | "podcasts">("all");
  const htpc = useSettings((s) => s.htpc);

  const load = (refresh: boolean) => {
    if (!inTauri) return setData({ shelves: [], recent: [], contexts: [], topTracks: [], stale: false });
    setError(null);
    api.home(refresh).then(
      (d) => {
        homeCache.data = d;
        setData(d);
        if (d.error) setError(d.error.message);
      },
      (e) => setError(errorMessage(e)),
    );
  };
  useEffect(() => load(false), []);

  const h = new Date().getHours();
  const greeting = h < 12 ? t("goodMorning") : h < 18 ? t("goodAfternoon") : t("goodEvening");

  // Shortcut grid: recently played contexts, then app playlists and library playlists.
  const shortcuts = useMemo(() => {
    const out: { id: string; title: string; artwork?: string | null; ctx: PlayContext }[] = [];
    const seen = new Set<string>();
    for (const c of data?.contexts ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, title: c.title, artwork: c.artwork, ctx: c });
    }
    for (const p of [...appPls, ...(lib?.playlists ?? [])]) {
      if (out.length >= 8) break;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, title: p.title, artwork: p.artwork, ctx: { kind: "playlist", id: p.id, title: p.title, artwork: p.artwork } });
    }
    return out.slice(0, 8);
  }, [data, appPls, lib]);

  if (!data && !error) return <Loading />;

  const shelves = (data?.shelves ?? []).filter((s) => {
    if (filter === "all") return true;
    const pod = s.items.some((i) => i.type === "podcast" || (i.type === "track" && i.episode));
    return filter === "podcasts" ? pod : !pod;
  });

  const openCtx = (c: PlayContext) =>
    navigate(c.kind === "album" ? { name: "album", id: c.id } : c.kind === "artist" ? { name: "artist", id: c.id } : { name: "playlist", id: c.id });
  const playCtx = (c: PlayContext) =>
    playItem(c.kind === "album" ? ({ type: "album", id: c.id, title: c.title, artist: "" } as MediaItem) : c.kind === "artist" ? ({ type: "artist", id: c.id, name: c.title } as MediaItem) : ({ type: "playlist", id: c.id, title: c.title, local: c.id.startsWith("app:") } as MediaItem));

  const firstShortcut = shortcuts[0];
  return (
    <div className="page home">
      {htpc && (
        <TvHero
          featured={
            firstShortcut && {
              title: firstShortcut.title,
              artwork: firstShortcut.artwork,
              open: () => openCtx(firstShortcut.ctx),
              play: () => playCtx(firstShortcut.ctx),
            }
          }
        />
      )}
      {info?.capabilities.podcasts && (
        <div className="chips">
          {(["all", "music", "podcasts"] as const).map((f) => (
            <button key={f} className={cls("chip", filter === f && "on")} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {t(f === "all" ? "all" : f === "music" ? "music" : "podcasts")}
            </button>
          ))}
        </div>
      )}
      <h1 className="greeting">{greeting}</h1>
      {data?.stale && <p className="muted small">{t("offline")}</p>}
      {error && <ErrorBox message={error} onRetry={() => load(true)} />}
      {filter !== "podcasts" && shortcuts.length > 0 && (
        <div className="shortcuts">
          {shortcuts.map((s) => (
            <div key={s.id} className="shortcut" role="button" tabIndex={0} onClick={() => openCtx(s.ctx)} onKeyDown={(e) => e.key === "Enter" && openCtx(s.ctx)}>
              <Art src={s.artwork} size={120} />
              <span className="name">{s.title}</span>
              <PlayFab label={t("play")} onClick={(e) => (e.stopPropagation(), playCtx(s.ctx))} />
            </div>
          ))}
        </div>
      )}
      {filter !== "podcasts" && (data?.recent.length ?? 0) > 0 && (
        <Shelf title={t("recentlyPlayed")}>
          {dedupeAlbums(data!.recent).map((tr) => (
            <Card key={tr.id} item={{ type: "track", ...tr }} onPlay={() => P.playTracks([tr], 0, null)} onContext={(e) => cardMenu(e, { type: "track", ...tr })} />
          ))}
        </Shelf>
      )}
      {filter !== "podcasts" && (data?.topTracks.length ?? 0) > 0 && (
        <Shelf title={t("yourTopTracks")}>
          {data!.topTracks.map((tr, i) => (
            <Card key={tr.id} item={{ type: "track", ...tr }} onPlay={() => P.playTracks(data!.topTracks, i, { kind: "top", id: "top", title: t("yourTopTracks") })} onContext={(e) => cardMenu(e, { type: "track", ...tr })} />
          ))}
        </Shelf>
      )}
      {shelves.map((s, i) => (
        <Shelf key={i} title={shelfTitle(lang, s.title)} subtitle={s.subtitle}>
          {s.items.map((it) => (
            <Card key={it.type + it.id} item={it} onPlay={() => playItem(it)} onContext={(e) => cardMenu(e, it)} />
          ))}
        </Shelf>
      ))}
      {filter !== "podcasts" && lib && lib.artists.length > 0 && (
        <Shelf title={t("yourTopArtists")} onShowAll={() => navigate({ name: "library", tab: "artists" })}>
          {lib.artists.slice(0, 12).map((a) => (
            <Card key={a.id} item={{ type: "artist", ...a }} onPlay={() => playItem({ type: "artist", ...a })} onContext={(e) => cardMenu(e, { type: "artist", ...a })} />
          ))}
        </Shelf>
      )}
      {!error && !shortcuts.length && !shelves.length && !data?.recent.length && <p className="muted center">{t("homeEmpty")}</p>}
    </div>
  );
}

/**
 * TV mode banner (Android TV / Google TV style): the playing track, or the first "jump back in"
 * item, large with its artwork behind it.
 */
function TvHero({ featured }: { featured?: { title: string; artwork?: string | null; open: () => void; play: () => void } }) {
  const t = useT();
  const cur = P.usePlayer((s) => s.queue.items[s.queue.index]?.track ?? null);
  const playing = P.usePlayer((s) => s.playing);
  const track = useDisplayTrack(cur);
  const hero = track
    ? {
        eyebrow: t("nowPlaying"),
        title: track.title,
        subtitle: track.artist,
        artwork: track.artwork,
        primary: { label: playing ? t("pause") : t("play"), run: P.toggle },
        secondary: { label: t("fullscreen"), run: () => useUi.setState({ fullscreen: true }) },
      }
    : featured
      ? {
          eyebrow: t("jumpBackIn"),
          title: featured.title,
          subtitle: null,
          artwork: featured.artwork,
          primary: { label: t("play"), run: featured.play },
          secondary: { label: t("showAll"), run: featured.open },
        }
      : null;
  if (!hero) return null;
  const art = artUrl(hero.artwork, 600);
  return (
    <section className="tv-hero" style={art ? { backgroundImage: `url("${art}")` } : undefined}>
      <div className="tv-hero-text">
        <div className="tv-eyebrow">{hero.eyebrow}</div>
        <h1>{hero.title}</h1>
        {hero.subtitle && <div className="tv-hero-sub">{hero.subtitle}</div>}
        <div className="row gap">
          <button className="pill primary" onClick={hero.primary.run}>
            {hero.primary.label}
          </button>
          <button className="pill ghost" onClick={hero.secondary.run}>
            {hero.secondary.label}
          </button>
        </div>
      </div>
    </section>
  );
}

function dedupeAlbums(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    const k = t.albumId ?? t.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---- search ----------------------------------------------------------------------------------

const searchCache = new Map<string, SearchResults>();
type SFilter = "all" | "songs" | "artists" | "albums" | "playlists" | "podcasts" | "episodes";

export function Search({ q }: { q: string }) {
  const t = useT();
  const caps = useApp((s) => s.info?.capabilities);
  const [res, setRes] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SFilter>("all");
  const tok = useRef(0);
  const query = q.trim();

  useEffect(() => {
    setError(null);
    if (!query) return setRes(null);
    const cached = searchCache.get(query.toLowerCase());
    if (cached) {
      setRes(cached);
      setLoading(false);
      return;
    }
    const my = ++tok.current;
    setLoading(true);
    // Debounced: one request after typing pauses, stale responses are dropped.
    const timer = setTimeout(() => {
      if (!inTauri) return setLoading(false);
      api.search(query).then(
        (r) => {
          searchCache.set(query.toLowerCase(), r);
          if (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value!);
          if (my === tok.current) (setRes(r), setLoading(false));
        },
        (e) => my === tok.current && (setError(errorMessage(e)), setLoading(false)),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // A filter chip loads the full list for that type (not just the overview's first few).
  const [kindRes, setKindRes] = useState<{ key: string; res: SearchResults } | null>(null);
  const [kindLoading, setKindLoading] = useState(false);
  const kindTok = useRef(0);
  useEffect(() => {
    if (!query || filter === "all" || !inTauri) return;
    const key = filter + "\u0000" + query.toLowerCase();
    const cached = searchCache.get(key);
    if (cached) return setKindRes({ key, res: cached });
    const my = ++kindTok.current;
    setKindLoading(true);
    const timer = setTimeout(() => {
      api.searchKind(query, filter).then(
        (r) => {
          searchCache.set(key, r);
          if (my === kindTok.current) (setKindRes({ key, res: r }), setKindLoading(false));
        },
        (e) => my === kindTok.current && (setError(errorMessage(e)), setKindLoading(false)),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [query, filter]);

  if (!query) return <BrowseEmpty />;
  const filters: SFilter[] = ["all", "songs", "artists", "albums", "playlists", ...(caps?.podcasts ? (["podcasts", "episodes"] as SFilter[]) : [])];
  const ctx: PlayContext = { kind: "search", id: query, title: query };
  const r = res;
  // Full list for the active filter once loaded; the overview's results meanwhile.
  const fr = filter !== "all" && kindRes?.key === filter + "\u0000" + query.toLowerCase() ? kindRes.res : r;
  // Local files blend into the song list (they carry a "Local file" badge): up to 2 of the
  // overview's 4 spots, so they're visible without a separate section.
  const provider = r ? r.tracks.filter((x) => x.source !== "local") : [];
  const local = r ? r.tracks.filter((x) => x.source === "local") : [];
  const nLocal = Math.min(2, local.length);
  const songs = [...provider.slice(0, 4 - nLocal), ...local.slice(0, nLocal), ...provider.slice(4 - nLocal), ...local.slice(nLocal)];
  return (
    <div className="page search">
      <div className="chips">
        {filters.map((f) => (
          <button key={f} className={cls("chip", filter === f && "on")} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(f)}
          </button>
        ))}
      </div>
      {loading && !r && <Loading />}
      {error && <ErrorBox message={error} />}
      {r && !loading && !r.tracks.length && !r.albums.length && !r.artists.length && !r.playlists.length && !r.podcasts.length && !r.episodes.length && (
        <p className="center muted">{t("noResults", { q: query })}</p>
      )}
      {r && filter === "all" && (
        <>
          <div className="search-top">
            {r.top && (
              <section className="top-result">
                <h2>{t("topResult")}</h2>
                <div className="top-card" role="button" tabIndex={0} onClick={() => openItem(r.top!)} onKeyDown={(e) => e.key === "Enter" && openItem(r.top!)} onContextMenu={(e) => cardMenu(e, r.top!)}>
                  <Art src={r.top.artwork} size={240} round={r.top.type === "artist"} className="lg" />
                  <div className="top-name">{r.top.type === "artist" ? r.top.name : r.top.title}</div>
                  <div className="muted">
                    <span className="badge-pill">{t(r.top.type === "track" ? "song" : r.top.type)}</span>
                  </div>
                  <PlayFab big label={t("play")} onClick={(e) => (e.stopPropagation(), playItem(r.top!))} />
                </div>
              </section>
            )}
            {songs.length > 0 && (
              <section className="top-songs">
                <h2>{t("songs")}</h2>
                <TrackList tracks={songs} limit={4} context={ctx} showAlbum={false} numbered={false} />
              </section>
            )}
          </div>
          <CardShelf title={t("artists")} items={r.artists.map((a) => ({ type: "artist" as const, ...a }))} />
          <CardShelf title={t("albums")} items={r.albums.map((a) => ({ type: "album" as const, ...a }))} />
          <CardShelf title={t("playlists")} items={r.playlists.map((a) => ({ type: "playlist" as const, ...a }))} />
          <CardShelf title={t("podcasts")} items={r.podcasts.map((a) => ({ type: "podcast" as const, ...a }))} />
          {r.episodes.length > 0 && (
            <section>
              <h2>{t("episodes")}</h2>
              <TrackList tracks={r.episodes} limit={6} context={ctx} showAlbum={false} />
            </section>
          )}
        </>
      )}
      {filter !== "all" && kindLoading && fr === r && <p className="muted small">{t("loadingMore")}</p>}
      {fr && filter === "songs" && <TrackList tracks={fr.tracks} context={ctx} />}
      {fr && filter === "episodes" && <TrackList tracks={fr.episodes} context={ctx} showAlbum={false} />}
      {fr && filter === "artists" && <Grid items={fr.artists.map((a) => ({ type: "artist" as const, ...a }))} />}
      {fr && filter === "albums" && <Grid items={fr.albums.map((a) => ({ type: "album" as const, ...a }))} />}
      {fr && filter === "playlists" && <Grid items={fr.playlists.map((a) => ({ type: "playlist" as const, ...a }))} />}
      {fr && filter === "podcasts" && <Grid items={fr.podcasts.map((a) => ({ type: "podcast" as const, ...a }))} />}
    </div>
  );
}

/** Search with nothing typed: Spotify's colourful "Browse all" tiles, here for your library. */
function BrowseEmpty() {
  const t = useT();
  const caps = useApp((s) => s.info?.capabilities);
  const pls = useApp((s) => s.library?.playlists);
  const liked = pls?.find((p) => /^yt:(VL)?LM$/.test(p.id));
  const tiles: { label: string; color: string; go: () => void; icon: React.ReactNode }[] = [
    ...(liked ? [{ label: t("likedSongs"), color: "#5038a0", go: () => navigate({ name: "playlist", id: liked.id }), icon: <I.IHeartFill size={36} /> }] : []),
    { label: t("recentlyPlayed"), color: "#1e3264", go: () => navigate({ name: "library", tab: "recent" }), icon: <I.IClock size={36} /> },
    { label: t("playlists"), color: "#8d67ab", go: () => navigate({ name: "library", tab: "playlists" }), icon: <I.IQueue size={36} /> },
    { label: t("albums"), color: "#e8115b", go: () => navigate({ name: "library", tab: "albums" }), icon: <I.IMusic size={36} /> },
    { label: t("artists"), color: "#148a08", go: () => navigate({ name: "library", tab: "artists" }), icon: <I.IMic size={36} /> },
    ...(caps?.podcasts
      ? [
          { label: t("podcasts"), color: "#006450", go: () => navigate({ name: "library", tab: "podcasts" }), icon: <I.IBookmark size={36} /> },
          { label: t("yourEpisodes"), color: "#477d95", go: () => navigate({ name: "episodes" }), icon: <I.IPlay size={36} /> },
        ]
      : []),
    { label: t("localFiles"), color: "#ba5d07", go: () => navigate({ name: "local" }), icon: <I.IFolder size={36} /> },
    ...(caps?.downloads ? [{ label: t("downloads"), color: "#27856a", go: () => navigate({ name: "downloads" }), icon: <I.IDownload size={36} /> }] : []),
  ];
  return (
    <div className="page">
      <h1>{t("search")}</h1>
      <p className="muted">{t("searchHint")}</p>
      <h2>{t("browseAll")}</h2>
      <div className="browse-tiles">
        {tiles.map((x) => (
          <button key={x.label} className="browse-tile" style={{ background: x.color }} onClick={x.go}>
            <span>{x.label}</span>
            <span className="bt-icon" aria-hidden="true">
              {x.icon}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function CardShelf({ title, items }: { title: string; items: MediaItem[] }) {
  if (!items.length) return null;
  return (
    <Shelf title={title}>
      {items.map((it) => (
        <Card key={it.type + it.id} item={it} onPlay={() => playItem(it)} onContext={(e) => cardMenu(e, it)} />
      ))}
    </Shelf>
  );
}

export function Grid({ items }: { items: MediaItem[] }) {
  return (
    <div className="grid">
      {items.map((it) => (
        <Card key={it.type + it.id} item={it} onPlay={() => playItem(it)} onContext={(e) => cardMenu(e, it)} />
      ))}
    </div>
  );
}

const ctxItem = (c: PlayContext): MediaItem =>
  c.kind === "album"
    ? { type: "album", id: c.id, title: c.title, artist: "", artwork: c.artwork }
    : c.kind === "artist"
      ? { type: "artist", id: c.id, name: c.title, artwork: c.artwork }
      : { type: "playlist", id: c.id, title: c.title, artwork: c.artwork, local: c.id.startsWith("app:") };

/** Your Library, in the classic Spotify layout: categories on desktop, Music/Podcasts tabs on phones. */
export function LibraryPage({ tab }: { tab?: LibraryTab }) {
  const t = useT();
  const lib = useApp((s) => s.library);
  const err = useApp((s) => s.libraryError);
  const pls = useApp((s) => s.playlists);
  const saved = useApp((s) => s.saved);
  const caps = useApp((s) => s.info?.capabilities);
  const phone = usePhoneLayout();
  const [q, setQ] = useState("");
  const albumSort = useSettings((s) => s.albumSort);
  const artistSort = useSettings((s) => s.artistSort);
  useAsync(() => refreshLibrary(false), []);
  const cur: LibraryTab = tab ?? "playlists";
  if (cur === "recent") return <RecentPage />;
  if (!lib && err) return <ErrorBox message={err} onRetry={() => refreshLibrary(true)} />;

  const playlists = dedupe([...pls, ...(lib?.playlists ?? [])]);
  const liked = playlists.find((p) => /^yt:(VL)?LM$/.test(p.id));
  // Albums/Artists are what you saved. YouTube Music's library is the account's own saved
  // collection, so it counts; Plex's "library" is the whole server, so it doesn't.
  const ytLibrary = useApp.getState().info?.flavor === "youtube";
  const items: MediaItem[] =
    cur === "playlists"
      ? playlists.filter((p) => p !== liked).map((p) => ({ type: "playlist" as const, ...p }))
      : cur === "albums"
        ? sortAlbums(dedupe([...saved.albums, ...(ytLibrary ? lib?.albums ?? [] : [])]), albumSort).map((a) => ({ type: "album" as const, ...a }))
        : cur === "artists"
          ? sortArtists(dedupe([...saved.artists, ...(ytLibrary ? lib?.artists ?? [] : [])]), artistSort).map((a) => ({ type: "artist" as const, ...a }))
          : dedupe([...saved.podcasts, ...(lib?.podcasts ?? [])]).map((a) => ({ type: "podcast" as const, ...a }));
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((it) => (it.type === "artist" ? it.name : it.title).toLowerCase().includes(needle)) : items;
  const go = (tb: LibraryTab) => navigate({ name: "library", tab: tb }, true);

  if (!phone) {
    const title = cur === "playlists" ? t("playlists") : cur === "albums" ? t("albums") : cur === "artists" ? t("artists") : t("podcasts");
    return (
      <div className="page">
        <div className="row between">
          <h1>{title}</h1>
          <div className="row" style={{ gap: 8 }}>
            {(cur === "albums" || cur === "artists") && <LibrarySortButton tab={cur} />}
            <input className="lib-filter" style={{ width: 200 }} placeholder={t("filterLibrary")} aria-label={t("filterLibrary")} value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="pill ghost small" onClick={() => refreshLibrary(true)}>
              {t("sync")}
            </button>
          </div>
        </div>
        {tab == null && (
          <div className="chips">
            {(["playlists", "albums", "artists", ...(caps?.podcasts ? ["podcasts"] : [])] as LibraryTab[]).map((f) => (
              <button key={f} className={cls("chip", cur === f && "on")} aria-pressed={cur === f} onClick={() => go(f)}>
                {t(f as "playlists")}
              </button>
            ))}
          </div>
        )}
        {!lib && !err ? <Loading /> : shown.length ? <Grid items={shown} /> : <p className="muted">{t("empty")}</p>}
      </div>
    );
  }

  const podcasts = cur === "podcasts";
  return (
    <div className="page lib-classic">
      <div className="lib-top">
        <button className={cls("lib-big", !podcasts && "on")} onClick={() => go("playlists")}>
          {t("music")}
        </button>
        {caps?.podcasts && (
          <button className={cls("lib-big", podcasts && "on")} onClick={() => go("podcasts")}>
            {t("podcasts")}
          </button>
        )}
      </div>
      {!podcasts && (
        <div className="lib-tabs" role="tablist">
          {(["playlists", "artists", "albums"] as const).map((f) => (
            <button key={f} role="tab" aria-selected={cur === f} className={cls("lib-tab", cur === f && "on")} onClick={() => go(f)}>
              {t(f)}
            </button>
          ))}
        </div>
      )}
      {(cur === "albums" || cur === "artists") && (
        <div className="lib-sort-row">
          <LibrarySortButton tab={cur} />
        </div>
      )}
      <div className="lib-rows" key={cur + albumSort.key + albumSort.desc + artistSort.key + artistSort.desc}>
        {cur === "playlists" && (
          <>
            <LibRow
              icon={<div className="art grad-new"><I.IPlus size={26} /></div>}
              title={t("createPlaylist")}
              onClick={async () => {
                const pl = await createPlaylist();
                if (pl) navigate({ name: "playlist", id: pl.id });
              }}
            />
            {liked && <LibRow icon={<div className="art grad-liked"><I.IHeartFill size={24} /></div>} title={t("likedSongs")} sub={liked.trackCount != null ? t("songsCount", { n: liked.trackCount }) : undefined} onClick={() => navigate({ name: "playlist", id: liked.id })} />}
            <LibRow icon={<div className="art grad-local"><I.IFolder size={24} /></div>} title={t("localFiles")} onClick={() => navigate({ name: "local" })} />
            {caps?.downloads && <LibRow icon={<div className="art grad-dl"><I.IDownload size={24} /></div>} title={t("downloads")} onClick={() => navigate({ name: "downloads" })} />}
          </>
        )}
        {podcasts && (
          <LibRow icon={<div className="art grad-episodes"><I.IBookmark size={24} /></div>} title={t("yourEpisodes")} sub={t("episodesCount", { n: saved.episodes.length })} onClick={() => navigate({ name: "episodes" })} />
        )}
        {!lib && !err ? (
          <Loading />
        ) : (
          shown.map((it) => (
            <LibRow
              key={it.type + it.id}
              icon={<Art src={it.artwork} size={128} round={it.type === "artist"} />}
              title={it.type === "artist" ? it.name : it.title}
              sub={itemSubtitle(it, t)}
              onClick={() => openItem(it)}
              onContext={(e) => cardMenu(e, it)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** "Sort by" for Albums (Recently added, Alphabetical, Artist, Release year) and Artists. */
function LibrarySortButton({ tab }: { tab: "albums" | "artists" }) {
  const t = useT();
  const albumSort = useSettings((s) => s.albumSort);
  const artistSort = useSettings((s) => s.artistSort);
  const set = useSettings((s) => s.set);
  const options: { key: string; label: string }[] =
    tab === "albums"
      ? [
          { key: "recent", label: t("recentlyAdded") },
          { key: "alpha", label: t("sortAlpha") },
          { key: "artist", label: t("sortArtist") },
          { key: "year", label: t("sortReleaseDate") },
        ]
      : [
          { key: "recent", label: t("recentlyAdded") },
          { key: "alpha", label: t("sortAlpha") },
        ];
  const cur = tab === "albums" ? albumSort : artistSort;
  const label = options.find((o) => o.key === cur.key)?.label ?? options[0].label;
  const pick = (key: string) => {
    // Picking the current sort again reverses it; Release year starts newest first.
    const next = { key, desc: key === cur.key ? !cur.desc : key === "year" };
    if (tab === "albums") set({ albumSort: next as typeof albumSort });
    else set({ artistSort: next as typeof artistSort });
  };
  return (
    <button
      className="sort-btn lib-sort"
      aria-label={`${t("sortMenu")}: ${label}`}
      title={t("sortMenu")}
      onClick={(e) =>
        openMenu(e, [
          { label: t("sortMenu"), heading: true },
          ...options.map((o) => ({
            label: o.label,
            checked: o.key === cur.key,
            hint: o.key === cur.key ? (cur.desc ? "↓" : "↑") : undefined,
            onClick: () => pick(o.key),
          })),
        ])
      }
    >
      <span>{label}</span>
      <span aria-hidden="true">{cur.desc ? "↓" : "↑"}</span>
      <I.IQueue size={18} />
    </button>
  );
}

function LibRow(p: { icon: React.ReactNode; title: string; sub?: string; onClick: () => void; onContext?: (e: React.MouseEvent) => void }) {
  return (
    <div className="lib-row" role="button" tabIndex={0} onClick={p.onClick} onKeyDown={(e) => e.key === "Enter" && p.onClick()} onContextMenu={p.onContext}>
      {p.icon}
      <div className="lib-row-text">
        <span className="name">{p.title}</span>
        {p.sub && <span className="sub">{p.sub}</span>}
      </div>
    </div>
  );
}

/** Recently Played: the albums, playlists and artists you played lately, then the songs. */
function RecentPage() {
  const t = useT();
  const [data, setData] = useState<HomeData | null>(homeCache.data);
  useEffect(() => {
    if (!inTauri || homeCache.data) return;
    api.home(false).then((d) => {
      homeCache.data = d;
      setData(d);
    }, () => setData({ shelves: [], recent: [], contexts: [], topTracks: [], stale: false }));
  }, []);
  usePageTitle(t("recentlyPlayed"));
  if (!data) return <Loading />;
  const seen = new Set<string>();
  const items = data.contexts.filter((c) => !seen.has(c.id) && (seen.add(c.id), true)).map(ctxItem);
  return (
    <div className="page">
      <h1>{t("recentlyPlayed")}</h1>
      {items.length > 0 && <Grid items={items} />}
      {data.recent.length > 0 && (
        <>
          <h2>{t("songs")}</h2>
          <TrackList tracks={data.recent} />
        </>
      )}
      {!items.length && !data.recent.length && <p className="muted">{t("empty")}</p>}
    </div>
  );
}

function dedupe<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.id) && (seen.add(x.id), true));
}
