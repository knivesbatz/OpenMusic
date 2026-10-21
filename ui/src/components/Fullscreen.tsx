// Custom fullscreen player: large artwork with synced lyrics to its right when there is room.
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, inTauri } from "../api";
import { useT } from "../i18n";
import { usePlayer } from "../player/engine";
import * as P from "../player/engine";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import type { Lyrics, Track } from "../types";
import { cls } from "../util";
import { displayText } from "../romaji";
import { Art } from "./common";
import * as I from "./Icons";
import { SaveButton, Seek, Transport, Volume } from "./PlayerBar";
import { QueuePanel } from "./QueuePanel";

const lyricsCache = new Map<string, Lyrics | null>();

export function useLyrics(track?: Track) {
  const [state, setState] = useState<{ id: string; lyrics: Lyrics | null; loading: boolean }>({ id: "", lyrics: null, loading: false });
  useEffect(() => {
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
  }, [track]);
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
    const el = box.current?.querySelector(".active") as HTMLElement | null;
    el?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
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
  const context = usePlayer((s) => s.context);
  const lyricsOpen = useUi((s) => s.lyricsOpen);
  const queueOpen = useUi((s) => s.queueOpen);
  const tr = item?.track;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    if (inTauri) getCurrentWindow().setFullscreen(true).catch(() => {});
    return () => {
      if (inTauri) getCurrentWindow().setFullscreen(false).catch(() => {});
      prev?.focus();
    };
  }, []);

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
            <div className="fs-title">{tr?.title ?? ""}</div>
            <div className="fs-artist">{[tr?.artist, tr?.album].filter(Boolean).join(" • ")}</div>
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

import { artUrl } from "../api";
const artBg = (a?: string | null) => artUrl(a, 120) ?? "";
