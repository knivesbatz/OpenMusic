// Drag handle on a side panel's inner edge (Spotify-style). The width follows the pointer live
// through a CSS variable and is saved when the drag ends; double-click resets it.
import { useRef } from "react";
import { useT } from "../i18n";
import { clampWidth, useSettings } from "../store/settings";

export function Resizer({ setting, range, def, edge, onCollapse }: {
  setting: "sidebarWidth" | "panelWidth";
  range: { min: number; max: number };
  def: number;
  /** Which edge of its panel the handle sits on. */
  edge: "left" | "right";
  /** Dragged well past the minimum. */
  onCollapse?: () => void;
}) {
  const t = useT();
  const drag = useRef<{ x: number; w: number; last: number } | null>(null);
  const cssVar = setting === "sidebarWidth" ? "--side-w" : "--panel-w";
  const root = () => document.querySelector<HTMLElement>(".layout");

  function down(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const w = useSettings.getState()[setting];
    drag.current = { x: e.clientX, w, last: w };
    document.body.classList.add("resizing");
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = edge === "right" ? e.clientX - d.x : d.x - e.clientX;
    d.last = d.w + dx;
    root()?.style.setProperty(cssVar, `${clampWidth(d.last, range, def)}px`);
  }
  function up() {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove("resizing");
    root()?.style.removeProperty(cssVar);
    if (onCollapse && d.last < range.min - 80) return onCollapse();
    useSettings.getState().set({ [setting]: clampWidth(d.last, range, def) });
  }
  function key(e: React.KeyboardEvent) {
    const step = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    const w = useSettings.getState()[setting];
    useSettings.getState().set({ [setting]: clampWidth(w + (edge === "right" ? step : -step), range, def) });
  }
  return (
    <div
      className={`resizer ${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("resizePanel")}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => useSettings.getState().set({ [setting]: def })}
      onKeyDown={key}
    />
  );
}
