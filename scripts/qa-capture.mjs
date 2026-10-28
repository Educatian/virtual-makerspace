// Visual QA capture: every screen and Bolt state, at desktop and phone widths.
//   node scripts/qa-capture.mjs http://localhost:4173 ./qa-shots
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:4173";
const out = process.argv[3] ?? "qa-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"],
});
const issues = [];
const code = () => `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;

async function open(query, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.on("pageerror", (error) => issues.push(`pageerror ${query}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource|api\/me/.test(message.text())) issues.push(`console ${query}: ${message.text().slice(0, 200)}`);
  });
  await page.goto(`${base}/?${query}`);
  await page.waitForSelector("#enter-room");
  return page;
}
async function enter(page) {
  await page.evaluate(() => document.querySelector("#enter-room").click());
  await page.waitForSelector("#viewport-heading");
  await page.waitForTimeout(2500);
}
const tab = (page, name) => page.evaluate((n) => document.querySelector(`.discussion-tab[data-tab="${n}"]`)?.click(), name);
const say = (page, text) => page.evaluate((body) => {
  document.querySelector('.discussion-tab[data-tab="chat"]')?.click();
  document.querySelector("#chat-input").value = body;
  document.querySelector("#chat-form").requestSubmit();
}, text);
const boltCount = (page, pattern) => page.evaluate((source) => {
  const re = new RegExp(source);
  return [...document.querySelectorAll(".chat-message")]
    .filter((row) => row.querySelector(".avatar.is-agent") && re.test(row.querySelector("p")?.textContent ?? "")).length;
}, pattern.source);
async function waitBolt(page, pattern, count = 1, timeout = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if ((await boltCount(page, pattern)) >= count) return true;
    await page.waitForTimeout(400);
  }
  issues.push(`timeout waiting for Bolt: ${pattern}`);
  return false;
}
const shot = (page, name, options = {}) => page.screenshot({ path: `${out}/${name}.png`, ...options });

// 1. Lobby, desktop and phone.
let page = await open(`room=${code()}&studio=circuit`);
await page.waitForTimeout(1500);
await shot(page, "01-lobby");
await page.context().close();
page = await open(`room=${code()}&studio=circuit`, { width: 390, height: 844 });
await page.waitForTimeout(1500);
await shot(page, "02-lobby-phone", { fullPage: true });
await page.context().close();

// 2. Workspace alone, Team tab with the empty Bolt card.
page = await open(`room=${code()}&studio=circuit&name=Ana`);
await enter(page);
await tab(page, "team");
await page.waitForTimeout(500);
await shot(page, "03-workspace-solo-team");

// 3. Invite Bolt, greeting, then Bolt builds (ghost hand frames).
await page.evaluate(() => document.querySelector("#invite-ai")?.click());
await waitBolt(page, /I'm Bolt/);
await tab(page, "chat");
await shot(page, "04-bolt-greeting");
await say(page, "Bolt, you build it.");
await waitBolt(page, /build my plan/);
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(500);
  await shot(page, `05-bolt-building-${i}`, { clip: { x: 94, y: 110, width: 866, height: 620 } });
}
await waitBolt(page, /^Done\./);
await shot(page, "06-bolt-built");

// 4. Teach, rebuild, test, notebook.
await say(page, "Use the columns.");
await waitBolt(page, /would that connect them/i);
await say(page, "Holes in a row aren't connected — the board connects them in vertical column strips, so parts have to share a column.");
await waitBolt(page, /share a column\. Got it/);
await say(page, "The path has to come back to the other side of the battery because current flows around a complete loop.");
await waitBolt(page, /^Done\./, 2, 240_000);
await page.waitForTimeout(3000);
await shot(page, "07-after-teaching");
await tab(page, "team");
await page.waitForTimeout(400);
await shot(page, "08-team-notebook");
const dock = await page.evaluate(() => { const r = document.querySelector(".discussion-dock").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
await shot(page, "09-dock-team", { clip: dock });
await tab(page, "chat");
await page.waitForTimeout(300);
await shot(page, "10-dock-chat", { clip: dock });
await tab(page, "voice");
await page.waitForTimeout(300);
await shot(page, "11-dock-voice", { clip: dock });
await page.context().close();

// 5. Other studios with Bolt.
for (const studio of ["greenhouse", "snap", "snapino"]) {
  page = await open(`room=${code()}&studio=${studio}&name=Ana&teammate=ai`);
  await enter(page);
  await waitBolt(page, /only learned the Circuit Bench/);
  await shot(page, `12-studio-${studio}`);
  await page.context().close();
}

// 6. Phone workspace with Bolt.
page = await open(`room=${code()}&studio=circuit&name=Ana&teammate=ai`, { width: 390, height: 844 });
await enter(page);
await waitBolt(page, /I'm Bolt/);
await shot(page, "13-workspace-phone", { fullPage: true });
await page.context().close();

writeFileSync(`${out}/issues.txt`, issues.join("\n") || "(none)");
console.log(issues.length ? issues.join("\n") : "no console/page errors");
await browser.close();
