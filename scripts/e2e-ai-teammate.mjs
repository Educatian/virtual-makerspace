// End-to-end check for Bolt, the teachable AI teammate, over same-origin BroadcastChannel.
//
//   npm run build && python3 -m http.server 4173 --bind 127.0.0.1 -d dist
//   node scripts/e2e-ai-teammate.mjs [http://localhost:4173] [screenshot-dir]
//
// One learner invites Bolt (?teammate=ai), lets it build from its naive ideas, sees the LED
// stay dark, teaches the three ideas in chat, and watches Bolt rebuild a safe, lit circuit.
// A maker who joins afterwards must see Bolt as a participant and receive its circuit.
// (Only one WebGL tab runs at a time: two software-rendered scenes starve a small CI box.)
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:4173";
const shots = process.argv[3] ?? null;
if (shots) mkdirSync(shots, { recursive: true });
const room = `B${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
// Small viewport: the WebGL scene is software-rendered in CI, so keep frames cheap.
const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
// DOM-level clicks and typing avoid waiting on "stable" frames from a slow renderer.
const tap = (page, selector) => page.evaluate((s) => document.querySelector(s)?.click(), selector);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function enter(name, query) {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => console.error(`[${name}] pageerror:`, error.message));
  await page.goto(`${base}/?room=${room}&studio=circuit&name=${encodeURIComponent(name)}${query}`);
  await page.waitForSelector("#enter-room");
  await tap(page, "#enter-room");
  await page.waitForSelector("#viewport-heading");
  return page;
}

const boltLines = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".chat-message")]
    .filter((row) => row.querySelector(".avatar.is-agent"))
    .map((row) => row.querySelector("p")?.textContent ?? ""));
async function waitForBolt(page, pattern, timeout = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const lines = await boltLines(page);
    const hit = lines.find((line) => pattern.test(line));
    if (hit) return hit;
    await page.waitForTimeout(400);
  }
  return null;
}
async function say(page, text) {
  await page.evaluate((body) => {
    document.querySelector('.discussion-tab[data-tab="chat"]')?.click();
    const input = document.querySelector("#chat-input");
    input.value = body;
    document.querySelector("#chat-form").requestSubmit();
  }, text);
}
const powered = (page) => page.evaluate(() => document.querySelector("#check-circuit")?.classList.contains("is-valid") ?? false);
async function markReady(page) {
  await page.evaluate(() => {
    document.querySelector('.discussion-tab[data-tab="team"]')?.click();
    const ready = document.querySelector("#toggle-ready");
    if (ready && ready.textContent.trim() !== "Ready") ready.click();
  });
}
async function readyAndTest(page, ...others) {
  for (const other of others) await markReady(other);
  await markReady(page);
  // Bolt follows the humans' readiness once its own work is done.
  const everyone = 2 + others.length;
  await page.waitForFunction((count) => document.querySelectorAll(".team-member.is-ready").length >= count, everyone, { timeout: 30_000 });
  await tap(page, "#check-circuit");
}
async function waitForBoltCount(page, pattern, count, timeout = 150_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if ((await boltLines(page)).filter((line) => pattern.test(line)).length >= count) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

const learner = await enter("Ana", "&teammate=ai");
await tap(learner, '.discussion-tab[data-tab="team"]');
await learner.waitForSelector(".team-member .avatar.is-agent");
check("Bolt joins as a participant", await learner.locator(".team-member", { hasText: "Bolt" }).count() === 1);
check("Bolt greets the team", Boolean(await waitForBolt(learner, /I'm Bolt/)));
check("solo learner is no longer 'waiting for partner'", !(await learner.locator(".team-summary h2").textContent()).includes("waiting"));


// Bolt builds from its naive ideas: parts end to end along one row, no resistor, no return.
await say(learner, "Bolt, you build it this time.");
check("Bolt takes the builder role", Boolean(await waitForBolt(learner, /I'll build/)));
if (shots) {
  // Bolt's ghost hand carries each part; grab a few frames of it mid-build.
  for (let frame = 0; frame < 4; frame += 1) {
    await learner.waitForTimeout(1200);
    await learner.screenshot({ path: `${shots}/0-hand-${frame}.png` });
  }
}
check("Bolt finishes its naive build", await waitForBoltCount(learner, /^Done\./, 1));
if (shots) await learner.screenshot({ path: `${shots}/1-naive-build.png` });
check("naive build leaves the LED dark", !(await powered(learner)));
await readyAndTest(learner);
check("Bolt asks what it got wrong", Boolean(await waitForBolt(learner, /What did I get wrong/)));

// Naming an idea without a reason earns a "why?" and no rebuild.
await say(learner, "Use the columns.");
check("Bolt asks why when only told what", Boolean(await waitForBolt(learner, /why would that connect them/)));

await say(learner, "Holes in a row aren't connected — the board connects them in vertical column strips, so parts have to share a column.");
check("Bolt learns column strips", Boolean(await waitForBolt(learner, /column strips, not along the row/)));
check("Bolt rebuilds after learning", await waitForBoltCount(learner, /^Done\./, 2));
await say(learner, "The path has to come back to the other side of the battery because current flows around a complete loop.");
check("Bolt learns the complete loop", Boolean(await waitForBolt(learner, /complete loop\. I'll remember/)));
check("Bolt rebuilds again", await waitForBoltCount(learner, /^Done\./, 3));
await learner.waitForTimeout(1000);
check("loop + strips light the LED", await powered(learner));
await readyAndTest(learner);
check("Bolt notices nothing protects the LED? (not yet taught)", Boolean(await waitForBolt(learner, /fine right on the battery|done\?/)));

await say(learner, "Add a resistor because it limits the current so the LED doesn't burn out.");
check("Bolt learns the series resistor", Boolean(await waitForBolt(learner, /resistor limits how much current/)));
check("Bolt rebuilds with the resistor", await waitForBoltCount(learner, /^Done\./, 4));
await learner.waitForTimeout(1000);
check("Bolt's rebuild stays lit with the resistor", await powered(learner));
if (shots) await learner.screenshot({ path: `${shots}/2-taught-build.png` });

await tap(learner, '.discussion-tab[data-tab="team"]');
const notebook = await learner.locator(".teammate-notebook li").count();
check("Bolt's notebook keeps all three ideas in the learner's words", notebook === 3, `${notebook} entries`);
const teachTraces = await learner.evaluate(() => JSON.parse(localStorage.getItem(`vm-trace:${new URLSearchParams(location.search).get("room")}`) ?? "[]").filter((trace) => trace.action === "teach").length);
check("teach events land in the shared trace", teachTraces >= 3, `${teachTraces} teach events`);
const leakedBody = await learner.evaluate(() => (localStorage.getItem(`vm-trace:${new URLSearchParams(location.search).get("room")}`) ?? "").includes("burn out"));
check("trace never stores the learner's words", !leakedBody);
if (shots) await learner.locator(".discussion-dock").screenshot({ path: `${shots}/3-notebook.png` });

const partner = await enter("Ben", "");
await tap(partner, '.discussion-tab[data-tab="team"]');
await partner.waitForSelector(".team-member .avatar.is-agent");
check("a second maker sees Bolt in the room", await partner.locator(".team-member", { hasText: "Bolt" }).count() === 1);
check("only one Bolt is offered per room", await partner.locator("#invite-ai").count() === 0);
await partner.waitForTimeout(2000);
check("a late joiner receives Bolt's working circuit", await powered(partner));

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
