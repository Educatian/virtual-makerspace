// Resource-Limited Greenhouse: the same cameras on two builds (before / after a change), with the
// brief's rig fully plumbed and wired: the overview at 1440×900 and 1280×720 and a close-up of
// the valves and the controller. Peer mode; renderer counters are draw calls and triangles of the
// frame shown, never frame rates (SwiftShader).
//
//   node scripts/qa-greenhouse-compare.mjs <base-url> <out-dir> <app-sha>
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base = "http://127.0.0.1:4173", out = "qa-greenhouse-compare", appSha = "unknown"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const BRIEF = [["irrigation-hose", 0, 1], ["irrigation-hose-2", 2, 3], ["irrigation-hose-3", 4, 6], ["irrigation-hose-4", 5, 7], ["power-cable-1", 8, 9], ["power-cable-2", 10, 12], ["power-cable-3", 11, 13]];
const record = { app: appSha, base, shots: [], issues: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
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
    page.on("pageerror", (error) => record.issues.push(`pageerror: ${error.message}`));
    await page.goto(`${base}/?room=Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}&name=QA&studio=greenhouse&qa=1&condition=DI`);
    await page.click("#enter-room");
    await page.waitForFunction(() => Boolean(window.__vmQa?.greenhouse?.().panel?.shown), null, { timeout: 300_000, polling: 500 });
    for (const [id, a, b] of BRIEF) {
      await page.evaluate(({ id, a }) => window.__vmQa.dropEnd(id, 0, a), { id, a });
      await page.evaluate(({ id, b }) => window.__vmQa.dropEnd(id, 1, b), { id, b });
    }
    await page.evaluate(() => window.__vmQa.seatShared({ "soil-sensor": [14, 15] }));
    await page.waitForFunction(() => window.__vmQa.greenhouse().panel.rig.complete === true, null, { polling: 500 });
    const shots = [[`overview-${viewport.width}`, null]];
    if (viewport.width === 1440) shots.push(["closeup-controls", [[1.25, 2.6, 4.7], [1.25, 0.9, 2.0]]]);
    for (const [name, camera] of shots) {
      if (camera) await page.evaluate(([position, target]) => window.__vmQa.view(position, target), camera);
      else await page.evaluate(() => window.__vmQa.preset("overview"));
      await settled(page, name);
      await page.screenshot({ path: `${out}/${name}.png` });
      const stats = await page.evaluate(() => window.__vmQa.stats());
      record.shots.push({ name, file: `${name}.png`, viewport, calls: stats?.calls ?? null, triangles: stats?.triangles ?? null, camera: await page.evaluate(() => window.__vmQa.camera()) });
      console.log(`shot ${name}: ${stats?.calls} calls, ${stats?.triangles} triangles`);
    }
    await context.close();
  }
} catch (error) {
  record.issues.push(`error: ${error.message}`);
  console.log(`ERROR ${error.message}`);
} finally {
  writeFileSync(`${out}/record.json`, JSON.stringify(record, null, 1));
  await browser.close();
  process.exitCode = record.issues.length ? 1 : 0;
}
