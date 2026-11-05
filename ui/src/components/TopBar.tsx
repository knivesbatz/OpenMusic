import { Fragment, useEffect, useRef } from "react";
import { createPlaylist, openAccount, signedInTo, signOutOf } from "../actions";
import { artUrl } from "../api";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { usePlayer } from "../player/engine";
import { openProfilePicker, useApp } from "../store/app";
import { loadProfile, openExternal, SUPPORT_URL, useMe } from "../store/profile";
import { isOn } from "../store/providers";
import { useSettings } from "../store/settings";
import { back, forward, navigate, openMenu, useUi, type MenuItem } from "../store/ui";
import * as I from "./Icons";
import { Art, useCaps, usePhoneLayout, useProvidersKey } from "./common";
import { useTitleBar } from "./TitleBar";
import { cls, serviceLabel } from "../util";
import { PROVIDERS, type Provider } from "../types";

/** The offline pill: every service that is on is unreachable (one of two down shows notes on the
 * pages instead). */
function useAllOffline(): boolean {
  return useApp((s) => {
    const on = PROVIDERS.filter((p) => s.services?.[p]);
    return on.length > 0 && on.every((p) => s.online?.[p] === false);
  });
}

/** Services you're signed in to with their switch on: the avatar menu's account items. */
const accounts = (): Provider[] => PROVIDERS.filter((p) => isOn(p) && signedInTo(p));

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
  const offline = useAllOffline();
  const titleBar = useTitleBar();

  const scrolled = useUi((s) => s.scrolled);
  const pageTitle = useUi((s) => s.pageTitle);
  const showTitle = scrolled === 2 && pageTitle && cur.name !== "search";
  const phone = usePhoneLayout();
  const bar = useBarHeight();
  const caps = useCaps();
  const homeFilter = useUi((s) => s.homeFilter);
  const playingHere = usePlayer((s) => s.playing && !!pageTitle?.ctxId && s.context?.id === pageTitle.ctxId);

  // Phone (Spotify mobile). Home: your picture and the All / Music / Podcasts chips in one row.
  // Your Library: picture, "Your Library", search and +. Search: picture and "Search" over a
  // white search field. Other pages: a back button and, once scrolled, their title.
  if (phone) {
    if (cur.name === "home") {
      return (
        <header ref={bar} className={cls("topbar phone-bar", scrolled > 0 && "solid")}>
          <AvatarButton phone />
          {caps.podcasts && (
            <div className="chips phone-chips">
              {(["all", "music", "podcasts"] as const).map((f) => (
                <button key={f} className={cls("chip", homeFilter === f && "on")} aria-pressed={homeFilter === f} onClick={() => useUi.setState({ homeFilter: f })}>
                  {t(f)}
                </button>
              ))}
            </div>
          )}
          <span className="grow" />
          {offline && <span className="offline-pill" role="status">{t("offlineShort")}</span>}
        </header>
      );
    }
    if (cur.name === "library") {
      return (
        <header ref={bar} className={cls("topbar phone-bar", scrolled > 0 && "solid")}>
          <AvatarButton phone />
          <h1 className="phone-h1">{t("library")}</h1>
          <span className="grow" />
          {offline && <span className="offline-pill" role="status">{t("offlineShort")}</span>}
          <button className="icon-btn" aria-label={t("search")} title={t("search")} onClick={() => navigate({ name: "search" })}>
            <I.ISearch size={24} />
          </button>
          <button
            className="icon-btn"
            aria-label={t("createPlaylist")}
            title={t("createPlaylist")}
            onClick={async () => {
              const pl = await createPlaylist();
              if (pl) navigate({ name: "playlist", id: pl.id });
            }}
          >
            <I.IPlus size={26} />
          </button>
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
        {offline ? <span className="offline-pill" role="status">{t("offlineShort")}</span> : <span className="bar-spacer" />}
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
  const offline = useAllOffline();
  return (
    <>
      {offline && <span className="offline-pill" role="status">{t("offlineShort")}</span>}
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
  const services = useProvidersKey();
  const account = useApp((s) => PROVIDERS.map((p) => s.auth?.[p]?.account ?? "").join("\u001f"));
  const me = useMe();
  // The profile follows the accounts: YouTube's channel when YouTube is on with an account,
  // otherwise the Plex account.
  useEffect(() => {
    if (accounts().length) loadProfile(true);
  }, [services, account]);
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
        openMenu({ clientX: r.right, clientY: r.bottom + 8, preventDefault: () => {}, stopPropagation: () => e.stopPropagation() }, accountMenu(t, accounts()));
      }}
    >
      {me.photo ? <Art src={me.photo} size={96} round /> : initial}
    </button>
  );
}

/** Spotify's account menu. With one account (YouTube Music or Plex) it reads as before: Account,
 * Switch profile and Log out are that service's. With both, Account and Switch profile open a
 * submenu per service, and "Services…" (Settings) takes the place of Log out. */
function accountMenu(t: ReturnType<typeof useT>, accts: Provider[]): MenuItem[] {
  const priv = useSettings.getState().privateSession;
  const items: MenuItem[] = [];
  const one = accts.length === 1 ? accts[0] : null;
  const perService = (fn: (p: Provider) => void, external?: boolean): MenuItem[] => accts.map((p) => ({ label: serviceLabel(p), external, onClick: () => fn(p) }));
  if (one) items.push({ label: t("account"), external: true, onClick: () => openAccount(one) });
  else if (accts.length) items.push({ label: t("account"), submenu: perService(openAccount, true) });
  items.push({ label: t("profile"), onClick: () => navigate({ name: "profile" }) });
  if (one) items.push({ label: t("switchProfile"), onClick: () => openProfilePicker(one) });
  else if (accts.length) items.push({ label: t("switchProfile"), submenu: perService(openProfilePicker) });
  items.push({ label: t("recents"), onClick: () => navigate({ name: "library", tab: "recent" }) });
  items.push({ label: t("transferPlaylists"), onClick: () => navigate({ name: "import" }) });
  items.push({ label: t("support"), external: true, onClick: () => openExternal(SUPPORT_URL) });
  items.push({ label: t("privateSession"), checked: priv, onClick: () => useSettings.getState().set({ privateSession: !priv }) });
  items.push({ label: t("settings"), onClick: () => navigate({ name: "settings" }) });
  items.push({ label: "", separator: true });
  // Signing in happens in Settings → Services (one card per service).
  if (one) items.push({ label: t("logOut"), onClick: () => signOutOf(one) });
  else if (accts.length) items.push({ label: t("menuServices"), onClick: () => navigate({ name: "settings" }) });
  else items.push({ label: t("signIn"), onClick: () => navigate({ name: "settings" }) });
  return items;
}

/** Phones: the drawer that slides in from the left when you tap your picture (Spotify mobile):
 * your name and "View profile" at the top, then the account items. */
export function AccountDrawer() {
  const t = useT();
  const open = useUi((s) => s.drawer);
  useProvidersKey();
  const accts = accounts();
  const one = accts.length === 1 ? accts[0] : null;
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
          {one && row(<I.IUser size={24} />, t("switchProfile"), go(() => openProfilePicker(one)))}
          {!one && accts.map((p) => <Fragment key={p}>{row(<I.IUser size={24} />, t("switchProfileOf", { service: serviceLabel(p) }), go(() => openProfilePicker(p)))}</Fragment>)}
          {row(<I.IImport size={24} />, t("transferPlaylists"), go(() => navigate({ name: "import" })))}
          {row(<I.ILock size={24} />, t("privateSession"), () => useSettings.getState().set({ privateSession: !priv }), <span className={cls("drawer-switch", priv && "on")} aria-hidden="true" />)}
          {row(<I.ISettings size={24} />, t("settingsAndPrivacy"), go(() => navigate({ name: "settings" })))}
          {one && row(<I.IOpen size={24} />, t("account"), go(() => openAccount(one)))}
          {!one && accts.map((p) => <Fragment key={p}>{row(<I.IOpen size={24} />, t("accountOf", { service: serviceLabel(p) }), go(() => openAccount(p)))}</Fragment>)}
          {row(<I.IInfo size={24} />, t("support"), go(() => openExternal(SUPPORT_URL)))}
          {one
            ? row(<I.IBack size={24} />, t("logOut"), go(() => signOutOf(one)))
            : accts.length
              ? row(<I.ISettings size={24} />, t("menuServices"), go(() => navigate({ name: "settings" })))
              : row(<I.IUser size={24} />, t("signIn"), go(() => navigate({ name: "settings" })))}
        </div>
      </nav>
    </div>
  );
}
