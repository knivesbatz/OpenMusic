import { useMemo, useState } from "react";
import { albumMenu, artistMenu, createPlaylist, folderMenu, newFolder, playlistMenu } from "../actions";
import { api } from "../api";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { useApp } from "../store/app";
import { arrange, folderKey, moveEntry, putInFolder, setSort, toggleFolder, useFolders, type Folder } from "../store/folders";
import { useSettings } from "../store/settings";
import { navigate, openMenu, useUi, type Route } from "../store/ui";
import type { Album, Artist, Playlist, Podcast } from "../types";
import { cls } from "../util";
import { Art } from "./common";
import * as I from "./Icons";

type Filter = "all" | "playlists" | "albums" | "artists" | "podcasts";
type Entry =
  | { k: "playlist"; v: Playlist; depth?: number; folderId?: string }
  | { k: "folder"; v: Folder }
  | { k: "album"; v: Album }
  | { k: "artist"; v: Artist }
  | { k: "podcast"; v: Podcast };

export function Sidebar() {
  const t = useT();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const setSettings = useSettings((s) => s.set);
  const lib = useApp((s) => s.library);
  const appPls = useApp((s) => s.playlists);
  const saved = useApp((s) => s.saved);
  const caps = useApp((s) => s.info?.capabilities);
  const flavor = useApp((s) => s.info?.flavor);
  const cur = useUi((s) => s.stack[s.pos]);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const org = useFolders();
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; mode: "before" | "after" | "into" } | null>(null);
  const needle = q.trim().toLowerCase();

  const playlists = useMemo(() => {
    const seen = new Set<string>();
    return [...appPls, ...(lib?.playlists ?? [])].filter((p) => !seen.has(p.id) && (seen.add(p.id), true));
  }, [appPls, lib]);
  /** Top-level keys (playlists and folders) in display order. */
  const topKeys = useMemo(() => arrange(org, playlists), [org, playlists]);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    if (filter === "all" || filter === "playlists") {
      if (needle) {
        for (const p of playlists) out.push({ k: "playlist", v: p });
      } else {
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
      }
    }
    // Albums/artists in "Your Library" are the ones the user saved. On Plex the provider library is
    // the whole server, so only YouTube's own library collection is merged in.
    const seen = new Set<string>();
    const uniq = <T extends { id: string }>(xs: T[]) => xs.filter((x) => !seen.has(x.id) && (seen.add(x.id), true));
    const provider = flavor === "youtube";
    if (filter === "all" || filter === "albums")
      for (const a of uniq([...saved.albums, ...(provider ? lib?.albums ?? [] : [])])) out.push({ k: "album", v: a });
    if (filter === "all" || filter === "artists")
      for (const a of uniq([...saved.artists, ...(provider ? lib?.artists ?? [] : [])])) out.push({ k: "artist", v: a });
    if (filter === "all" || filter === "podcasts") for (const p of lib?.podcasts ?? []) out.push({ k: "podcast", v: p });
    const name = (e: Entry) => (e.k === "artist" ? e.v.name : e.k === "folder" ? e.v.name : e.v.title);
    if (needle) return out.filter((e) => name(e).toLowerCase().includes(needle));
    if (org.sort !== "alpha") return out;
    // Playlists and folders are already arranged; sort the rest alphabetically after them.
    const head = out.filter((e) => e.k === "playlist" || e.k === "folder");
    const rest = out.filter((e) => e.k !== "playlist" && e.k !== "folder").sort((a, b) => name(a).localeCompare(name(b)));
    return [...head, ...rest];
  }, [filter, lib, saved, flavor, needle, org, playlists, topKeys]);

  const canDrag = org.sort === "custom" && !needle;
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
  const open = (e: Entry) => navigate(e.k === "album" ? { name: "album", id: e.v.id } : e.k === "artist" ? { name: "artist", id: e.v.id } : { name: "playlist", id: e.v.id });

  const filters: Filter[] = ["playlists", "albums", "artists", ...(caps?.podcasts ? (["podcasts"] as Filter[]) : [])];

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
          {!collapsed && (
            <button
              className="icon-btn"
              aria-label={t("createPlaylist")}
              title={t("createPlaylist")}
              onClick={(e) =>
                openMenu(e, [
                  {
                    label: t("createPlaylist"),
                    onClick: async () => {
                      const pl = await createPlaylist();
                      if (pl) navigate({ name: "playlist", id: pl.id });
                    },
                  },
                  { label: t("createFolder"), onClick: () => newFolder() },
                ])
              }
            >
              <I.IPlus size={18} />
            </button>
          )}
        </div>
        {!collapsed && (
          <>
            <div className="chips">
              {filter !== "all" && (
                <button className="chip" aria-label={t("all")} onClick={() => setFilter("all")}>
                  <I.IClose size={14} />
                </button>
              )}
              {filters.map((f) => (
                <button key={f} className={cls("chip", filter === f && "on")} aria-pressed={filter === f} onClick={() => setFilter(filter === f ? "all" : f)}>
                  {t(f)}
                </button>
              ))}
            </div>
            <div className="lib-tools">
              <input className="lib-filter" placeholder={t("searchInLibrary")} aria-label={t("searchInLibrary")} value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="link small" title={t("sortBy")} onClick={() => setSort(nextSort)}>
                {sortLabel}
              </button>
            </div>
          </>
        )}
        <div className="lib-list">
          <SideItem
            active={is({ name: "local" })}
            collapsed={collapsed}
            title={t("localFiles")}
            sub={t("localFilesSub")}
            icon={<div className="art sm grad-local"><I.IFolder size={20} /></div>}
            onClick={() => navigate({ name: "local" })}
          />
          {caps?.downloads && (
            <SideItem
              active={is({ name: "downloads" })}
              collapsed={collapsed}
              title={t("downloads")}
              sub={t("offlineAvailable")}
              icon={<div className="art sm grad-dl"><I.IDownload size={20} /></div>}
              onClick={() => navigate({ name: "downloads" })}
            />
          )}
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
              key={e.k + e.v.id + (e.k === "playlist" && e.folderId ? "@" + e.folderId : "")}
              depth={e.k === "playlist" ? e.depth : 0}
              {...(e.k === "playlist" ? dragProps(e) : {})}
              active={cur.name !== "home" && "id" in cur && cur.id === e.v.id}
              collapsed={collapsed}
              title={e.k === "artist" ? e.v.name : e.v.title}
              sub={sub(e, t, flavor)}
              icon={<Art src={e.v.artwork} size={96} round={e.k === "artist"} className="sm" />}
              onClick={() => open(e)}
              onContext={
                e.k === "playlist"
                  ? (ev) => openMenu(ev, playlistMenu(e.v as Playlist, async () => (await api.playlist(e.v.id)).tracks))
                  : e.k === "album"
                    ? (ev) => openMenu(ev, albumMenu(e.v as Album, async () => (await api.album(e.v.id)).tracks))
                    : e.k === "artist"
                      ? (ev) => openMenu(ev, artistMenu(e.v as Artist))
                      : undefined
              }
              onPlay={
                e.k === "playlist"
                  ? async () => {
                      const p = await api.playlist(e.v.id);
                      P.playTracks(p.tracks, 0, { kind: "playlist", id: e.v.id, title: p.playlist.title, artwork: p.playlist.artwork });
                    }
                  : e.k === "album"
                    ? async () => {
                        const a = await api.album(e.v.id);
                        P.playTracks(a.tracks, 0, { kind: "album", id: e.v.id, title: a.album.title, artwork: a.album.artwork });
                      }
                    : undefined
              }
            />
            ),
          )}
        </div>
      </div>
    </nav>
  );
}

function sub(e: Exclude<Entry, { k: "folder" }>, t: ReturnType<typeof useT>, flavor?: string): string {
  switch (e.k) {
    case "playlist":
      return [e.v.local ? t("appPlaylist") : t("remotePlaylist", { provider: flavor === "plex" ? "Plex" : "YouTube Music" }), e.v.trackCount != null ? t("songsCount", { n: e.v.trackCount }) : null]
        .filter(Boolean)
        .join(" • ");
    case "album":
      return `${t("album")} • ${e.v.artist}`;
    case "artist":
      return t("artist");
    case "podcast":
      return `${t("podcast")}${e.v.author ? " • " + e.v.author : ""}`;
  }
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
      onDoubleClick={p.onPlay}
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
