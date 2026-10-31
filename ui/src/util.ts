export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export const fmtMs = (ms?: number | null) => (ms ? fmtTime(ms / 1000) : "");

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export function totalDuration(tracks: { durationMs?: number | null }[]): number {
  return tracks.reduce((a, t) => a + (t.durationMs ?? 0), 0) / 1000;
}

export function cls(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}

/** Touch-first device (phones/tablets): taps play instead of selecting, no hover. */
export const isTouch = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;


/** A text field, where Space types a space. */
export function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file", "image"].includes(el.type);
}

// Elements that got focus from a mouse or touch press (a clicked button keeps focus). Browsers'
// :focus-visible can't tell: in Chromium it turns on for any focused element once a key is pressed.
const pointerFocused = new WeakSet<Element>();
if (typeof window !== "undefined") {
  // How the user last interacted when focus moves decides how it got there.
  let pointer = false;
  addEventListener("pointerdown", () => (pointer = true), true);
  addEventListener("keydown", () => (pointer = false), true);
  addEventListener(
    "focusin",
    (e) => {
      if (!(e.target instanceof Element)) return;
      if (pointer) pointerFocused.add(e.target);
      else pointerFocused.delete(e.target);
    },
    true,
  );
}

/**
 * Whether Space should play/pause rather than go to the focused element. A button, switch or row
 * that was clicked keeps focus, and the browser would "press" it again on Space (a clicked Next
 * button skipped the song). Space only goes to text fields and to controls the user reached with
 * the keyboard.
 */
export function spaceTogglesPlayback(e: KeyboardEvent): boolean {
  if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.target instanceof Element ? e.target : null;
  if (isTextField(el)) return false;
  const control = el?.closest("button, a[href], input, [role=button], [role=option], [role=row], [role=menuitem], [role=menuitemradio], [role=switch], [role=slider], [role=tab], [tabindex]");
  return !control || pointerFocused.has(el!) || pointerFocused.has(control);
}
