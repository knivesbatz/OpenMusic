// Main window <-> mini player (PiP) sync. The main window owns the engine and broadcasts a compact
// snapshot; the PiP window renders it and sends commands back. No second audio session exists.
import { emit, listen } from "@tauri-apps/api/event";
import { inTauri } from "../api";
import * as P from "./engine";
import { usePlayer } from "./engine";
import type { Track } from "../types";
import { displayTrack, useSongMeta } from "../store/songmeta";

export interface Snapshot {
  track: Track | null;
  playing: boolean;
  position: number;
  duration: number;
}

export type Command = "toggle" | "next" | "previous" | { seek: number };

export function startBroadcast() {
  if (!inTauri) return;
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    last = Date.now();
    const s = usePlayer.getState();
    const cur = s.queue.items[s.queue.index]?.track;
    const snap: Snapshot = { track: cur ? displayTrack(cur) : null, playing: s.playing, position: s.position, duration: s.duration };
    emit("player-state", snap).catch(() => {});
  };
  usePlayer.subscribe((s, prev) => {
    const important = s.playing !== prev.playing || s.queue !== prev.queue;
    clearTimeout(timer);
    // Position ticks are throttled to 1 Hz; track/play changes go out at once.
    if (important || Date.now() - last > 1000) send();
    else timer = setTimeout(send, 1000);
  });
  listen("pip-ready", send);
  // Album art for a playing music video may arrive after the track started.
  useSongMeta.subscribe(() => send());
  listen<Command>("player-cmd", (e) => {
    const c = e.payload;
    if (c === "toggle") P.toggle();
    else if (c === "next") P.next();
    else if (c === "previous") P.previous();
    else if (typeof c === "object" && typeof c.seek === "number") P.seek(c.seek);
  });
}

export const sendCommand = (c: Command) => emit("player-cmd", c);
