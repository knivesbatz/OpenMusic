// Virtualized track table used by albums, playlists, artist pages, search, local files and liked.
import { createContext, memo, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { trackMenu, type TrackMenuOpts } from "../actions";
import { useT } from "../i18n";
import { usePlayer } from "../player/engine";
import * as P from "../player/engine";
import { select } from "../player/queue";
import { useApp } from "../store/app";
import { openMenu } from "../store/ui";
import type { PlayContext, Track } from "../types";
import { cls, fmtMs } from "../util";
import { Art, ArtistName, JpText } from "./common";
import { IClock, IMore, IPlay } from "./Icons";

/** The main view's scroll container; lists virtualize against it. */
export const ScrollCtx = createContext<React.RefObject<HTMLElement>>({ current: null });

interface Props {
  tracks: Track[];
  context?: PlayContext | null;
  showAlbum?: boolean;
  showArt?: boolean;
  numbered?: boolean;
  /** App playlist editing: removal and drag reorder. */
  onRemove?: (indexes: number[]) => void;
  onReorder?: (order: number[]) => void;
  menuOpts?: TrackMenuOpts;
  limit?: number;
}

const ROW = 56;

export function TrackList({ tracks, context, showAlbum = true, showArt = true, numbered = true, onRemove, onReorder, limit }: Props) {
  const t = useT();
  const scrollRef = useContext(ScrollCtx);
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [sel, setSel] = useState<{ selected: Set<string>; anchor: string | null }>({ selected: new Set(), anchor: null });
  const [dragOver, setDragOver] = useState<number | null>(null);
  const list = limit ? tracks.slice(0, limit) : tracks;
  const keys = list.map((tr, i) => `${i}:${tr.id}`);

  useLayoutEffect(() => {
    const el = listRef.current;
    const sc = scrollRef.current;
    if (el && sc) setMargin(el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop);
  }, [scrollRef, list.length]);

  const v = useVirtualizer({
    count: list.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 10,
    scrollMargin: margin,
  });

  const play = useCallback((i: number) => P.playTracks(list, i, context ?? null), [list, context]);
  const selectedTracks = () => list.filter((_, i) => sel.selected.has(keys[i]));
  const selectedIdx = () => list.map((_, i) => i).filter((i) => sel.selected.has(keys[i]));

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Delete" && onRemove && sel.selected.size) {
      onRemove(selectedIdx());
      setSel({ selected: new Set(), anchor: null });
    } else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSel({ selected: new Set(keys), anchor: keys[0] ?? null });
    } else if (e.key === "Escape") setSel({ selected: new Set(), anchor: null });
  }

  function drop(before: number, e: React.DragEvent) {
    e.preventDefault();
    setDragOver(null);
    if (!onReorder) return;
    const moving = selectedIdx();
    if (!moving.length) return;
    const ms = new Set(moving);
    const rest = list.map((_, i) => i).filter((i) => !ms.has(i));
    const anchor = list.map((_, i) => i).slice(before).find((i) => !ms.has(i));
    const at = anchor === undefined ? rest.length : rest.indexOf(anchor);
    onReorder([...rest.slice(0, at), ...moving, ...rest.slice(at)]);
    setSel({ selected: new Set(), anchor: null });
  }

  return (
    <div className="tracklist" role="grid" aria-rowcount={list.length} onKeyDown={onKey}>
      <div className={cls("tl-row tl-head", !showAlbum && "no-album")} role="row">
        <span className="tl-num">#</span>
        <span>{t("title")}</span>
        {showAlbum && <span>{t("album")}</span>}
        <span className="tl-dur" aria-label={t("duration")}>
          <IClock size={16} />
        </span>
      </div>
      <div ref={listRef} style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((vi) => {
          const i = vi.index;
          const tr = list[i];
          return (
            <Row
              key={keys[i]}
              track={tr}
              index={i}
              top={vi.start - margin}
              selected={sel.selected.has(keys[i])}
              showAlbum={showAlbum}
              showArt={showArt}
              numbered={numbered}
              draggable={!!onReorder}
              dragOver={dragOver === i}
              onSelect={(e) => setSel((s) => select(keys, s.selected, s.anchor, keys[i], { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }))}
              onPlay={() => play(i)}
              onContext={(e) => {
                const inSel = sel.selected.has(keys[i]);
                if (!inSel) setSel({ selected: new Set([keys[i]]), anchor: keys[i] });
                const selection = inSel ? selectedTracks() : [tr];
                const idx = inSel ? selectedIdx() : [i];
                openMenu(e, trackMenu(tr, { selection, onRemoveFromPlaylist: onRemove ? () => onRemove(idx) : undefined }));
              }}
              onDragStart={(e) => {
                if (!sel.selected.has(keys[i])) setSel({ selected: new Set([keys[i]]), anchor: keys[i] });
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tr.title);
              }}
              onDragOver={(e) => {
                if (!onReorder) return;
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setDragOver(e.clientY > r.top + r.height / 2 ? i + 1 : i);
              }}
              onDrop={(e) => drop(dragOver ?? i, e)}
              dropAfter={dragOver === i + 1 && i === list.length - 1}
            />
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  track: Track;
  index: number;
  top: number;
  selected: boolean;
  showAlbum: boolean;
  showArt: boolean;
  numbered: boolean;
  draggable: boolean;
  dragOver: boolean;
  dropAfter: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onPlay: () => void;
  onContext: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

const Row = memo(function Row(p: RowProps) {
  const t = useT();
  const tr = p.track;
  const isCurrent = usePlayer((s) => s.queue.items[s.queue.index]?.track.id === tr.id);
  const offline = useApp((s) => s.online) === false && tr.source !== "local";
  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={p.selected}
      className={cls("tl-row", p.selected && "selected", isCurrent && "current", !p.showAlbum && "no-album", p.dragOver && "drop-before", p.dropAfter && "drop-after", offline && "dim")}
      style={{ transform: `translateY(${p.top}px)` }}
      onClick={p.onSelect}
      onDoubleClick={p.onPlay}
      onKeyDown={(e) => {
        if (e.key === "Enter") p.onPlay();
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          p.onContext({ clientX: r.left + 40, clientY: r.bottom, preventDefault: () => e.preventDefault(), stopPropagation: () => {} } as React.MouseEvent);
        }
      }}
      onContextMenu={p.onContext}
      draggable={p.draggable}
      onDragStart={p.onDragStart}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
    >
      <span className="tl-num">
        <span className="n">{p.numbered ? (tr.trackNumber && !p.showArt ? tr.trackNumber : p.index + 1) : ""}</span>
        <button className="icon-btn play-hover" aria-label={t("play")} onClick={(e) => (e.stopPropagation(), p.onPlay())}>
          <IPlay size={14} />
        </button>
      </span>
      <span className="tl-title">
        {p.showArt && <Art src={tr.artwork} size={80} className="sm" />}
        <span className="tl-text">
          <span className="name">
            <JpText text={tr.title} />
          </span>
          <span className="sub">
            {tr.explicit && <span className="badge">{t("explicit")}</span>}
            {tr.source === "local" && <span className="badge">{t("localFile")}</span>}
            <ArtistName name={tr.artist} />
          </span>
        </span>
      </span>
      {p.showAlbum && (
        <span className="tl-album">
          <JpText text={tr.album} />
        </span>
      )}
      <span className="tl-dur">
        {fmtMs(tr.durationMs)}
        <button className="icon-btn more" aria-label={t("more")} title={t("more")} onClick={(e) => (e.stopPropagation(), p.onContext(e))}>
          <IMore size={16} />
        </button>
      </span>
    </div>
  );
});
