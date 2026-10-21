// Resizable mini player window. Layout adapts: square-ish shows artwork, short shows a strip.
import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../api";
import { useT } from "../i18n";
import { sendCommand, type Snapshot } from "../player/bridge";
import { cls } from "../util";
import { Art } from "./common";
import * as I from "./Icons";

export function Pip() {
  const t = useT();
  const [s, setS] = useState<Snapshot>({ track: null, playing: false, position: 0, duration: 0 });
  const [at, setAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const un = listen<Snapshot>("player-state", (e) => {
      setS(e.payload);
      setAt(Date.now());
    });
    emit("pip-ready").catch(() => {});
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => {
      un.then((f) => f());
      clearInterval(id);
    };
  }, []);
  const pos = s.playing ? Math.min(s.duration, s.position + (now - at) / 1000) : s.position;
  const pct = s.duration ? (pos / s.duration) * 100 : 0;
  const tr = s.track;
  return (
    <div className="pip" onMouseDown={(e) => e.button === 0 && !(e.target as HTMLElement).closest("button") && getCurrentWindow().startDragging()}>
      <div className="pip-top">
        <button className="icon-btn" aria-label={t("openMain")} title={t("openMain")} onClick={() => api.focusMain()}>
          <I.IPip size={16} />
        </button>
        <button className="icon-btn" aria-label={t("close")} title={t("close")} onClick={() => getCurrentWindow().close()}>
          <I.IClose size={16} />
        </button>
      </div>
      <div className="pip-art">{tr && <Art src={tr.artwork} size={600} />}</div>
      <div className="pip-bar">
        <div className="pip-meta">
          <div className="name">{tr?.title ?? "—"}</div>
          <div className="sub">{tr?.artist ?? ""}</div>
        </div>
        <div className="pip-ctl">
          <button className="icon-btn" aria-label={t("previous")} title={t("previous")} onClick={() => sendCommand("previous")}>
            <I.IPrev size={18} />
          </button>
          <button className={cls("play-btn")} aria-label={s.playing ? t("pause") : t("play")} onClick={() => sendCommand("toggle")}>
            {s.playing ? <I.IPause size={18} /> : <I.IPlay size={18} />}
          </button>
          <button className="icon-btn" aria-label={t("next")} title={t("next")} onClick={() => sendCommand("next")}>
            <I.INext size={18} />
          </button>
        </div>
      </div>
      <div className="pip-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}
