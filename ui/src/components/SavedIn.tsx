// Spotify's "Saved in" panel: Liked Songs and every playlist with a check to add or remove the
// song. YouTube playlists (for YouTube songs, while YouTube is on with an account) come from
// YouTube Music's own "Save to playlist" list; Plex playlists are never written.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { canLikeTrack, createPlaylist, skipDuplicates, toggleLike } from "../actions";
import { api, inTauri } from "../api";
import { localError, useT } from "../i18n";
import { refreshPlaylists, useApp } from "../store/app";
import { toast, useUi } from "../store/ui";
import type { Track } from "../types";
import { cls } from "../util";
import { Art, useProvidersKey } from "./common";
import * as I from "./Icons";

interface Remote {
  id: string;
  title: string;
  contains: boolean;
}

/** Open the panel at the clicked button. */
export function openSavedIn(e: React.MouseEvent, track: Track) {
  e.preventDefault();
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  useUi.setState({ savedIn: { x: r.left + r.width / 2, y: r.top, track }, menu: null });
}

/** The heart: likes a song in one click; on a liked song it opens "Saved in". */
export function likeOrOpen(e: React.MouseEvent, track: Track) {
  if (useApp.getState().liked.has(track.id)) openSavedIn(e, track);
  else {
    e.stopPropagation();
    toggleLike(track);
  }
}

export function SavedInPanel() {
  const t = useT();
  const open = useUi((s) => s.savedIn);
  const pls = useApp((s) => s.playlists);
  const liked = useApp((s) => (open ? s.liked.has(open.track.id) : false));
  useProvidersKey();
  const canLike = !!open && canLikeTrack(open.track);
  const [inApp, setInApp] = useState<Set<string> | null>(null);
  const [remote, setRemote] = useState<Remote[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const close = () => useUi.setState({ savedIn: null });

  useEffect(() => {
    if (!open) return;
    setInApp(null);
    setRemote([]);
    if (!inTauri) return setInApp(new Set());
    let live = true;
    api.savedIn(open.track).then(
      (r) => live && (setInApp(new Set(r.appPlaylists)), setRemote(r.remote)),
      () => live && setInApp(new Set()),
    );
    return () => {
      live = false;
    };
  }, [open]);

  // Above the button when there's room, kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(8, open.x - w / 2), innerWidth - w - 8);
    const top = open.y - h - 8 > 8 ? open.y - h - 8 : Math.min(open.y + 36, innerHeight - h - 8);
    setPos({ left, top });
  }, [open, inApp, remote.length]);

  useEffect(() => {
    if (!open) return;
    // The "Already added" question opens over the panel; answering it leaves the panel open.
    const inDialog = (e: Event) => !!(e.target as Element | null)?.closest?.(".modal-bg");
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !inDialog(e) && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && !inDialog(e) && close();
    addEventListener("mousedown", down);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("mousedown", down);
      removeEventListener("keydown", key);
    };
  }, [open]);

  if (!open) return null;
  const track = open.track;

  /** Adding: false when the song (or one with its title and artist) is there and the answer is "Don't add". */
  const wanted = async (id: string, title: string) => (await skipDuplicates(id, title, [track])).length > 0;

  async function toggleApp(id: string, on: boolean) {
    setBusy(id);
    try {
      if (on && !(await wanted(id, pls.find((p) => p.id === id)?.title ?? ""))) return setBusy(null);
      if (on) await api.plAdd(id, [track]);
      else await api.plRemoveTrack(id, track.id);
      setInApp((s) => {
        const n = new Set(s);
        if (on) n.add(id);
        else n.delete(id);
        return n;
      });
      refreshPlaylists();
    } catch (e) {
      toast(localError(e));
    }
    setBusy(null);
  }

  async function toggleRemote(p: Remote, on: boolean) {
    setBusy(p.id);
    try {
      if (on && !(await wanted(p.id, p.title))) return setBusy(null);
      await api.ytPlaylistEdit(p.id, track, on);
      setRemote((rs) => rs.map((r) => (r.id === p.id ? { ...r, contains: on } : r)));
    } catch (e) {
      toast(localError(e));
    }
    setBusy(null);
  }

  const Row = (p: { id: string; icon: React.ReactNode; title: string; checked: boolean; onChange: (on: boolean) => void }) => (
    <label className={cls("si-row", busy === p.id && "busy")}>
      {p.icon}
      <span className="si-title">{p.title}</span>
      <input type="checkbox" className="si-check" checked={p.checked} disabled={busy === p.id} onChange={(e) => p.onChange(e.target.checked)} />
    </label>
  );

  return (
    <div ref={ref} className="savedin" role="dialog" aria-label={t("savedIn")} style={pos}>
      <div className="si-head">{t("savedIn")}</div>
      <button
        className="si-new"
        onClick={async () => {
          close();
          await createPlaylist([track]);
        }}
      >
        <I.IPlus size={16} /> {t("newPlaylist")}
      </button>
      <div className="si-list">
        {canLike && (
          <Row id="liked" icon={<div className="art grad-liked"><I.IHeartFill size={14} /></div>} title={t("likedSongs")} checked={liked} onChange={() => toggleLike(track)} />
        )}
        {inApp == null ? (
          <p className="muted small si-pad">{t("loading")}</p>
        ) : (
          pls.map((p) => <Row key={p.id} id={p.id} icon={<Art src={p.artwork} size={64} />} title={p.title} checked={inApp.has(p.id)} onChange={(on) => toggleApp(p.id, on)} />)
        )}
        {remote.length > 0 && (
          <>
            <div className="si-sub">{t("youtubePlaylists")}</div>
            {remote.map((p) => (
              <Row key={p.id} id={p.id} icon={<div className="art grad-yt"><I.IMusic size={14} /></div>} title={p.title} checked={p.contains} onChange={(on) => toggleRemote(p, on)} />
            ))}
          </>
        )}
      </div>
      <div className="si-foot">
        <button className="pill small" onClick={close}>
          {t("done")}
        </button>
      </div>
    </div>
  );
}
