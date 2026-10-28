// Sound Flow Studio (Episode 2) render evidence, one reproducible capture run against a build of
// the app (peer mode: no server needed). Headless Chromium + SwiftShader: renderer counters are
// draw calls and triangles of the frame shown, never frame rates.
//
//   npm run build && (cd dist && python3 -m http.server 4173 --bind 127.0.0.1)
//   node scripts/qa-sound.mjs http://127.0.0.1:4173 <out-dir> <app-sha>
//
// Shots (fixed cameras, so later runs can be compared shot for shot):
//   01 overview (cables on the mat) 1440×900 · 02 overview 1280×720 · 03 plan · 04 listener view
//   05 jack close-up · 06 knob close-up · 07 speaker close-up (all three patched)
//   08 wrong patch: a loop and a loose end, with the Inspector diagram and connection list
//   09 working: the brief met, with the signal display (scope, levels, harmonics) and live audio
//   10 recovery: the same desk after the fix · 11 phone 390×844 top, 12 phone dock reached by
//   wheel/keyboard · 13 PF Studio panel (no worked example)
// Composition: the overview's projected desk width / the free width between the panels (≥ 0.6).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base = "http://127.0.0.1:4173", out = "qa-sound", appSha = "unknown"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
const room = () => `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
const record = { app: appSha, base, shots: [], checks: [], issues: [] };
const check = (name, ok, detail = "") => {
  record.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function open(viewport, condition = "DI") {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await instrument(context);
  const page = await context.newPage();
  page.setDefaultTimeout(600_000);
  page.on("pageerror", (error) => record.issues.push(`pageerror: ${error.message}`));
  const code = room();
  await page.goto(`${base}/?room=${code}&name=QA&studio=sound&qa=1&condition=${condition}`);
  await page.click("#enter-room");
  await page.waitForFunction(() => Boolean(window.__vmQa?.sound), null, { timeout: 300_000 });
  await settled(page, `${condition} ${viewport.width} entered`);
  return { context, page, code };
}
async function shot(page, name, { element = null, note = "" } = {}) {
  await settled(page, name);
  const path = `${out}/${name}.png`;
  if (element) await page.locator(element).screenshot({ path });
  else await page.screenshot({ path });
  const stats = await page.evaluate(() => window.__vmQa.stats());
  const camera = await page.evaluate(() => window.__vmQa.camera());
  const entry = { name, file: `${name}.png`, viewport: page.viewportSize(), element, calls: stats?.calls ?? null, triangles: stats?.triangles ?? null, camera, note };
  record.shots.push(entry);
  console.log(`shot ${name}: ${entry.calls} calls, ${entry.triangles} triangles`);
}
async function patch(page, cables) {
  for (const [id, a, b] of cables) {
    if (a !== null) await page.evaluate(({ id, a }) => window.__vmQa.dropEnd(id, 0, a), { id, a });
    if (b !== null) await page.evaluate(({ id, b }) => window.__vmQa.dropEnd(id, 1, b), { id, b });
  }
}
async function setKnob(page, id, selector, value) {
  await page.locator(`.component-card[data-component-id="${id}"]`).click();
  await page.locator('.discussion-tab[data-tab="inspect"]').click();
  await page.locator(selector).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(String(value));
  await page.keyboard.press("Enter");
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
  check("1440×900 overview: the desk fills ≥ 60 % of the free width", fill1440 >= 0.6, fill1440.toFixed(3));
  await page.keyboard.press("2");
  await shot(page, "03-plan", { note: "key 2" });
  await page.keyboard.press("3");
  await shot(page, "04-listener", { note: "key 3" });
  await page.keyboard.press("1");
  await patch(page, [["snd-cable-a", 0, 1], ["snd-cable-b", 2, 3], ["snd-cable-c", 4, 5]]);
  for (const [name, position, target] of [
    ["05-closeup-jacks", [-1.4, 1.5, 1.85], [-1.4, 0.62, 0.62]],
    ["06-closeup-knob", [-3.4, 1.55, 0.6], [-3.7, 0.65, -0.45]],
    ["07-closeup-speaker", [1.6, 1.7, 1.2], [1.2, 0.6, -0.3]],
  ]) {
    await page.evaluate(({ position, target }) => window.__vmQa.view(position, target), { position, target });
    await shot(page, name);
  }
  // Wrong patch: the Filter and Drive patched into each other (a loop) and the red cable loose.
  await page.evaluate(() => window.__vmQa.preset("overview"));
  await page.evaluate(() => window.__vmQa.dropEnd("snd-cable-c", 0, 1)).catch(() => undefined);
  await page.locator("#project-menu-button").click();
  await page.locator("#reset-bench").click();
  await page.locator("#confirm-ok").click();
  await page.waitForFunction(() => window.__vmQa.sound().model.state.cables["snd-cable-a"][0] === null);
  await patch(page, [["snd-cable-b", 2, 3], ["snd-cable-c", 4, 1], ["snd-cable-a", 0, null]]);
  await page.locator(".component-card[data-component-id=\"snd-filter\"]").click();
  await page.locator('.discussion-tab[data-tab="inspect"]').click();
  const wrong = await page.evaluate(() => window.__vmQa.sound());
  check("wrong patch: the loop and the loose end are drawn and diagnosed; nothing reaches the Speaker", wrong.model.faults.includes("loop") && wrong.model.faults.includes("loose-end") && !wrong.model.reaches && wrong.model.edges.some((edge) => edge.status === "loop"), JSON.stringify(wrong.model.faults));
  await shot(page, "08-wrong-patch");
  await shot(page, "08b-wrong-patch-inspector", { element: "#sound-inspector" });
  // Fix it, set the knobs by keyboard, test, explain.
  await page.locator("#project-menu-button").click();
  await page.locator("#reset-bench").click();
  await page.locator("#confirm-ok").click();
  await page.waitForFunction(() => window.__vmQa.sound().model.state.cables["snd-cable-b"][0] === null);
  await patch(page, [["snd-cable-a", 0, 1], ["snd-cable-b", 2, 3], ["snd-cable-c", 4, 5]]);
  await setKnob(page, "snd-source", "#sdi-hz", 220);
  await page.locator('input[name="sdi-wave"][value="sawtooth"]').check();
  await page.locator('[data-apply="snd-source"]').click();
  await page.waitForFunction(() => window.__vmQa.sound().model.state.source.wave === "sawtooth");
  await setKnob(page, "snd-filter", "#sdi-cutoff", 300);
  await setKnob(page, "snd-drive", "#sdi-gain", "1.70");
  await page.waitForFunction(() => window.__vmQa.sound().model.state.drive.gain === 1.7);
  await page.locator('.discussion-tab[data-tab="sound"]').click();
  await page.locator('#ss-predictions input[value="meets"]').check();
  await page.locator("#ss-test").click();
  await page.waitForFunction(() => window.__vmQa.sound().panel.tested);
  await page.locator("#ss-audio-start").click();
  await page.waitForFunction(() => window.__vmQa.sound().panel.audio === "running", null, { timeout: 60_000 }).catch(() => record.issues.push("audio did not reach running"));
  await page.waitForTimeout(1500);
  const working = await page.evaluate(() => window.__vmQa.sound());
  check("working: the brief is met, the display shows a rendered, unclipped tone at the Speaker", working.panel.met === true && working.panel.display?.reaches === true && working.panel.display?.clipped === false && working.panel.display?.source === "rendered", JSON.stringify({ met: working.panel.met, display: working.panel.display, audio: working.panel.audio }));
  await shot(page, "09-working");
  await shot(page, "09b-signal-display", { element: "#ss-scope >> xpath=ancestor::section[1]" });
  await shot(page, "09c-test-result", { element: "#ss-result" });
  await page.locator("#ss-explain").fill("The 300 Hz low-pass keeps 220 Hz and cuts 660 Hz; ×1.7 brings the level back without clipping.");
  await page.locator("#ss-explain-save").click();
  await page.locator("#ss-audio-mute").click();
  await page.evaluate(() => window.__vmQa.preset("overview"));
  await shot(page, "10-recovered");
  await page.context().close();

  // ── 1280×720 composition ──
  const small = await open({ width: 1280, height: 720 });
  await small.page.evaluate(() => window.__vmQa.preset("overview"));
  await shot(small.page, "02-overview-1280");
  const fill1280 = await fill(small.page);
  check("1280×720 overview: the desk fills ≥ 60 % of the free width", fill1280 >= 0.6, fill1280.toFixed(3));
  await small.context.close();

  // ── Phone 390×844: the dock is reached by real wheel scrolling and keyboard ──
  const phone = await open({ width: 390, height: 844 });
  await shot(phone.page, "11-phone-top");
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("phone: no horizontal overflow", overflow <= 0, String(overflow));
  await phone.page.mouse.move(195, 700);
  for (let i = 0; i < 12; i += 1) await phone.page.mouse.wheel(0, 400);
  await phone.page.locator('.discussion-tab[data-tab="sound"]').click();
  await phone.page.locator("#ss-audio-start").scrollIntoViewIfNeeded();
  let reached = false;
  for (let i = 0; i < 40 && !reached; i += 1) {
    await phone.page.keyboard.press("Tab");
    reached = await phone.page.evaluate(() => document.activeElement?.id === "ss-test");
  }
  const target = await phone.page.locator("#ss-test").boundingBox();
  check("phone: Test patch reached by keyboard after wheel scrolling; target ≥ 44 px", reached && target && target.height >= 44, JSON.stringify(target));
  await shot(phone.page, "12-phone-dock", { note: "after wheel + Tab" });
  await phone.context.close();

  // ── PF ──
  const pf = await open({ width: 1440, height: 900 }, "PF");
  await pf.page.locator('.discussion-tab[data-tab="sound"]').click();
  check("PF: no worked example", !(await pf.page.locator("#ss-worked").isVisible()));
  await shot(pf.page, "13-pf-studio", { element: "#sound-studio" });
  await pf.context.close();
} catch (error) {
  record.issues.push(`error: ${String(error?.message ?? error).split("\n")[0]}`);
} finally {
  record.ok = record.issues.length === 0 && record.checks.every((entry) => entry.ok);
  writeFileSync(`${out}/record.json`, `${JSON.stringify(record, null, 1)}\n`);
  console.log(JSON.stringify({ ok: record.ok, issues: record.issues, checks: record.checks.map((entry) => `${entry.ok ? "PASS" : "FAIL"} ${entry.name}`) }, null, 1));
  await browser.close();
  process.exit(record.ok ? 0 : 1);
}
