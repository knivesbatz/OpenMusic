import { sourceOf } from "../store/providers";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, artUrl, inTauri } from "../api";
import { localError, useT, type Key } from "../i18n";
import { displayText } from "../romaji";
import { isMobileApp, useApp } from "../store/app";
import { caps } from "../store/providers";
import { signedInTo } from "../actions";
import { useArtistAlias } from "../store/names";
import { useTitleTranslation } from "../store/translate";
import { useSettings } from "../store/settings";
import { navigate, openMenu, useUi } from "../store/ui";
import type { Capabilities, MediaItem, ProviderError, Track } from "../types";
import { PROVIDERS } from "../types";
import { useDisplayTrack } from "../store/songmeta";
import { cls, isTouch, serviceLabel } from "../util";
import { IDownload, IDownloaded, IMusic, IPlay } from "./Icons";

export const Art = memo(function Art({
  src,
  size = 300,
  round,
  className,
  alt = "",
  placeholder,
}: {
  src?: string | null;
  size?: number;
  round?: boolean;
  className?: string;
  alt?: string;
  /** Shown when there's no picture (default: a note). */
  placeholder?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const url = artUrl(src, size);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className={cls("art", round && "round", className)}>
      {url && !failed ? (
        <img src={url} alt={alt} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
      ) : (
        placeholder ?? <IMusic size={28} />
      )}
    </div>
  );
});

export function PlayFab({ onClick, label, big }: { onClick: (e: React.MouseEvent) => void; label: string; big?: boolean }) {
  return (
    <button className={cls("fab", big && "big")} onClick={onClick} aria-label={label} title={label}>
      <IPlay size={big ? 24 : 20} />
    </button>
  );
}

export function itemSubtitle(item: MediaItem, t: ReturnType<typeof useT>): string {
  switch (item.type) {
    case "album":
      return [item.year, item.artist].filter(Boolean).join(" • ");
    case "artist":
      return t("artist");
    case "playlist":
      return item.owner ? t("by", { name: item.owner }) : t("playlist");
    case "podcast":
      return item.author ?? t("podcast");
    case "track":
      return item.artist;
  }
}

export function openItem(item: MediaItem) {
  switch (item.type) {
    case "album":
      return navigate({ name: "album", id: item.id });
    case "artist":
      return navigate({ name: "artist", id: item.id });
    case "playlist":
    case "podcast":
      // Liked Songs (played from its page) has a page of its own.
      return navigate(item.id === "liked" ? { name: "liked" } : { name: "playlist", id: item.id });
    case "track":
      return item.albumId ? navigate({ name: "album", id: item.albumId }) : undefined;
  }
}

export const Card = memo(function Card({
  item,
  onPlay,
  onContext,
  sub,
}: {
  item: MediaItem;
  onPlay?: () => void;
  onContext?: (e: React.MouseEvent) => void;
  /** Instead of the usual subtitle ("2026 • Album" in a discography). */
  sub?: string;
}) {
  const t = useT();
  const patched = useDisplayTrack(item.type === "track" ? item : null);
  if (item.type === "track" && patched) item = { ...patched, type: "track" };
  const title = item.type === "artist" ? item.name : item.title;
  return (
    <div
      className="card"
      data-source={sourceOf(item.id) ?? undefined}
      role="button"
      tabIndex={0}
      onClick={() => openItem(item)}
      onKeyDown={(e) => e.key === "Enter" && openItem(item)}
      onContextMenu={onContext}
    >
      <div className="card-art">
        <Art src={item.artwork} round={item.type === "artist"} />
        {onPlay && (
          <PlayFab
            label={t("play")}
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
          />
        )}
      </div>
      <div className="card-title" title={title}>
        {item.type === "artist" ? <ArtistName name={title} /> : <TitleText text={title} />}
      </div>
      <div className="card-sub">
        <JpText text={sub ?? itemSubtitle(item, t)} />
      </div>
    </div>
  );
});

export function Shelf({
  title,
  subtitle,
  note,
  children,
  onShowAll,
}: {
  title: string;
  subtitle?: string | null;
  /** A small line under the title ("Only visible to you"). */
  note?: string;
  children: ReactNode;
  onShowAll?: () => void;
}) {
  const t = useT();
  return (
    <section className="shelf">
      <div className="shelf-head">
        <div>
          {subtitle && <div className="shelf-sub">{subtitle}</div>}
          <h2>{title}</h2>
          {note && <div className="shelf-note">{note}</div>}
        </div>
        {onShowAll && (
          <button className="link" onClick={onShowAll}>
            {t("showAll")}
          </button>
        )}
      </div>
      <div className="shelf-row">{children}</div>
    </section>
  );
}

export function Loading() {
  const t = useT();
  return (
    <div className="center muted" role="status">
      <div className="spinner" aria-hidden="true" />
      {t("loading")}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="center" role="alert">
      <p className="muted">{message}</p>
      {onRetry && (
        <button className="pill" onClick={onRetry}>
          {t("retry")}
        </button>
      )}
    </div>
  );
}

/** Small async loader with stale-response suppression. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  const tok = useRef(0);
  useEffect(() => {
    const my = ++tok.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => my === tok.current && setState({ data, error: null, loading: false }),
      (e) => my === tok.current && setState({ data: null, error: localError(e), loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

/** Japanese metadata shown per the "Japanese text" setting; the original is never modified. */
export const JpText = memo(function JpText({ text }: { text: string | null | undefined }) {
  const mode = useSettings((s) => s.jpMode);
  if (!text) return null;
  const [main, alt] = displayText(text, mode);
  return alt ? (
    <>
      {main} <span className="jp-alt">{alt}</span>
    </>
  ) : (
    <>{main}</>
  );
});

/**
 * An artist name in the UI language when MusicBrainz has an alias for it (e.g. a Japanese artist
 * shown with its English name). The original name stays visible as a tooltip and in the DOM text
 * for screen readers, and the setting "Japanese text" still applies.
 */
export const ArtistName = memo(function ArtistName({ name }: { name: string | null | undefined }) {
  const alias = useArtistAlias(name);
  if (!name) return null;
  if (!alias) return <JpText text={name} />;
  return (
    <span title={name}>
      <JpText text={alias} />
    </span>
  );
});

/**
 * A song or album title in the UI language when it is written in another script (machine
 * translated). The original stays visible as a tooltip; the "Japanese text" setting still applies.
 */
export const TitleText = memo(function TitleText({ text }: { text: string | null | undefined }) {
  const tr = useTitleTranslation(text);
  if (!text) return null;
  if (!tr) return <JpText text={text} />;
  return <span title={text}>{tr}</span>;
});

/** Artwork for a track, using album art instead of a YouTube video thumbnail when known. */
export function TrackArt({ track, size, className }: { track: Track; size?: number; className?: string }) {
  const tr = useDisplayTrack(track);
  return <Art src={tr.artwork} size={size} className={className} />;
}

/**
 * Dropdown drawn by the app (the same menu as right-click menus) instead of a native `<select>`,
 * whose popup is a separate native window in WebView2 and was implicated in crashes.
 */
export function Select<V extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  label: string;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <button
      type="button"
      className="select"
      role="combobox"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={false}
      disabled={disabled}
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(
          { clientX: r.left, clientY: r.bottom + 4, preventDefault: () => {}, stopPropagation: () => e.stopPropagation() },
          options.map((o) => ({ label: (o.value === value ? "✓ " : " ") + o.label, onClick: () => onChange(o.value) })),
        );
      }}
    >
      <span>{current}</span>
      <span aria-hidden="true">▾</span>
    </button>
  );
}

/** Show this page's name (and a play button) in the top bar once it scrolls, like Spotify. */
/** The page's name for the top bar once scrolled. With `play`, the bar also gets a play button;
 * `art` tints the phone's pinned bar with the cover's colour, `ctxId` lets it show pause while
 * this page is playing. */
export function usePageTitle(title: string | null | undefined, play?: () => void, opts?: { art?: string | null; ctxId?: string }) {
  const playRef = useRef(play);
  playRef.current = play;
  const art = opts?.art ?? null;
  const ctxId = opts?.ctxId;
  const hasPlay = !!play;
  useEffect(() => {
    if (!title) return;
    useUi.setState({ pageTitle: { title, play: hasPlay ? () => playRef.current?.() : undefined, art, ctxId } });
    return () => useUi.setState({ pageTitle: null });
  }, [title, art, ctxId, hasPlay]);
}

/** The phone app, or a narrow touch screen: Spotify mobile-style song screen and queue sheet. */
export function usePhoneLayout() {
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const m = matchMedia("(max-width: 760px)");
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return isMobileApp() || (narrow && isTouch());
}

// ---- services ------------------------------------------------------------------------------------

/**
 * Changes whenever a service is switched on or off, signs in or out, or the app info arrives:
 * components that ask the (non-reactive) per-service helpers re-render with it, and pages use it
 * as an effect dependency to fetch again.
 */
export function useProvidersKey(): string {
  const services = useApp((s) => s.services);
  const auth = useApp((s) => s.auth);
  const info = useApp((s) => s.info);
  return useMemo(
    () => PROVIDERS.map((p) => `${services?.[p] ? 1 : 0}${signedInTo(p) ? 1 : 0}`).join("") + (info ? "" : "-"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, auth, info],
  );
}

/** What the services that are on can do (podcasts, downloads…), re-rendering when they change. */
export function useCaps(): Capabilities {
  useProvidersKey();
  return caps();
}

const NOTE: Record<string, Key> = { offline: "noteOffline", timeout: "noteTimeout", authExpired: "noteAuthExpired", notSignedIn: "noteNotSignedIn" };

/** Small notes on a merged page (Home, Search, Your Library) for each service whose part failed:
 * the other service's part still shows. Services that were switched off since are left out. */
export function ProviderNotes({ errors }: { errors: ProviderError[] | null | undefined }) {
  const t = useT();
  const services = useApp((s) => s.services);
  const seen = new Set<string>();
  const shown = (errors ?? []).filter(
    (e) => (e.provider === "youtube" || e.provider === "plex") && services?.[e.provider] && e.code !== "disabled" && !seen.has(e.provider) && (seen.add(e.provider), true),
  );
  if (!shown.length) return null;
  return (
    <>
      {shown.map((e) => (
        <p key={e.provider} className="muted small provider-note" role="status" data-provider={e.provider}>
          {t(NOTE[e.code] ?? "noteFailed", { service: serviceLabel(e.provider) })}
        </p>
      ))}
    </>
  );
}

/** Downloads on this device (finished ones play from disk, also while their service is off):
 * `done` and `busy` (queued or downloading) song ids, and the playlists and albums downloaded as a
 * whole (kv `ui.downloads.collections`: id → its song ids), which show Spotify's green mark. */
type DownloadState = { done: Set<string>; busy: Set<string>; any: boolean; collections: Record<string, string[]> };
export const useDownloadState = create<DownloadState>(() => ({ done: new Set(), busy: new Set(), any: false, collections: {} }));
let downloadsWatched = false;
const COLLECTIONS_KEY = "downloads.collections";
function loadDownloads() {
  api.downloadList().then(
    (l) =>
      useDownloadState.setState({
        done: new Set(l.filter((d) => d.status === "done").map((d) => d.track.id)),
        busy: new Set(l.filter((d) => d.status === "queued" || d.status === "downloading").map((d) => d.track.id)),
        any: l.length > 0,
      }),
    () => {},
  );
  api.kvGet<Record<string, string[]>>(COLLECTIONS_KEY).then((c) => useDownloadState.setState({ collections: c ?? {} }), () => {});
}

/** Remember a playlist or album as downloaded (its downloadable songs), or forget it (`null`). */
export function setCollectionDownload(id: string, songIds: string[] | null) {
  const collections = { ...useDownloadState.getState().collections };
  if (songIds && songIds.length) collections[id] = songIds;
  else delete collections[id];
  useDownloadState.setState({ collections });
  if (inTauri) api.kvSet(COLLECTIONS_KEY, collections).catch(() => {});
}

/** "done": every downloadable song of the list is on this device; "busy": some are on their way. */
export type ListDownload = "done" | "busy" | null;
export function listDownload(s: DownloadState, songIds: string[]): ListDownload {
  if (!songIds.length) return null;
  if (songIds.some((id) => s.busy.has(id))) return "busy";
  return songIds.every((id) => s.done.has(id)) ? "done" : null;
}

/** A playlist or album downloaded as a whole (Download on it), as far as it has finished. */
export function useCollectionDownload(id: string | null | undefined): ListDownload {
  useEffect(watchDownloads, []);
  return useDownloadState((s) => (id && s.collections[id] ? listDownload(s, s.collections[id]) : null));
}

/** The download state of a list of songs (a playlist or album page). */
export function useListDownload(songIds: string[]): ListDownload {
  useEffect(watchDownloads, []);
  return useDownloadState((s) => listDownload(s, songIds));
}

/** One song: downloaded, on its way, or neither. */
export function useDownloadStatus(id: string): ListDownload {
  useEffect(watchDownloads, []);
  return useDownloadState((s) => (s.done.has(id) ? "done" : s.busy.has(id) ? "busy" : null));
}

/** Spotify's green "downloaded" arrow; pulsing while the download is on its way. */
export function DownloadMark({ state, size = 14 }: { state: ListDownload; size?: number }) {
  const t = useT();
  if (!state) return null;
  return (
    <span className={cls("dl-mark", state === "busy" && "busy")} role="img" aria-label={t(state === "done" ? "downloaded" : "statusDownloading")} title={t(state === "done" ? "downloaded" : "statusDownloading")}>
      {state === "done" ? <IDownloaded size={size} /> : <IDownload size={size} />}
    </span>
  );
}

/** The mark of a playlist or album downloaded as a whole (sidebar, Your Library, cards). */
export function CollectionDownloadMark({ id, size }: { id: string | null | undefined; size?: number }) {
  return <DownloadMark state={useCollectionDownload(id)} size={size} />;
}
function watchDownloads() {
  if (downloadsWatched || !inTauri) return;
  downloadsWatched = true;
  loadDownloads();
  listen("downloads-changed", loadDownloads).catch(() => {});
}

/** Whether there is anything in Downloads (the entry stays while Plex is off). */
export function useHasDownloads(): boolean {
  useEffect(watchDownloads, []);
  return useDownloadState((s) => s.any);
}

/** Whether this track was downloaded and plays from disk. */
export function useDownloaded(id: string): boolean {
  useEffect(watchDownloads, []);
  return useDownloadState((s) => s.done.has(id));
}
