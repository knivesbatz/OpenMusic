import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { artUrl } from "../api";
import { useT } from "../i18n";
import { displayText } from "../romaji";
import { useArtistAlias } from "../store/names";
import { useSettings } from "../store/settings";
import { navigate } from "../store/ui";
import type { MediaItem } from "../types";
import { cls } from "../util";
import { IMusic, IPlay } from "./Icons";

export const Art = memo(function Art({
  src,
  size = 300,
  round,
  className,
  alt = "",
}: {
  src?: string | null;
  size?: number;
  round?: boolean;
  className?: string;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = artUrl(src, size);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className={cls("art", round && "round", className)}>
      {url && !failed ? (
        <img src={url} alt={alt} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <IMusic size={28} />
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
      return navigate({ name: "playlist", id: item.id });
    case "track":
      return item.albumId ? navigate({ name: "album", id: item.albumId }) : undefined;
  }
}

export const Card = memo(function Card({
  item,
  onPlay,
  onContext,
}: {
  item: MediaItem;
  onPlay?: () => void;
  onContext?: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  const title = item.type === "artist" ? item.name : item.title;
  return (
    <div
      className="card"
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
        {item.type === "artist" ? <ArtistName name={title} /> : <JpText text={title} />}
      </div>
      <div className="card-sub">
        <JpText text={itemSubtitle(item, t)} />
      </div>
    </div>
  );
});

export function Shelf({ title, subtitle, children, onShowAll }: { title: string; subtitle?: string | null; children: ReactNode; onShowAll?: () => void }) {
  const t = useT();
  return (
    <section className="shelf">
      <div className="shelf-head">
        <div>
          {subtitle && <div className="shelf-sub">{subtitle}</div>}
          <h2>{title}</h2>
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
      (e) => my === tok.current && setState({ data: null, error: e?.message ?? String(e), loading: false }),
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
