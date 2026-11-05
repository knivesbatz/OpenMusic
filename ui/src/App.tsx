import { lazy, Suspense, useEffect, useRef, type ComponentType } from "react";
import { PlayerBar } from "./components/PlayerBar";
import { MobileTabs } from "./components/MobileTabs";
import { QueuePanel } from "./components/QueuePanel";
import { Sidebar } from "./components/Sidebar";
import { AccountDrawer, TopBar } from "./components/TopBar";
import { TitleBar, useTitleBar } from "./components/TitleBar";
import { TvNav } from "./components/TvNav";
import { ContextMenu, DialogHost, InfoDialog, Toasts } from "./components/Overlays";
import { SavedInPanel } from "./components/SavedIn";
import { LyricsPanel } from "./components/LyricsPanel";
import { Resizer } from "./components/Resizer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProfilePicker } from "./components/ProfilePicker";
import { UpdateBanner } from "./components/UpdateBanner";
import { Loading, usePhoneLayout } from "./components/common";
import { ScrollCtx } from "./components/TrackList";
import { useT } from "./i18n";
import * as P from "./player/engine";
import { isMobileApp, needsConnect, useApp } from "./store/app";
import { useConnectFlowActive } from "./store/signin";
import { PANEL_W, SIDEBAR_W, useSettings } from "./store/settings";
import { navigate, useUi } from "./store/ui";
import { BrowseCategoryPage, HistoryPage, Home, LibraryPage, Search, WhatsNewPage } from "./pages/Browse";
import { ProfileEditDialog, ProfilePage } from "./pages/Profile";
import { AlbumPage, ArtistPage, EpisodesPage, PlaylistPage, PodcastPage } from "./pages/Detail";
import { Connect } from "./pages/Login";
import { cls, spaceTogglesPlayback } from "./util";

// Rarely used pages load on demand to keep startup light.
const Manage = () => import("./pages/Manage");
const LocalPage = lazy(() => Manage().then((m) => ({ default: m.LocalPage })));
const DownloadsPage = lazy(() => Manage().then((m) => ({ default: m.DownloadsPage })));
const ImportPage = lazy(() => Manage().then((m) => ({ default: m.ImportPage })));
const SettingsPage = lazy(() => Manage().then((m) => ({ default: m.SettingsPage })));
const Fullscreen = lazy(() => import("./components/Fullscreen").then((m) => ({ default: m.Fullscreen })));
const PhonePlayer = lazy(() => import("./components/PhonePlayer").then((m) => ({ default: m.PhonePlayer })));
const PhoneQueue = lazy(() => import("./components/PhonePlayer").then((m) => ({ default: m.PhoneQueue })));
/** Liked Songs of every service that is on (`liked_tracks`), from pages/Detail.tsx. */
const LikedPage = lazy(() => import("./pages/Detail").then((m) => ({ default: (m as unknown as { LikedPage: ComponentType }).LikedPage })));

function Page() {
  const r = useUi((s) => s.stack[s.pos]);
  switch (r.name) {
    case "home":
      return <Home />;
    case "search":
      return <Search q={r.q ?? ""} />;
    case "library":
      return <LibraryPage key={r.tab ?? ""} tab={r.tab} />;
    case "artist":
      return <ArtistPage id={r.id} />;
    case "album":
      return <AlbumPage id={r.id} />;
    case "playlist":
      return r.id.startsWith("yt:MPSP") ? <PodcastPage id={r.id} /> : <PlaylistPage id={r.id} />;
    case "liked":
      return <LikedPage />;
    case "new":
      return <WhatsNewPage />;
    case "history":
      return <HistoryPage />;
    case "episodes":
      return <EpisodesPage />;
    case "local":
      return <LocalPage />;
    case "downloads":
      return <DownloadsPage />;
    case "import":
      return <ImportPage />;
    case "settings":
      return <SettingsPage />;
    case "profile":
      return <ProfilePage key={r.section ?? ""} section={r.section} />;
    case "browse":
      return <BrowseCategoryPage key={r.id} id={r.id} title={r.title} />;
    default:
      return <Home />;
  }
}

/** Buttons react to Space on key-up as well; swallow it there too. */
function onSpaceUp(e: KeyboardEvent) {
  if (spaceTogglesPlayback(e)) (e.preventDefault(), e.stopPropagation());
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export function App() {
  const t = useT();
  const info = useApp((s) => s.info);
  const ready = useApp((s) => s.ready);
  const noService = useApp(needsConnect);
  const connectFlow = useConnectFlowActive();
  const servicesEpoch = useApp((s) => s.servicesEpoch);
  const routeName = useUi((s) => s.stack[s.pos].name);
  const lyricsPanel = useUi((s) => s.lyricsPanel);
  const sideW = useSettings((s) => s.sidebarWidth);
  const panelW = useSettings((s) => s.panelWidth);
  const sideCollapsed = useSettings((s) => s.sidebarCollapsed);
  const queueOpen = useUi((s) => s.queueOpen);
  const fullscreen = useUi((s) => s.fullscreen);
  const pos = useUi((s) => s.pos);
  // TV mode is a desktop (HTPC) feature; the phone app never uses it.
  const htpc = useSettings((s) => s.htpc) && !isMobileApp();
  const profilePicker = useApp((s) => s.profilePicker);
  const phone = usePhoneLayout();
  const titleBar = useTitleBar();
  const scroll = useRef<HTMLElement>(null);

  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
    useUi.setState({ scrolled: 0 });
  }, [pos]);

  // Past the page header the top bar turns solid and shows the page's name (Spotify style).
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    let frame = 0;
    const on = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // On a phone the title (and the play button) move into the bar as the page's own play
        // button scrolls under it, like Spotify; elsewhere past a fixed height.
        const fab = phone ? el.querySelector<HTMLElement>(".detail .action-bar .fab") : null;
        const bar = document.documentElement.style.getPropertyValue("--topbar-h");
        const past = fab
          ? fab.getBoundingClientRect().top - el.getBoundingClientRect().top < (parseInt(bar) || 56) - 4
          : el.scrollTop > 260;
        const level = past ? 2 : el.scrollTop > 48 ? 1 : 0;
        if (level !== useUi.getState().scrolled) useUi.setState({ scrolled: level });
      });
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  });

  // TV mode: keep the focused card in view as the D-pad moves along a row or down the page.
  useEffect(() => {
    if (!htpc) return;
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest?.(".shelf-row, .shortcuts, .tv-hero")) return;
      const smooth = !useSettings.getState().reducedMotion;
      el.scrollIntoView({ block: "nearest", inline: "center", behavior: smooth ? "smooth" : "auto" });
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [htpc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "k") {
        e.preventDefault();
        navigate({ name: "search" });
        setTimeout(() => document.getElementById("global-search")?.focus());
        return;
      }
      if (isTyping(e)) return;
      if (ctrl && e.key === "ArrowRight") P.next();
      else if (ctrl && e.key === "ArrowLeft") P.previous();
      else if (ctrl && e.key === "ArrowUp") (e.preventDefault(), useSettings.getState().set({ volume: Math.min(1, useSettings.getState().volume + 0.1) }));
      else if (ctrl && e.key === "ArrowDown") (e.preventDefault(), useSettings.getState().set({ volume: Math.max(0, useSettings.getState().volume - 0.1) }));
      else if (ctrl && e.key.toLowerCase() === "q") useUi.setState((s) => ({ queueOpen: !s.queueOpen }));
      else if (e.key === "F11") (e.preventDefault(), useUi.setState((s) => ({ fullscreen: !s.fullscreen })));
      else if (e.altKey && e.key === "ArrowLeft") useUi.setState((s) => ({ pos: Math.max(0, s.pos - 1) }));
      else if (e.altKey && e.key === "ArrowRight") useUi.setState((s) => ({ pos: Math.min(s.stack.length - 1, s.pos + 1) }));
    };
    // Space plays/pauses and does nothing else: caught before any button, switch, row or menu
    // on the page sees it.
    const onSpace = (e: KeyboardEvent) => {
      if (!spaceTogglesPlayback(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) P.toggle();
    };
    addEventListener("keydown", onKey);
    addEventListener("keydown", onSpace, true);
    addEventListener("keyup", onSpaceUp, true);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("keydown", onSpace, true);
      removeEventListener("keyup", onSpaceUp, true);
    };
  }, []);

  if (!info || !ready) return <Loading />;
  // "Connect your music": nothing set up yet, or a sign-in started there is still going (the
  // Plex server list comes after Plex is signed in).
  const needsLogin = noService || connectFlow;

  return (
    <div className={cls("app", htpc && "htpc", titleBar && "titled")}>
      <a className="skip" href="#main">
        {t("skipToContent")}
      </a>
      {titleBar && !fullscreen && <TitleBar nav={!needsLogin && !htpc} />}
      {needsLogin ? (
        <Connect />
      ) : (
        <div
          className={cls("layout", (queueOpen || lyricsPanel) && !phone && "with-queue")}
          style={{ ["--side-w" as string]: `${sideW}px`, ["--panel-w" as string]: `${panelW}px` }}
        >
          {!htpc && <Sidebar />}
          {!htpc && !phone && !sideCollapsed && (
            <div className="side-resizer">
              <Resizer setting="sidebarWidth" range={SIDEBAR_W} def={300} edge="right" onCollapse={() => useSettings.getState().set({ sidebarCollapsed: true })} />
            </div>
          )}
          <main id="main" className="main" ref={scroll} tabIndex={-1}>
            {htpc ? <TvNav /> : <TopBar />}
            <ScrollCtx.Provider value={scroll}>
              <ErrorBoundary resetKey={pos}>
                <Suspense fallback={<Loading />}>
                  {/* A service switched on or off: the page loads again (Settings, where the
                      switches are, stays as it is). */}
                  <Page key={routeName === "settings" ? "settings" : servicesEpoch} />
                </Suspense>
              </ErrorBoundary>
            </ScrollCtx.Provider>
          </main>
          {queueOpen && !fullscreen && (phone ? <Suspense fallback={null}><PhoneQueue /></Suspense> : <QueuePanel />)}
          {lyricsPanel && !queueOpen && !fullscreen && !phone && <LyricsPanel />}
          {(queueOpen || lyricsPanel) && !fullscreen && !phone && (
            <div className="panel-resizer">
              <Resizer setting="panelWidth" range={PANEL_W} def={340} edge="left" />
            </div>
          )}
          <PlayerBar />
          <MobileTabs />
        </div>
      )}
      {fullscreen && (
        <div className="fullscreen-host">
          <ErrorBoundary onClose={() => useUi.setState({ fullscreen: false })}>
            <Suspense fallback={null}>{phone ? <PhonePlayer /> : <Fullscreen />}</Suspense>
          </ErrorBoundary>
        </div>
      )}
      {profilePicker && <ProfilePicker key={profilePicker} provider={profilePicker} />}
      <ProfileEditDialog />
      <AccountDrawer />
      <ContextMenu />
      <SavedInPanel />
      <DialogHost />
      <InfoDialog />
      <UpdateBanner />
      <Toasts />
    </div>
  );
}
