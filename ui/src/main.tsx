import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Pip } from "./components/Pip";
import { initGamepad } from "./gamepad";
import { initRemoteControls, initMediaSession, restore } from "./player/engine";
import { initGestures } from "./gestures";
import { initUpdates } from "./store/update";
import { loadPlaylistSorts } from "./store/playlistSort";
import { isTouch } from "./util";
import { startBroadcast } from "./player/bridge";
import { boot } from "./store/app";
import { useSettings } from "./store/settings";
// Figtree (SIL OFL), bundled so text looks the same on Windows and Android, offline too. The
// closest open typeface to Spotify's geometric sans; Japanese falls back to the system fonts.
import "@fontsource-variable/figtree";
import "./styles.css";
import { api, inTauri, setArtBase } from "./api";
import { useApp } from "./store/app";
import { ErrorBoundary } from "./components/ErrorBoundary";

/** Uncaught UI errors go to crash.log too, so reports from users carry something to go on. */
function installErrorLog() {
  if (!inTauri) return;
  let sent = 0;
  const log = (msg: string) => sent++ < 20 && api.logUiError(msg.slice(0, 2000)).catch(() => {});
  addEventListener("error", (e) => log(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ""}`));
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    // Rejected API calls are handled where they're made; only log real exceptions.
    if (r instanceof Error) log(`unhandled rejection: ${r.message}\n${r.stack ?? ""}`);
  });
}

const isPip = location.hash === "#pip";

/** Applies accessibility and language settings to the document root. */
function Root() {
  const scale = useSettings((s) => s.textScale);
  const reduced = useSettings((s) => s.reducedMotion);
  const contrast = useSettings((s) => s.highContrast);
  const lang = useSettings((s) => s.language);
  useEffect(() => {
    const el = document.documentElement;
    el.style.fontSize = 16 * scale + "px";
    el.classList.toggle("reduced-motion", reduced);
    el.classList.toggle("high-contrast", contrast);
    el.lang = lang;
  }, [scale, reduced, contrast, lang]);
  return <ErrorBoundary>{isPip ? <Pip /> : <App />}</ErrorBoundary>;
}

async function start() {
  installErrorLog();
  await useSettings.getState().load();
  if (inTauri) {
    try {
      const info = await api.appInfo();
      setArtBase(info.artBase);
      if (!isPip) useApp.setState({ info });
    } catch {
      /* boot() reports it */
    }
  }
  if (isPip) document.documentElement.classList.add("pip-window");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
  if (isPip) return;
  await boot().catch((e) => console.error("boot failed", e));
  await restore();
  initMediaSession();
  initRemoteControls();
  initUpdates();
  loadPlaylistSorts();
  if (isTouch() || /Android/i.test(navigator.userAgent)) initGestures();
  if (useApp.getState().info?.selfTest) import("./selftest").then((m) => m.runSelfTest());
  startBroadcast();
  initGamepad();
}

start();
