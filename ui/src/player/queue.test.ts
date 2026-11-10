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

  it("a list's play button with shuffle on starts on a random song, not always the first", () => {
    const list = [tr(1), tr(2), tr(3), tr(4)];
    const q = Q.load(list, null, true, undefined, () => 0.6);
    expect(Q.current(q)!.track.id).toBe("plex:3");
    expect(q.index).toBe(0);
    expect([...ids(q)].sort()).toEqual(list.map((x) => x.id).sort());
    // Only playable songs are picked.
    const q2 = Q.load(list, null, true, (t) => t.id === "plex:4", () => 0);
    expect(Q.current(q2)!.track.id).toBe("plex:4");
    // Shuffle off: from the top. A chosen song still starts first with shuffle on.
    expect(Q.current(Q.load(list, null, false))!.track.id).toBe("plex:1");
    expect(Q.current(Q.load(list, 1, true))!.track.id).toBe("plex:2");
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

  describe("tracks that can't play (their service is off)", () => {
    const yt = (n: number): Track => ({ id: `yt:v${n}`, source: "youtube", title: `Y${n}`, artist: "A" });
    // YouTube is switched off.
    const ok: Q.Playable = (t) => !t.id.startsWith("yt:");

    it("next and previous skip them, both ways", () => {
      const q = Q.load([tr(1), yt(2), yt(3), tr(4)], 0, false, ok);
      expect(Q.nextIndex(q, "off", true, ok)).toBe(3);
      const at4 = Q.advance(q, 3);
      expect(Q.prevIndex(at4, "off", ok)).toBe(0);
      // The end of the queue: stop, or wrap past the skipped ones with repeat all.
      expect(Q.nextIndex(at4, "off", false, ok)).toBe(-1);
      expect(Q.nextIndex(at4, "all", false, ok)).toBe(0);
      expect(Q.prevIndex(q, "all", ok)).toBe(3);
      // Nothing playable before the first track: restart it.
      expect(Q.prevIndex(q, "off", ok)).toBe(0);
    });

    it("load starts at the next track that can play", () => {
      const q = Q.load([tr(1), yt(2), tr(3)], 1, false, ok);
      expect(Q.current(q)!.track.id).toBe("plex:3");
      // Past the end it wraps to the start.
      expect(Q.current(Q.load([tr(1), yt(2)], 1, false, ok))!.track.id).toBe("plex:1");
      // With shuffle the playable start still comes first.
      expect(Q.current(Q.load([yt(1), tr(2), yt(3), tr(4)], 0, true, ok))!.track.id).toBe("plex:2");
    });

    it("nothing playable: -1, whatever the repeat mode", () => {
      const q = Q.load([yt(1), yt(2), yt(3)], 0, false, ok);
      expect(q.index).toBe(-1);
      expect(q.items).toHaveLength(3);
      expect(Q.current(q)).toBeUndefined();
      // A queue restored with every track disabled (current one included).
      const restored: Q.QueueState = { items: Q.toItems([yt(1), yt(2)]), index: 0, unshuffled: null };
      for (const r of ["off", "all", "one"] as Q.Repeat[]) {
        expect(Q.nextIndex(restored, r, false, ok)).toBe(-1);
        expect(Q.nextIndex(restored, r, true, ok)).toBe(-1);
      }
    });

    it("repeat one replays the current track only while it can play", () => {
      const q = Q.load([tr(1), tr(2)], 0, false, ok);
      expect(Q.nextIndex(q, "one", false, ok)).toBe(0);
      expect(Q.nextIndex(q, "one", false, () => false)).toBe(-1);
      // Repeat all with one playable track: it plays again.
      const single = Q.load([tr(1), yt(2)], 0, false, ok);
      expect(Q.nextIndex(single, "all", false, ok)).toBe(0);
    });

    it("a manual queue item from a disabled service is skipped, and stays queued", () => {
      let q = Q.enqueue(Q.load([tr(1), tr(2)], 0, false, ok), [yt(9)]);
      expect(titles(q)).toEqual(["T1", "Y9", "T2"]);
      const i = Q.nextIndex(q, "off", true, ok);
      expect(q.items[i].track.title).toBe("T2");
      q = Q.advance(q, i);
      expect(Q.current(q)!.track.title).toBe("T2");
      expect(titles(q)).toEqual(["T1", "Y9", "T2"]);
    });
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
