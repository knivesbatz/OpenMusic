// Artist, album and playlist pages.
import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { albumMenu, canChangeCover, changeCover, downloadTracks, likedMenu, likesOn, playlistMenu, plexDownloads, providerOfId, toggleSaved, trackHead, trackMenu } from "../actions";
import { api, artUrl, inTauri } from "../api";
import { Art, ArtistName, ErrorBox, Loading, PlayFab, ProviderNotes, TitleText, useAsync, usePageTitle, usePhoneLayout, useProvidersKey } from "../components/common";
import * as I from "../components/Icons";
import { TrackList } from "../components/TrackList";
import { localError, useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
import { refreshPlaylists, useApp } from "../store/app";
import { newestFirst, splitCompilations } from "../store/discography";
import { setPlaylistSort, sortTracks, usePlaylistSort, type SortKey } from "../store/playlistSort";
import { orderEpisodes, setOldestFirst, useOldestFirst } from "../store/podcastSort";
import { useSettings } from "../store/settings";
import { useMe } from "../store/profile";
import { navigate, openMenu, toast } from "../store/ui";
import type { Album, Artist, PlayContext, Track } from "../types";
import { partErrors } from "../searchMerge";
import { cls, fmtTime, totalDuration } from "../util";
import { CardShelf, Grid } from "./Browse";

export function Hero({
  art,
  kind,
  title,
  meta,
  round,
  onArt,
  artLabel,
  onTitle,
  placeholder,
}: {
  art?: string | null;
  kind: string;
  title: string;
  meta: React.ReactNode;
  round?: boolean;
  onArt?: () => void;
  /** Text under the pencil on hover ("Choose photo"). */
  artLabel?: string;
  onTitle?: () => void;
  placeholder?: React.ReactNode;
}) {
  // A color wash from the cover behind the header (Spotify style): the cover blown up so far
  // that only its colors show; no blur filter, which some GPUs choke on.
  const wash = artUrl(art, 60);
  return (
    <header className="hero">
      {wash && <div className="hero-wash" aria-hidden="true" style={{ backgroundImage: `url("${wash}")` }} />}
      {onArt ? (
        <button className={cls("hero-art-btn", round && "round")} onClick={onArt} aria-label={artLabel ?? kind}>
          <Art src={art} size={480} round={round} className="hero-art" placeholder={placeholder} />
          <span className="hero-art-edit">
            <span>
              <I.IEdit size={36} />
              {artLabel && <span className="hero-art-label">{artLabel}</span>}
            </span>
          </span>
        </button>
      ) : (
        <Art src={art} size={480} round={round} className="hero-art" />
      )}
      <div className="hero-text">
        <span className="small">{kind}</span>
        <h1 className={cls(title.length > 28 && "long", onTitle && "clickable")} onClick={onTitle}>
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
  useProvidersKey();
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
      {/* Downloads are Plex's: only for lists with Plex songs, while Plex is on. */}
      {plexDownloads() && tracks.some((x) => x.source === "plex") && (
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

/** Phones (Spotify's app): "Find in playlist" and a Sort button above the cover. Sort opens the
 * "Sort by" sheet. */
function PhoneFindBar({ id, tracks, value, onChange }: { id: string; tracks: Track[]; value: string | null; onChange: (v: string | null) => void }) {
  const t = useT();
  const { open } = useSortMenu(id, tracks);
  return (
    <div className="pl-findbar">
      <label className="pl-findfield">
        <I.ISearch size={18} />
        <input
          type="search"
          placeholder={t("findInPlaylist")}
          aria-label={t("findInPlaylist")}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.blur(), onChange(null))}
        />
      </label>
      <button className="pl-sortbtn" onClick={open}>
        {t("sortShort")}
      </button>
    </div>
  );
}

/** Spotify's search-in-playlist: an icon that opens a filter box. */
function PlaylistFind({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const t = useT();
  if (value === null)
    return (
      <button className="icon-btn" aria-label={t("searchInPlaylist")} title={t("searchInPlaylist")} onClick={() => onChange("")}>
        <I.ISearch size={18} />
      </button>
    );
  return (
    <label className="pl-find">
      <I.ISearch size={16} />
      <input
        autoFocus
        type="search"
        placeholder={t("searchInPlaylist")}
        aria-label={t("searchInPlaylist")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange(null)}
        onBlur={() => !value.trim() && onChange(null)}
      />
    </label>
  );
}

/** Spotify's "Sort by" / "View as" menu for a playlist; the choice is kept until changed. */
function useSortMenu(id: string, tracks: Track[]) {
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
  return { open, current, sort };
}

function SortButton({ id, tracks }: { id: string; tracks: Track[] }) {
  const t = useT();
  const { open, current, sort } = useSortMenu(id, tracks);
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
  const phone = usePhoneLayout();
  const { data, error, loading, reload } = useAsync(() => api.album(id), [id]);
  usePageTitle(data?.album.title, () => data && P.playTracks(data.tracks, 0, { kind: "album", id, title: data.album.title, artwork: data.album.artwork }), { art: data?.album.artwork, ctxId: id });
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const { album, tracks } = data;
  const ctx: PlayContext = { kind: "album", id, title: album.title, artwork: album.artwork };
  const artist = (
    <button className="link strong" onClick={() => album.artistId && navigateArtist(album.artistId)}>
      <ArtistName name={album.artist} />
    </button>
  );
  return (
    <div className="page detail">
      <Hero
        art={album.artwork}
        kind={album.kind ?? t("album")}
        title={album.title}
        meta={
          phone ? (
            // Spotify's app: the artist on one line, then "Album • 2015".
            <>
              <span className="hero-owner">{artist}</span>
              <span className="hero-stats">{[album.kind ?? t("album"), album.year].filter(Boolean).join(" • ")}</span>
            </>
          ) : (
            <>
              {artist}
              {album.year ? ` • ${album.year}` : ""} • {t("songsCount", { n: tracks.length })}, {fmtTime(totalDuration(tracks))}
            </>
          )
        }
      />
      <ActionBar
        tracks={tracks}
        ctx={ctx}
        onMore={(e) => openMenu(e, albumMenu(album, async () => tracks), { title: album.title, sub: album.artist, art: album.artwork })}
        extra={<SaveAlbumButton album={album} />}
      />
      <DiscTracks tracks={tracks} ctx={ctx} />
    </div>
  );
}

/** Album tracks, split under "Disc 1", "Disc 2"… headings when the album has several discs. */
function DiscTracks({ tracks, ctx }: { tracks: Track[]; ctx: PlayContext }) {
  const t = useT();
  const discs = useMemo(() => {
    const out: { disc: number; tracks: Track[]; offset: number }[] = [];
    tracks.forEach((tr, i) => {
      const d = tr.discNumber ?? 1;
      const last = out[out.length - 1];
      if (last && last.disc === d) last.tracks.push(tr);
      else out.push({ disc: d, tracks: [tr], offset: i });
    });
    return out;
  }, [tracks]);
  if (discs.length < 2) return <TrackList tracks={tracks} context={ctx} showAlbum={false} showArt={false} />;
  return (
    <>
      {discs.map((d) => (
        <section key={d.disc + ":" + d.offset} className="disc">
          <h3 className="disc-head">
            <I.IDisc size={18} />
            {t("discN", { n: d.disc })}
          </h3>
          <TrackList tracks={d.tracks} context={ctx} showAlbum={false} showArt={false} queue={{ tracks, offset: d.offset }} />
        </section>
      ))}
    </>
  );
}

const navigateArtist = (id: string) => navigate({ name: "artist", id });

type Disc = "popular" | "albums" | "singles" | "compilations" | "appears";

export function ArtistPage({ id }: { id: string }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.artist(id), [id]);
  // Compilations by name from MusicBrainz (YouTube Music doesn't mark them; Plex only when tagged).
  const artistName = data?.artist?.name ?? "";
  const { data: mbCompilations } = useAsync(() => (artistName ? api.artistCompilations(artistName) : Promise.resolve([])), [artistName]);
  usePageTitle(data?.artist?.name, () => data && P.playTracks(data.topTracks, 0, { kind: "artist", id, title: data.artist?.name ?? "", artwork: data.artist?.artwork }), { art: data?.artist?.artwork, ctxId: id });
  const [more, setMore] = useState(false);
  const [disc, setDisc] = useState<Disc>("popular");
  const [showAll, setShowAll] = useState(false);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const name = data.artist?.name ?? "";
  // Local files by this artist blend into Popular and the discography (no separate section). Local
  // copies of songs and releases already on the page took their place in the core
  // (artist_merge::add_local), so these are only the others.
  const localTracks = data.localTracks ?? [];
  const popular = [...data.topTracks.slice(0, 5), ...localTracks, ...data.topTracks.slice(5)];
  // Albums, singles and compilations each newest first, like Spotify.
  const { albums: albumsAll, compilations } = splitCompilations([...data.albums, ...(data.localAlbums ?? [])], mbCompilations ?? []);
  const singles = newestFirst(data.singles);
  const ctx: PlayContext = { kind: "artist", id, title: name, artwork: data.artist?.artwork };
  const all: Album[] = newestFirst([...albumsAll, ...singles, ...compilations]);
  const discItems =
    disc === "albums" ? albumsAll : disc === "singles" ? singles : disc === "compilations" ? compilations : disc === "appears" ? data.appearsOn : all;
  if (showAll)
    return (
      <div className="page">
        <div className="row between">
          <h1>{name}</h1>
          <button className="pill ghost small" onClick={() => setShowAll(false)}>
            {t("back")}
          </button>
        </div>
        <DiscChips disc={disc} setDisc={setDisc} hasAppears={data.appearsOn.length > 0} hasCompilations={compilations.length > 0} />
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
          <DiscChips disc={disc} setDisc={setDisc} hasAppears={data.appearsOn.length > 0} hasCompilations={compilations.length > 0} />
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

function DiscChips({ disc, setDisc, hasAppears, hasCompilations }: { disc: Disc; setDisc: (d: Disc) => void; hasAppears: boolean; hasCompilations: boolean }) {
  const t = useT();
  const opts: [Disc, string][] = [
    ["popular", t("popularReleases")],
    ["albums", t("albums")],
    ["singles", t("singlesEps")],
    ...(hasCompilations ? ([["compilations", t("compilations")]] as [Disc, string][]) : []),
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
  const phone = usePhoneLayout();
  const me = useMe();
  const accounts = useApp((s) => s.auth);
  const { data, error, loading, reload } = useAsync(() => api.playlist(id), [id]);
  usePageTitle(data?.playlist.title, () => data && P.playTracks(data.tracks, 0, { kind: "playlist", id, title: data.playlist.title, artwork: data.playlist.artwork }), {
    art: data?.playlist.artwork ?? data?.tracks[0]?.artwork,
    ctxId: id,
  });
  const [busy, setBusy] = useState(false);
  const sort = usePlaylistSort(id);
  const compact = useSettings((s) => s.compactTracks);
  const [find, setFind] = useState<string | null>(null);
  const rows = useMemo(() => {
    const sorted = sortTracks(data?.tracks ?? [], sort);
    const q = (find ?? "").trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(({ track: x }) => [x.title, x.artist, x.album].some((v) => v?.toLowerCase().includes(q)));
  }, [data, sort, find]);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const { playlist, tracks } = data;
  const shown = rows.map((r) => r.track);
  const sorted = sort.key !== "custom";
  const ctx: PlayContext = { kind: "playlist", id, title: playlist.title, artwork: playlist.artwork };
  const editable = playlist.local;
  // Your own playlists show your profile picture by your name, like Spotify: app playlists, and a
  // service's playlists owned by your account there.
  const service = providerOfId(id);
  const mine = playlist.local || (!!playlist.owner && (playlist.owner === me.name || (!!service && playlist.owner === accounts?.[service]?.account)));
  const ownerPhoto = mine ? artUrl(me.photo, 64) : undefined;

  async function reorder(order: number[]) {
    if (busy) return;
    setBusy(true);
    try {
      await api.plReorder(id, order);
      reload();
      refreshPlaylists();
    } catch (e) {
      toast(localError(e));
    }
    setBusy(false);
  }

  return (
    <div className="page detail">
      {phone && tracks.length > 1 && <PhoneFindBar id={id} tracks={tracks} value={find} onChange={setFind} />}
      <Hero
        art={playlist.artwork ?? tracks[0]?.artwork}
        kind={t("playlist")}
        onArt={canChangeCover(playlist) ? () => changeCover(playlist, reload) : undefined}
        title={playlist.title}
        meta={
          <>
            {playlist.description && <p className="muted hero-desc">{playlist.description}</p>}
            {playlist.owner && (
              <span className="hero-owner">
                {ownerPhoto ? (
                  <img className="avatar" src={ownerPhoto} alt="" />
                ) : (
                  <span className="avatar" aria-hidden="true">
                    {playlist.owner.slice(0, 1).toUpperCase()}
                  </span>
                )}
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
        onMore={(e) => openMenu(e, playlistMenu(playlist, async () => shown, reload), { title: playlist.title, sub: playlist.owner, art: playlist.artwork })}
        right={
          !phone &&
          tracks.length > 1 && (
            <>
              <PlaylistFind value={find} onChange={setFind} />
              <SortButton id={id} tracks={tracks} />
            </>
          )
        }
      />
      {tracks.length > 0 && !shown.length ? (
        <p className="muted pad">{t("noMatches")}</p>
      ) : tracks.length ? (
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
          // Dragging only makes sense in the playlist's own order, unfiltered.
          onReorder={editable && !sorted && !find?.trim() ? reorder : undefined}
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
    <div className={cls("ep-row", current && "current")} onContextMenu={(e) => openMenu(e, trackMenuFor(ep), trackHead(ep))}>
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
          <button className="icon-btn" aria-label={t("more")} onClick={(e) => openMenu(e, trackMenuFor(ep), trackHead(ep))}>
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
  // Episodes newest first (the provider's order) or oldest first, remembered per show.
  const oldestFirst = useOldestFirst(id);
  usePageTitle(data?.playlist.title, () => data && P.playTracks(orderEpisodes(data.tracks, oldestFirst), 0, { kind: "playlist", id, title: data.playlist.title, artwork: data.playlist.artwork }), {
    art: data?.playlist.artwork,
    ctxId: id,
  });
  const following = useApp((s) => s.saved.podcasts.some((p) => p.id === id));
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const { playlist } = data;
  const tracks = orderEpisodes(data.tracks, oldestFirst);
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
          <div className="row between">
            <h2>{t("allEpisodes")}</h2>
            {tracks.length > 1 && (
              <button
                className="sort-btn"
                aria-pressed={oldestFirst}
                title={t("sortMenu")}
                onClick={() => setOldestFirst(id, !oldestFirst)}
              >
                <span>{t(oldestFirst ? "oldestFirst" : "newestFirst")}</span>
                <span aria-hidden="true">{oldestFirst ? "↑" : "↓"}</span>
                <I.IQueue size={18} />
              </button>
            )}
          </div>
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

/** Liked Songs. When YouTube Music is the only service that keeps likes, it is YouTube's own
 * Liked Music playlist on the playlist page, exactly as in YTSpot 1.6.1 (its cover and colour
 * wash, owner, menu, sort and find). With Plex ratings too, both lists on one page. */
export function LikedPage() {
  useProvidersKey();
  return likesOn("youtube") && !likesOn("plex") ? <PlaylistPage id={YT_LIKED} /> : <MergedLikedPage />;
}

/** YouTube Music's liked songs playlist ("Liked Music"). */
const YT_LIKED = "yt:LM";

/** The songs you liked on YouTube Music and the tracks you rated on Plex, on one page. Laid out
 * like a playlist (Find in playlist, Sort, the pinned bar). */
function MergedLikedPage() {
  const t = useT();
  const phone = usePhoneLayout();
  const me = useMe();
  const services = useProvidersKey();
  const [refresh, setRefresh] = useState(0);
  const { data, error, loading, reload } = useAsync(() => (inTauri ? api.likedTracks(refresh > 0) : Promise.resolve({ tracks: [], stale: false })), [services, refresh]);
  // A service's part that arrived after the page stopped waiting for it.
  useEffect(() => {
    if (!inTauri) return;
    const un = listen("liked-changed", reload);
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tracks = data?.tracks ?? [];
  const title = t("likedSongs");
  const ctx: PlayContext = { kind: "playlist", id: "liked", title };
  usePageTitle(title, () => data && P.playTracks(tracks, 0, ctx), { ctxId: "liked" });
  const sort = usePlaylistSort("liked");
  const compact = useSettings((s) => s.compactTracks);
  const [find, setFind] = useState<string | null>(null);
  const rows = useMemo(() => {
    const sorted = sortTracks(tracks, sort);
    const q = (find ?? "").trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(({ track: x }) => [x.title, x.artist, x.album].some((v) => v?.toLowerCase().includes(q)));
  }, [tracks, sort, find]);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={() => setRefresh((n) => n + 1)} />;
  const shown = rows.map((r) => r.track);
  const ownerPhoto = artUrl(me.photo, 64);
  return (
    <div className="page detail">
      {phone && tracks.length > 1 && <PhoneFindBar id="liked" tracks={tracks} value={find} onChange={setFind} />}
      <header className="hero">
        <div className="art hero-art grad-liked" aria-hidden="true">
          <I.IHeartFill size={96} />
        </div>
        <div className="hero-text">
          <span className="small">{t("playlist")}</span>
          <h1>{title}</h1>
          <div className="hero-meta">
            {me.name && (
              <span className="hero-owner">
                {ownerPhoto ? (
                  <img className="avatar" src={ownerPhoto} alt="" />
                ) : (
                  <span className="avatar" aria-hidden="true">
                    {me.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <strong>{me.name}</strong>
              </span>
            )}
            <span className="hero-stats">
              {t("songsCount", { n: tracks.length })} • {fmtLong(t, totalDuration(tracks))}
            </span>
          </div>
        </div>
      </header>
      <ActionBar
        tracks={shown}
        ctx={ctx}
        onMore={(e) => openMenu(e, likedMenu(shown), { title, sub: me.name || undefined })}
        right={
          !phone &&
          tracks.length > 1 && (
            <>
              <PlaylistFind value={find} onChange={setFind} />
              <SortButton id="liked" tracks={tracks} />
            </>
          )
        }
      />
      {data.stale && !partErrors(data).length && <p className="muted small pad">{t("offline")}</p>}
      <ProviderNotes errors={partErrors(data)} />
      {tracks.length > 0 && !shown.length ? (
        <p className="muted pad">{t("noMatches")}</p>
      ) : tracks.length ? (
        <TrackList tracks={shown} context={ctx} showArt={!compact} />
      ) : (
        <p className="muted pad">{t("empty")}</p>
      )}
    </div>
  );
}
