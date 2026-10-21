import { useMemo, useState } from "react";
import { createPlaylist, playlistMenu } from "../actions";
import { api } from "../api";
import { useT } from "../i18n";
import * as P from "../player/engine";
import { useApp } from "../store/app";
import { useSettings } from "../store/settings";
import { navigate, openMenu, useUi, type Route } from "../store/ui";
import type { Album, Artist, Playlist, Podcast } from "../types";
import { cls } from "../util";
import { Art } from "./common";
import * as I from "./Icons";

type Filter = "all" | "playlists" | "albums" | "artists" | "podcasts";
type Entry =
  | { k: "playlist"; v: Playlist }
  | { k: "album"; v: Album }
  | { k: "artist"; v: Artist }
  | { k: "podcast"; v: Podcast };

export function Sidebar() {
  const t = useT();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const setSettings = useSettings((s) => s.set);
  const lib = useApp((s) => s.library);
  const appPls = useApp((s) => s.playlists);
  const caps = useApp((s) => s.info?.capabilities);
  const flavor = useApp((s) => s.info?.flavor);
  const cur = useUi((s) => s.stack[s.pos]);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [alpha, setAlpha] = useState(false);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    if (filter === "all" || filter === "playlists") {
      for (const p of appPls) out.push({ k: "playlist", v: p });
      for (const p of lib?.playlists ?? []) out.push({ k: "playlist", v: p });
    }
    if (filter === "all" || filter === "albums") for (const a of lib?.albums ?? []) out.push({ k: "album", v: a });
    if (filter === "all" || filter === "artists") for (const a of lib?.artists ?? []) out.push({ k: "artist", v: a });
    if (filter === "all" || filter === "podcasts") for (const p of lib?.podcasts ?? []) out.push({ k: "podcast", v: p });
    const name = (e: Entry) => (e.k === "artist" ? e.v.name : e.v.title);
    const needle = q.trim().toLowerCase();
    const list = needle ? out.filter((e) => name(e).toLowerCase().includes(needle)) : out;
    return alpha ? list.slice().sort((a, b) => name(a).localeCompare(name(b))) : list;
  }, [filter, lib, appPls, q, alpha]);

  const is = (r: Route) => JSON.stringify(r) === JSON.stringify(cur);
  const open = (e: Entry) => navigate(e.k === "album" ? { name: "album", id: e.v.id } : e.k === "artist" ? { name: "artist", id: e.v.id } : { name: "playlist", id: e.v.id });

  const filters: Filter[] = ["playlists", "albums", "artists", ...(caps?.podcasts ? (["podcasts"] as Filter[]) : [])];

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
            <button className="icon-btn" aria-label={t("createPlaylist")} title={t("createPlaylist")} onClick={async () => {
              const pl = await createPlaylist();
              if (pl) navigate({ name: "playlist", id: pl.id });
            }}>
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
              <button className="link small" onClick={() => setAlpha(!alpha)}>
                {alpha ? t("sortAlpha") : t("sortRecent")}
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
          {entries.map((e) => (
            <SideItem
              key={e.k + e.v.id}
              active={cur.name !== "home" && "id" in cur && cur.id === e.v.id}
              collapsed={collapsed}
              title={e.k === "artist" ? e.v.name : e.v.title}
              sub={sub(e, t, flavor)}
              icon={<Art src={e.v.artwork} size={96} round={e.k === "artist"} className="sm" />}
              onClick={() => open(e)}
              onContext={
                e.k === "playlist"
                  ? (ev) => openMenu(ev, playlistMenu(e.v as Playlist, async () => (await api.playlist(e.v.id)).tracks))
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
          ))}
        </div>
      </div>
    </nav>
  );
}

function sub(e: Entry, t: ReturnType<typeof useT>, flavor?: string): string {
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
}) {
  return (
    <div
      className={cls("side-item", p.active && "active")}
      role="button"
      tabIndex={0}
      title={p.collapsed ? p.title : undefined}
      onClick={p.onClick}
      onDoubleClick={p.onPlay}
      onKeyDown={(e) => e.key === "Enter" && p.onClick()}
      onContextMenu={p.onContext}
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
