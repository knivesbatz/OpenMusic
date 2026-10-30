// "Share audio with Discord" (Windows). The app's sound comes from WebView2's own processes, which
// Discord's Go Live doesn't hear when it shares the app's (or the mini player's) window. With the
// setting on, Rust plays that audio again from the app's process (see audio_share.rs).
import { listen } from "@tauri-apps/api/event";
import { api, errorMessage, inTauri } from "../api";
import { useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { toast } from "../store/ui";

export function initAudioShare() {
  if (!inTauri || useApp.getState().info?.platform !== "windows") return;
  const apply = (on: boolean) =>
    api.audioShareSet(on).catch((e) => {
      if (!on) return;
      useSettings.getState().set({ shareAudio: false });
      toast(errorMessage(e));
    });
  // It stopped by itself (Windows didn't pass the audio, the device went away): say why.
  listen<string>("audio-share-stopped", (e) => {
    useSettings.getState().set({ shareAudio: false });
    toast(e.payload);
  }).catch(() => {});
  if (useSettings.getState().shareAudio) apply(true);
  useSettings.subscribe((s, prev) => s.shareAudio !== prev.shareAudio && apply(s.shareAudio));
}
