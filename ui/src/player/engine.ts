// The single playback engine. Lives only in the main window; the mini player (PiP) mirrors its
// state over Tauri events and sends commands back, so there is never a second audio session.
import { create } from "zustand";
import { api, errorMessage, fileUrl, inTauri } from "../api";
import type { PlayContext, Stream, Track } from "../types";
import { useSettings } from "../store/settings";
import { toast } from "../store/ui";
import * as Q from "./queue";
import { YouTubeOutput } from "./youtube";
import { displayTrack } from "../store/songmeta";

export interface PlayerState {
  queue: Q.QueueState;
  context: PlayContext | null;
  playing: boolean;
  loading: boolean;
  position: number; // seconds
  duration: number; // seconds
  shuffle: boolean;
  repeat: Q.Repeat;
  /** Kind of output for the current track; YouTube has no crossfade/gapless. */
  output: "audio" | "youtube" | null;
  quality: string | null;
  offline: boolean;
}

const initial: PlayerState = {
  queue: Q.emptyQueue,
  context: null,
  playing: false,
  loading: false,
  position: 0,
  duration: 0,
  shuffle: false,
  repeat: "off",
  output: null,
  quality: null,
  offline: false,
};

export const usePlayer = create<PlayerState>(() => initial);
const get = usePlayer.getState;
const set = usePlayer.setState;

// ---- audio outputs ---------------------------------------------------------------------------

/** Two elements so crossfade and gapless preload can overlap tracks. */
const decks: HTMLAudioElement[] = [];
let active = 0;
let preloaded: { uid: string; src: string } | null = null;
let fading = false;
let fadeTimer: ReturnType<typeof setInterval> | undefined;
let yt: YouTubeOutput | null = null;
let loadToken = 0;
let scrobble: { uid: string; startedAt: number; done: boolean; playedMs: number; lastTick: number } | null = null;

function deck(i = active) {
  return decks[i];
}

function ensureDecks() {
  if (decks.length) return;
  for (let i = 0; i < 2; i++) {
    const a = new Audio();
    a.preload = "auto";
    a.crossOrigin = "anonymous";
    const idx = i;
    a.addEventListener("timeupdate", () => idx === active && onTime(a.currentTime, a.duration));
    a.addEventListener("durationchange", () => idx === active && onTime(a.currentTime, a.duration));
    a.addEventListener("play", () => idx === active && set({ playing: true }));
    a.addEventListener("pause", () => idx === active && !fading && set({ playing: false }));
    a.addEventListener("ended", () => idx === active && onEnded());
    a.addEventListener("error", () => idx === active && a.src && onError(a.error?.message || "media error"));
    decks.push(a);
  }
}

function volume() {
  return useSettings.getState().volume;
}

function stopAll() {
  clearInterval(fadeTimer);
  fading = false;
  for (const a of decks) {
    a.pause();
    a.removeAttribute("src");
    a.load();
  }
  preloaded = null;
  yt?.stop();
}

// ---- stream resolution -----------------------------------------------------------------------

const streamCache = new Map<string, Promise<Stream>>();

function resolve(track: Track): Promise<Stream> {
  const quality = useSettings.getState().quality;
  const key = track.id + "|" + quality;
  let p = streamCache.get(key);
  if (!p) {
    p = api.resolveStream(track, quality);
    streamCache.set(key, p);
    p.catch(() => streamCache.delete(key));
    // Signed stream URLs expire; never keep them for long.
    setTimeout(() => streamCache.delete(key), 10 * 60_000);
    if (streamCache.size > 50) streamCache.delete(streamCache.keys().next().value!);
  }
  return p;
}

function srcOf(s: Stream): string | null {
  if (s.kind === "url") return s.url;
  if (s.kind === "file") return fileUrl(s.path);
  return null;
}

// ---- loading and transitions -----------------------------------------------------------------

async function loadCurrent(autoplay: boolean, startAt = 0) {
  const item = Q.current(get().queue);
  const token = ++loadToken;
  clearInterval(fadeTimer);
  fading = false;
  if (!item) {
    stopAll();
    set({ playing: false, position: 0, duration: 0, output: null });
    return;
  }
  set({ loading: true, position: startAt, duration: (item.track.durationMs ?? 0) / 1000 });
  try {
    ensureDecks();
    // Gapless: the next track may already be buffered on the idle deck.
    if (preloaded && preloaded.uid === item.uid) {
      const other = 1 - active;
      deck().pause();
      active = other;
      preloaded = null;
      const a = deck();
      a.volume = volume();
      if (autoplay) await a.play();
      set({ loading: false, output: "audio" });
      startedTrack(item);
      return;
    }
    const stream = await resolve(item.track);
    if (token !== loadToken) return;
    for (const a of decks) a.pause();
    if (stream.kind === "youtube") {
      yt ??= new YouTubeOutput({
        onTime: (t, d) => get().output === "youtube" && onTime(t, d),
        onEnded: () => get().output === "youtube" && onEnded(),
        onState: (p) => get().output === "youtube" && set({ playing: p }),
        onError: (m) => get().output === "youtube" && onError(m),
      });
      set({ output: "youtube", quality: null, offline: false });
      await yt.load(stream.videoId, startAt, autoplay, volume());
    } else {
      yt?.stop();
      const a = deck();
      a.src = srcOf(stream)!;
      a.volume = volume();
      if (startAt) a.currentTime = startAt;
      set({ output: "audio", quality: stream.quality, offline: stream.offline });
      if (autoplay) await a.play();
    }
    if (token !== loadToken) return;
    set({ loading: false });
    startedTrack(item);
  } catch (e) {
    if (token !== loadToken) return;
    onError(errorMessage(e));
  }
}

function startedTrack(item: Q.QItem) {
  scrobble = { uid: item.uid, startedAt: Math.floor(Date.now() / 1000), done: false, playedMs: 0, lastTick: Date.now() };
  if (!inTauri) return;
  const ctx = get().context;
  api.recordPlay(item.track, ctx).catch(() => {});
  if (useSettings.getState().scrobble && !item.track.episode) api.lastfmNowPlaying(item.track).catch(() => {});
  persistSoon();
}

let errorStreak = 0;
function onError(message: string) {
  const item = Q.current(get().queue);
  set({ loading: false, playing: false });
  if (!item) return;
  toast(`“${item.track.title}”: ${message}`);
  // Skip unavailable tracks, but never spin through a whole queue of failures.
  if (++errorStreak < 3) next(true);
  else errorStreak = 0;
}

function onTime(t: number, d: number) {
  const s = get();
  const dur = Number.isFinite(d) && d > 0 ? d : s.duration;
  set({ position: t, duration: dur });
  if (t > 1) errorStreak = 0;
  trackScrobble();
  if (s.output !== "audio" || !s.playing) return;
  const remaining = dur - t;
  const settings = useSettings.getState();
  const nextI = Q.nextIndex(s.queue, s.repeat, false);
  const nextItem = nextI >= 0 && nextI !== s.queue.index ? s.queue.items[nextI] : undefined;
  if (!nextItem || nextItem.track.source === "youtube") return;
  const cur = Q.current(s.queue)!;
  const fade = crossfadeSeconds(cur.track, nextItem.track);
  // Preload the next stream ahead of time: makes gapless and crossfade start instantly.
  if ((settings.gapless || fade > 0) && remaining < Math.max(20, fade + 8) && preloaded?.uid !== nextItem.uid) {
    preload(nextItem);
  }
  if (fade > 0 && !fading && remaining <= fade && remaining > 0.25 && preloaded?.uid === nextItem.uid) {
    crossfadeTo(nextI, fade);
  }
}

/** Crossfade length between two tracks, respecting Automix (never fade inside an album). */
export function crossfadeSeconds(a: Track, b: Track): number {
  const s = useSettings.getState();
  if (s.automix) {
    if (a.albumId && a.albumId === b.albumId) return 0;
    return s.crossfade || 6;
  }
  return s.crossfade;
}

async function preload(item: Q.QItem) {
  preloaded = { uid: item.uid, src: "" };
  try {
    const stream = await resolve(item.track);
    const src = srcOf(stream);
    if (!src || preloaded?.uid !== item.uid) return;
    const idle = deck(1 - active);
    idle.src = src;
    idle.volume = 0;
    idle.load();
    preloaded.src = src;
  } catch {
    preloaded = null;
  }
}

function crossfadeTo(nextI: number, seconds: number) {
  const from = deck();
  const to = deck(1 - active);
  fading = true;
  to.volume = 0;
  to.play().catch(() => {});
  active = 1 - active;
  preloaded = null;
  set({ queue: Q.advance(get().queue, nextI), position: 0 });
  const item = Q.current(get().queue);
  if (item) startedTrack(item);
  const steps = Math.max(1, Math.round((seconds * 1000) / 50));
  let step = 0;
  clearInterval(fadeTimer);
  fadeTimer = setInterval(() => {
    step++;
    const v = volume();
    const k = Math.min(1, step / steps);
    // Equal-power curve keeps loudness steady through the fade.
    to.volume = v * Math.sin((k * Math.PI) / 2);
    from.volume = v * Math.cos((k * Math.PI) / 2);
    if (k >= 1) {
      clearInterval(fadeTimer);
      from.pause();
      fading = false;
    }
  }, 50);
}

function onEnded() {
  const s = get();
  const i = Q.nextIndex(s.queue, s.repeat, false);
  if (i < 0) {
    autoplayRadio();
    return;
  }
  if (i === s.queue.index) {
    seek(0);
    play();
    return;
  }
  set({ queue: Q.advance(s.queue, i) });
  loadCurrent(true);
}

async function autoplayRadio() {
  const s = get();
  const cur = Q.current(s.queue);
  set({ playing: false });
  if (!cur || !useSettings.getState().autoplay || !inTauri) return;
  try {
    const more = (await api.radio(cur.track)).filter((t) => t.id !== cur.track.id);
    if (!more.length) return;
    const q = get().queue;
    const items = [...q.items, ...Q.toItems(more)];
    set({ queue: Q.advance({ ...q, items }, q.items.length) });
    loadCurrent(true);
  } catch {
    /* no radio for this source */
  }
}

function trackScrobble() {
  const s = get();
  const item = Q.current(s.queue);
  if (!scrobble || !item || scrobble.uid !== item.uid) return;
  const now = Date.now();
  if (s.playing) scrobble.playedMs += Math.min(2000, now - scrobble.lastTick);
  scrobble.lastTick = now;
  if (scrobble.done || item.track.episode) return;
  const dur = s.duration;
  // Last.fm rule: track longer than 30 s, played for half its length or 4 minutes.
  if (dur > 30 && scrobble.playedMs / 1000 >= Math.min(dur / 2, 240)) {
    scrobble.done = true;
    if (inTauri) {
      api.markPlayed(item.track).catch(() => {});
      if (useSettings.getState().scrobble) api.lastfmScrobble(item.track, scrobble.startedAt).catch(() => {});
    }
  }
}

// ---- persistence -----------------------------------------------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon() {
  if (!inTauri) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const s = get();
    const tracks = s.queue.items.map((i) => ({ t: i.track, m: i.manual }));
    api
      .queueSave({ tracks, index: s.queue.index, context: s.context, position: s.position, shuffle: s.shuffle, repeat: s.repeat })
      .catch(() => {});
  }, 1500);
}

export async function restore() {
  if (!inTauri) return;
  try {
    const raw = (await api.queueLoad()) as {
      tracks: { t: Track; m: boolean }[];
      index: number;
      context: PlayContext | null;
      position: number;
      shuffle: boolean;
      repeat: Q.Repeat;
    } | null;
    if (!raw || !Array.isArray(raw.tracks)) return;
    const items = raw.tracks.map((x) => ({ uid: Q.newUid(), track: x.t, manual: !!x.m }));
    const index = Math.min(Math.max(-1, raw.index), items.length - 1);
    set({
      queue: { items, index, unshuffled: null },
      context: raw.context,
      position: raw.position || 0,
      shuffle: !!raw.shuffle,
      repeat: ["off", "all", "one"].includes(raw.repeat) ? raw.repeat : "off",
      duration: (items[index]?.track.durationMs ?? 0) / 1000,
    });
  } catch {
    /* first run */
  }
}

usePlayer.subscribe((s, prev) => {
  if (s.queue !== prev.queue || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat) persistSoon();
});

// Volume follows settings.
useSettings.subscribe((s, prev) => {
  if (s.volume === prev.volume) return;
  if (!fading && decks.length) deck().volume = s.volume;
  yt?.setVolume(s.volume);
});

// ---- public commands -------------------------------------------------------------------------

export function playTracks(tracks: Track[], start = 0, context: PlayContext | null = null) {
  if (!tracks.length) return;
  errorStreak = 0;
  set({ queue: Q.load(tracks, start, get().shuffle), context });
  loadCurrent(true);
}

export function playUid(uid: string) {
  const q = get().queue;
  const i = q.items.findIndex((x) => x.uid === uid);
  if (i < 0) return;
  set({ queue: Q.advance(q, i) });
  loadCurrent(true);
}

export function play() {
  const s = get();
  if (!Q.current(s.queue)) return;
  if (s.output === null || (s.output === "audio" && !deck()?.src)) {
    loadCurrent(true, s.position);
    return;
  }
  if (s.output === "youtube") yt?.play();
  else deck().play().catch((e) => onError(errorMessage(e)));
}

export function pause() {
  if (get().output === "youtube") yt?.pause();
  else if (decks.length) {
    deck().pause();
    if (fading) {
      clearInterval(fadeTimer);
      fading = false;
      deck(1 - active).pause();
      deck().volume = volume();
    }
  }
  set({ playing: false });
}

export function toggle() {
  if (get().playing) pause();
  else play();
}

export function next(userSkip = true) {
  const s = get();
  const i = Q.nextIndex(s.queue, s.repeat, userSkip);
  if (i < 0) {
    autoplayRadio();
    return;
  }
  set({ queue: Q.advance(s.queue, i) });
  loadCurrent(true);
}

export function previous() {
  const s = get();
  // Like Spotify: restart the track if more than 3 s in.
  if (s.position > 3) return seek(0);
  const i = Q.prevIndex(s.queue, s.repeat);
  if (i === s.queue.index) return seek(0);
  set({ queue: Q.advance(s.queue, i) });
  loadCurrent(true);
}

export function seek(seconds: number) {
  const s = get();
  const t = Math.max(0, Math.min(seconds, s.duration || seconds));
  if (s.output === "youtube") yt?.seek(t);
  else if (decks.length && deck().src) deck().currentTime = t;
  set({ position: t });
}

export function setShuffle(on: boolean) {
  set({ shuffle: on, queue: Q.setShuffle(get().queue, on) });
  preloaded = null;
}

export function cycleRepeat() {
  const r = get().repeat;
  set({ repeat: r === "off" ? "all" : r === "all" ? "one" : "off" });
}

export function addToQueue(tracks: Track[]) {
  const wasEmpty = !Q.current(get().queue);
  set({ queue: Q.enqueue(get().queue, tracks) });
  if (wasEmpty) loadCurrent(true);
}

export function addNext(tracks: Track[]) {
  const wasEmpty = !Q.current(get().queue);
  set({ queue: Q.playNext(get().queue, tracks) });
  if (wasEmpty) loadCurrent(true);
}

export function removeFromQueue(uids: string[]) {
  set({ queue: Q.remove(get().queue, uids) });
  preloaded = null;
}

export function moveInQueue(uids: string[], beforeIndex: number) {
  set({ queue: Q.move(get().queue, uids, beforeIndex) });
  preloaded = null;
}

export function clearQueue() {
  set({ queue: Q.clearUpcoming(get().queue) });
  preloaded = null;
}

export function currentTrack(): Track | undefined {
  return Q.current(get().queue)?.track;
}

/** Hook up OS media keys / SMTC. */
export function initMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", play);
  ms.setActionHandler("pause", pause);
  ms.setActionHandler("nexttrack", () => next());
  ms.setActionHandler("previoustrack", previous);
  ms.setActionHandler("seekto", (d) => d.seekTime != null && seek(d.seekTime));
  let lastId = "";
  usePlayer.subscribe((s) => {
    const cur = Q.current(s.queue)?.track;
    const t = cur && displayTrack(cur);
    ms.playbackState = s.playing ? "playing" : "paused";
    if (!t || t.id === lastId) return;
    lastId = t.id;
    ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album ?? "" });
  });
}
