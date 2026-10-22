// Machine translations into the UI language (Rust caches them on disk): song and album titles
// written in another script, and lyrics. Title requests are batched like the artist aliases.
import { create } from "zustand";
import { useEffect, useState } from "react";
import { api, inTauri } from "../api";
import { useSettings } from "./settings";

/**
 * Text worth translating for this UI language. English UI: anything in a non-Latin script
 * (Japanese, Korean, Chinese, Cyrillic, …). Japanese UI: non-Latin text that isn't Japanese
 * (Korean, Cyrillic, …). Latin-script titles stay as published, like Spotify shows them.
 */
export function needsTranslation(text: string, locale: "en" | "ja"): boolean {
  const foreign = /[Ͱ-ϿЀ-ӿ֐-ۿऀ-෿฀-໿ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯]/;
  if (locale === "en") return foreign.test(text);
  const japanese = /[぀-ヿ㐀-䶿一-鿿]/;
  return foreign.test(text) && !japanese.test(text);
}

interface TitlesState {
  /** `${locale}:${text}` -> translation, or "" when there is none. */
  map: Record<string, string>;
}

export const useTitles = create<TitlesState>(() => ({ map: {} }));

const pending = new Set<string>();
const requested = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  timer = undefined;
  const locale = useSettings.getState().language;
  const texts = [...pending].slice(0, 60);
  texts.forEach((n) => pending.delete(n));
  if (!texts.length) return;
  api.translateTexts(texts, locale).then(
    (found) => {
      const map = { ...useTitles.getState().map };
      texts.forEach((n, i) => (map[`${locale}:${n}`] = found[i] ?? ""));
      useTitles.setState({ map });
      if (pending.size) timer = setTimeout(flush, 400);
    },
    // Offline or refused: allow a retry later.
    () => texts.forEach((n) => requested.delete(`${locale}:${n}`)),
  );
}

/** A title in the UI language when it is written in another script, or null. */
export function useTitleTranslation(text: string | null | undefined): string | null {
  const locale = useSettings((s) => s.language);
  const enabled = useSettings((s) => s.translateNames);
  const key = `${locale}:${text}`;
  const found = useTitles((s) => (text ? s.map[key] : undefined));
  if (!text || !enabled || !inTauri || !needsTranslation(text, locale)) return null;
  if (found === undefined && !requested.has(key)) {
    requested.add(key);
    pending.add(text);
    timer ??= setTimeout(flush, 200);
  }
  return found || null;
}

const lyricsCache = new Map<string, (string | null)[] | null>();

/** Line-by-line translation of lyrics into the UI language (null while loading or when the lyrics are already in it). */
export function useLyricsTranslation(id: string | undefined, lines: string[] | undefined): (string | null)[] | null {
  const locale = useSettings((s) => s.language);
  const enabled = useSettings((s) => s.translateLyrics);
  const key = `${locale}:${id}`;
  const [state, setState] = useState<{ key: string; tr: (string | null)[] | null }>({ key: "", tr: null });
  useEffect(() => {
    if (!enabled || !inTauri || !id || !lines?.length) return;
    if (lyricsCache.has(key)) return setState({ key, tr: lyricsCache.get(key)! });
    let live = true;
    api.translateTexts(lines, locale).then(
      (tr) => {
        const useful = tr.some(Boolean) ? tr : null;
        lyricsCache.set(key, useful);
        if (lyricsCache.size > 100) lyricsCache.delete(lyricsCache.keys().next().value!);
        if (live) setState({ key, tr: useful });
      },
      () => live && setState({ key, tr: null }),
    );
    return () => {
      live = false;
    };
    // `lines` belongs to the lyrics of `id`; keyed on the id so a new array doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, lines?.length]);
  return enabled && state.key === key ? state.tr : null;
}
