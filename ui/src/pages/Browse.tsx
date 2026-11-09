// Home, Search and the Library grid.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { albumMenu, artistMenu, likedSongsAvailable, playlistMenu, podcastMenu, providerOfId, trackMenu, usableProvider, usableProviders, visibleId } from "../actions";
import { api, artUrl, errorCode, inTauri } from "../api";
import {
  Art,
  Card,
  CollectionDownloadMark,
  ErrorBox,
  Loading,
  PlayFab,
  ProviderNotes,
  Shelf,
  itemSubtitle,
  openItem,
  useAsync,
  useCaps,
  useHasDownloads,
  usePageTitle,
  usePhoneLayout,
  useProvidersKey,
} from "../components/common";
import * as I from "../components/Icons";
import { TrackList } from "../components/TrackList";
import { localError, shelfTitle, translate, useT } from "../i18n";
import * as P from "../player/engine";
import { refreshLibrary, useApp } from "../store/app";
import { capsOf, sourceOf, useBothOn, useOn } from "../store/providers";
import { useMe } from "../store/profile";
import { sortAlbums, sortArtists } from "../store/librarySort";
import { setSort, setView, useFolders } from "../store/folders";
import { useSettings } from "../store/settings";
import { confirmDialog, navigate, openMenu, toast, useUi, type LibraryTab } from "../store/ui";
import { useDisplayTrack } from "../store/songmeta";
import type { BrowseCategory, HistoryEntry, HomeData, Library, MediaItem, PlayContext, Playlist, Provider, ProviderError, SearchResults, Track } from "../types";
import { PROVIDERS } from "../types";
import { useArtistLinks, useLinkRequest } from "../store/artistLinks";
import { dedupeArtists, emptyResults, isEmptyResults, mergeSearch, partErrors, type SearchParts } from "../searchMerge";
import { cls, isYtLiked, serviceLabel } from "../util";

/** Play any card: tracks play directly, collections are fetched first. */
export async function playItem(item: MediaItem) {
  try {
    if (item.type === "track") return P.playTracks([item], 0, null);
    if (item.type === "album") {
      const a = await api.album(item.id);
      return P.playTracks(a.tracks, 0, { kind: "album", id: item.id, title: a.album.title, artwork: a.album.artwork });
    }
    if (item.type === "playlist" && item.id === "liked") {
      const l = await api.likedTracks(false);
      return P.playTracks(l.tracks, 0, { kind: "playlist", id: "liked", title: item.title });
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
    toast(localError(e));
  }
}

export function cardMenu(e: React.MouseEvent, item: MediaItem) {
  const head = { title: item.type === "artist" ? item.name : item.title, art: item.artwork, round: item.type === "artist", sub: itemSubtitle(item, (k, v) => translate(useSettings.getState().language, k, v)) };
  if (item.type === "track") return openMenu(e, trackMenu(item), head);
  if (item.type === "album") return openMenu(e, albumMenu(item, async () => (await api.album(item.id)).tracks), head);
  if (item.type === "playlist") return openMenu(e, playlistMenu(item, async () => (await api.playlist(item.id)).tracks), head);
  if (item.type === "artist") return openMenu(e, artistMenu(item), head);
  if (item.type === "podcast") return openMenu(e, podcastMenu(item), head);
}

const homeCache: { data: HomeData | null } = { data: null };

// What the UI keeps from the services that were on is forgotten when the switches or sign-ins
// change: Home, search results and Browse all are fetched again for the new set of services.
useApp.subscribe((s, prev) => {
  if (s.services === prev.services && s.auth === prev.auth) return;
  homeCache.data = null;
  searchCache.clear();
  categoryCache.list = null;
  tileArt.clear();
});

export function Home() {
  const t = useT();
  const lang = useSettings((s) => s.language);
  const caps = useCaps();
  const services = useProvidersKey();
  const lib = useApp((s) => s.library);
  const appPls = useApp((s) => s.playlists);
  const [data, setData] = useState<HomeData | null>(homeCache.data);
  const [error, setError] = useState<string | null>(null);
  const filter = useUi((s) => s.homeFilter);
  const setFilter = (f: "all" | "music" | "podcasts") => useUi.setState({ homeFilter: f });
  const phone = usePhoneLayout();
  const htpc = useSettings((s) => s.htpc);

  // Shelves of every service that is on (the core merges them: Plex first, then YouTube). A
  // service that failed is named in `errors` and gets a small note; the rest still shows.
  const load = (refresh: boolean) => {
    if (!inTauri) return setData({ shelves: [], recent: [], contexts: [], topTracks: [], stale: false });
    setError(null);
    api.home(refresh).then(
      (d) => {
        // A partial answer isn't kept for later visits: the failed part is asked again.
        homeCache.data = partErrors(d).length ? null : d;
        setData(d);
      },
      (e) => setError(localError(e)),
    );
  };
  // Again when a service is switched on or off, or signs in or out.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(false), [services]);
  const errors = partErrors(data);

  const h = new Date().getHours();
  const greeting = h < 12 ? t("goodMorning") : h < 18 ? t("goodAfternoon") : t("goodEvening");

  // Shortcut grid: recently played contexts, then app playlists and library playlists.
  const shortcuts = useMemo(() => {
    const out: { id: string; title: string; artwork?: string | null; ctx: PlayContext }[] = [];
    const seen = new Set<string>();
    for (const c of data?.contexts ?? []) {
      if (seen.has(c.id) || !visibleId(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, title: c.title, artwork: c.artwork, ctx: c });
    }
    for (const p of [...appPls, ...(lib?.playlists ?? [])]) {
      if (out.length >= 8) break;
      if (seen.has(p.id) || !visibleId(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, title: p.title, artwork: p.artwork, ctx: { kind: "playlist", id: p.id, title: p.title, artwork: p.artwork } });
    }
    return out.slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, appPls, lib, services]);
  // Songs of a service that is off are left out (they can't play).
  const recent = (data?.recent ?? []).filter((x) => visibleId(x.id));
  const topTracks = (data?.topTracks ?? []).filter((x) => visibleId(x.id));
  const links = useArtistLinks((s) => s.links);
  const libArtists = (lib?.artists ?? []).filter((a) => visibleId(a.id));
  useLinkRequest(libArtists);
  const topArtists = dedupeArtists(libArtists, links);

  if (!data && !error) return <Loading />;

  const shelves = (data?.shelves ?? []).filter((s) => {
    if (filter === "all") return true;
    const pod = s.items.some((i) => i.type === "podcast" || (i.type === "track" && i.episode));
    return filter === "podcasts" ? pod : !pod;
  });

  const openCtx = (c: PlayContext) =>
    navigate(c.kind === "album" ? { name: "album", id: c.id } : c.kind === "artist" ? { name: "artist", id: c.id } : c.id === "liked" ? { name: "liked" } : { name: "playlist", id: c.id });
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
      {/* Phones show these chips in the top bar, next to your picture. */}
      {caps.podcasts && !phone && (
        <div className="chips">
          {(["all", "music", "podcasts"] as const).map((f) => (
            <button key={f} className={cls("chip", filter === f && "on")} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {t(f === "all" ? "all" : f === "music" ? "music" : "podcasts")}
            </button>
          ))}
        </div>
      )}
      {!phone && <h1 className="greeting">{greeting}</h1>}
      {data?.stale && !errors.length && <p className="muted small">{t("offline")}</p>}
      <ProviderNotes errors={errors} />
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
      {filter !== "podcasts" && recent.length > 0 && (
        <Shelf title={t("recentlyPlayed")}>
          {dedupeAlbums(recent).map((tr) => (
            <Card key={tr.id} item={{ type: "track", ...tr }} onPlay={() => P.playTracks([tr], 0, null)} onContext={(e) => cardMenu(e, { type: "track", ...tr })} />
          ))}
        </Shelf>
      )}
      {filter !== "podcasts" && topTracks.length > 0 && (
        <Shelf title={t("yourTopTracks")}>
          {topTracks.map((tr, i) => (
            <Card key={tr.id} item={{ type: "track", ...tr }} onPlay={() => P.playTracks(topTracks, i, { kind: "top", id: "top", title: t("yourTopTracks") })} onContext={(e) => cardMenu(e, { type: "track", ...tr })} />
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
      {filter !== "podcasts" && topArtists.length > 0 && (
        <Shelf title={t("yourTopArtists")} onShowAll={() => navigate({ name: "library", tab: "artists" })}>
          {topArtists.slice(0, 12).map((a) => (
            <Card key={a.id} item={{ type: "artist", ...a }} onPlay={() => playItem({ type: "artist", ...a })} onContext={(e) => cardMenu(e, { type: "artist", ...a })} />
          ))}
        </Shelf>
      )}
      {!error && !errors.length && !shortcuts.length && !shelves.length && !recent.length && <p className="muted center">{t("homeEmpty")}</p>}
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

/** Finished searches (every part answered, none failed), by kind, services and query. */
const searchCache = new Map<string, SearchParts>();
type SFilter = "all" | "songs" | "artists" | "albums" | "playlists" | "podcasts" | "episodes";
type SearchSource = Provider | "local";

/** Who to ask: each service that can answer (for podcasts and episodes only those that have
 * them), then local files with app playlists. */
function searchSources(kind: SFilter | null): SearchSource[] {
  const pod = kind === "podcasts" || kind === "episodes";
  const out: SearchSource[] = PROVIDERS.filter((p) => usableProvider(p) && (!pod || capsOf(p).podcasts));
  if (!pod) out.push("local");
  return out;
}

interface SearchState {
  key: string;
  parts: SearchParts;
  /** Sources whose request failed. */
  failed: { source: SearchSource; code: string; message: string }[];
  /** Sources still on their way. */
  pending: number;
  /** The services asked. */
  providers: Provider[];
}

/** Failures of the services (not local files), for the notes. */
const providerErrors = (s: SearchState): ProviderError[] =>
  s.failed.flatMap((f) => (f.source === "local" ? [] : [{ provider: f.source, code: f.code, message: f.message }]));

/**
 * One search, asked of every source at once after typing pauses. Each answer shows as it arrives,
 * so YouTube's results never wait for a slow Plex server. `kind` asks for the full list of one
 * type (a filter chip).
 */
function useSearch(query: string, kind: SFilter | null, enabled: boolean): SearchState | null {
  const services = useProvidersKey();
  const key = `${kind ?? "all"}\u0000${services}\u0000${query.toLowerCase()}`;
  const [state, setState] = useState<SearchState | null>(null);
  useEffect(() => {
    if (!enabled || !query) return;
    const sources = searchSources(kind);
    const providers = sources.filter((s): s is Provider => s !== "local");
    const cached = searchCache.get(key);
    if (cached || !sources.length) return setState({ key, parts: cached ?? {}, failed: [], pending: 0, providers });
    let live = true;
    setState({ key, parts: {}, failed: [], pending: sources.length, providers });
    // Debounced; answers for an older query are dropped.
    const timer = setTimeout(() => {
      if (!inTauri) return setState({ key, parts: {}, failed: [], pending: 0, providers });
      const parts: SearchParts = {};
      const failed: SearchState["failed"] = [];
      let left = sources.length;
      for (const src of sources) {
        const provider = src === "local" ? null : src;
        (kind ? api.searchKind(query, kind, provider) : api.search(query, provider))
          .then(
            (r) => void (parts[src] = r),
            (e) => void failed.push({ source: src, code: errorCode(e) ?? "network", message: localError(e, provider ?? undefined) }),
          )
          .finally(() => {
            left--;
            if (!live) return;
            // Only complete answers are kept: a part that failed is asked again next time.
            if (!left && !failed.length && !Object.values(parts).some((r) => partErrors(r).length)) {
              searchCache.set(key, { ...parts });
              if (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value!);
            }
            setState({ key, parts: { ...parts }, failed: [...failed], pending: left, providers });
          });
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return enabled && state?.key === key ? state : null;
}

/** Merge what has arrived; null before the first answer. Also says whether every service asked
 * failed with nothing else to show (then an error box, as with one service before). */
function useMerged(query: string, s: SearchState | null): { res: SearchResults | null; errors: ProviderError[]; failure: string | null } {
  return useMemo(() => {
    if (!s) return { res: null, errors: [], failure: null };
    const errors = providerErrors(s);
    const arrived = Object.keys(s.parts).length > 0;
    // Local files and app playlists come back from SQLite at once; they never stand alone while a
    // service is still on its way (the spinner, or the last results, stay up as with one service).
    const providerArrived = s.providers.some((p) => p in s.parts);
    const providersDone = s.providers.every((p) => p in s.parts || s.failed.some((f) => f.source === p));
    const res = arrived && (providerArrived || providersDone) ? mergeSearch(query, s.parts, errors) : null;
    const allFailed = s.providers.length > 0 && s.providers.every((p) => s.failed.some((f) => f.source === p));
    const nothing = !res || isEmptyResults(res);
    const failure = s.pending === 0 && (allFailed || (!arrived && s.failed.length > 0)) && nothing ? s.failed[0]?.message ?? null : null;
    return { res, errors: [...errors, ...Object.values(s.parts).flatMap((r) => partErrors(r))], failure };
  }, [s, query]);
}

export function Search({ q }: { q: string }) {
  const t = useT();
  const caps = useCaps();
  const [filter, setFilter] = useState<SFilter>("all");
  const query = q.trim();
  const all = useSearch(query, null, !!query);
  const kind = useSearch(query, filter === "all" ? null : filter, !!query && filter !== "all");
  const overview = useMerged(query, all);
  const full = useMerged(query, kind);
  // While a new query is on its way, the last results stay on screen.
  const last = useRef<SearchResults | null>(null);
  const links = useArtistLinks((s) => s.links);
  useLinkRequest(overview.res?.artists);
  useLinkRequest(full.res?.artists);
  if (overview.res) last.current = overview.res;
  if (!query) last.current = null;
  const loading = !all || all.pending > 0;

  if (!query) return <BrowseEmpty />;
  const filters: SFilter[] = ["all", "songs", "artists", "albums", "playlists", ...(caps.podcasts ? (["podcasts", "episodes"] as SFilter[]) : [])];
  const ctx: PlayContext = { kind: "search", id: query, title: query };
  const r = overview.res ?? (loading ? last.current : null) ?? (overview.failure ? null : loading ? null : emptyResults());
  // Full list for the active filter as it arrives; the overview's results meanwhile.
  const kindLoading = filter !== "all" && (!kind || kind.pending > 0);
  const fr = filter !== "all" && full.res ? full.res : r;
  const shown = filter === "all" || !kind || kind.pending > 0 ? overview : full;
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
      {shown.failure ? <ErrorBox message={shown.failure} /> : <ProviderNotes errors={shown.errors} />}
      {r && !loading && !overview.failure && isEmptyResults(r) && <p className="center muted">{t("noResults", { q: query })}</p>}
      {r && filter === "all" && (
        <>
          <div className="search-top">
            {r.top && (
              <section className="top-result">
                <h2>{t("topResult")}</h2>
                <div className="top-card" data-source={sourceOf(r.top.id) ?? undefined} role="button" tabIndex={0} onClick={() => openItem(r.top!)} onKeyDown={(e) => e.key === "Enter" && openItem(r.top!)} onContextMenu={(e) => cardMenu(e, r.top!)}>
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
          <CardShelf title={t("artists")} items={dedupeArtists(r.artists, links).map((a) => ({ type: "artist" as const, ...a }))} />
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
      {fr && filter === "artists" && <Grid items={dedupeArtists(fr.artists, links).map((a) => ({ type: "artist" as const, ...a }))} />}
      {fr && filter === "albums" && <Grid items={fr.albums.map((a) => ({ type: "album" as const, ...a }))} />}
      {fr && filter === "playlists" && <Grid items={fr.playlists.map((a) => ({ type: "playlist" as const, ...a }))} />}
      {fr && filter === "podcasts" && <Grid items={fr.podcasts.map((a) => ({ type: "podcast" as const, ...a }))} />}
    </div>
  );
}

/** What's New: recent releases from artists you follow, then the provider's new-release feed. */
export function WhatsNewPage() {
  const t = useT();
  const lang = useSettings((s) => s.language);
  const [refresh, setRefresh] = useState(0);
  const { data, error, loading } = useAsync(() => (inTauri ? api.newReleases(refresh > 0) : Promise.resolve([])), [refresh]);
  usePageTitle(t("whatsNew"));
  return (
    <div className="page">
      <div className="row between">
        <h1>{t("whatsNew")}</h1>
        <button className="pill ghost small" onClick={() => setRefresh((n) => n + 1)} disabled={loading}>
          {t("sync")}
        </button>
      </div>
      <p className="muted">{t("whatsNewHint")}</p>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} onRetry={() => setRefresh((n) => n + 1)} />
      ) : data && data.length ? (
        data.map((s, i) => <CardShelf key={s.title + i} title={shelfTitle(lang, s.title)} items={s.items} />)
      ) : (
        <p className="muted">{t("whatsNewEmpty")}</p>
      )}
    </div>
  );
}

// Spotify's tile colours, for tiles the provider gives no colour.
const TILE_COLORS = ["#dc148c", "#006450", "#8400e7", "#1e3264", "#e8115b", "#477d95", "#ba5d07", "#8d67ab", "#e91429", "#27856a", "#503750", "#148a08", "#509bf5", "#af2896", "#e13300", "#7358ff", "#0d73ec", "#bc5900"];
const tileColor = (title: string) => TILE_COLORS[[...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TILE_COLORS.length];

const categoryCache: { list: BrowseCategory[] | null } = { list: null };

/** Keeps a Browse all list for the session only when every service asked gave its part: a list
 * missing one service (it timed out or was unreachable) is shown but asked for again next visit,
 * so that service's genres come back once it answers (the core caches each part on its own). */
function keepCategories(list: BrowseCategory[]): BrowseCategory[] {
  const complete = usableProviders().every((p) => list.some((c) => providerOfId(c.id) === p));
  categoryCache.list = complete ? list : null;
  return list;
}
const tileArt = new Map<string, string | null>();

/** Search with nothing typed: Spotify's "Browse all": the provider's genres, moods and sections
 * as colourful tiles with a cover, then shortcuts into your library. */
function BrowseEmpty() {
  const t = useT();
  const caps = useCaps();
  const services = useProvidersKey();
  const both = useBothOn();
  const plexOn = useOn("plex");
  const hasDownloads = useHasDownloads();
  // Genres and moods come from the services that can answer (YouTube also without an account).
  const usable = PROVIDERS.some(usableProvider);
  const [cats, setCats] = useState<BrowseCategory[] | null>(categoryCache.list);
  const [error, setError] = useState<string | null>(null);
  usePageTitle(t("browseAll"));
  useEffect(() => {
    if (!inTauri || !usable) return;
    if (categoryCache.list) return setCats(categoryCache.list);
    setCats(null);
    setError(null);
    api.browseCategories(false).then(
      (l) => setCats(keepCategories(l)),
      (e) => setError(localError(e)),
    );
  }, [usable, services]);
  const liked = likedSongsAvailable();
  const tiles: { label: string; color: string; go: () => void; icon: React.ReactNode }[] = [
    ...(liked ? [{ label: t("likedSongs"), color: "#5038a0", go: () => navigate({ name: "liked" }), icon: <I.IHeartFill size={36} /> }] : []),
    { label: t("whatsNew"), color: "#e13300", go: () => navigate({ name: "new" }), icon: <I.IBell size={36} /> },
    { label: t("recentlyPlayed"), color: "#1e3264", go: () => navigate({ name: "library", tab: "recent" }), icon: <I.IClock size={36} /> },
    { label: t("listeningHistory"), color: "#7358ff", go: () => navigate({ name: "history" }), icon: <I.IHistory size={36} /> },
    { label: t("playlists"), color: "#8d67ab", go: () => navigate({ name: "library", tab: "playlists" }), icon: <I.IQueue size={36} /> },
    { label: t("albums"), color: "#e8115b", go: () => navigate({ name: "library", tab: "albums" }), icon: <I.IMusic size={36} /> },
    { label: t("artists"), color: "#148a08", go: () => navigate({ name: "library", tab: "artists" }), icon: <I.IMic size={36} /> },
    ...(caps.podcasts
      ? [
          { label: t("podcasts"), color: "#006450", go: () => navigate({ name: "library", tab: "podcasts" }), icon: <I.IBookmark size={36} /> },
          { label: t("yourEpisodes"), color: "#477d95", go: () => navigate({ name: "episodes" }), icon: <I.IPlay size={36} /> },
        ]
      : []),
    { label: t("localFiles"), color: "#ba5d07", go: () => navigate({ name: "local" }), icon: <I.IFolder size={36} /> },
    ...(plexOn || hasDownloads ? [{ label: t("downloads"), color: "#27856a", go: () => navigate({ name: "downloads" }), icon: <I.IDownload size={36} /> }] : []),
  ];
  // One group per service (YouTube Music's sections, moods and genres; Plex's genres), titled only
  // while both are on.
  const groups = PROVIDERS.map((p) => ({ p, list: (cats ?? []).filter((c) => providerOfId(c.id) === p) })).filter((g) => g.list.length > 0);
  const retry = () => (setError(null), api.browseCategories(true).then((l) => setCats(keepCategories(l)), (e) => setError(localError(e))));
  return (
    <div className="page browse-page">
      <h1>{t("browseAll")}</h1>
      {usable &&
        (cats ? (
          groups.map((g) => (
            <Fragment key={g.p}>
              {both && <h2 className="browse-group">{serviceLabel(g.p)}</h2>}
              <div className="browse-tiles" data-provider={g.p}>
                {g.list.map((c) => (
                  <CategoryTile key={c.id} cat={c} />
                ))}
              </div>
            </Fragment>
          ))
        ) : error ? (
          <ErrorBox message={error} onRetry={retry} />
        ) : (
          <Loading />
        ))}
      <h2>{t("yourLibrary")}</h2>
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

/** One genre/mood tile: its cover (the first picture on its page) is fetched once it scrolls into view. */
function CategoryTile({ cat }: { cat: BrowseCategory }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [art, setArt] = useState<string | null | undefined>(tileArt.get(cat.id));
  useEffect(() => {
    if (art !== undefined || !inTauri) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      api.browseArt(cat.id).then(
        (a) => (tileArt.set(cat.id, a), setArt(a)),
        () => setArt(null),
      );
    });
    io.observe(el);
    return () => io.disconnect();
  }, [cat.id, art]);
  const url = artUrl(art, 200);
  return (
    <button ref={ref} className="browse-tile" style={{ background: cat.color || tileColor(cat.title) }} onClick={() => navigate({ name: "browse", id: cat.id, title: cat.title })}>
      <span>{cat.title}</span>
      {url && <img className="bt-art" src={url} alt="" loading="lazy" draggable={false} />}
    </button>
  );
}

/** The page behind a "Browse all" tile: the provider's shelves for that genre, mood or section. */
export function BrowseCategoryPage({ id, title }: { id: string; title: string }) {
  const t = useT();
  const lang = useSettings((s) => s.language);
  const { data, error, loading, reload } = useAsync(() => api.browsePage(id), [id]);
  usePageTitle(title);
  return (
    <div className="page">
      <h1>{title}</h1>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : data && data.some((s) => s.items.length) ? (
        data.map((s, i) =>
          data.length === 1 ? <Grid key={i} items={s.items} /> : <CardShelf key={s.title + i} title={shelfTitle(lang, s.title)} items={s.items} />,
        )
      ) : (
        <p className="muted">{t("empty")}</p>
      )}
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

/** Your Library: categories on desktop; on phones, PhoneLibrary. */
export function LibraryPage({ tab }: { tab?: LibraryTab }) {
  const t = useT();
  const lib = useApp((s) => s.library);
  const err = useApp((s) => s.libraryError);
  const pls = useApp((s) => s.playlists);
  const saved = useApp((s) => s.saved);
  const caps = useCaps();
  useProvidersKey();
  const phone = usePhoneLayout();
  const [q, setQ] = useState("");
  const albumSort = useSettings((s) => s.albumSort);
  const artistSort = useSettings((s) => s.artistSort);
  const links = useArtistLinks((s) => s.links);
  useAsync(() => refreshLibrary(false), []);
  useLinkRequest(libraryCollections(lib, pls, saved, []).artists);
  const cur: LibraryTab = tab ?? "playlists";
  if (cur === "recent") return <RecentPage />;
  if (!lib && err) return <ErrorBox message={err} onRetry={() => refreshLibrary(true)} />;

  const c = libraryCollections(lib, pls, saved, links);
  const items: MediaItem[] =
    cur === "playlists"
      ? c.playlists.map((p) => ({ type: "playlist" as const, ...p }))
      : cur === "albums"
        ? sortAlbums(c.albums, albumSort).map((a) => ({ type: "album" as const, ...a }))
        : cur === "artists"
          ? sortArtists(c.artists, artistSort).map((a) => ({ type: "artist" as const, ...a }))
          : c.podcasts.map((a) => ({ type: "podcast" as const, ...a }));
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
            {(["playlists", "albums", "artists", ...(caps.podcasts ? ["podcasts"] : [])] as LibraryTab[]).map((f) => (
              <button key={f} className={cls("chip", cur === f && "on")} aria-pressed={cur === f} onClick={() => go(f)}>
                {t(f as "playlists")}
              </button>
            ))}
          </div>
        )}
        <ProviderNotes errors={partErrors(lib)} />
        {!lib && !err ? <Loading /> : shown.length ? <Grid items={shown} /> : <p className="muted">{t("empty")}</p>}
      </div>
    );
  }

  return <PhoneLibrary tab={tab} c={c} />;
}

/**
 * What Your Library lists, from the services that are on:
 * - playlists: the app's, then the services' (YouTube's Liked Music is Liked Songs instead);
 * - albums and artists: the ones saved in the app, plus YouTube Music's library (the account's
 *   own collection). Plex's library is the whole server, so its albums and artists count only
 *   once saved. An artist saved from several sources is listed once once the backend confirms it is one artist;
 * - podcasts: followed in the app and YouTube's.
 */
function libraryCollections(lib: Library | null, appPls: Playlist[], saved: SavedState, links: [string, string][]) {
  const yt = <T extends { id: string }>(xs: T[] | undefined) => (xs ?? []).filter((x) => providerOfId(x.id) === "youtube");
  const shown = <T extends { id: string }>(xs: T[]) => xs.filter((x) => visibleId(x.id));
  return {
    playlists: shown(dedupe([...appPls, ...(lib?.playlists ?? [])])).filter((p) => !isYtLiked(p.id)),
    albums: shown(dedupe([...saved.albums, ...yt(lib?.albums)])),
    // Once per artist (confirmed links): the page of the one kept merges the other sources' copies.
    artists: dedupeArtists(shown(dedupe([...saved.artists, ...yt(lib?.artists)])), links),
    podcasts: shown(dedupe([...saved.podcasts, ...(lib?.podcasts ?? [])])),
  };
}
type SavedState = ReturnType<typeof useApp.getState>["saved"];
type Collections = ReturnType<typeof libraryCollections>;

type PhoneChip = "playlists" | "podcasts" | "albums" | "artists";

/** Your Library on phones, as in Spotify's app: Playlists · Artists · Albums tabs (the older
 * underlined style), a sort row with the list/grid switch, then everything in one list: Liked
 * Songs and the app's own collections first. */
function PhoneLibrary({ tab, c }: { tab?: LibraryTab; c: Collections }) {
  const t = useT();
  const lib = useApp((s) => s.library);
  const err = useApp((s) => s.libraryError);
  const saved = useApp((s) => s.saved);
  const likedCount = useApp((s) => s.liked.size);
  const caps = useCaps();
  const plexOn = useOn("plex");
  const hasDownloads = useHasDownloads();
  const org = useFolders();
  const me = useMe();
  const chip: PhoneChip | null = tab === "playlists" || tab === "podcasts" || tab === "albums" || tab === "artists" ? tab : null;
  const liked = likedSongsAvailable();
  const of = (k: PhoneChip) => !chip || chip === k;
  const items: MediaItem[] = [
    ...(of("playlists") ? c.playlists.map((p) => ({ type: "playlist" as const, ...p })) : []),
    ...(of("podcasts") ? c.podcasts.map((a) => ({ type: "podcast" as const, ...a })) : []),
    ...(of("albums") ? c.albums.map((a) => ({ type: "album" as const, ...a })) : []),
    ...(of("artists") ? c.artists.map((a) => ({ type: "artist" as const, ...a })) : []),
  ];
  const name = (it: MediaItem) => (it.type === "artist" ? it.name : it.title);
  const creator = (it: MediaItem) =>
    it.type === "playlist" ? it.owner ?? "" : it.type === "album" ? it.artist : it.type === "podcast" ? it.author ?? "" : it.type === "artist" ? it.name : it.artist;
  const sorted =
    org.sort === "alpha"
      ? [...items].sort((a, b) => name(a).localeCompare(name(b)))
      : org.sort === "creator"
        ? [...items].sort((a, b) => creator(a).localeCompare(creator(b)) || name(a).localeCompare(name(b)))
        : org.sort === "added"
          ? items.map((it, i) => ({ it, i })).sort((a, b) => (org.added[b.it.id] ?? 0) - (org.added[a.it.id] ?? 0) || a.i - b.i).map((x) => x.it)
          : items;
  const grid = org.view === "grid" || org.view === "compactGrid";
  const go = (c: PhoneChip | null) => navigate(c ? { name: "library", tab: c } : { name: "library" }, true);
  const sortNames: Record<string, string> = { recent: t("sortRecent"), added: t("recentlyAdded"), alpha: t("sortAlpha"), creator: t("sortCreator"), custom: t("sortRecent") };
  const sortMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: t("sortMenu"), heading: true },
      ...(["recent", "added", "alpha", "creator"] as const).map((k) => ({ label: sortNames[k], checked: (org.sort === "custom" ? "recent" : org.sort) === k, onClick: () => setSort(k) })),
    ]);
  const pinned: { key: string; icon: React.ReactNode; title: string; sub?: string; pin?: boolean; go: () => void }[] = [
    ...(liked && of("playlists") ? [{ key: "liked", icon: <div className="art grad-liked"><I.IHeartFill size={grid ? 40 : 24} /></div>, title: t("likedSongs"), pin: true, sub: [t("playlist"), me.name || (likedCount ? t("songsCount", { n: likedCount }) : null)].filter(Boolean).join(" • "), go: () => navigate({ name: "liked" }) }] : []),
    ...(caps.podcasts && of("podcasts") ? [{ key: "episodes", icon: <div className="art grad-episodes"><I.IBookmark size={grid ? 40 : 24} /></div>, title: t("yourEpisodes"), pin: true, sub: [t("playlist"), t("episodesCount", { n: saved.episodes.length })].join(" • "), go: () => navigate({ name: "episodes" }) }] : []),
    ...(!chip ? [{ key: "local", icon: <div className="art grad-local"><I.IFolder size={grid ? 40 : 24} /></div>, title: t("localFiles"), go: () => navigate({ name: "local" }) }] : []),
    ...(!chip && (plexOn || hasDownloads) ? [{ key: "downloads", icon: <div className="art grad-dl"><I.IDownload size={grid ? 40 : 24} /></div>, title: t("downloads"), go: () => navigate({ name: "downloads" }) }] : []),
  ];
  return (
    <div className="page lib-phone">
      {/* The old Spotify tabs with the green underline; tap the open one again to show everything. */}
      <div className="lib-tabs" role="tablist">
        {(["playlists", "artists", "albums"] as const).map((c) => (
          <button key={c} role="tab" aria-selected={chip === c} className={cls("lib-tab", chip === c && "on")} onClick={() => go(chip === c ? null : c)}>
            {t(c)}
          </button>
        ))}
      </div>
      <div className="lib-sortbar">
        <button className="lib-sortbtn" onClick={sortMenu} aria-label={`${t("sortMenu")}: ${sortNames[org.sort]}`}>
          <I.ISort size={16} />
          <span>{sortNames[org.sort]}</span>
        </button>
        <button className="icon-btn" aria-label={grid ? t("viewList") : t("viewGrid")} title={grid ? t("viewList") : t("viewGrid")} onClick={() => setView(grid ? "list" : "grid")}>
          {grid ? <I.IViewList size={18} /> : <I.IViewGrid size={18} />}
        </button>
      </div>
      <ProviderNotes errors={partErrors(lib)} />
      {!lib && err ? (
        <ErrorBox message={err} onRetry={() => refreshLibrary(true)} />
      ) : (
        <div className={cls("lib-rows", grid && "lib-grid")} key={(chip ?? "all") + org.sort + org.view}>
          {pinned.map((x) => (
            <LibRow key={x.key} icon={x.icon} title={x.title} sub={x.sub} pin={x.pin} onClick={x.go} />
          ))}
          {!lib && !err ? (
            <Loading />
          ) : (
            sorted.map((it) => (
              <LibRow
                key={it.type + it.id}
                icon={<Art src={it.artwork} size={grid ? 240 : 128} round={it.type === "artist"} />}
                title={name(it)}
                badgeId={it.id}
                // Spotify's rows: "Playlist • maya" (app playlists are yours).
                sub={it.type === "playlist" ? [t("playlist"), it.local ? me.name : it.owner].filter(Boolean).join(" • ") : itemSubtitle(it, t)}
                onClick={() => openItem(it)}
                onContext={(e) => cardMenu(e, it)}
              />
            ))
          )}
        </div>
      )}
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

function LibRow(p: { icon: React.ReactNode; title: string; sub?: string; pin?: boolean; badgeId?: string; onClick: () => void; onContext?: (e: React.MouseEvent) => void }) {
  return (
    <div className="lib-row" data-source={sourceOf(p.badgeId) ?? undefined} role="button" tabIndex={0} onClick={p.onClick} onKeyDown={(e) => e.key === "Enter" && p.onClick()} onContextMenu={p.onContext}>
      {p.icon}
      <div className="lib-row-text">
        <span className="name">{p.title}</span>
        {p.sub && (
          <span className="sub">
            {p.pin && <I.IPin size={14} className="lib-pin" />}
            <CollectionDownloadMark id={p.badgeId} />
            {p.sub}
          </span>
        )}
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
      <div className="page-head-row">
        <h1>{t("recentlyPlayed")}</h1>
        <button className="pill ghost small" onClick={() => navigate({ name: "history" })}>
          <I.IHistory size={16} /> {t("listeningHistory")}
        </button>
      </div>
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

/** Every play, newest first, grouped by day, like Spotify's listening history. */
export function HistoryPage() {
  const t = useT();
  const lang = useSettings((s) => s.language);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  usePageTitle(t("listeningHistory"));
  const load = (before: number | null) => {
    setLoading(true);
    api
      .listeningHistory(before)
      .then(
        (page) => {
          setEntries((cur) => (before ? [...(cur ?? []), ...page] : page));
          setMore(page.length === HISTORY_PAGE);
        },
        (e) => {
          toast(localError(e));
          setEntries((cur) => cur ?? []);
        },
      )
      .finally(() => setLoading(false));
  };
  useEffect(() => load(null), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const days = useMemo(() => historyDays(entries ?? [], lang, t), [entries, lang]);
  if (!entries) return <Loading />;
  const tracks = entries.map((e) => e.track);
  const remove = (indexes: number[]) => {
    const ids = new Set(indexes.map((i) => entries[i].id));
    api.historyRemove([...ids]).then(() => setEntries((cur) => (cur ?? []).filter((e) => !ids.has(e.id))), (e) => toast(localError(e)));
  };
  const clear = async () => {
    if (!(await confirmDialog({ title: t("clearHistory"), body: t("clearHistoryBody"), confirm: t("clearHistory") }))) return;
    api.historyClear().then(() => (setEntries([]), setMore(false)), (e) => toast(localError(e)));
  };
  return (
    <div className="page history">
      <div className="page-head-row">
        <h1>{t("listeningHistory")}</h1>
        {entries.length > 0 && (
          <button className="pill ghost small" onClick={clear}>
            <I.ITrash size={16} /> {t("clearHistory")}
          </button>
        )}
      </div>
      <p className="muted small">{t("listeningHistoryHint")}</p>
      {!entries.length && <p className="muted">{t("historyEmpty")}</p>}
      {days.map((d) => (
        <section key={d.key} className="history-day">
          <h2>{d.label}</h2>
          <TrackList
            tracks={tracks.slice(d.offset, d.offset + d.count)}
            queue={{ tracks, offset: d.offset }}
            onRemove={(ix) => remove(ix.map((i) => i + d.offset))}
            removeLabel={t("removeFromHistory")}
          />
        </section>
      ))}
      {more && (
        <button className="pill ghost" disabled={loading} onClick={() => load(entries[entries.length - 1].id)}>
          {t("showMore")}
        </button>
      )}
    </div>
  );
}

const HISTORY_PAGE = 100;

/** Consecutive runs of plays on the same local day: "Today", "Yesterday", then dates. */
export function historyDays(entries: HistoryEntry[], lang: string, t: (k: "today" | "yesterday") => string, now = new Date()) {
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = dayKey(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = dayKey(y);
  const out: { key: string; label: string; offset: number; count: number }[] = [];
  entries.forEach((e, i) => {
    const d = new Date(e.playedAt * 1000);
    const key = dayKey(d);
    const last = out[out.length - 1];
    if (last?.key === key) return void last.count++;
    const label =
      key === today
        ? t("today")
        : key === yesterday
          ? t("yesterday")
          : d.toLocaleDateString(lang, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
    out.push({ key, label, offset: i, count: 1 });
  });
  return out;
}

function dedupe<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.id) && (seen.add(x.id), true));
}
