// Usage: node ui/e2e/screenshots.mjs http://localhost:4173/ docs/screenshots ui/e2e/mock-backend.js
// (run `npx vite preview --port 4173` in ui/ first). PLAYWRIGHT points at a playwright install.
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const [, , base, outDir, mock] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.addInitScript({ path: mock });
await page.goto(base);
await page.waitForSelector(".playerbar");
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/home.png` });
// Queue open
await page.click('button[aria-label="Queue"]');
await page.waitForTimeout(300);
const rows = page.locator(".q-row:not(.current)");
await rows.nth(1).click();
await rows.nth(4).click({ modifiers: ["Shift"] });
await page.waitForTimeout(200);
await page.screenshot({ path: `${outDir}/queue.png` });
await page.click('button[aria-label="Queue"]');
// Album page
await page.click(".card >> nth=8");
await page.waitForSelector(".hero");
await page.waitForTimeout(500);
await page.locator(".tl-row:not(.tl-head)").nth(2).click({ button: "right" });
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/album-menu.png` });
await page.keyboard.press("Escape");
// Artist page
await page.evaluate(() => document.querySelector(".hero-meta .link")?.click());
await page.waitForSelector(".artist-hero");
await page.waitForTimeout(500);
await page.screenshot({ path: `${outDir}/artist.png` });
// Fullscreen
await page.click('button[aria-label="Lyrics"]');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${outDir}/fullscreen.png` });
await browser.close();
