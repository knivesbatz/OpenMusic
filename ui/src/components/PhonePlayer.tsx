// Phone layout of the song screen and the queue (Spotify mobile style): the cover's colors
// washed behind everything, big artwork, the current lyric line, title with the like button,
// seek bar with elapsed/remaining time, transport, then share and queue; lyrics in a card
// below. The queue is a bottom sheet with drag handles and Shuffle / Repeat / Timer buttons.
import { useRef, useState } from "react";
import { api, artUrl } from "../api";
import { shareSubmenu, sleepSubmenu, toggleSaved, trackHead, trackMenu } from "../actions";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
import { useDisplayTrack } from "../store/songmeta";
import { navigate, openMenu, useUi } from "../store/ui";
import { useApp } from "../store/app";
import { cls, fmtTime } from "../util";
import { Art, ArtistName, TitleText, useAsync } from "./common";
import { LyricsView } from "./Fullscreen";
import * as I from "./Icons";
import { PhoneSaveButton, Transport } from "./PlayerBar";

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

/** Spotify's song screen moves with the finger: pull it down to close it (from the top of the
 * screen), swipe the cover sideways to change song. Transforms are set directly, without
 * re-rendering. */
function usePullToClose(close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const g = useRef<{ x0: number; y0: number; t0: number; dy: number; mode: "?" | "down" | "no" } | null>(null);
  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const slideOut = () => {
    const el = ref.current;
    if (!el || reduce()) return close();
    el.style.transition = "transform 220ms cubic-bezier(0.2, 0, 0, 1)";
    el.style.transform = "translateY(100%)";
    setTimeout(close, 200);
  };
  const handlers = {
    onTouchStart: (e: React.TouchEvent) => {
      const el = ref.current;
      const scrolled = (el?.querySelector(".pp-scroll")?.scrollTop ?? 0) > 0;
      if (!el || scrolled || (e.target as HTMLElement).closest("input, .pp-art-swipe, .pq-sheet, .pp-lyrics")) return;
      g.current = { x0: e.touches[0].clientX, y0: e.touches[0].clientY, t0: performance.now(), dy: 0, mode: "?" };
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = g.current;
      const el = ref.current;
      if (!s || !el || s.mode === "no") return;
      const dx = e.touches[0].clientX - s.x0;
      const dy = e.touches[0].clientY - s.y0;
      if (s.mode === "?") {
        if (dy > 8 && dy > Math.abs(dx)) s.mode = "down";
        else if (Math.abs(dx) > 8 || dy < -8) return void (s.mode = "no");
        else return;
      }
      s.dy = Math.max(0, dy);
      el.style.transition = "none";
      el.style.transform = `translateY(${s.dy}px)`;
    },
    onTouchEnd: () => {
      const s = g.current;
      const el = ref.current;
      g.current = null;
      if (!s || !el || s.mode !== "down") return;
      const fast = s.dy / Math.max(1, performance.now() - s.t0) > 0.6;
      if (s.dy > 140 || (fast && s.dy > 40)) return slideOut();
      el.style.transition = "transform 200ms cubic-bezier(0.2, 0, 0, 1)";
      el.style.transform = "";
    },
  };
  return { ref, handlers, slideOut };
}

function useArtSwipe() {
  const ref = useRef<HTMLDivElement>(null);
  const g = useRef<{ x0: number; y0: number; dx: number; mode: "?" | "side" | "no" } | null>(null);
  const set = (x: number, fade: boolean, animate: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = animate ? "transform 200ms cubic-bezier(0.2, 0, 0, 1), opacity 200ms" : "none";
    el.style.transform = x ? `translateX(${x}px)` : "";
    el.style.opacity = fade ? "0" : "";
  };
  return {
    ref,
    onTouchStart: (e: React.TouchEvent) => (g.current = { x0: e.touches[0].clientX, y0: e.touches[0].clientY, dx: 0, mode: "?" }),
    onTouchMove: (e: React.TouchEvent) => {
      const s = g.current;
      if (!s || s.mode === "no") return;
      const dx = e.touches[0].clientX - s.x0;
      const dy = e.touches[0].clientY - s.y0;
      if (s.mode === "?") {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) s.mode = "side";
        else if (Math.abs(dy) > 10) return void (s.mode = "no");
        else return;
      }
      s.dx = dx;
      set(dx, false, false);
    },
    onTouchEnd: () => {
      const s = g.current;
      g.current = null;
      if (!s || s.mode !== "side") return;
      const w = ref.current?.offsetWidth ?? 300;
      if (Math.abs(s.dx) < w / 4) return set(0, false, true);
      const dir = s.dx < 0 ? -1 : 1;
      set(dir * w, true, true);
      setTimeout(() => {
        if (dir < 0) P.next();
        else P.previous();
        // The new cover comes in from the other side.
        set(-dir * 40, true, false);
        requestAnimationFrame(() => requestAnimationFrame(() => set(0, false, true)));
      }, 180);
    },
  };
}

export function PhonePlayer() {
  const t = useT();
  const item = usePlayer((s) => s.queue.items[s.queue.index]);
  const tr = useDisplayTrack(item?.track);
  const context = usePlayer((s) => s.context);
  const playing = usePlayer((s) => s.playing);
  const queueOpen = useUi((s) => s.queueOpen);
  const pull = usePullToClose(() => useUi.setState({ fullscreen: false, queueOpen: false }));
  const swipe = useArtSwipe();
  const close = pull.slideOut;
  return (
    <div className="pp" role="dialog" aria-modal="true" aria-label={t("nowPlaying")} ref={pull.ref} {...pull.handlers}>
      <div className="pp-wash" style={wash(tr?.artwork)} aria-hidden="true" />
      <div className="pp-scroll">
        <div className="pp-top">
          <button className="icon-btn" aria-label={t("close")} onClick={close}>
            <I.IChevronDown size={28} />
          </button>
          <span className="pp-context">
            <span className="pp-ctx-title">{context?.title ?? ""}</span>
          </span>
          <button className="icon-btn" aria-label={t("more")} onClick={(e) => tr && openMenu(e, trackMenu(tr, { queueUid: item?.uid }), trackHead(tr))}>
            <I.IMore size={24} />
          </button>
        </div>
        <div className="pp-art-swipe" ref={swipe.ref} onTouchStart={swipe.onTouchStart} onTouchMove={swipe.onTouchMove} onTouchEnd={swipe.onTouchEnd}>
          {tr ? <Art src={tr.artwork} size={800} className={cls("pp-art", !playing && "paused")} alt={tr.album ?? tr.title} /> : <div className="pp-art art" />}
        </div>
        <div className="pp-gap" />
        <div className="pp-meta">
          <div className="pp-names">
            <div className="pp-title">
              <TitleText text={tr?.title} />
            </div>
            <div className="pp-artist">
              <ArtistName name={tr?.artist} />
            </div>
          </div>
          <PhoneSaveButton size={28} />
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
        {tr?.artistId && <AboutArtist id={tr.artistId} />}
      </div>
      {queueOpen && <PhoneQueue />}
    </div>
  );
}

/** "About the artist" under the lyrics (Spotify): photo, name, followers, the start of the bio
 * and Follow. Tapping it opens the artist page. */
function AboutArtist({ id }: { id: string }) {
  const t = useT();
  const { data } = useAsync(() => (id.startsWith("local-artist:") ? Promise.resolve(null) : api.artist(id)), [id]);
  const followed = useApp((s) => s.saved.artists.some((a) => a.id === id));
  const a = data?.artist;
  if (!a) return null;
  const open = () => {
    useUi.setState({ fullscreen: false, queueOpen: false });
    navigate({ name: "artist", id });
  };
  return (
    <section className="pp-about" role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
      <div className="pp-about-img" style={a.artwork ? { backgroundImage: `url("${artUrl(a.artwork, 600)}")` } : undefined}>
        <h2>{t("aboutTheArtist")}</h2>
      </div>
      <div className="pp-about-body">
        <div className="row between">
          <div>
            <div className="pp-about-name">{a.name}</div>
            {data?.followers && <div className="muted small">{t("followersCount", { n: data.followers })}</div>}
          </div>
          <button
            className={cls("pill ghost small", followed && "on")}
            onClick={(e) => {
              e.stopPropagation();
              toggleSaved({ kind: "artist", v: a });
            }}
          >
            {followed ? t("following") : t("follow")}
          </button>
        </div>
        {data?.description && <p className="pp-about-bio">{data.description}</p>}
      </div>
    </section>
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
              onMenu={(e) => openMenu(e, trackMenu(it.track, { queueUid: it.uid }), trackHead(it.track))}
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
