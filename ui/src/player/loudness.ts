// Volume normalization (Spotify's "Normalize volume"): the gain that brings a song to a target
// loudness. Pure, so it is unit-tested.
import type { NormalizeLevel } from "../store/settings";

/** Target loudness for each level, like Spotify (LUFS). */
export const NORMALIZE_TARGET: Record<NormalizeLevel, number> = { quiet: -23, normal: -14, loud: -11 };

/**
 * Volume factor (0.1–1) for a song measured at `lufs`. Only turns songs down: an <audio> element
 * can't go above full volume, so loud masters drop to the target and quieter ones stay as they are.
 * Unknown loudness plays unchanged.
 */
export function normalizeGain(lufs: number | null | undefined, level: NormalizeLevel): number {
  if (lufs == null || !Number.isFinite(lufs)) return 1;
  const target = NORMALIZE_TARGET[level] ?? NORMALIZE_TARGET.normal;
  return Math.max(0.1, Math.min(1, 10 ** ((target - lufs) / 20)));
}
