// Drives the real installed app (WebView2 + Rust backend) on a Windows CI runner through
// tauri-driver, to reproduce crashes the mock-backend tests can't see. Each step checks the app is
// still alive and logs which interaction killed it.
// Usage: node e2e/windows-app.mjs <path-to-app.exe>   (tauri-driver listening on :4444)
import { Builder, By } from "selenium-webdriver";

const exe = process.argv[2];
const driver = await new Builder()
  .usingServer("http://127.0.0.1:4444/")
  .withCapabilities({ browserName: "wry", "tauri:options": { application: exe } })
  .build();

let failed = 0;
async function alive() {
  return driver.executeScript("return document.readyState").then(() => true, () => false);
}
async function step(name, fn) {
  try {
    await fn();
    await driver.sleep(400);
    if (!(await alive())) throw new Error("app stopped responding");
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${String(e.message).split("\n")[0]}`);
    if (!(await alive())) {
      console.log("APP DIED after step:", name);
      process.exitCode = 1;
      throw e;
    }
  }
}
const click = (css) => driver.findElement(By.css(css)).then((el) => el.click());
const byText = (tag, text) => driver.findElement(By.xpath(`//${tag}[contains(normalize-space(.), ${JSON.stringify(text)})]`));

try {
  await driver.sleep(4000);
  await step("app started", async () => {
    const title = await driver.getTitle();
    console.log("  title:", title);
  });
  await step("continue with local files only", async () => {
    const btns = await driver.findElements(By.xpath("//button[contains(., 'Continue with local files only')]"));
    if (btns.length) await btns[0].click();
  });
  await step("open settings", () => click('button[aria-label="Settings"]'));
  const switches = await driver.findElements(By.css('input[role="switch"]'));
  for (let i = 0; i < switches.length; i++) {
    await step(`switch ${i} on/off`, async () => {
      const s = (await driver.findElements(By.css('input[role="switch"]')))[i];
      if (!(await s.isEnabled())) return;
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", s);
      await s.click();
      await driver.sleep(300);
      await s.click();
    });
  }
  const combos = await driver.findElements(By.css('button[role="combobox"]'));
  for (let i = 0; i < combos.length; i++) {
    await step(`dropdown ${i}`, async () => {
      const c = (await driver.findElements(By.css('button[role="combobox"]')))[i];
      if (!(await c.isEnabled())) return;
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'})", c);
      await c.click();
      const items = await driver.findElements(By.css(".menu button"));
      if (items.length > 1) await items[1].click();
      else await driver.executeScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    });
  }
  // Put the language back to English if a dropdown changed it.
  await step("language back to English", async () => {
    const c = (await driver.findElements(By.css('button[role="combobox"]')))[0];
    await c.click();
    await (await byText("button", "English")).click();
  });
  const sliders = await driver.findElements(By.css('main input[type="range"]'));
  for (let i = 0; i < sliders.length; i++) {
    await step(`slider ${i}`, async () => {
      const r = (await driver.findElements(By.css('main input[type="range"]')))[i];
      await driver.executeScript(
        "const r=arguments[0]; r.scrollIntoView({block:'center'}); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(r, r.max); r.dispatchEvent(new Event('input',{bubbles:true})); set.call(r, r.min); r.dispatchEvent(new Event('input',{bubbles:true}));",
        r,
      );
    });
  }
  await step("scroll settings to bottom and back", async () => {
    for (let y = 0; y < 3000; y += 150) {
      await driver.executeScript(`document.querySelector('.main').scrollTo(0, ${y})`);
      await driver.sleep(30);
    }
    await driver.executeScript("document.querySelector('.main').scrollTo(0, 0)");
  });
  await step("home", () => click('button[aria-label="Home"]'));
  await step("mini player", () => click('button[aria-label="Mini player"]'));
  await step("fullscreen", async () => {
    await click('button[aria-label="Full screen"]');
    await driver.sleep(500);
    await driver.executeScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  });
  await step("transfer page", () => click('button[aria-label="Transfer playlists"]'));
} finally {
  console.log(failed ? `${failed} step(s) failed` : "all steps passed");
  await driver.quit().catch(() => {});
}
