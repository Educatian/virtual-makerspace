// Visual QA for Episode 1 · Rescue Signal Workshop, one maker in solo mode (sender + solo check):
// overview with the panel, matched close-ups of the transmitter lamp lit/unlit on its snaps, the
// receiver's framing, a running transmission, the solo check after a working round, an open
// circuit (error) and its recovery, and a phone-width viewport. Records renderer counters per view.
//
//   npm run build && npx vite preview --port 4173 --strictPort
//   node scripts/qa-episode.mjs http://localhost:4173 ./qa-episode [quality]
//
// A fresh random local room per page (never 7K3M); peer mode, nothing leaves the browser.
// Software WebGL (SwiftShader): counters are draw calls/triangles, NOT real-device frame rates.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:4173";
const out = process.argv[3] ?? "qa-episode";
const quality = process.argv[4] ?? "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"],
});
const code = () => {
  const value = `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
  if (value === "7K3M") throw new Error("never the production room");
  return value;
};
const stats = {};
const issues = [];
const only = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",")) : null;
const wanted = (name) => !only || only.has(name);

/** The workshop and inspector are dock tabs: bring an element's tab (and the dock) to the front, as a person would. */
async function showTabOf(page, selector) {
  await page.evaluate((s) => {
    const element = document.querySelector(s);
    const panel = element?.closest(".discussion-panel");
    if (!panel || panel.classList.contains("is-active")) return;
    if (document.querySelector(".workspace-shell.is-dock-collapsed")) document.querySelector("#dock-reopen")?.click();
    document.querySelector(`.discussion-tab[data-tab="${panel.dataset.panel}"]`)?.click();
  }, selector);
}
const tap = async (page, selector) => {
  // Fail fast: the button must be present and enabled.
  await page.waitForFunction((s) => { const element = document.querySelector(s); return Boolean(element) && !element.disabled; }, selector, { timeout: 120_000, polling: 250 });
  await showTabOf(page, selector);
  const clicked = await page.evaluate((s) => { const element = document.querySelector(s); if (!element || element.disabled || element.getClientRects().length === 0) return false; element.click(); return true; }, selector);
  if (!clicked) throw new Error(`${selector} became unavailable (or not visible) before the click`);
};
const episode = (page) => page.evaluate(() => window.__vmQa.episode());
const panelText = async (page) => { await showTabOf(page, "#episode-body"); return page.evaluate(() => document.querySelector("#episode-body")?.innerText.replace(/\s+/g, " ") ?? ""); };
async function until(read, test, timeout = 180_000) {
  const started = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    value = await read();
  }
  if (!test(value)) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 200)}`);
  return value;
}

/** Mean brightness (0–255) of a PNG, measured in a separate lightweight page. */
const analysis = await (await browser.newContext()).newPage();
async function brightness(png) {
  return analysis.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let sum = 0;
    for (let index = 0; index < pixels.length; index += 4) sum += 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    return sum / (pixels.length / 4);
  }, png.toString("base64"));
}

async function open(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(240_000);
  page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
  // The static preview has no API: /api/me answering 404 is expected (peer mode). Any other
  // failed request, or any other console error, is an issue.
  page.on("response", (response) => { if (response.status() >= 400 && !response.url().endsWith("/api/me")) issues.push(`HTTP ${response.status()} ${response.url()}`); });
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) issues.push(`console: ${message.text()}`); });
  await page.goto(`${base}/?room=${code()}&name=QA&studio=snapino&episode=rescue-signal&qa=1${quality ? `&quality=${quality}` : ""}`);
  await page.waitForSelector("#enter-room", { state: "attached" });
  await tap(page, "#enter-room");
  await page.waitForFunction(() => Boolean(window.__vmQa?.episode), null, { timeout: 240_000 });
  await page.waitForFunction(() => !document.querySelector("#episode-panel")?.hidden, null, { timeout: 240_000 });
  await page.waitForTimeout(5000);
  return page;
}
async function shot(page, name, view) {
  if (!wanted(name)) return;
  if (view) await page.evaluate((v) => window.__vmQa.view(v[0], v[1]), view);
  await page.waitForTimeout(2500);
  stats[name] = await page.evaluate(() => window.__vmQa.stats());
  await page.screenshot({ path: `${out}/${name}.png` });
  writeFileSync(`${out}/stats.json`, JSON.stringify(stats, null, 2));
  if (only && [...only].every((wantedName) => stats[wantedName])) {
    console.log(JSON.stringify(stats, null, 1));
    await browser.close();
    process.exit(0);
  }
}
async function design(page) {
  await tap(page, '[data-episode="claim-role"][data-role="sender"]');
  await until(() => episode(page), (state) => state.role === "sender");
  await tap(page, "#load-field-test");
  await until(() => page.evaluate(() => window.__vmQa.bench().parts["sno-l1"]?.sockets), Boolean);
  await tap(page, '[data-episode="mission"][data-mission="ridge"]');
  await until(() => episode(page), (state) => state.state?.mission === "ridge");
  for (const [index, word] of ["INJURED", "NORTH"].entries()) {
    await tap(page, `[data-episode="intent-add"][data-word="${word}"]`);
    await until(() => episode(page), (state) => state.state?.intent.length === index + 1);
  }
  await tap(page, '[data-episode="write-blocks"]');
  await page.waitForTimeout(400);
}
async function transmitAndWait(page, n, during) {
  await tap(page, '[data-episode="transmit"]');
  await until(() => episode(page), (state) => state.state?.round?.n === n);
  if (during) await during();
  await until(() => episode(page), (state) => state.elapsed >= state.state.round.durationMs + 200);
  await until(() => panelText(page), (text) => /Solo check/.test(text));
}
async function closeRound(page) {
  await tap(page, '[data-episode="close-round"]');
  await until(() => episode(page), (state) => state.state?.round === null);
}

// ── Desktop 1440×900 ─────────────────────────────────────────────────────────────────────────
let page = await open({ width: 1440, height: 900 });
await design(page);
await shot(page, "e01-overview-design");

// Matched close-ups: identical camera, D5 HIGH vs LOW (same pins the transmission drives).
const lamp = await page.evaluate(() => window.__vmQa.partPosition("sno-l1"));
const [x, y, z] = lamp;
const close = [[x + 1.15, y + 1.25, z + 1.6], [x, y + 0.22, z]];
const low = [[x + 1.45, y + 0.42, z + 0.75], [x, y + 0.14, z]];
// Close-ups are about the artifact: fold the panel away (the same toggle a learner uses).
await tap(page, "#dock-collapse");
await page.evaluate(() => window.__vmQa.pins({ D5: true }));
await shot(page, "e02-lamp-lit-close", close);
// Pixel check (separate from the scene's own state): the bulb crop, lit vs unlit, same camera.
const bulb = async () => {
  const rect = await page.evaluate(() => window.__vmQa.partScreenRect("sno-l1"));
  const png = await page.screenshot({ clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(4, Math.min(rect.width, 600)), height: Math.max(4, Math.min(rect.height, 600)) } });
  return brightness(png);
};
const litBrightness = await bulb();
await page.evaluate(() => window.__vmQa.pins({ D5: false }));
await shot(page, "e03-lamp-unlit-close", close);
const darkBrightness = await bulb();
stats["e02-lamp-lit-close"].bulbBrightness = Number(litBrightness.toFixed(1));
stats["e03-lamp-unlit-close"].bulbBrightness = Number(darkBrightness.toFixed(1));
if (!(litBrightness - darkBrightness > 8)) issues.push(`pixels: lit bulb ${litBrightness.toFixed(1)} vs unlit ${darkBrightness.toFixed(1)}`);
await shot(page, "e04-lamp-snaps-low", low);
await tap(page, "#dock-reopen");
await page.evaluate(() => { window.__vmQa.pins({ D5: true }); window.__vmQa.receiverView(); });
await shot(page, "e05-receiver-view-lit");
await page.evaluate(() => window.__vmQa.pins({ D5: false }));

// A running transmission (panel + live lamp). Software rendering takes seconds per frame, so this
// round is a deliberately long single flash (110 s, under the 120 s cap; not a protocol word):
// the shot is taken while it is running and lit, then the sender stops it (the Stop path).
await page.evaluate(() => window.__vmQa.receiverView());
await page.evaluate(() => window.__vmQa.editDraft([{ op: "write", pin: "D5", value: true }, ...Array.from({ length: 22 }, () => ({ op: "wait", ms: 5000 })), { op: "write", pin: "D5", value: false }]));
await tap(page, '[data-episode="transmit"]');
await until(() => episode(page), (state) => state.state?.round?.n === 1);
await until(() => page.evaluate(() => window.__vmQa.lights()), (lights) => lights.includes("sno-l1"), 60_000);
stats["e06-transmitting"] = await page.evaluate(() => window.__vmQa.stats());
await page.screenshot({ path: `${out}/e06-transmitting.png` });
const live = await episode(page);
if (!(live.elapsed < live.state.round.durationMs) || !/Stop/.test(await panelText(page))) issues.push(`e06 was not captured during the transmission (${Math.round(live.elapsed)} of ${live.state.round.durationMs} ms)`);
// Under software rendering the steps above can take a minute or more; if the 110 s flash has
// already ended, there is nothing left to stop (recorded in stats.json either way).
const stillRunning = await episode(page);
if (stillRunning.state.round && !stillRunning.state.round.stopReason && stillRunning.elapsed < stillRunning.state.round.durationMs - 3000) await tap(page, '[data-episode="stop"]');
const halted = await until(() => episode(page), (state) => state.state?.round?.stopReason === "stopped" || state.elapsed >= state.state.round.durationMs);
stats["e06-transmitting"].endedBy = halted.state.round.stopReason === "stopped" ? `Stop at ${Math.round(halted.state.round.stoppedAtMs)} ms` : "ran to its end before Stop";
stats["e06-transmitting"].capturedAtMs = Math.round(live.elapsed);
await until(() => page.evaluate(() => window.__vmQa.lights()), (lights) => !lights.includes("sno-l1"), 60_000);
await closeRound(page);

// A working round: the DI helper's blocks for INJURED · NORTH, then the solo check.
await tap(page, '[data-episode="write-blocks"]');
await page.waitForTimeout(400);
await transmitAndWait(page, 2);
await shot(page, "e07-solo-check-delivered");
const delivered = await panelText(page);
if (!/INJURED/.test(delivered) || !/NORTH/.test(delivered) || !/No problems found/.test(delivered)) issues.push(`solo check after a working round: ${delivered.slice(0, 300)}`);
await closeRound(page);

// Error: the return wire off the base (open circuit) — imported through the real file path.
const bench = await page.evaluate(() => window.__vmQa.bench());
const parts = Object.entries(bench.parts).map(([id, part]) => ({ id, sockets: id === "sno-w2a" ? null : part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
await page.setInputFiles("#project-file-input", { name: "open.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "virtual-makerspace.project", version: 1, solver: "x", studio: "snapino", savedAt: new Date().toISOString(), parts })) });
await page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open, null, { timeout: 60_000 });
await tap(page, "#confirm-ok");
await until(() => page.evaluate(() => window.__vmQa.bench().parts["sno-w2a"]?.sockets), (sockets) => !sockets);
await tap(page, '[data-episode="write-blocks"]');
await page.waitForTimeout(400);
await transmitAndWait(page, 3);
await shot(page, "e08-open-circuit-solo-check");
const open8 = await panelText(page);
if (!/No light at all/.test(open8)) issues.push(`open circuit solo check: ${open8.slice(0, 300)}`);
await closeRound(page);

// Recovery: rebuild the loop, same message, transmit again.
await tap(page, "#load-field-test");
await until(() => page.evaluate(() => window.__vmQa.bench().parts["sno-w2a"]?.sockets), Boolean);
await transmitAndWait(page, 4);
await shot(page, "e09-recovered-solo-check");
if (!/No problems found/.test(await panelText(page))) issues.push("recovery round still reports problems");
await closeRound(page);

// Faults from the parent review, through the real import path:
const importParts = async (name, parts) => {
  await page.setInputFiles("#project-file-input", { name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "virtual-makerspace.project", version: 1, solver: "x", studio: "snapino", savedAt: new Date().toISOString(), parts })) });
  await page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open, null, { timeout: 60_000 });
  await tap(page, "#confirm-ok");
};
const pads = { D5: 12, "5V": 14, GND: 15 };
// (a) a snap wire from D5 straight to GND: the pin is shorted and the lamp is bypassed.
await importParts("pin-short.json", [
  { id: "sno-l1", sockets: [pads.D5, 30] }, { id: "sno-w3", sockets: [30, 33] }, { id: "sno-w2a", sockets: [33, pads.GND] }, { id: "sno-w4a", sockets: [pads.D5, pads.GND] },
]);
await until(() => page.evaluate(() => window.__vmQa.bench().parts["sno-w4a"]?.sockets), Boolean);
await transmitAndWait(page, 5);
await shot(page, "e12-pin-short-bypassed-solo-check");
const short12 = await panelText(page);
if (!/No light at all/.test(short12) || !/D5 was set HIGH while its pad was wired straight to GND/.test(short12) || !/same connected net/.test(short12)) issues.push(`pin-short solo check: ${short12.slice(0, 400)}`);
const lit12 = await page.evaluate(() => window.__vmQa.lights());
if (lit12.length) issues.push(`pin short: the 3D bench shows ${lit12} running`);
await closeRound(page);
// (b) the lamp from 5V to GND: always on, and still on after the transmission.
await importParts("five-volt.json", [
  { id: "sno-l1", sockets: [pads["5V"], 30] }, { id: "sno-w3", sockets: [30, 33] }, { id: "sno-w2a", sockets: [33, pads.GND] }, { id: "sno-w4a", sockets: null },
]);
await until(() => page.evaluate(() => window.__vmQa.bench().parts["sno-l1"]?.sockets?.[0]), (socket) => socket === pads["5V"]);
await transmitAndWait(page, 6);
await shot(page, "e13-5v-still-lit-solo-check");
const five13 = await panelText(page);
if (!/still on when the transmission ended/.test(five13) || /switched it off/.test(five13)) issues.push(`5V solo check: ${five13.slice(0, 400)}`);
if (!(await page.evaluate(() => window.__vmQa.lights())).includes("sno-l1")) issues.push("5V lamp: the 3D bench shows it dark after the transmission");
if (!(await page.evaluate(() => Boolean(document.querySelector(".strip-flash.is-continuing"))))) issues.push("5V lamp: the strip does not mark the light as continuing");
await page.context().close();

// ── Phone 390×844 ────────────────────────────────────────────────────────────────────────────
page = await open({ width: 390, height: 844 });
await design(page);
await shot(page, "e10-phone-design");
await tap(page, "#episode-toggle");
await page.evaluate(() => window.__vmQa.receiverView());
await shot(page, "e11-phone-collapsed-3d");
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (overflow > 0) issues.push(`phone: horizontal overflow ${overflow}px`);
await page.context().close();

writeFileSync(`${out}/stats.json`, JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 1));
console.log(issues.length ? issues.join("\n") : "no issues");
await browser.close();
if (issues.length) process.exitCode = 1;
