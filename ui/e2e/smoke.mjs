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

async function test(name, fn, { youtube = false, init } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript({ path: mock });
  if (youtube) await page.addInitScript({ path: ytOverrides });
  if (init) await page.addInitScript(init);
  await page.goto(base);
  await page.waitForSelector(".playerbar");
  const t0 = Date.now();
  try {
    await fn(page);
    assert.deepEqual(errors, [], "uncaught page errors");
    results.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split("\n")[0] });
  }
  await page.close();
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
  await p.click('.menu .menu button:has-text("Moods")');
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
  await p.click('.menu .menu button:has-text("Text file")');
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
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? ` (${r.ms} ms)` : ` — ${r.error}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
