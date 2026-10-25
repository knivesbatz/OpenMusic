import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { sleepSubmenu, trackMenu, useSleep } from "../actions";
import { api, artUrl, inTauri } from "../api";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
import { isMobileApp, useApp } from "../store/app";
import { useDisplayTrack } from "../store/songmeta";
import { useSettings } from "../store/settings";
import { navigate, openMenu, useUi } from "../store/ui";
import { cls, fmtTime, isTouch } from "../util";
import { Art, ArtistName, TitleText } from "./common";
import { likeOrOpen, openSavedIn } from "./SavedIn";
import * as I from "./Icons";

export function Seek({ compact }: { compact?: boolean }) {
  const pos = usePlayer((s) => s.position);
  const dur = usePlayer((s) => s.duration);
  const [drag, setDrag] = useState<number | null>(null);
  const t = useT();
  const value = drag ?? pos;
  const pct = dur ? (value / dur) * 100 : 0;
  // Hover/drag bubble above the bar showing the time under the pointer.
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const track = (e: React.PointerEvent<HTMLInputElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover({ x: f * 100, t: f * dur });
  };
  return (
    <div className={cls("seek", compact && "compact")}>
      {!compact && <span className="time">{fmtTime(value)}</span>}
      <div className="seek-track">
        {!compact && dur > 0 && (hover || drag !== null) && (
          <span className="seek-tip" style={{ left: `${drag !== null ? pct : hover!.x}%` }} aria-hidden="true">
            {fmtTime(drag ?? hover!.t)}
          </span>
        )}
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
        onPointerMove={track}
        onPointerLeave={() => setHover(null)}
        onPointerUp={() => drag !== null && (P.seek(drag), setDrag(null))}
        onKeyUp={() => drag !== null && (P.seek(drag), setDrag(null))}
      />
      </div>
      {/* Remaining time, like Spotify: "-2:56". */}
      {!compact && <span className="time">{dur ? "-" + fmtTime(Math.max(0, dur - value)) : fmtTime(0)}</span>}
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
        <span className="swap" key={String(playing)}>
          {playing ? <I.IPause size={big ? 26 : 18} /> : <I.IPlay size={big ? 26 : 18} />}
        </span>
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
        <button className={cls("icon-btn", liked && "on")} aria-pressed={liked} aria-label={liked ? t("savedIn") : t("like")} title={liked ? t("savedIn") : t("like")} onClick={(e) => likeOrOpen(e, track)}>
          {liked ? <I.IHeartFill size={18} /> : <I.IHeart size={18} />}
        </button>
        <button className="icon-btn" aria-label={t("addToPlaylist")} title={t("addToPlaylist")} onClick={(e) => openSavedIn(e, track)}>
          <I.IPlus size={18} />
        </button>
      </span>
    );
  return (
    <button className="icon-btn" aria-label={t("addToPlaylist")} title={t("addToPlaylist")} onClick={(e) => openSavedIn(e, track)}>
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
  const lyricsPanel = useUi((s) => s.lyricsPanel);
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
      // Phone mini player: tinted with the cover's colour (a tiny cover stretched into a wash).
      style={tr?.artwork ? ({ ["--pb-wash" as string]: `url("${artUrl(tr.artwork, 60)}")` } as React.CSSProperties) : undefined}
      // Phone: the whole mini player opens the song screen, except its own buttons.
      onClick={(e) => tr && isTouch() && !(e.target as HTMLElement).closest("button:not(.pb-art):not(.link), input") && useUi.setState({ fullscreen: true })}
    >
      <div className="pb-left">
        {tr && (
          <>
            <button className="pb-art" key={"a" + tr.id} onClick={() => useUi.setState({ fullscreen: true })} aria-label={t("fullscreen")}>
              <Art src={tr.artwork} size={120} />
            </button>
            <div className="pb-meta" key={"m" + tr.id} onContextMenu={(e) => openMenu(e, trackMenu(tr, { queueUid: undefined }))}>
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
        <button
          className={cls("icon-btn", lyricsPanel && !queueOpen && "on")}
          aria-pressed={lyricsPanel && !queueOpen}
          aria-label={t("lyrics")}
          title={t("lyrics")}
          // Lyrics open in the side panel first; its expand button goes fullscreen.
          onClick={() => useUi.setState(lyricsPanel && !queueOpen ? { lyricsPanel: false } : { lyricsPanel: true, queueOpen: false })}
        >
          <I.IMic size={18} />
        </button>
        <button className={cls("icon-btn", queueOpen && "on")} aria-pressed={queueOpen} aria-label={t("queue")} title={t("queue")} onClick={() => useUi.setState({ queueOpen: !queueOpen, lyricsPanel: false })}>
          <I.IQueue size={18} />
        </button>
        <SleepButton />
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

/** Sleep timer: green while set, with the time left in its tooltip. */
function SleepButton() {
  const t = useT();
  const until = useSleep((s) => s.until);
  // Re-render once a minute so the tooltip's countdown stays current.
  const [, tick] = useState(0);
  useEffect(() => {
    if (typeof until !== "number") return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [until]);
  const left = typeof until === "number" ? Math.max(1, Math.ceil((until - Date.now()) / 60_000)) : null;
  const label = until === "track" ? t("sleepEndOfTrack") : left != null ? t("sleepLeft", { n: left }) : t("sleepTimer");
  return (
    <button className={cls("icon-btn", until != null && "on")} aria-pressed={until != null} aria-label={label} title={label} onClick={(e) => openMenu(e, sleepSubmenu())}>
      <I.IMoon size={18} />
    </button>
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
        <span className="swap" key={String(playing)}>
          {playing ? <I.IPause size={24} /> : <I.IPlay size={24} />}
        </span>
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

