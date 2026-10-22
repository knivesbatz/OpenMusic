import { lazy, Suspense, useEffect, useRef } from "react";
import { PlayerBar } from "./components/PlayerBar";
import { MobileTabs } from "./components/MobileTabs";
import { QueuePanel } from "./components/QueuePanel";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
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
import { isMobileApp, useApp } from "./store/app";
import { PANEL_W, SIDEBAR_W, useSettings } from "./store/settings";
import { navigate, useUi } from "./store/ui";
import { Home, LibraryPage, Search } from "./pages/Browse";
import { AlbumPage, ArtistPage, EpisodesPage, PlaylistPage, PodcastPage } from "./pages/Detail";
import { Login } from "./pages/Login";
import { cls } from "./util";

// Rarely used pages load on demand to keep startup light.
const Manage = () => import("./pages/Manage");
const LocalPage = lazy(() => Manage().then((m) => ({ default: m.LocalPage })));
const DownloadsPage = lazy(() => Manage().then((m) => ({ default: m.DownloadsPage })));
const ImportPage = lazy(() => Manage().then((m) => ({ default: m.ImportPage })));
const SettingsPage = lazy(() => Manage().then((m) => ({ default: m.SettingsPage })));
const Fullscreen = lazy(() => import("./components/Fullscreen").then((m) => ({ default: m.Fullscreen })));
const PhonePlayer = lazy(() => import("./components/PhonePlayer").then((m) => ({ default: m.PhonePlayer })));
const PhoneQueue = lazy(() => import("./components/PhonePlayer").then((m) => ({ default: m.PhoneQueue })));

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
    default:
      return <Home />;
  }
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export function App() {
  const t = useT();
  const info = useApp((s) => s.info);
  const auth = useApp((s) => s.auth);
  const localOnly = useApp((s) => s.localOnly);
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
        const level = el.scrollTop > 260 ? 2 : el.scrollTop > 48 ? 1 : 0;
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
      if (e.key === " " && !(e.target as HTMLElement).closest("button, [role=option], [role=row]")) {
        e.preventDefault();
        P.toggle();
      } else if (ctrl && e.key === "ArrowRight") P.next();
      else if (ctrl && e.key === "ArrowLeft") P.previous();
      else if (ctrl && e.key === "ArrowUp") (e.preventDefault(), useSettings.getState().set({ volume: Math.min(1, useSettings.getState().volume + 0.1) }));
      else if (ctrl && e.key === "ArrowDown") (e.preventDefault(), useSettings.getState().set({ volume: Math.max(0, useSettings.getState().volume - 0.1) }));
      else if (ctrl && e.key.toLowerCase() === "q") useUi.setState((s) => ({ queueOpen: !s.queueOpen }));
      else if (e.key === "F11") (e.preventDefault(), useUi.setState((s) => ({ fullscreen: !s.fullscreen })));
      else if (e.altKey && e.key === "ArrowLeft") useUi.setState((s) => ({ pos: Math.max(0, s.pos - 1) }));
      else if (e.altKey && e.key === "ArrowRight") useUi.setState((s) => ({ pos: Math.min(s.stack.length - 1, s.pos + 1) }));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  if (!info) return <Loading />;
  const needsLogin = !localOnly && (!auth?.signedIn || auth.needsServer);

  return (
    <div className={cls("app", htpc && "htpc")}>
      <a className="skip" href="#main">
        {t("skipToContent")}
      </a>
      {needsLogin ? (
        <Login />
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
                  <Page />
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
      {profilePicker && <ProfilePicker />}
      <ContextMenu />
      <SavedInPanel />
      <DialogHost />
      <InfoDialog />
      <UpdateBanner />
      <Toasts />
    </div>
  );
}
