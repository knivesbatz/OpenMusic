import { describe, expect, it } from "vitest";
import { orderEpisodes, publishedAt, setOldestFirst, usePodcastSorts } from "./podcastSort";

const now = new Date(2026, 10, 4, 12);
const ep = (title: string, published: string | null) => ({ title, published });

describe("podcast episode order", () => {
  it("reads the dates providers show", () => {
    expect(new Date(publishedAt("Oct 26", now)!).toDateString()).toBe(new Date(2026, 9, 26).toDateString());
    // Without a year and later than today: last year.
    expect(new Date(publishedAt("Dec 24", now)!).getFullYear()).toBe(2025);
    expect(new Date(publishedAt("Mar 3, 2023", now)!).getFullYear()).toBe(2023);
    expect(publishedAt("3 days ago", now)).toBe(now.getTime() - 3 * 864e5);
    expect(new Date(publishedAt("2023/10/26", now)!).getMonth()).toBe(9);
    expect(new Date(publishedAt("10月26日", now)!).getDate()).toBe(26);
    expect(publishedAt("", now)).toBeNull();
    expect(publishedAt("whenever", now)).toBeNull();
  });

  it("puts the oldest first, whichever way the provider lists them", () => {
    const newestFirst = [ep("3", "Oct 23"), ep("2", "Oct 22"), ep("1", "Oct 21")];
    expect(orderEpisodes(newestFirst, true, now).map((e) => e.title)).toEqual(["1", "2", "3"]);
    expect(orderEpisodes(newestFirst, false, now)).toBe(newestFirst);
    const oldestFirst = [ep("1", "2 weeks ago"), ep("2", "1 week ago"), ep("3", "2 days ago")];
    expect(orderEpisodes(oldestFirst, true, now)).toBe(oldestFirst);
    expect(orderEpisodes(oldestFirst, false, now).map((e) => e.title)).toEqual(["3", "2", "1"]);
    // No readable dates: the provider's order counts as newest first.
    const undated = [ep("b", null), ep("a", null)];
    expect(orderEpisodes(undated, true, now).map((e) => e.title)).toEqual(["a", "b"]);
  });

  it("is remembered per show until changed", () => {
    setOldestFirst("yt:MPSPa", true);
    expect(usePodcastSorts.getState().oldest).toEqual({ "yt:MPSPa": true });
    setOldestFirst("yt:MPSPa", false);
    expect(usePodcastSorts.getState().oldest).toEqual({});
  });
});
