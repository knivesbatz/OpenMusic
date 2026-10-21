import { describe, expect, it } from "vitest";
import type { Track } from "../types";
import { needsSongMeta, patchTrack } from "./songmeta";

const video: Track = {
  id: "yt:abc",
  source: "youtube",
  title: "Welcome to the Black Parade",
  artist: "mcr",
  artwork: "art://url/https%3A%2F%2Fi.ytimg.com%2Fvi%2Fabc%2Fhqdefault.jpg",
  streamKey: "abc",
};

describe("song meta", () => {
  it("only applies to YouTube video thumbnails", () => {
    expect(needsSongMeta(video)).toBe(true);
    expect(needsSongMeta({ ...video, artwork: "art://url/https%3A%2F%2Flh3.googleusercontent.com%2Fx" })).toBe(false);
    expect(needsSongMeta({ ...video, source: "plex" })).toBe(false);
  });
  it("patches art and official artist, keeps ids and existing album", () => {
    const p = patchTrack(
      { ...video, title: "Welcome to the Black Parade (Official Music Video)", album: "Kept" },
      { title: "Welcome to the Black Parade", artwork: "art://url/sq", artist: "My Chemical Romance", artistId: "yt:UCmcr", album: "The Black Parade", albumId: "yt:MPRE" },
    );
    expect(p.id).toBe("yt:abc");
    expect(p.title).toBe("Welcome to the Black Parade");
    expect(p.artwork).toBe("art://url/sq");
    expect(p.artist).toBe("My Chemical Romance");
    expect(p.artistId).toBe("yt:UCmcr");
    expect(p.album).toBe("Kept");
    expect(patchTrack(video, {})).toEqual(video);
  });
});
