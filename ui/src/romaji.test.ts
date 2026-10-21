import { describe, expect, it } from "vitest";
import { displayText, toRomaji } from "./romaji";

describe("romaji", () => {
  it("converts hiragana and katakana", () => {
    expect(toRomaji("さくら")).toBe("sakura");
    expect(toRomaji("トーキョー")).toBe("tookyoo");
    expect(toRomaji("きって")).toBe("kitte");
    expect(toRomaji("しゃしん")).toBe("shashin");
    expect(toRomaji("こんや")).toBe("kon'ya");
  });
  it("respects display mode and leaves latin text alone", () => {
    expect(displayText("hello", "romaji")).toEqual(["hello", null]);
    expect(displayText("さくら", "both")).toEqual(["さくら", "sakura"]);
    expect(displayText("さくら", "original")).toEqual(["さくら", null]);
  });
});
