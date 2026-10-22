// Artist, album and playlist pages.
import { useMemo, useState } from "react";
import { albumMenu, changeCover, downloadTracks, playlistMenu, toggleSaved, trackMenu } from "../actions";
import { api, artUrl, errorMessage } from "../api";
import { Art, ArtistName, ErrorBox, Loading, PlayFab, TitleText, useAsync, usePageTitle } from "../components/common";
import * as I from "../components/Icons";
import { TrackList } from "../components/TrackList";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
import { refreshPlaylists, useApp } from "../store/app";
import { setPlaylistSort, sortTracks, usePlaylistSort, type SortKey } from "../store/playlistSort";
import { useSettings } from "../store/settings";
import { navigate, openMenu, toast } from "../store/ui";
import type { Album, Artist, PlayContext, Track } from "../types";
import { cls, fmtTime, totalDuration } from "../util";
import { CardShelf, Grid } from "./Browse";

function Hero({ art, kind, title, meta, round, onArt }: { art?: string | null; kind: string; title: string; meta: React.ReactNode; round?: boolean; onArt?: () => void }) {
  // A color wash from the cover behind the header (Spotify style): the cover blown up so far
  // that only its colors show; no blur filter, which some GPUs choke on.
  const wash = artUrl(art, 60);
  return (
    <header className="hero">
      {wash && <div className="hero-wash" aria-hidden="true" style={{ backgroundImage: `url("${wash}")` }} />}
      {onArt ? (
        <button className="hero-art-btn" onClick={onArt} aria-label={kind}>
          <Art src={art} size={480} round={round} className="hero-art" />
          <span className="hero-art-edit">
            <I.IEdit size={36} />
          </span>
        </button>
      ) : (
        <Art src={art} size={480} round={round} className="hero-art" />
      )}
      <div className="hero-text">
        <span className="small">{kind}</span>
        <h1 className={cls(title.length > 28 && "long")}>
          <TitleText text={title} />
        </h1>
        <div className="hero-meta">{meta}</div>
      </div>
    </header>
  );
}

/** "2 h 26 min" / "48 min", like Spotify's playlist header. */
function fmtLong(t: ReturnType<typeof useT>, sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? t("hoursMinutes", { h, m }) : t("minutesOnly", { m });
}

function ActionBar({ tracks, ctx, onMore, extra, right }: { tracks: Track[]; ctx: PlayContext; onMore?: (e: React.MouseEvent) => void; extra?: React.ReactNode; right?: React.ReactNode }) {
  const t = useT();
  const playingHere = usePlayer((s) => s.playing && s.context?.id === ctx.id);
  const shuffle = usePlayer((s) => s.shuffle);
  const caps = useApp((s) => s.info?.capabilities);
  return (
    <div className="action-bar">
      {playingHere ? (
        <button className="fab big static" aria-label={t("pause")} onClick={P.pause}>
          <I.IPause size={24} />
        </button>
      ) : (
        <PlayFab big label={t("play")} onClick={() => P.playTracks(tracks, 0, ctx)} />
      )}
      <button className={cls("icon-btn lg ab-shuffle", shuffle && "on")} aria-pressed={shuffle} aria-label={t("shuffle")} title={t("shuffle")} onClick={() => P.setShuffle(!shuffle)}>
        <I.IShuffle size={26} />
      </button>
      {caps?.downloads && tracks.some((x) => x.source === "plex") && (
        <button className="icon-btn lg" aria-label={t("download")} title={t("download")} onClick={() => downloadTracks(tracks)}>
          <I.IDownload size={26} />
        </button>
      )}
      {extra}
      {onMore && (
        <button className="icon-btn lg" aria-label={t("more")} title={t("more")} onClick={onMore}>
          <I.IMore size={26} />
        </button>
      )}
      {right && <div className="ab-right">{right}</div>}
    </div>
  );
}

/** Spotify's "Sort by" / "View as" menu for a playlist; the choice is kept until changed. */
function SortButton({ id, tracks }: { id: string; tracks: Track[] }) {
  const t = useT();
  const sort = usePlaylistSort(id);
  const compact = useSettings((s) => s.compactTracks);
  const setSettings = useSettings((s) => s.set);
  const keys: { key: SortKey; label: string; show: boolean }[] = [
    { key: "custom", label: t("sortCustom"), show: true },
    { key: "title", label: t("sortTitle"), show: true },
    { key: "artist", label: t("sortArtist"), show: true },
    { key: "album", label: t("sortAlbum"), show: true },
    { key: "added", label: t("recentlyAdded"), show: tracks.some((x) => x.addedAt != null) },
    { key: "year", label: t("sortReleaseDate"), show: tracks.some((x) => x.year != null) },
    { key: "duration", label: t("sortDuration"), show: true },
  ];
  const current = keys.find((k) => k.key === sort.key) ?? keys[0];
  const open = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: t("sortMenu"), heading: true },
      ...keys
        .filter((k) => k.show)
        .map((k) => ({
          label: k.label,
          checked: k.key === sort.key,
          hint: k.key === sort.key && k.key !== "custom" ? (sort.desc ? "↓" : "↑") : undefined,
          // Picking the current sort again flips its direction, like Spotify.
          onClick: () => setPlaylistSort(id, { key: k.key, desc: k.key === sort.key ? !sort.desc : k.key === "added" }),
        })),
      { label: "", separator: true },
      { label: t("viewAs"), heading: true },
      { label: t("viewCompact"), checked: compact, onClick: () => setSettings({ compactTracks: true }) },
      { label: t("viewList"), checked: !compact, onClick: () => setSettings({ compactTracks: false }) },
    ]);
  return (
    <button className="sort-btn" aria-label={`${t("sortMenu")}: ${current.label}`} title={t("sortMenu")} onClick={open}>
      <span>{current.label}</span>
      {sort.key !== "custom" && <span aria-hidden="true">{sort.desc ? "↓" : "↑"}</span>}
      <I.IQueue size={18} />
    </button>
  );
}

export function AlbumPage({ id }: { id: string }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.album(id), [id]);
  usePageTitle(data?.album.title, () => data && P.playTracks(data.tracks, 0, { kind: "album", id, title: data.album.title, artwork: data.album.artwork }));
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const { album, tracks } = data;
  const ctx: PlayContext = { kind: "album", id, title: album.title, artwork: album.artwork };
  return (
    <div className="page detail">
      <Hero
        art={album.artwork}
        kind={album.kind ?? t("album")}
        title={album.title}
        meta={
          <>
            <button className="link strong" onClick={() => album.artistId && navigateArtist(album.artistId)}>
              <ArtistName name={album.artist} />
            </button>
            {album.year ? ` • ${album.year}` : ""} • {t("songsCount", { n: tracks.length })}, {fmtTime(totalDuration(tracks))}
          </>
        }
      />
      <ActionBar
        tracks={tracks}
        ctx={ctx}
        onMore={(e) => openMenu(e, albumMenu(album, async () => tracks))}
        extra={<SaveAlbumButton album={album} />}
      />
      <TrackList tracks={tracks} context={ctx} showAlbum={false} showArt={false} />
    </div>
  );
}

const navigateArtist = (id: string) => navigate({ name: "artist", id });

type Disc = "popular" | "albums" | "singles" | "appears";

export function ArtistPage({ id }: { id: string }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.artist(id), [id]);
  usePageTitle(data?.artist?.name, () => data && P.playTracks(data.topTracks, 0, { kind: "artist", id, title: data.artist?.name ?? "", artwork: data.artist?.artwork }));
  const [more, setMore] = useState(false);
  const [disc, setDisc] = useState<Disc>("popular");
  const [showAll, setShowAll] = useState(false);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const name = data.artist?.name ?? "";
  // Local files by this artist blend into Popular and the discography (no separate section).
  const localTracks = data.localTracks ?? [];
  const popular = [...data.topTracks.slice(0, 5), ...localTracks, ...data.topTracks.slice(5)];
  const albumsAll = [...data.albums, ...(data.localAlbums ?? [])];
  const ctx: PlayContext = { kind: "artist", id, title: name, artwork: data.artist?.artwork };
  const all: Album[] = [...albumsAll, ...data.singles];
  const discItems = disc === "albums" ? albumsAll : disc === "singles" ? data.singles : disc === "appears" ? data.appearsOn : all.slice().sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  if (showAll)
    return (
      <div className="page">
        <div className="row between">
          <h1>{name}</h1>
          <button className="pill ghost small" onClick={() => setShowAll(false)}>
            {t("back")}
          </button>
        </div>
        <DiscChips disc={disc} setDisc={setDisc} hasAppears={data.appearsOn.length > 0} />
        <Grid items={discItems.map((a) => ({ type: "album" as const, ...a }))} />
      </div>
    );
  return (
    <div className="page detail">
      <header className="artist-hero" style={data.artist?.artwork ? { ["--hero" as string]: `url(${JSON.stringify(artBg(data.artist.artwork))})` } : undefined}>
        <div className="artist-hero-text">
          <h1>
            <ArtistName name={name} />
          </h1>
          {data.followers && <p className="artist-followers">{t("followersCount", { n: data.followers })}</p>}
        </div>
      </header>
      <ActionBar tracks={popular} ctx={ctx} extra={data.artist && <FollowButton artist={data.artist} />} />
      {popular.length > 0 && (
        <section>
          <h2>{t("popular")}</h2>
          <TrackList tracks={popular} limit={more ? 10 + localTracks.length : 5 + Math.min(localTracks.length, 5)} context={ctx} showAlbum={false} />
          {popular.length > 5 + Math.min(localTracks.length, 5) && (
            <button className="link small" onClick={() => setMore(!more)}>
              {more ? t("showLess") : t("seeMore")}
            </button>
          )}
        </section>
      )}
      {(all.length > 0 || data.appearsOn.length > 0) && (
        <section className="shelf">
          <div className="shelf-head">
            <h2>{t("discography")}</h2>
            <button className="link" onClick={() => setShowAll(true)}>
              {t("showAll")}
            </button>
          </div>
          <DiscChips disc={disc} setDisc={setDisc} hasAppears={data.appearsOn.length > 0} />
          <Grid items={discItems.slice(0, 12).map((a) => ({ type: "album" as const, ...a }))} />
        </section>
      )}
      <CardShelf title={t("fansAlsoLike")} items={data.related.map((a) => ({ type: "artist" as const, ...a }))} />
      {disc !== "appears" && <CardShelf title={t("appearsOn")} items={data.appearsOn.map((a) => ({ type: "album" as const, ...a }))} />}
      {data.description && (
        <section className="about">
          <h2>{t("about")}</h2>
          <p>{data.description}</p>
        </section>
      )}
    </div>
  );
}

const artBg = (a: string) => artUrl(a, 1000) ?? "";

function DiscChips({ disc, setDisc, hasAppears }: { disc: Disc; setDisc: (d: Disc) => void; hasAppears: boolean }) {
  const t = useT();
  const opts: [Disc, string][] = [
    ["popular", t("popularReleases")],
    ["albums", t("albums")],
    ["singles", t("singlesEps")],
    ...(hasAppears ? ([["appears", t("appearsOn")]] as [Disc, string][]) : []),
  ];
  return (
    <div className="chips">
      {opts.map(([k, label]) => (
        <button key={k} className={cls("chip", disc === k && "on")} aria-pressed={disc === k} onClick={() => setDisc(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function PlaylistPage({ id }: { id: string }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.playlist(id), [id]);
  usePageTitle(data?.playlist.title, () => data && P.playTracks(data.tracks, 0, { kind: "playlist", id, title: data.playlist.title, artwork: data.playlist.artwork }));
  const [busy, setBusy] = useState(false);
  const sort = usePlaylistSort(id);
  const compact = useSettings((s) => s.compactTracks);
  const rows = useMemo(() => sortTracks(data?.tracks ?? [], sort), [data, sort]);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const { playlist, tracks } = data;
  const shown = rows.map((r) => r.track);
  const sorted = sort.key !== "custom";
  const ctx: PlayContext = { kind: "playlist", id, title: playlist.title, artwork: playlist.artwork };
  const editable = playlist.local;

  async function reorder(order: number[]) {
    if (busy) return;
    setBusy(true);
    try {
      await api.plReorder(id, order);
      reload();
      refreshPlaylists();
    } catch (e) {
      toast(errorMessage(e));
    }
    setBusy(false);
  }

  return (
    <div className="page detail">
      <Hero
        art={playlist.artwork ?? tracks[0]?.artwork}
        kind={t("playlist")}
        onArt={editable ? () => changeCover(playlist, reload) : undefined}
        title={playlist.title}
        meta={
          <>
            {playlist.description && <p className="muted hero-desc">{playlist.description}</p>}
            {playlist.owner && (
              <span className="hero-owner">
                <span className="avatar" aria-hidden="true">
                  {playlist.owner.slice(0, 1).toUpperCase()}
                </span>
                <strong>{playlist.owner}</strong>
              </span>
            )}
            <span className="hero-stats">
              {t("songsCount", { n: tracks.length })} • {fmtLong(t, totalDuration(tracks))}
            </span>
          </>
        }
      />
      <ActionBar
        tracks={shown}
        ctx={ctx}
        onMore={(e) => openMenu(e, playlistMenu(playlist, async () => shown))}
        right={tracks.length > 1 && <SortButton id={id} tracks={tracks} />}
      />
      {tracks.length ? (
        <TrackList
          tracks={shown}
          context={ctx}
          showArt={!compact}
          onRemove={
            editable
              ? (idx) => {
                  // Positions in the sorted view map back to the playlist's own order.
                  const gone = new Set(idx.map((i) => rows[i].index));
                  reorder(tracks.map((_, i) => i).filter((i) => !gone.has(i)));
                }
              : undefined
          }
          // Dragging only makes sense in the playlist's own order.
          onReorder={editable && !sorted ? reorder : undefined}
        />
      ) : (
        <p className="muted pad">{editable ? t("playlistEmptyHint") : t("empty")}</p>
      )}
    </div>
  );
}

function SaveAlbumButton({ album }: { album: Album }) {
  const t = useT();
  const saved = useApp((s) => s.saved.albums.some((a) => a.id === album.id));
  const label = saved ? t("removeFromLibrary") : t("saveToLibrary");
  return (
    <button className={cls("icon-btn lg", saved && "saved")} aria-pressed={saved} aria-label={label} title={label} onClick={() => toggleSaved({ kind: "album", v: album })}>
      {saved ? <I.IChecked size={30} /> : <I.IAddCircle size={30} />}
    </button>
  );
}

function FollowButton({ artist }: { artist: Artist }) {
  const t = useT();
  const saved = useApp((s) => s.saved.artists.some((a) => a.id === artist.id));
  return (
    <button className={cls("pill ghost small follow", saved && "on")} aria-pressed={saved} onClick={() => toggleSaved({ kind: "artist", v: artist })}>
      {saved ? t("following") : t("follow")}
    </button>
  );
}

// ---- podcasts (YouTube Music) ------------------------------------------------------------------

function EpisodeRow({ ep, onPlay }: { ep: Track; onPlay: () => void }) {
  const t = useT();
  const current = usePlayer((s) => s.queue.items[s.queue.index]?.track.id === ep.id);
  const playing = usePlayer((s) => s.playing) && current;
  const saved = useApp((s) => s.saved.episodes.some((e) => e.id === ep.id));
  return (
    <div className={cls("ep-row", current && "current")} onContextMenu={(e) => openMenu(e, trackMenuFor(ep))}>
      <Art src={ep.artwork} size={240} className="ep-art" />
      <div className="ep-body">
        <div className="ep-title">
          <TitleText text={ep.title} />
        </div>
        {ep.description && <div className="ep-desc">{ep.description}</div>}
        <div className="ep-actions">
          <button className="ep-play" aria-label={playing ? t("pause") : t("play")} onClick={playing ? P.pause : onPlay}>
            {playing ? <I.IPause size={18} /> : <I.IPlay size={18} />}
          </button>
          <span className="muted small">{[ep.published, ep.durationMs ? fmtLong(t, ep.durationMs / 1000) : null].filter(Boolean).join(" • ")}</span>
          <span className="grow" />
          <button className={cls("icon-btn", saved && "on")} aria-pressed={saved} aria-label={saved ? t("removeFromYourEpisodes") : t("saveToYourEpisodes")} title={saved ? t("removeFromYourEpisodes") : t("saveToYourEpisodes")} onClick={() => toggleSaved({ kind: "episode", v: ep })}>
            {saved ? <I.IChecked size={22} /> : <I.IAddCircle size={22} />}
          </button>
          <button className="icon-btn" aria-label={t("more")} onClick={(e) => openMenu(e, trackMenuFor(ep))}>
            <I.IMore size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

const trackMenuFor = (ep: Track) => trackMenu(ep, {});

/** A show, laid out like Spotify's: header, Follow, the episode list and About. */
export function PodcastPage({ id }: { id: string }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.playlist(id), [id]);
  usePageTitle(data?.playlist.title, () => data && P.playTracks(data.tracks, 0, { kind: "playlist", id, title: data.playlist.title, artwork: data.playlist.artwork }));
  const following = useApp((s) => s.saved.podcasts.some((p) => p.id === id));
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const { playlist, tracks } = data;
  const ctx: PlayContext = { kind: "playlist", id, title: playlist.title, artwork: playlist.artwork };
  const podcast = { id, title: playlist.title, author: playlist.owner ?? null, artwork: playlist.artwork ?? null };
  return (
    <div className="page detail podcast-page">
      <Hero art={playlist.artwork} kind={t("podcast")} title={playlist.title} meta={playlist.owner && <strong>{playlist.owner}</strong>} />
      <div className="action-bar">
        <button className={cls("pill ghost follow", following && "on")} aria-pressed={following} onClick={() => toggleSaved({ kind: "podcast", v: podcast })}>
          {following ? t("following") : t("follow")}
        </button>
        <span className="grow" />
        {tracks.length > 0 && <PlayFab big label={t("play")} onClick={() => P.playTracks(tracks, 0, ctx)} />}
      </div>
      <div className="podcast-cols">
        <section className="podcast-eps">
          <h2>{t("allEpisodes")}</h2>
          {tracks.length ? tracks.map((ep, i) => <EpisodeRow key={ep.id} ep={ep} onPlay={() => P.playTracks(tracks, i, ctx)} />) : <p className="muted">{t("empty")}</p>}
        </section>
        {playlist.description && (
          <aside className="podcast-about">
            <h2>{t("about")}</h2>
            <p className="muted">{playlist.description}</p>
          </aside>
        )}
      </div>
    </div>
  );
}

/** "Your Episodes": episodes saved in the app. */
export function EpisodesPage() {
  const t = useT();
  const eps = useApp((s) => s.saved.episodes);
  const ctx: PlayContext = { kind: "playlist", id: "episodes", title: t("yourEpisodes") };
  return (
    <div className="page detail podcast-page">
      <header className="hero">
        <div className="art hero-art grad-episodes" aria-hidden="true">
          <I.IBookmark size={96} />
        </div>
        <div className="hero-text">
          <span className="small">{t("playlist")}</span>
          <h1>{t("yourEpisodes")}</h1>
          <div className="hero-meta">{t("episodesCount", { n: eps.length })}</div>
        </div>
      </header>
      {eps.length ? eps.map((ep, i) => <EpisodeRow key={ep.id} ep={ep} onPlay={() => P.playTracks(eps, i, ctx)} />) : <p className="muted pad">{t("yourEpisodesEmpty")}</p>}
    </div>
  );
}
