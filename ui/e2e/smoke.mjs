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

async function test(name, fn, { youtube = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript({ path: mock });
  if (youtube) await page.addInitScript({ path: ytOverrides });
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
  // Local files get their own section; the Songs filter loads the full list.
  await p.locator("h2", { hasText: "On this computer" }).waitFor();
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
  await p.locator("h2", { hasText: "On this computer" }).waitFor();
  await p.click("button.follow");
  await p.waitForSelector('button.follow[aria-pressed="true"]');
  assert.equal((await p.locator("button.follow").textContent()).trim(), "Following");
});

await test("fullscreen opens with lyrics and closes on Escape", async (p) => {
  await p.click('button[aria-label="Lyrics"]');
  await p.waitForSelector(".fullscreen .lyrics .line");
  await p.keyboard.press("Escape");
  await p.waitForSelector(".fullscreen", { state: "detached" });
});

// Regression: the lyrics effect was keyed on the displayed track object, which is new on every
// render for YouTube music videos, so reopening lyrics (cache hit) looped forever and froze the app.
await test("YouTube: reopening lyrics on a music video stays responsive", async (p) => {
  for (let i = 0; i < 2; i++) {
    await p.click('button[aria-label="Lyrics"]');
    await p.waitForSelector(".fullscreen .lyrics .line");
    await p.waitForTimeout(300);
    await p.keyboard.press("Escape");
    await p.waitForSelector(".fullscreen", { state: "detached" });
  }
  await p.click('button[aria-label="Lyrics"]');
  await p.waitForSelector(".fullscreen .lyrics .line");
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
  for (let i = 0; i < 2; i++) await p.click(".lib-tools .link");
  assert.equal((await p.locator(".lib-tools .link").textContent()).trim(), "Custom order");
  const names = async () => (await lib.locator(".side-item .name").allTextContents()).filter((n) => n !== "Local files" && n !== "Downloads");
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

await browser.close();
server.httpServer.close();
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? ` (${r.ms} ms)` : ` — ${r.error}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
