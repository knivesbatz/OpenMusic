import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Pip } from "./components/Pip";
import { initGamepad } from "./gamepad";
import { initMediaSession, restore } from "./player/engine";
import { startBroadcast } from "./player/bridge";
import { boot } from "./store/app";
import { useSettings } from "./store/settings";
import "./styles.css";

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
  return isPip ? <Pip /> : <App />;
}

async function start() {
  await useSettings.getState().load();
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
  startBroadcast();
  initGamepad();
}

start();
