import { describe, expect, it } from "vitest";
import { localError, translate } from "./i18n";
import { useSettings } from "./store/settings";

describe("localError", () => {
  it("translates the core's service error codes and never shows their English text", () => {
    useSettings.setState({ language: "ja" });
    const disabled = { code: "disabled", message: "Plex is turned off in Settings", provider: "plex" };
    expect(localError(disabled)).toBe(translate("ja", "serviceDisabled", { service: "Plex" }));
    expect(localError(disabled)).not.toContain("turned off");
    expect(localError(disabled)).toContain("Plex");
    useSettings.setState({ language: "en" });
    expect(localError(disabled)).toBe("Plex is turned off in Settings → Services.");
    expect(localError({ code: "authExpired", message: "session expired", provider: "youtube" })).toBe("YouTube Music: your session expired. Sign in again in Settings → Services.");
    // A code with no provider of its own takes the one the caller knows (a search part).
    expect(localError({ code: "offline", message: "server unavailable: x" }, "plex")).toBe("Plex can't be reached right now.");
    expect(localError({ code: "notSignedIn", message: "not signed in" }, "plex")).toBe("Sign in to Plex to do this.");
    // Anything else: the core's message.
    expect(localError({ code: "notFound", message: "not found: x" })).toBe("not found: x");
    expect(localError({ code: "offline", message: "server unavailable: x" })).toBe("server unavailable: x");
  });
});
