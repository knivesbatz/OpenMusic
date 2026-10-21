import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { openProfilePicker, useApp } from "../store/app";
import { back, forward, navigate, useUi } from "../store/ui";
import * as I from "./Icons";
import { cls } from "../util";

export function TopBar() {
  const t = useT();
  const pos = useUi((s) => s.pos);
  const len = useUi((s) => s.stack.length);
  const cur = useUi((s) => s.stack[s.pos]);
  const online = useApp((s) => s.online);
  const auth = useApp((s) => s.auth);
  const flavor = useApp((s) => s.info?.flavor);
  const input = useRef<HTMLInputElement>(null);
  const q = cur.name === "search" ? cur.q ?? "" : "";

  useEffect(() => {
    if (cur.name === "search") input.current?.focus();
  }, [cur.name]);

  const scrolled = useUi((s) => s.scrolled);
  const pageTitle = useUi((s) => s.pageTitle);
  const showTitle = scrolled === 2 && pageTitle && cur.name !== "search";

  return (
    <header className={cls("topbar", scrolled > 0 && "solid")}>
      <div className="row gap">
        <button className="round-btn" aria-label={t("back")} title={t("back")} disabled={pos === 0} onClick={back}>
          <I.IBack size={18} />
        </button>
        <button className="round-btn" aria-label={t("forward")} title={t("forward")} disabled={pos >= len - 1} onClick={forward}>
          <I.IForward size={18} />
        </button>
        {showTitle && (
          <div className="topbar-title">
            {pageTitle.play && (
              <button className="play-btn" aria-label={t("play")} onClick={pageTitle.play}>
                <I.IPlay size={16} />
              </button>
            )}
            <span>{pageTitle.title}</span>
          </div>
        )}
      </div>
      <div className="search-box">
        <button className="round-btn home" aria-label={t("home")} title={t("home")} onClick={() => navigate({ name: "home" })}>
          <I.IHome size={20} />
        </button>
        <label className="search-input">
          <I.ISearch size={18} />
          <input
            ref={input}
            id="global-search"
            type="search"
            placeholder={t("searchPlaceholder")}
            aria-label={t("search")}
            value={q}
            onFocus={() => cur.name !== "search" && navigate({ name: "search", q })}
            onChange={(e) => navigate({ name: "search", q: e.target.value }, cur.name === "search")}
          />
          {q && (
            <button className="icon-btn" aria-label={t("clear")} onClick={() => navigate({ name: "search", q: "" }, true)}>
              <I.IClose size={16} />
            </button>
          )}
        </label>
      </div>
      <div className="row gap">
        {!online && <span className="offline-pill" role="status">{t("offlineShort")}</span>}
        {auth?.account &&
          (flavor ? (
            <button className="link small account" title={t("switchProfile")} onClick={openProfilePicker}>
              {auth.account}
            </button>
          ) : (
            <span className="muted small account">{auth.account}</span>
          ))}
        <button className="round-btn import-btn" aria-label={t("transferPlaylists")} title={t("transferPlaylists")} onClick={() => navigate({ name: "import" })}>
          <I.IImport size={18} />
        </button>
        <button className="round-btn" aria-label={t("settings")} title={t("settings")} onClick={() => navigate({ name: "settings" })}>
          <I.ISettings size={18} />
        </button>
      </div>
    </header>
  );
}
