// UI smoke tests against the production build with a mock backend (no real provider accounts).
// Run: npm run build && npm run e2e
// Env: CHROMIUM=/path/to/chromium to use a preinstalled browser.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { chromium } from "playwright";

const mock = fileURLToPath(new URL("./mock-backend.js", import.meta.url));
const ytOverrides = fileURLToPath(new URL("./yt-overrides.js", import.meta.url));
const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: "error" });
const base = "http://localhost:4174/";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const results = [];

/** Rejects after `ms`: a crashed renderer can leave a Playwright call waiting forever. */
const within = (ms, p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);

/** Settings is in the profile picture's menu (Spotify's top bar). */
async function openSettings(p) {
  await p.locator(".avatar-btn").first().click();
  // Phones open the account drawer, desktop the menu under the picture.
  await p.locator(".drawer .drawer-item:has-text('Settings'), .menu button:has-text('Settings')").first().click();
}

/**
 * One test in a fresh page. Options:
 * - scenario: which services are on and signed in ("both" by default, "youtube", "plex", "fresh");
 * - youtube: only YouTube Music on, with Japanese metadata (yt-overrides.js; 1.x YTSpot);
 * - init: an init script run after the mock (it can change `window.__MOCK__`);
 * - ready: the selector that says the app is up (the player bar; the Connect page on a fresh install).
 * Env ONLY=<regex> runs the matching tests only.
 */
async function test(name, fn, { youtube = false, scenario = "both", init, userAgent, ready = ".playerbar" } = {}) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY, "i").test(name)) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, userAgent });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let r;
  const t0 = Date.now();
  try {
    await page.addInitScript({ path: mock });
    if (youtube) await page.addInitScript({ path: ytOverrides });
    else if (scenario !== "both") await page.addInitScript((s) => window.__setScenario(s), scenario);
    if (init) await page.addInitScript(init);
    await page.goto(base);
    await page.waitForSelector(ready);
    await within(150000, fn(page), "test");
    assert.deepEqual(errors, [], "uncaught page errors");
    r = { name, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    r = { name, ok: false, error: e.message.split("\n")[0] };
    // What the page showed, for failures that only happen on CI.
    const state = await within(5000, page.evaluate(() => ({
      viewport: [innerWidth, innerHeight],
      menus: [...document.querySelectorAll(".menu")].map((m) => {
        const b = m.getBoundingClientRect();
        return { box: [b.x, b.y, b.width, b.height].map(Math.round), items: [...m.querySelectorAll(":scope > button")].map((x) => x.textContent.trim()) };
      }),
      toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent),
    })), "diagnostics").catch(() => null);
    r.details = [e.message.split("\n").slice(0, 8).join("\n    "), state && JSON.stringify(state)].filter(Boolean).join("\n    ");
  }
  results.push(r);
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? ` (${r.ms} ms)` : ` — ${r.error}`}`);
  if (r.details) console.log("    " + r.details);
  await within(10000, page.close(), "close").catch(() => {});
}

await test("home shows greeting, shortcuts and restored player", async (p) => {
  await p.waitForSelector(".greeting");
  assert.ok((await p.locator(".shortcut").count()) >= 4);
  assert.equal(await p.locator(".pb-meta .name").textContent(), "Slow Lights");
});

await test("search shows top result and songs", async (p) => {
  await p.fill("#global-search", "aster");
  await p.waitForSelector(".top-result .top-name");
  assert.equal((await p.locator(".top-result .top-name").textContent()).trim(), "Aster Vale");
  assert.ok((await p.locator(".top-songs .tl-row:not(.tl-head)").count()) > 0);
  // Local files blend into Songs (with a badge); the Songs filter loads the full list.
  await p.locator(".top-songs .tl-row .name", { hasText: "home demo" }).waitFor();
  await p.click('.chips button:has-text("Songs")');
  await p.locator(".tl-row .name", { hasText: "(more)" }).first().waitFor();
});

await test("queue: shift-click range selection and bulk remove", async (p) => {
  await p.click('button[aria-label="Queue"]');
  const rows = p.locator(".q-row:not(.current)");
  await rows.nth(0).click();
  await rows.nth(3).click({ modifiers: ["Shift"] });
  assert.equal(await p.locator('.q-row[aria-selected="true"]').count(), 4);
  await p.keyboard.press("Delete");
  assert.equal(await p.locator('.q-row[aria-selected="true"]').count(), 0);
  for (const title of ["Halfway Home", "Static Bloom"])
    assert.equal(await p.locator(".q-row .name", { hasText: title }).count(), 0, `${title} still queued`);
  assert.equal(await p.locator(".q-row.current .name").textContent(), "Slow Lights", "current track changed");
});

await test("album page: context menu and save to library", async (p) => {
  await p.click(".shelf .card >> nth=0");
  await p.waitForSelector(".hero");
  await p.locator(".tl-row:not(.tl-head)").nth(1).click({ button: "right" });
  const menu = p.locator(".menu");
  await menu.waitFor();
  for (const label of ["Add to playlist", "Add to queue", "Go to artist", "View credits", "Share"])
    assert.ok(await menu.getByText(label, { exact: true }).count(), `menu missing ${label}`);
  await p.keyboard.press("Escape");
  const save = p.locator('button[aria-label="Save to Your Library"]');
  await save.click();
  await p.waitForSelector('button[aria-label="Remove from Your Library"][aria-pressed="true"]');
});

await test("artist page: follow toggles", async (p) => {
  await p.click(".shelf .card >> nth=0");
  await p.waitForSelector(".hero-meta .link");
  await p.click(".hero-meta .link");
  await p.waitForSelector(".artist-hero");
  await p.locator(".tl-row .name", { hasText: "home demo" }).waitFor();
  await p.click("button.follow");
  await p.waitForSelector('button.follow[aria-pressed="true"]');
  assert.equal((await p.locator("button.follow").textContent()).trim(), "Following");
});

await test("Lyrics open in the side panel, expand to fullscreen and close on Escape", async (p) => {
  await p.click('.playerbar button[aria-label="Lyrics"]');
  await p.waitForSelector(".lyrics-panel .lyrics .line");
  assert.equal(await p.locator(".fullscreen").count(), 0, "lyrics must not jump straight to fullscreen");
  // Queue and lyrics share the right-hand panel.
  await p.click('.playerbar button[aria-label="Queue"]');
  await p.waitForSelector(".lyrics-panel", { state: "detached" });
  await p.click('.playerbar button[aria-label="Lyrics"]');
  await p.click('.lyrics-panel button[aria-label="Full screen"]');
  await p.waitForSelector(".fullscreen .lyrics .line");
  await p.keyboard.press("Escape");
  await p.waitForSelector(".fullscreen", { state: "detached" });
});

// Regression: the lyrics effect was keyed on the displayed track object, which is new on every
// render for YouTube music videos, so reopening lyrics (cache hit) looped forever and froze the app.
await test("YouTube: reopening lyrics on a music video stays responsive", async (p) => {
  for (let i = 0; i < 2; i++) {
    await p.click('.playerbar button[aria-label="Lyrics"]');
    await p.waitForSelector(".lyrics-panel .lyrics .line");
    await p.click('.lyrics-panel button[aria-label="Full screen"]');
    await p.waitForSelector(".fullscreen .lyrics .line");
    await p.waitForTimeout(300);
    await p.keyboard.press("Escape");
    await p.waitForSelector(".fullscreen", { state: "detached" });
    await p.click('.playerbar button[aria-label="Lyrics"]');
    await p.waitForSelector(".lyrics-panel", { state: "detached" });
  }
  await p.click('.playerbar button[aria-label="Lyrics"]');
  await p.waitForSelector(".lyrics-panel .lyrics .line");
  const t0 = Date.now();
  await Promise.race([
    p.evaluate(() => new Promise((r) => setTimeout(r, 50))),
    new Promise((_, rej) => setTimeout(() => rej(new Error("page unresponsive (render loop)")), 3000)),
  ]);
  assert.ok(Date.now() - t0 < 3000);
}, { youtube: true });

await test("YouTube: settings toggles and Japanese text modes", async (p) => {
  await openSettings(p);
  for (const mode of ["Romaji", "Both", "Japanese script"]) {
    await p.click('button[aria-label="Japanese text"]');
    await p.click(`.menu button:has-text("${mode}")`);
  }
  // Every switch but the Services ones (tested on their own below).
  for (const s of await p.locator('input[role="switch"]:not(:disabled):not([data-service])').all()) {
    await s.click();
    await s.click();
  }
  await p.click('button[aria-label="Language"]');
  await p.click('.menu button:has-text("日本語")');
  await p.click('button[aria-label="言語"]');
  await p.click('.menu button:has-text("English")');
  await p.waitForSelector("text=Settings");
}, { youtube: true });

await test("playlist folders and custom order in the sidebar", async (p) => {
  const lib = p.locator(".lib-list");
  await p.click('button[aria-label="Create playlist"]');
  await p.click('.menu button:has-text("Create folder")');
  await p.fill(".dialog input", "Moods");
  await p.click('.dialog button:has-text("Save")');
  await lib.locator(".side-item", { hasText: "Moods" }).waitFor();
  // Move "autumn" into the folder from its context menu.
  await lib.locator(".side-item", { hasText: "autumn" }).click({ button: "right" });
  await p.hover('.menu button:has-text("Move to folder")');
  await p.click('.menu.sub button:has-text("Moods")');
  await lib.locator(".side-item.nested", { hasText: "autumn" }).waitFor();
  // Collapse and expand the folder.
  await lib.locator(".side-item", { hasText: "Moods" }).click();
  assert.equal(await lib.locator(".side-item.nested").count(), 0);
  await lib.locator(".side-item", { hasText: "Moods" }).click();
  assert.equal(await lib.locator(".side-item.nested").count(), 1);
  // Custom order: drag "End" above "Moods".
  await p.click(".side-section .side-sort");
  await p.click('.menu button:has-text("Custom order")');
  assert.equal((await p.locator(".side-section .side-sort").textContent()).trim(), "Custom order");
  const names = async () => await lib.locator(".side-item .name").allTextContents();
  await lib.locator(".side-item", { hasText: /^End/ }).dragTo(lib.locator(".side-item", { hasText: "Moods" }), { targetPosition: { x: 40, y: 2 } });
  const order = await names();
  assert.ok(order.indexOf("End") < order.indexOf("Moods"), `order: ${order.join(", ")}`);
}, { scenario: "plex" });

await test("language switch to Japanese", async (p) => {
  await openSettings(p);
  await p.click('button[aria-label="Language"]');
  await p.click('.menu button:has-text("日本語")');
  await p.waitForSelector("text=ホーム");
});

await test("50,000-track playlist stays virtualized and responsive", async (p) => {
  const t0 = Date.now();
  await p.click(".side-item >> text=Everything");
  await p.waitForSelector(".tl-row:not(.tl-head)");
  const renderMs = Date.now() - t0;
  const domRows = await p.locator(".tl-row:not(.tl-head)").count();
  assert.ok(domRows < 120, `expected virtualization, got ${domRows} DOM rows`);
  const s0 = Date.now();
  await p.evaluate(() => document.querySelector(".main")?.scrollTo(0, 56 * 40000));
  await p.waitForFunction(() => [...document.querySelectorAll(".tl-text .name")].some((n) => / 400\d\d$/.test(n.textContent ?? "")), null, { timeout: 5000 });
  const scrollMs = Date.now() - s0;
  const heap = await p.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  console.log(`  50k list: first rows ${renderMs} ms, jump-scroll ${scrollMs} ms, ${domRows} rows in DOM, JS heap ${(heap / 1048576).toFixed(1)} MB`);
  assert.ok(renderMs < 3000, `slow first render: ${renderMs} ms`);
  assert.ok(scrollMs < 1000, `slow jump-scroll: ${scrollMs} ms`);
});

await test(
  "YouTube podcast: show page, follow, save an episode to Your Episodes",
  async (p) => {
    // The classic "Your Library" categories: Podcasts opens the saved shows.
    await p.click('.sidebar .side-cat:has-text("Podcasts")');
    await p.locator(".main .card", { hasText: "Conspiracy Theories" }).first().click();
    await p.waitForSelector(".podcast-page .ep-row", { timeout: 5000 });
    assert.equal(await p.locator(".ep-row").count(), 3);
    await p.click(".podcast-page .follow");
    await p.waitForFunction(() => document.querySelector(".podcast-page .follow")?.getAttribute("aria-pressed") === "true");
    // Newest first by default: Pt. 3 (Oct 23) on top.
    assert.match(await p.locator(".ep-row .ep-title").first().textContent(), /Pt\. 3/);
    await p.locator(".ep-row", { hasText: "Pt. 1" }).locator("button[aria-pressed]").click();
    await p.click('.sidebar .side-cat:has-text("Your Episodes")');
    await p.waitForSelector(".podcast-page .ep-row");
    assert.equal(await p.locator(".ep-row").count(), 1);
    assert.match(await p.locator(".ep-row .ep-title").first().textContent(), /Lost Tomb Pt\. 1/);
  },
  { youtube: true },
);

await test(
  "Podcast episodes can be sorted oldest first, and stay that way",
  async (p) => {
    await p.click('.sidebar .side-cat:has-text("Podcasts")');
    await p.locator(".main .card", { hasText: "Conspiracy Theories" }).first().click();
    await p.waitForSelector(".podcast-page .ep-row", { timeout: 5000 });
    const titles = async () => (await p.locator(".ep-row .ep-title").allTextContents()).map((x) => x.trim());
    // Saved as oldest first earlier: opens that way (Pt. 1 is from Oct 21, Pt. 3 from Oct 23).
    assert.deepEqual(await titles(), ["The Lost Tomb Pt. 1", "The Lost Tomb Pt. 2", "The Lost Tomb Pt. 3"]);
    const btn = p.locator(".podcast-page .sort-btn");
    assert.ok((await btn.textContent()).includes("Oldest first"));
    // Newest first, saved.
    await btn.click();
    await p.waitForFunction(() => document.querySelector(".ep-row .ep-title")?.textContent?.includes("Pt. 3"));
    assert.deepEqual(await titles(), ["The Lost Tomb Pt. 3", "The Lost Tomb Pt. 2", "The Lost Tomb Pt. 1"]);
    assert.ok((await btn.textContent()).includes("Newest first"));
    assert.deepEqual(await p.evaluate(() => window.__KV.podcastOldestFirst), {});
    // And back.
    await btn.click();
    await p.waitForFunction(() => document.querySelector(".ep-row .ep-title")?.textContent?.includes("Pt. 1"));
    assert.deepEqual(await p.evaluate(() => window.__KV.podcastOldestFirst), { "yt:MPSPshow": true });
  },
  {
    youtube: true,
    init: () => {
      const d = window.__MOCK__;
      window.__KV = {};
      const base = d.kv_get;
      // The show was saved as oldest first.
      d.kv_get = (a) => (a.key === "podcastOldestFirst" ? { "yt:MPSPshow": true } : typeof base === "function" ? base(a) : base);
      d.kv_set = (a) => ((window.__KV[a.key] = a.value), null);
    },
  },
);

await test(
  "YouTube artist page shows subscribers as followers",
  async (p) => {
    await p.click('.sidebar .side-cat:has-text("Artists")');
    await p.locator(".main .card").first().click();
    await p.waitForSelector(".artist-hero");
    assert.equal((await p.locator(".artist-followers").textContent()).trim(), "1.23M followers");
  },
  { youtube: true },
);

await test(
  "titles in another script are translated, with the original on hover",
  async (p) => {
    const name = p.locator(".pb-meta .name span[title]");
    await name.waitFor();
    assert.equal(await name.getAttribute("title"), "夜明けの歌");
    assert.equal((await name.textContent()).trim(), "[en] 夜明けの歌");
  },
  { youtube: true },
);

await test("side panels resize by dragging and remember their width", async (p) => {
  const side = await p.locator(".sidebar").boundingBox();
  const h = await p.locator(".side-resizer .resizer").boundingBox();
  await p.mouse.move(h.x + 4, h.y + 200);
  await p.mouse.down();
  await p.mouse.move(h.x + 84, h.y + 200, { steps: 4 });
  await p.mouse.up();
  const after = await p.locator(".sidebar").boundingBox();
  assert.ok(Math.abs(after.width - (side.width + 80)) <= 2, `sidebar ${side.width} -> ${after.width}`);
  await p.click('.playerbar button[aria-label="Queue"]');
  const q = await p.locator(".queue-panel").boundingBox();
  const qh = await p.locator(".panel-resizer .resizer").boundingBox();
  await p.mouse.move(qh.x + 4, qh.y + 200);
  await p.mouse.down();
  await p.mouse.move(qh.x - 56, qh.y + 200, { steps: 4 });
  await p.mouse.up();
  const q2 = await p.locator(".queue-panel").boundingBox();
  assert.ok(Math.abs(q2.width - (q.width + 60)) <= 2, `queue ${q.width} -> ${q2.width}`);
});

await test("sleep timer has its own button", async (p) => {
  await p.click('.playerbar button[aria-label="Sleep timer"]');
  await p.click('.menu button:has-text("15 min")');
  await p.waitForSelector('.playerbar button[aria-label^="Sleep timer: 15 min"][aria-pressed="true"]');
});

await test("playlist exports as Artist - Title text for Soundiiz", async (p) => {
  await p.locator(".lib-list .side-item", { hasText: "Road trip" }).click({ button: "right" });
  await p.hover('.menu button:has-text("Export")');
  await p.click('.menu.sub button:has-text("Text file")');
  await p.waitForFunction(() => window.__EXPORT__);
  const exp = await p.evaluate(() => window.__EXPORT__);
  assert.equal(exp.name, "Road trip.txt");
  const lines = exp.content.trim().split("\n");
  assert.ok(lines.length > 0);
  assert.match(lines[0], /^.+ - .+$/);
});

await test(
  "multi-disc albums show a heading per disc and play through the whole album",
  async (p) => {
    await p.locator(".card").nth(8).click();
    await p.waitForSelector(".disc-head");
    assert.deepEqual((await p.locator(".disc-head").allTextContents()).map((x) => x.trim()), ["Disc 1", "Disc 2"]);
    // The first song of disc 2 starts there. The sample backend has no audio, so the first
    // message names the song that was tried first.
    await p.locator(".disc").nth(1).locator(".tl-row:not(.tl-head)").first().dblclick();
    await p.waitForSelector(".toast");
    assert.match(await p.locator(".toast").first().textContent(), /Disc two opener/);
  },
  {
    init: () => {
      const d = window.__MOCK__;
      const base = typeof d.album === "function" ? d.album({ id: "x" }) : d.album;
      const tr = (n, disc, title) => ({ ...base.tracks[0], id: "plex:d" + disc + n, title, discNumber: disc, trackNumber: n });
      d.album = () => ({ album: base.album, tracks: [tr(1, 1, "Disc one opener"), tr(2, 1, "Disc one closer"), tr(1, 2, "Disc two opener"), tr(2, 2, "Disc two closer")] });
    },
  },
);

await test("search inside a playlist filters its songs", async (p) => {
  await p.locator(".lib-list .side-item", { hasText: "Road trip" }).click();
  await p.waitForSelector(".tl-row:not(.tl-head)");
  const before = await p.locator(".tl-row:not(.tl-head)").count();
  await p.click('button[aria-label="Search in playlist"]');
  await p.fill('.pl-find input', "paper");
  await p.waitForFunction((n) => document.querySelectorAll(".tl-row:not(.tl-head)").length < n, before);
  // Title, artist or album matches (the album column shows on desktop).
  for (const row of await p.locator(".tl-row:not(.tl-head)").allTextContents()) assert.match(row.toLowerCase(), /paper/);
  await p.fill('.pl-find input', "zzzz-nothing");
  await p.waitForSelector("text=No songs match");
});

await test("What's New shows releases from followed artists and the latest releases", async (p) => {
  await p.click('.topbar button[aria-label="What\'s New"]');
  await p.waitForSelector("h1:has-text(\"What's New\")");
  const heads = (await p.locator(".shelf-head h2").allTextContents()).map((x) => x.trim());
  assert.deepEqual(heads.slice(0, 2), ["From artists you follow", "Latest releases in your library"]);
  assert.ok((await p.locator(".shelf .card").count()) >= 5);
});

await test("Windows gets a Spotify-style title bar with navigation, search and window buttons", async (p) => {
  await p.waitForSelector(".titlebar #global-search");
  assert.equal(await p.locator(".topbar #global-search").count(), 0, "search moved out of the page header");
  assert.equal(await p.locator('.titlebar [data-tauri-drag-region]').count() >= 1, true);
  await p.click('.titlebar button[aria-label="Minimize"]');
  await p.click('.titlebar button[aria-label="Maximize"]');
  const calls = await p.evaluate(() => window.__CALLS__);
  assert.ok(calls.includes("plugin:window|minimize") && calls.includes("plugin:window|toggle_maximize"), calls.join());
  await p.click('.titlebar button[aria-label="Menu"]');
  await p.click('.menu button:has-text("Settings")');
  await p.waitForSelector(".page h1:has-text('Settings')");
  await p.click('.titlebar button[aria-label="Go back"]');
  await p.waitForSelector(".greeting");
  await p.fill(".titlebar #global-search", "slow");
  await p.waitForSelector(".page .search-top, .page h2");
}, { init: () => { window.__MOCK__.app_info.platform = "windows"; } });

await test("Windows: sharing audio with Discord turns the relay on and off, and turns itself off when Windows refuses", async (p) => {
  await p.click('.titlebar button[aria-label="Menu"]');
  await p.click('.menu button:has-text("Settings")');
  const sw = p.locator('label.setting:has-text("Share audio when streaming on Discord") input');
  assert.equal(await sw.isChecked(), false, "off by default");
  await sw.click();
  await p.waitForFunction(() => window.__SHARE.join() === "true");
  await sw.click();
  await p.waitForFunction(() => window.__SHARE.join() === "true,false");
  await p.evaluate(() => (window.__MOCK__.audio_share_set = () => { throw "not supported: process loopback"; }));
  await sw.click();
  await p.waitForSelector('.toast:has-text("process loopback")');
  await p.waitForFunction(() => [...document.querySelectorAll("label.setting")].some((l) => l.textContent.includes("Share audio when streaming") && !l.querySelector("input").checked));
}, { init: () => {
  window.__MOCK__.app_info.platform = "windows";
  window.__SHARE = [];
  window.__MOCK__.audio_share_set = (a) => (window.__SHARE.push(a.enabled), null);
} });

await test("Listening history lists every play by day; plays can be removed and the history cleared", async (p) => {
  await p.click('.sidebar .side-cat:has-text("Listening history")');
  await p.waitForSelector(".page h1:has-text('Listening history')");
  const heads = (await p.locator(".history-day h2").allTextContents()).map((x) => x.trim());
  assert.deepEqual(heads.slice(0, 2), ["Today", "Yesterday"]);
  assert.equal(heads.length, 3, heads.join());
  assert.equal(await p.locator(".history-day .tl-row:not(.tl-head)").count(), 5);
  // The same song twice in a day stays two plays.
  assert.equal(await p.locator('.history-day:first-of-type .tl-row:not(.tl-head) .name:has-text("Slow Lights")').count(), 2);
  await p.locator(".history-day .tl-row:not(.tl-head)").nth(1).click({ button: "right" });
  await p.click('.menu button:has-text("Remove from listening history")');
  await p.waitForFunction(() => document.querySelectorAll(".history-day .tl-row:not(.tl-head)").length === 4);
  assert.deepEqual(await p.evaluate(() => window.__REMOVED), [[4]]);
  // Playing from history plays on through the rest of it.
  await p.locator(".history-day .tl-row:not(.tl-head)").nth(2).dblclick();
  await p.waitForFunction(() => document.querySelector(".pb-meta .name")?.textContent?.length > 0);
  await p.click('.page-head-row button:has-text("Clear history")');
  await p.click('.dialog button:has-text("Clear history")');
  await p.waitForSelector("text=Songs you play will show up here.");
  // Recently played links here.
  await p.click('.sidebar .side-cat:has-text("Recently played")');
  await p.click('.page-head-row button:has-text("Listening history")');
  await p.waitForSelector(".page h1:has-text('Listening history')");
}, { init: () => {
  const d = window.__MOCK__;
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const tr = (i) => window.__FIX__.tracks[i];
  let entries = [
    { id: 5, track: tr(0), playedAt: now - 60, context: null },
    { id: 4, track: tr(1), playedAt: now - 120, context: null },
    { id: 3, track: tr(0), playedAt: now - 180, context: null },
    { id: 2, track: tr(2), playedAt: now - day, context: null },
    { id: 1, track: tr(3), playedAt: now - 9 * day, context: null },
  ];
  // Today's plays must stay on today's date even just after midnight.
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  if (now - 180 < midnight / 1000) entries = entries.map((e, i) => (i < 3 ? { ...e, playedAt: Math.floor(midnight / 1000) + 1 } : e));
  window.__REMOVED = [];
  d.listening_history = () => entries;
  d.history_remove = (a) => (window.__REMOVED.push(a.ids), (entries = entries.filter((e) => !a.ids.includes(e.id))), null);
  d.history_clear = () => ((entries = []), null);
} });

await test("Sync playlists: receive shows an address and code; send posts to the typed address", async (p) => {
  await openSettings(p);
  await p.waitForSelector("h2:has-text('Sync playlists between devices')");
  await p.click('.sync .setting button:has-text("Receive")');
  await p.waitForSelector('.sync-code strong:has-text("192.168.1.23:47380")');
  await p.waitForSelector('.sync-code strong:has-text("482913")');
  await p.click('.sync .setting button:has-text("Stop")');
  await p.waitForFunction(() => !document.querySelector(".sync-code"));
  const send = p.locator('.sync-send button:has-text("Send")');
  await p.fill('.sync-send input[aria-label="Address"]', "192.168.1.40");
  assert.equal(await send.isDisabled(), true, "needs the 6-digit code");
  await p.fill('.sync-send input[aria-label="Code"]', "12a3456");
  assert.equal(await p.inputValue('.sync-send input[aria-label="Code"]'), "123456");
  await send.click();
  await p.waitForSelector('.toast:has-text("Sent 2 playlists (20 songs)")');
  await p.waitForSelector('.toast:has-text("3 songs from local files stayed on this device")');
  assert.deepEqual(await p.evaluate(() => window.__SENT), [{ address: "192.168.1.40", code: "123456" }]);
  assert.equal(await p.inputValue('.sync-send input[aria-label="Code"]'), "", "code cleared after sending");
}, { init: () => {
  const d = window.__MOCK__;
  window.__SENT = [];
  d.sync_receive_start = { address: "192.168.1.23:47380", code: "482913", expiresAt: Math.floor(Date.now() / 1000) + 600 };
  d.sync_send = (a) => (window.__SENT.push(a), { playlists: 2, songs: 20, skipped: 3 });
} });

await test("Space only plays/pauses: it never presses a clicked or keyboard-focused button or switch", async (p) => {
  const name = () => p.locator(".playerbar .pb-meta .name").textContent();
  const playLabel = () => p.locator(".playerbar .play-btn").getAttribute("aria-label");
  const first = await name();
  await p.click('.playerbar button[aria-label="Next"]');
  await p.waitForFunction((n) => document.querySelector(".playerbar .pb-meta .name")?.textContent !== n, first);
  await p.waitForSelector('.playerbar .play-btn[aria-label="Pause"]');
  const song = await name();
  const before = await playLabel();
  // The clicked Next button still has focus: Space must not press it again.
  await p.keyboard.press(" ");
  await p.waitForFunction((b) => document.querySelector(".playerbar .play-btn")?.getAttribute("aria-label") !== b, before);
  assert.equal(await name(), song, "Space skipped the song");
  await p.keyboard.press(" ");
  await p.waitForFunction((b) => document.querySelector(".playerbar .play-btn")?.getAttribute("aria-label") === b, before);
  assert.equal(await name(), song);
  // A clicked switch in Settings doesn't flip either.
  await openSettings(p);
  const sw = p.locator('label.setting:has-text("Gapless") input');
  const on = await sw.isChecked();
  await sw.click();
  await p.keyboard.press(" ");
  assert.equal(await sw.isChecked(), !on, "Space flipped the clicked switch back");
  // Reached with the keyboard, the switch still isn't flipped: Space pauses or plays.
  await p.keyboard.press("Shift+Tab");
  await p.keyboard.press("Tab");
  const label = await playLabel();
  await p.keyboard.press(" ");
  assert.equal(await sw.isChecked(), !on, "Space flipped a keyboard-focused switch");
  await p.waitForFunction((b) => document.querySelector(".playerbar .play-btn")?.getAttribute("aria-label") !== b, label);
  // Typing still types spaces.
  await p.click("#global-search");
  await p.keyboard.type("slow li");
  assert.equal(await p.inputValue("#global-search"), "slow li");
}, {
  init: () => {
    // Songs that really play (a 2-minute quiet tone), so play/pause can be seen.
    const rate = 4000, n = rate * 120, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true);
    v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(4 * Math.sin(i / 8)));
    const wav = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    const d = window.__MOCK__;
    d.resolve_stream = () => ({ kind: "url", url: wav, quality: "test", offline: false });
    d.settings_get = { crossfade: 0, volume: 0.5, gapless: true };
    d.queue_load = { ...d.queue_load, position: 0 };
  },
});

await test("A refused request repairs the session and retries instead of signing out", async (p) => {
  await p.waitForSelector(".greeting");
  await p.waitForSelector(".shelf .card");
  assert.deepEqual(await p.evaluate(() => [window.__RECOVERS, window.__HOME_CALLS, window.__RECOVERED]), [1, 2, "plex"]);
  assert.equal(await p.locator(".login").count(), 0, "signed out");
}, { init: () => {
  const d = window.__MOCK__;
  const home = d.home;
  window.__RECOVERS = 0;
  window.__HOME_CALLS = 0;
  // The first Home request is refused as if the session had expired; the repair fixes it.
  d.home = () => {
    if (window.__HOME_CALLS++ === 0) throw { code: "authExpired", message: "session expired, please sign in again", provider: "plex" };
    return home;
  };
  d.auth_recover = (a) => (window.__RECOVERS++, (window.__RECOVERED = a.provider), true);
} });

await test("A submenu reached while its menu is still opening stays open", async (p) => {
  // Right-click, then go straight to Export: the rows must not move out from under the pointer.
  const box = await p.locator(".lib-list .side-item", { hasText: "Road trip" }).boundingBox();
  await p.mouse.click(box.x + 40, box.y + box.height / 2, { button: "right" });
  const ex = await p.evaluate(() => {
    const b = [...document.querySelectorAll(".menu > button")].find((x) => x.textContent.includes("Export")).getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  });
  await p.mouse.move(ex[0], ex[1]);
  await p.waitForTimeout(400);
  assert.equal(await p.locator(".menu.sub").count(), 1, "the Export submenu closed");
});

await test("Private session: nothing played is recorded until it's turned off", async (p) => {
  const recorded = () => p.evaluate(() => window.__CALLS__.filter((c) => ["record_play", "lastfm_now_playing", "presence_update"].includes(c)));
  await openSettings(p);
  await p.locator('label.setting:has-text("Private session") input').click();
  await p.waitForSelector('.toast:has-text("Private session on")');
  await p.waitForSelector(".playerbar .private-badge");
  await p.evaluate(() => (window.__CALLS__.length = 0));
  await p.click('.playerbar button[aria-label="Next"]');
  await p.waitForSelector('.playerbar .play-btn[aria-label="Pause"]');
  await p.waitForTimeout(500);
  assert.deepEqual(await recorded(), [], "recorded during a private session");
  // The badge ends it; the next song is recorded again.
  await p.click(".playerbar .private-badge");
  await p.waitForSelector(".playerbar .private-badge", { state: "detached" });
  await p.click('.playerbar button[aria-label="Next"]');
  await p.waitForFunction(() => window.__CALLS__.includes("record_play"));
  assert.ok((await recorded()).includes("presence_update"), "Discord presence after the private session");
}, {
  init: () => {
    const rate = 4000, n = rate * 120, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true);
    v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(4 * Math.sin(i / 8)));
    const wav = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    const d = window.__MOCK__;
    d.resolve_stream = () => ({ kind: "url", url: wav, quality: "test", offline: false });
    d.settings_get = { crossfade: 0, volume: 0.5, gapless: true, lastfmScrobble: true, discordPresence: true };
    d.queue_load = { ...d.queue_load, position: 0 };
    d.app_info = { ...d.app_info, capabilities: { ...d.app_info.capabilities, discordPresence: true } };
  },
});

await test("Android: notification buttons reach the player and song changes reach the notification directly", async (p) => {
  await p.waitForFunction(() => typeof window.__omMedia === "function");
  const first = await p.locator(".pb-meta .name").textContent();
  await p.evaluate(() => window.__omMedia({ action: "next" }));
  await p.waitForFunction((t) => document.querySelector(".pb-meta .name")?.textContent !== t, first);
  const now = (await p.locator(".pb-meta .name").textContent()).trim();
  await p.waitForFunction((t) => window.__NP.some((u) => u.title === t), now);
  const sent = await p.evaluate(() => window.__NP);
  const last = sent.at(-1);
  assert.equal(last.title, now);
  assert.ok(last.id && last.seq > 0 && last.artwork === null, JSON.stringify(last));
  assert.ok(sent.every((u, i) => i === 0 || u.seq > sent[i - 1].seq), "seq increases");
}, {
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
  init: () => {
    window.__NP = [];
    window.OpenMusicMedia = { update: (j) => window.__NP.push(JSON.parse(j)) };
  },
});

await test("YouTube playlists can get an in-app cover", async (p) => {
  await p.locator(".lib-list .side-item", { hasText: "My YouTube mix" }).click();
  await p.waitForSelector(".page h1:has-text('My YouTube mix')");
  // 1×1 PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const chooser = p.waitForEvent("filechooser");
  await p.click(".hero-art-btn");
  await (await chooser).setFiles({ name: "cover.png", mimeType: "image/png", buffer: png });
  await p.waitForFunction(() => window.__COVER?.image?.length > 0);
  assert.equal(await p.evaluate(() => window.__COVER.id), "yt:VLPLmine");
  await p.click('.page button[aria-label="More options"]');
  await p.locator(".menu button", { hasText: "Change cover" }).waitFor();
}, {
  youtube: true,
  init: () => {
    const d = window.__MOCK__;
    const base = d.playlist;
    d.playlist = (a) => ({ ...base(a), playlist: { id: "yt:VLPLmine", title: "My YouTube mix", artwork: null, trackCount: 6, local: false } });
    d.pl_set_cover = (a) => ((window.__COVER = a), null);
  },
});

await test("Selected songs go into Liked Songs together; menus show icons", async (p) => {
  await p.locator(".lib-list .side-item", { hasText: "autumn" }).click();
  const rows = p.locator(".page .tl-row:not(.tl-head)");
  await rows.nth(2).waitFor();
  // Click the titles: the middle of a row is the album link.
  await rows.nth(0).locator(".name").click();
  await rows.nth(2).locator(".name").click({ modifiers: ["Shift"] });
  await rows.nth(1).locator(".name").click({ button: "right" });
  assert.ok((await p.locator(".menu button .mi svg").count()) >= 5, "menu items have icons");
  await p.click('.menu button:has-text("Add 3 to Liked Songs")');
  await p.waitForFunction(() => window.__RATES.length === 3);
  assert.ok(await p.evaluate(() => window.__RATES.every((r) => r.liked === true)));
  // The playlist's menu likes every song in it; "Add to playlist" lists Liked Songs first.
  await p.click('.page button[aria-label="More options"]');
  await p.locator('.menu button:has-text("Add all to Liked Songs")').waitFor();
  await p.keyboard.press("Escape");
  await rows.nth(4).locator(".name").click({ button: "right" });
  await p.hover('.menu button:has-text("Add to playlist")');
  await p.locator('.menu.sub button:has-text("Liked Songs")').waitFor();
}, {
  init: () => {
    window.__RATES = [];
    window.__MOCK__.rate = (a) => (window.__RATES.push(a), null);
  },
});

await test("Android widgets: a tapped playlist opens in the app, and the recent widget gets refreshed", async (p) => {
  await p.waitForSelector(".page h1:has-text('autumn')");
  // Brought back by another widget tap while running.
  await p.evaluate(() => window.__omLaunch({ kind: "album", id: "plex:al1" }));
  await p.waitForFunction(() => {
    const h = document.querySelector(".page h1")?.textContent;
    return h && h !== "autumn";
  });
  await p.waitForFunction(() => window.__CALLS__.includes("widget_refresh"), null, { timeout: 8000 });
}, {
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
  init: () => {
    let launch = JSON.stringify({ kind: "playlist", id: "plex:pl0" });
    window.OpenMusicMedia = { update: () => {}, takeLaunch: () => { const l = launch; launch = ""; return l; } };
  },
});

await test("Normalize volume: the switch reveals the level, and both are saved", async (p) => {
  await openSettings(p);
  await p.waitForSelector(".page h1:has-text('Settings')");
  const row = p.locator(".setting", { hasText: "Normalize volume" });
  assert.equal(await p.locator(".setting", { hasText: "Volume level" }).count(), 0);
  await row.locator('input[role="switch"]').check();
  await p.locator(".setting", { hasText: "Volume level" }).waitFor();
  await p.locator(".setting", { hasText: "Volume level" }).locator("button").click();
  await p.click('.menu button:has-text("Quiet")');
  await p.waitForFunction(() => JSON.stringify(window.__MOCK__.__saved ?? {}).includes('"normalizeLevel":"quiet"'), null, { timeout: 5000 });
}, {
  init: () => {
    const d = window.__MOCK__;
    d.__saved = {};
    d.settings_set = (a) => ((d.__saved = a.settings), null);
  },
});

await test("Crossfade still reaches full volume when the page's timers are throttled (background)", async (p) => {
  await p.click('.playerbar button[aria-label="Play"]');
  // The restored position is past the end of the short test songs, so playback moves on, and the
  // next song crossfades into the one after. Wait until a crossfade has started and finished.
  await p.waitForFunction(() => window.__AUDIOS.filter((a) => !a.paused).length === 2, null, { timeout: 15000 });
  await p.waitForFunction(() => window.__AUDIOS.filter((a) => !a.paused).length === 1, null, { timeout: 15000 });
  // 2 s fade, timers throttled to once per 2 s: the new song is at full volume right after.
  await p.waitForTimeout(600);
  const vols = await p.evaluate(() => window.__AUDIOS.filter((a) => !a.paused).map((a) => a.volume));
  assert.equal(vols.length, 1);
  assert.ok(vols[0] > 0.75, "volume after the crossfade: " + vols[0]);
}, {
  init: () => {
    // Throttled timers, like a page in the background.
    const si = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...rest) => si(fn, Math.max(ms ?? 0, 2000), ...rest);
    // Keep the player's <audio> elements to look at.
    const A = window.Audio;
    window.__AUDIOS = [];
    window.Audio = function (...a) {
      const x = new A(...a);
      window.__AUDIOS.push(x);
      return x;
    };
    // 5-second tone WAVs as the song streams.
    const wav = (() => {
      const rate = 8000, n = rate * 5, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
      const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true);
      v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
      for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(40 * Math.sin(i / 8)));
      return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    })();
    const d = window.__MOCK__;
    d.resolve_stream = () => ({ kind: "url", url: wav, quality: "test", offline: false });
    d.settings_get = { crossfade: 2, volume: 0.8, gapless: true };
    for (const x of d.queue_load.tracks) x.t.durationMs = 5000;
  },
});

await test("Artist discography: albums newest first, compilations on their own tab", async (p) => {
  await p.click(".shelf .card >> nth=0");
  await p.waitForSelector(".hero-meta .link");
  await p.click(".hero-meta .link");
  await p.waitForSelector(".artist-hero");
  await p.click('.chips button:has-text("Albums")');
  const titles = async () => (await p.locator(".shelf .grid .card .card-title").allTextContents()).map((x) => x.trim());
  await p.waitForFunction(() => document.querySelector(".shelf .grid .card .card-title")?.textContent?.trim() === "Paper Moons");
  assert.deepEqual(await titles(), ["Paper Moons", "Low Tide", "Autumn Tapes", "Night Drive"]);
  await p.click('.chips button:has-text("Compilations")');
  await p.waitForFunction(() => document.querySelectorAll(".shelf .grid .card").length === 1);
  assert.deepEqual(await titles(), ["Glass Garden"]);
}, {
  init: () => {
    window.__MOCK__.artist_compilations = ["Glass Garden (Deluxe Edition)"];
  },
});

await test("Phones: Settings opens the newest release page in the phone's browser", async (p) => {
  await openSettings(p);
  const row = p.locator(".setting", { hasText: "Latest version for Android" });
  await row.waitFor();
  await row.locator("button", { hasText: "Open in browser" }).click();
  await p.waitForFunction(() => window.__OPENED);
  // Always the latest release page, through the Android app's browser bridge (not the opener).
  assert.equal(await p.evaluate(() => window.__OPENED), "https://github.com/knivesbatz/OpenMusic/releases/latest");
  assert.ok(!(await p.evaluate(() => window.__CALLS__.includes("plugin:opener|open_url"))));
}, {
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
  init: () => {
    const d = window.__MOCK__;
    d.app_info = { ...d.app_info, platform: "android" };
    window.OpenMusicMedia = { openInBrowser: (url) => ((window.__OPENED = url), true), update: () => {}, takeLaunch: () => "" };
  },
});

await test("Desktop Settings has no Android download link", async (p) => {
  await openSettings(p);
  await p.waitForSelector(".page h1:has-text('Settings')");
  await p.locator(".setting", { hasText: "Check for updates" }).first().waitFor();
  assert.equal(await p.locator(".setting", { hasText: "Latest version for Android" }).count(), 0);
});

await test("Plex only: Albums lists only saved albums, not the whole server", async (p) => {
  await p.click('.sidebar .side-cat:has-text("Albums")');
  await p.waitForSelector(".page h1:has-text('Albums')");
  await p.waitForSelector("text=Nothing here yet");
  assert.equal(await p.locator(".grid .card").count(), 0);
}, { scenario: "plex" });

await test("Both services: Library Albums lists YouTube's library albums, not the Plex server's", async (p) => {
  await p.click('.sidebar .side-cat:has-text("Albums")');
  await p.waitForSelector(".grid .card");
  const titles = (await p.locator(".grid .card .card-title").allTextContents()).map((x) => x.trim()).sort();
  assert.deepEqual(titles, ["Blue Hour", "Cassette Summer", "Midnight Ferry", "Orbit Season"]);
  // Every card is a YouTube one (badges show with both services on).
  assert.equal(await p.locator('.grid .card[data-source="youtube"]').count(), 4);
  assert.equal(await p.locator('.grid .card[data-source="plex"]').count(), 0);
  // A Plex album saved in the app counts.
  await p.evaluate(() => window.__EMIT__("saved-changed", null));
  await p.waitForFunction(() => [...document.querySelectorAll(".grid .card .card-title")].some((n) => n.textContent.trim() === "Night Drive"));
  assert.equal(await p.locator('.grid .card[data-source="plex"]').count(), 1);
}, { init: () => {
  const d = window.__MOCK__;
  let calls = 0;
  // Saved in the app once the test says so (saved-changed).
  d.saved_list = () => ({ albums: calls++ ? [window.__FIX__.albums[0]] : [], artists: [], playlists: [], podcasts: [] });
} });

await test("Your Library albums sort by name or release year, and the choice sticks", async (p) => {
  await p.click('.sidebar .side-cat:has-text("Albums")');
  await p.waitForSelector(".grid .card");
  const first = async () => (await p.locator(".grid .card .card-title").first().textContent()).trim();
  await p.click("button.lib-sort");
  await p.click('.menu button:has-text("Alphabetical")');
  await p.waitForFunction(() => document.querySelector(".grid .card .card-title")?.textContent?.trim() === "Blue Hour");
  await p.click("button.lib-sort");
  await p.click('.menu button:has-text("Release date")');
  await p.waitForFunction(() => document.querySelector(".grid .card .card-title")?.textContent?.trim() === "Cassette Summer");
  // Leave and come back: still newest first.
  await p.click('.sidebar .side-cat:has-text("Artists")');
  await p.click('.sidebar .side-cat:has-text("Albums")');
  await p.waitForSelector(".grid .card");
  assert.equal(await first(), "Cassette Summer");
}, { youtube: true });

await test("Saved in: check and uncheck playlists for the playing song", async (p) => {
  await p.click('.playerbar button[aria-label="Add to playlist"]');
  const panel = p.locator(".savedin");
  await panel.waitFor();
  const row = (name) => panel.locator(".si-row", { hasText: name }).locator("input");
  await row("Road trip").waitFor();
  assert.equal(await row("Road trip").isChecked(), true);
  assert.equal(await row("Rainy day").isChecked(), false);
  await row("Road trip").click();
  await row("Rainy day").click();
  await p.waitForFunction(() => window.__CALLS__.includes("pl_remove_track") && window.__CALLS__.includes("pl_add"));
  assert.equal(await row("Road trip").isChecked(), false);
  assert.equal(await row("Rainy day").isChecked(), true);
  await p.keyboard.press("Escape");
  assert.equal(await panel.count(), 0);
});

await test(
  "Saved in: YouTube playlists can be added to",
  async (p) => {
    await p.click('.playerbar button[aria-label="Add to playlist"]');
    const box = p.locator(".savedin .si-row", { hasText: "My YouTube mix" }).locator("input");
    await box.click();
    await p.waitForFunction(() => window.__CALLS__.includes("yt_playlist_edit"));
    assert.equal(await box.isChecked(), true);
  },
  { youtube: true },
);

await test(
  "App playlists can be copied to YouTube Music",
  async (p) => {
    await p.locator(".lib-list .side-item", { hasText: "Road trip" }).click();
    await p.click('.page button[aria-label="More options"]');
    await p.click('.menu button:has-text("Copy to YouTube Music")');
    const dlg = p.locator(".dialog");
    // The dialog fills its fields right after it opens.
    await p.waitForFunction(() => document.querySelector(".dialog input")?.value === "Road trip");
    assert.equal(await dlg.locator("select").inputValue(), "PRIVATE");
    await dlg.locator("input").fill("Road trip (YT)");
    await dlg.locator("select").selectOption("UNLISTED");
    await dlg.locator('button:has-text("Copy")').click();
    await p.waitForFunction(() => window.__COPY);
    assert.deepEqual(await p.evaluate(() => window.__COPY), { id: "app:1", title: "Road trip (YT)", privacy: "UNLISTED" });
    // The result lists the songs that weren't found, and opens the new playlist.
    await p.waitForSelector(".dialog h2:has-text('Copied to YouTube Music')");
    const body = await p.locator(".dialog p").textContent();
    assert.ok(body.includes("5 of 6") && body.includes("Someone - Home demo"), body);
    await p.click('.dialog button:has-text("Open playlist")');
    await p.waitForFunction(() => window.__CALLS__.filter((c) => c === "playlist").length >= 2);
  },
  {
    youtube: true,
    init: () => {
      const d = window.__MOCK__;
      const base = d.playlist;
      d.playlist = (a) => (a.id === "app:1" ? { ...base(a), playlist: { id: "app:1", title: "Road trip", artwork: null, trackCount: 6, local: true } } : base(a));
      d.yt_copy_playlist = (a) => ((window.__COPY = a), { playlistId: "yt:VLPLnew", added: 5, missing: ["Someone - Home demo"] });
    },
  },
);

await test(
  "in-app self-test (--self-test, used on Windows CI) reaches the end",
  async (p) => {
    await p.waitForFunction(() => window.__SELFTEST_EXIT, null, { timeout: 90000 });
    const lines = await p.evaluate(() => window.__SELFTEST);
    const fails = lines.filter((l) => l.startsWith("fail"));
    console.log(`  self-test: ${lines.filter((l) => l.startsWith("ok")).length} steps ok${fails.length ? "; " + fails.join("; ") : ""}`);
    if (process.env.DEBUG) console.log(lines.join("\n"));
    assert.equal(lines.at(-1), "done");
    assert.deepEqual(fails, []);
    assert.ok(lines.includes("ok service youtube") && lines.includes("ok service plex"), "the Services switches were not exercised");
    assert.ok(lines.filter((l) => l.startsWith("ok switch")).length >= 5, "switches were not exercised");
    // Every switch went back: the services are as they were, and nobody was signed out.
    assert.deepEqual(await p.evaluate(() => window.__STATE__.services), { youtube: true, plex: true });
    assert.ok(!(await p.evaluate(() => window.__CALLS__.includes("sign_out"))), "a switch signed out");
    assert.deepEqual(await p.evaluate(() => window.__SETTINGS_SAVED__ && Object.keys(window.__SETTINGS_START__).filter((k) => window.__SETTINGS_SAVED__[k] !== window.__SETTINGS_START__[k])), []);
  },
  {
    init: () => {
      window.__SELFTEST = [];
      const d = window.__MOCK__;
      d.app_info = { ...d.app_info, selfTest: true };
      // Saved settings, to see that every switch went back.
      window.__SETTINGS_START__ = { translateNames: true, translateLyrics: true, gapless: true, automix: false, autoplaySimilar: true, normalizeVolume: false, closeToTray: false, autoUpdate: true, privateSession: false, reducedMotion: false, highContrast: false, htpc: false };
      d.settings_get = { ...window.__SETTINGS_START__ };
      d.settings_set = (a) => ((window.__SETTINGS_SAVED__ = a.settings), null);
      d.self_test_log = (a) => (window.__SELFTEST.push(a.line), null);
      d.self_test_exit = () => ((window.__SELFTEST_EXIT = true), null);
    },
  },
);

await test(
  "Top bar: the profile picture opens Spotify's account menu",
  async (p) => {
    await p.waitForSelector(".topbar .avatar-btn img");
    await p.click(".topbar .avatar-btn");
    const items = (await p.locator(".menu > button").allTextContents()).map((x) => x.trim());
    for (const want of ["Account", "Profile", "Recents", "Support", "Private session", "Settings", "Log out"]) assert.ok(items.includes(want), `menu has ${want}: ${items}`);
    // Account opens the provider's account page outside the app.
    await p.click(".menu button:has-text('Account')");
    await p.waitForFunction(() => window.__OPENED.length > 0);
    assert.equal(await p.evaluate(() => window.__OPENED[0]), "https://app.plex.tv/desktop/#!/settings/account");
    // Recents is the recently played list.
    await p.click(".topbar .avatar-btn");
    await p.click(".menu button:has-text('Recents')");
    await p.waitForFunction(() => document.querySelector(".page h1")?.textContent?.includes("Recently played"));
    // The old account name link, transfer and settings buttons are gone from the bar.
    assert.equal(await p.locator(".topbar .account, .topbar .import-btn").count(), 0);
  },
  {
    scenario: "plex",
    init: () => {
      window.__OPENED = [];
      window.__MOCK__["plugin:opener|open_url"] = (a) => (window.__OPENED.push(a.url), null);
    },
  },
);

await test(
  "Profile page: photo, counts, top and recent artists; a new photo and name are kept in the app",
  async (p) => {
    await p.click(".topbar .avatar-btn");
    await p.click(".menu button:has-text('Profile')");
    await p.waitForSelector(".profile-page .hero h1");
    assert.equal((await p.locator(".profile-page .hero h1").textContent()).trim(), "maya");
    const meta = await p.locator(".profile-counts").textContent();
    assert.ok(/\d+ Playlists/.test(meta) && /\d+ Following/.test(meta), meta);
    const heads = (await p.locator(".profile-page .shelf h2").allTextContents()).map((x) => x.trim());
    assert.deepEqual(heads, ["Top artists this month", "Playlists", "Recently played artists"]);
    assert.ok((await p.locator(".shelf-note").textContent()).includes("Only visible to you"));
    // Show all opens the full list.
    await p.locator(".shelf", { hasText: "Top artists this month" }).locator("button.link").click();
    await p.waitForFunction(() => document.querySelector(".page h1")?.textContent === "Top artists this month");
    assert.ok((await p.locator(".grid .card").count()) >= 6);
    await p.click(".topbar .avatar-btn");
    await p.click(".menu button:has-text('Profile')");
    await p.waitForSelector(".profile-page .hero-art-btn");
    // Choose photo → Profile details: pick an image, rename, save.
    await p.click(".profile-page .hero-art-btn");
    await p.waitForSelector(".dialog.profile-edit");
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.click(".dialog.profile-edit .hero-art-btn")]);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
    await chooser.setFiles({ name: "me.png", mimeType: "image/png", buffer: png });
    await p.waitForSelector(".dialog.profile-edit .pe-art img[src^='data:image/jpeg']");
    await p.fill(".dialog.profile-edit input", "Maya K");
    await p.click(".dialog.profile-edit button:has-text('Save')");
    await p.waitForFunction(() => document.querySelector(".profile-page .hero h1")?.textContent === "Maya K");
    const saved = await p.evaluate(() => window.__KV.profile);
    assert.equal(saved.name, "Maya K");
    assert.ok(saved.photo.startsWith("data:image/jpeg"));
    // The top bar shows the new photo too.
    assert.ok((await p.getAttribute(".topbar .avatar-btn img", "src")).startsWith("data:image/jpeg"));
  },
  {
    init: () => {
      window.__KV = {};
      window.__MOCK__.kv_set = (a) => ((window.__KV[a.key] = a.value), null);
    },
  },
);

await test(
  "Browse all: the search box's browse button shows genre tiles that open their page",
  async (p) => {
    await p.click(".browse-btn");
    await p.waitForFunction(() => document.querySelector(".page h1")?.textContent === "Browse all");
    await p.waitForSelector(".browse-tile:has-text('Pop')");
    // Covers load for tiles on screen.
    await p.waitForSelector(".browse-tile .bt-art");
    // Both services on: one group each, with its name.
    assert.deepEqual((await p.locator("h2.browse-group").allTextContents()).map((x) => x.trim()), ["YouTube Music", "Plex"]);
    await p.locator('.browse-tiles[data-provider="youtube"] .browse-tile', { hasText: "Feel good" }).waitFor();
    // Your library shortcuts are still there.
    assert.ok(await p.locator("h2", { hasText: "Your library" }).count());
    await p.click(".browse-tile:has-text('Pop')");
    await p.waitForFunction(() => document.querySelector(".page h1")?.textContent === "Pop");
    const heads = (await p.locator(".shelf h2").allTextContents()).map((x) => x.trim());
    assert.deepEqual(heads, ["Albums", "Artists"]);
  },
);

await test("Your Library: Spotify's Sort by and View as menu, remembered", async (p) => {
  const lib = p.locator(".lib-list");
  await lib.locator(".side-item", { hasText: "Road trip" }).waitFor();
  await p.click(".side-section .side-sort");
  const items = (await p.locator(".menu > button").allTextContents()).map((x) => x.trim().replace("✓", ""));
  assert.deepEqual(items.slice(0, 5), ["Recents", "Recently added", "Alphabetical", "Creator", "Custom order"]);
  assert.equal(await p.locator(".menu-icons button").count(), 4);
  // Alphabetical.
  await p.click('.menu button:has-text("Alphabetical")');
  const names = (await lib.locator(".side-item .name").allTextContents()).map((x) => x.trim());
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  // Grid: covers with names; compact grid: covers only; compact: no covers.
  await p.click(".side-section .side-sort");
  await p.click('.menu-icons button[aria-label="Grid"]');
  await p.waitForSelector(".lib-entries.view-grid .side-item .art");
  await p.click(".side-section .side-sort");
  await p.click('.menu-icons button[aria-label="Compact grid"]');
  await p.waitForSelector(".lib-entries.view-compactGrid");
  assert.equal(await lib.locator(".side-item .name").count(), 0);
  await p.click(".side-section .side-sort");
  await p.click('.menu-icons button[aria-label="Compact"]');
  await p.waitForSelector(".lib-entries.view-compact");
  assert.equal(await lib.locator(".side-item .art").count(), 0);
  assert.ok((await lib.locator(".side-item", { hasText: "Road trip" }).textContent()).includes("• Playlist"));
  // Saved for next time.
  await p.waitForFunction(() => window.__KV.libraryOrg?.view === "compact");
  assert.equal(await p.evaluate(() => window.__KV.libraryOrg.sort), "alpha");
}, {
  init: () => {
    window.__KV = {};
    window.__MOCK__.kv_set = (a) => ((window.__KV[a.key] = a.value), null);
  },
});

await test("Updates: a new version found at startup downloads and installs while nothing plays", async (p) => {
  await p.waitForFunction(() => window.__CALLS__.includes("update_restart"), null, { timeout: 12000 });
  const calls = await p.evaluate(() => window.__CALLS__);
  assert.ok(calls.indexOf("update_check") < calls.indexOf("update_download") && calls.indexOf("update_download") < calls.indexOf("update_restart"), calls.join(","));
  assert.ok((await p.locator(".toast").allTextContents()).some((x) => x.includes("Updating to 9.9.9")));
  assert.deepEqual(await p.evaluate(() => window.__KV["update.autoInstall"]?.version), "9.9.9");
}, {
  init: () => {
    const d = window.__MOCK__;
    window.__KV = {};
    d.kv_set = (a) => ((window.__KV[a.key] = a.value), null);
    d.update_check = { available: true, current: "1.4.0", version: "9.9.9", url: "https://github.com/knivesbatz/OpenMusic/releases/download/v9.9.9/OpenSpot_9.9.9_x64-setup.exe", ready: false };
    d.update_download = null;
    d.update_restart = null;
  },
});

await test("Updates: a version already tried at a recent start isn't installed again", async (p) => {
  await p.waitForFunction(() => window.__CALLS__.includes("update_download"), null, { timeout: 12000 });
  await p.waitForTimeout(2500);
  assert.ok(!(await p.evaluate(() => window.__CALLS__.includes("update_restart"))));
  // It waits for the app to close instead: the banner offers Restart to update.
  await p.waitForSelector(".update-banner");
}, {
  init: () => {
    const d = window.__MOCK__;
    d.kv_get = (a) => (a.key === "update.autoInstall" ? { version: "9.9.9", at: Date.now() - 60_000 } : null);
    d.update_check = { available: true, current: "1.4.0", version: "9.9.9", url: "https://github.com/knivesbatz/OpenMusic/releases/download/v9.9.9/OpenSpot_9.9.9_x64-setup.exe", ready: false };
    d.update_download = null;
    d.update_restart = null;
  },
});

await test("YouTube: your own playlist can be deleted from YouTube, after a confirmation", async (p) => {
  const lib = p.locator(".lib-list");
  const row = lib.locator(".side-item", { hasText: "My mix" });
  await row.waitFor();
  await row.click({ button: "right" });
  const items = (await p.locator(".menu > button").allTextContents()).map((x) => x.trim());
  assert.ok(items.includes("Delete from YouTube"), items.join(", "));
  assert.ok(!items.some((x) => x.includes("Open in YouTube")), items.join(", "));
  await p.click('.menu button:has-text("Delete from YouTube")');
  await p.waitForSelector(".dialog");
  assert.ok((await p.locator(".dialog").textContent()).includes("can't be undone"));
  await p.click('.dialog button:has-text("Delete")');
  await p.waitForFunction(() => window.__DELETED?.length === 1);
  assert.equal(await p.evaluate(() => window.__DELETED[0]), "yt:VLPLmine");
  await p.waitForFunction(() => ![...document.querySelectorAll(".lib-list .side-item .name")].some((n) => n.textContent === "My mix"));
  // Built-in lists (Liked Music, mixes) never offer it.
  await lib.locator(".side-item", { hasText: "Supermix" }).click({ button: "right" });
  assert.ok(!(await p.locator(".menu > button").allTextContents()).some((x) => x.includes("Delete from YouTube")));
}, {
  youtube: true,
  init: () => {
    const d = window.__MOCK__;
    window.__DELETED = [];
    const mine = { id: "yt:VLPLmine", title: "My mix", trackCount: 3, owner: "Me", local: false };
    const mix = { id: "yt:VLRDTMAK5uy", title: "Supermix", local: false };
    let pls = [mine, mix];
    const base = d.library;
    d.library = () => ({ ...(typeof base === "function" ? base() : base), playlists: pls });
    d.yt_delete_playlist = (a) => (window.__DELETED.push(a.id), (pls = pls.filter((x) => x.id !== a.id)), null);
  },
});

await test("Android: a new version found at startup is downloaded and installed by the app", async (p) => {
  await p.waitForFunction(() => window.__INSTALL?.length === 1, null, { timeout: 12000 });
  assert.equal(await p.evaluate(() => window.__INSTALL[0]), "https://github.com/knivesbatz/OpenMusic/releases/download/v9.9.9/OpenSpot_9.9.9_android-arm64.apk");
  assert.ok(!(await p.evaluate(() => window.__CALLS__.includes("plugin:opener|open_url"))));
}, {
  init: () => {
    const d = window.__MOCK__;
    d.app_info = { ...d.app_info, platform: "android" };
    window.__INSTALL = [];
    window.OpenMusicMedia = { update() {}, installUpdate: (url) => (window.__INSTALL.push(url), true) };
    d.update_check = { available: true, current: "1.4.1", version: "9.9.9", url: "https://github.com/knivesbatz/OpenMusic/releases/download/v9.9.9/OpenSpot_9.9.9_android-arm64.apk", ready: false };
  },
});

await test("Phone: library tabs, Find in playlist + Sort sheet, pinned bar with play", async (p) => {
  await p.setViewportSize({ width: 390, height: 844 });
  // Three tabs, no Create.
  assert.deepEqual(await p.locator(".mobile-tabs button span").allTextContents(), ["Home", "Search", "Your Library"]);
  // Your Library: Playlists · Artists · Albums tabs; tapping the open one again shows everything.
  await p.click('.mobile-tabs button:has-text("Your Library")');
  await p.locator(".lib-phone .lib-tab", { hasText: "Albums" }).click();
  await p.locator(".lib-phone .lib-tab.on", { hasText: "Albums" }).waitFor();
  await p.locator(".lib-phone .lib-tab", { hasText: "Albums" }).click();
  await p.waitForFunction(() => !document.querySelector(".lib-phone .lib-tab.on"));
  // A playlist: Find in playlist and Sort above the cover; Sort opens the Sort by sheet.
  await p.locator(".lib-row", { hasText: "Road trip" }).first().click();
  const before = await p.locator(".detail .tl-row .tl-text .name").allTextContents();
  await p.locator(".pl-findbar .pl-sortbtn").click();
  await p.locator(".menu-sheet .sheet-item", { hasText: "Title" }).click();
  await p.waitForFunction(() => !document.querySelector(".menu-sheet"));
  const after = await p.locator(".detail .tl-row .tl-text .name").allTextContents();
  assert.notDeepEqual(after, before, "the order changed");
  await p.locator(".pl-findbar .pl-sortbtn").click();
  await p.locator(".menu-sheet .sheet-item.on", { hasText: "Title" }).waitFor();
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => !document.querySelector(".menu-sheet"));
  await p.fill(".pl-findfield input", "zzzz-no-match");
  await p.locator(".detail .muted", { hasText: "No" }).first().waitFor();
  await p.fill(".pl-findfield input", "");
  // Scrolled past the play button: the bar pins with the name and its own play button.
  await p.evaluate(() => document.querySelector(".main").scrollTo(0, 2000));
  await p.locator(".topbar.detail-bar.pinned .bar-fab").waitFor();
  const name = (await p.locator(".detail .hero h1").textContent()).trim();
  assert.equal((await p.locator(".topbar.detail-bar .phone-title").textContent()).trim(), name);
  // Its play button starts this playlist (the mock's Android player never reports "playing").
  await p.evaluate(() => (window.__CALLS__.length = 0));
  await p.click(".topbar.detail-bar .bar-fab");
  await p.waitForFunction(() => window.__CALLS__.includes("resolve_stream"));
}, {
  init: () => {
    const d = window.__MOCK__;
    d.app_info = { ...d.app_info, platform: "android" };
  },
});

// ---- OpenSpot: two services ---------------------------------------------------------------------

/** Settings → Services switch of one provider. */
const serviceSwitch = (p, provider) => p.locator(`input[role="switch"][data-service="${provider}"]`);
/** Type a search (cleared first, so the same query is asked again). */
async function search(p, q) {
  await p.fill("#global-search", "");
  await p.fill("#global-search", q);
}
// Visible source badges were removed (the user asked); rows and cards carry an invisible data-source.
const badges = (p) => p.locator(".src-badge");
const srcs = (p, source) => p.locator(`[data-source="${source}"]`);

await test("Services: switching Plex off hides it everywhere and forgets its search results; back on brings it back", async (p) => {
  // Both on: Plex and YouTube shelves on Home.
  await p.locator(".shelf .card", { hasText: "Night Drive" }).first().waitFor();
  await p.locator(".shelf .card", { hasText: "Blue Hour" }).first().waitFor();
  await search(p, "aster");
  await p.waitForSelector(".top-result .top-name:has-text('Aster Vale')");
  await p.locator('.top-songs [data-source="plex"]').first().waitFor();
  await p.locator(".lib-list .side-item", { hasText: "autumn" }).waitFor();
  await p.fill("#global-search", "");
  await p.click(".browse-btn");
  await p.waitForSelector(".browse-tile:has-text('Jazz')");
  // Off: no question, no sign-out, the sign-in is kept.
  await openSettings(p);
  await serviceSwitch(p, "plex").click();
  assert.equal(await serviceSwitch(p, "plex").isChecked(), false);
  await p.waitForTimeout(300);
  assert.equal(await p.locator(".dialog, .modal-bg").count(), 0, "a dialog opened");
  assert.deepEqual(await p.evaluate(() => window.__STATE__.services), { youtube: true, plex: false });
  assert.ok(!(await p.evaluate(() => window.__CALLS__.includes("sign_out"))), "signed out");
  assert.equal(await p.evaluate(() => window.__STATE__.auth.plex.signedIn), true);
  // Sidebar: Plex's playlists are gone, YouTube's and the app's stay.
  await p.waitForFunction(() => ![...document.querySelectorAll(".lib-list .side-item .name")].some((n) => n.textContent === "autumn"));
  await p.locator(".lib-list .side-item", { hasText: "My YouTube mix" }).waitFor();
  await p.locator(".lib-list .side-item", { hasText: "Road trip" }).waitFor();
  // Home: only YouTube's shelves, without source badges (one service).
  await p.click('button[aria-label="Home"]');
  await p.locator(".shelf .card", { hasText: "Blue Hour" }).first().waitFor();
  assert.equal(await p.locator(".shelf .card", { hasText: "Night Drive" }).count(), 0, "Plex shelf still on Home");
  assert.equal(await badges(p).count(), 0, "badges with one service");
  // The same search again: YouTube's answer only, not the one cached with Plex.
  await search(p, "aster");
  await p.waitForSelector(".top-result .top-name:has-text('Luna Park')");
  const songs = await p.locator(".page .tl-row:not(.tl-head) .name").allTextContents();
  assert.ok(songs.length > 0 && !songs.some((n) => ["Slow Lights", "Halfway Home", "Paper Planes"].includes(n.trim())), `Plex songs still in the results: ${songs}`);
  assert.equal(await p.locator(".page .card", { hasText: "Aster Vale" }).count(), 0, "Plex artist still in the results");
  assert.equal(await badges(p).count(), 0);
  // Browse all: YouTube's moods only, no group headings.
  await p.fill("#global-search", "");
  await p.click(".browse-btn");
  await p.waitForSelector(".browse-tile:has-text('Feel good')");
  assert.equal(await p.locator(".browse-tile", { hasText: "Jazz" }).count(), 0, "Plex genres still in Browse all");
  assert.equal(await p.locator("h2.browse-group").count(), 0);
  // Back on: Plex is back in search, with badges.
  await openSettings(p);
  await serviceSwitch(p, "plex").click();
  await p.waitForFunction(() => window.__STATE__.services.plex);
  await search(p, "aster");
  await p.waitForSelector(".top-result .top-name:has-text('Aster Vale')");
  await srcs(p, "plex").first().waitFor();
  await srcs(p, "youtube").first().waitFor();
  assert.equal(await badges(p).count(), 0, "no visible source badges, even with both services on");
  await p.click(".lib-list .side-item >> text=autumn");
});

await test("Combined search: each section mixes both services, and every row and card shows its source", async (p) => {
  await search(p, "aster");
  await p.waitForSelector(".top-result .top-name:has-text('Aster Vale')");
  // The Top result is the best title match (Plex's artist), with its badge.
  await p.locator('.top-result .top-card[data-source="plex"]').waitFor();
  // Songs: Plex's, YouTube's and the local file, each with its own mark.
  await p.locator('.top-songs .tl-row[data-source="youtube"]').first().waitFor();
  assert.ok((await p.locator('.top-songs .tl-row[data-source="plex"]').count()) > 0);
  await p.locator(".top-songs .tl-row .name", { hasText: "home demo" }).waitFor();
  // Artists and albums interleave the two services.
  const artists = p.locator(".shelf", { has: p.locator("h2", { hasText: /^Artists$/ }) });
  const sources = await artists.locator(".card[data-source]").evaluateAll((els) => els.map((e) => e.dataset.source));
  assert.deepEqual(sources.slice(0, 4), ["plex", "youtube", "plex", "youtube"]);
  // A filter chip asks both services for the full list.
  await p.click('.chips button:has-text("Albums")');
  await p.locator(".grid .card", { hasText: "Blue Hour" }).waitFor();
  await p.locator(".grid .card", { hasText: "Night Drive" }).waitFor();
  // Podcasts come from YouTube Music only; the chip is there because YouTube is on.
  await p.click('.chips button:has-text("Podcasts")');
  await p.locator(".grid .card", { hasText: "Conspiracy Theories" }).waitFor();
});

await test("Only YouTube Music on looks like YTSpot 1.6.1: no source badges, no Browse group headings, no Plex", async (p) => {
  await p.locator(".shelf .card", { hasText: "Blue Hour" }).first().waitFor();
  assert.equal(await badges(p).count(), 0, "badges on Home or the sidebar");
  assert.equal(await p.locator(".shelf .card", { hasText: "Night Drive" }).count(), 0);
  await search(p, "aster");
  await p.waitForSelector(".top-result .top-name");
  await p.locator(".top-songs .tl-row").first().waitFor();
  assert.equal(await badges(p).count(), 0, "badges in search");
  assert.equal(await p.evaluate(() => window.__CALLS__.filter((c) => c === "search").length), 2, "asked YouTube and local files");
  await p.fill("#global-search", "");
  await p.click(".browse-btn");
  await p.waitForSelector(".browse-tile:has-text('Feel good')");
  assert.equal(await p.locator("h2.browse-group").count(), 0);
  // No Plex-only entries (Downloads) in the sidebar; podcasts are there.
  assert.equal(await p.locator('.sidebar .side-cat:has-text("Downloads")').count(), 0);
  await p.locator('.sidebar .side-cat:has-text("Podcasts")').waitFor();
  // The avatar menu reads as before: one account, Log out.
  await p.click(".topbar .avatar-btn");
  const items = (await p.locator(".menu > button").allTextContents()).map((x) => x.trim());
  assert.ok(items.includes("Log out") && items.includes("Account") && !items.includes("Services…"), items.join(", "));
}, { scenario: "youtube" });

await test("Account menu with both services: Account and Switch profile per service; Plex signs out in Settings and YouTube stays", async (p) => {
  await p.click(".topbar .avatar-btn");
  const items = (await p.locator(".menu > button").allTextContents()).map((x) => x.trim());
  assert.ok(items.includes("Services…") && !items.includes("Log out"), items.join(", "));
  await p.hover('.menu button:has-text("Account")');
  assert.deepEqual((await p.locator(".menu.sub button").allTextContents()).map((x) => x.trim()), ["YouTube Music", "Plex"]);
  await p.click('.menu > button:has-text("Services…")');
  await p.waitForSelector(".page.settings section.services");
  // Sign out of Plex only, after a confirmation that names it.
  const plexCard = p.locator(".services .service", { has: serviceSwitch(p, "plex") });
  await plexCard.locator("button", { hasText: "Sign out" }).click();
  await p.waitForSelector(".dialog");
  assert.ok((await p.locator(".dialog").textContent()).includes("Plex"));
  await p.click('.dialog button:has-text("Sign out")');
  await p.waitForFunction(() => window.__STATE__.auth.plex.signedIn === false);
  // Plex is off and offers Sign in; YouTube is untouched; the app stays open.
  await plexCard.locator('[data-testid="signin-plex"]').waitFor();
  await p.waitForFunction(() => !document.querySelector('input[data-service="plex"]').checked);
  assert.equal(await serviceSwitch(p, "youtube").isChecked(), true);
  assert.equal(await p.evaluate(() => window.__STATE__.auth.youtube.signedIn), true);
  assert.equal(await p.locator(".login").count(), 0);
  await p.waitForFunction(() => ![...document.querySelectorAll(".lib-list .side-item .name")].some((n) => n.textContent === "autumn"));
});

await test("One service's session expiring never signs you out: the other's shelves stay, with a note and a Sign in", async (p) => {
  // Home: Plex's part failed with authExpired (the core could not repair it); YouTube's arrived.
  await p.locator(".shelf .card", { hasText: "Blue Hour" }).first().waitFor();
  await p.locator('.provider-note[data-provider="plex"]').waitFor();
  assert.ok((await p.locator('.provider-note[data-provider="plex"]').textContent()).includes("Plex"));
  assert.equal(await p.locator(".page .error-box, .page [role=alert]").count(), 0, "an error box instead of the shelves");
  await p.locator('.toast:has-text("Plex: your session expired")').waitFor();
  assert.equal(await p.locator(".login").count(), 0, "bounced to the Connect page");
  // Then YouTube's session expires too (an auth-expired event): still no Connect page.
  await p.evaluate(() => window.__EMIT__("auth-expired", { provider: "youtube" }));
  await p.locator('.toast:has-text("YouTube Music: your session expired")').waitFor();
  assert.equal(await p.locator(".login").count(), 0);
  await p.locator(".shelf .card", { hasText: "Blue Hour" }).first().waitFor();
  // Both switches stay on.
  assert.deepEqual(await p.evaluate(() => window.__STATE__.services), { youtube: true, plex: true });
  // The Plex toast's Sign in starts a Plex sign-in in Settings → Services (YouTube stays as it is).
  await p.click('.toast:has-text("Plex: your session expired") button:has-text("Sign in")');
  await p.waitForSelector(".page.settings section.services");
  await p.locator(".services .service", { hasText: "PIN: ABCD" }).waitFor();
  assert.ok(await p.evaluate(() => window.__CALLS__.includes("plex_pin_start")));
  assert.equal(await serviceSwitch(p, "youtube").isChecked(), true);
}, { init: () => {
  const d = window.__MOCK__;
  const base = d.home;
  d.home = () => {
    const h = base();
    h.shelves = h.shelves.filter((s) => s.items.every((i) => i.id.startsWith("yt:")));
    h.errors = [{ provider: "plex", code: "authExpired", message: "Plex session expired" }];
    return h;
  };
} });

await test("A fresh install shows Connect your music; Skip — local files only opens the app and survives a reload", async (p) => {
  assert.equal((await p.locator(".login h1").textContent()).trim(), "Connect your music");
  for (const id of ["connect-youtube", "connect-plex", "connect-anonymous", "connect-local"]) await p.locator(`[data-testid="${id}"]`).waitFor();
  await p.click('[data-testid="connect-local"]');
  await p.waitForSelector(".sidebar");
  assert.equal(await p.evaluate(() => window.__STATE__.kv.localOnly), true);
  // Nothing of a service shows; app playlists do.
  await p.locator(".lib-list .side-item", { hasText: "Road trip" }).waitFor();
  assert.equal(await p.locator(".lib-list .side-item", { hasText: "My YouTube mix" }).count(), 0);
  await p.reload();
  await p.waitForSelector(".sidebar");
  assert.equal(await p.locator(".login").count(), 0, "the Connect page came back after a reload");
  // Settings: both services off; Plex turns on by signing in, YouTube can be switched on.
  await openSettings(p);
  assert.equal(await serviceSwitch(p, "youtube").isChecked(), false);
  assert.equal(await serviceSwitch(p, "plex").isChecked(), false);
  assert.equal(await serviceSwitch(p, "plex").isDisabled(), true);
  await p.locator('[data-testid="signin-plex"]').waitFor();
}, { scenario: "fresh", ready: '[data-testid="connect-local"]' });

await test("Connect your music: YouTube Music without an account turns YouTube on and opens the app", async (p) => {
  await p.click('[data-testid="connect-anonymous"]');
  await p.waitForSelector(".sidebar");
  assert.deepEqual(await p.evaluate(() => window.__STATE__.services), { youtube: true, plex: false });
  await p.locator(".shelf .card", { hasText: "Blue Hour" }).first().waitFor();
}, { scenario: "fresh", ready: '[data-testid="connect-local"]', init: () => {
  // Nobody signed in: YouTube answers anonymously.
  window.__STATE__.auth.youtube.signedIn = false;
} });

await test("Liked Songs combines YouTube's liked songs and Plex's; with YouTube off, Plex's only", async (p) => {
  // YouTube's Liked Music is the Liked Songs page, never a playlist row.
  await p.locator(".lib-list .side-item", { hasText: "My YouTube mix" }).waitFor();
  assert.equal(await p.locator(".lib-list .side-item", { hasText: "Liked Music" }).count(), 0);
  await p.click('.sidebar .side-cat:has-text("Liked Songs")');
  await p.waitForSelector(".page h1:has-text('Liked Songs')");
  const names = async () => (await p.locator(".page .tl-row:not(.tl-head) .name").allTextContents()).map((x) => x.trim());
  await p.waitForFunction(() => document.querySelectorAll(".page .tl-row:not(.tl-head)").length === 5);
  assert.deepEqual((await names()).sort(), ["Cassette Heart", "Ferry Lights", "Glasshouse", "Orbit", "Undertow"]);
  assert.equal(await p.locator('.page .tl-row[data-source="youtube"]').count(), 3);
  assert.equal(await p.locator('.page .tl-row[data-source="plex"]').count(), 2);
  await openSettings(p);
  await serviceSwitch(p, "youtube").click();
  await p.waitForFunction(() => !window.__STATE__.services.youtube);
  await p.click('.sidebar .side-cat:has-text("Liked Songs")');
  await p.waitForFunction(() => document.querySelectorAll(".page .tl-row:not(.tl-head)").length === 2);
  assert.deepEqual((await names()).sort(), ["Glasshouse", "Undertow"]);
  assert.equal(await badges(p).count(), 0);
});

await test("Only YouTube on: Liked Songs is YTSpot 1.6.1's Liked Music playlist page (cover wash, owner, Find/Sort, playlist menu)", async (p) => {
  await p.click('.sidebar .side-cat:has-text("Liked Songs")');
  await p.waitForSelector(".page.detail .hero h1:has-text('Liked Music')");
  await p.waitForFunction(() => document.querySelectorAll(".page .tl-row:not(.tl-head)").length === 3);
  // The Hero of a playlist: its colour wash and cover, not the combined page's heart tile.
  assert.equal(await p.locator(".page .hero .hero-wash").count(), 1);
  assert.equal(await p.locator(".page .hero .grad-liked").count(), 0);
  assert.equal((await p.locator(".page .hero .hero-owner strong").textContent()).trim(), "Me");
  await p.locator(".action-bar .ab-right .sort-btn").waitFor();
  assert.equal(await badges(p).count(), 0);
  assert.ok(await p.evaluate(() => window.__CALLS__.includes("playlist")), "asked for yt:LM like 1.6.1");
  await p.click('.action-bar button[aria-label="More options"]');
  const items = (await p.locator(".menu > button").allTextContents()).map((x) => x.trim());
  assert.ok(items.some((x) => x.startsWith("Move to folder")) && items.some((x) => x.startsWith("Export")), items.join(", "));
}, { scenario: "youtube" });

await test("Plex on with a token but no server: the Connect page shows the server list, as PLEXSpot 1.6.1 did", async (p) => {
  await p.locator(".login .server", { hasText: "Home server" }).click();
  await p.waitForSelector(".playerbar");
  assert.equal(await p.locator(".login").count(), 0);
  assert.deepEqual(await p.evaluate(() => window.__SELECTED), ["srv1"]);
}, { scenario: "plex", ready: ".login .server", init: () => {
  const d = window.__MOCK__;
  const st = window.__STATE__;
  window.__SELECTED = [];
  st.auth.plex = { signedIn: true, account: "demo", server: null, serverConnection: null, needsServer: true };
  d.plex_servers = [{ name: "Home server", clientIdentifier: "srv1", owned: true, connections: [{ uri: "http://192.168.1.5:32400", local: true, relay: false }] }];
  d.plex_select_server = (a) => {
    window.__SELECTED.push(a.clientIdentifier);
    st.auth.plex = { signedIn: true, account: "demo", server: "Home server", serverConnection: "local", needsServer: false };
    setTimeout(() => (window.__EMIT__("services-changed", st.services), window.__EMIT__("auth-changed", { provider: "plex" })), 0);
    return "Home server";
  };
} });

await test("Only YouTube on: search keeps its spinner, then the last results, until YouTube answers (local files never stand alone)", async (p) => {
  await search(p, "aster");
  await p.locator(".page.search [role='status'] .spinner").waitFor();
  // Local files have answered; YouTube hasn't: no half-empty page.
  await p.waitForFunction(() => window.__CALLS__.filter((c) => c === "search").length === 2);
  await p.waitForTimeout(150);
  assert.equal(await p.locator(".search-top").count(), 0, "nothing rendered before YouTube answers");
  await p.evaluate(() => window.__releaseYt());
  await p.waitForSelector(".top-result .top-name");
  assert.equal((await p.locator(".top-result .top-name").textContent()).trim(), "Luna Park");
  // The next query: the last results stay on screen until YouTube answers again.
  await p.fill("#global-search", "aster v");
  await p.waitForFunction(() => window.__CALLS__.filter((c) => c === "search").length === 4);
  await p.waitForTimeout(150);
  assert.equal((await p.locator(".top-result .top-name").textContent()).trim(), "Luna Park");
  await p.evaluate(() => window.__releaseYt());
  await p.waitForFunction(() => document.querySelector(".top-result .top-name")?.textContent.trim() === "Kite Runners");
}, { scenario: "youtube", init: () => {
  const d = window.__MOCK__;
  const base = d.search;
  let n = 0;
  let release = [];
  window.__releaseYt = () => (release.forEach((r) => r()), (release = []));
  d.search = (a) => {
    if (a.provider !== "youtube") return base(a);
    const r = base(a);
    // A different top result per query, to tell the answers apart.
    r.top = { type: "artist", ...window.__FIX__.ytArtists[n++ % 2] };
    return new Promise((res) => release.push(() => res(r)));
  };
} });

await test("Japanese: the Settings → Services section", async (p) => {
  await openSettings(p);
  await p.click('button[aria-label="Language"]');
  await p.click('.menu button:has-text("日本語")');
  await p.waitForSelector(".page.settings section.services h2:has-text('サービス')");
  const section = p.locator(".page.settings section.services");
  assert.equal(await section.locator(".service").count(), 2);
  assert.equal(await section.locator('button:has-text("サインアウト")').count(), 2);
  assert.ok((await section.textContent()).includes("サインイン中"), await section.textContent());
});

await test("Japanese: Connect your music on a fresh install", async (p) => {
  await p.waitForSelector(".login h1:has-text('音楽を接続')");
  await p.locator('[data-testid="connect-local"]:has-text("ローカルファイルのみ")').waitFor();
  await p.locator('[data-testid="connect-anonymous"]:has-text("アカウントなし")').waitFor();
}, { scenario: "fresh", ready: '[data-testid="connect-local"]', init: () => (window.__MOCK__.settings_get = { language: "ja" }) });

await test("Plex sign-in from Settings while YouTube is on: PIN, then the server list in the Plex card; the app stays put", async (p) => {
  await openSettings(p);
  await p.click('[data-testid="signin-plex"]');
  const card = p.locator(".services .service", { has: serviceSwitch(p, "plex") });
  await card.locator(".server", { hasText: "Home server" }).waitFor();
  assert.ok(await p.evaluate(() => window.__CALLS__.includes("plugin:opener|open_url")), "plex.tv opened");
  await card.locator(".server", { hasText: "Home server" }).click();
  await p.waitForFunction(() => document.querySelector('input[data-service="plex"]')?.checked);
  // Still in Settings (no Connect page, no jump), YouTube untouched, Plex's playlists arrive.
  assert.equal(await p.locator(".page.settings").count(), 1);
  assert.equal(await p.locator(".login").count(), 0);
  assert.equal(await serviceSwitch(p, "youtube").isChecked(), true);
  await p.locator(".lib-list .side-item", { hasText: "autumn" }).waitFor();
  assert.deepEqual(await p.evaluate(() => window.__SELECTED), ["srv1"]);
}, { scenario: "youtube", init: () => {
  const d = window.__MOCK__;
  const st = window.__STATE__;
  window.__SELECTED = [];
  d.plex_pin_poll = () => ((st.auth.plex = { signedIn: true, account: "demo", server: null, serverConnection: null, needsServer: true }), true);
  d.plex_servers = [{ name: "Home server", clientIdentifier: "srv1", owned: true, connections: [{ uri: "http://192.168.1.5:32400", local: true, relay: false }] }];
  // As the core does: a chosen server turns Plex on.
  d.plex_select_server = (a) => {
    window.__SELECTED.push(a.clientIdentifier);
    st.auth.plex = { signedIn: true, account: "demo", server: "Home server", serverConnection: "local", needsServer: false };
    st.services.plex = true;
    setTimeout(() => (window.__EMIT__("services-changed", st.services), window.__EMIT__("auth-changed", { provider: "plex" })), 0);
    return "Home server";
  };
} });

await test("Android: a Plex sign-in that left for plex.tv resumes in Settings when the app comes back", async (p) => {
  await p.waitForSelector(".page.settings section.services");
  await p.locator(".services .service", { hasText: "PIN: WXYZ" }).waitFor();
  assert.equal(await p.evaluate(() => localStorage.getItem("plex.pendingPin")), null, "the pending PIN is used once");
}, { scenario: "youtube", init: () => {
  if (!sessionStorage.getItem("resumed")) {
    sessionStorage.setItem("resumed", "1");
    localStorage.setItem("plex.pendingPin", JSON.stringify({ id: 7, code: "WXYZ", origin: "settings" }));
  }
} });

/** Init for the mixed-queue tests: a fake YouTube IFrame player, 1.5-second tones as Plex streams,
 * and a queue that goes Plex, YouTube, Plex, YouTube. */
const mixedQueue = () => {
  window.__YT_LOADS = [];
  window.YT = {
    PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2 },
    Player: class {
      constructor(el, opts) {
        this.ev = opts.events;
        this.t0 = 0;
        this.timers = [];
        setTimeout(() => this.ev.onReady(), 10);
      }
      run() {
        this.clear();
        this.t0 = Date.now();
        this.timers.push(setTimeout(() => this.ev.onStateChange({ data: 1 }), 30), setTimeout(() => this.ev.onStateChange({ data: 0 }), 1500));
      }
      clear() { this.timers.forEach(clearTimeout); this.timers = []; }
      loadVideoById(o) { window.__YT_LOADS.push(o.videoId); this.run(); }
      cueVideoById(o) { this.cued = o.videoId; }
      playVideo() { if (this.cued) window.__YT_LOADS.push(this.cued), (this.cued = null); this.run(); }
      pauseVideo() { this.clear(); this.ev.onStateChange({ data: 2 }); }
      stopVideo() { this.clear(); }
      seekTo() {}
      setVolume() {}
      getCurrentTime() { return this.t0 ? (Date.now() - this.t0) / 1000 : 0; }
      getDuration() { return 1.5; }
      destroy() { this.clear(); }
    },
  };
  const rate = 8000, n = Math.round(rate * 1.5), buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(20 * Math.sin(i / 8)));
  const wav = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  const d = window.__MOCK__;
  const f = window.__FIX__;
  d.resolve_stream = (a) => (a.track.id.startsWith("yt:") ? { kind: "youtube", videoId: a.track.streamKey } : { kind: "url", url: wav, quality: "test", offline: false });
  d.settings_get = { crossfade: 0, volume: 0.5, gapless: false };
  const list = [f.tracks[0], f.ytTracks[0], f.tracks[1], f.ytTracks[1]].map((t) => ({ ...t, durationMs: 1500 }));
  d.queue_load = { tracks: list.map((t) => ({ t, m: false })), index: 0, context: null, position: 0, shuffle: false, repeat: "off" };
};
const nowPlaying = (p) => p.evaluate(() => document.querySelector(".pb-meta .name")?.textContent?.trim());

await test("Mixed queue: a Plex song, then a YouTube song, then Plex again play one after another", async (p) => {
  assert.equal(await nowPlaying(p), "Slow Lights");
  await p.click('.playerbar button[aria-label="Play"]');
  const seen = ["Slow Lights"];
  const deadline = Date.now() + 20000;
  while (seen.length < 4 && Date.now() < deadline) {
    const n = await nowPlaying(p);
    if (n && n !== seen.at(-1)) seen.push(n);
    await p.waitForTimeout(100);
  }
  assert.deepEqual(seen, ["Slow Lights", "Ferry Lights", "Halfway Home", "Orbit"]);
  assert.deepEqual(await p.evaluate(() => window.__YT_LOADS), ["vid0", "vid1"]);
}, { init: mixedQueue });

await test("Mixed queue with YouTube off: its songs are skipped, the Plex ones play", async (p) => {
  assert.equal(await nowPlaying(p), "Slow Lights");
  await p.click('.playerbar button[aria-label="Next"]');
  await p.waitForFunction(() => document.querySelector(".pb-meta .name")?.textContent?.trim() !== "Slow Lights");
  assert.equal(await nowPlaying(p), "Halfway Home");
  assert.deepEqual(await p.evaluate(() => window.__YT_LOADS), []);
  // Back skips it too.
  await p.click('.playerbar button[aria-label="Previous"]');
  await p.click('.playerbar button[aria-label="Previous"]');
  await p.waitForFunction(() => document.querySelector(".pb-meta .name")?.textContent?.trim() === "Slow Lights");
}, { scenario: "plex", init: mixedQueue });

await browser.close();
server.httpServer.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
