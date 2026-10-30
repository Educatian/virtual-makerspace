// Resource-Limited Greenhouse: the 3D valve handwheels and controller knobs as pointer targets, on
// the brief's fully plumbed and wired rig, in the overview a learner sees on entering (key 1), at
// 1440×900 and 1280×720 (peer mode, real pointer and keyboard input).
//
//   npm run build && (cd dist && python3 -m http.server 4173 --bind 127.0.0.1)
//   node scripts/qa-greenhouse-controls.mjs http://127.0.0.1:4173 <out-dir> <app-sha>
//
// History: the first version of this script (run on faa7c09) clicked each valve grip and dial
// centre and failed 3/6 — hose fittings and cable 3 stood in front of three of them. Its second
// version searched an 81×81 px window for a pixel showing the control; that only proved a tiny
// hittable area (8–13 of 441 samples). Both records are kept in docs/qa/greenhouse/app-faa7c09/.
// This version (after the redesign: handwheels and knobs on square position plates facing the
// room, nothing pluggable in front of them) uses each control's DECLARED target — the centre of
// its knob (the object named "control_target") — and fixed points around it, never a search:
//  1. the 44×44 CSS px square centred on the target: at every 4 px sample the first visible
//     surface (hidden meshes and lines' grab spheres and rings skipped, as the app's pick does) is
//     the control itself, and no line's grab sphere or ring lies in front of it (sphere behind:
//     counted and reported);
//  2. five predetermined points (centre, ±15 px across, ±15 px down): from a neutral selection
//     (the fan picked in the parts rail), a real click selects the control's part and focuses
//     its field;
//  3. a value typed into that field and Enter is applied (the connection list shows it), for the
//     closed / middle / open (or min / middle / max) poses, and the centre still works in each pose;
//  4. a click or a short drag on a control moves no hose or cable end (every end's world position,
//     to the millimetre, and every line's status unchanged);
//  5. (1440) the day running: a 3D click selects the part, the fields are locked, an unapplied
//     draft typed before the start is kept, nothing is sent; after a pause the draft applies;
//  6. (1440) the hose end standing next to valve B can still be dragged out of its port and back;
//  7. the fields reached from the 3D click, their steppers and Apply are ≥ 44 px tall, and Tab
//     moves from the field to the next control.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base = "http://127.0.0.1:4173", out = "qa-greenhouse-controls", appSha = "unknown"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const record = { app: appSha, base, rooms: [], checks: [], targets: {}, issues: [] };
const check = (name, ok, detail = "") => {
  record.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const BRIEF = [["irrigation-hose", 0, 1], ["irrigation-hose-2", 2, 3], ["irrigation-hose-3", 4, 6], ["irrigation-hose-4", 5, 7], ["power-cable-1", 8, 9], ["power-cable-2", 10, 12], ["power-cable-3", 11, 13]];
const CONTROLS = [
  { control: "valveA", part: "valve-manifold", label: "valve A handwheel", values: [0, 50, 100] },
  { control: "valveB", part: "valve-manifold", label: "valve B handwheel", values: [0, 50, 100] },
  { control: "pumpBelow", part: "farm-controller", label: "PUMP BELOW knob", values: [10, 50, 90] },
  { control: "fanAbove", part: "farm-controller", label: "FAN ABOVE knob", values: [20, 30, 40] },
];
const POINTS = [[0, 0], [-15, 0], [15, 0], [0, -15], [0, 15]];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    const vw = `${viewport.width}`;
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
    page.on("pageerror", (error) => record.issues.push(`pageerror (${vw}): ${error.message}`));
    const room = `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
    record.rooms.push(room);
    await page.goto(`${base}/?room=${room}&name=QA&studio=greenhouse&qa=1&condition=DI`);
    await page.click("#enter-room");
    await page.waitForFunction(() => Boolean(window.__vmQa?.greenhouse?.().panel?.shown), null, { timeout: 300_000, polling: 500 });
    await settled(page, `${vw} entered`);
    for (const [id, a, b] of BRIEF) {
      await page.evaluate(({ id, a }) => window.__vmQa.dropEnd(id, 0, a), { id, a });
      await page.evaluate(({ id, b }) => window.__vmQa.dropEnd(id, 1, b), { id, b });
    }
    await page.evaluate(() => window.__vmQa.seatShared({ "soil-sensor": [14, 15] }));
    await page.waitForFunction(() => window.__vmQa.greenhouse().panel.rig.complete === true, null, { polling: 500 });
    // The learner's overview: key 1 from the 3D view.
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined)); // key 1 from the 3D view, not into a field
    await page.keyboard.press("1");
    await settled(page, `${vw} overview`);
    const lineState = () => page.evaluate(() => {
      const lines = window.__vmQa.greenhouse().panel.rig.lines;
      const ends = {};
      // World positions of both ends (mm), so a camera change cannot hide or fake a move.
      for (const id of Object.keys(lines)) ends[id] = (window.__vmQa.wireEnds(id) ?? []).map((end) => end.map((v) => Math.round(v * 1000)));
      return JSON.stringify({ lines, ends });
    });
    const plugsBefore = await lineState();
    const neutral = async () => {
      await page.locator('.component-card[data-component-id="vent-fan"]').click();
      await page.waitForFunction(() => window.__vmQa.selected() === "vent-fan", null, { timeout: 60_000, polling: 250 });
    };
    const focusAfter = async (id) => {
      let focused = "";
      for (let i = 0; i < 60 && focused !== id; i += 1) {
        await sleep(250);
        focused = await page.evaluate(() => document.activeElement?.id ?? "");
      }
      return focused;
    };
    const listText = () => page.locator("#gh-list").textContent();
    await page.screenshot({ path: `${out}/overview-${vw}.png` });
    record.targets[vw] = {};
    for (const { control, part, label, values } of CONTROLS) {
      const target = await page.evaluate((control) => window.__vmQa.ghControlTarget(control), control);
      const xs = target.rim.map((p) => p.x);
      const ys = target.rim.map((p) => p.y);
      const plate = { w: Math.round(Math.max(...xs) - Math.min(...xs)), h: Math.round(Math.max(...ys) - Math.min(...ys)) };
      // 1. The 44 px square around the declared centre.
      const square = await page.evaluate(({ control, centre }) => {
        let own = 0, total = 0, handleInFront = 0, handleBehind = 0;
        const others = {};
        for (let dy = -22; dy <= 22; dy += 4) {
          for (let dx = -22; dx <= 22; dx += 4) {
            total += 1;
            const hits = window.__vmQa.debugPick(centre.x + dx, centre.y + dy) ?? [];
            const index = hits.findIndex((h) => h.visible && !h.handle && !h.ring);
            const first = index >= 0 ? hits[index] : null;
            if (first?.control === control) own += 1;
            else { const key = first ? `${first.part}:${first.material}` : "nothing"; others[key] = (others[key] ?? 0) + 1; }
            if (hits.slice(0, index < 0 ? hits.length : index).some((h) => h.handle || h.ring)) handleInFront += 1;
            if (index >= 0 && hits.slice(index + 1).some((h) => h.handle)) handleBehind += 1;
          }
        }
        return { own, total, handleInFront, handleBehind, others };
      }, { control, centre: target.centre });
      record.targets[vw][control] = { centre: target.centre, plate, square };
      check(`${vw} ${label}: its whole 44×44 px square around the declared centre shows the control first (${square.total} samples), with no grab sphere in front`, square.own === square.total && square.handleInFront === 0, `${square.own}/${square.total}; plate ${plate.w}×${plate.h} px; grab spheres behind the plate at ${square.handleBehind} samples; other surfaces ${JSON.stringify(square.others)}`);
      // 2. Five predetermined points.
      const results = [];
      for (const [dx, dy] of POINTS) {
        await neutral();
        await page.mouse.click(target.centre.x + dx, target.centre.y + dy);
        const focused = await focusAfter(`gh-${control}`);
        const selected = await page.evaluate(() => window.__vmQa.selected());
        results.push({ dx, dy, focused, selected });
      }
      check(`${vw} ${label}: a real click at each of 5 fixed points (centre, ±15 px) selects ${part} and focuses its field`, results.every((r) => r.focused === `gh-${control}` && r.selected === part), JSON.stringify(results));
      // 3. Values through the focused field, in each pose; the centre still works after each.
      const poses = [];
      for (const value of values) {
        await neutral();
        await page.mouse.click(target.centre.x, target.centre.y);
        await focusAfter(`gh-${control}`);
        await page.keyboard.press("Control+A");
        await page.keyboard.type(String(value));
        const beforeEnter = await page.evaluate(() => ({ active: document.activeElement?.id ?? "", value: document.activeElement?.value ?? null, drafts: window.__vmQa.greenhouse().panel.drafts }));
        await page.keyboard.press("Enter");
        const expected = control === "valveA" ? `valve A ${value} %` : control === "valveB" ? `valve B ${value} %` : control === "pumpBelow" ? `soil < ${value} %` : `air > ${value} °C`;
        await page.waitForFunction((text) => (document.querySelector("#gh-list")?.textContent ?? "").includes(text), expected, { timeout: 120_000, polling: 250 }).catch(() => undefined);
        const applied = (await listText())?.includes(expected) ?? false;
        const afterEnter = await page.evaluate(() => ({ editNote: window.__vmQa.greenhouse().panel.editNote, list: (document.querySelector("#gh-list")?.textContent ?? "").match(/valve A \d+ %, valve B \d+ %|soil < \d+ %, fan when air > \d+ °C/g) }));
        await settled(page, `${vw} ${control} ${value}`);
        await neutral();
        await page.mouse.click(target.centre.x, target.centre.y);
        const again = await focusAfter(`gh-${control}`);
        poses.push({ value, applied, centreAfter: again === `gh-${control}`, ...(applied ? {} : { beforeEnter, afterEnter }) });
      }
      check(`${vw} ${label}: values typed after the 3D click are applied (${values.join(", ")}), and in each resulting pose the centre still focuses the field`, poses.every((p) => p.applied && p.centreAfter), JSON.stringify(poses));
      // 4. A short drag on the control: it may orbit the camera (a drag on a fixture does), but
      //    it must not move any line end. Back to the overview with key 1, as a learner would.
      await neutral();
      await page.mouse.move(target.centre.x, target.centre.y);
      await page.mouse.down();
      for (let step = 1; step <= 4; step += 1) await page.mouse.move(target.centre.x + step * 4, target.centre.y + step * 2);
      await page.mouse.up();
      await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined)); // key 1 from the 3D view, not into a field
      await page.keyboard.press("1");
      await settled(page, `${vw} ${control} drag, overview again`);
    }
    // Back to the brief's worked values for the rest.
    const plugsAfter = await lineState();
    check(`${vw} no click or short drag on a control moved any hose or cable end (both ends of every line at the same world position, every line's status unchanged)`, plugsAfter === plugsBefore, plugsAfter === plugsBefore ? "" : `${plugsBefore} → ${plugsAfter}`);
    // 7. 44 px reach from the 3D click.
    await neutral();
    const valveA = record.targets[vw].valveA.centre;
    await page.mouse.click(valveA.x, valveA.y);
    await focusAfter("gh-valveA");
    const sizes = await page.evaluate(() => [...document.querySelectorAll('#gh-part-panel form[data-part="valve-manifold"] input, #gh-part-panel form[data-part="valve-manifold"] button')].filter((el) => el.offsetParent !== null).map((el) => ({ what: el.id || el.getAttribute("aria-label") || el.textContent.trim(), h: Math.round(el.getBoundingClientRect().height) })));
    await page.keyboard.press("Tab");
    const next = await page.evaluate(() => ({ label: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.id ?? "", h: Math.round(document.activeElement?.getBoundingClientRect().height ?? 0) }));
    check(`${vw} from the 3D click: the field, its steppers and Apply are ≥ 44 px tall, and Tab moves to the next control`, sizes.length >= 5 && sizes.every((s) => s.h >= 44) && next.h >= 44 && next.label !== "gh-valveA", JSON.stringify({ sizes, next }));
    if (viewport.width === 1440) {
      // 5. The day running: locked fields, kept draft, nothing sent.
      await neutral();
      await page.mouse.click(valveA.x, valveA.y);
      await focusAfter("gh-valveA");
      await page.keyboard.press("Control+A");
      await page.keyboard.type("35");
      const listBeforeRun = await listText();
      await page.locator('.discussion-tab[data-tab="greenhouse"]').click();
      await page.locator("#gh-run-toggle").click();
      await page.waitForFunction(() => window.__vmQa.greenhouse().panel.locked === true, null, { timeout: 60_000, polling: 250 });
      await neutral();
      const valveB = record.targets[vw].valveB.centre;
      await page.mouse.click(valveB.x, valveB.y);
      await page.waitForFunction(() => window.__vmQa.selected() === "valve-manifold", null, { timeout: 60_000, polling: 250 });
      await sleep(1500);
      const running = await page.evaluate(() => ({
        drafts: window.__vmQa.greenhouse().panel.drafts,
        disabled: document.querySelector("#gh-valveB")?.disabled ?? null,
        note: document.querySelector("#gh-part-panel")?.textContent?.includes("The day is running") ?? false,
      }));
      check("1440 while the day runs: a 3D click on valve B selects the manifold, its fields are locked with the reason shown, and the unapplied valve A draft (35) is kept", running.drafts["valve-manifold:valveA"] === "35" && running.disabled === true && running.note, JSON.stringify(running));
      check("1440 …and nothing was sent: the room's valve values are unchanged", (await listText())?.includes("valve A 100 %") && listBeforeRun?.includes("valve A 100 %"));
      await page.locator('.discussion-tab[data-tab="greenhouse"]').click();
      await page.locator("#gh-run-toggle").click();
      await page.waitForFunction(() => window.__vmQa.greenhouse().panel.locked === false, null, { timeout: 60_000, polling: 250 });
      await page.locator('#gh-part-panel form[data-part="valve-manifold"] button[type="submit"]').click();
      await page.waitForFunction(() => (document.querySelector("#gh-list")?.textContent ?? "").includes("valve A 35 %"), null, { timeout: 120_000, polling: 250 }).catch(() => undefined);
      check("1440 after a pause, the kept draft applies (valve A 35 %)", (await listText())?.includes("valve A 35 %"));
      // 6. The hose end next to valve B: out of its port and back, by pointer.
      const from = await page.evaluate(() => window.__vmQa.plugPoint("irrigation-hose-4", 0));
      const underFrom = await page.evaluate(({ x, y }) => window.__vmQa.debugPick(x, y)?.slice(0, 2) ?? null, from);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let step = 1; step <= 10; step += 1) await page.mouse.move(from.x - step * 9, from.y + step * 14);
      await page.mouse.up();
      await settled(page, "1440 hose 4 out");
      const out1 = await page.evaluate(() => window.__vmQa.greenhouse().panel.rig.lines["irrigation-hose-4"]);
      const from2 = await page.evaluate(() => window.__vmQa.plugPoint("irrigation-hose-4", 0));
      const to = await page.evaluate(() => window.__vmQa.jackPoint(5, true));
      await page.mouse.move(from2.x, from2.y);
      await page.mouse.down();
      for (let step = 1; step <= 12; step += 1) await page.mouse.move(from2.x + ((to.x - from2.x) * step) / 12, from2.y + ((to.y - from2.y) * step) / 12);
      await page.mouse.up();
      await settled(page, "1440 hose 4 back");
      const back = await page.evaluate(() => window.__vmQa.greenhouse().panel.rig.lines["irrigation-hose-4"]);
      check("1440 the hose end at VALVE B OUT (next to the valve B handwheel) is dragged out of its port and back into it by pointer", out1 !== "branch" && back === "branch", JSON.stringify({ underTheGrab: underFrom, out: out1, back }));
    }
    await context.close();
  }
  check("no page errors", !record.issues.some((issue) => issue.startsWith("pageerror")), record.issues.join(" | "));
} catch (error) {
  record.issues.push(`error: ${error.message}`);
  console.log(`ERROR ${error.message}`);
} finally {
  record.ok = record.checks.length > 0 && record.checks.every((c) => c.ok) && !record.issues.some((i) => i.startsWith("error"));
  writeFileSync(`${out}/record.json`, JSON.stringify(record, null, 1));
  console.log(`qa greenhouse controls: ${record.checks.filter((c) => c.ok).length}/${record.checks.length} checks passed (rooms ${record.rooms.join(", ")})`);
  await browser.close();
  process.exitCode = record.ok ? 0 : 1;
}
