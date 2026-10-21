// Localized artist names (MusicBrainz aliases via Rust). Requests are batched and cached in memory;
// the Rust side caches them on disk and respects MusicBrainz's rate limit.
import { create } from "zustand";
import { api, inTauri } from "../api";
import { useSettings } from "./settings";

interface NamesState {
  /** `${locale}:${name}` -> alias, or "" when there is none. */
  map: Record<string, string>;
}

export const useNames = create<NamesState>(() => ({ map: {} }));

const pending = new Set<string>();
const requested = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  timer = undefined;
  const locale = useSettings.getState().language;
  const names = [...pending].slice(0, 50);
  names.forEach((n) => pending.delete(n));
  if (!names.length) return;
  api.localizedArtistNames(names, locale).then(
    (found) => {
      const map = { ...useNames.getState().map };
      for (const n of names) map[`${locale}:${n}`] = found[n] ?? "";
      useNames.setState({ map });
      if (pending.size) timer = setTimeout(flush, 1500);
    },
    () => names.forEach((n) => requested.delete(`${locale}:${n}`)),
  );
}

/** Localized name for an artist, or null. Triggers a background lookup the first time. */
export function useArtistAlias(name: string | null | undefined): string | null {
  const locale = useSettings((s) => s.language);
  const enabled = useSettings((s) => s.translateNames);
  const key = `${locale}:${name}`;
  const alias = useNames((s) => (name ? s.map[key] : undefined));
  if (!name || !enabled || !inTauri) return null;
  if (alias === undefined && !requested.has(key)) {
    requested.add(key);
    pending.add(name);
    timer ??= setTimeout(flush, 250);
  }
  return alias || null;
}
