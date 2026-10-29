import { describe, expect, it } from "vitest";
import type { Album } from "../types";
import { albumKey, newestFirst, splitCompilations } from "./discography";

const al = (title: string, year: number | null, kind = "album"): Album => ({ id: title, title, artist: "Weezer", year, kind });

describe("discography", () => {
  it("sorts newest first, keeping the provider's order on ties and undated albums last", () => {
    const sorted = newestFirst([al("Blue", 1994), al("Undated", null), al("1192", 2026), al("Weezer", 2026), al("Green", 2001)]);
    expect(sorted.map((a) => a.title)).toEqual(["1192", "Weezer", "Green", "Blue", "Undated"]);
  });

  it("files compilations from the provider, MusicBrainz and telling titles", () => {
    const { albums, compilations } = splitCompilations(
      [al("Pinkerton", 1996), al("Death to False Metal", 2010), al("Greatest Hits", 2004), al("Hits Live", 2000, "compilation"), al("Weezer (Blue Album)", 1994)],
      ["Death To False Metal (Deluxe)"],
    );
    expect(albums.map((a) => a.title)).toEqual(["Pinkerton", "Weezer (Blue Album)"]);
    expect(compilations.map((a) => a.title)).toEqual(["Death to False Metal", "Greatest Hits", "Hits Live"]);
    expect(compilations.every((a) => a.kind === "compilation")).toBe(true);
  });

  it("compares titles without edition suffixes and punctuation", () => {
    expect(albumKey("Death to False Metal (Deluxe Edition)")).toBe("death to false metal");
    expect(albumKey("Everything Will Be Alright in the End [Remastered]")).toBe("everything will be alright in the end");
    expect(albumKey("Make Believe!")).toBe("make believe");
  });
});
