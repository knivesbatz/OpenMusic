import { useEffect, useRef } from "react";
import { createPlaylist } from "../actions";
import { artUrl } from "../api";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
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
  const caps = useApp((s) => s.info?.capabilities);
  const homeFilter = useUi((s) => s.homeFilter);
  const classicLibrary = useSettings((s) => s.classicLibrary);
  const playingHere = usePlayer((s) => s.playing && !!pageTitle?.ctxId && s.context?.id === pageTitle.ctxId);

  // Phone (Spotify mobile). Home: your picture and the All / Music / Podcasts chips in one row.
  // Your Library: picture, "Your Library", search and +. Search: picture and "Search" over a
  // white search field. Other pages: a back button and, once scrolled, their title.
  if (phone) {
    if (cur.name === "home") {
      return (
        <header ref={bar} className={cls("topbar phone-bar", scrolled > 0 && "solid")}>
          <AvatarButton phone />
          {caps?.podcasts && (
            <div className="chips phone-chips">
              {(["all", "music", "podcasts"] as const).map((f) => (
                <button key={f} className={cls("chip", homeFilter === f && "on")} aria-pressed={homeFilter === f} onClick={() => useUi.setState({ homeFilter: f })}>
                  {t(f)}
                </button>
              ))}
            </div>
          )}
          <span className="grow" />
          {!online && <span className="offline-pill" role="status">{t("offlineShort")}</span>}
        </header>
      );
    }
    if (cur.name === "library") {
      // The classic library shows its own big "Music  Podcasts" heading and a Create playlist row.
      return (
        <header ref={bar} className={cls("topbar phone-bar", scrolled > 0 && "solid")}>
          <AvatarButton phone />
          {!classicLibrary && <h1 className="phone-h1">{t("library")}</h1>}
          <span className="grow" />
          {!online && <span className="offline-pill" role="status">{t("offlineShort")}</span>}
          <button className="icon-btn" aria-label={t("search")} title={t("search")} onClick={() => navigate({ name: "search" })}>
            <I.ISearch size={24} />
          </button>
          {!classicLibrary && <button
            className="icon-btn"
            aria-label={t("createPlaylist")}
            title={t("createPlaylist")}
            onClick={async () => {
              const pl = await createPlaylist();
              if (pl) navigate({ name: "playlist", id: pl.id });
            }}
          >
            <I.IPlus size={26} />
          </button>}
        </header>
      );
    }
    if (cur.name === "search") {
      return (
        <header ref={bar} className={cls("topbar phone-search", scrolled > 0 && "solid")}>
          {!(cur.q ?? "") && (
            <div className="phone-search-head">
              <AvatarButton phone />
              <h1 className="phone-h1">{t("search")}</h1>
            </div>
          )}
          <PhoneSearchField />
        </header>
      );
    }
    // Spotify's pinned bar: once the page's play button reaches it, the bar takes the cover's
    // colour, shows the name centred, and the green play button docks on its lower edge.
    const wash = showTitle ? artUrl(pageTitle.art, 60) : null;
    return (
      <header
        ref={bar}
        className={cls("topbar phone-bar detail-bar", scrolled > 0 && "solid", showTitle && "pinned", wash && "tinted")}
        style={wash ? ({ ["--bar-wash" as string]: `url("${wash}")` } as React.CSSProperties) : undefined}
      >
        <button className="round-btn" aria-label={t("back")} title={t("back")} disabled={pos === 0} onClick={back}>
          <I.IBack size={18} />
        </button>
        <span className="phone-title">{showTitle ? pageTitle.title : ""}</span>
        {!online ? <span className="offline-pill" role="status">{t("offlineShort")}</span> : <span className="bar-spacer" />}
        {showTitle && pageTitle.play && (
          <button className="fab bar-fab" aria-label={playingHere ? t("pause") : t("play")} onClick={playingHere ? P.pause : pageTitle.play}>
            {playingHere ? <I.IPause size={22} /> : <I.IPlay size={22} />}
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

/** Phones: Spotify's white search field ("What do you want to listen to?"). */
function PhoneSearchField() {
  const t = useT();
  const cur = useUi((s) => s.stack[s.pos]);
  const q = cur.name === "search" ? cur.q ?? "" : "";
  return (
    <label className="phone-search-field">
      <I.ISearch size={22} />
      <input
        id="global-search"
        type="search"
        placeholder={t("searchPlaceholderPhone")}
        aria-label={t("search")}
        value={q}
        onChange={(e) => navigate({ name: "search", q: e.target.value }, true)}
      />
      {q && (
        <button className="icon-btn" aria-label={t("clear")} onClick={() => navigate({ name: "search", q: "" }, true)}>
          <I.IClose size={18} />
        </button>
      )}
    </label>
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
        // Phones: Spotify's side drawer. Desktop: the account menu under the picture.
        if (phone) return useUi.setState({ drawer: true });
        const r = e.currentTarget.getBoundingClientRect();
        openMenu({ clientX: r.right, clientY: r.bottom + 8, preventDefault: () => {}, stopPropagation: () => e.stopPropagation() }, accountMenu(t, signedIn));
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

/** Phones: the drawer that slides in from the left when you tap your picture (Spotify mobile):
 * your name and "View profile" at the top, then the account items. */
export function AccountDrawer() {
  const t = useT();
  const open = useUi((s) => s.drawer);
  const signedIn = useApp((s) => !!s.auth?.signedIn);
  const priv = useSettings((s) => s.privateSession);
  const me = useMe();
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && useUi.setState({ drawer: false });
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [open]);
  if (!open) return null;
  const close = () => useUi.setState({ drawer: false });
  const go = (fn: () => void) => () => (close(), fn());
  const initial = me.name.trim().slice(0, 1).toUpperCase() || "♪";
  const row = (icon: React.ReactNode, label: string, onClick: () => void, extra?: React.ReactNode) => (
    <button className="drawer-item" onClick={onClick}>
      <span className="drawer-icon">{icon}</span>
      <span className="grow">{label}</span>
      {extra}
    </button>
  );
  return (
    <div className="drawer-bg" onClick={(e) => e.target === e.currentTarget && close()}>
      <nav className="drawer" aria-label={t("profile")}>
        <button className="drawer-me" onClick={go(() => navigate({ name: "profile" }))}>
          <span className="avatar-btn big">{me.photo ? <Art src={me.photo} size={128} round /> : initial}</span>
          <span className="drawer-me-text">
            <strong>{me.name || t("profile")}</strong>
            <span className="muted small">{t("viewProfile")}</span>
          </span>
        </button>
        <div className="drawer-items">
          {row(<I.IBell size={24} />, t("whatsNew"), go(() => navigate({ name: "new" })))}
          {row(<I.IClock size={24} />, t("recents"), go(() => navigate({ name: "library", tab: "recent" })))}
          {row(<I.IHistory size={24} />, t("listeningHistory"), go(() => navigate({ name: "history" })))}
          {signedIn && row(<I.IUser size={24} />, t("switchProfile"), go(openProfilePicker))}
          {row(<I.IImport size={24} />, t("transferPlaylists"), go(() => navigate({ name: "import" })))}
          {row(<I.ILock size={24} />, t("privateSession"), () => useSettings.getState().set({ privateSession: !priv }), <span className={cls("drawer-switch", priv && "on")} aria-hidden="true" />)}
          {row(<I.ISettings size={24} />, t("settingsAndPrivacy"), go(() => navigate({ name: "settings" })))}
          {signedIn && row(<I.IOpen size={24} />, t("account"), go(() => openExternal(accountUrl())))}
          {row(<I.IInfo size={24} />, t("support"), go(() => openExternal(SUPPORT_URL)))}
          {signedIn ? row(<I.IBack size={24} />, t("logOut"), go(signOut)) : row(<I.IUser size={24} />, t("signIn"), go(() => setLocalOnly(false)))}
        </div>
      </nav>
    </div>
  );
}
