// Before/after renders for the reference-quality upgrade of the Snapino bench, plus the new
// layouts and the PF/DI diagram rule. Static build in a same-device (peer) room; developer
// environment (headless Chromium, SwiftShader). Draw calls and triangles per shot; no frame rates.
//
//   node scripts/qa-reference.mjs <base-url> <out-dir> <before|after>
//
// "Same camera" shots place identical parts locally (`__vmQa.place`, no room traffic) and set the
// camera explicitly (`__vmQa.view`), so the two builds are compared at one viewpoint. Composition
// shots use each build's own default framing and layout on purpose.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base = "http://localhost:4173", out = "qa-reference", build = "after"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
const report = { build, base, shots: {}, checks: [] };
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const LAYOUT = { "sno-l1": [12, 30], "sno-w3": [30, 33], "sno-w2a": [33, 15], "sno-s1": [14, 32], "sno-w4a": [32, 28], "sno-w2b": [28, 10] };
const BOARD_X = -0.75;

async function open(viewport, { episode = false, condition = "DI" } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await instrument(context);
  const page = await context.newPage();
  page.setDefaultTimeout(600_000);
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  const room = `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
  await page.goto(`${base}/?room=${room}&quality=low&qa&condition=${condition}`);
  await page.waitForSelector("#enter-room", { state: "attached" });
  await page.getByRole("radio", { name: /Snapino Bridge/ }).click();
  if (episode) await page.evaluate(() => { const box = document.querySelector("#lobby-episode"); if (box && !box.checked) box.click(); });
  await page.locator("#enter-room").click();
  await page.waitForFunction(() => Boolean(window.__vmQa?.place), null, { polling: 500 });
  if (episode) await page.waitForFunction(() => window.__vmQa.episode?.().state?.active === true, null, { polling: 500 });
  page.e2eLabel = `${build}-${viewport.width}`;
  return page;
}
async function place(page, layout) {
  await page.evaluate((entries) => { for (const [id, [a, b]] of Object.entries(entries)) window.__vmQa.place(id, a, b); }, layout);
}
async function shot(page, name, note = "") {
  await settled(page, name, { budgetMs: 900_000 });
  const stats = await page.evaluate(() => window.__vmQa.stats());
  await page.screenshot({ path: `${out}/${name}.png` });
  report.shots[name] = { ...stats, note };
  console.log(`  shot ${name}: ${stats.calls} calls, ${stats.triangles} triangles`);
}
const has = (page, hook) => page.evaluate((name) => typeof window.__vmQa?.[name] === "function", hook);

try {
  // ── Same camera, identical parts (both builds) ──
  const page = await open({ width: 1440, height: 900 });
  await place(page, LAYOUT);
  await page.evaluate(() => window.__vmQa.pins({ D5: true }));
  // Collapse the dock in both builds so the canvas is identical in extent.
  await page.evaluate(() => document.querySelector("#dock-collapse")?.click());
  // The after build's camera-view toolbar is chrome, not bench detail: hidden for these shots.
  await page.evaluate(() => { const bar = document.querySelector("#view-presets"); if (bar) bar.hidden = true; });
  await page.evaluate(() => window.__vmQa.view([7.2, 5.8, 8.6], [0, 0.55, -0.1]));
  await shot(page, "same-01-overview", "camera (7.2, 5.8, 8.6) → (0, 0.55, −0.1): the old default");
  await page.evaluate((x) => window.__vmQa.view([x - 0.2, 2.2, 3.1], [x - 0.6, 0.3, 0.3]), BOARD_X);
  await shot(page, "same-02-studs-and-lamp", "close three-quarter view over rows C–F");
  await page.evaluate((x) => window.__vmQa.view([x - 2.6, 0.95, 2.75], [x - 1.6, 0.27, 1.3]), BOARD_X);
  await shot(page, "same-03-grid-labels-low", "low angle on the row letters and column numbers");
  await page.evaluate((x) => window.__vmQa.view([x + 0.2, 4.6, 0.95], [x + 0.2, 0.26, -0.05]), BOARD_X);
  await shot(page, "same-04-top", "near-top view of the stud grid");
  await page.context().close();

  // ── Each build's own default composition, workshop open (DI) ──
  const composition = await open({ width: 1440, height: 900 }, { episode: true });
  await place(composition, LAYOUT);
  if (await has(composition, "preset")) await composition.evaluate(() => window.__vmQa.preset("bench"));
  else await composition.evaluate(() => document.querySelector("#reset-view")?.click());
  await shot(composition, "composition-1440-workshop", "default framing and panels, workshop open");
  if (await has(composition, "benchRect")) {
    const rect = await composition.evaluate(() => window.__vmQa.benchRect());
    report.composition = { after: rect };
    // The same metric for the old default camera, measured in this build's layout.
    await composition.evaluate(() => window.__vmQa.view([7.2, 5.8, 8.6], [0, 0.55, -0.1]));
    await settled(composition, "old camera");
    report.composition.oldCameraInThisLayout = await composition.evaluate(() => window.__vmQa.benchRect());
    check("bench view fills more of the free view than the old default camera", rect.bench.width / rect.free.width > report.composition.oldCameraInThisLayout.bench.width / report.composition.oldCameraInThisLayout.free.width,
      `${Math.round((100 * rect.bench.width) / rect.free.width)}% vs ${Math.round((100 * report.composition.oldCameraInThisLayout.bench.width) / report.composition.oldCameraInThisLayout.free.width)}% of the free width`);
  }
  await composition.context().close();

  if (build === "after") {
    // ── Inspector with a selection, three widths ──
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      const p = await open(viewport);
      await place(p, LAYOUT);
      await p.evaluate(() => window.__vmQa.preset("bench"));
      await settled(p, "placed");
      const rect = await p.evaluate(() => window.__vmQa.partScreenRect("sno-l1"));
      if (viewport.width > 600) {
        await p.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      } else {
        await p.evaluate(() => document.querySelector('.discussion-tab[data-tab="inspect"]')?.click());
        await p.evaluate(() => document.querySelector('#si-diagram [data-part="sno-l1"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      }
      await p.waitForFunction(() => document.querySelector("#si-part-title")?.textContent === "Lamp L1", null, { polling: 500 });
      const layout = await p.evaluate(() => {
        const dock = document.querySelector("#discussion-dock").getBoundingClientRect();
        const presets = [...document.querySelectorAll("#view-presets button")].map((button) => { const r = button.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
        const targets = [...document.querySelectorAll("#snapino-inspector button, .discussion-tab:not([hidden])")].map((element) => { const r = element.getBoundingClientRect(); return Math.min(r.width, r.height); }).filter((size) => size > 0);
        return { dock: { left: Math.round(dock.left), width: Math.round(dock.width) }, presets, smallest: Math.min(...targets), overflow: document.documentElement.scrollWidth > window.innerWidth, chatTab: Boolean(document.querySelector('.discussion-tab[data-tab="chat"]:not([hidden])')) };
      });
      check(`${viewport.width}px: no horizontal page scroll; chat tab reachable`, !layout.overflow && layout.chatTab, JSON.stringify(layout.dock));
      check(`${viewport.width}px: inspector and dock-tab targets ≥ 44 px, view buttons ≥ 44 px`, layout.smallest >= 44 && layout.presets.every(([w, h]) => w >= 44 && h >= 44), `smallest ${layout.smallest} px`);
      await shot(p, `after-inspector-${viewport.width}`, "lamp selected: rung, nets and stud rings");
      if (viewport.width === 1440) {
        await p.evaluate(() => window.__vmQa.preset("top"));
        await shot(p, "after-top-preset-1440", "Top view preset, lamp still selected");
        await p.evaluate(() => document.querySelector('#si-part [data-tab="behavior"]')?.click());
        await p.locator("#si-part").screenshot({ path: `${out}/after-inspector-behaviour-card.png` });
        await p.evaluate(() => document.querySelector('#si-part [data-tab="pinout"]')?.click());
        await p.locator("#si-part").screenshot({ path: `${out}/after-inspector-pinout-card.png` });
      }
      check(`${viewport.width}px: no page errors`, p.errors.length === 0, p.errors.join(" | "));
      await p.context().close();
    }

    // ── PF withholds fault notes; DI shows them; both draw the wiring as built ──
    for (const condition of ["PF", "DI"]) {
      const p = await open({ width: 1280, height: 720 }, { episode: true, condition });
      // L1 bypassed: a snap wire across both of its studs.
      await place(p, { "sno-l1": [12, 30], "sno-w2b": [12, 30], "sno-w3": [30, 33], "sno-w2a": [33, 15] });
      await p.evaluate(() => document.querySelector('.discussion-tab[data-tab="inspect"]')?.click());
      await settled(p, `${condition} inspector`);
      const state = await p.evaluate(() => ({
        loop: document.querySelector('#si-diagram [data-part="sno-l1"] .dg-lead')?.getAttribute("d")?.includes(" C ") ?? false,
        flags: document.querySelectorAll("#si-diagram .dg-flag").length,
        faults: [...document.querySelectorAll("#si-faults [data-fault]")].map((item) => item.dataset.fault),
        withheld: document.querySelector("#si-faults .si-withheld")?.textContent ?? null,
      }));
      check(`${condition}: the bypassed lamp is drawn as built (a loop on one net)`, state.loop);
      if (condition === "PF") check("PF before any compared round: fault notes withheld, with the reason shown", state.flags === 0 && state.faults.length === 0 && Boolean(state.withheld), JSON.stringify(state));
      else check("DI: the bypass is flagged and explained", state.flags > 0 && state.faults.includes("bypassed"), JSON.stringify(state));
      await shot(p, `after-diagram-${condition}-bypassed`, `${condition} condition, L1 bypassed by W2b`);
      await p.context().close();
    }
  }
} catch (error) {
  console.error(error);
  check("ran to completion", false, error.message.split("\n")[0]);
} finally {
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
  const failed = report.checks.filter((entry) => !entry.ok).length;
  console.log(`${report.checks.length - failed}/${report.checks.length} checks · ${Object.keys(report.shots).length} shots → ${out}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
}
