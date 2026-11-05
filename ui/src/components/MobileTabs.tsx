// Phone layout navigation (shown by CSS on narrow screens instead of the sidebar): Home, Search,
// Your Library and Create, like Spotify's app. Create opens a small panel above the tabs.
import { useEffect, useState } from "react";
import { createPlaylist, newFolder } from "../actions";
import { useT } from "../i18n";
import { navigate, useUi } from "../store/ui";
import { cls } from "../util";
import * as I from "./Icons";

export function MobileTabs() {
  const t = useT();
  const name = useUi((s) => s.stack[s.pos].name);
  const [create, setCreate] = useState(false);
  const tabs = [
    { route: "home" as const, label: t("home"), icon: (on: boolean) => (on ? <I.IHomeFill size={24} /> : <I.IHome size={24} />) },
    { route: "search" as const, label: t("search"), icon: () => <I.ISearch size={24} /> },
    { route: "library" as const, label: t("library"), icon: (on: boolean) => (on ? <I.ILibraryFill size={24} /> : <I.ILibrary size={24} />) },
  ];
  return (
    <>
      {create && <CreateSheet onClose={() => setCreate(false)} />}
      <nav className="mobile-tabs" aria-label="Main">
        {tabs.map((x) => {
          const on = name === x.route && !create;
          return (
            <button key={x.route} className={cls(on && "on")} aria-current={on ? "page" : undefined} onClick={() => (setCreate(false), navigate({ name: x.route }))}>
              {x.icon(on)}
              <span>{x.label}</span>
            </button>
          );
        })}
        <button className={cls("create-tab", create && "open")} aria-expanded={create} aria-haspopup="dialog" onClick={() => setCreate(!create)}>
          <span className="create-icon">{create ? <I.IClose size={20} /> : <I.IPlus size={24} />}</span>
          <span>{t("create")}</span>
        </button>
      </nav>
    </>
  );
}

/** Spotify's Create panel: what can be made in this app, each with a line on what it is. */
function CreateSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const rows = [
    {
      icon: <I.IMusic size={24} />,
      title: t("playlist"),
      sub: t("createPlaylistSub"),
      go: async () => {
        const pl = await createPlaylist();
        if (pl) navigate({ name: "playlist", id: pl.id });
      },
    },
    {
      icon: <I.IFolder size={24} />,
      title: t("folder"),
      sub: t("createFolderSub"),
      go: async () => {
        if (await newFolder()) navigate({ name: "library" });
      },
    },
    { icon: <I.IImport size={24} />, title: t("transferPlaylists"), sub: t("transferPlaylistsSub"), go: () => navigate({ name: "import" }) },
  ];
  return (
    <div className="create-bg" onClick={onClose}>
      <div className="create-panel" role="dialog" aria-label={t("create")} onClick={(e) => e.stopPropagation()}>
        {rows.map((r) => (
          <button
            key={r.title}
            className="create-row"
            onClick={() => {
              onClose();
              r.go();
            }}
          >
            <span className="create-row-icon">{r.icon}</span>
            <span className="create-row-text">
              <span className="t">{r.title}</span>
              <span className="s">{r.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
