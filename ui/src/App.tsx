import { lazy, Suspense, useEffect, useRef } from "react";
import { PlayerBar } from "./components/PlayerBar";
import { QueuePanel } from "./components/QueuePanel";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ContextMenu, DialogHost, InfoDialog, Toasts } from "./components/Overlays";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProfilePicker } from "./components/ProfilePicker";
import { Loading } from "./components/common";
import { ScrollCtx } from "./components/TrackList";
import { useT } from "./i18n";
import * as P from "./player/engine";
import { useApp } from "./store/app";
import { useSettings } from "./store/settings";
import { navigate, useUi } from "./store/ui";
import { Home, LibraryPage, Search } from "./pages/Browse";
import { AlbumPage, ArtistPage, PlaylistPage } from "./pages/Detail";
import { Login } from "./pages/Login";
import { cls } from "./util";

// Rarely used pages load on demand to keep startup light.
const Manage = () => import("./pages/Manage");
const LocalPage = lazy(() => Manage().then((m) => ({ default: m.LocalPage })));
const DownloadsPage = lazy(() => Manage().then((m) => ({ default: m.DownloadsPage })));
const ImportPage = lazy(() => Manage().then((m) => ({ default: m.ImportPage })));
const SettingsPage = lazy(() => Manage().then((m) => ({ default: m.SettingsPage })));
const Fullscreen = lazy(() => import("./components/Fullscreen").then((m) => ({ default: m.Fullscreen })));

function Page() {
  const r = useUi((s) => s.stack[s.pos]);
  switch (r.name) {
    case "home":
      return <Home />;
    case "search":
      return <Search q={r.q ?? ""} />;
    case "library":
      return <LibraryPage />;
    case "artist":
      return <ArtistPage id={r.id} />;
    case "album":
      return <AlbumPage id={r.id} />;
    case "playlist":
      return <PlaylistPage id={r.id} />;
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
  const queueOpen = useUi((s) => s.queueOpen);
  const fullscreen = useUi((s) => s.fullscreen);
  const pos = useUi((s) => s.pos);
  const htpc = useSettings((s) => s.htpc);
  const profilePicker = useApp((s) => s.profilePicker);
  const scroll = useRef<HTMLElement>(null);

  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
  }, [pos]);

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
        <div className={cls("layout", queueOpen && "with-queue")}>
          <Sidebar />
          <main id="main" className="main" ref={scroll} tabIndex={-1}>
            <TopBar />
            <ScrollCtx.Provider value={scroll}>
              <ErrorBoundary resetKey={pos}>
                <Suspense fallback={<Loading />}>
                  <Page />
                </Suspense>
              </ErrorBoundary>
            </ScrollCtx.Provider>
          </main>
          {queueOpen && !fullscreen && <QueuePanel />}
          <PlayerBar />
        </div>
      )}
      {fullscreen && (
        <div className="fullscreen-host">
          <ErrorBoundary onClose={() => useUi.setState({ fullscreen: false })}>
            <Suspense fallback={null}>
              <Fullscreen />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
      {profilePicker && <ProfilePicker />}
      <ContextMenu />
      <DialogHost />
      <InfoDialog />
      <Toasts />
    </div>
  );
}
