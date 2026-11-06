// Spotify's "Already added": which songs a playlist holds already (actions.ts skipDuplicates).

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();

interface Song {
  id: string;
  title?: string;
  artist?: string;
}

/** Title and first-named artist, folded so "Song", "song!" and "ＳＯＮＧ" match. "" (only the same
 * id counts) when the title or the artist has no letters to compare: untagged files called "Intro"
 * are not one song. */
export function songKey(x: Song): string {
  const title = fold(x.title ?? "");
  const artist = fold((x.artist ?? "").split(/,|&|、|\s(?:feat\.?|ft\.?|featuring)\s/i)[0]);
  return title && artist ? title + "\u001f" + artist : "";
}

/** The songs of `tracks` a playlist already holds: the same id, or the same title and main artist. */
export function duplicatesIn<T extends Song>(existing: Song[], tracks: T[]): T[] {
  const ids = new Set(existing.map((x) => x.id));
  const keys = new Set(existing.map(songKey).filter(Boolean));
  return tracks.filter((x) => ids.has(x.id) || keys.has(songKey(x)));
}

/** `tracks` with each song once (by id, or title and main artist), the first of each kept. */
export function uniqueSongs<T extends Song>(tracks: T[]): T[] {
  const ids = new Set<string>();
  const keys = new Set<string>();
  return tracks.filter((x) => {
    const k = songKey(x);
    if (ids.has(x.id) || (k && keys.has(k))) return false;
    ids.add(x.id);
    if (k) keys.add(k);
    return true;
  });
}
