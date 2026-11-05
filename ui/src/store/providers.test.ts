import { beforeEach, describe, expect, it } from "vitest";
import type { AppInfo, Capabilities, Track } from "../types";
import { useApp } from "./app";
import { allOffline, caps, capsFor, needsReconnect, playable, sourceOf, usable } from "./providers";

const none: Capabilities = { downloads: false, qualityControl: false, podcasts: false, crossfade: false, gapless: false, favorites: false };
const info: AppInfo = {
  name: "OpenSpot",
  version: "2.0.0",
  providers: { youtube: { ...none, podcasts: true, favorites: true }, plex: { ...none, downloads: true, qualityControl: true, favorites: true } },
  services: { youtube: false, plex: false },
  discordPresence: true,
};
const track = (id: string, source: Track["source"]): Track => ({ id, source, title: id, artist: "A" });
const signedIn = { signedIn: true, needsServer: false };
const signedOut = { signedIn: false, needsServer: false };

function setUp(youtube: boolean, plex: boolean, plexAuth = signedIn) {
  useApp.setState({ info, services: { youtube, plex }, auth: { youtube: signedOut, plex: plexAuth }, online: { youtube: true, plex: true }, downloaded: new Set() });
}

describe("providers", () => {
  beforeEach(() => setUp(true, true));

  it("tells the source by the id prefix", () => {
    expect(sourceOf("yt:abc")).toBe("youtube");
    expect(sourceOf("plex:12")).toBe("plex");
    expect(sourceOf("plex-genre:5")).toBe("plex");
    expect(sourceOf("local:ff")).toBe("local");
    expect(sourceOf("local-album:A\u001fB")).toBe("local");
    expect(sourceOf("app:1")).toBe("app");
    expect(sourceOf("plexx:1")).toBeNull();
  });

  it("capabilities combine the services that are on; Discord doesn't depend on them", () => {
    expect(caps()).toMatchObject({ downloads: true, podcasts: true, favorites: true, discordPresence: true });
    setUp(true, false);
    expect(caps()).toMatchObject({ downloads: false, qualityControl: false, podcasts: true, discordPresence: true });
    setUp(false, false);
    expect(caps()).toMatchObject({ favorites: false, podcasts: false, discordPresence: true });
    expect(capsFor("plex:1").downloads).toBe(false);
    setUp(false, true);
    expect(capsFor("plex:1").downloads).toBe(true);
    expect(capsFor("local:1").downloads).toBe(false);
  });

  it("tracks of a service that is off can't play; local files and downloads always can", () => {
    expect(playable(track("yt:a", "youtube"))).toBe(true);
    expect(playable(track("plex:1", "plex"))).toBe(true);
    setUp(false, false);
    expect(playable(track("yt:a", "youtube"))).toBe(false);
    expect(playable(track("plex:1", "plex"))).toBe(false);
    expect(playable(track("local:1", "local"))).toBe(true);
    useApp.setState({ downloaded: new Set(["plex:1"]) });
    expect(playable(track("plex:1", "plex"))).toBe(true);
    // Plex on but its server is gone: only downloads play.
    setUp(false, true, { signedIn: true, needsServer: true });
    expect(playable(track("plex:2", "plex"))).toBe(false);
  });

  it("YouTube works without an account; Plex needs one", () => {
    setUp(true, false);
    expect(usable("youtube")).toBe(true);
    expect(needsReconnect()).toBe(false);
    setUp(false, true, signedOut);
    expect(usable("plex")).toBe(false);
    expect(needsReconnect()).toBe(true);
    setUp(false, false);
    expect(needsReconnect()).toBe(false);
  });

  it("the offline pill needs every service that is on to be offline", () => {
    useApp.setState({ online: { youtube: true, plex: false } });
    expect(allOffline()).toBe(false);
    useApp.setState({ online: { youtube: false, plex: false } });
    expect(allOffline()).toBe(true);
    setUp(false, true);
    useApp.setState({ online: { youtube: true, plex: false } });
    expect(allOffline()).toBe(true);
    setUp(false, false);
    useApp.setState({ online: { youtube: false, plex: false } });
    expect(allOffline()).toBe(false);
  });
});
