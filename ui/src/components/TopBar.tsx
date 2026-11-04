import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { openProfilePicker, setLocalOnly, useApp } from "../store/app";
import { accountUrl, loadProfile, openExternal, signOut, SUPPORT_URL, useMe } from "../store/profile";
import { useSettings } from "../store/settings";
import { back, forward, navigate, openMenu, useUi, type MenuItem } from "../store/ui";
import * as I from "./Icons";
import { Art, usePhoneLayout } from "./common";
import { useTitleBar } from "./TitleBar";
import { cls } from "../util";

/** Keeps `--topbar-h` at the bar's real height: sticky headers below it (a track list's column
 * header) stick right under it, whatever the bar holds (title bar mode, phones, the avatar). */
function useBarHeight() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--topbar-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return ref;
}

export function TopBar() {
  const t = useT();
  const pos = useUi((s) => s.pos);
  const len = useUi((s) => s.stack.length);
  const cur = useUi((s) => s.stack[s.pos]);
  const online = useApp((s) => s.online);
  const titleBar = useTitleBar();

  const scrolled = useUi((s) => s.scrolled);
  const pageTitle = useUi((s) => s.pageTitle);
  const showTitle = scrolled === 2 && pageTitle && cur.name !== "search";
  const phone = usePhoneLayout();
  const bar = useBarHeight();

  // Phone (Spotify mobile): no search field outside Search. Home and Your Library show the
  // your picture (account menu); other pages a back button and, once scrolled, their title.
  if (phone && cur.name !== "search") {
    const root = cur.name === "home" || cur.name === "library";
    return (
      <header ref={bar} className={cls("topbar phone-bar", scrolled > 0 && "solid")}>
        {root ? (
          <AvatarButton phone />
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
  if (titleBar) return <header ref={bar} className={cls("topbar slim", scrolled > 0 && "solid")}>{title}</header>;

  return (
    <header ref={bar} className={cls("topbar", scrolled > 0 && "solid")}>
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
        <span className="search-sep" aria-hidden="true" />
        <button
          className={cls("icon-btn browse-btn", cur.name === "search" && !q && "on")}
          aria-label={t("browse")}
          title={t("browse")}
          onClick={(e) => {
            e.preventDefault();
            navigate({ name: "search", q: "" }, cur.name === "search");
          }}
        >
          <I.IBrowse size={22} />
        </button>
      </label>
    </div>
  );
}

/** Offline badge, What's New and your profile picture (its menu has the rest). */
export function DesktopActions() {
  const t = useT();
  const cur = useUi((s) => s.stack[s.pos]);
  const online = useApp((s) => s.online);
  return (
    <>
      {!online && <span className="offline-pill" role="status">{t("offlineShort")}</span>}
      <button className={cls("icon-btn tb-icon", cur.name === "new" && "on")} aria-label={t("whatsNew")} title={t("whatsNew")} onClick={() => navigate({ name: "new" })}>
        <I.IBell size={20} />
      </button>
      <AvatarButton />
    </>
  );
}

/** Your profile picture (or initial). Opens Spotify's account menu. */
export function AvatarButton({ phone }: { phone?: boolean }) {
  const t = useT();
  const signedIn = useApp((s) => !!s.auth?.signedIn);
  const account = useApp((s) => s.auth?.account);
  const me = useMe();
  useEffect(() => {
    if (signedIn) loadProfile(true);
  }, [signedIn, account]);
  const initial = me.name.trim().slice(0, 1).toUpperCase() || "♪";
  return (
    <button
      className={cls("avatar-btn", !phone && "desk")}
      aria-label={me.name || t("profile")}
      title={me.name || t("profile")}
      aria-haspopup="menu"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu({ clientX: phone ? r.left : r.right, clientY: r.bottom + 8, preventDefault: () => {}, stopPropagation: () => e.stopPropagation() }, accountMenu(t, signedIn));
      }}
    >
      {me.photo ? <Art src={me.photo} size={96} round /> : initial}
    </button>
  );
}

function accountMenu(t: ReturnType<typeof useT>, signedIn: boolean): MenuItem[] {
  const priv = useSettings.getState().privateSession;
  const items: MenuItem[] = [];
  if (signedIn) items.push({ label: t("account"), external: true, onClick: () => openExternal(accountUrl()) });
  items.push({ label: t("profile"), onClick: () => navigate({ name: "profile" }) });
  if (signedIn) items.push({ label: t("switchProfile"), onClick: openProfilePicker });
  items.push({ label: t("recents"), onClick: () => navigate({ name: "library", tab: "recent" }) });
  items.push({ label: t("transferPlaylists"), onClick: () => navigate({ name: "import" }) });
  items.push({ label: t("support"), external: true, onClick: () => openExternal(SUPPORT_URL) });
  items.push({ label: t("privateSession"), checked: priv, onClick: () => useSettings.getState().set({ privateSession: !priv }) });
  items.push({ label: t("settings"), onClick: () => navigate({ name: "settings" }) });
  items.push({ label: "", separator: true });
  items.push(signedIn ? { label: t("logOut"), onClick: signOut } : { label: t("signIn"), onClick: () => setLocalOnly(false) });
  return items;
}
