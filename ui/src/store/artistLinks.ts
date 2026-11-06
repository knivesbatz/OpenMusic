// Which artists on screen are the same artist on several sources (YouTube Music, Plex, local
// files), as confirmed by the backend (`artist_links`, `artist_link_check`). Lists show those once
// (searchMerge.dedupeArtists). Without both services on, the backend confirms nothing.
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { create } from "zustand";
import { api, inTauri } from "../api";
import { linkCandidates } from "../searchMerge";
import type { Artist } from "../types";

type Link = [string, string];
export const useArtistLinks = create<{ links: Link[] }>(() => ({ links: [] }));

/** Every artist id asked about this session (newest last, at most 500). */
let seen: string[] = [];
let listening = false;

async function refresh() {
  try {
    const links = await api.artistLinks(seen);
    useArtistLinks.setState({ links });
  } catch {
    /* keep the last answer */
  }
}

/** Ask about the artists in a list: known links at once, and a background check of the names
 * another source also lists (a later `artist-links-changed` brings the answer). */
export function requestLinks(xs: Pick<Artist, "id" | "name">[]) {
  if (!xs.length) return;
  const fresh = xs.map((a) => a.id).filter((id) => !seen.includes(id));
  if (fresh.length) seen = [...seen, ...fresh].slice(-500);
  if (!listening && inTauri) {
    listening = true;
    listen("artist-links-changed", () => void refresh()).catch(() => {});
  }
  void refresh();
  const check = linkCandidates(xs);
  if (check.length) api.artistLinkCheck(check).catch(() => {});
}

/** Request links for a list whenever its artists change. */
export function useLinkRequest(xs: Pick<Artist, "id" | "name">[] | null | undefined) {
  const key = (xs ?? []).map((a) => a.id).join("\n");
  useEffect(() => {
    if (xs?.length) requestLinks(xs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
