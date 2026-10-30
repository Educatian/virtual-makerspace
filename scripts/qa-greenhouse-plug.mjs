// Resource-Limited Greenhouse: every hose and cable end can be picked up from where it lies and
// plugged by real pointer drags in the overview (peer mode), building the brief's rig end by end,
// at 1440×900, 1280×720 and 960×640 (the two-client run's size). Written after the two-client run
// on b9dde3c failed: the cables' coils then lay on the floor behind the controller, where its new
// knob console covered two of their ends, so a press there picked the knob (the control in front)
// and the cable stayed out. At every grab point the first visible surface must be the line itself
// (or nothing of a control), and after the 14 drags the rig must be complete.
//
//   npm run build && (cd dist && python3 -m http.server 4173 --bind 127.0.0.1)
//   node scripts/qa-greenhouse-plug.mjs http://127.0.0.1:4173 <record.json> [1440x900,1280x720,960x640]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base = "http://127.0.0.1:4173", out = null, sizes = "1440x900,1280x720,960x640"] = process.argv.slice(2);
const PLAN = [["irrigation-hose", 0, 0], ["irrigation-hose", 1, 1], ["irrigation-hose-2", 0, 2], ["irrigation-hose-2", 1, 3], ["irrigation-hose-3", 0, 4], ["irrigation-hose-3", 1, 6], ["irrigation-hose-4", 0, 5], ["irrigation-hose-4", 1, 7], ["power-cable-1", 0, 8], ["power-cable-1", 1, 9], ["power-cable-2", 0, 10], ["power-cable-2", 1, 12], ["power-cable-3", 0, 11], ["power-cable-3", 1, 13]];
const COMPLETE = JSON.stringify({ "irrigation-hose": "supply", "irrigation-hose-2": "delivery", "irrigation-hose-3": "branch", "irrigation-hose-4": "branch", "power-cable-1": "charging", "power-cable-2": "feed", "power-cable-3": "feed" });
const record = { base, checks: [], steps: {}, issues: [] };
const check = (name, ok, detail = "") => {
  record.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
try {
  for (const size of sizes.split(",")) {
    const [width, height] = size.split("x").map(Number);
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await instrument(context);
    await context.addInitScript(() => {
      if (!crypto.randomUUID) {
        crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
          (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(240_000);
    page.on("pageerror", (error) => record.issues.push(`pageerror (${size}): ${error.message}`));
    await page.goto(`${base}/?room=Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}&name=QA&studio=greenhouse&qa=1&condition=DI`);
    await page.click("#enter-room");
    await page.waitForFunction(() => Boolean(window.__vmQa?.greenhouse?.().panel?.shown), null, { timeout: 300_000, polling: 500 });
    const steps = [];
    for (const [line, end, port] of PLAN) {
      await settled(page, `${size} ${line}:${end}`);
      const from = await page.evaluate(({ line, end }) => window.__vmQa.plugPoint(line, end), { line, end });
      const first = await page.evaluate(({ x, y }) => (window.__vmQa.debugPick(x, y) ?? []).find((h) => h.visible && !h.handle && !h.ring) ?? null, from);
      const to = await page.evaluate((port) => window.__vmQa.jackPoint(port, true), port);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let s = 1; s <= 12; s += 1) await page.mouse.move(from.x + ((to.x - from.x) * s) / 12, from.y + ((to.y - from.y) * s) / 12);
      await page.mouse.up();
      await settled(page, `${size} after ${line}:${end}`);
      const status = await page.evaluate((line) => window.__vmQa.greenhouse().panel.rig.lines[line], line);
      steps.push({ line, end, port, status, firstAtGrab: first ? `${first.part}:${first.material}${first.control ? ` (control ${first.control})` : ""}` : "none" });
    }
    record.steps[size] = steps;
    const lines = await page.evaluate(() => JSON.stringify(window.__vmQa.greenhouse().panel.rig.lines));
    check(`${size}: no grab point lies under a 3D control (each end is picked up, not a knob)`, steps.every((s) => !/\(control /.test(s.firstAtGrab)), JSON.stringify(steps.filter((s) => /\(control /.test(s.firstAtGrab))));
    check(`${size}: 14 real pointer drags build the brief's rig, every line in its ports`, lines === COMPLETE, lines);
    await context.close();
  }
  check("no page errors", !record.issues.length, record.issues.join(" | "));
} catch (error) {
  record.issues.push(`error: ${error.message}`);
  check("run completed", false, error.message.split("\n")[0]);
} finally {
  if (out) writeFileSync(out, JSON.stringify(record, null, 1));
  await browser.close();
  const passed = record.checks.filter((c) => c.ok).length;
  console.log(`qa greenhouse plug: ${passed}/${record.checks.length} checks passed`);
  process.exitCode = passed === record.checks.length ? 0 : 1;
}
