// Where an item comes from, as a tiny glyph: a play triangle for YouTube Music, a chevron for
// Plex. Original drawings (no logos). Shown only while both services are on; with one service the
// app looks exactly as before.
import { memo } from "react";
import { useT } from "../i18n";
import { sourceOf, useBothOn } from "../store/providers";
import { cls, serviceLabel } from "../util";

export const SourceBadge = memo(function SourceBadge({ id, after }: { id: string | null | undefined; after?: boolean }) {
  const t = useT();
  const both = useBothOn();
  const s = sourceOf(id);
  if (!both || (s !== "youtube" && s !== "plex")) return null;
  const label = t("fromService", { service: serviceLabel(s) });
  return (
    <span className={cls("src-badge", s, after && "after")} role="img" aria-label={label} title={label} data-source={s}>
      <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {s === "youtube" ? (
          <path fill="currentColor" d="M4.5 2.6c0-.8.9-1.3 1.6-.9l8 5.4c.6.4.6 1.4 0 1.8l-8 5.4c-.7.4-1.6-.1-1.6-.9z" />
        ) : (
          <path fill="currentColor" d="M3.5 1.5h4.3L13 8l-5.2 6.5H3.5L8.7 8z" />
        )}
      </svg>
    </span>
  );
});
