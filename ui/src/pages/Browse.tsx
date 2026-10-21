// Home, Search and the Library grid.
import { useEffect, useMemo, useRef, useState } from "react";
import { albumMenu, artistMenu, playlistMenu, trackMenu } from "../actions";
import { api, artUrl, errorMessage, inTauri } from "../api";
import { Art, Card, ErrorBox, Loading, PlayFab, Shelf, openItem, useAsync } from "../components/common";
import { TrackList } from "../components/TrackList";
import { shelfTitle, useT } from "../i18n";
import * as P from "../player/engine";
import { refreshLibrary, useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { navigate, openMenu, toast, useUi } from "../store/ui";
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
        <Shelf title={t("yourTopArtists")} onShowAll={() => navigate({ name: "library" })}>
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

function BrowseEmpty() {
  const t = useT();
  return (
    <div className="page">
      <h1>{t("search")}</h1>
      <p className="muted">{t("searchHint")}</p>
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

export function LibraryPage() {
  const t = useT();
  const lib = useApp((s) => s.library);
  const err = useApp((s) => s.libraryError);
  const pls = useApp((s) => s.playlists);
  const saved = useApp((s) => s.saved);
  const [tab, setTab] = useState<"playlists" | "albums" | "artists" | "podcasts">("playlists");
  useAsync(() => refreshLibrary(false), []);
  if (!lib && err) return <ErrorBox message={err} onRetry={() => refreshLibrary(true)} />;
  const items: MediaItem[] =
    tab === "playlists"
      ? [...pls, ...(lib?.playlists ?? [])].map((p) => ({ type: "playlist" as const, ...p }))
      : tab === "albums"
        ? dedupe([...saved.albums, ...(lib?.albums ?? [])]).map((a) => ({ type: "album" as const, ...a }))
        : tab === "artists"
          ? dedupe([...saved.artists, ...(lib?.artists ?? [])]).map((a) => ({ type: "artist" as const, ...a }))
          : (lib?.podcasts ?? []).map((a) => ({ type: "podcast" as const, ...a }));
  return (
    <div className="page">
      <div className="row between">
        <h1>{t("library")}</h1>
        <button className="pill ghost small" onClick={() => refreshLibrary(true)}>
          {t("sync")}
        </button>
      </div>
      <div className="lib-links">
        <button className="pill ghost small" onClick={() => navigate({ name: "local" })}>
          {t("localFiles")}
        </button>
        {useApp.getState().info?.capabilities.downloads && (
          <button className="pill ghost small" onClick={() => navigate({ name: "downloads" })}>
            {t("downloads")}
          </button>
        )}
        <button className="pill ghost small" onClick={() => navigate({ name: "import" })}>
          {t("transferPlaylists")}
        </button>
        <button className="pill ghost small" onClick={() => navigate({ name: "settings" })}>
          {t("settings")}
        </button>
      </div>
      <div className="chips">
        {(["playlists", "albums", "artists", "podcasts"] as const).map((f) => (
          <button key={f} className={cls("chip", tab === f && "on")} aria-pressed={tab === f} onClick={() => setTab(f)}>
            {t(f)}
          </button>
        ))}
      </div>
      {!lib && !err ? <Loading /> : items.length ? <Grid items={items} /> : <p className="muted">{t("empty")}</p>}
    </div>
  );
}

function dedupe<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.id) && (seen.add(x.id), true));
}
