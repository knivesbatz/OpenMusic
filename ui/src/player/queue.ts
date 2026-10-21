// Pure queue operations. The playback engine (engine.ts) keeps a QueueState and only ever changes it
// through these functions, so their behavior is unit-tested in isolation (queue.test.ts).
import type { Track } from "../types";

export interface QItem {
  /** Unique per queue entry, so the same track can be queued twice and still be selected/moved. */
  uid: string;
  track: Track;
  /** Added with "Add to queue" / "Play next" (Spotify's "Next in queue") rather than from the context. */
  manual: boolean;
}

export interface QueueState {
  items: QItem[];
  /** Index of the current item, -1 when nothing is loaded. */
  index: number;
  /** Context order before shuffle, used to restore order when shuffle is turned off. */
  unshuffled: string[] | null;
}

export type Repeat = "off" | "all" | "one";

let uidCounter = 0;
export const newUid = () => `q${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

export const emptyQueue: QueueState = { items: [], index: -1, unshuffled: null };

export function toItems(tracks: Track[], manual = false): QItem[] {
  return tracks.map((track) => ({ uid: newUid(), track, manual }));
}

export function current(q: QueueState): QItem | undefined {
  return q.index >= 0 ? q.items[q.index] : undefined;
}

/** Replace the queue with a context (album, playlist, …) and start at `start`. */
export function load(tracks: Track[], start = 0, shuffle = false): QueueState {
  let items = toItems(tracks);
  const s = Math.max(0, Math.min(start, items.length - 1));
  let index = items.length ? s : -1;
  let unshuffled: string[] | null = null;
  if (shuffle && items.length > 1) {
    unshuffled = items.map((i) => i.uid);
    const first = items[index];
    const rest = items.filter((_, i) => i !== index);
    items = [first, ...shuffled(rest)];
    index = 0;
  }
  return { items, index, unshuffled };
}

/** End of the "Next in queue" block: manual items directly after the current one. */
function manualEnd(q: QueueState): number {
  let i = q.index + 1;
  while (i < q.items.length && q.items[i].manual) i++;
  return i;
}

/** Spotify "Add to queue": after the current track and any tracks queued before. */
export function enqueue(q: QueueState, tracks: Track[]): QueueState {
  const add = toItems(tracks, true);
  if (q.index < 0) return { ...q, items: [...q.items, ...add], index: q.items.length ? q.index : 0 };
  const at = manualEnd(q);
  return { ...q, items: [...q.items.slice(0, at), ...add, ...q.items.slice(at)] };
}

/** "Play next": directly after the current track. */
export function playNext(q: QueueState, tracks: Track[]): QueueState {
  const add = toItems(tracks, true);
  if (q.index < 0) return { ...q, items: [...add, ...q.items], index: 0 };
  const at = q.index + 1;
  return { ...q, items: [...q.items.slice(0, at), ...add, ...q.items.slice(at)] };
}

/** Remove entries by uid. The current item is never removed (stop playback instead). */
export function remove(q: QueueState, uids: Iterable<string>): QueueState {
  const drop = new Set(uids);
  const cur = current(q);
  if (cur) drop.delete(cur.uid);
  if (!drop.size) return q;
  const items = q.items.filter((i) => !drop.has(i.uid));
  const index = cur ? items.findIndex((i) => i.uid === cur.uid) : -1;
  const unshuffled = q.unshuffled ? q.unshuffled.filter((u) => !drop.has(u)) : null;
  return { items, index, unshuffled };
}

/** Clear everything after the current track ("Clear queue"). */
export function clearUpcoming(q: QueueState): QueueState {
  if (q.index < 0) return emptyQueue;
  const items = q.items.slice(0, q.index + 1);
  return { items, index: q.index, unshuffled: q.unshuffled ? q.unshuffled.filter((u) => items.some((i) => i.uid === u)) : null };
}

/**
 * Move the given entries so they sit before the entry that is currently at `beforeIndex`
 * (`items.length` = end). Selected entries keep their relative order. The current item can move too;
 * the index follows it, so playback never jumps.
 */
export function move(q: QueueState, uids: string[], beforeIndex: number): QueueState {
  const sel = new Set(uids);
  if (!sel.size) return q;
  const cur = current(q);
  const moving = q.items.filter((i) => sel.has(i.uid));
  const anchor = q.items.slice(beforeIndex).find((i) => !sel.has(i.uid));
  const rest = q.items.filter((i) => !sel.has(i.uid));
  const at = anchor ? rest.indexOf(anchor) : rest.length;
  const items = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  const index = cur ? items.findIndex((i) => i.uid === cur.uid) : -1;
  return { ...q, items, index };
}

/** Index to play after the current one finishes or the user presses Next. -1 = stop. */
export function nextIndex(q: QueueState, repeat: Repeat, userSkip: boolean): number {
  if (q.index < 0 || !q.items.length) return -1;
  if (repeat === "one" && !userSkip) return q.index;
  if (q.index + 1 < q.items.length) return q.index + 1;
  return repeat === "off" ? -1 : 0;
}

export function prevIndex(q: QueueState, repeat: Repeat): number {
  if (q.index > 0) return q.index - 1;
  if (repeat !== "off" && q.items.length) return q.items.length - 1;
  return q.index;
}

/** Manual items are consumed once played, like Spotify's "Next in queue". */
export function advance(q: QueueState, to: number): QueueState {
  if (to < 0 || to >= q.items.length) return q;
  const prev = current(q);
  let items = q.items;
  let index = to;
  if (prev && prev.manual && to !== q.index) {
    items = items.filter((i) => i.uid !== prev.uid);
    index = items.findIndex((i) => i.uid === q.items[to].uid);
  }
  return { ...q, items, index };
}

export function setShuffle(q: QueueState, on: boolean): QueueState {
  if (on === (q.unshuffled !== null)) return q;
  const cur = current(q);
  if (on) {
    const unshuffled = q.items.map((i) => i.uid);
    if (q.index < 0) return { ...q, items: shuffled(q.items), unshuffled };
    const head = q.items.slice(0, manualEnd(q));
    const tail = shuffled(q.items.slice(manualEnd(q)));
    return { items: [...head, ...tail], index: q.index, unshuffled };
  }
  const pos = new Map(q.unshuffled!.map((u, i) => [u, i]));
  // Manual "Next in queue" entries stay right after the current track.
  const manualAfter = q.index >= 0 ? q.items.slice(q.index + 1, manualEnd(q)) : [];
  const manualSet = new Set(manualAfter.map((i) => i.uid));
  const ordered = q.items
    .filter((i) => !manualSet.has(i.uid))
    .sort((a, b) => (pos.get(a.uid) ?? Infinity) - (pos.get(b.uid) ?? Infinity));
  const ci = cur ? ordered.findIndex((i) => i.uid === cur.uid) : -1;
  const items = ci >= 0 ? [...ordered.slice(0, ci + 1), ...manualAfter, ...ordered.slice(ci + 1)] : ordered;
  return { items, index: cur ? items.findIndex((i) => i.uid === cur.uid) : -1, unshuffled: null };
}

export function shuffled<T>(arr: T[], rnd: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Selection with Spotify/Explorer semantics. Plain click selects one item and sets the anchor,
 * Ctrl/Cmd toggles, Shift selects the range from the anchor (Ctrl+Shift adds the range).
 */
export function select(
  order: string[],
  selected: Set<string>,
  anchor: string | null,
  target: string,
  mod: { shift?: boolean; ctrl?: boolean },
): { selected: Set<string>; anchor: string | null } {
  if (mod.shift && anchor && order.includes(anchor)) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(target);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const next = mod.ctrl ? new Set(selected) : new Set<string>();
    for (let i = lo; i <= hi; i++) next.add(order[i]);
    return { selected: next, anchor };
  }
  if (mod.ctrl) {
    const next = new Set(selected);
    if (next.has(target)) next.delete(target);
    else next.add(target);
    return { selected: next, anchor: target };
  }
  return { selected: new Set([target]), anchor: target };
}
