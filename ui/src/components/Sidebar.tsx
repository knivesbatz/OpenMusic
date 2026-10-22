import { useMemo, useState } from "react";
import { createPlaylist, folderMenu, newFolder, playlistMenu } from "../actions";
import { api } from "../api";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { useApp } from "../store/app";
import { arrange, folderKey, moveEntry, putInFolder, setSort, toggleFolder, useFolders, type Folder } from "../store/folders";
import { useSettings } from "../store/settings";
import { navigate, openMenu, useUi, type Route } from "../store/ui";
import type { Playlist } from "../types";
import { cls, isTouch } from "../util";
import { Art } from "./common";
import * as I from "./Icons";

type Entry = { k: "playlist"; v: Playlist; depth?: number; folderId?: string } | { k: "folder"; v: Folder };
type Category = { key: string; label: string; route: Route; icon: React.ReactNode };

/** A provider's own "liked songs" playlist (YouTube Music's LM), shown as the Liked Songs category. */
const isLikedPlaylist = (p: Playlist) => /^yt:(VL)?LM$/.test(p.id);

export function Sidebar() {
  const t = useT();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const setSettings = useSettings((s) => s.set);
  const lib = useApp((s) => s.library);
  const appPls = useApp((s) => s.playlists);
  const caps = useApp((s) => s.info?.capabilities);
  const cur = useUi((s) => s.stack[s.pos]);
  const org = useFolders();
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; mode: "before" | "after" | "into" } | null>(null);

  const allPlaylists = useMemo(() => {
    const seen = new Set<string>();
    return [...appPls, ...(lib?.playlists ?? [])].filter((p) => !seen.has(p.id) && (seen.add(p.id), true));
  }, [appPls, lib]);
  const liked = allPlaylists.find(isLikedPlaylist);
  const playlists = useMemo(() => allPlaylists.filter((p) => !isLikedPlaylist(p)), [allPlaylists]);
  /** Top-level keys (playlists and folders) in display order. */
  const topKeys = useMemo(() => arrange(org, playlists), [org, playlists]);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    const byId = new Map(playlists.map((p) => [p.id, p]));
    for (const key of topKeys) {
      if (key.startsWith("folder:")) {
        const f = org.folders.find((x) => folderKey(x.id) === key);
        if (!f) continue;
        out.push({ k: "folder", v: f });
        if (f.open) for (const id of f.items) {
          const p = byId.get(id);
          if (p) out.push({ k: "playlist", v: p, depth: 1, folderId: f.id });
        }
      } else {
        const p = byId.get(key);
        if (p) out.push({ k: "playlist", v: p });
      }
    }
    return out;
  }, [org, playlists, topKeys]);

  // The classic Spotify "Your Library" list: one line per collection.
  const categories: Category[] = [
    { key: "new", label: t("whatsNew"), route: { name: "new" }, icon: <I.IBell size={20} /> },
    { key: "recent", label: t("recentlyPlayed"), route: { name: "library", tab: "recent" }, icon: <I.IClock size={20} /> },
    ...(liked ? [{ key: "liked", label: t("likedSongs"), route: { name: "playlist", id: liked.id } as Route, icon: <I.IHeart size={20} /> }] : []),
    { key: "albums", label: t("albums"), route: { name: "library", tab: "albums" }, icon: <I.IMusic size={20} /> },
    { key: "artists", label: t("artists"), route: { name: "library", tab: "artists" }, icon: <I.IMic size={20} /> },
    ...(caps?.podcasts
      ? [
          { key: "podcasts", label: t("podcasts"), route: { name: "library", tab: "podcasts" } as Route, icon: <I.IBookmark size={20} /> },
          { key: "episodes", label: t("yourEpisodes"), route: { name: "episodes" } as Route, icon: <I.IPlay size={20} /> },
        ]
      : []),
    { key: "local", label: t("localFiles"), route: { name: "local" }, icon: <I.IFolder size={20} /> },
    ...(caps?.downloads ? [{ key: "downloads", label: t("downloads"), route: { name: "downloads" } as Route, icon: <I.IDownload size={20} /> }] : []),
  ];

  const canDrag = org.sort === "custom";
  const keyOf = (e: Entry) => (e.k === "folder" ? folderKey(e.v.id) : e.v.id);

  function onDrop(target: Entry) {
    const dragged = drag;
    const where = drop;
    setDrag(null);
    setDrop(null);
    if (!dragged || !where) return;
    const draggedIsFolder = dragged.startsWith("folder:");
    if (target.k === "folder" && where.mode === "into" && !draggedIsFolder) return putInFolder(dragged, target.v.id);
    if (target.k === "playlist" && target.folderId && !draggedIsFolder) {
      const f = org.folders.find((x) => x.id === target.folderId);
      const i = f ? f.items.indexOf(target.v.id) : -1;
      const before = where.mode === "after" ? f?.items[i + 1] : target.v.id;
      return putInFolder(dragged, target.folderId, before);
    }
    // Top level: a child row stands for its folder.
    const tKey = target.k === "playlist" && target.folderId ? folderKey(target.folderId) : keyOf(target);
    const i = topKeys.indexOf(tKey);
    const before = where.mode === "after" ? topKeys[i + 1] ?? null : tKey;
    if (before === dragged) return;
    moveEntry(dragged, before, topKeys);
  }

  const sortLabel = org.sort === "alpha" ? t("sortAlpha") : org.sort === "custom" ? t("sortCustom") : t("sortRecent");
  const nextSort = org.sort === "recent" ? "alpha" : org.sort === "alpha" ? "custom" : "recent";

  const is = (r: Route) => JSON.stringify(r) === JSON.stringify(cur);

  function dragProps(e: Entry) {
    if (!canDrag || collapsed) return {};
    const key = keyOf(e);
    return {
      draggable: true,
      dropMode: drop && drop.key === key + (e.k === "playlist" && e.folderId ? "@" + e.folderId : "") ? drop.mode : undefined,
      onDragStart: (ev: React.DragEvent) => {
        setDrag(key);
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", key);
      },
      onDragOver: (ev: React.DragEvent) => {
        if (!drag || drag === key) return;
        ev.preventDefault();
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        const y = (ev.clientY - r.top) / r.height;
        const intoFolder = e.k === "folder" && !drag.startsWith("folder:") && y > 0.25 && y < 0.75;
        const mode = intoFolder ? "into" : y < 0.5 ? "before" : "after";
        setDrop({ key: key + (e.k === "playlist" && e.folderId ? "@" + e.folderId : ""), mode });
      },
      onDragEnd: () => {
        setDrag(null);
        setDrop(null);
      },
      onDrop: (ev: React.DragEvent) => {
        ev.preventDefault();
        onDrop(e);
      },
    };
  }

  const newMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      {
        label: t("createPlaylist"),
        onClick: async () => {
          const pl = await createPlaylist();
          if (pl) navigate({ name: "playlist", id: pl.id });
        },
      },
      { label: t("createFolder"), onClick: () => newFolder() },
    ]);

  return (
    <nav className={cls("sidebar", collapsed && "collapsed")} aria-label="Main">
      <div className="side-box nav-box">
        <button className={cls("nav-item", cur.name === "home" && "active")} onClick={() => navigate({ name: "home" })} title={t("home")}>
          <I.IHome size={22} />
          <span>{t("home")}</span>
        </button>
        <button className={cls("nav-item", cur.name === "search" && "active")} onClick={() => navigate({ name: "search" })} title={t("search")}>
          <I.ISearch size={22} />
          <span>{t("search")}</span>
        </button>
      </div>
      <div className="side-box lib-box">
        <div className="lib-head">
          <button className="nav-item" onClick={() => setSettings({ sidebarCollapsed: !collapsed })} title={collapsed ? t("expand") : t("collapse")} aria-expanded={!collapsed}>
            <I.ILibrary size={22} />
            <span>{t("library")}</span>
          </button>
        </div>
        <div className="lib-list">
          <div className="side-cats">
            {categories.map((c) => (
              <button
                key={c.key}
                className={cls("side-cat", is(c.route) && "active")}
                title={collapsed ? c.label : undefined}
                aria-current={is(c.route) ? "page" : undefined}
                onClick={() => navigate(c.route)}
              >
                {collapsed ? c.icon : c.label}
              </button>
            ))}
          </div>
          <div className="side-section">
            {!collapsed && <span>{t("playlists")}</span>}
            {!collapsed && (
              <button className="link small" title={t("sortBy")} onClick={() => setSort(nextSort)}>
                {sortLabel}
              </button>
            )}
            <button className="icon-btn" aria-label={t("createPlaylist")} title={t("createPlaylist")} onClick={newMenu}>
              <I.IPlus size={16} />
            </button>
          </div>
          {entries.map((e) =>
            e.k === "folder" ? (
              <SideItem
                key={"folder" + e.v.id}
                active={false}
                collapsed={collapsed}
                title={e.v.name}
                sub={t("folderCount", { n: e.v.items.length })}
                icon={<div className="art sm folder-art">{e.v.open ? <I.IFolderOpen size={20} /> : <I.IFolder size={20} />}</div>}
                expanded={e.v.open}
                onClick={() => toggleFolder(e.v.id)}
                onContext={(ev) => openMenu(ev, folderMenu(e.v))}
                {...dragProps(e)}
              />
            ) : (
              <SideItem
                key={e.v.id + (e.folderId ? "@" + e.folderId : "")}
                depth={e.depth}
                {...dragProps(e)}
                active={cur.name === "playlist" && cur.id === e.v.id}
                collapsed={collapsed}
                title={e.v.title}
                sub={sub(e.v, t)}
                icon={<Art src={e.v.artwork} size={96} className="sm" />}
                onClick={() => navigate({ name: "playlist", id: e.v.id })}
                onContext={(ev) => openMenu(ev, playlistMenu(e.v, async () => (await api.playlist(e.v.id)).tracks))}
                onPlay={async () => {
                  const p = await api.playlist(e.v.id);
                  P.playTracks(p.tracks, 0, { kind: "playlist", id: e.v.id, title: p.playlist.title, artwork: p.playlist.artwork });
                }}
              />
            ),
          )}
        </div>
      </div>
    </nav>
  );
}

function sub(p: Playlist, t: ReturnType<typeof useT>): string {
  // Like Spotify: "Playlist • owner" (or the song count), never where it syncs from.
  return [t("playlist"), p.owner ?? (p.trackCount != null ? t("songsCount", { n: p.trackCount }) : null)].filter(Boolean).join(" • ");
}

function SideItem(p: {
  active: boolean;
  collapsed: boolean;
  title: string;
  sub: string;
  icon: React.ReactNode;
  onClick: () => void;
  onContext?: (e: React.MouseEvent) => void;
  onPlay?: () => void;
  depth?: number;
  expanded?: boolean;
  draggable?: boolean;
  dropMode?: "before" | "after" | "into";
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  return (
    <div
      className={cls("side-item", p.active && "active", !!p.depth && !p.collapsed && "nested", p.dropMode && "drop-" + p.dropMode)}
      role="button"
      tabIndex={0}
      aria-expanded={p.expanded}
      title={p.collapsed ? p.title : undefined}
      onClick={p.onClick}
      onDoubleClick={isTouch() ? undefined : p.onPlay}
      onKeyDown={(e) => e.key === "Enter" && p.onClick()}
      onContextMenu={p.onContext}
      draggable={p.draggable}
      onDragStart={p.onDragStart}
      onDragOver={p.onDragOver}
      onDragEnd={p.onDragEnd}
      onDrop={p.onDrop}
    >
      {p.icon}
      {!p.collapsed && (
        <div className="side-text">
          <span className="name">{p.title}</span>
          <span className="sub">{p.sub}</span>
        </div>
      )}
    </div>
  );
}
