import { describe, expect, it } from "vitest";
import { emptyResults, interleave, isEmptyResults, matchClass, mergeSearch, partErrors, pickTop } from "./searchMerge";
import type { MediaItem, Playlist, SearchResults, Track } from "./types";

const track = (id: string, title: string, source: Track["source"] = id.startsWith("plex:") ? "plex" : id.startsWith("yt:") ? "youtube" : "local"): Track => ({
  id,
  source,
  title,
  artist: "A",
});
const pl = (id: string, title: string, local = false): Playlist => ({ id, title, local });
const res = (p: Partial<SearchResults>): SearchResults => ({ ...emptyResults(), ...p });
const artist = (id: string, name: string): MediaItem => ({ type: "artist", id, name });
const album = (id: string, title: string): MediaItem => ({ type: "album", id, title, artist: "A" });

describe("matchClass", () => {
  it("ranks exact, prefix, contains, none, case-insensitively", () => {
    expect(matchClass(artist("yt:1", "Daft Punk"), "daft punk")).toBe(0);
    expect(matchClass(artist("yt:1", "Daft Punk"), "  DAFT ")).toBe(1);
    expect(matchClass(album("yt:1", "Best of Daft Punk"), "daft")).toBe(2);
    expect(matchClass(album("yt:1", "Homework"), "daft")).toBe(3);
    expect(matchClass(null, "daft")).toBe(4);
  });
});

describe("interleave", () => {
  it("alternates and keeps the longer list's rest", () => {
    expect(interleave<number | string>([1, 2, 3], ["a"])).toEqual([1, "a", 2, 3]);
    expect(interleave([], ["a", "b"])).toEqual(["a", "b"]);
    expect(interleave([1], [])).toEqual([1]);
  });
});

describe("pickTop", () => {
  it("takes the better match, Plex on a tie, the only one otherwise", () => {
    const ytExact = artist("yt:a", "Muse");
    const plexPrefix = album("plex:b", "Muse Live");
    const plexExact = artist("plex:c", "muse");
    expect(pickTop("muse", ytExact, plexPrefix)).toBe(ytExact);
    expect(pickTop("muse", ytExact, plexExact)).toBe(plexExact);
    expect(pickTop("muse", null, plexPrefix)).toBe(plexPrefix);
    expect(pickTop("muse", ytExact, undefined)).toBe(ytExact);
    expect(pickTop("muse", null, null)).toBeNull();
  });
});

describe("mergeSearch", () => {
  it("keeps a single provider's answer as it is (its own Top result, its order)", () => {
    const yt = res({ top: album("yt:x", "Something else"), tracks: [track("yt:1", "One"), track("yt:2", "Two")], playlists: [pl("yt:PL1", "Mix")] });
    const r = mergeSearch("one", { youtube: yt });
    expect(r.top).toBe(yt.top);
    expect(r.tracks.map((t) => t.id)).toEqual(["yt:1", "yt:2"]);
    expect(r.playlists.map((p) => p.id)).toEqual(["yt:PL1"]);
    expect(partErrors(r)).toEqual([]);
  });

  it("interleaves both providers, led by the provider of the Top result", () => {
    const yt = res({ top: artist("yt:a", "Muse"), tracks: [track("yt:1", "a"), track("yt:2", "b")], albums: [] });
    const plex = res({ top: album("plex:b", "Muse Live"), tracks: [track("plex:1", "c"), track("plex:2", "d"), track("plex:3", "e")] });
    const r = mergeSearch("muse", { youtube: yt, plex });
    expect(r.top).toBe(yt.top);
    expect(r.tracks.map((t) => t.id)).toEqual(["yt:1", "plex:1", "yt:2", "plex:2", "plex:3"]);
  });

  it("gives a tie to Plex, which then leads the sections", () => {
    const yt = res({ top: artist("yt:a", "Muse"), artists: [{ id: "yt:a", name: "Muse" }] });
    const plex = res({ top: artist("plex:a", "MUSE"), artists: [{ id: "plex:a", name: "MUSE" }] });
    const r = mergeSearch("muse", { youtube: yt, plex });
    expect(r.top).toBe(plex.top);
    expect(r.artists.map((a) => a.id)).toEqual(["plex:a", "yt:a"]);
  });

  it("starts with Plex when neither provider has a Top result", () => {
    const r = mergeSearch("q", { youtube: res({ albums: [{ id: "yt:1", title: "x", artist: "a" }] }), plex: res({ albums: [{ id: "plex:1", title: "y", artist: "a" }] }) });
    expect(r.top).toBeNull();
    expect(r.albums.map((a) => a.id)).toEqual(["plex:1", "yt:1"]);
  });

  it("adds local files after the providers and app playlists before them", () => {
    const yt = res({ tracks: [track("yt:1", "a")], playlists: [pl("yt:PL1", "Road")], artists: [{ id: "yt:a", name: "Road" }] });
    const local = res({ tracks: [track("local:1", "Road", "local")], playlists: [pl("app:1", "Road trip", true)], artists: [{ id: "local-artist:Road", name: "Road" }] });
    const r = mergeSearch("road", { youtube: yt, local });
    expect(r.tracks.map((t) => t.id)).toEqual(["yt:1", "local:1"]);
    expect(r.playlists.map((p) => p.id)).toEqual(["app:1", "yt:PL1"]);
    expect(r.artists.map((a) => a.id)).toEqual(["yt:a", "local-artist:Road"]);
  });

  it("works with local results only (no service on) and before any part arrived", () => {
    const local = res({ tracks: [track("local:1", "Song", "local")] });
    expect(mergeSearch("song", { local }).tracks).toHaveLength(1);
    expect(isEmptyResults(mergeSearch("song", {}))).toBe(true);
  });

  it("collects the errors of failed parts", () => {
    const yt = res({ tracks: [track("yt:1", "a")] });
    const r = mergeSearch("a", { youtube: yt, plex: null }, [{ provider: "plex", code: "offline" }]);
    expect(r.tracks).toHaveLength(1);
    expect(partErrors(r)).toEqual([{ provider: "plex", code: "offline" }]);
  });
});
