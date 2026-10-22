// Phone layout of the song screen and the queue (Spotify mobile style): the cover's colors
// washed behind everything, big artwork, the current lyric line, title with the like button,
// seek bar with elapsed/remaining time, transport, then share and queue; lyrics in a card
// below. The queue is a bottom sheet with drag handles and Shuffle / Repeat / Timer buttons.
import { useRef, useState } from "react";
import { artUrl } from "../api";
import { shareSubmenu, sleepSubmenu, trackMenu } from "../actions";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
import { useSettings } from "../store/settings";
import { useDisplayTrack } from "../store/songmeta";
import { openMenu, useUi } from "../store/ui";
import { displayText } from "../romaji";
import { cls, fmtTime } from "../util";
import { Art, ArtistName, TitleText } from "./common";
import { LyricsView, useLyrics } from "./Fullscreen";
import * as I from "./Icons";
import { SaveButton, Transport } from "./PlayerBar";

/** The cover blown up so only its colors show (no blur filter). */
const wash = (a?: string | null) => {
  const u = artUrl(a, 60);
  return u ? { backgroundImage: `url("${u}")` } : undefined;
};

function PhoneSeek() {
  const pos = usePlayer((s) => s.position);
  const dur = usePlayer((s) => s.duration);
  const [drag, setDrag] = useState<number | null>(null);
  const t = useT();
  const value = drag ?? pos;
  return (
    <div className="pp-seek">
      <input
        type="range"
        className="slider"
        min={0}
        max={dur || 1}
        step={0.5}
        value={value}
        aria-label={t("seek")}
        style={{ ["--pct" as string]: (dur ? (value / dur) * 100 : 0) + "%" }}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => drag !== null && (P.seek(drag), setDrag(null))}
        onTouchEnd={() => drag !== null && (P.seek(drag), setDrag(null))}
      />
      <div className="pp-times">
        <span>{fmtTime(value)}</span>
        <span>-{fmtTime(Math.max(0, dur - value))}</span>
      </div>
    </div>
  );
}

/** The synced lyric line at the current position, shown above the title. */
function CurrentLine({ track }: { track: Parameters<typeof useLyrics>[0] }) {
  const { lyrics } = useLyrics(track);
  const pos = usePlayer((s) => s.position);
  const jp = useSettings((s) => s.jpMode);
  if (!lyrics?.synced) return <div className="pp-line" />;
  const ms = pos * 1000 + 250;
  let text = "";
  for (const l of lyrics.lines) if ((l.timeMs ?? 0) <= ms) text = l.text;
  return <div className="pp-line">{text ? displayText(text, jp)[0] : ""}</div>;
}

export function PhonePlayer() {
  const t = useT();
  const item = usePlayer((s) => s.queue.items[s.queue.index]);
  const tr = useDisplayTrack(item?.track);
  const context = usePlayer((s) => s.context);
  const queueOpen = useUi((s) => s.queueOpen);
  const close = () => useUi.setState({ fullscreen: false, queueOpen: false });
  return (
    <div className="pp" role="dialog" aria-modal="true" aria-label={t("nowPlaying")}>
      <div className="pp-wash" style={wash(tr?.artwork)} aria-hidden="true" />
      <div className="pp-scroll">
        <div className="pp-top">
          <button className="icon-btn" aria-label={t("close")} onClick={close}>
            <I.IChevronDown size={28} />
          </button>
          <span className="pp-context">{context?.title ?? ""}</span>
          <button className="icon-btn" aria-label={t("more")} onClick={(e) => tr && openMenu(e, trackMenu(tr, { queueUid: item?.uid }))}>
            <I.IMore size={24} />
          </button>
        </div>
        {tr ? <Art src={tr.artwork} size={800} className="pp-art" alt={tr.album ?? tr.title} /> : <div className="pp-art art" />}
        {tr && <CurrentLine track={tr} />}
        <div className="pp-meta">
          <div className="pp-names">
            <div className="pp-title">
              <TitleText text={tr?.title} />
            </div>
            <div className="pp-artist">
              <ArtistName name={tr?.artist} />
            </div>
          </div>
          <SaveButton />
        </div>
        <PhoneSeek />
        <div className="pp-transport">
          <Transport big />
        </div>
        <div className="pp-actions">
          <span />
          <div className="row gap">
            <button className="icon-btn" aria-label={t("share")} onClick={(e) => tr && openMenu(e, shareSubmenu(tr))}>
              <I.IShare size={22} />
            </button>
            <button className={cls("icon-btn", queueOpen && "on")} aria-label={t("queue")} onClick={() => useUi.setState({ queueOpen: true })}>
              <I.IQueue size={22} />
            </button>
          </div>
        </div>
        {tr && (
          <section className="pp-lyrics" style={wash(tr.artwork)}>
            <h2>{t("lyrics")}</h2>
            <LyricsView track={tr} />
          </section>
        )}
      </div>
      {queueOpen && <PhoneQueue />}
    </div>
  );
}

const ROW_H = 64;

export function PhoneQueue() {
  const t = useT();
  const q = usePlayer((s) => s.queue);
  const context = usePlayer((s) => s.context);
  const playing = usePlayer((s) => s.playing);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const upcoming = q.items.slice(q.index + 1);
  const cur = q.items[q.index];
  const curTrack = useDisplayTrack(cur?.track);
  // Drag-to-reorder with the ≡ handle: rows move in steps of one row height.
  const [drag, setDrag] = useState<{ uid: string; from: number; dy: number } | null>(null);
  const startY = useRef(0);
  const close = () => useUi.setState({ queueOpen: false });

  const onDown = (e: React.PointerEvent, uid: string, from: number) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    startY.current = e.clientY;
    setDrag({ uid, from, dy: 0 });
  };
  const onMove = (e: React.PointerEvent) => drag && setDrag({ ...drag, dy: e.clientY - startY.current });
  const onUp = () => {
    if (!drag) return;
    const steps = Math.round(drag.dy / ROW_H);
    const to = Math.max(0, Math.min(upcoming.length - 1, drag.from + steps));
    if (to !== drag.from) {
      // Absolute queue index to insert before; moving down inserts after the target row.
      const target = q.index + 1 + to + (to > drag.from ? 1 : 0);
      P.moveInQueue([drag.uid], target);
    }
    setDrag(null);
  };

  return (
    <div className="pq-backdrop" onClick={close}>
      <div className="pq-sheet" role="dialog" aria-label={t("queue")} onClick={(e) => e.stopPropagation()}>
        <div className="pq-grab" aria-hidden="true" />
        <div className="pq-head">
          <div>
            <h2>{t("queue")}</h2>
            {context && (
              <div className="muted small">
                {t("playingFrom")} <strong>{context.title}</strong>
              </div>
            )}
          </div>
          <button className="pill ghost small" onClick={() => P.clearQueue()}>
            {t("clearQueue")}
          </button>
        </div>
        <div className="pq-list" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {curTrack && (
            <div className="pq-row current">
              <Art src={curTrack.artwork} size={120} className="sm" />
              <div className="pq-text">
                <div className="name">
                  <TitleText text={curTrack.title} />
                </div>
                <div className="sub">
                  <ArtistName name={curTrack.artist} />
                </div>
              </div>
              <button className="pq-play" aria-label={playing ? t("pause") : t("play")} onClick={P.toggle}>
                {playing ? <I.IPause size={20} /> : <I.IPlay size={20} />}
              </button>
            </div>
          )}
          {upcoming.map((it, i) => (
            <QueueRow
              key={it.uid}
              track={it.track}
              dragging={drag?.uid === it.uid}
              dy={drag?.uid === it.uid ? drag.dy : 0}
              onPlay={() => P.playUid(it.uid)}
              onMenu={(e) => openMenu(e, trackMenu(it.track, { queueUid: it.uid }))}
              onHandleDown={(e) => onDown(e, it.uid, i)}
            />
          ))}
        </div>
        <div className="pq-buttons">
          <button className={cls(shuffle && "on")} aria-pressed={shuffle} onClick={() => P.setShuffle(!shuffle)}>
            <I.IShuffle size={24} />
            <span>{t("shuffle")}</span>
          </button>
          <button className={cls(repeat !== "off" && "on")} onClick={P.cycleRepeat}>
            <I.IRepeat size={24} />
            <span>{repeat === "one" ? t("repeatOne") : t("repeat")}</span>
          </button>
          <button onClick={(e) => openMenu(e, sleepSubmenu())}>
            <I.IClock size={24} />
            <span>{t("sleepTimer")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function QueueRow(p: {
  track: Parameters<typeof useDisplayTrack>[0];
  dragging: boolean;
  dy: number;
  onPlay: () => void;
  onMenu: (e: React.MouseEvent) => void;
  onHandleDown: (e: React.PointerEvent) => void;
}) {
  const t = useT();
  const tr = useDisplayTrack(p.track);
  if (!tr) return null;
  return (
    <div className={cls("pq-row", p.dragging && "dragging")} style={p.dragging ? { transform: `translateY(${p.dy}px)` } : undefined} onClick={p.onPlay} onContextMenu={p.onMenu}>
      <Art src={tr.artwork} size={120} className="sm" />
      <div className="pq-text">
        <div className="name">
          <TitleText text={tr.title} />
        </div>
        <div className="sub">
          <ArtistName name={tr.artist} />
        </div>
      </div>
      <button className="icon-btn pq-handle" aria-label={t("reorder")} onPointerDown={p.onHandleDown} onClick={(e) => e.stopPropagation()}>
        <I.IHandle size={22} />
      </button>
    </div>
  );
}
