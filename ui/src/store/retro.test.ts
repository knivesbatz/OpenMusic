import { describe, expect, it } from "vitest";
import type { Album, ArtistPage, Track } from "../types";
import { cutoffFor, datesWanted, releasedBy, retroArtist } from "./retro";

describe("Windows 95 theme cutoff", () => {
  it("is today's date 28 years ago, moving a day each day", () => {
    expect(cutoffFor(new Date(2026, 10, 3))).toBe("1998-11-03");
    expect(cutoffFor(new Date(2026, 10, 4))).toBe("1998-11-04");
    expect(cutoffFor(new Date(2027, 0, 1))).toBe("1999-01-01");
    expect(cutoffFor(new Date(2028, 1, 29))).toBe("2000-02-29");
    expect(cutoffFor(new Date(2029, 2, 1))).toBe("2001-03-01");
  });

  it("keeps only releases out by the cutoff", () => {
    const cut = "1998-11-03";
    expect(releasedBy({ released: "1998-11-03" }, cut)).toBe(true);
    expect(releasedBy({ released: "1998-11-04" }, cut)).toBe(false);
    expect(releasedBy({ released: "1998-11" }, cut)).toBe(false);
    expect(releasedBy({ released: "1998-10" }, cut)).toBe(true);
    expect(releasedBy({ released: "1998" }, cut)).toBe(false);
    expect(releasedBy({ year: 1997 }, cut)).toBe(true);
    expect(releasedBy({ year: 1998 }, cut)).toBe(false);
    expect(releasedBy({ year: 2024, released: null }, cut)).toBe(false);
    expect(releasedBy({ year: 1990, released: "2003-05-01" }, cut)).toBe(false);
    expect(releasedBy({}, cut)).toBe(false);
  });
});

describe("artist pages in the Windows 95 theme", () => {
  const al = (id: string, year: number | null, released: string | null = null): Album => ({ id, title: id, artist: "A", year, released });
  const tr = (id: string, albumId: string | null, year: number | null = null, album: string | null = null): Track =>
    ({ id, source: "youtube", title: id, artist: "A", albumId, album, year }) as Track;
  const page: ArtistPage = {
    topTracks: [tr("old song", "Spacy"), tr("new song", "Reissue"), tr("dated by year", null, 1985), tr("mb dated", null, null, "Late One"), tr("unknown", null)],
    albums: [al("Spacy", 1976), al("Reissue", 2021), al("Late One", 1998), al("Early One", 1998)],
    singles: [al("Single", 1998, "1998-11-04"), al("Older single", 1998, "1998-02-01")],
    appearsOn: [al("Guest", 2003)],
    related: [],
  };

  it("leaves the page alone when the theme is off", () => {
    expect(retroArtist(page, null, {})).toBe(page);
  });

  it("hides songs and releases from after the cutoff", () => {
    const v = retroArtist(page, "1998-11-03", { "Late One": "1998-12-01", "Early One": "1998-03-14" });
    expect(v.albums.map((a) => a.id)).toEqual(["Spacy", "Early One"]);
    expect(v.albums[1].released).toBe("1998-03-14");
    expect(v.singles.map((a) => a.id)).toEqual(["Older single"]);
    expect(v.appearsOn).toEqual([]);
    // Songs with no date anywhere are left out; YouTube gives most songs none.
    expect(v.topTracks.map((t) => t.id)).toEqual(["old song", "dated by year"]);
    // A song MusicBrainz dates by its own title.
    expect(retroArtist(page, "1998-11-03", { unknown: "1983-06-08" }).topTracks.map((t) => t.id)).toEqual(["old song", "dated by year", "unknown"]);
    // The next day the November 4 single is out.
    expect(retroArtist(page, "1998-11-04", {}).singles.map((a) => a.id)).toEqual(["Single", "Older single"]);
  });

  it("never lets a same-titled older release make a newer one look old", () => {
    const p: ArtistPage = { ...page, albums: [al("Akina", 2017), al("Fixer", 2015)], singles: [], appearsOn: [], topTracks: [] };
    // MusicBrainz has a 1993 compilation called "AKINA": not this 2017 album.
    expect(retroArtist(p, "1998-11-03", { Akina: "1993-11-10", Fixer: "2015-12-30" }).albums).toEqual([]);
    // Every Weezer album is "Weezer (… Album)", and they all match MusicBrainz's 1994 "Weezer".
    const w: ArtistPage = {
      ...p,
      albums: [al("Weezer", 2026), al("Weezer (Black Album)", 2019), al("Weezer (Green Album)", 2001), al("Pinkerton", 1996), al("Weezer (Blue Album)", 1994)],
    };
    const wDates = { Weezer: "1994-05-10", "Weezer (Black Album)": "1994-05-10", "Weezer (Green Album)": "1994-05-10", Pinkerton: "1996-09-24", "Weezer (Blue Album)": "1994-05-10" };
    expect(retroArtist(w, "1998-11-03", wDates).albums.map((a) => a.id)).toEqual(["Pinkerton", "Weezer (Blue Album)"]);
    // Same year: the date narrows it down to the day.
    const q: ArtistPage = { ...p, albums: [al("Early", 1998), al("Late", 1998)] };
    expect(retroArtist(q, "1998-11-03", { Early: "1998-03-04", Late: "1998-12-01" }).albums.map((a) => a.id)).toEqual(["Early"]);
  });

  it("asks for dates only where the year doesn't settle it", () => {
    expect(datesWanted(page, null)).toEqual([]);
    expect(datesWanted(page, "1998-11-03")).toEqual(["Reissue", "Late One", "Early One", "Guest", "new song", "mb dated", "unknown"]);
  });
});
