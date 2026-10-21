// In-app self-test for CI (`YTSpot.exe --self-test`): clicks through the screens that crashed for
// users (every Settings switch, dropdown and slider, scrolling, mini player, fullscreen) in the real
// WebView2 + Rust app, logging each step before and after. If the app hangs or dies, the last
// "start" line in selftest.log names the culprit. Mirrors e2e/smoke.mjs, which runs on a mock.
import { api } from "./api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (css: string) => Array.from(document.querySelectorAll<HTMLElement>(css));
const click = (css: string) => {
  const el = document.querySelector<HTMLElement>(css);
  if (!el) throw new Error(`not found: ${css}`);
  el.click();
};
const log = (line: string) => api.selfTestLog(line).catch(() => {});

async function step(name: string, fn: () => void | Promise<void>) {
  await log(`start ${name}`);
  try {
    await fn();
    await sleep(400);
    await log(`ok ${name}`);
  } catch (e) {
    await log(`fail ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const labelOf = (el: HTMLElement) => (el.closest("label")?.textContent ?? "").trim().slice(0, 40);

function setRange(r: HTMLInputElement, v: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(r, v);
  r.dispatchEvent(new Event("input", { bubbles: true }));
  r.dispatchEvent(new Event("change", { bubbles: true }));
}

const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

export async function runSelfTest() {
  await log("self-test begins");
  await sleep(4000);
  await step("continue with local files only", () => $$("button").find((b) => b.textContent?.includes("Continue with local files only"))?.click());
  await sleep(1000);
  await step("open settings", () => click('button[aria-label="Settings"]'));
  await sleep(1500);

  const switches = $$('input[role="switch"]').length;
  for (let i = 0; i < switches; i++) {
    const s = $$('input[role="switch"]')[i] as HTMLInputElement | undefined;
    if (!s || s.disabled) continue;
    await step(`switch ${i} (${labelOf(s)})`, async () => {
      s.scrollIntoView({ block: "center" });
      s.click();
      await sleep(300);
      ($$('input[role="switch"]')[i] as HTMLInputElement | undefined)?.click();
    });
  }

  const combos = $$('button[role="combobox"]').length;
  for (let i = 0; i < combos; i++) {
    const c = $$('button[role="combobox"]')[i];
    if (!c || (c as HTMLButtonElement).disabled) continue;
    await step(`dropdown ${i} (${labelOf(c)})`, async () => {
      c.scrollIntoView({ block: "center" });
      c.click();
      await sleep(300);
      const items = $$(".menu button");
      if (items.length > 1) items[1].click();
      else escape();
    });
  }
  await step("language back to English", async () => {
    $$('button[role="combobox"]')[0]?.click();
    await sleep(300);
    $$(".menu button").find((b) => b.textContent?.includes("English"))?.click();
  });

  const sliders = $$('main input[type="range"]').length;
  for (let i = 0; i < sliders; i++) {
    await step(`slider ${i}`, () => {
      const r = $$('main input[type="range"]')[i] as HTMLInputElement | undefined;
      if (!r) return;
      r.scrollIntoView({ block: "center" });
      setRange(r, r.max);
      setRange(r, r.min);
    });
  }

  await step("scroll settings to bottom and back", async () => {
    const main = document.querySelector<HTMLElement>(".main");
    for (let y = 0; y < 4000; y += 120) {
      main?.scrollTo(0, y);
      await sleep(25);
    }
    main?.scrollTo(0, 0);
  });
  await step("drag the scrollbar (scrollTop jumps)", async () => {
    const main = document.querySelector<HTMLElement>(".main");
    for (let i = 0; i < 40; i++) {
      if (main) main.scrollTop = (i % 2 ? 0.9 : 0.1) * main.scrollHeight;
      await sleep(15);
    }
  });
  await step("home", () => click('button[aria-label="Home"]'));
  await sleep(1000);
  await step("scroll home", async () => {
    const main = document.querySelector<HTMLElement>(".main");
    for (let y = 0; y < 3000; y += 100) {
      main?.scrollTo(0, y);
      await sleep(20);
    }
  });
  await step("mini player", () => click('button[aria-label="Mini player"]'));
  await sleep(1500);
  await step("fullscreen", async () => {
    click('button[aria-label="Full screen"]');
    await sleep(800);
    escape();
  });
  await step("transfer page", () => click('button[aria-label="Transfer playlists"]'));
  await log("done");
  await sleep(500);
  await api.selfTestExit();
}
