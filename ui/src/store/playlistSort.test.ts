import { describe, expect, it } from "vitest";
import type { Track } from "../types";
import { sortTracks } from "./playlistSort";

const tr = (id: string, o: Partial<Track>): Track => ({ id, source: "local", title: id, artist: "", ...o });
const ids = (rows: { track: Track }[]) => rows.map((r) => r.track.id);

describe("sortTracks", () => {
  const list = [
    tr("c", { title: "Cherry", artist: "Zed", album: "B", trackNumber: 2, durationMs: 300, addedAt: 3 }),
    tr("a", { title: "apple", artist: "Amy", album: "X", durationMs: 100, addedAt: 1 }),
    tr("b", { title: "Banana", artist: "Zed", album: "B", trackNumber: 1, durationMs: 200 }),
  ];

  it("custom keeps the playlist order and reports original indices", () => {
    const rows = sortTracks(list, { key: "custom", desc: false });
    expect(ids(rows)).toEqual(["c", "a", "b"]);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("title ignores case; descending reverses", () => {
    expect(ids(sortTracks(list, { key: "title", desc: false }))).toEqual(["a", "b", "c"]);
    expect(ids(sortTracks(list, { key: "title", desc: true }))).toEqual(["c", "b", "a"]);
  });

  it("artist keeps each album in track order", () => {
    expect(ids(sortTracks(list, { key: "artist", desc: false }))).toEqual(["a", "b", "c"]);
  });

  it("missing values sort last", () => {
    expect(ids(sortTracks(list, { key: "added", desc: true }))).toEqual(["c", "a", "b"]);
    expect(ids(sortTracks(list, { key: "year", desc: false }))).toEqual(["c", "a", "b"]);
  });

  it("does not modify the input", () => {
    sortTracks(list, { key: "duration", desc: true });
    expect(ids(list.map((track) => ({ track })))).toEqual(["c", "a", "b"]);
  });
});
