// Renders the README screenshots from the production build with the mock backend (sample data).
// Usage: cd ui && npm run build && node e2e/screenshots.mjs ../docs/screenshots
// Env: CHROMIUM=/path/to/chromium to use a preinstalled browser.
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { chromium } from "playwright";

const outDir = process.argv[2] ?? "../docs/screenshots";
const mock = fileURLToPath(new URL("./mock-backend.js", import.meta.url));
const ytOverrides = fileURLToPath(new URL("./yt-overrides.js", import.meta.url));
const server = await preview({ preview: { port: 4175, strictPort: true }, logLevel: "error" });
const base = "http://localhost:4175/";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });

async function open({ youtube = false, phone = false } = {}) {
  const page = await browser.newPage(
    phone
      ? { viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.addInitScript({ path: mock });
  if (youtube) await page.addInitScript({ path: ytOverrides });
  if (phone) await page.addInitScript(() => (window.__MOCK__.app_info = { ...window.__MOCK__.app_info, platform: "android" }));
  await page.goto(base);
  await page.waitForSelector(".playerbar");
  await page.waitForTimeout(800);
  return page;
}
const shot = (page, name) => page.screenshot({ path: `${outDir}/${name}.png` });

// Desktop (Windows) — PLEXSpot.
let page = await open();
await shot(page, "home");
await page.click('button[aria-label="Queue"]');
await page.waitForTimeout(300);
const rows = page.locator(".q-row:not(.current)");
await rows.nth(1).click();
await rows.nth(4).click({ modifiers: ["Shift"] });
await page.waitForTimeout(200);
await shot(page, "queue");
await page.click('button[aria-label="Queue"]');
await page.click('.sidebar .side-cat:has-text("Albums")');
await page.waitForSelector(".grid .card");
await page.waitForTimeout(600);
await page.click(".grid .card >> nth=0");
await page.waitForSelector(".hero");
await page.waitForTimeout(500);
await page.locator(".tl-row:not(.tl-head)").nth(2).click({ button: "right" });
await page.waitForTimeout(300);
await shot(page, "album-menu");
await page.keyboard.press("Escape");
await page.evaluate(() => document.querySelector(".hero-meta .link")?.click());
await page.waitForSelector(".artist-hero");
await page.waitForTimeout(500);
await shot(page, "artist");
await page.click('button[aria-label="Lyrics"]');
await page.waitForTimeout(1200);
await shot(page, "fullscreen");
await page.close();

// Desktop (Windows) — YTSpot: the classic library categories, including Podcasts.
page = await open({ youtube: true });
await page.click('.sidebar .side-cat:has-text("Podcasts")');
await page.waitForSelector(".grid .card");
await page.waitForTimeout(600);
await shot(page, "library");
await page.close();

// Phone (Android) — YTSpot.
page = await open({ youtube: true, phone: true });
await shot(page, "phone-home");
await page.click('.mobile-tabs button:has-text("Your Library")');
await page.waitForSelector(".lib-row");
await page.waitForTimeout(500);
await shot(page, "phone-library");
await page.click('.lib-tab:has-text("Albums")');
await page.waitForTimeout(500);
await shot(page, "phone-albums");
await page.click(".playerbar");
await page.waitForSelector(".pp");
await page.waitForTimeout(800);
await shot(page, "phone-player");
await page.close();

await browser.close();
server.httpServer.close();
