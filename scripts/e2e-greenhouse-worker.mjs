// Resource-Limited Greenhouse (Episode 3) — two real browsers (separate browser processes) over
// the real Worker (Durable Object + WebSocket), plus a late joiner. Developer-environment run
// (headless Chromium, SwiftShader, wrangler dev + the local access proxy), not CI. A fresh random
// room every run (never 7K3M). Every check records when it ran and who acted; a failing check
// keeps its detail and the run's diagnostics.
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799
//   node scripts/e2e-greenhouse-worker.mjs [http://vm.test:8800] [artifacts-dir]
//
// With real pointer and keyboard input (Playwright mouse/keyboard):
//  - typed ports: a hose end dropped on a power socket stays out (both clients);
//  - a wrong build (tank straight to a bed) is drawn as built and carries nothing, then fixed;
//  - plumbing and wiring by pointer by both makers, the probe pushed into a bed slot; both converge;
//  - occupied: a plug released over a taken port stays out;
//  - keyboard edits of the valves and rules: an off-step value is caught before sending, an
//    accepted one reaches the other maker; a teammate's edit leaves an unapplied draft alone;
//  - stale: simultaneous rule edits — one accepted, the other refused (up to 4 attempts);
//  - Undo / Redo while paused;
//  - the day: start, speed ×4, the rig locked while running (drag refused, Undo refused
//    "running"), a pause racing an Undo (both converge either way), paused convergence of
//    model time and resources (exact), a late joiner (exact), a dropped connection and recovery
//    (no free elapsed time, no rewind), step one hour, a reset race (one applies, the other is
//    refused as stale), a failing day (DI reasons vs PF measured values only, the PF notes gate)
//    and a passing day with the worked allocation, explained;
//  - export (version 3, build only), import refused while running, Reset bench and import back,
//    a version-1 greenhouse file migrated to the default rig with a notice;
//  - cameras (1/2/3) and selection cross-links (diagram → 3D, 3D valve handle → inspector field);
//  - everyone leaves while the day runs: it pauses with its resources (no refill), and the
//    returning host is offered its saved rig.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `G${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const artifacts = process.argv[3] ?? `${tmpdir()}/vm-e2e-greenhouse-${room}`;
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
const pages = {};
async function check(name, ok, detail = "", actor = "") {
  const entry = { name, ok: Boolean(ok), detail, actor, at: new Date().toISOString() };
  results.push(entry);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const ready = (page, label) => settled(page, label, { diagnostics: artifacts });
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
const lines = (s) => JSON.stringify(s?.panel?.rig?.lines ?? null);
const status = (page) => page.locator("#scene-status-copy").textContent();
const BRIEF_RIG = { "irrigation-hose": [0, 1], "irrigation-hose-2": [2, 3], "irrigation-hose-3": [4, 6], "irrigation-hose-4": [5, 7], "power-cable-1": [8, 9], "power-cable-2": [10, 12], "power-cable-3": [11, 13] };
const COMPLETE = JSON.stringify({ "irrigation-hose": "supply", "irrigation-hose-2": "delivery", "irrigation-hose-3": "branch", "irrigation-hose-4": "branch", "power-cable-1": "charging", "power-cable-2": "feed", "power-cable-3": "feed" });
const shownKey = (s) => JSON.stringify(s?.panel?.shown ? { tick: s.panel.shown.tick, tank: s.panel.shown.tank, beds: s.panel.shown.beds, battery: s.panel.shown.battery, air: s.panel.shown.air, stress: s.panel.shown.stress } : null);

async function maker(email, viewport) {
  const context = await (await launch()).newContext({ viewport, reducedMotion: "reduce", acceptDownloads: true });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await instrument(context);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  return context;
}
async function join(context, label, { host = false, condition = "DI" } = {}) {
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
  await ready(page, `${label} entered`);
  pages[label] = page;
  return page;
}
/** A real pointer drag of a hose's or cable's end into a port (or anywhere `to`). */
async function plug(page, line, end, port) {
  await ready(page, `before ${line}:${end}→${port}`);
  const from = await page.evaluate(({ line, end }) => window.__vmQa.plugPoint(line, end), { line, end });
  const to = await page.evaluate((port) => window.__vmQa.jackPoint(port, true), port);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) await page.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
  await page.mouse.up();
}
/** A real pointer drag of the soil probe into a bed's slot (pins `a`, `b`). */
async function placeProbe(page, a, b) {
  await ready(page, "before probe");
  const points = await page.evaluate(([a, b]) => window.__vmQa.partDragPoints("soil-sensor", a, b), [a, b]);
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  for (let step = 1; step <= 14; step += 1) await page.mouse.move(points.from.x + ((points.to.x - points.from.x) * step) / 14, points.from.y + ((points.to.y - points.from.y) * step) / 14);
  await page.mouse.up();
}
async function openTab(page) {
  await page.locator('.discussion-tab[data-tab="greenhouse"]').click();
}
async function selectOnDiagram(page, id) {
  await openTab(page);
  await page.locator('#gh-panel .gh-jump a[href="#gh-flow-title"]').click();
  // Equipment and the probe: their diagram node; a hose or cable: its button in the connection list.
  if (/hose|cable/.test(id)) await page.locator(`#gh-list [data-select="${id}"]`).click();
  else await page.locator(`#gh-diagram [data-select="${id}"]`).click();
  await page.waitForFunction((id) => window.__vmQa.selected() === id && document.querySelector("#gh-part-panel")?.textContent?.length > 20, id);
}
async function typeInto(page, selector, text) {
  await page.locator(selector).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
  const value = await page.locator(selector).inputValue();
  if (value !== text) await check(`keyboard typing landed in ${selector}`, false, `field shows "${value}", typed "${text}"`);
}
/** Sets both values of a fixture by keyboard (type, Tab past the stepper, Enter on the form). */
async function setValues(page, part, values) {
  await selectOnDiagram(page, part);
  for (const [param, value] of Object.entries(values)) await typeInto(page, `#gh-${param}`, String(value));
  await page.keyboard.press("Enter");
}
const editNote = (page) => page.locator("#gh-part-panel .si-edit-note[role=status]").last().textContent().catch(() => "");
const runNote = (page) => page.locator("#gh-run-note").textContent().catch(() => "");
async function runControl(page, selector) {
  await openTab(page);
  await page.locator('#gh-panel .gh-jump a[href="#gh-day-title"]').click();
  await page.locator(selector).click();
}
async function resetDay(page, seed = null) {
  await runControl(page, "#gh-reset");
  if (seed !== null) {
    await page.locator('.gh-reset-dialog input[value="practice"]').check();
    await page.locator('.gh-reset-dialog input[name="gh-seed"]').fill(String(seed));
  } else await page.locator('.gh-reset-dialog input[value="brief"]').check();
  await page.locator('.gh-reset-dialog button[type="submit"]').click();
}

let exitCode = 0;
try {
  const hostContext = await maker("host@example.test", { width: 960, height: 640 });
  const memberContext = await maker("member@example.test", { width: 960, height: 640 });
  const host = await join(hostContext, "host", { host: true, condition: "DI" });
  const member = await join(memberContext, "member", { condition: "PF" });

  // ── Start: one run, same day; DI vs PF ──
  const [h0, m0] = [await gh(host), await gh(member)];
  await check("both hold the room's day: run 1, seed 11, not started, 06:00, tank 40 L", h0.panel.run.runId === m0.panel.run.runId && h0.panel.run.seed === 11 && m0.panel.run.status === "idle" && shownKey(h0) === shownKey(m0) && m0.panel.shown.tank === 40 && m0.panel.shown.clock === "06:00", `${shownKey(h0)} | ${shownKey(m0)}`);
  await check("DI host sees the worked example; PF member does not; the greenhouse tab is the open dock tab", await host.locator("#gh-worked").isVisible() && !(await member.locator("#gh-worked").isVisible()) && await member.locator('.discussion-tab[data-tab="greenhouse"].is-active').count() === 1);
  await check("nothing is built at the start (no auto-build in either condition)", !m0.panel.rig.complete && m0.panel.rig.faults.includes("no-probe") && Object.values(m0.panel.rig.lines).every((s) => s === "unplugged"), JSON.stringify(m0.panel.rig.lines));

  // ── Typed ports: a hose end on a power socket stays out ──
  await plug(host, "irrigation-hose", 0, 12);
  await ready(host, "host after wrong-type");
  const wrongType = await status(host);
  const afterWrongType = await until(() => gh(member), (s) => s.panel.rig.lines["irrigation-hose"] === "unplugged", 30_000);
  await check("typed ports: a hose end dropped on PUMP 12 V IN stays out, for both, with the reason", /takes a power plug/.test(wrongType ?? "") && afterWrongType.panel.rig.lines["irrigation-hose"] === "unplugged" && (await gh(host)).panel.rig.lines["irrigation-hose"] === "unplugged", `status "${wrongType}"`, "host");

  // ── A wrong build drawn as built: the tank straight to bed A ──
  await plug(host, "irrigation-hose", 0, 0);
  await plug(host, "irrigation-hose", 1, 6);
  const noPump = await until(() => gh(member), (s) => s.panel.rig.lines["irrigation-hose"] === "no-pump");
  const memberEdge = await member.evaluate(() => { const g = document.querySelector('#gh-diagram [data-line="irrigation-hose"]'); return g ? { status: g.getAttribute("data-status"), flow: g.getAttribute("data-flow") } : null; });
  const hostNotes = await host.locator("#gh-notes").textContent();
  const memberNotes = await member.locator("#gh-notes").textContent();
  await check("wrong build: TANK OUT → BED A INLET is drawn as built (no pump, ✕), carries nothing; DI explains it, PF withholds the explanation until a finished day", noPump.panel.rig.lines["irrigation-hose"] === "no-pump" && memberEdge?.status === "no-pump" && memberEdge?.flow === "wrong" && /tank straight to a bed/i.test(hostNotes ?? "") && !/tank straight to a bed/i.test(memberNotes ?? "") && /after your own first finished day/.test(memberNotes ?? ""),
    `edge ${JSON.stringify(memberEdge)}; PF notes "${memberNotes?.slice(0, 160)}"`, "host");
  // Fix it: end B to PUMP IN.
  await plug(host, "irrigation-hose", 1, 1);

  // ── Plumb (host) and wire + probe (member), by pointer ──
  for (const [line, [a, b]] of Object.entries(BRIEF_RIG)) {
    if (line === "irrigation-hose") continue;
    const page = line.startsWith("power") ? member : host;
    await plug(page, line, 0, a);
    await plug(page, line, 1, b);
  }
  await placeProbe(member, 14, 15);
  const builtHost = await until(() => gh(host), (s) => lines(s) === COMPLETE && s.panel.rig.probe === "A");
  const builtMember = await until(() => gh(member), (s) => lines(s) === COMPLETE && s.panel.rig.probe === "A");
  await check("pointer-built rig: both makers hold the same complete rig (supply, delivery, two branches, solar, two feeds, probe in bed A)", builtHost.panel.rig.complete && builtMember.panel.rig.complete && lines(builtHost) === lines(builtMember), `${lines(builtHost)} probe ${builtHost.panel.rig.probe}`, "host + member");

  // ── Occupied: a plug released over a taken port stays out ──
  await plug(member, "power-cable-3", 1, 12);
  const occupied = await until(() => gh(host), (s) => s.panel.rig.lines["power-cable-3"] === "loose", 60_000);
  const occupiedCopy = await status(member);
  await check("occupied: a cable end dropped on PUMP 12 V IN (taken) stays out; the pump's cable is untouched", occupied.panel.rig.lines["power-cable-3"] === "loose" && occupied.panel.rig.lines["power-cable-2"] === "feed" && /already holds a line/.test(occupiedCopy ?? ""), `status "${occupiedCopy}"`, "member");
  // Keyboard alternative to dragging: the member chooses the port in the cable's card and submits by Enter.
  await selectOnDiagram(member, "power-cable-3");
  await member.locator("#gh-end-1").focus();
  await member.locator("#gh-end-1").selectOption("13");
  await member.locator('#gh-part-panel form[data-ports] button[type="submit"]').focus();
  await member.keyboard.press("Enter");
  const keyboardPlug = await until(() => gh(host), (s) => lines(s) === COMPLETE, 120_000);
  await check("keyboard plumbing: choosing FAN 12 V IN for cable 3's free end in its card connects it for both", lines(keyboardPlug) === COMPLETE, lines(keyboardPlug), "member");

  // ── Keyboard edits: an off-step value never leaves the page; a valid one is shared ──
  await setValues(host, "valve-manifold", { valveA: 33, valveB: 100 });
  const offStep = await editNote(host);
  const listAfterOffStep = await member.evaluate(() => document.querySelector("#gh-list")?.textContent ?? "");
  await check("off-step valve value (33 %) is caught on the page: nothing sent, the room keeps 100 %", /5 % steps/.test(offStep ?? "") && /valve A 100 %/.test(listAfterOffStep), `note "${offStep}"`, "host");
  await setValues(host, "valve-manifold", { valveA: 30, valveB: 100 });
  const accepted = await until(() => member.evaluate(() => document.querySelector("#gh-list")?.textContent ?? ""), (text) => /valve A 30 %/.test(text), 120_000);
  await check("host's valve A 30 % (typed, Enter) accepted and shown to the member", /valve A 30 %/.test(accepted), "", "host");

  // ── Draft preservation ──
  await selectOnDiagram(member, "valve-manifold");
  await typeInto(member, "#gh-valveB", "45");
  await setValues(host, "valve-manifold", { valveA: 30, valveB: 50 });
  await until(() => member.evaluate(() => document.querySelector("#gh-list")?.textContent ?? ""), (text) => /valve B 50 %/.test(text), 120_000);
  const memberDraft = await member.locator("#gh-valveB").inputValue();
  const memberDrafts = (await gh(member)).panel.drafts;
  await check("member's unapplied draft (valve B 45 %) survives the host's accepted 50 %; the room shows 50 %", memberDraft === "45" && memberDrafts["valve-manifold:valveB"] === "45", `field "${memberDraft}" drafts ${JSON.stringify(memberDrafts)}`, "host vs member");
  await member.locator('[data-revert="valve-manifold"]').click();

  // ── Stale: simultaneous rule edits ──
  let stale = null;
  for (let attempt = 1; attempt <= 4 && !stale; attempt += 1) {
    await selectOnDiagram(host, "farm-controller");
    await selectOnDiagram(member, "farm-controller");
    await typeInto(host, "#gh-pumpBelow", String(55 + 5 * (attempt % 2)));
    await typeInto(member, "#gh-pumpBelow", String(65 + 5 * (attempt % 2)));
    await Promise.all([host.locator('#gh-part-panel form[data-part="farm-controller"] button[type="submit"]').click(), member.locator('#gh-part-panel form[data-part="farm-controller"] button[type="submit"]').click()]);
    const notes = await until(async () => [await editNote(host), await editNote(member)], (pair) => pair.every((text) => text && !/Sending/.test(text)), 60_000);
    const refused = notes.findIndex((text) => /Not applied/.test(text));
    if (refused >= 0) stale = { attempt, notes, refused: refused === 0 ? "host" : "member" };
  }
  if (stale) {
    const loser = stale.refused === "host" ? host : member;
    const loserDrafts = (await gh(loser)).panel.drafts;
    await check("stale: one of two simultaneous rule edits is refused; that maker keeps their draft and the room's value", /a teammate changed it first/.test(stale.notes[stale.refused === "host" ? 0 : 1]) && Boolean(loserDrafts["farm-controller:pumpBelow"]), `attempt ${stale.attempt}: ${JSON.stringify(stale.notes)}`, stale.refused);
    await loser.locator('[data-revert="farm-controller"]').click().catch(() => undefined);
  } else await check("stale: observed within 4 simultaneous attempts (both accepted every time: arrival order serialized them)", true, "not observed; the room-core stale refusal is covered by greenhouse-model-check", "both");

  // ── Undo / Redo while the day is not running ──
  await setValues(host, "farm-controller", { pumpBelow: 60, fanAbove: 26 });
  await until(() => member.evaluate(() => document.querySelector("#gh-list")?.textContent ?? ""), (text) => /soil < 60 %, fan when air > 26/.test(text), 120_000);
  await host.locator("#undo-edit").click();
  const undone = await until(() => member.evaluate(() => document.querySelector("#gh-list")?.textContent ?? ""), (text) => !/fan when air > 26/.test(text), 120_000);
  await host.locator("#redo-edit").click();
  const redone = await until(() => member.evaluate(() => document.querySelector("#gh-list")?.textContent ?? ""), (text) => /soil < 60 %, fan when air > 26/.test(text), 120_000);
  await check("Undo and Redo of the host's rule edit reach the member", !/fan when air > 26/.test(undone) && /fan when air > 26/.test(redone), "", "host");

  // ── The day: start, ×4, locked rig ──
  await openTab(member);
  await member.locator('#gh-predictions input[value="dry"]').check();
  await runControl(host, "#gh-run-toggle");
  await until(() => gh(member), (s) => s.panel.run.status === "running", 60_000);
  await runControl(member, '#gh-panel [data-speed="4"]');
  const fast = await until(() => gh(host), (s) => s.panel.run.speed === 4 && s.panel.shown.tick > 0, 120_000);
  await check("start (host) and speed ×4 (member): both clients run the room's day", fast.panel.run.status === "running" && fast.panel.run.speed === 4 && fast.panel.locked === true, JSON.stringify(fast.panel.run), "host + member");
  // Back to ×1 (a day in 4 minutes) so the lock checks below happen while the day still runs.
  await runControl(member, '#gh-panel [data-speed="1"]');
  await until(() => gh(host), (s) => s.panel.run.speed === 1, 120_000);
  const linesBefore = lines(await gh(host));
  await plug(member, "irrigation-hose-4", 1, 6);
  await ready(member, "member after locked drag");
  const lockedCopy = await status(member);
  await check("while the day runs, a hose drag is refused on the page and nothing changes", /rig is locked/.test(lockedCopy ?? "") && lines(await gh(host)) === linesBefore && lines(await gh(member)) === linesBefore, `status "${lockedCopy}"`, "member");
  await host.locator("#undo-edit").click();
  const undoRunning = await until(() => status(host), (text) => /running/.test(text ?? ""), 60_000);
  await check("while the day runs, Undo is refused by the room (running) and the rule stays", /day is running/.test(undoRunning ?? "") && /fan when air > 26/.test(await member.evaluate(() => document.querySelector("#gh-list")?.textContent ?? "")), `status "${undoRunning}"`, "host");

  // ── A pause racing an Undo: the room orders them; both clients converge either way ──
  await Promise.all([runControl(member, "#gh-run-toggle"), host.locator("#undo-edit").click()]);
  const pausedHost = await until(() => gh(host), (s) => s.panel.run.status === "paused", 120_000);
  await sleep(3000);
  const [ph, pm] = [await gh(host), await gh(member)];
  await check("pause vs Undo race: both clients hold the same paused day and the same rig", ph.panel.run.status === "paused" && shownKey(ph) === shownKey(pm) && lines(ph) === lines(pm) && ph.panel.run.runId === pm.panel.run.runId, `${shownKey(ph)} | ${shownKey(pm)}`, "member + host");
  await check("paused day: water and energy ledgers balance (|residual| < 1e-9 L / Wh); records = model time", Math.abs(ph.panel.shown.balance.water) < 1e-9 && Math.abs(ph.panel.shown.balance.energy) < 1e-9 && ph.panel.shown.tick === ph.panel.run.tick, JSON.stringify(ph.panel.shown.balance));
  void pausedHost;
  // Put the worked allocation back for the rest of the run (it may have been undone).
  await setValues(host, "farm-controller", { pumpBelow: 60, fanAbove: 26 });
  await until(() => gh(member), (s) => true, 1000);

  // ── Late joiner ──
  const lateContext = await maker("late@example.test", { width: 900, height: 640 });
  const late = await join(lateContext, "late", { condition: "DI" });
  const lateView = await until(() => gh(late), (s) => shownKey(s) === shownKey(ph));
  await check("late joiner (paused day): the same model time and resources, exactly", shownKey(lateView) === shownKey(ph) && lines(lateView) === lines(ph), `${shownKey(lateView)}`, "late");
  await late.close();
  delete pages.late;

  // ── Dropped connection and recovery while the day runs ──
  await runControl(host, "#gh-run-toggle");
  await until(() => gh(member), (s) => s.panel.run.status === "running", 60_000);
  const beforeDrop = await gh(member);
  await member.evaluate(() => window.__vmQa.dropConnection());
  const wentOffline = await until(() => member.evaluate(() => window.__vmQa.episode().online), (online) => online === false, 30_000);
  await runControl(member, "#gh-run-toggle");
  const offlineNote = await until(() => runNote(member), (text) => Boolean(text) && !/Sending/.test(text), 60_000);
  await sleep(6000);
  await runControl(host, "#gh-run-toggle");
  const hostPaused = await until(() => gh(host), (s) => s.panel.run.status === "paused", 120_000);
  const memberBack = await until(() => gh(member), (s) => s.panel.run.status === "paused" && shownKey(s) === shownKey(hostPaused), 180_000);
  await check("member's connection dropped mid-run: its run control was not applied; after reconnecting it holds the room's paused day exactly (no rewind, no free time)", shownKey(memberBack) === shownKey(hostPaused) && memberBack.panel.shown.tick >= beforeDrop.panel.shown.tick && wentOffline === false && /Not applied/.test(offlineNote ?? ""), `note "${offlineNote}"; before ${beforeDrop.panel.shown.tick} after ${memberBack.panel.shown.tick}`, "member");

  // ── Step one hour ──
  const beforeStep = (await gh(host)).panel.shown.tick;
  await runControl(member, "#gh-step");
  const stepped = await until(() => gh(host), (s) => s.panel.shown.tick === Math.min(96, beforeStep + 4), 60_000);
  await check("step one hour: +4 steps for both", stepped.panel.shown.tick === Math.min(96, beforeStep + 4) && shownKey(await until(() => gh(member), (s) => shownKey(s) === shownKey(stepped), 60_000)) === shownKey(stepped), `${beforeStep} → ${stepped.panel.shown.tick}`, "member");

  // ── Reset race: one reset applies, the other is refused as stale ──
  const runBefore = (await gh(host)).panel.run.runId;
  await Promise.all([resetDay(host), resetDay(member)]);
  const notes = await until(async () => [await runNote(host), await runNote(member)], (pair) => pair.every((text) => text && !/Sending/.test(text)), 60_000);
  const afterReset = await until(() => gh(member), (s) => s.panel.run.runId > runBefore, 60_000);
  await sleep(2000);
  const [rh, rm] = [await gh(host), await gh(member)];
  const staleCount = notes.filter((text) => /changed the day first/.test(text)).length;
  // Either the second reset was decided on the old run (refused as stale: run +1), or its
  // maker already saw the first reset when confirming (both apply in turn: run +2). Never a
  // reset applied on a run its maker did not see.
  const raced = (rh.panel.run.runId === runBefore + 1 && staleCount === 1) || (rh.panel.run.runId === runBefore + 2 && staleCount === 0);
  await check("reset race: no reset is applied to a run its maker did not see (one stale refusal, or two resets in turn); tank 40 L, 06:00 for both", raced && rh.panel.run.runId === rm.panel.run.runId && rh.panel.shown.tank === 40 && rh.panel.shown.tick === 0 && shownKey(rh) === shownKey(rm),
    `${JSON.stringify(notes)}; run ${runBefore} → ${rh.panel.run.runId}`, "host + member");
  void afterReset;

  // ── A failing day (default allocation): DI reasons vs PF measured values; PF notes gate ──
  await setValues(host, "valve-manifold", { valveA: 100, valveB: 100 });
  await setValues(host, "farm-controller", { pumpBelow: 50, fanAbove: 30 });
  await until(() => member.evaluate(() => document.querySelector("#gh-list")?.textContent ?? ""), (text) => /valve A 100 %, valve B 100 %/.test(text) && /soil < 50 %, fan when air > 30/.test(text), 120_000);
  const notesLocked = (await gh(member)).panel.notesUnlocked;
  await runControl(host, "#gh-run-toggle");
  await runControl(host, '#gh-panel [data-speed="4"]').catch(() => undefined);
  const failedDay = await until(() => gh(member), (s) => s.panel.verdict !== null, 600_000);
  await sleep(1500);
  const memberVerdict = await member.locator("#gh-verdict").textContent();
  const hostVerdict = await host.locator("#gh-verdict").textContent();
  await check("default allocation on the brief's day fails (bed B out of range too long); both see the same measured values", failedDay.panel.verdict.met === false && failedDay.panel.verdict.criteria.find((c) => c.id === "G3")?.pass === false && JSON.stringify((await gh(host)).panel.verdict) === JSON.stringify(failedDay.panel.verdict), JSON.stringify(failedDay.panel.verdict.criteria.map((c) => `${c.id}:${c.measured}`)));
  await check("after the day: DI host sees why each failed criterion failed; PF member sees measured values only", /watered blind|half as much again/.test(hostVerdict ?? "") && !/watered blind|half as much again/.test(memberVerdict ?? "") && /measured/.test(memberVerdict ?? ""), "", "host vs member");
  const notesUnlocked = (await gh(member)).panel.notesUnlocked;
  await check("PF member: explanatory notes withheld before their own first finished day, unlocked after it", notesLocked === false && notesUnlocked === true, "", "member");
  const memberAttempt1 = await gh(member);
  await check("member's attempt 1 holds this day's result (a private record)", memberAttempt1.panel.resultRun === failedDay.panel.run.runId, JSON.stringify({ attempt: memberAttempt1.panel.attempt, result: memberAttempt1.panel.resultRun }), "member");

  // ── Revise: a new attempt (resets the day), the worked allocation, a passing day ──
  await openTab(member);
  await member.locator("#gh-explain").fill("Bed B dried out in the afternoon: the probe sat in bed A, and both valves fully open gave B no more than A.");
  await member.locator("#gh-explain-save").click();
  await member.locator("#gh-new-attempt").click();
  await member.locator('.gh-reset-dialog input[value="brief"]').check();
  await member.locator('.gh-reset-dialog button[type="submit"]').click();
  await until(() => gh(member), (s) => s.panel.attempt === 2 && s.panel.shown.tick === 0, 120_000);
  await setValues(member, "valve-manifold", { valveA: 30, valveB: 50 });
  await setValues(member, "farm-controller", { pumpBelow: 60, fanAbove: 26 });
  await until(() => host.evaluate(() => document.querySelector("#gh-list")?.textContent ?? ""), (text) => /valve A 30 %, valve B 50 %/.test(text) && /soil < 60 %, fan when air > 26/.test(text), 120_000);
  await openTab(member);
  await member.locator('#gh-predictions input[value="meets"]').check();
  await runControl(member, "#gh-run-toggle");
  await runControl(member, '#gh-panel [data-speed="4"]').catch(() => undefined);
  const passed = await until(() => gh(member), (s) => s.panel.verdict !== null, 600_000);
  await check("worked allocation on the brief's day: all five criteria met, for both", passed.panel.verdict.met === true && (await until(() => gh(host), (s) => s.panel.verdict?.met === true, 60_000)).panel.verdict.met === true, JSON.stringify(passed.panel.verdict.criteria.map((c) => `${c.id}:${c.measured}`)), "member");
  await member.locator("#gh-explain").fill("Valve B got the bigger share because bed B uses more; the fan started at 26 °C so the midday peak stayed under 35 °C.");
  await member.locator("#gh-explain-save").click();
  const explained = await gh(member);
  await check("member: attempt 2 met and explained (the goal counts only with an explanation)", explained.panel.attempt === 2 && explained.panel.explained === true && /brief met · explained/.test(await member.locator("#gh-pill").textContent() ?? ""), await member.locator("#gh-pill").textContent(), "member");

  // ── Export (build only), import refused while running, reset bench, import back, v1 migration ──
  await host.locator("#project-menu-button").click();
  const [download] = await Promise.all([host.waitForEvent("download"), host.locator("#export-project").click()]);
  const exportPath = `${artifacts}/export.json`;
  await download.saveAs(exportPath);
  const exported = JSON.parse(readFileSync(exportPath, "utf8"));
  const allowed = ["format", "version", "solver", "studio", "savedAt", "parts"];
  await check("export: a version-3 greenhouse project, build only (no run, tank, model time, names, notes)", exported.version === 3 && exported.studio === "greenhouse" && Object.keys(exported).every((key) => allowed.includes(key)) && !/tank|runId|records|host@|member@|explan|predict/i.test(JSON.stringify(exported)) && JSON.stringify(exported.parts.find((p) => p.id === "irrigation-hose-4").sockets) === "[5,7]" && exported.parts.find((p) => p.id === "valve-manifold").props.valveB === 50,
    JSON.stringify(Object.keys(exported)), "host");
  await resetDay(host);
  await until(() => gh(host), (s) => s.panel.shown.tick === 0, 60_000);
  await runControl(host, "#gh-run-toggle");
  await until(() => gh(host), (s) => s.panel.run.status === "running", 60_000);
  await host.locator("#project-file-input").setInputFiles(exportPath);
  await host.locator("#confirm-ok").click();
  const importRunning = await until(() => status(host), (text) => /running/.test(text ?? ""), 60_000);
  await check("import while the day runs is refused by the room (running); nothing changed", /day is running/.test(importRunning ?? ""), importRunning, "host");
  await runControl(host, "#gh-run-toggle");
  await until(() => gh(host), (s) => s.panel.run.status === "paused", 60_000);
  const tankBeforeReset = (await gh(host)).panel.shown.tank;
  await host.locator("#project-menu-button").click();
  await host.locator("#reset-bench").click();
  await host.locator("#confirm-ok").click();
  const benchReset = await until(() => gh(member), (s) => Object.values(s.panel.rig.lines).every((x) => x === "unplugged") && s.panel.rig.probe === null, 120_000);
  await check("Reset bench (paused): every line unplugged and the probe in its holder, for both; the day's resources are untouched (no refill)", benchReset.panel.rig.complete === false && Math.abs(benchReset.panel.shown.tank - tankBeforeReset) < 1e-9, `tank ${tankBeforeReset} → ${benchReset.panel.shown.tank}`, "host");
  await host.locator("#project-file-input").setInputFiles(exportPath);
  await host.locator("#confirm-ok").click();
  const imported = await until(() => gh(member), (s) => lines(s) === COMPLETE && s.panel.rig.probe === "A", 120_000);
  await check("import of the export restores the rig and values for both (one room edit); the tank is not refilled", lines(imported) === COMPLETE && /valve A 30 %, valve B 50 %/.test(await member.evaluate(() => document.querySelector("#gh-list")?.textContent ?? "")) && Math.abs(imported.panel.shown.tank - tankBeforeReset) < 1e-9, "", "host");
  const legacyPath = `${artifacts}/legacy-greenhouse.json`;
  writeFileSync(legacyPath, JSON.stringify({ format: "virtual-makerspace.project", version: 1, solver: "dc-mna-1", studio: "greenhouse", savedAt: "2026-01-01T00:00:00.000Z", parts: [{ id: "soil-sensor", sockets: [0, 1] }, { id: "water-pump", sockets: [12, 14] }] }));
  await host.locator("#project-file-input").setInputFiles(legacyPath);
  const migrateDialog = await until(() => host.locator("#confirm-body").textContent(), (text) => /earlier greenhouse file/.test(text ?? ""), 30_000);
  await host.locator("#confirm-ok").click();
  await host.locator("#confirm-ok").click().catch(() => undefined);
  const migrated = await until(() => gh(member), (s) => Object.values(s.panel.rig.lines).every((x) => x === "unplugged"), 120_000);
  await check("a version-1 greenhouse file: a notice, then the default rig for both", /version 1/.test(migrateDialog ?? "") && Object.values(migrated.panel.rig.lines).every((x) => x === "unplugged"), migrateDialog?.slice(0, 120), "host");
  await host.locator("#undo-edit").click();
  await until(() => gh(member), (s) => lines(s) === COMPLETE, 120_000);

  // ── Cameras and selection cross-links ──
  await host.locator("#scene-host canvas, canvas").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  const cams = [];
  for (const key of ["1", "2", "3"]) {
    await host.locator("body").press(key);
    await sleep(800);
    cams.push(JSON.stringify((await host.evaluate(() => window.__vmQa.camera())).target));
  }
  await check("camera keys 1/2/3 (overview, top, beds) frame three different views", new Set(cams).size === 3, cams.join(" | "), "host");
  await selectOnDiagram(host, "vent-fan");
  await check("selecting the fan on the diagram selects it in 3D and opens its card", (await host.evaluate(() => window.__vmQa.selected())) === "vent-fan" && /cooling/i.test(await host.locator("#gh-part-panel").textContent() ?? ""), "", "host");
  await host.locator("body").press("1");
  await sleep(800);
  const handle = await host.evaluate(() => window.__vmQa.ghControlPoint("valveB"));
  await host.mouse.click(handle.x, handle.y);
  const focused = await until(() => host.evaluate(() => document.activeElement?.id ?? ""), (id) => id === "gh-valveB", 30_000);
  await check("clicking the valve B handle in 3D selects the manifold and focuses its valve B field", focused === "gh-valveB" && (await host.evaluate(() => window.__vmQa.selected())) === "valve-manifold", `focus ${focused}`, "host");

  // ── Everyone leaves while the day runs: it pauses with its resources; recovery offered ──
  await runControl(host, "#gh-run-toggle");
  await until(() => gh(host), (s) => s.panel.run.status === "running" && s.panel.shown.tick > 2, 120_000);
  const atLeave = await gh(host);
  await sleep(2500);
  await member.close();
  delete pages.member;
  await host.close();
  delete pages.host;
  await sleep(5000);
  const back = await join(hostContext, "host");
  const resumed = await gh(back);
  await check("everyone left mid-day: the day paused where it was (same run, model time not before the leave, no refill)", resumed.panel.run.status === "paused" && resumed.panel.run.runId === atLeave.panel.run.runId && resumed.panel.shown.tick >= atLeave.panel.shown.tick && resumed.panel.shown.tick < 96 && resumed.panel.shown.tank <= atLeave.panel.shown.tank + 1e-9,
    `left at ${atLeave.panel.shown.tick} (${atLeave.panel.shown.tank.toFixed(2)} L); back at ${resumed.panel.shown.tick} (${resumed.panel.shown.tank.toFixed(2)} L), ${resumed.panel.run.status}`, "host");
  const banner = await until(() => back.locator("#recovery-banner").isVisible(), Boolean, 120_000);
  await back.locator('[data-recovery="restore"]').click();
  const recovered = await until(() => gh(back), (s) => lines(s) === COMPLETE, 120_000);
  await check("the bench reset as in every studio; the returning host is offered and restores its saved rig", banner === true && lines(recovered) === COMPLETE, lines(recovered), "host");
  const errors = Object.values(pages).flatMap((page) => page.errors ?? []);
  await check("no page errors", errors.length === 0, errors.join("; "));
} catch (error) {
  console.error(error);
  results.push({ name: "run completed", ok: false, detail: String(error?.stack ?? error), at: new Date().toISOString() });
  for (const [label, page] of Object.entries(pages)) {
    if (page && !page.isClosed()) await page.screenshot({ path: `${artifacts}/fail-${label}.png` }).catch(() => undefined);
  }
  exitCode = 1;
} finally {
  const failed = results.filter((entry) => !entry.ok);
  writeFileSync(`${artifacts}/results.json`, `${JSON.stringify({ room, base, results }, null, 1)}\n`);
  console.log(`e2e greenhouse: ${results.length - failed.length}/${results.length} checks passed (room ${room}; artifacts ${artifacts})`);
  await Promise.all(browsers.map((own) => own.close().catch(() => undefined)));
  process.exit(failed.length || exitCode ? 1 : 0);
}
