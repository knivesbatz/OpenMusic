import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "../api";
import { useT } from "../i18n";
import { isMobileApp, useApp } from "../store/app";
import { back, forward, navigate, openMenu, toast, useUi } from "../store/ui";
import * as I from "./Icons";
import { DesktopActions, SearchField } from "./TopBar";

/** Windows draws no system title bar (the main window is undecorated there); this one replaces it. */
export const useTitleBar = () => useApp((s) => inTauri && !isMobileApp() && s.info?.platform === "windows");

/** Spotify-style title bar: app menu and history on the left, Home and search in the middle,
 *  actions and the window buttons on the right. Empty space drags the window; double-click maximizes. */
export function TitleBar({ nav }: { nav: boolean }) {
  const t = useT();
  const pos = useUi((s) => s.pos);
  const len = useUi((s) => s.stack.length);
  const name = useApp((s) => s.info?.name);
  return (
    <header className="titlebar" data-tauri-drag-region>
      {/* The window's name, shown only by the Windows 95 theme (as a classic caption). */}
      <span className="tb-name" data-tauri-drag-region>
        {name}
      </span>
      {nav && (
        <div className="tb-side" data-tauri-drag-region>
          <button className="tb-btn" aria-label={t("menu")} title={t("menu")} onClick={(e) => openMenu(e, appMenu(t))}>
            <I.IMore size={20} />
          </button>
          <button className="tb-btn" aria-label={t("back")} title={t("back")} disabled={pos === 0} onClick={back}>
            <I.IBack size={18} />
          </button>
          <button className="tb-btn" aria-label={t("forward")} title={t("forward")} disabled={pos >= len - 1} onClick={forward}>
            <I.IForward size={18} />
          </button>
        </div>
      )}
      {nav && <SearchField />}
      <div className="tb-side right" data-tauri-drag-region>
        {nav && <DesktopActions />}
        <WindowButtons />
      </div>
    </header>
  );
}

function appMenu(t: ReturnType<typeof useT>) {
  return [
    { label: t("whatsNew"), icon: I.IBell, onClick: () => navigate({ name: "new" }) },
    { label: t("transferPlaylists"), icon: I.IImport, onClick: () => navigate({ name: "import" }) },
    { label: t("settings"), icon: I.ISettings, onClick: () => navigate({ name: "settings" }) },
    { label: "", separator: true },
    { label: t("keyboardShortcuts"), icon: I.IInfo, onClick: () => toast(t("shortcuts")) },
  ];
}

function WindowButtons() {
  const t = useT();
  const [max, setMax] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    const sync = () => void w.isMaximized().then(setMax).catch(() => {});
    sync();
    const un = w.onResized(sync);
    return () => void un.then((f) => f());
  }, []);
  const w = () => getCurrentWindow();
  return (
    <div className="win-btns">
      <button className="win-btn" aria-label={t("minimize")} title={t("minimize")} onClick={() => w().minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" /></svg>
      </button>
      <button className="win-btn" aria-label={max ? t("restore") : t("maximize")} title={max ? t("restore") : t("maximize")} onClick={() => w().toggleMaximize()}>
        {max ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor">
            <path d="M2.5 2.5V.5h7v7h-2" /><rect x=".5" y="2.5" width="7" height="7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor"><rect x=".5" y=".5" width="9" height="9" /></svg>
        )}
      </button>
      <button className="win-btn close" aria-label={t("close")} title={t("close")} onClick={() => w().close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" /></svg>
      </button>
    </div>
  );
}
