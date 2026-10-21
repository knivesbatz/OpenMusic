// HTPC / TV mode: controller navigation through the Gamepad API (Xbox, DualShock 4, Switch Pro all
// map to the "standard" layout in WebView2). Polls only while a pad is connected.
import * as P from "./player/engine";
import { back, useUi } from "./store/ui";

const FOCUSABLE = 'button:not(:disabled), [role="button"], [role="row"], [role="option"], input, select, a[href]';

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
}

/** Move focus to the nearest focusable element in a direction (spatial navigation). */
export function moveFocus(dir: "up" | "down" | "left" | "right") {
  const scope = (document.querySelector(".menu, .modal-bg, .fullscreen") as HTMLElement | null) ?? document.body;
  const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || !all.includes(cur)) return all[0]?.focus();
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    const primary = dir === "up" ? -dy : dir === "down" ? dy : dir === "left" ? -dx : dx;
    if (primary <= 1) continue;
    const secondary = dir === "up" || dir === "down" ? Math.abs(dx) : Math.abs(dy);
    const score = primary + secondary * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

let raf = 0;
const prev: boolean[] = [];
let repeatAt = 0;

function poll() {
  const pad = [...navigator.getGamepads()].find((p) => p && p.mapping === "standard") ?? [...navigator.getGamepads()].find(Boolean);
  if (!pad) {
    raf = 0;
    return;
  }
  const now = performance.now();
  const pressed = pad.buttons.map((b) => b.pressed);
  const edge = (i: number) => pressed[i] && !prev[i];
  const ax = pad.axes[0] ?? 0;
  const ay = pad.axes[1] ?? 0;
  const dir =
    pressed[12] || ay < -0.6 ? "up" : pressed[13] || ay > 0.6 ? "down" : pressed[14] || ax < -0.6 ? "left" : pressed[15] || ax > 0.6 ? "right" : null;
  if (dir && now >= repeatAt) {
    moveFocus(dir);
    repeatAt = now + (repeatAt === 0 ? 350 : 140);
  }
  if (!dir) repeatAt = 0;
  // A (Xbox A / DS4 Cross / Switch B in standard mapping) = activate, B = back/close.
  if (edge(0)) {
    const el = document.activeElement as HTMLElement | null;
    if (el && el.getAttribute("role") === "row") el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    else el?.click();
  }
  if (edge(1)) {
    const ui = useUi.getState();
    if (ui.menu) useUi.setState({ menu: null });
    else if (ui.fullscreen) useUi.setState({ fullscreen: false });
    else if (ui.queueOpen) useUi.setState({ queueOpen: false });
    else back();
  }
  if (edge(2)) useUi.setState({ queueOpen: !useUi.getState().queueOpen }); // X / Square
  if (edge(3)) useUi.setState({ fullscreen: !useUi.getState().fullscreen }); // Y / Triangle
  if (edge(9)) P.toggle(); // Start / Options / +
  if (edge(5)) P.next(); // RB / R1
  if (edge(4)) P.previous(); // LB / L1
  if (edge(7)) P.seek(P.usePlayer.getState().position + 10); // RT
  if (edge(6)) P.seek(P.usePlayer.getState().position - 10); // LT
  pressed.forEach((p, i) => (prev[i] = p));
  raf = requestAnimationFrame(poll);
}

export function initGamepad() {
  addEventListener("gamepadconnected", () => {
    if (!raf) raf = requestAnimationFrame(poll);
  });
}
