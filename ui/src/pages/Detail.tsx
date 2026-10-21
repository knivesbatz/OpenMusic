// Artist, album and playlist pages.
import { useState } from "react";
import { albumMenu, downloadTracks, playlistMenu, toggleSaved } from "../actions";
import { api, artUrl, errorMessage } from "../api";
import { Art, ArtistName, ErrorBox, JpText, Loading, PlayFab, useAsync } from "../components/common";
import * as I from "../components/Icons";
import { TrackList } from "../components/TrackList";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
import { refreshPlaylists, useApp } from "../store/app";
import { navigate, openMenu, toast } from "../store/ui";
import type { Album, Artist, PlayContext, Track } from "../types";
import { cls, fmtTime, totalDuration } from "../util";
import { CardShelf, Grid } from "./Browse";

function Hero({ art, kind, title, meta, round }: { art?: string | null; kind: string; title: string; meta: React.ReactNode; round?: boolean }) {
  return (
    <header className="hero">
      <Art src={art} size={480} round={round} className="hero-art" />
      <div className="hero-text">
        <span className="small">{kind}</span>
        <h1 className={cls(title.length > 28 && "long")}>
          <JpText text={title} />
        </h1>
        <div className="hero-meta">{meta}</div>
      </div>
    </header>
  );
}

function ActionBar({ tracks, ctx, onMore, extra }: { tracks: Track[]; ctx: PlayContext; onMore?: (e: React.MouseEvent) => void; extra?: React.ReactNode }) {
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
      <button className={cls("icon-btn lg", shuffle && "on")} aria-pressed={shuffle} aria-label={t("shuffle")} title={t("shuffle")} onClick={() => P.setShuffle(!shuffle)}>
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
    </div>
  );
}

export function AlbumPage({ id }: { id: string }) {
  const t = useT();
  const { data, error, loading, reload } = useAsync(() => api.album(id), [id]);
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
  const [more, setMore] = useState(false);
  const [disc, setDisc] = useState<Disc>("popular");
  const [showAll, setShowAll] = useState(false);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const name = data.artist?.name ?? "";
  const ctx: PlayContext = { kind: "artist", id, title: name, artwork: data.artist?.artwork };
  const all: Album[] = [...data.albums, ...data.singles];
  const discItems = disc === "albums" ? data.albums : disc === "singles" ? data.singles : disc === "appears" ? data.appearsOn : all.slice().sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
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
        <h1>
          <ArtistName name={name} />
        </h1>
      </header>
      <ActionBar tracks={data.topTracks} ctx={ctx} extra={data.artist && <FollowButton artist={data.artist} />} />
      {data.topTracks.length > 0 && (
        <section>
          <h2>{t("popular")}</h2>
          <TrackList tracks={data.topTracks} limit={more ? 10 : 5} context={ctx} showAlbum={false} />
          {data.topTracks.length > 5 && (
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
      {(data.localTracks?.length ?? 0) > 0 && (
        <section>
          <h2>{t("onThisComputer")}</h2>
          <TrackList tracks={data.localTracks!} context={{ kind: "artist-local", id, title: name }} showAlbum />
        </section>
      )}
      <CardShelf title={t("localAlbums")} items={(data.localAlbums ?? []).map((a) => ({ type: "album" as const, ...a }))} />
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
  const flavor = useApp((s) => s.info?.flavor);
  const { data, error, loading, reload } = useAsync(() => api.playlist(id), [id]);
  const [busy, setBusy] = useState(false);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? t("errorGeneric")} onRetry={reload} />;
  const { playlist, tracks } = data;
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
        kind={playlist.local ? t("appPlaylist") : t("remotePlaylist", { provider: flavor === "plex" ? "Plex" : "YouTube Music" })}
        title={playlist.title}
        meta={
          <>
            {playlist.description && <p className="muted">{playlist.description}</p>}
            {playlist.owner && <strong>{playlist.owner} • </strong>}
            {t("songsCount", { n: tracks.length })}, {fmtTime(totalDuration(tracks))}
          </>
        }
      />
      <ActionBar tracks={tracks} ctx={ctx} onMore={(e) => openMenu(e, playlistMenu(playlist, async () => tracks))} />
      {tracks.length ? (
        <TrackList
          tracks={tracks}
          context={ctx}
          onRemove={editable ? (idx) => reorder(tracks.map((_, i) => i).filter((i) => !idx.includes(i))) : undefined}
          onReorder={editable ? reorder : undefined}
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
