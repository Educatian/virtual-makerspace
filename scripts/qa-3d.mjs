// Visual QA for the 3D bench: overview + close-ups of the breadboard, LED/resistor, cable ends,
// the Snapino PCB, and a laptop viewport. Records renderer counters for each view.
//
//   node scripts/qa-3d.mjs http://localhost:4173 ./qa-3d [quality]
//
// Uses the ?qa hook (window.__vmQa) to place the camera and seat parts locally; nothing is
// sent to a real room (each run uses a fresh random room code).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:4173";
const out = process.argv[3] ?? "qa-3d";
const quality = process.argv[4] ?? "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"],
});
const code = () => `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
const stats = {};
/** Optional QA_ONLY=1-overview,11-led-powered limits the run to those shots (fast iteration). */
const only = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",")) : null;
const wanted = (...names) => !only || names.some((name) => only.has(name));
const issues = [];

async function open(studio, viewport) {
  const page = await (await browser.newContext({ viewport, deviceScaleFactor: 1 })).newPage();
  page.setDefaultTimeout(180_000);
  page.on("pageerror", (error) => issues.push(`pageerror ${studio}: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") issues.push(`console ${studio}: ${message.text()}`); });
  await page.goto(`${base}/?room=${code()}&name=QA&studio=${studio}&qa=1${quality ? `&quality=${quality}` : ""}`);
  await page.waitForSelector("#enter-room");
  await page.evaluate(() => document.querySelector("#enter-room").click());
  await page.waitForSelector("#viewport-heading");
  await page.waitForFunction(() => window.__vmQa);
  // Let the GLB models stream in and the first shadow pass settle.
  await page.waitForTimeout(6000);
  // Collapse the discussion dock so close-ups show the bench, not the chat.
  return page;
}
async function shot(page, name, view) {
  if (!wanted(name)) return;
  if (view) await page.evaluate((v) => window.__vmQa.view(v[0], v[1]), view);
  await page.waitForTimeout(2200);
  stats[name] = await page.evaluate(() => window.__vmQa.stats());
  await page.screenshot({ path: `${out}/${name}.png` });
}
const collapseDock = (page) => page.evaluate(() => document.querySelector("#dock-collapse")?.click());

let page = await open("circuit", { width: 1440, height: 900 });
// Identical placements in every build (BEFORE/AFTER): the red LED is in a working 1 kΩ loop
// (battery + at r1c5, − at r1c7; LED anode r3c5 → cathode r3c4 → resistor → −); the green LED
// sits in unconnected strips (unpowered) for a side-by-side comparison.
const seat = () => page.evaluate(() => {
  window.__vmQa.place("battery-9v", 21, 23);
  window.__vmQa.place("resistor-1k", 36, 39);
  window.__vmQa.place("led-red", 53, 52);
  window.__vmQa.place("wire-blue", 7 * 16 + 3, 7 * 16 + 7);
  window.__vmQa.place("wire-yellow", 6 * 16 + 9, 6 * 16 + 13);
  window.__vmQa.place("wire-red", 0 * 16 + 10, 1 * 16 + 12);
  window.__vmQa.place("led-green", 8 * 16 + 9, 8 * 16 + 10);
});
await seat();
await shot(page, "1-overview");
await collapseDock(page);
// Close-ups use the same framing as the BEFORE build: fold the circuit meter (if any) away.
await page.evaluate(() => {
  const toggle = document.querySelector("#inspector-toggle");
  if (toggle?.getAttribute("aria-expanded") === "true") toggle.click();
});
await shot(page, "2-overview-collapsed");
await shot(page, "3-breadboard-close", [[-0.15, 1.75, 2.35], [-0.75, 0.3, 0.75]]);
await shot(page, "4-led-resistor-close", [[-1.0, 1.45, 0.35], [-1.3, 0.38, -0.95]]);
await shot(page, "5-cable-ends-close", [[-0.4, 1.25, 1.75], [-0.95, 0.35, 0.45]]);
await shot(page, "6-battery-close", [[-0.6, 1.6, 0.4], [-1.27, 0.45, -1.2]]);
await shot(page, "7-rails-close", [[1.0, 1.1, 2.6], [0.6, 0.3, 1.6]]);
// LED powered (red, in the loop) vs. unpowered (green, unconnected), same framing distance.
await shot(page, "11-led-powered", [[-1.05, 1.15, 0.05], [-1.5, 0.55, -0.66]]);
await shot(page, "12-led-unpowered", [[0.18, 1.15, 1.37], [-0.27, 0.55, 0.66]]);
// Occupied sockets: lead and cable tips seen low and close, to judge alignment with the holes.
await shot(page, "13-occupied-sockets", [[-1.2, 0.75, 0.2], [-1.45, 0.32, -0.75]]);
await shot(page, "14-cable-tip-macro", [[-1.75, 0.62, 1.05], [-1.83, 0.32, 0.42]]);
// The circuit meter with a part selected (AFTER builds only): the 1 kΩ resistor set to 220 Ω.
if (wanted("15-meter-editor") && (await page.evaluate(() => Boolean(document.querySelector("#inspector-toggle"))))) {
  await page.evaluate(() => {
    window.__vmQa.view([5.2, 5.6, 6.4], [-0.9, 0.2, -0.4]);
    const toggle = document.querySelector("#inspector-toggle");
    if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
    document.querySelector('.component-card[data-component-id="resistor-1k"]')?.click();
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('.value-editor[data-part="resistor-1k"] .preset[data-value="220"]')?.click());
  await shot(page, "15-meter-editor");
}
await page.context().close();

if (wanted("8-snapino-overview", "9-pcb-close")) {
page = await open("snapino", { width: 1440, height: 900 });
await collapseDock(page);
await shot(page, "8-snapino-overview");
await shot(page, "9-pcb-close", [[-0.55, 2.0, 0.6], [-0.95, 0.35, -1.35]]);
await page.context().close();
}

if (wanted("10-laptop")) {
page = await open("circuit", { width: 1180, height: 760 });
await page.evaluate(() => {
  window.__vmQa.place("battery-9v", 21, 23);
  window.__vmQa.place("resistor-1k", 36, 39);
  window.__vmQa.place("led-red", 53, 52);
});
await shot(page, "10-laptop");
await page.context().close();
}

writeFileSync(`${out}/stats.json`, JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 1));
console.log(issues.length ? issues.join("\n") : "no issues");
await browser.close();
