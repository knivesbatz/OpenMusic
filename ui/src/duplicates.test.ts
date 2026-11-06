import { describe, expect, it } from "vitest";
import { duplicatesIn, songKey, uniqueSongs } from "./duplicates";

const s = (id: string, title: string, artist = "Aster Vale") => ({ id, title, artist });

describe("songKey / duplicatesIn", () => {
  it("matches the same id, or the same title and main artist however spelled", () => {
    const existing = [s("yt:1", "Slow Lights"), s("plex:2", "Harbor")];
    const adds = [s("yt:1", "Renamed"), s("plex:9", "SLOW LIGHTS!", "Aster Vale feat. Someone"), s("yt:3", "Harbor", "Other"), s("yt:4", "New")];
    expect(duplicatesIn(existing, adds).map((x) => x.id)).toEqual(["yt:1", "plex:9"]);
    expect(songKey(s("x", "ＳＯＮＧ"))).toBe(songKey(s("y", "song!")));
  });

  it("never matches untagged songs by title alone", () => {
    const existing = [s("local:a", "Intro", ""), s("local:b", "Track 01", "  ")];
    const adds = [s("local:c", "Intro", ""), s("local:d", "Track 01", "!!"), s("local:a", "Intro", "")];
    expect(songKey(adds[0])).toBe("");
    expect(duplicatesIn(existing, adds).map((x) => x.id)).toEqual(["local:a"]);
  });
});

describe("uniqueSongs", () => {
  it("keeps the first of each song within a batch", () => {
    const batch = [s("yt:1", "Slow Lights"), s("yt:1", "Slow Lights"), s("plex:1", "slow lights"), s("yt:2", "Harbor"), s("local:x", "Intro", ""), s("local:y", "Intro", "")];
    expect(uniqueSongs(batch).map((x) => x.id)).toEqual(["yt:1", "yt:2", "local:x", "local:y"]);
  });
});
