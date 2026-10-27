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
  // A first read can come before the detailed models replace the stand-ins: settle twice.
  await settled(page, `${name} (again)`, { budgetMs: 900_000 });
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
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
      const p = await open(viewport);
      await place(p, LAYOUT);
      await p.evaluate(() => window.__vmQa.preset("bench"));
      await settled(p, "placed");
      const rect = await p.evaluate(() => window.__vmQa.partScreenRect("sno-l1"));
      await p.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await p.waitForFunction(() => document.querySelector("#si-part-title")?.textContent === "Lamp L1", null, { polling: 500 });
      const layout = await p.evaluate(() => {
        const dock = document.querySelector("#discussion-dock").getBoundingClientRect();
        const presets = [...document.querySelectorAll("#view-presets button")].map((button) => { const r = button.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
        const targets = [...document.querySelectorAll("#snapino-inspector button, .discussion-tab:not([hidden])")].map((element) => { const r = element.getBoundingClientRect(); return Math.min(r.width, r.height); }).filter((size) => size > 0);
        return { dock: { left: Math.round(dock.left), width: Math.round(dock.width) }, presets, smallest: Math.min(...targets), overflow: document.documentElement.scrollWidth > window.innerWidth, chatTab: Boolean(document.querySelector('.discussion-tab[data-tab="chat"]:not([hidden])')) };
      });
      check(`${viewport.width}px: no horizontal overflow; chat tab present`, !layout.overflow && layout.chatTab, JSON.stringify(layout.dock));
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

    // ── Phone 390×844: compact chrome, and the inspector reached by real scrolling, pointer and keys ──
    {
      const p = await open({ width: 390, height: 844 });
      await place(p, LAYOUT);
      await settled(p, "phone placed");
      const chrome = await p.evaluate(() => {
        const top = (selector) => Math.round(document.querySelector(selector).getBoundingClientRect().top + scrollY);
        return { frameTop: top("#scene-frame"), dockTop: top("#discussion-dock"), tabsTop: top(".discussion-tabs"), innerHeight, scrollHeight: document.documentElement.scrollHeight };
      });
      check("phone: the 3D bench starts within the first 260 px (compact chrome)", chrome.frameTop <= 260, JSON.stringify(chrome));
      check("phone: the dock's tab row is on the first screen", chrome.tabsTop + 44 <= chrome.innerHeight, JSON.stringify(chrome));
      await shot(p, "after-phone-first-screen", "390×844 first screen: header, one row of studios and parts, one row of tools, the bench, the dock's tabs");
      // Real wheel scrolling over the dock (not the canvas, whose wheel zooms the 3D view).
      const tabs = await p.locator(".discussion-tabs").boundingBox();
      await p.mouse.move(tabs.x + tabs.width / 2, tabs.y + tabs.height / 2);
      await p.mouse.wheel(0, 520);
      await p.waitForFunction(() => scrollY > 200, null, { polling: 200, timeout: 30_000 });
      const scrolled = await p.evaluate(() => Math.round(scrollY));
      // Pointer: open the Inspector tab, then select the lamp on the diagram.
      await p.locator('.discussion-tab[data-tab="inspect"]').click();
      await p.locator('#si-diagram [data-part="sno-l1"] .dg-hit').click();
      await p.waitForFunction(() => document.querySelector("#si-part-title")?.textContent === "Lamp L1", null, { polling: 300 });
      // Keyboard: Pinout tab, then ArrowRight to Behaviour & limits.
      await p.locator('#si-part [data-tab="pinout"]').click();
      await p.keyboard.press("ArrowRight");
      const reached = await p.evaluate(() => {
        const part = document.querySelector("#si-part").getBoundingClientRect();
        const tabs = document.querySelector(".discussion-tabs").getBoundingClientRect();
        return {
          scrollY: Math.round(scrollY),
          tab: document.querySelector(".discussion-tab.is-active")?.dataset.tab ?? null,
          selectedTab: document.querySelector('#si-part [role="tab"][aria-selected="true"]')?.dataset.tab ?? null,
          focused: document.activeElement?.dataset.tab ?? null,
          partVisible: part.top < innerHeight && part.bottom > 0,
          tabsVisible: tabs.top >= 0 && tabs.bottom <= innerHeight,
          highlights: window.__vmQa.highlights().length,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      check("phone: wheel scrolling reaches the dock; the Inspector tab and a diagram rung work with the pointer", scrolled > 200 && reached.tab === "inspect" && reached.partVisible && reached.highlights > 0, JSON.stringify({ scrolled, ...reached }));
      check("phone: the inspector's reference tabs work from the keyboard (ArrowRight moves to Behaviour & limits)", reached.selectedTab === "behavior" && reached.focused === "behavior", JSON.stringify(reached));
      check("phone: no horizontal overflow (vertical scrolling is the intended way to the dock)", !reached.overflow);
      await shot(p, "after-phone-inspector-selected", "390×844 scrolled to the dock: Inspector tab, lamp selected from the diagram, Behaviour & limits");
      // Back up to the 3D bench: the selection's rings are on the studs.
      await p.mouse.move(195, 30);
      await p.mouse.wheel(0, -2000);
      await p.waitForFunction(() => scrollY < 10, null, { polling: 200, timeout: 30_000 });
      await shot(p, "after-phone-3d-selected", "390×844 back at the bench: the lamp's terminal and net rings in 3D");
      check("phone: no page errors", p.errors.length === 0, p.errors.join(" | "));
      await p.context().close();
    }
    // Phone with the workshop: its tab folded by the learner's own toggle.
    {
      const p = await open({ width: 390, height: 844 }, { episode: true });
      await settled(p, "phone workshop");
      const tabs = await p.locator(".discussion-tabs").boundingBox();
      await p.mouse.move(tabs.x + tabs.width / 2, tabs.y + 10);
      await p.mouse.wheel(0, 500);
      await p.waitForFunction(() => scrollY > 200, null, { polling: 200, timeout: 30_000 });
      await p.locator("#episode-toggle").click();
      const folded = await p.evaluate(() => ({ collapsed: document.querySelector("#episode-panel")?.classList.contains("is-collapsed") ?? false, expanded: document.querySelector("#episode-toggle")?.getAttribute("aria-expanded") }));
      check("phone: the workshop folds with its own toggle (pointer)", folded.collapsed && folded.expanded === "false", JSON.stringify(folded));
      await shot(p, "after-phone-workshop-folded", "390×844 workshop tab folded");
      await p.context().close();
    }

    // ── Circuit Bench: the meter in the dock inspector, real value edit + Undo, solved-current flow ──
    {
      const FLOW = { "battery-9v": [21, 23], "led-red": [53, 52], "resistor-1k": [41, 44], "wire-blue": [68, 73], "wire-yellow": [76, 71] };
      for (const reducedMotion of ["reduce", "no-preference"]) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion });
        await instrument(context);
        const p = await context.newPage();
        p.setDefaultTimeout(600_000);
        p.errors = [];
        p.on("pageerror", (error) => p.errors.push(error.message));
        await p.goto(`${base}/?room=Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}&quality=low&qa&studio=circuit`);
        await p.waitForSelector("#enter-room", { state: "attached" });
        await p.locator("#enter-room").click();
        await p.waitForFunction(() => Boolean(window.__vmQa?.flow), null, { polling: 500 });
        await place(p, FLOW);
        await settled(p, `circuit ${reducedMotion}`);
        if (reducedMotion === "reduce") {
          // Real pointer on the resistor in 3D: the meter in the dock's Inspector tab shows it.
          const rect = await p.evaluate(() => window.__vmQa.partScreenRect("resistor-1k"));
          await p.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
          await p.waitForFunction(() => Boolean(document.querySelector('.value-editor[data-part="resistor-1k"]')), null, { polling: 300 });
          const docked = await p.evaluate(() => ({ tab: document.querySelector(".discussion-tab.is-active")?.dataset.tab, inDock: Boolean(document.querySelector("#discussion-dock #inspector")), visible: document.querySelector("#inspector").getClientRects().length > 0 }));
          check("Circuit Bench: selecting a part in 3D opens the meter in the dock's Inspector tab", docked.tab === "inspect" && docked.inDock && docked.visible, JSON.stringify(docked));
          await p.locator('.value-editor[data-part="resistor-1k"] .preset[data-value="470"]').click();
          await p.waitForFunction(() => window.__vmQa.bench().parts["resistor-1k"]?.props?.ohms === 470, null, { polling: 300 });
          const edited = await p.evaluate(() => document.querySelector("#inspector-readings")?.textContent ?? "");
          await p.locator("#undo-edit").click();
          await p.waitForFunction(() => window.__vmQa.bench().parts["resistor-1k"]?.props?.ohms === 1000, null, { polling: 300 });
          check("Circuit Bench: a preset click edits the real resistor value through the room, and Undo restores it", /470/.test(edited), edited.slice(0, 120));
          await shot(p, "after-circuit-meter-docked", "Circuit Bench: meter in the dock Inspector tab, resistor selected");
        }
        await p.evaluate(() => document.querySelector('.discussion-tab[data-tab="inspect"]')?.click());
        await p.locator("#inspector-flow").check();
        await settled(p, `flow on ${reducedMotion}`);
        const flow = await p.evaluate(() => ({ state: window.__vmQa.flow(), blue: window.__vmQa.wireEnds("wire-blue"), note: document.querySelector("#inspector-flow-note")?.textContent ?? "" }));
        const blue = flow.state.wires.find((wire) => wire.id === "wire-blue");
        check(`flow (${reducedMotion}): a valid solve shows arrows on both carrying jumpers, in the solved direction`, flow.state.reason === "solved" && flow.state.arrows === 8 && blue && blue.amps > 0 && blue.direction === 1, JSON.stringify(flow.state).slice(0, 300));
        // The first arrow belongs to wire-blue; its axis must point from end A toward end B horizontally.
        const ab = [flow.blue[1][0] - flow.blue[0][0], flow.blue[1][2] - flow.blue[0][2]];
        const along = flow.state.firstPointsTo[0] * ab[0] + flow.state.firstPointsTo[2] * ab[1];
        check(`flow (${reducedMotion}): the 3D arrow points from the wire's end A toward end B (positive solved current)`, along > 0, `dot ${along.toFixed(3)}`);
        check(`flow (${reducedMotion}): the note states the solved current and that speed is not to scale`, /mA/.test(flow.note) && /not to scale/.test(flow.note), flow.note);
        const firstA = flow.state.first;
        await settled(p, `flow frames ${reducedMotion}`);
        const firstB = (await p.evaluate(() => window.__vmQa.flow())).first;
        const moved = Math.hypot(firstA[0] - firstB[0], firstA[1] - firstB[1], firstA[2] - firstB[2]);
        if (reducedMotion === "reduce") check("flow with reduced motion: the arrows stand still", moved < 1e-6 && flow.state.moving === false, `moved ${moved}`);
        else check("flow without reduced motion: the arrows glide along the wire", moved > 1e-4 && flow.state.moving === true, `moved ${moved}`);
        if (reducedMotion === "reduce") {
          await shot(p, "after-circuit-flow", "Circuit Bench: solved-current arrows on the two jumpers (reduced motion: still)");
          // A short across the battery: no flow drawn, and the note says why.
          await place(p, { "wire-red": [85, 87] });
          await settled(p, "flow short");
          const shorted = await p.evaluate(() => ({ state: window.__vmQa.flow(), note: document.querySelector("#inspector-flow-note")?.textContent ?? "" }));
          check("flow: a short circuit draws no arrows and says so", shorted.state.arrows === 0 && shorted.state.reason === "short circuit" && /short circuit/.test(shorted.note), JSON.stringify(shorted));
          // Open the loop (the red short removed, the yellow jumper out): no flow.
          // Both jumpers moved to dead spots (red: two unused bottom columns; yellow: both ends on
          // the bottom rail), so the resistor's far end no longer reaches the battery.
          await place(p, { "wire-red": [100, 101], "wire-yellow": [176, 177] });
          await settled(p, "flow open");
          const opened = await p.evaluate(() => window.__vmQa.flow());
          check("flow: an open circuit draws no arrows", opened.arrows === 0 && opened.reason !== "solved", JSON.stringify(opened));
          await p.locator("#inspector-flow").uncheck();
          const off = await p.evaluate(() => window.__vmQa.flow());
          check("flow off: no arrows remain", off.arrows === 0 && off.enabled === false, JSON.stringify(off));
        }
        check(`circuit (${reducedMotion}): no page errors`, p.errors.length === 0, p.errors.join(" | "));
        await context.close();
      }
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
