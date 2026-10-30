// Resource-Limited Greenhouse (Episode 3) render evidence, one reproducible capture run against a
// build of the app (peer mode: no server needed). Headless Chromium + SwiftShader: renderer
// counters are draw calls and triangles of the frame shown, never frame rates.
//
//   npm run build && (cd dist && python3 -m http.server 4173 --bind 127.0.0.1)
//   node scripts/qa-greenhouse.mjs http://127.0.0.1:4173 <out-dir> <app-sha>
//
// Shots (fixed cameras, so later runs can be compared shot for shot):
//   01 overview 1440×900 (nothing built) · 02 overview 1280×720 · 03 top (key 2) · 04 beds (key 3)
//   05 wrong build (tank straight to a bed, OUT→OUT, a loose end) with the flow card
//   06 built, mid-day (paused at 13:00) with the day card · 07 close-up pump and manifold ports
//   07b close-up of the valve handwheels and the controller knobs
//   08 close-up beds with the probe · 09 failure: the default allocation's day (bed B dries)
//   10 recovery: the worked allocation's day (all five met) · 11 the selected manifold's card
//   12 phone 390×844 top · 13 phone dock reached by wheel and keyboard · 14 PF panel (no worked example)
// Composition: the overview's projected greenhouse width / the free width between the panels (≥ 0.6).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base = "http://127.0.0.1:4173", out = "qa-greenhouse", appSha = "unknown"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
const room = () => `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
const pages = [];
const record = { app: appSha, base, shots: [], checks: [], issues: [] };
const check = (name, ok, detail = "") => {
  record.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const BRIEF = [["irrigation-hose", 0, 1], ["irrigation-hose-2", 2, 3], ["irrigation-hose-3", 4, 6], ["irrigation-hose-4", 5, 7], ["power-cable-1", 8, 9], ["power-cable-2", 10, 12], ["power-cable-3", 11, 13]];

async function open(viewport, condition = "DI") {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await instrument(context);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(240_000);
  pages.push(page);
  page.on("pageerror", (error) => record.issues.push(`pageerror: ${error.message}`));
  const code = room();
  await page.goto(`${base}/?room=${code}&name=QA&studio=greenhouse&qa=1&condition=${condition}`);
  await page.click("#enter-room");
  await page.waitForFunction(() => Boolean(window.__vmQa?.greenhouse?.().panel?.shown), null, { timeout: 300_000, polling: 500 });
  await settled(page, `${condition} ${viewport.width} entered`);
  return { context, page, code };
}
async function shot(page, name, { element = null, note = "" } = {}) {
  await settled(page, name);
  const path = `${out}/${name}.png`;
  if (element) {
    // A dock card can be taller than the window: capture what the window shows of it (an element
    // screenshot would resize the window and re-lay out the dock).
    const locator = page.locator(element);
    await locator.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    const box = await locator.boundingBox();
    const view = page.viewportSize();
    const clip = box ? { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, view.width - Math.max(0, box.x)), height: Math.min(box.height, view.height - Math.max(0, box.y)) } : undefined;
    await page.screenshot({ path, clip });
  } else await page.screenshot({ path });
  const stats = await page.evaluate(() => window.__vmQa.stats());
  const camera = await page.evaluate(() => window.__vmQa.camera());
  const entry = { name, file: `${name}.png`, viewport: page.viewportSize(), element, calls: stats?.calls ?? null, triangles: stats?.triangles ?? null, camera, note };
  record.shots.push(entry);
  console.log(`shot ${name}: ${entry.calls} calls, ${entry.triangles} triangles`);
}
const state = (page) => page.evaluate(() => window.__vmQa.greenhouse());
async function build(page, lines, probe = [14, 15]) {
  for (const [id, a, b] of lines) {
    if (a !== null) await page.evaluate(({ id, a }) => window.__vmQa.dropEnd(id, 0, a), { id, a });
    if (b !== null) await page.evaluate(({ id, b }) => window.__vmQa.dropEnd(id, 1, b), { id, b });
  }
  if (probe) await page.evaluate(([a, b]) => window.__vmQa.seatShared({ "soil-sensor": [a, b] }), probe);
}
async function setValues(page, part, values) {
  await page.locator(`.component-card[data-component-id="${part}"]`).click();
  await page.locator('.discussion-tab[data-tab="greenhouse"]').click();
  for (const [param, value] of Object.entries(values)) {
    await page.locator(`#gh-${param}`).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(String(value));
  }
  await page.keyboard.press("Enter");
  await page.waitForFunction(({ part, values }) => {
    const text = document.querySelector("#gh-list")?.textContent ?? "";
    return part === "valve-manifold" ? text.includes(`valve A ${values.valveA} %, valve B ${values.valveB} %`) : text.includes(`soil < ${values.pumpBelow} %, fan when air > ${values.fanAbove}`);
  }, { part, values });
}
async function control(page, selector) {
  await page.locator('.discussion-tab[data-tab="greenhouse"]').click();
  await page.locator(selector).click();
}
async function runDay(page) {
  await control(page, "#gh-run-toggle");
  await control(page, '#gh-panel [data-speed="4"]');
  await page.waitForFunction(() => window.__vmQa.greenhouse().panel.verdict !== null, null, { timeout: 600_000, polling: 1000 });
}
const fill = async (page) => {
  const rect = await page.evaluate(() => window.__vmQa.benchRect());
  return rect ? rect.bench.width / rect.free.width : 0;
};

try {
  // ── 1440×900, DI ──
  const { page } = await open({ width: 1440, height: 900 });
  await page.evaluate(() => window.__vmQa.preset("overview"));
  await shot(page, "01-overview");
  const fill1440 = await fill(page);
  check("1440×900 overview: the greenhouse fills ≥ 60 % of the free width", fill1440 >= 0.6, fill1440.toFixed(3));
  await page.locator("canvas").first().focus().catch(() => undefined);
  const cams = [];
  for (const [key, name] of [["2", "03-top"], ["3", "04-beds"]]) {
    await page.keyboard.press(key);
    cams.push(JSON.stringify((await page.evaluate(() => window.__vmQa.camera())).target));
    await shot(page, name, { note: `key ${key}` });
  }
  await page.keyboard.press("1");
  check("camera keys 2 and 3 frame different views", new Set(cams).size === 2, cams.join(" | "));

  // Wrong build: tank straight to bed A (no pump), valve A to valve B (OUT→OUT), a loose cable.
  await build(page, [["irrigation-hose", 0, 6], ["irrigation-hose-3", 4, 5], ["power-cable-1", 8, null]], null);
  const wrong = await state(page);
  check("wrong build drawn as built: no pump, OUT→OUT and loose; nothing flows", wrong.panel.rig.lines["irrigation-hose"] === "no-pump" && wrong.panel.rig.lines["irrigation-hose-3"] === "out-out" && wrong.panel.rig.lines["power-cable-1"] === "loose" && !wrong.panel.rig.complete, JSON.stringify(wrong.panel.rig.lines));
  await page.locator('.discussion-tab[data-tab="greenhouse"]').click();
  await page.locator('#gh-panel .gh-jump a[href="#gh-flow-title"]').click();
  await shot(page, "05-wrong-build");
  await shot(page, "05b-wrong-build-flow", { element: "#gh-flow-card" });

  // Built rig, worked allocation, mid-day.
  await page.locator("#project-menu-button").click();
  await page.locator("#reset-bench").click();
  await page.locator("#confirm-ok").click();
  await page.waitForFunction(() => window.__vmQa.greenhouse().panel.rig.lines["irrigation-hose"] === "unplugged");
  await build(page, BRIEF);
  await page.waitForFunction(() => window.__vmQa.greenhouse().panel.rig.complete);
  await setValues(page, "valve-manifold", { valveA: 30, valveB: 50 });
  await setValues(page, "farm-controller", { pumpBelow: 60, fanAbove: 26 });
  // Mid-day by "Step 1 h" (a software-rendered page is too slow to pause a running day at a set time).
  for (let hour = 1; hour <= 7; hour += 1) {
    await control(page, "#gh-step");
    await page.waitForFunction((tick) => window.__vmQa.greenhouse().panel.shown.tick === tick, hour * 4);
  }
  const mid = await state(page);
  check("mid-day (paused): resources from the model, ledgers balanced", Math.abs(mid.panel.shown.balance.water) < 1e-9 && Math.abs(mid.panel.shown.balance.energy) < 1e-9 && mid.panel.shown.tank < 40, JSON.stringify({ tick: mid.panel.shown.tick, tank: mid.panel.shown.tank, balance: mid.panel.shown.balance }));
  await page.locator('#gh-panel .gh-jump a[href="#gh-day-title"]').click();
  await shot(page, "06-built-midday");
  await shot(page, "06b-day-card", { element: "#gh-day-card" });
  for (const [name, position, target] of [
    ["07-closeup-pump-manifold", [-0.4, 2.7, 4.7], [-0.4, 0.6, 1.95]],
    ["07b-closeup-controls", [1.25, 2.6, 4.7], [1.25, 0.9, 2.0]],
    ["08-closeup-beds-probe", [-1.6, 2.9, 2.5], [-1.5, 0.55, -0.45]],
  ]) {
    await page.evaluate(({ position, target }) => window.__vmQa.view(position, target), { position, target });
    await shot(page, name);
  }
  await page.evaluate(() => window.__vmQa.preset("overview"));

  // Failure: the default allocation on the brief's day, as a new attempt (the mid-day steps above
  // began attempt 1's day, which fixed its prediction; a new attempt predicts again).
  await control(page, "#gh-new-attempt");
  await page.locator('.gh-reset-dialog input[value="brief"]').check();
  await page.locator('.gh-reset-dialog button[type="submit"]').click();
  await page.waitForFunction(() => window.__vmQa.greenhouse().panel.attempt === 2 && window.__vmQa.greenhouse().panel.shown.tick === 0);
  await setValues(page, "valve-manifold", { valveA: 100, valveB: 100 });
  await setValues(page, "farm-controller", { pumpBelow: 50, fanAbove: 30 });
  await page.locator('#gh-predictions input[value="meets"]').check();
  // The dock collapsed while the day runs: model time goes on (the HUD and 3D follow it).
  await control(page, "#gh-run-toggle");
  await page.locator("#dock-collapse").click();
  const collapsedAt = await page.evaluate(() => ({ tick: window.__vmQa.greenhouse().panel.shown.tick, clock: document.querySelector("#metric-clock")?.textContent }));
  await page.waitForFunction((tick) => window.__vmQa.greenhouse().panel.shown.tick >= tick + 4, collapsedAt.tick, { polling: 500 });
  const collapsedLater = await page.evaluate(() => ({ tick: window.__vmQa.greenhouse().panel.shown.tick, clock: document.querySelector("#metric-clock")?.textContent, dockHidden: document.querySelector("#dock-reopen")?.offsetParent !== null }));
  check("dock collapsed: the day keeps running and the HUD clock follows it", collapsedLater.tick >= collapsedAt.tick + 4 && collapsedLater.clock !== collapsedAt.clock && collapsedLater.dockHidden, JSON.stringify({ collapsedAt, collapsedLater }));
  await page.locator("#dock-reopen").click();
  await control(page, '#gh-panel [data-speed="4"]');
  await page.waitForFunction(() => window.__vmQa.greenhouse().panel.verdict !== null, null, { timeout: 600_000, polling: 1000 });
  const failed = await state(page);
  check("failure: the default allocation fails the brief (bed B out of range too long)", failed.panel.verdict.met === false && failed.panel.verdict.criteria.find((c) => c.id === "G3")?.pass === false, JSON.stringify(failed.panel.verdict.criteria.map((c) => `${c.id}:${c.measured}`)));
  await page.locator('#gh-panel .gh-jump a[href="#gh-day-title"]').click();
  await shot(page, "09-failure");
  await shot(page, "09b-failure-verdict", { element: "#gh-verdict" });

  // Recovery: the worked allocation on a fresh brief's day.
  await page.locator("#gh-explain").fill("Bed B dried out: both valves wide open gave it no more water than bed A, which uses less.");
  await page.locator("#gh-explain-save").click();
  await page.locator("#gh-new-attempt").click();
  await page.locator('.gh-reset-dialog input[value="brief"]').check();
  await page.locator('.gh-reset-dialog button[type="submit"]').click();
  await page.waitForFunction(() => window.__vmQa.greenhouse().panel.attempt === 3 && window.__vmQa.greenhouse().panel.shown.tick === 0);
  await setValues(page, "valve-manifold", { valveA: 30, valveB: 50 });
  await setValues(page, "farm-controller", { pumpBelow: 60, fanAbove: 26 });
  await runDay(page);
  const recovered = await state(page);
  check("recovery: the worked allocation meets all five criteria", recovered.panel.verdict.met === true, JSON.stringify(recovered.panel.verdict.criteria.map((c) => `${c.id}:${c.measured}`)));
  await page.locator('#gh-panel .gh-jump a[href="#gh-day-title"]').click();
  await shot(page, "10-recovery");
  await shot(page, "10b-recovery-verdict", { element: "#gh-verdict" });
  await page.locator(".component-card[data-component-id=\"valve-manifold\"]").click();
  await page.locator('#gh-panel .gh-jump a[href="#gh-part-title"]').click();
  await shot(page, "11-selected-manifold", { element: "#gh-part-card" });
  await page.context().close();

  // ── 1280×720 composition ──
  const small = await open({ width: 1280, height: 720 });
  await small.page.evaluate(() => window.__vmQa.preset("overview"));
  await shot(small.page, "02-overview-1280");
  const fill1280 = await fill(small.page);
  check("1280×720 overview: the greenhouse fills ≥ 60 % of the free width", fill1280 >= 0.6, fill1280.toFixed(3));
  await small.context.close();

  // ── Phone 390×844: the dock is reached by real wheel scrolling and keyboard ──
  const phone = await open({ width: 390, height: 844 });
  await shot(phone.page, "12-phone-top");
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("phone: no horizontal overflow", overflow <= 0, String(overflow));
  await phone.page.mouse.move(195, 700);
  for (let i = 0; i < 12; i += 1) await phone.page.mouse.wheel(0, 400);
  await phone.page.locator('.discussion-tab[data-tab="greenhouse"]').click();
  let reached = false;
  for (let i = 0; i < 60 && !reached; i += 1) {
    await phone.page.keyboard.press("Tab");
    reached = await phone.page.evaluate(() => document.activeElement?.id === "gh-run-toggle");
  }
  const target = await phone.page.locator("#gh-run-toggle").boundingBox();
  check("phone: Start the day reached by keyboard after wheel scrolling; target ≥ 44 px", reached && target && target.height >= 44, JSON.stringify(target));
  await phone.page.locator("#gh-run-toggle").scrollIntoViewIfNeeded();
  await shot(phone.page, "13-phone-dock", { note: "after wheel + Tab" });
  const small44 = await phone.page.evaluate(() => [...document.querySelectorAll("#gh-panel button, #gh-panel a, #gh-panel input[type=radio]")].filter((el) => el.offsetParent).map((el) => { const r = (el.closest("label") ?? el).getBoundingClientRect(); return { id: el.id || el.textContent?.trim().slice(0, 20), h: Math.round(r.height) }; }).filter((entry) => entry.h < 44));
  check("phone: every visible control in the greenhouse tab is at least 44 px tall", small44.length === 0, JSON.stringify(small44.slice(0, 8)));
  await phone.context.close();

  // ── PF ──
  const pf = await open({ width: 1440, height: 900 }, "PF");
  await pf.page.locator('.discussion-tab[data-tab="greenhouse"]').click();
  check("PF: no worked example", !(await pf.page.locator("#gh-worked").isVisible()));
  await shot(pf.page, "14-pf-panel", { element: "#gh-panel" });
  await pf.context.close();
} catch (error) {
  record.issues.push(`error: ${String(error?.message ?? error).split("\n").slice(0, 3).join(" ")}`);
  for (const [index, page] of pages.entries()) if (!page.isClosed()) await page.screenshot({ path: `${out}/error-${index}.png` }).catch(() => undefined);
} finally {
  record.ok = record.issues.length === 0 && record.checks.every((entry) => entry.ok);
  writeFileSync(`${out}/record.json`, `${JSON.stringify(record, null, 1)}\n`);
  console.log(JSON.stringify({ ok: record.ok, issues: record.issues, checks: record.checks.map((entry) => `${entry.ok ? "PASS" : "FAIL"} ${entry.name}`) }, null, 1));
  await browser.close();
  process.exit(record.ok ? 0 : 1);
}
