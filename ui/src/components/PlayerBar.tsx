import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { playlistSubmenu, toggleLike, trackMenu } from "../actions";
import { api, inTauri } from "../api";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
import { isMobileApp, useApp } from "../store/app";
import { useDisplayTrack } from "../store/songmeta";
import { useSettings } from "../store/settings";
import { navigate, openMenu, useUi } from "../store/ui";
import { cls, fmtTime, isTouch } from "../util";
import { Art, ArtistName, TitleText } from "./common";
import * as I from "./Icons";

export function Seek({ compact }: { compact?: boolean }) {
  const pos = usePlayer((s) => s.position);
  const dur = usePlayer((s) => s.duration);
  const [drag, setDrag] = useState<number | null>(null);
  const t = useT();
  const value = drag ?? pos;
  const pct = dur ? (value / dur) * 100 : 0;
  return (
    <div className={cls("seek", compact && "compact")}>
      {!compact && <span className="time">{fmtTime(value)}</span>}
      <input
        type="range"
        className="slider"
        min={0}
        max={dur || 1}
        step={0.5}
        value={value}
        aria-label={t("seek")}
        aria-valuetext={`${fmtTime(value)} / ${fmtTime(dur)}`}
        style={{ ["--pct" as string]: pct + "%" }}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => drag !== null && (P.seek(drag), setDrag(null))}
        onKeyUp={() => drag !== null && (P.seek(drag), setDrag(null))}
      />
      {!compact && <span className="time">{fmtTime(dur)}</span>}
    </div>
  );
}

export function Transport({ big }: { big?: boolean }) {
  const t = useT();
  const playing = usePlayer((s) => s.playing);
  const loading = usePlayer((s) => s.loading);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const sz = big ? 24 : 18;
  return (
    <div className="transport">
      <button className={cls("icon-btn", shuffle && "on")} aria-pressed={shuffle} aria-label={t("shuffle")} title={t("shuffle")} onClick={() => P.setShuffle(!shuffle)}>
        <I.IShuffle size={sz} />
      </button>
      <button className="icon-btn" aria-label={t("previous")} title={t("previous")} onClick={P.previous}>
        <I.IPrev size={sz} />
      </button>
      <button className={cls("play-btn", big && "big", loading && "loading")} aria-label={playing ? t("pause") : t("play")} title={playing ? t("pause") : t("play")} onClick={P.toggle}>
        {playing ? <I.IPause size={big ? 26 : 18} /> : <I.IPlay size={big ? 26 : 18} />}
      </button>
      <button className="icon-btn" aria-label={t("next")} title={t("next")} onClick={() => P.next()}>
        <I.INext size={sz} />
      </button>
      <button
        className={cls("icon-btn", repeat !== "off" && "on")}
        aria-label={repeat === "one" ? t("repeatOne") : repeat === "all" ? t("repeat") : t("repeatOff")}
        title={repeat === "one" ? t("repeatOne") : repeat === "all" ? t("repeat") : t("repeatOff")}
        onClick={P.cycleRepeat}
      >
        <I.IRepeat size={sz} />
        {repeat === "one" && <span className="one">1</span>}
      </button>
    </div>
  );
}

export function Volume() {
  const t = useT();
  const volume = useSettings((s) => s.volume);
  const set = useSettings((s) => s.set);
  const last = useRef(volume || 0.8);
  return (
    <div className="volume">
      <button
        className="icon-btn"
        aria-label={volume ? t("mute") : t("unmute")}
        title={volume ? t("mute") : t("unmute")}
        onClick={() => {
          if (volume) {
            last.current = volume;
            set({ volume: 0 });
          } else set({ volume: last.current || 0.8 });
        }}
      >
        {volume ? <I.IVolume size={18} /> : <I.IMute size={18} />}
      </button>
      <input
        type="range"
        className="slider"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        aria-label={t("volume")}
        style={{ ["--pct" as string]: volume * 100 + "%" }}
        onChange={(e) => set({ volume: Number(e.target.value) })}
      />
    </div>
  );
}

export function SaveButton() {
  const t = useT();
  const track = usePlayer((s) => s.queue.items[s.queue.index]?.track);
  const caps = useApp((s) => s.info?.capabilities);
  const liked = useApp((s) => (track ? s.liked.has(track.id) : false));
  if (!track) return null;
  if (caps?.favorites && track.source !== "local")
    return (
      <span className="save-group">
        <button className={cls("icon-btn", liked && "on")} aria-pressed={liked} aria-label={liked ? t("unlike") : t("like")} title={liked ? t("unlike") : t("like")} onClick={() => toggleLike(track)}>
          {liked ? <I.IHeartFill size={18} /> : <I.IHeart size={18} />}
        </button>
        <button className="icon-btn" aria-label={t("addToPlaylist")} title={t("addToPlaylist")} onClick={(e) => openMenu(e, playlistSubmenu([track]))}>
          <I.IPlus size={18} />
        </button>
      </span>
    );
  return (
    <button className="icon-btn" aria-label={t("addToPlaylist")} title={t("addToPlaylist")} onClick={(e) => openMenu(e, playlistSubmenu([track]))}>
      <I.IAddCircle size={18} />
    </button>
  );
}

export function PlayerBar() {
  const t = useT();
  const item = usePlayer((s) => s.queue.items[s.queue.index]);
  const shown = useDisplayTrack(item?.track);
  const quality = usePlayer((s) => s.quality);
  const offline = usePlayer((s) => s.offline);
  const queueOpen = useUi((s) => s.queueOpen);
  const lyricsOpen = useUi((s) => s.lyricsOpen);
  const [pip, setPip] = useState(false);
  const tr = shown;

  useEffect(() => {
    if (!inTauri) return;
    const un = listen("pip-closed", () => setPip(false));
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => {
    if (tr) document.title = `${tr.title} • ${tr.artist}`;
    else document.title = useApp.getState().info?.name ?? "OpenMusic";
  }, [tr]);

  return (
    <footer
      className="playerbar"
      aria-label={t("nowPlaying")}
      // Phone: the whole mini player opens the song screen, except its own buttons.
      onClick={(e) => tr && isTouch() && !(e.target as HTMLElement).closest("button:not(.pb-art):not(.link), input") && useUi.setState({ fullscreen: true })}
    >
      <div className="pb-left">
        {tr && (
          <>
            <button className="pb-art" onClick={() => useUi.setState({ fullscreen: true })} aria-label={t("fullscreen")}>
              <Art src={tr.artwork} size={120} />
            </button>
            <div className="pb-meta" onContextMenu={(e) => openMenu(e, trackMenu(tr, { queueUid: undefined }))}>
              <button className="link name" onClick={() => (isTouch() ? useUi.setState({ fullscreen: true }) : tr.albumId && navigate({ name: "album", id: tr.albumId }))}>
                <TitleText text={tr.title} />
              </button>
              <button className="link sub" onClick={() => (isTouch() ? useUi.setState({ fullscreen: true }) : tr.artistId && navigate({ name: "artist", id: tr.artistId }))}>
                <ArtistName name={tr.artist} />
              </button>
            </div>
            <SaveButton />
          </>
        )}
      </div>
      <div className="pb-center">
        <Transport />
        <Seek />
      </div>
      {tr && <MiniControls />}
      <div className="pb-right">
        {quality && (
          <span className="quality" title={offline ? t("offlineAvailable") : t("audioQuality")}>
            {offline ? "⤓ " : ""}
            {quality}
          </span>
        )}
        <button className={cls("icon-btn", lyricsOpen && "on")} aria-pressed={lyricsOpen} aria-label={t("lyrics")} title={t("lyrics")} onClick={() => useUi.setState({ fullscreen: true, lyricsOpen: true })}>
          <I.IMic size={18} />
        </button>
        <button className={cls("icon-btn", queueOpen && "on")} aria-pressed={queueOpen} aria-label={t("queue")} title={t("queue")} onClick={() => useUi.setState({ queueOpen: !queueOpen })}>
          <I.IQueue size={18} />
        </button>
        <Volume />
        {inTauri && !isMobileApp() && (
          <button className={cls("icon-btn", pip && "on")} aria-label={t("miniPlayer")} title={t("miniPlayer")} onClick={() => api.pipToggle().then(setPip)}>
            <I.IPip size={18} />
          </button>
        )}
        <button className="icon-btn" aria-label={t("fullscreen")} title={t("fullscreen")} onClick={() => useUi.setState({ fullscreen: true })}>
          <I.IFullscreen size={18} />
        </button>
      </div>
    </footer>
  );
}

/** Phone layout: play/pause and next on the mini player, plus a thin progress line. */
function MiniControls() {
  const t = useT();
  const playing = usePlayer((s) => s.playing);
  const pos = usePlayer((s) => s.position);
  const dur = usePlayer((s) => s.duration);
  return (
    <div className="pb-mobile">
      <button className="icon-btn" aria-label={playing ? t("pause") : t("play")} onClick={P.toggle}>
        {playing ? <I.IPause size={24} /> : <I.IPlay size={24} />}
      </button>
      <button className="icon-btn" aria-label={t("next")} onClick={() => P.next()}>
        <I.INext size={22} />
      </button>
      <div className="pb-line" aria-hidden="true">
        <div style={{ width: dur ? (pos / dur) * 100 + "%" : 0 }} />
      </div>
    </div>
  );
}

