// In-app self-test for CI (`OpenSpot.exe --self-test`): clicks through the screens that crashed for
// users (the Services switches, every Settings switch, dropdown and slider, scrolling, mini player,
// fullscreen) in the real WebView2 + Rust app, logging each step before and after. If the app
// hangs or dies, the last "start" line in selftest.log names the culprit; a step that couldn't do
// its job logs a "fail" line, which fails CI. Mirrors e2e/smoke.mjs, which runs on a mock.
import { api } from "./api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (css: string) => Array.from(document.querySelectorAll<HTMLElement>(css));
const click = (css: string) => {
  const el = document.querySelector<HTMLElement>(css);
  if (!el) throw new Error(`not found: ${css}`);
  el.click();
};
/** An item of the profile picture's menu (Settings, Transfer playlists, ...). */
async function accountMenu(item: string) {
  click(".avatar-btn");
  await sleep(300);
  const b = $$(".menu button").find((x) => x.textContent?.trim() === item);
  if (!b) throw new Error(`menu item not found: ${item}`);
  b.click();
}
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

/** A dialog, profile picker or sign-in prompt opened by itself. */
const dialogOpen = () => !!document.querySelector('.modal-bg, [role="dialog"], [role="alertdialog"]');

export async function runSelfTest() {
  await log("self-test begins");
  await sleep(4000);
  // A fresh install starts on "Connect your music": skip to local files (no account in CI).
  if (document.querySelector('[data-testid="connect-local"]')) {
    await step("connect page: skip to local files", () => click('[data-testid="connect-local"]'));
    await sleep(1000);
  }
  await step("open settings", async () => {
    await accountMenu("Settings");
    await sleep(1500);
    if (!document.querySelector(".page.settings")) throw new Error("Settings page not reached");
  });

  // The Services switches first, each on its own: on, then back off. Turning a service off must
  // never ask anything or sign out.
  for (const el of $$('input[role="switch"][data-service]') as HTMLInputElement[]) {
    const name = el.dataset.service ?? "?";
    if (el.disabled) {
      await log(`skip service ${name} (needs a sign-in)`);
      continue;
    }
    await step(`service ${name}`, async () => {
      const was = el.checked;
      el.scrollIntoView({ block: "center" });
      el.click();
      await sleep(1500);
      if (!el.isConnected) throw new Error("the switch disappeared");
      el.click();
      await sleep(800);
      if (dialogOpen()) {
        escape();
        throw new Error("a dialog opened");
      }
      if (el.checked !== was) throw new Error("the switch didn't go back");
    });
  }

  // Every other switch: held by reference, so switches appearing or moving can't shift which one
  // the second click lands on.
  const switches = $$('input[role="switch"]:not([data-service])') as HTMLInputElement[];
  for (const [i, s] of switches.entries()) {
    if (!s.isConnected || s.disabled) continue;
    await step(`switch ${i} (${labelOf(s)})`, async () => {
      s.scrollIntoView({ block: "center" });
      s.click();
      await sleep(300);
      if (s.isConnected) s.click();
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
  await step("transfer page", () => accountMenu("Transfer playlists"));
  await log("done");
  await sleep(500);
  await api.selfTestExit();
}
