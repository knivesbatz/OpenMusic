import { describe, expect, it } from "vitest";
import { normalizeGain } from "./loudness";

describe("normalizeGain", () => {
  it("turns loud songs down to the target", () => {
    // -8 LUFS at the Normal target (-14): 6 dB down.
    expect(normalizeGain(-8, "normal")).toBeCloseTo(0.501, 3);
    expect(normalizeGain(-11, "loud")).toBe(1);
    expect(normalizeGain(-13, "quiet")).toBeCloseTo(0.316, 3);
  });

  it("never boosts, never goes silent, and leaves unknown songs alone", () => {
    expect(normalizeGain(-20, "normal")).toBe(1);
    expect(normalizeGain(10, "quiet")).toBe(0.1);
    expect(normalizeGain(null, "normal")).toBe(1);
    expect(normalizeGain(NaN, "normal")).toBe(1);
  });
});
