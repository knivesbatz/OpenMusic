import { describe, expect, it } from "vitest";
import type { Album, Artist } from "../types";
import { sortAlbums, sortArtists } from "./librarySort";

const al = (id: string, title: string, artist: string, year?: number): Album => ({ id, title, artist, year });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("library sort", () => {
  const albums = [al("1", "Zebra", "The Lanterns", 2016), al("2", "apple", "Aster Vale", 2021), al("3", "Mango", "Lanterns Two"), al("4", "Kiwi", "The Lanterns", 2012)];

  it("recent keeps the library order; reversed when descending", () => {
    expect(ids(sortAlbums(albums, { key: "recent", desc: false }))).toEqual(["1", "2", "3", "4"]);
    expect(ids(sortAlbums(albums, { key: "recent", desc: true }))).toEqual(["4", "3", "2", "1"]);
  });

  it("alphabetical ignores case", () => {
    expect(ids(sortAlbums(albums, { key: "alpha", desc: false }))).toEqual(["2", "4", "3", "1"]);
  });

  it("artist ignores a leading 'The' and lists each artist's albums oldest first", () => {
    expect(ids(sortAlbums(albums, { key: "artist", desc: false }))).toEqual(["2", "4", "1", "3"]);
  });

  it("release year, newest first when descending, unknown years last", () => {
    expect(ids(sortAlbums(albums, { key: "year", desc: true }))).toEqual(["2", "1", "4", "3"]);
    expect(ids(sortAlbums(albums, { key: "year", desc: false }))).toEqual(["4", "1", "2", "3"]);
  });

  it("artists alphabetically", () => {
    const artists: Artist[] = [{ id: "a", name: "The Weeknd" }, { id: "b", name: "aurora" }, { id: "c", name: "Muse" }];
    expect(ids(sortArtists(artists, { key: "alpha", desc: false }))).toEqual(["b", "c", "a"]);
    expect(ids(sortArtists(artists, { key: "recent", desc: false }))).toEqual(["a", "b", "c"]);
  });
});
