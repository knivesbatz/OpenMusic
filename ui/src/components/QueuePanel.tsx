// Right-hand queue: Now playing, Next in queue (manual), Next from <context>.
// Multi-select (click, Ctrl-click, Shift-click range, Ctrl+A), Delete removes, drag to reorder.
import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { trackMenu } from "../actions";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
import { select, type QItem } from "../player/queue";
import { openMenu, useUi } from "../store/ui";
import { cls } from "../util";
import { Art } from "./common";
import * as I from "./Icons";

type Entry = { kind: "head"; label: string; clear?: boolean } | { kind: "item"; item: QItem; index: number; current: boolean };

export function QueuePanel() {
  const t = useT();
  const queue = usePlayer((s) => s.queue);
  const context = usePlayer((s) => s.context);
  const [sel, setSel] = useState<{ selected: Set<string>; anchor: string | null }>({ selected: new Set(), anchor: null });
  const [dropAt, setDropAt] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const entries: Entry[] = [];
  const cur = queue.items[queue.index];
  if (cur) {
    entries.push({ kind: "head", label: t("nowPlaying") });
    entries.push({ kind: "item", item: cur, index: queue.index, current: true });
  }
  const upcoming = queue.items.map((item, index) => ({ item, index })).slice(queue.index + 1);
  const manual = upcoming.filter((x) => x.item.manual);
  const rest = upcoming.filter((x) => !x.item.manual);
  if (manual.length) {
    entries.push({ kind: "head", label: t("nextInQueue"), clear: true });
    for (const x of manual) entries.push({ kind: "item", ...x, current: false });
  }
  if (rest.length) {
    entries.push({ kind: "head", label: context ? t("nextFrom", { name: context.title }) : t("nextUp"), clear: !manual.length });
    for (const x of rest) entries.push({ kind: "item", ...x, current: false });
  }
  const order = upcoming.map((x) => x.item.uid);

  const v = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (entries[i].kind === "head" ? 48 : 60),
    overscan: 8,
  });

  function removeSelected() {
    if (!sel.selected.size) return;
    P.removeFromQueue([...sel.selected]);
    setSel({ selected: new Set(), anchor: null });
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Delete" || e.key === "Backspace") removeSelected();
    else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSel({ selected: new Set(order), anchor: order[0] ?? null });
    } else if (e.key === "Escape") setSel({ selected: new Set(), anchor: null });
  }

  function drop(e: React.DragEvent) {
    e.preventDefault();
    if (dropAt !== null && sel.selected.size) P.moveInQueue(order.filter((u) => sel.selected.has(u)), dropAt);
    setDropAt(null);
  }

  return (
    <aside className="queue-panel" aria-label={t("queue")}>
      <div className="panel-head">
        <h2>{t("queue")}</h2>
        <div className="row gap">
          {sel.selected.size > 0 && (
            <button className="pill small" onClick={removeSelected}>
              {t("removeSelected", { n: sel.selected.size })}
            </button>
          )}
          <button className="icon-btn" aria-label={t("close")} title={t("close")} onClick={() => useUi.setState({ queueOpen: false })}>
            <I.IClose size={18} />
          </button>
        </div>
      </div>
      {!cur && <p className="muted pad">{t("queueEmpty")}</p>}
      <div className="queue-scroll" ref={scroller} onKeyDown={onKey} role="listbox" aria-multiselectable="true" aria-label={t("queue")}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((vi) => {
            const en = entries[vi.index];
            const style = { transform: `translateY(${vi.start}px)`, height: vi.size };
            if (en.kind === "head")
              return (
                <div key={"h" + vi.index} className="q-head" style={style}>
                  <span>{en.label}</span>
                  {en.clear && (
                    <button className="pill small" onClick={P.clearQueue}>
                      {t("clearQueue")}
                    </button>
                  )}
                </div>
              );
            const { item, index, current } = en;
            const tr = item.track;
            const selected = sel.selected.has(item.uid);
            return (
              <div
                key={item.uid}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                className={cls("q-row", current && "current", selected && "selected", dropAt === index && "drop-before", dropAt === index + 1 && index === queue.items.length - 1 && "drop-after")}
                style={style}
                draggable={!current}
                onClick={(e) => !current && setSel((s) => select(order, s.selected, s.anchor, item.uid, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }))}
                onDoubleClick={() => P.playUid(item.uid)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") P.playUid(item.uid);
                  if (e.key === " " && !current) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSel((s) => select(order, s.selected, s.anchor, item.uid, { shift: e.shiftKey, ctrl: true }));
                  }
                }}
                onContextMenu={(e) => {
                  const inSel = selected && sel.selected.size > 1;
                  const selection = inSel ? queue.items.filter((x) => sel.selected.has(x.uid)).map((x) => x.track) : [tr];
                  const items = trackMenu(tr, { selection, queueUid: current ? undefined : item.uid });
                  if (inSel) {
                    const ri = items.findIndex((m) => m.onClick && m.label === t("removeSelected", { n: sel.selected.size }));
                    if (ri >= 0) items[ri] = { ...items[ri], onClick: removeSelected };
                  }
                  openMenu(e, items);
                }}
                onDragStart={(e) => {
                  if (!selected) setSel({ selected: new Set([item.uid]), anchor: item.uid });
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", tr.title);
                }}
                onDragOver={(e) => {
                  if (current) return;
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setDropAt(e.clientY > r.top + r.height / 2 ? index + 1 : index);
                }}
                onDragEnd={() => setDropAt(null)}
                onDrop={drop}
              >
                <div className="q-art">
                  <Art src={tr.artwork} size={80} className="sm" />
                  {!current && (
                    <button className="icon-btn q-play" aria-label={t("play")} onClick={(e) => (e.stopPropagation(), P.playUid(item.uid))}>
                      <I.IPlay size={16} />
                    </button>
                  )}
                </div>
                <div className="q-text">
                  <span className="name">{tr.title}</span>
                  <span className="sub">
                    {tr.explicit && <span className="badge">{t("explicit")}</span>}
                    {tr.artist}
                  </span>
                </div>
                <button className="icon-btn more" aria-label={t("more")} title={t("more")} onClick={(e) => (e.stopPropagation(), openMenu(e, trackMenu(tr, { queueUid: current ? undefined : item.uid })))}>
                  <I.IMore size={16} />
                </button>
                {!current && (
                  <span className="grip" aria-hidden="true">
                    <I.IDrag size={16} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
