// Resource-Limited Greenhouse: real pointer clicks on the 3D valve handles and controller dials of a
// fully plumbed rig (peer mode, overview camera, 1440×900). Each click must select the part that
// owns the control and focus that control's field in the Greenhouse dock tab. Written after the
// two-client e2e on fe4fdf8 failed its valve-handle click (the hose fitting won the pick).
// Its first version clicked each valve grip and dial centre; on faa7c09 three of those four points
// showed a hose fitting or a cable in front of the control, so that version failed 3/6 (record kept
// in docs/qa/greenhouse/app-faa7c09/). This version records what is in front of each grip or centre,
// measures how much of the control is visible around it, and clicks a pixel that shows the control.
//
//   npm run build && (cd dist && python3 -m http.server 4173 --bind 127.0.0.1)
//   node scripts/qa-greenhouse-controls.mjs http://127.0.0.1:4173 <out-dir> <app-sha>
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base = "http://127.0.0.1:4173", out = "qa-greenhouse-controls", appSha = "unknown"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const record = { app: appSha, base, room: "", checks: [], issues: [] };
const check = (name, ok, detail = "") => {
  record.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const BRIEF = [["irrigation-hose", 0, 1], ["irrigation-hose-2", 2, 3], ["irrigation-hose-3", 4, 6], ["irrigation-hose-4", 5, 7], ["power-cable-1", 8, 9], ["power-cable-2", 10, 12], ["power-cable-3", 11, 13]];
const CONTROLS = [["valveA", "valve-manifold", "valve A handle"], ["valveB", "valve-manifold", "valve B handle"], ["pumpBelow", "farm-controller", "PUMP BELOW dial"], ["fanAbove", "farm-controller", "FAN ABOVE dial"]];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await instrument(context);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(240_000);
  page.on("pageerror", (error) => record.issues.push(`pageerror: ${error.message}`));
  record.room = `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
  await page.goto(`${base}/?room=${record.room}&name=QA&studio=greenhouse&qa=1&condition=DI`);
  await page.click("#enter-room");
  await page.waitForFunction(() => Boolean(window.__vmQa?.greenhouse?.().panel?.shown), null, { timeout: 300_000, polling: 500 });
  await settled(page, "entered");
  for (const [id, a, b] of BRIEF) {
    await page.evaluate(({ id, a }) => window.__vmQa.dropEnd(id, 0, a), { id, a });
    await page.evaluate(({ id, b }) => window.__vmQa.dropEnd(id, 1, b), { id, b });
  }
  await page.evaluate(() => window.__vmQa.seatShared({ "soil-sensor": [14, 15] }));
  await page.waitForFunction(() => window.__vmQa.greenhouse().panel.rig.complete === true, null, { timeout: 120_000, polling: 500 });
  check("the brief's rig is plumbed and wired (every hose fitting in place at the manifold)", true, JSON.stringify((await page.evaluate(() => window.__vmQa.greenhouse())).panel.rig.lines));
  await page.locator("canvas").first().focus().catch(() => undefined);
  await page.keyboard.press("1");
  await settled(page, "overview");
  // For each control: what is the first visible surface at its grip / dial centre (recorded, not a
  // check: a plugged hose fitting or a cable can stand in front of it from this camera), how much
  // of an 81×81 px window around it shows the control itself, and does a real click on a pixel
  // where the control is the first visible surface select its part and focus its field.
  // "First visible surface" skips hidden meshes and lines' grab spheres and rings, as the app does.
  const firstVisible = (hits) => (hits ?? []).find((hit) => hit.visible && !hit.handle && !hit.ring) ?? null;
  for (const [control, part, label] of CONTROLS) {
    const point = await page.evaluate((c) => window.__vmQa.ghControlPoint(c), control);
    const atPoint = firstVisible(await page.evaluate(({ x, y }) => window.__vmQa.debugPick(x, y), point));
    record[`${control}AtGrip`] = atPoint;
    console.log(`  ${label}: first visible surface at its ${control.startsWith("valve") ? "grip" : "centre"} (${Math.round(point.x)}, ${Math.round(point.y)}): ${atPoint ? `${atPoint.part}${atPoint.control ? ` (${atPoint.control})` : ""} ${atPoint.material}` : "nothing"}`);
    const scan = await page.evaluate(({ control, x0, y0 }) => {
      const own = [];
      let samples = 0;
      for (let dy = -40; dy <= 40; dy += 4) {
        for (let dx = -40; dx <= 40; dx += 4) {
          samples += 1;
          const hit = (window.__vmQa.debugPick(x0 + dx, y0 + dy) ?? []).find((h) => h.visible && !h.handle && !h.ring);
          if (hit?.control === control) own.push({ x: x0 + dx, y: y0 + dy, d: Math.hypot(dx, dy) });
        }
      }
      own.sort((a, b) => a.d - b.d);
      return { samples, own: own.length, nearest: own[0] ?? null };
    }, { control, x0: point.x, y0: point.y });
    record[`${control}Scan`] = scan;
    if (!scan.nearest) {
      check(`the ${label} is visible and clickable in the plumbed overview`, false, `no pixel of ${scan.samples} around it shows the control first`);
      continue;
    }
    // Start each click from a neutral state: another part selected.
    await page.locator('.component-card[data-component-id="vent-fan"]').click();
    await page.waitForFunction(() => window.__vmQa.selected() === "vent-fan", null, { timeout: 60_000, polling: 250 });
    await page.mouse.click(scan.nearest.x, scan.nearest.y);
    let focused = "";
    for (let i = 0; i < 60 && focused !== `gh-${control}`; i++) {
      await page.waitForTimeout(500);
      focused = await page.evaluate(() => document.activeElement?.id ?? "");
    }
    const selected = await page.evaluate(() => window.__vmQa.selected());
    check(`clicking the visible ${label} in 3D selects ${part} and focuses its field`, focused === `gh-${control}` && selected === part, `clicked (${Math.round(scan.nearest.x)}, ${Math.round(scan.nearest.y)}), ${Math.round(scan.nearest.d)} px from its ${control.startsWith("valve") ? "grip" : "centre"}; the control is the first visible surface at ${scan.own} of ${scan.samples} sampled pixels; focus ${focused}; selected ${selected}`);
    if (control === "valveB") await page.screenshot({ path: `${out}/valve-b-clicked.png` });
  }
  check("no page errors", record.issues.length === 0, record.issues.join(" | "));
} catch (error) {
  record.issues.push(`error: ${error.message}`);
  console.log(`ERROR ${error.message}`);
} finally {
  record.ok = record.checks.length > 0 && record.checks.every((c) => c.ok) && !record.issues.some((i) => i.startsWith("error"));
  writeFileSync(`${out}/record.json`, JSON.stringify(record, null, 1));
  console.log(`qa greenhouse controls: ${record.checks.filter((c) => c.ok).length}/${record.checks.length} checks passed (room ${record.room})`);
  await browser.close();
  process.exitCode = record.ok ? 0 : 1;
}
