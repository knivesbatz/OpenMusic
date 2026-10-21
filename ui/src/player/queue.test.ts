import { describe, expect, it } from "vitest";
import type { Track } from "../types";
import * as Q from "./queue";

const tr = (n: number): Track => ({ id: `plex:${n}`, source: "plex", title: `T${n}`, artist: "A" });
const ids = (q: Q.QueueState) => q.items.map((i) => i.track.id);
const titles = (q: Q.QueueState) => q.items.map((i) => i.track.title);

describe("queue", () => {
  it("loads a context at the requested start", () => {
    const q = Q.load([tr(1), tr(2), tr(3)], 1);
    expect(q.index).toBe(1);
    expect(Q.current(q)!.track.id).toBe("plex:2");
  });

  it("add to queue goes after current and earlier queued tracks (Next in queue)", () => {
    let q = Q.load([tr(1), tr(2), tr(3)], 0);
    q = Q.enqueue(q, [tr(10)]);
    q = Q.enqueue(q, [tr(11)]);
    expect(titles(q)).toEqual(["T1", "T10", "T11", "T2", "T3"]);
    q = Q.playNext(q, [tr(12)]);
    expect(titles(q)).toEqual(["T1", "T12", "T10", "T11", "T2", "T3"]);
  });

  it("manual entries are consumed once played", () => {
    let q = Q.enqueue(Q.load([tr(1), tr(2)], 0), [tr(10)]);
    q = Q.advance(q, Q.nextIndex(q, "off", true)); // -> T10
    expect(Q.current(q)!.track.title).toBe("T10");
    q = Q.advance(q, Q.nextIndex(q, "off", true)); // -> T2, T10 removed
    expect(titles(q)).toEqual(["T1", "T2"]);
    expect(Q.current(q)!.track.title).toBe("T2");
  });

  it("remove never drops the current track and keeps the index on it", () => {
    let q = Q.load([tr(1), tr(2), tr(3), tr(4)], 2);
    const uids = q.items.map((i) => i.uid);
    q = Q.remove(q, [uids[0], uids[2], uids[3]]);
    expect(titles(q)).toEqual(["T2", "T3"]);
    expect(Q.current(q)!.track.title).toBe("T3");
  });

  it("move keeps relative order of a multi-selection and follows the current item", () => {
    let q = Q.load([tr(1), tr(2), tr(3), tr(4), tr(5)], 1);
    const u = q.items.map((i) => i.uid);
    q = Q.move(q, [u[3], u[4]], 0);
    expect(titles(q)).toEqual(["T4", "T5", "T1", "T2", "T3"]);
    expect(Q.current(q)!.track.title).toBe("T2");
    q = Q.move(q, [q.items[0].uid], q.items.length);
    expect(titles(q)).toEqual(["T5", "T1", "T2", "T3", "T4"]);
  });

  it("repeat modes", () => {
    const q = Q.load([tr(1), tr(2)], 1);
    expect(Q.nextIndex(q, "off", false)).toBe(-1);
    expect(Q.nextIndex(q, "all", false)).toBe(0);
    expect(Q.nextIndex(q, "one", false)).toBe(1);
    // A manual skip during repeat-one ends the queue unless repeat-all would wrap.
    expect(Q.nextIndex(q, "one", true)).toBe(0);
  });

  it("shuffle keeps current first and restores original order", () => {
    const tracks = Array.from({ length: 20 }, (_, i) => tr(i));
    let q = Q.load(tracks, 5);
    q = Q.setShuffle(q, true);
    expect(Q.current(q)!.track.id).toBe("plex:5");
    expect(new Set(ids(q))).toEqual(new Set(tracks.map((t) => t.id)));
    q = Q.setShuffle(q, false);
    expect(ids(q)).toEqual(tracks.map((t) => t.id));
    expect(Q.current(q)!.track.id).toBe("plex:5");
  });

  it("shift-click selects ranges, ctrl toggles", () => {
    const order = ["a", "b", "c", "d", "e"];
    let s = Q.select(order, new Set(), null, "b", {});
    s = Q.select(order, s.selected, s.anchor, "d", { shift: true });
    expect([...s.selected]).toEqual(["b", "c", "d"]);
    s = Q.select(order, s.selected, s.anchor, "c", { ctrl: true });
    expect([...s.selected].sort()).toEqual(["b", "d"]);
    s = Q.select(order, s.selected, s.anchor, "a", { shift: true });
    expect([...s.selected]).toEqual(["a", "b", "c"]);
  });

  it("clear queue keeps history and current", () => {
    let q = Q.enqueue(Q.load([tr(1), tr(2), tr(3)], 1), [tr(9)]);
    q = Q.clearUpcoming(q);
    expect(titles(q)).toEqual(["T1", "T2"]);
  });

  it("autoplay extends the context after the last track and plays on", () => {
    let q = Q.load([tr(1), tr(2)], 1);
    expect(Q.nextIndex(q, "off", false)).toBe(-1);
    q = Q.extend(q, [tr(7), tr(8)]);
    expect(titles(q)).toEqual(["T1", "T2", "T7", "T8"]);
    expect(Q.nextIndex(q, "off", false)).toBe(2);
    // With shuffle on, turning it off keeps the autoplay songs at the end.
    const sh = Q.extend(Q.load([tr(1), tr(2), tr(3)], 0, true), [tr(7)]);
    expect(titles(Q.setShuffle(sh, false))).toEqual(["T1", "T2", "T3", "T7"]);
  });
});
