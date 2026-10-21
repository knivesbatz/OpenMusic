// The single playback engine. Lives only in the main window; the mini player (PiP) mirrors its
// state over Tauri events and sends commands back, so there is never a second audio session.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
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
  /** Kind of output for the current track. */
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
let loadToken = 0;

/**
 * Two YouTube players, like the two audio decks: the idle one cues the next video so it can
 * crossfade in or start the moment the current one ends.
 */
const ytDecks: YouTubeOutput[] = [];
let ytActive = 0;
let ytPreloaded: { uid: string; videoId: string; ready: boolean } | null = null;

function ytDeck(i = ytActive): YouTubeOutput {
  while (ytDecks.length < 2) {
    const idx = ytDecks.length;
    const mine = () => idx === ytActive && get().output === "youtube";
    ytDecks.push(
      new YouTubeOutput({
        onTime: (t, d) => mine() && onTime(t, d),
        onEnded: () => mine() && onEnded(),
        onState: (p) => mine() && !fading && set({ playing: p }),
        onError: (m) => mine() && onError(m),
      }),
    );
  }
  return ytDecks[i];
}

function stopYouTube() {
  for (const d of ytDecks) d.stop();
  ytPreloaded = null;
}
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
  stopYouTube();
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
    // Same for a YouTube video cued on the idle player.
    if (ytPreloaded && ytPreloaded.uid === item.uid && ytPreloaded.ready) {
      ytDeck().stop();
      ytActive = 1 - ytActive;
      ytPreloaded = null;
      const d = ytDeck();
      d.setVolume(volume());
      if (autoplay) d.play();
      set({ loading: false, output: "youtube", quality: null, offline: false });
      startedTrack(item);
      return;
    }
    const stream = await resolve(item.track);
    if (token !== loadToken) return;
    for (const a of decks) a.pause();
    if (stream.kind === "youtube") {
      set({ output: "youtube", quality: null, offline: false });
      if (ytDecks.length) ytDeck(1 - ytActive).stop();
      ytPreloaded = null;
      await ytDeck().load(stream.videoId, startAt, autoplay, volume());
    } else {
      stopYouTube();
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
  // Last.fm gets the official artist/album of YouTube music videos, not the uploader.
  if (useSettings.getState().scrobble && !item.track.episode) api.lastfmNowPlaying(displayTrack(item.track)).catch(() => {});
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
  if (!s.output || !s.playing) return;
  const remaining = dur - t;
  const settings = useSettings.getState();
  const nextI = Q.nextIndex(s.queue, s.repeat, false);
  const nextItem = nextI >= 0 && nextI !== s.queue.index ? s.queue.items[nextI] : undefined;
  if (!nextItem) {
    // Last song: fetch Autoplay songs early so gapless and crossfade work into them too.
    if (remaining < 30) fetchAutoplay();
    return;
  }
  // Blending needs both tracks on the same kind of output (two audio decks or two players).
  const yt = s.output === "youtube";
  if (yt !== (nextItem.track.source === "youtube")) return;
  const cur = Q.current(s.queue)!;
  const fade = crossfadeSeconds(cur.track, nextItem.track);
  const ahead = remaining < Math.max(20, fade + 8);
  // Preload the next track ahead of time: makes gapless and crossfade start instantly.
  if (yt) {
    if ((settings.gapless || fade > 0) && ahead && ytPreloaded?.uid !== nextItem.uid) preloadYouTube(nextItem);
    if (fade > 0 && !fading && remaining <= fade && remaining > 0.25 && ytPreloaded?.uid === nextItem.uid && ytPreloaded.ready) {
      crossfadeYouTube(nextI, fade);
    }
    return;
  }
  if ((settings.gapless || fade > 0) && ahead && preloaded?.uid !== nextItem.uid) preload(nextItem);
  if (fade > 0 && !fading && remaining <= fade && remaining > 0.25 && preloaded?.uid === nextItem.uid) {
    crossfadeTo(nextI, fade);
  }
}

async function preloadYouTube(item: Q.QItem) {
  ytPreloaded = { uid: item.uid, videoId: "", ready: false };
  try {
    const stream = await resolve(item.track);
    if (stream.kind !== "youtube" || ytPreloaded?.uid !== item.uid) return;
    ytPreloaded.videoId = stream.videoId;
    // Cued (not playing) and silent until the transition.
    await ytDeck(1 - ytActive).load(stream.videoId, 0, false, 0);
    if (ytPreloaded?.uid === item.uid) ytPreloaded.ready = true;
  } catch {
    ytPreloaded = null;
  }
}

function crossfadeYouTube(nextI: number, seconds: number) {
  const from = ytDeck();
  const to = ytDeck(1 - ytActive);
  fading = true;
  to.setVolume(0);
  to.play();
  ytActive = 1 - ytActive;
  ytPreloaded = null;
  set({ queue: Q.advance(get().queue, nextI), position: 0, playing: true });
  const item = Q.current(get().queue);
  if (item) startedTrack(item);
  runFade(
    seconds,
    (inV, outV) => {
      to.setVolume(inV);
      from.setVolume(outV);
    },
    () => from.stop(),
  );
}

/** Equal-power fade over `seconds`, calling `apply(incoming, outgoing)` volumes every 50 ms. */
function runFade(seconds: number, apply: (inV: number, outV: number) => void, done: () => void) {
  const steps = Math.max(1, Math.round((seconds * 1000) / 50));
  let step = 0;
  clearInterval(fadeTimer);
  fadeTimer = setInterval(() => {
    step++;
    const v = volume();
    const k = Math.min(1, step / steps);
    apply(v * Math.sin((k * Math.PI) / 2), v * Math.cos((k * Math.PI) / 2));
    if (k >= 1) {
      clearInterval(fadeTimer);
      done();
      fading = false;
    }
  }, 50);
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
  runFade(
    seconds,
    (inV, outV) => {
      to.volume = inV;
      from.volume = outV;
    },
    () => from.pause(),
  );
}

function onEnded() {
  const s = get();
  const i = Q.nextIndex(s.queue, s.repeat, false);
  if (i < 0) {
    autoplayRadio();
    return;
  }
  if (i === s.queue.index) {
    // Repeat one: every replay is a new listen (Last.fm scrobble and history).
    seek(0);
    play();
    const item = Q.current(s.queue);
    if (item) startedTrack(item);
    return;
  }
  set({ queue: Q.advance(s.queue, i) });
  loadCurrent(true);
}

let autoplaySeed = "";
let autoplayFetch: Promise<boolean> = Promise.resolve(false);

/**
 * Settings → Autoplay: append songs similar to the last queue item (once per last item).
 * Resolves true when songs were added.
 */
function fetchAutoplay(): Promise<boolean> {
  const s = get();
  const last = s.queue.items[s.queue.items.length - 1];
  if (!inTauri || !useSettings.getState().autoplaySimilar || !last || s.repeat !== "off") return Promise.resolve(false);
  if (autoplaySeed === last.uid) return autoplayFetch;
  autoplaySeed = last.uid;
  const exclude = s.queue.items.slice(-200).map((i) => i.track.id);
  autoplayFetch = api
    .autoplayTracks(last.track, exclude)
    .then((tracks) => {
      const q = get().queue;
      // The queue changed while fetching: leave it alone.
      if (!tracks?.length || q.items[q.items.length - 1]?.uid !== last.uid) return false;
      set({ queue: Q.extend(q, tracks) });
      return true;
    })
    .catch(() => false);
  return autoplayFetch;
}

/** The queue ran out: continue with Autoplay songs if that's on, otherwise stop. */
async function autoplayRadio() {
  set({ loading: true });
  const added = await fetchAutoplay();
  const s = get();
  const i = added ? Q.nextIndex(s.queue, s.repeat, true) : -1;
  if (i < 0 || i === s.queue.index) {
    set({ playing: false, loading: false });
    return;
  }
  set({ queue: Q.advance(s.queue, i) });
  loadCurrent(true);
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
      if (useSettings.getState().scrobble) api.lastfmScrobble(displayTrack(item.track), scrobble.startedAt).catch(() => {});
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
  if (fading) return; // the fade reads the volume on every step
  if (decks.length) deck().volume = s.volume;
  if (ytDecks.length) ytDeck().setVolume(s.volume);
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
  if (s.output === "youtube") ytDeck().play();
  else deck().play().catch((e) => onError(errorMessage(e)));
}

export function pause() {
  // Pausing mid-fade finishes the transition: the outgoing track stops, the new one keeps its place.
  const midFade = fading;
  if (midFade) {
    clearInterval(fadeTimer);
    fading = false;
  }
  if (get().output === "youtube") {
    if (ytDecks.length) {
      ytDeck().pause();
      if (midFade) {
        ytDeck(1 - ytActive).stop();
        ytDeck().setVolume(volume());
      }
    }
  } else if (decks.length) {
    deck().pause();
    if (midFade) {
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
  if (s.output === "youtube") ytDecks.length && ytDeck().seek(t);
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

/**
 * Tray menu and Android notification buttons. On Android the webview's Media Session doesn't
 * reach the system, so the player is also mirrored into the app's media notification (which
 * keeps playback alive in the background).
 */
export function initRemoteControls() {
  if (!inTauri) return;
  // Controls outside the webview: the desktop tray menu and the Android notification.
  listen<{ action: string; positionMs?: number }>("media-action", ({ payload }) => {
    if (payload.action === "play") play();
    else if (payload.action === "pause") pause();
    else if (payload.action === "toggle") toggle();
    else if (payload.action === "next") next();
    else if (payload.action === "previous") previous();
    else if (payload.action === "seek" && payload.positionMs != null) seek(payload.positionMs / 1000);
  });
  if (!/Android/i.test(navigator.userAgent)) return;
  let sent = { id: "", playing: false, at: 0, position: 0 };
  usePlayer.subscribe((s) => {
    const cur = Q.current(s.queue)?.track;
    if (!cur) {
      if (sent.id) api.mediaStop().catch(() => {});
      sent = { id: "", playing: false, at: 0, position: 0 };
      return;
    }
    const t = displayTrack(cur);
    // Send on track, play/pause or seek changes only; Android advances the position itself.
    const expected = sent.position + (sent.playing ? (Date.now() - sent.at) / 1000 : 0);
    if (t.id === sent.id && s.playing === sent.playing && Math.abs(s.position - expected) < 3) return;
    sent = { id: t.id, playing: s.playing, at: Date.now(), position: s.position };
    api
      .mediaUpdate({
        title: t.title,
        artist: t.artist,
        album: t.album ?? null,
        artwork: t.artwork ?? null,
        playing: s.playing,
        positionMs: Math.round(s.position * 1000),
        durationMs: Math.round(s.duration * 1000),
      })
      .catch(() => {});
  });
}
