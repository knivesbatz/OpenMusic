// Per-show episode order: the provider's newest first, or oldest first. Kept in the app database
// until changed, so a show stays in the order you picked.
import { create } from "zustand";
import { api, inTauri } from "../api";

const KV = "podcastOldestFirst";
export const usePodcastSorts = create<{ oldest: Record<string, true> }>(() => ({ oldest: {} }));

let loaded = false;
export function loadPodcastSorts() {
  if (loaded || !inTauri) return;
  loaded = true;
  api.kvGet<Record<string, true>>(KV).then((m) => m && usePodcastSorts.setState({ oldest: m }), () => {});
}

export function setOldestFirst(id: string, on: boolean) {
  const oldest = { ...usePodcastSorts.getState().oldest };
  if (on) oldest[id] = true;
  else delete oldest[id];
  usePodcastSorts.setState({ oldest });
  if (inTauri) api.kvSet(KV, oldest).catch(() => {});
}

export const useOldestFirst = (id: string): boolean => usePodcastSorts((s) => !!s.oldest[id]);

const UNIT: Record<string, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };

/**
 * An episode's date as shown by the provider ("Oct 26", "Oct 26, 2023", "3 days ago",
 * "2023/10/26", "10月26日"), in ms; null when it can't be read. A date without a year is this year,
 * or last year if that would be in the future.
 */
export function publishedAt(s: string | null | undefined, now = new Date()): number | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  const ago = t.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (ago) return now.getTime() - Number(ago[1]) * UNIT[ago[2].toLowerCase()];
  const jp = t.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  const noYear = (d: Date) => (d.getTime() > now.getTime() + 864e5 ? new Date(d.getFullYear() - 1, d.getMonth(), d.getDate()) : d);
  if (jp) {
    const d = new Date(jp[1] ? Number(jp[1]) : now.getFullYear(), Number(jp[2]) - 1, Number(jp[3]));
    return (jp[1] ? d : noYear(d)).getTime();
  }
  if (/\d{4}/.test(t)) {
    const v = Date.parse(t);
    return Number.isNaN(v) ? null : v;
  }
  // "Oct 26" only: the date parser reads almost anything with a year added.
  if (!/^[A-Za-z]{3,}\.?\s+\d{1,2}$/.test(t)) return null;
  const v = Date.parse(`${t}, ${now.getFullYear()}`);
  return Number.isNaN(v) ? null : noYear(new Date(v)).getTime();
}

/**
 * Episodes in the chosen order. Providers usually list them newest first; when the dates say the
 * list runs the other way, that's taken into account, so "oldest first" always is.
 */
export function orderEpisodes<T extends { published?: string | null }>(eps: T[], oldestFirst: boolean, now = new Date()): T[] {
  const dates = eps.map((e) => publishedAt(e.published, now)).filter((d): d is number => d != null);
  const ascending = dates.length >= 2 && dates[0] < dates[dates.length - 1];
  return oldestFirst === ascending ? eps : [...eps].reverse();
}
