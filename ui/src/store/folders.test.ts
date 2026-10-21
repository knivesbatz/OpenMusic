import { describe, expect, it } from "vitest";
import { arrange, detach, emptyOrg, folderKey, moveIntoFolder, moveTopLevel, sanitizeOrg, type LibraryOrg } from "./folders";

const pls = [
  { id: "p1", title: "Rainy" },
  { id: "p2", title: "Autumn" },
  { id: "p3", title: "Chill" },
];
const withFolder: LibraryOrg = { ...emptyOrg, folders: [{ id: "f", name: "Moods", items: [], open: true }] };

describe("playlist folders", () => {
  it("moves playlists into folders and keeps them out of the top level", () => {
    let o = moveIntoFolder(withFolder, "p2", "f");
    o = moveIntoFolder(o, "p1", "f", "p2");
    expect(o.folders[0].items).toEqual(["p1", "p2"]);
    expect(arrange(o, pls)).toEqual([folderKey("f"), "p3"]);
    // Moving into another position of the same folder doesn't duplicate.
    o = moveIntoFolder(o, "p2", "f", "p1");
    expect(o.folders[0].items).toEqual(["p2", "p1"]);
  });

  it("detach removes a playlist from folders and order", () => {
    const o = detach({ ...moveIntoFolder(withFolder, "p1", "f"), order: ["p1", "p3"] }, "p1");
    expect(o.folders[0].items).toEqual([]);
    expect(o.order).toEqual(["p3"]);
  });

  it("alphabetical sort includes folders by name", () => {
    expect(arrange({ ...withFolder, sort: "alpha" }, pls)).toEqual(["p2", "p3", folderKey("f"), "p1"]);
  });

  it("custom order: drag before an item, unplaced entries keep recent order after placed ones", () => {
    const shown = arrange(withFolder, pls); // [folder, p1, p2, p3]
    let o = moveTopLevel(withFolder, "p3", folderKey("f"), shown);
    expect(o.sort).toBe("custom");
    expect(arrange(o, pls)).toEqual(["p3", folderKey("f"), "p1", "p2"]);
    o = moveTopLevel(o, "p1", null, arrange(o, pls));
    expect(arrange(o, [...pls, { id: "p4", title: "New" }])).toEqual(["p3", folderKey("f"), "p2", "p1", "p4"]);
  });

  it("moving a foldered playlist to the top level takes it out of the folder", () => {
    const o1 = moveIntoFolder(withFolder, "p1", "f");
    const o2 = moveTopLevel(o1, "p1", null, arrange(o1, pls));
    expect(o2.folders[0].items).toEqual([]);
    expect(arrange(o2, pls).slice(-1)[0]).toBe("p1");
  });

  it("sanitizes stored data", () => {
    expect(sanitizeOrg(null)).toEqual(emptyOrg);
    expect(sanitizeOrg({ folders: [{ id: "x", name: "A", items: ["p1", 3 as unknown as string], open: false }], order: ["p1"], sort: "custom" })).toEqual({
      folders: [{ id: "x", name: "A", items: ["p1"], open: false }],
      order: ["p1"],
      sort: "custom",
    });
  });
});
