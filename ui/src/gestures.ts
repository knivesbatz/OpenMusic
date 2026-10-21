// Phone gestures and the Android Back button.
// - Swipe down on the full-screen player, the queue or a menu closes it.
// - Swipe right from the left edge goes back (closing the topmost panel first).
// - Android Back: the app navigates without browser history, so a history entry is kept on top
//   and every Back press closes the topmost thing instead of leaving the app. With nothing left
//   to close, a second Back leaves the app.
import { translate } from "./i18n";
import { useSettings } from "./store/settings";
import { toast, useUi } from "./store/ui";

/** Close the topmost panel or go back one page. False when there is nothing to do. */
export function goBackOrClose(): boolean {
  const s = useUi.getState();
  if (s.menu) return useUi.setState({ menu: null }), true;
  if (s.dialog) {
    s.dialog.resolve(false);
    return useUi.setState({ dialog: null }), true;
  }
  if (s.info) return useUi.setState({ info: null }), true;
  if (s.queueOpen) return useUi.setState({ queueOpen: false }), true;
  if (s.lyricsOpen) return useUi.setState({ lyricsOpen: false }), true;
  if (s.fullscreen) return useUi.setState({ fullscreen: false }), true;
  if (s.pos > 0) return useUi.setState({ pos: s.pos - 1 }), true;
  return false;
}

/** Scrolled to the top (or not scrollable): a downward swipe means "close", not "scroll". */
function atTop(el: Element | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1 && getComputedStyle(n).overflowY !== "visible" && n.scrollTop > 0) return false;
  }
  return true;
}

export function initGestures() {
  const android = /Android/i.test(navigator.userAgent);
  if (android) {
    history.pushState({ openmusic: true }, "");
    addEventListener("popstate", () => {
      if (goBackOrClose()) history.pushState({ openmusic: true }, "");
      else toast(translate(useSettings.getState().language, "backAgainToExit"));
    });
  }

  let start: { x: number; y: number; t: number; target: Element; top: boolean } | null = null;
  document.addEventListener(
    "touchstart",
    (e) => {
      const p = e.touches[0];
      const target = e.target as Element;
      // Sliders and the seek bar use horizontal drags themselves.
      if (e.touches.length !== 1 || target.closest("input[type=range], .seek, .progress")) return (start = null);
      start = { x: p.clientX, y: p.clientY, t: Date.now(), target, top: atTop(target) };
    },
    { passive: true },
  );
  document.addEventListener(
    "touchend",
    (e) => {
      if (!start) return;
      const p = e.changedTouches[0];
      const dx = p.clientX - start.x;
      const dy = p.clientY - start.y;
      const quick = Date.now() - start.t < 700;
      const { target, top } = start;
      start = null;
      if (!quick) return;
      // Edge swipe to the right: back.
      if (p.clientX - dx < 28 && dx > 70 && Math.abs(dy) < 60) {
        goBackOrClose();
        return;
      }
      // Swipe down: close the sheet it started on.
      if (dy > 90 && Math.abs(dx) < 70) {
        const s = useUi.getState();
        if (target.closest(".menu") && s.menu) useUi.setState({ menu: null });
        else if (!top) return;
        else if (target.closest(".queue-panel") && s.queueOpen) useUi.setState({ queueOpen: false });
        else if (target.closest(".fullscreen-host") && s.fullscreen) useUi.setState({ fullscreen: false });
      }
    },
    { passive: true },
  );
}
