// HTPC / TV mode: controller navigation through the Gamepad API (Xbox, DualShock 4, Switch Pro all
// map to the "standard" layout in WebView2). Polls only while a pad is connected.
import * as P from "./player/engine";
import { back, useUi } from "./store/ui";
import { useSettings } from "./store/settings";
import { isMobileApp } from "./store/app";

const FOCUSABLE = 'button:not(:disabled), [role="button"], [role="row"], [role="option"], input, select, a[href]';

/** Tiles move focus as a whole: never land on the buttons inside a card, row or shortcut. */
const TILE = ".card, .shortcut, .tl-row, .pq-row";

function usable(el: HTMLElement) {
  if (el.closest(TILE) && !el.matches(TILE)) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.pointerEvents !== "none" && Number(cs.opacity) > 0.05;
}

/**
 * Move focus to the nearest element in a direction (spatial navigation, as on Android TV).
 * Off-screen elements count too, so focus walks along rows and down the page, which scroll to
 * follow. Elements lined up with the current one (same row/column) win over diagonal ones.
 */
export function moveFocus(dir: "up" | "down" | "left" | "right") {
  const scope = (document.querySelector(".menu, .modal-bg, .pq-sheet, .fullscreen, .pp") as HTMLElement | null) ?? document.body;
  const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(usable);
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || cur === document.body || !all.includes(cur)) {
    const first = scope.querySelector<HTMLElement>(".tv-tab.on") ?? all.find((el) => el.getBoundingClientRect().top >= 0) ?? all[0];
    first?.focus();
    return;
  }
  const a = cur.getBoundingClientRect();
  const vertical = dir === "up" || dir === "down";
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === cur || el.contains(cur) || cur.contains(el)) continue;
    const b = el.getBoundingClientRect();
    const gap = dir === "down" ? b.top - a.bottom : dir === "up" ? a.top - b.bottom : dir === "right" ? b.left - a.right : a.left - b.right;
    // Must lie beyond the current element's edge (small overlaps allowed for tight grids).
    const centre = dir === "down" ? b.top + b.height / 2 > a.top + a.height / 2 : dir === "up" ? b.top + b.height / 2 < a.top + a.height / 2 : dir === "right" ? b.left + b.width / 2 > a.left + a.width / 2 : b.left + b.width / 2 < a.left + a.width / 2;
    if (gap < -8 || !centre) continue;
    const overlap = vertical ? Math.min(a.right, b.right) - Math.max(a.left, b.left) : Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const ortho = vertical ? Math.abs(b.left + b.width / 2 - (a.left + a.width / 2)) : Math.abs(b.top + b.height / 2 - (a.top + a.height / 2));
    const score = Math.max(gap, 0) + (overlap > 0 ? ortho * 0.2 : 400 + ortho * 2);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) {
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }
}

function activate() {
  const el = document.activeElement as HTMLElement | null;
  if (el && el.getAttribute("role") === "row") el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  else el?.click();
}

function goBack() {
  const ui = useUi.getState();
  if (ui.menu) useUi.setState({ menu: null });
  else if (ui.queueOpen) useUi.setState({ queueOpen: false });
  else if (ui.fullscreen) useUi.setState({ fullscreen: false });
  else back();
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
  if (edge(0)) activate();
  if (edge(1)) goBack();
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
  // TV remotes and keyboards in TV mode: arrows move focus, Enter/OK selects, Back/Esc goes back.
  addEventListener(
    "keydown",
    (e) => {
      if (!useSettings.getState().htpc || isMobileApp()) return;
      const typing = (e.target as HTMLElement).matches?.("input:not([type=range]), textarea");
      const keys: Record<string, "up" | "down" | "left" | "right" | undefined> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
      const dir = keys[e.key];
      if (dir && !(typing && (dir === "left" || dir === "right"))) {
        e.preventDefault();
        moveFocus(dir);
      } else if (e.key === "Enter" && !typing && (document.activeElement as HTMLElement | null)?.getAttribute("role")) {
        e.preventDefault();
        activate();
      } else if (e.key === "BrowserBack" || e.key === "GoBack" || (e.key === "Backspace" && !typing)) {
        e.preventDefault();
        goBack();
      } else if (e.key === "MediaPlayPause") P.toggle();
      else if (e.key === "MediaTrackNext") P.next();
      else if (e.key === "MediaTrackPrevious") P.previous();
    },
    true,
  );
}
