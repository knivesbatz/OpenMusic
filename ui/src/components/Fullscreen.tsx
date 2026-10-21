// Custom fullscreen player: large artwork with synced lyrics to its right when there is room.
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, artUrl, inTauri } from "../api";
import { useT } from "../i18n";
import { usePlayer } from "../player/engine";
import * as P from "../player/engine";
import { useSettings } from "../store/settings";
import { useDisplayTrack } from "../store/songmeta";
import { isMobileApp } from "../store/app";
import { useUi } from "../store/ui";
import type { Lyrics, Track } from "../types";
import { cls } from "../util";
import { displayText } from "../romaji";
import { Art, ArtistName, JpText } from "./common";
import * as I from "./Icons";
import { SaveButton, Seek, Transport, Volume } from "./PlayerBar";
import { QueuePanel } from "./QueuePanel";

const lyricsCache = new Map<string, Lyrics | null>();

export function useLyrics(track?: Track) {
  const [state, setState] = useState<{ id: string; lyrics: Lyrics | null; loading: boolean }>({ id: "", lyrics: null, loading: false });
  // Keyed on the track id, not the object: the displayed track (song art/title for YouTube
  // videos) is a new object on every render, and an effect keyed on it looped forever.
  const latest = useRef(track);
  latest.current = track;
  const id = track?.id;
  useEffect(() => {
    const track = latest.current;
    if (!track || !inTauri) return;
    if (lyricsCache.has(track.id)) return setState({ id: track.id, lyrics: lyricsCache.get(track.id)!, loading: false });
    let live = true;
    setState({ id: track.id, lyrics: null, loading: true });
    api
      .lyrics(track)
      .then((l) => {
        lyricsCache.set(track.id, l);
        if (lyricsCache.size > 100) lyricsCache.delete(lyricsCache.keys().next().value!);
        if (live) setState({ id: track.id, lyrics: l, loading: false });
      })
      .catch(() => live && setState({ id: track.id, lyrics: null, loading: false }));
    return () => {
      live = false;
    };
  }, [id]);
  return state;
}

export function LyricsView({ track }: { track: Track }) {
  const t = useT();
  const { lyrics, loading } = useLyrics(track);
  const pos = usePlayer((s) => s.position);
  const jp = useSettings((s) => s.jpMode);
  const reduced = useSettings((s) => s.reducedMotion);
  const box = useRef<HTMLDivElement>(null);
  let active = -1;
  if (lyrics?.synced) {
    const ms = pos * 1000 + 250;
    for (let i = 0; i < lyrics.lines.length; i++) if ((lyrics.lines[i].timeMs ?? 0) <= ms) active = i;
  }
  useEffect(() => {
    // Scroll only the lyrics' own container: scrollIntoView would also scroll the page around
    // it (the phone song screen jumped down to the lyrics card).
    const sc = box.current;
    const el = sc?.querySelector(".active") as HTMLElement | null;
    if (!sc || !el) return;
    const container = sc.scrollHeight > sc.clientHeight + 1 ? sc : sc.parentElement;
    if (!container) return;
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    container.scrollTo({ top: container.scrollTop + r.top - c.top - container.clientHeight / 2 + r.height / 2, behavior: reduced ? "auto" : "smooth" });
  }, [active, reduced]);
  if (loading) return <div className="lyrics muted">{t("loading")}</div>;
  if (!lyrics || !lyrics.lines.length) return <div className="lyrics muted">{t("noLyrics")}</div>;
  return (
    <div className="lyrics" ref={box} aria-live="off">
      {!lyrics.synced && <p className="muted small">{t("lyricsUnsynced")}</p>}
      {lyrics.lines.map((l, i) => {
        const [main, alt] = displayText(l.text, jp);
        return (
          <p
            key={i}
            className={cls("line", lyrics.synced && i === active && "active", lyrics.synced && i < active && "past")}
            onClick={() => lyrics.synced && l.timeMs != null && P.seek(l.timeMs / 1000)}
          >
            {main || "♪"}
            {alt && <span className="alt">{alt}</span>}
          </p>
        );
      })}
      <p className="muted small">{t("lyricsSource", { source: lyrics.source })}</p>
    </div>
  );
}

export function Fullscreen() {
  const t = useT();
  const item = usePlayer((s) => s.queue.items[s.queue.index]);
  const shown = useDisplayTrack(item?.track);
  const context = usePlayer((s) => s.context);
  const lyricsOpen = useUi((s) => s.lyricsOpen);
  const queueOpen = useUi((s) => s.queueOpen);
  const tr = shown;
  const ref = useRef<HTMLDivElement>(null);

  const [osFull, setOsFull] = useState(false);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus();
  }, []);

  // The player fills the app window; switching the OS window to fullscreen is a separate,
  // explicit action, and it is always undone when the player closes.
  async function toggleOsFullscreen() {
    if (!inTauri) return;
    try {
      const w = getCurrentWindow();
      const next = !(await w.isFullscreen());
      await w.setFullscreen(next);
      setOsFull(next);
    } catch (e) {
      console.error("fullscreen", e);
    }
  }
  useEffect(() => {
    if (!osFull || !inTauri) return;
    return () => void getCurrentWindow().setFullscreen(false).catch(() => {});
  }, [osFull]);

  const exit = () => useUi.setState({ fullscreen: false });
  return (
    <div className="fullscreen" role="dialog" aria-modal="true" aria-label={t("fullscreen")} tabIndex={-1} ref={ref} onKeyDown={(e) => e.key === "Escape" && exit()}>
      {tr && <div className="fs-bg" style={{ backgroundImage: `url(${JSON.stringify(artBg(tr.artwork))})` }} aria-hidden="true" />}
      <div className="fs-top">
        <span className="fs-context">{context?.title ?? ""}</span>
        <div className="row gap">
          <button className={cls("icon-btn", lyricsOpen && "on")} aria-pressed={lyricsOpen} aria-label={t("lyrics")} title={t("lyrics")} onClick={() => useUi.setState({ lyricsOpen: !lyricsOpen })}>
            <I.IMic size={20} />
          </button>
          <button className={cls("icon-btn", queueOpen && "on")} aria-pressed={queueOpen} aria-label={t("queue")} title={t("queue")} onClick={() => useUi.setState({ queueOpen: !queueOpen })}>
            <I.IQueue size={20} />
          </button>
          {inTauri && !isMobileApp() && (
            <button className={cls("icon-btn", osFull && "on")} aria-pressed={osFull} aria-label={t("fullscreenWindow")} title={t("fullscreenWindow")} onClick={toggleOsFullscreen}>
              <I.IFullscreen size={20} />
            </button>
          )}
          <button className="icon-btn" aria-label={t("exitFullscreen")} title={t("exitFullscreen")} onClick={exit}>
            <I.IExitFullscreen size={20} />
          </button>
        </div>
      </div>
      <div className={cls("fs-main", lyricsOpen && "with-lyrics")}>
        <div className="fs-left">
          {tr ? <Art src={tr.artwork} size={1000} className="fs-art" alt={tr.album ?? tr.title} /> : <div className="fs-art art" />}
        </div>
        {lyricsOpen && tr && (
          <div className="fs-right">
            <LyricsView track={tr} />
          </div>
        )}
        {queueOpen && <QueuePanel />}
      </div>
      <div className="fs-bottom">
        <div className="fs-meta">
          <div>
            <div className="fs-title">
              <JpText text={tr?.title} />
            </div>
            <div className="fs-artist">
              <ArtistName name={tr?.artist} />
              {tr?.album && (
                <>
                  {" • "}
                  <JpText text={tr.album} />
                </>
              )}
            </div>
          </div>
          <SaveButton />
        </div>
        <Seek />
        <div className="fs-controls">
          <div />
          <Transport big />
          <Volume />
        </div>
      </div>
    </div>
  );
}

const artBg = (a?: string | null) => artUrl(a, 32) ?? "";
