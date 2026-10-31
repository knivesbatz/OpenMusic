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

async function test(name, fn, { youtube = false, init, userAgent } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, userAgent });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let r;
  const t0 = Date.now();
  try {
    await page.addInitScript({ path: mock });
    if (youtube) await page.addInitScript({ path: ytOverrides });
    if (init) await page.addInitScript(init);
    await page.goto(base);
    await page.waitForSelector(".playerbar");
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
  await p.click('button[aria-label="Settings"]');
  for (const mode of ["Romaji", "Both", "Japanese script"]) {
    await p.click('button[aria-label="Japanese text"]');
    await p.click(`.menu button:has-text("${mode}")`);
  }
  for (const s of await p.locator('input[role="switch"]:not(:disabled)').all()) {
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
  for (let i = 0; i < 2; i++) await p.click(".side-section .link");
  assert.equal((await p.locator(".side-section .link").textContent()).trim(), "Custom order");
  const names = async () => await lib.locator(".side-item .name").allTextContents();
  await lib.locator(".side-item", { hasText: /^End/ }).dragTo(lib.locator(".side-item", { hasText: "Moods" }), { targetPosition: { x: 40, y: 2 } });
  const order = await names();
  assert.ok(order.indexOf("End") < order.indexOf("Moods"), `order: ${order.join(", ")}`);
});

await test("language switch to Japanese", async (p) => {
  await p.click('button[aria-label="Settings"]');
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
    await p.locator(".ep-row").first().locator("button[aria-pressed]").click();
    await p.click('.sidebar .side-cat:has-text("Your Episodes")');
    await p.waitForSelector(".podcast-page .ep-row");
    assert.equal(await p.locator(".ep-row").count(), 1);
    assert.match(await p.locator(".ep-row .ep-title").first().textContent(), /Lost Tomb Pt\. 1/);
  },
  { youtube: true },
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
  const tr = (i) => d.search.tracks[i];
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
  await p.click('button[aria-label="Settings"]');
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

await test("Space plays/pauses after clicking Next or a switch, and only presses controls reached with the keyboard", async (p) => {
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
  await p.click('button[aria-label="Settings"]');
  const sw = p.locator('label.setting:has-text("Gapless") input');
  const on = await sw.isChecked();
  await sw.click();
  await p.keyboard.press(" ");
  assert.equal(await sw.isChecked(), !on, "Space flipped the clicked switch back");
  // Reached with the keyboard (focus ring), Space presses the control as usual.
  await p.keyboard.press("Shift+Tab");
  await p.keyboard.press("Tab");
  await p.keyboard.press(" ");
  assert.equal(await sw.isChecked(), on, "Space should toggle a switch focused with the keyboard");
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
  await p.locator(".lib-list .side-item", { hasText: "autumn" }).click();
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
  await p.click('button[aria-label="Settings"]');
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

await test("Windows 95 theme: picked in Settings, applied to the whole app and saved", async (p) => {
  await p.click('button[aria-label="Settings"]');
  await p.waitForSelector(".page h1:has-text('Settings')");
  assert.equal(await p.evaluate(() => document.documentElement.classList.contains("win95")), false);
  await p.locator(".setting", { hasText: "Theme" }).locator("button").click();
  await p.click('.menu button:has-text("Windows 95")');
  await p.waitForFunction(() => document.documentElement.classList.contains("win95"));
  // The teal desktop and grey windows.
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector(".layout")).backgroundColor), "rgb(0, 128, 128)");
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector(".main")).backgroundColor), "rgb(192, 192, 192)");
  await p.waitForFunction(() => JSON.stringify(window.__MOCK__.__saved ?? {}).includes('"theme":"win95"'), null, { timeout: 5000 });
}, {
  init: () => {
    const d = window.__MOCK__;
    d.settings_set = (a) => ((d.__saved = a.settings), null);
  },
});

await test("PLEXSpot Albums lists only saved albums, not the whole server", async (p) => {
  await p.click('.sidebar .side-cat:has-text("Albums")');
  await p.waitForSelector(".page h1:has-text('Albums')");
  assert.equal(await p.locator(".grid .card").count(), 0);
});

await test("Your Library albums sort by name or release year, and the choice sticks", async (p) => {
  await p.click('.sidebar .side-cat:has-text("Albums")');
  await p.waitForSelector(".grid .card");
  const first = async () => (await p.locator(".grid .card .card-title").first().textContent()).trim();
  await p.click("button.lib-sort");
  await p.click('.menu button:has-text("Alphabetical")');
  await p.waitForFunction(() => document.querySelector(".grid .card .card-title")?.textContent?.trim() === "Autumn Tapes");
  await p.click("button.lib-sort");
  await p.click('.menu button:has-text("Release date")');
  await p.waitForFunction(() => document.querySelector(".grid .card .card-title")?.textContent?.trim() === "Summer Static");
  // Leave and come back: still newest first.
  await p.click('.sidebar .side-cat:has-text("Artists")');
  await p.click('.sidebar .side-cat:has-text("Albums")');
  await p.waitForSelector(".grid .card");
  assert.equal(await first(), "Summer Static");
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
  "in-app self-test (--self-test, used on Windows CI) reaches the end",
  async (p) => {
    await p.waitForFunction(() => window.__SELFTEST_EXIT, null, { timeout: 90000 });
    const lines = await p.evaluate(() => window.__SELFTEST);
    const fails = lines.filter((l) => l.startsWith("fail"));
    console.log(`  self-test: ${lines.filter((l) => l.startsWith("ok")).length} steps ok${fails.length ? "; " + fails.join("; ") : ""}`);
    assert.equal(lines.at(-1), "done");
    assert.ok(lines.filter((l) => l.startsWith("ok switch")).length >= 5, "switches were not exercised");
  },
  {
    init: () => {
      window.__SELFTEST = [];
      const d = window.__MOCK__;
      d.app_info = { ...d.app_info, selfTest: true };
      d.self_test_log = (a) => (window.__SELFTEST.push(a.line), null);
      d.self_test_exit = () => ((window.__SELFTEST_EXIT = true), null);
    },
  },
);

await browser.close();
server.httpServer.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
