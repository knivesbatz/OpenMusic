// YouTube playback through the official IFrame Player API (the only supported way to play YouTube
// audio in a third-party client). It has no crossfade, gapless preload or quality control, which is
// reported through Capabilities and explained in Settings.

interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  setVolume(v: number): void;
  getCurrentTime(): number;
  getDuration(): number;
}

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer; PlayerState: Record<string, number> };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface Callbacks {
  onTime: (t: number, d: number) => void;
  onEnded: () => void;
  onState: (playing: boolean) => void;
  onError: (message: string) => void;
}

let apiReady: Promise<void> | null = null;
function loadApi(): Promise<void> {
  apiReady ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      apiReady = null;
      reject(new Error("YouTube player could not be loaded (offline?)"));
    };
    document.head.appendChild(s);
  });
  return apiReady;
}

const ERRORS: Record<number, string> = {
  2: "invalid video id",
  5: "HTML5 player error",
  100: "video not found or private",
  101: "the owner does not allow playback in other apps",
  150: "the owner does not allow playback in other apps",
};

export class YouTubeOutput {
  private player: YTPlayer | null = null;
  private ready: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private cb: Callbacks) {}

  private init(): Promise<void> {
    this.ready ??= loadApi().then(
      () =>
        new Promise<void>((resolve) => {
          const host = document.createElement("div");
          const wrap = document.createElement("div");
          wrap.setAttribute("aria-hidden", "true");
          wrap.style.cssText = "position:fixed;width:200px;height:200px;left:-10000px;top:0;pointer-events:none";
          wrap.appendChild(host);
          document.body.appendChild(wrap);
          this.player = new window.YT!.Player(host, {
            width: 200,
            height: 200,
            playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, origin: location.origin },
            events: {
              onReady: () => resolve(),
              onStateChange: (e: { data: number }) => this.state(e.data),
              onError: (e: { data: number }) => this.cb.onError(ERRORS[e.data] ?? `YouTube error ${e.data}`),
            },
          });
        }),
    );
    return this.ready;
  }

  private state(s: number) {
    // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (s === 0) {
      this.stopTimer();
      this.cb.onEnded();
    } else if (s === 1) {
      this.cb.onState(true);
      this.startTimer();
    } else if (s === 2) {
      this.cb.onState(false);
      this.stopTimer();
    }
  }

  private startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (this.player) this.cb.onTime(this.player.getCurrentTime(), this.player.getDuration());
    }, 500);
  }

  private stopTimer() {
    clearInterval(this.timer);
  }

  async load(videoId: string, startAt: number, autoplay: boolean, volume: number) {
    await this.init();
    this.player!.setVolume(Math.round(volume * 100));
    if (autoplay) this.player!.loadVideoById({ videoId, startSeconds: startAt });
    else this.player!.cueVideoById({ videoId, startSeconds: startAt });
  }

  play() {
    this.player?.playVideo();
  }
  pause() {
    this.player?.pauseVideo();
  }
  stop() {
    this.stopTimer();
    this.player?.stopVideo();
  }
  seek(t: number) {
    this.player?.seekTo(t, true);
  }
  setVolume(v: number) {
    this.player?.setVolume(Math.round(v * 100));
  }
}
