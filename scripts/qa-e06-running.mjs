// One capture only: Episode 1's running transmission (e06) at 1440×900, as qa-episode frames it,
// for a software renderer that needs minutes per few frames. The round is a deliberately long,
// legal QA light (D5 HIGH for 115 s, under the 120 s cap; not a protocol word), so the shot can be
// taken while it runs. The room clock is not paused or faked. What the shot shows is proven by the
// page's own state around it: the same transmission (tx), still running, lamp lit and Stop shown,
// before and after the screenshot. Not a protocol-timing or real-device claim.
//
//   node scripts/qa-e06-running.mjs <base-url> <out-dir> <app-sha>
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base = "http://localhost:4173", out = "qa-e06", appSha = "unknown"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
const room = `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
if (room === "7K3M") throw new Error("never the production room");
const record = { app: appSha, room, viewport: "1440x900", issues: [] };

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await instrument(context);
const page = await context.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (error) => record.issues.push(`pageerror: ${error.message}`));
const episode = () => page.evaluate(() => window.__vmQa.episode());
const click = async (selector) => {
  await page.waitForFunction((s) => { const element = document.querySelector(s); return Boolean(element) && !element.disabled; }, selector, { polling: 250 });
  await page.evaluate((s) => {
    const element = document.querySelector(s);
    const panel = element.closest(".discussion-panel");
    if (panel && !panel.classList.contains("is-active")) document.querySelector(`.discussion-tab[data-tab="${panel.dataset.panel}"]`)?.click();
    element.click();
  }, selector);
};
const waitFor = (fn, arg) => page.waitForFunction(fn, arg, { polling: 250 });

try {
  await page.goto(`${base}/?room=${room}&name=QA&studio=snapino&episode=rescue-signal&qa=1`);
  await page.waitForSelector("#enter-room", { state: "attached" });
  await click("#enter-room");
  await waitFor(() => Boolean(window.__vmQa?.episode) && !document.querySelector("#episode-panel")?.hidden);
  await click('[data-episode="claim-role"][data-role="sender"]');
  await waitFor(() => window.__vmQa.episode().role === "sender");
  await click("#load-field-test");
  await waitFor(() => Boolean(window.__vmQa.bench().parts["sno-l1"]?.sockets));
  await click('[data-episode="mission"][data-mission="ridge"]');
  await waitFor(() => window.__vmQa.episode().state?.mission === "ridge");
  // An intended message (the panel transmits only with one); the QA light below is not it.
  await click('[data-episode="intent-add"][data-word="SAFE"]');
  await waitFor(() => window.__vmQa.episode().state?.intent.length === 1);
  const program = [{ op: "write", pin: "D5", value: true }, ...Array.from({ length: 23 }, () => ({ op: "wait", ms: 5000 })), { op: "write", pin: "D5", value: false }];
  await page.evaluate((statements) => window.__vmQa.editDraft(statements), program);
  await page.evaluate(() => window.__vmQa.receiverView());
  // Display warm-up (the first lit lamp makes SwiftShader link a new program): light the lamp
  // locally once and settle, then dark again. No room traffic; the transmission is untouched.
  await page.evaluate(() => window.__vmQa.pins({ D5: true }));
  await settled(page, "lamp warm-up (lit)", { budgetMs: 900_000 });
  await page.evaluate(() => window.__vmQa.pins({ D5: false }));
  await settled(page, "ready to transmit", { budgetMs: 900_000 });

  await click('[data-episode="transmit"]');
  await waitFor(() => Boolean(document.querySelector('[data-episode="stop"]')) && window.__vmQa.episode().state?.round?.n === 1);
  const before = await episode();
  const startedAt = Date.now();
  await page.screenshot({ path: `${out}/e06-transmitting.png` });
  const shotMs = Date.now() - startedAt;
  const after = await episode();
  const litAfter = (await page.evaluate(() => window.__vmQa.lights())).includes("sno-l1");
  const stopShown = await page.evaluate(() => Boolean(document.querySelector('[data-episode="stop"]')));
  record.stats = await page.evaluate(() => window.__vmQa.stats());
  record.transmission = { durationMs: after.state.round.durationMs, txBefore: before.state.round.tx, txAfter: after.state.round.tx, elapsedBeforeShotMs: Math.round(before.elapsed), elapsedAfterShotMs: Math.round(after.elapsed), screenshotMs: shotMs, litAfterShot: litAfter, stopShownAfterShot: stopShown };
  const t = record.transmission;
  record.ok = t.txBefore === t.txAfter && !after.state.round.stopReason && t.elapsedAfterShotMs < t.durationMs && litAfter && stopShown;
  if (!record.ok) record.issues.push("the shot was not proven to be of the running, lit transmission");
  // Then the sender's Stop, while it still runs.
  if (!after.state.round.stopReason && after.elapsed < after.state.round.durationMs - 3000) {
    await click('[data-episode="stop"]');
    const stopped = await page.waitForFunction(() => window.__vmQa.episode().state?.round?.stopReason ?? null, null, { polling: 250 }).then((handle) => handle.jsonValue());
    record.stop = { stopReason: stopped };
  }
} catch (error) {
  record.issues.push(`error: ${error.message.split("\n")[0]}`);
  record.ok = false;
} finally {
  writeFileSync(`${out}/record.json`, JSON.stringify(record, null, 1));
  console.log(JSON.stringify(record, null, 1));
  await browser.close();
  process.exit(record.ok ? 0 : 1);
}
