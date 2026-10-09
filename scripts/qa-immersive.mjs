// Visual QA for the immersive workspace: panels open and collapsed, each studio, laptop and phone widths.
//   node scripts/qa-immersive.mjs http://localhost:4173 ./qa-immersive
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:4173";
const out = process.argv[3] ?? "qa-immersive";
/** Optional third argument "narrow" captures only the laptop and phone widths. */
const narrowOnly = process.argv[4] === "narrow";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"],
});
const issues = [];
const code = () => `I${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;

async function open(query, viewport) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.setDefaultTimeout(120_000);
  page.on("pageerror", (error) => issues.push(`pageerror ${query}: ${error.message}`));
  await page.goto(`${base}/?room=${code()}&name=Ana&${query}`);
  await page.waitForSelector("#enter-room");
  await page.evaluate(() => document.querySelector("#enter-room").click());
  await page.waitForSelector("#viewport-heading");
  await page.waitForTimeout(3500);
  return page;
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

let page;
if (!narrowOnly) {
page = await open("studio=circuit&teammate=ai", { width: 1440, height: 900 });
await page.waitForFunction(() => document.querySelector(".chat-message .avatar.is-agent"));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/1-circuit-open.png` });
await page.evaluate(() => document.querySelector('.discussion-tab[data-tab="team"]').click());
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/2-circuit-team.png` });
await page.evaluate(() => document.querySelector("#dock-collapse").click());
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/3-circuit-collapsed.png` });
await page.evaluate(() => { const i = document.querySelector("#chat-input"); i.value = "Bolt, you build it."; document.querySelector("#chat-form").requestSubmit(); });
await page.waitForFunction(() => document.querySelector("#dock-reopen.has-unread"), null, { timeout: 60_000 }).catch(() => issues.push("no unread dot while collapsed"));
await page.screenshot({ path: `${out}/4-collapsed-unread.png` });
await page.evaluate(() => document.querySelector("#dock-reopen").click());
await page.waitForTimeout(900);
const reopened = await page.evaluate(() => !document.querySelector(".workspace-shell").classList.contains("is-dock-collapsed") && !document.querySelector("#dock-reopen").classList.contains("has-unread"));
if (!reopened) issues.push("panel did not reopen cleanly");
await page.context().close();

for (const studio of ["greenhouse", "snapino"]) {
  page = await open(`studio=${studio}`, { width: 1440, height: 900 });
  await page.screenshot({ path: `${out}/5-${studio}.png` });
  await page.context().close();
}
}

page = await open("studio=circuit", { width: 1180, height: 760 });
await page.screenshot({ path: `${out}/6-laptop.png` });
if (await overflow(page) > 0) issues.push("laptop width overflows");
await page.context().close();

page = await open("studio=circuit", { width: 390, height: 844 });
await page.screenshot({ path: `${out}/7-phone.png` });
if (await overflow(page) > 0) issues.push("phone width overflows");
await page.context().close();

console.log(issues.length ? issues.join("\n") : "no issues");
await browser.close();
