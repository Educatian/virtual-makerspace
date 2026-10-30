// Resource-Limited Greenhouse — the gate corrections, over the real Worker (Durable Object +
// WebSocket) with two makers in separate browser processes and a late joiner. Developer
// environment (headless Chromium, SwiftShader, wrangler dev + the local access proxy), not CI.
// A fresh random room (never 7K3M).
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799
//   node scripts/e2e-greenhouse-fixes-worker.mjs [http://vm.test:8800] [artifacts-dir]
//
//  1. The four 3D controls by real pointer (the declared target centre of each) and keyboard, two
//     on each client: each edit is accepted by the room and arrives at the other client.
//  2. The day ends at ×4; then a maker unplugs the tank hose by pointer. The finished day keeps
//     its final tank and pumped water and its verdict (G1 included) on both clients — the room
//     settled it with the rig it ran on before the rig unlocked.
//  3. A late joiner (PF, fresh tab) after the end sees the same finished day, and it is not their
//     attempt: no result, PF notes still locked.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `G${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const artifacts = process.argv[3] ?? `${tmpdir()}/vm-e2e-greenhouse-fixes-${room}`;
mkdirSync(artifacts, { recursive: true });
const browsers = [];
const launch = async () => {
  const own = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8800", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  });
  browsers.push(own);
  return own;
};
const results = [];
async function check(name, ok, detail = "", actor = "") {
  results.push({ name, ok: Boolean(ok), detail, actor, at: new Date().toISOString() });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read, test, timeout = 240_000) => {
  const started = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - started < timeout) {
    await sleep(500);
    value = await read();
  }
  return value;
};
const gh = (page) => page.evaluate(() => window.__vmQa.greenhouse());
const listText = (page) => page.locator("#gh-list").textContent();
const BRIEF = [["irrigation-hose", 0, 1], ["irrigation-hose-2", 2, 3], ["irrigation-hose-3", 4, 6], ["irrigation-hose-4", 5, 7], ["power-cable-1", 8, 9], ["power-cable-2", 10, 12], ["power-cable-3", 11, 13]];

async function join(email, label, { host = false, condition = "DI" } = {}) {
  const context = await (await launch()).newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await instrument(context);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  page.errors = [];
  page.on("pageerror", (error) => { page.errors.push(error.message); console.error(`[${label}] pageerror:`, error.message); });
  await page.goto(`${base}/?room=${room}&quality=low&qa&condition=${condition}`);
  await page.waitForSelector("#enter-room", { state: "attached" });
  if (host) await page.getByRole("radio", { name: /Resource-Limited Greenhouse/ }).click();
  await page.locator("#enter-room").click();
  await page.waitForFunction(() => Boolean(window.__vmQa?.greenhouse) && window.__vmQa.bench().studio === "greenhouse", null, { timeout: 300_000, polling: 500 });
  await until(() => gh(page), (s) => Boolean(s.panel?.run && s.panel?.shown), 120_000);
  await settled(page, `${label} entered`, { diagnostics: artifacts });
  return page;
}
async function neutral(page) {
  await page.locator('.component-card[data-component-id="vent-fan"]').click();
  await page.waitForFunction(() => window.__vmQa.selected() === "vent-fan", null, { timeout: 60_000, polling: 250 });
}
/** A real click on a 3D control's declared target, then a typed value and Enter. */
async function setBy3D(page, control, value) {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined)); // key 1 from the 3D view, not into a field
  await page.keyboard.press("1");
  await settled(page, `overview for ${control}`, { diagnostics: artifacts });
  await neutral(page);
  const target = await page.evaluate((control) => window.__vmQa.ghControlPoint(control), control);
  await page.mouse.click(target.x, target.y);
  const focused = await until(() => page.evaluate(() => document.activeElement?.id ?? ""), (id) => id === `gh-${control}`, 60_000);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(String(value));
  await page.keyboard.press("Enter");
  return { focused, at: target };
}

let host;
let member;
try {
  host = await join("host@example.test", "host", { host: true });
  member = await join("member@example.test", "member");
  for (const [id, a, b] of BRIEF) {
    await host.evaluate(({ id, a }) => window.__vmQa.dropEnd(id, 0, a), { id, a });
    await host.evaluate(({ id, b }) => window.__vmQa.dropEnd(id, 1, b), { id, b });
  }
  await host.evaluate(() => window.__vmQa.seatShared({ "soil-sensor": [14, 15] }));
  const built = await until(() => gh(member), (s) => s.panel?.rig?.complete === true, 240_000);
  await check("both makers hold the brief's rig, fully plumbed and wired", built.panel?.rig?.complete === true, JSON.stringify(built.panel?.rig?.lines), "host");

  // 1. The four 3D controls, two per client; each edit arrives at the other client.
  const edits = [[host, "host", member, "valveA", 30, "valve A 30 %"], [member, "member", host, "valveB", 50, "valve B 50 %"], [host, "host", member, "pumpBelow", 60, "soil < 60 %"], [member, "member", host, "fanAbove", 26, "air > 26 °C"]];
  for (const [actor, name, other, control, value, text] of edits) {
    const { focused } = await setBy3D(actor, control, value);
    const mine = await until(() => listText(actor), (t) => t?.includes(text), 120_000);
    const theirs = await until(() => listText(other), (t) => t?.includes(text), 120_000);
    await check(`${name}: a 3D click on ${control} focuses its field; ${value} typed and Enter is accepted by the room and arrives at the other maker`, focused === `gh-${control}` && mine?.includes(text) && theirs?.includes(text), `focus ${focused}`, name);
  }

  // 2. The day ends; then the tank hose is unplugged by pointer.
  await host.locator('.discussion-tab[data-tab="greenhouse"]').click();
  await host.locator("#gh-run-toggle").click();
  await host.locator('#gh-panel [data-speed="4"]').click();
  const ended = await until(() => gh(host), (s) => s.panel?.verdict !== null && s.panel?.shown?.tick === 96, 900_000);
  const endedMember = await until(() => gh(member), (s) => s.panel?.verdict !== null && s.panel?.shown?.tick === 96, 300_000);
  const finalTank = ended.panel.shown.tank;
  await check("the day ran to its end at ×4 on both; the worked allocation meets the brief", ended.panel.verdict?.met === true && endedMember.panel.verdict?.met === true && Math.abs(endedMember.panel.shown.tank - finalTank) < 1e-9, `tank ${finalTank.toFixed(2)} L · run ${JSON.stringify(ended.panel.run)}`, "host");
  await member.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await member.keyboard.press("1");
  await settled(member, "member overview before unplug", { diagnostics: artifacts });
  const from = await member.evaluate(() => window.__vmQa.plugPoint("irrigation-hose", 0));
  await member.mouse.move(from.x, from.y);
  await member.mouse.down();
  for (let step = 1; step <= 10; step += 1) await member.mouse.move(from.x - step * 10, from.y + step * 12);
  await member.mouse.up();
  const after = await until(() => gh(host), (s) => s.panel?.rig?.lines?.["irrigation-hose"] !== "supply", 240_000);
  const afterMember = await until(() => gh(member), (s) => s.panel?.rig?.lines?.["irrigation-hose"] !== "supply", 120_000);
  await sleep(3000);
  const hostNow = await gh(host);
  const memberNow = await gh(member);
  await check("after the day ended, the member unplugged the tank hose by pointer (the rig was unlocked) and both see it unplugged", after.panel.rig.lines["irrigation-hose"] !== "supply" && afterMember.panel.rig.lines["irrigation-hose"] !== "supply", JSON.stringify(after.panel.rig.lines["irrigation-hose"]), "member");
  await check("…the finished day is unchanged on both: same final tank, same verdict (G1 still met: judged on the build the day ended with), run ended with the same id", Math.abs(hostNow.panel.shown.tank - finalTank) < 1e-9 && Math.abs(memberNow.panel.shown.tank - finalTank) < 1e-9 && hostNow.panel.verdict?.met === true && memberNow.panel.verdict?.met === true && hostNow.panel.run.status === "ended" && hostNow.panel.run.runId === ended.panel.run.runId, JSON.stringify({ host: { tank: hostNow.panel.shown.tank, met: hostNow.panel.verdict?.met, run: hostNow.panel.run }, member: { tank: memberNow.panel.shown.tank, met: memberNow.panel.verdict?.met } }), "both");

  // 3. A late joiner (PF) after the end.
  const late = await join("late@example.test", "late", { condition: "PF" });
  const lateState = await until(() => gh(late), (s) => s.panel?.shown?.tick === 96, 120_000);
  await check("a late joiner (PF, fresh tab) sees the same finished day: final tank, verdict", Math.abs(lateState.panel.shown.tank - finalTank) < 1e-9 && lateState.panel.verdict?.met === true, `tank ${lateState.panel.shown.tank}`, "late");
  await check("…and that day is not their attempt: no result, PF explanatory notes still locked, the attempt card says it finished without them", lateState.panel.resultRun === null && lateState.panel.notesUnlocked === false && /finished without you/.test((await late.locator("#gh-run-summary").textContent()) ?? ""), JSON.stringify({ resultRun: lateState.panel.resultRun, notesUnlocked: lateState.panel.notesUnlocked }), "late");
  await check("no page errors", [host, member, late].every((page) => page.errors.length === 0), [host, member, late].flatMap((page) => page.errors).join(" | "));
} catch (error) {
  await check("run completed", false, String(error?.message ?? error).split("\n")[0]);
} finally {
  writeFileSync(`${artifacts}/results.json`, `${JSON.stringify({ room, base, results }, null, 1)}\n`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`e2e greenhouse fixes: ${passed}/${results.length} checks passed (room ${room}; artifacts ${artifacts})`);
  for (const browser of browsers) await browser.close().catch(() => undefined);
  process.exitCode = passed === results.length && results.length > 0 ? 0 : 1;
}
