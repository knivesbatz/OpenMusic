import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { openProfilePicker, useApp } from "../store/app";
import { back, forward, navigate, useUi } from "../store/ui";
import * as I from "./Icons";
import { usePhoneLayout } from "./common";
import { useTitleBar } from "./TitleBar";
import { cls } from "../util";

export function TopBar() {
  const t = useT();
  const pos = useUi((s) => s.pos);
  const len = useUi((s) => s.stack.length);
  const cur = useUi((s) => s.stack[s.pos]);
  const online = useApp((s) => s.online);
  const auth = useApp((s) => s.auth);
  const titleBar = useTitleBar();

  const scrolled = useUi((s) => s.scrolled);
  const pageTitle = useUi((s) => s.pageTitle);
  const showTitle = scrolled === 2 && pageTitle && cur.name !== "search";
  const phone = usePhoneLayout();

  // Phone (Spotify mobile): no search field outside Search. Home and Your Library show the
  // account button (opens Settings); other pages a back button and, once scrolled, their title.
  if (phone && cur.name !== "search") {
    const root = cur.name === "home" || cur.name === "library";
    const initial = (auth?.account ?? "").trim().slice(0, 1).toUpperCase() || "♪";
    return (
      <header className={cls("topbar phone-bar", scrolled > 0 && "solid")}>
        {root ? (
          <button className="avatar-btn" aria-label={t("settings")} title={t("settings")} onClick={() => navigate({ name: "settings" })}>
            {initial}
          </button>
        ) : (
          <button className="round-btn" aria-label={t("back")} title={t("back")} disabled={pos === 0} onClick={back}>
            <I.IBack size={18} />
          </button>
        )}
        {showTitle && <span className="phone-title">{pageTitle.title}</span>}
        <span className="grow" />
        {!online && <span className="offline-pill" role="status">{t("offlineShort")}</span>}
        {cur.name === "home" && (
          <button className="icon-btn" aria-label={t("whatsNew")} title={t("whatsNew")} onClick={() => navigate({ name: "new" })}>
            <I.IBell size={22} />
          </button>
        )}
        {cur.name === "library" && (
          <button className="icon-btn" aria-label={t("search")} title={t("search")} onClick={() => navigate({ name: "search" })}>
            <I.ISearch size={22} />
          </button>
        )}
      </header>
    );
  }

  const title = showTitle && (
    <div className="topbar-title">
      {pageTitle.play && (
        <button className="play-btn" aria-label={t("play")} onClick={pageTitle.play}>
          <I.IPlay size={16} />
        </button>
      )}
      <span>{pageTitle.title}</span>
    </div>
  );

  // Windows: navigation, search and actions live in the title bar; this bar only shows the page title.
  if (titleBar) return <header className={cls("topbar slim", scrolled > 0 && "solid")}>{title}</header>;

  return (
    <header className={cls("topbar", scrolled > 0 && "solid")}>
      <div className="row gap">
        <button className="round-btn" aria-label={t("back")} title={t("back")} disabled={pos === 0} onClick={back}>
          <I.IBack size={18} />
        </button>
        <button className="round-btn" aria-label={t("forward")} title={t("forward")} disabled={pos >= len - 1} onClick={forward}>
          <I.IForward size={18} />
        </button>
        {title}
      </div>
      <SearchField />
      <div className="row gap">
        <DesktopActions />
      </div>
    </header>
  );
}

/** Home button and the search field (Ctrl+K focuses `#global-search`). */
export function SearchField() {
  const t = useT();
  const cur = useUi((s) => s.stack[s.pos]);
  const input = useRef<HTMLInputElement>(null);
  const q = cur.name === "search" ? cur.q ?? "" : "";

  useEffect(() => {
    if (cur.name === "search") input.current?.focus();
  }, [cur.name]);

  return (
    <div className="search-box">
      <button className={cls("round-btn home", cur.name === "home" && "on")} aria-label={t("home")} title={t("home")} onClick={() => navigate({ name: "home" })}>
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
  );
}

/** Offline badge, account (switch profile), What's New, transfer playlists and settings. */
export function DesktopActions() {
  const t = useT();
  const cur = useUi((s) => s.stack[s.pos]);
  const online = useApp((s) => s.online);
  const auth = useApp((s) => s.auth);
  const flavor = useApp((s) => s.info?.flavor);
  return (
    <>
      {!online && <span className="offline-pill" role="status">{t("offlineShort")}</span>}
      {auth?.account &&
        (flavor ? (
          <button className="link small account" title={t("switchProfile")} onClick={openProfilePicker}>
            {auth.account}
          </button>
        ) : (
          <span className="muted small account">{auth.account}</span>
        ))}
      <button className={cls("round-btn", cur.name === "new" && "on")} aria-label={t("whatsNew")} title={t("whatsNew")} onClick={() => navigate({ name: "new" })}>
        <I.IBell size={18} />
      </button>
      <button className="round-btn import-btn" aria-label={t("transferPlaylists")} title={t("transferPlaylists")} onClick={() => navigate({ name: "import" })}>
        <I.IImport size={18} />
      </button>
      <button className="round-btn" aria-label={t("settings")} title={t("settings")} onClick={() => navigate({ name: "settings" })}>
        <I.ISettings size={18} />
      </button>
    </>
  );
}
