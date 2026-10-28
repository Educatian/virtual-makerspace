// Render-cost probe (developer environment, SwiftShader): frames drawn per 90 s by 1 or 2 Snapino
// pages of one browser, workshop open, the rescue layout placed. Not a frame rate claim; a relative
// comparison of two builds on the same machine, run one after the other.
//
//   node scripts/qa-render-cost.mjs <base-url> <label> [pages=1] [out.json] [WIDTHxHEIGHT=1000x680]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base, label, pagesArg = "1", out, size = "1000x680"] = process.argv.slice(2);
const [vw, vh] = size.split("x").map(Number);
const extraArgs = (process.env.EXTRA_ARGS ?? "").split(" ").filter(Boolean);
const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server", ...extraArgs] });
// SEPARATE=1: every page in a browser process of its own (its own GPU process).
const browsers = [await launch()];
const browser = browsers[0];
const LAYOUT = { "sno-l1": [12, 30], "sno-w3": [30, 33], "sno-w2a": [33, 15] };
const room = `P${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
const pages = [];
for (let index = 0; index < Number(pagesArg); index += 1) {
  const owner = index > 0 && process.env.SEPARATE === "1" ? browsers[browsers.push(await launch()) - 1] : browser;
  const context = await owner.newContext({ viewport: { width: vw, height: vh } });
  await instrument(context);
  const page = await context.newPage();
  page.setDefaultTimeout(900_000);
  await page.goto(`${base}/?room=${room}&quality=low&qa`);
  await page.waitForSelector("#enter-room", { state: "attached" });
  await page.getByRole("radio", { name: /Snapino Bridge/ }).click();
  if (index === 0) await page.evaluate(() => { const box = document.querySelector("#lobby-episode"); if (box && !box.checked) box.click(); });
  const started = Date.now();
  await page.locator("#enter-room").click();
  await page.waitForFunction(() => Boolean(window.__vmQa?.place), null, { polling: 500 });
  await page.evaluate((entries) => { for (const [id, [a, b]] of Object.entries(entries)) window.__vmQa.place(id, a, b); }, LAYOUT);
  await settled(page, `${label} page ${index + 1}`, { budgetMs: 900_000 });
  console.log(`${label} page ${index + 1} ready in ${Math.round((Date.now() - started) / 1000)} s`);
  pages.push(page);
}
// PAUSE_OTHERS=1: every page but the first stops drawing (the ?qa drawing hook) while counting.
if (process.env.PAUSE_OTHERS === "1") for (const page of pages.slice(1)) await page.evaluate(() => window.__vmQa.drawing(false));
await Promise.all(pages.map((page) => page.evaluate(() => { window.__probeFrames = 0; const tick = () => { window.__probeFrames += 1; requestAnimationFrame(tick); }; requestAnimationFrame(tick); window.__probeStart = performance.now(); })));
await new Promise((resolve) => setTimeout(resolve, 90_000));
const result = { label, pages: [] };
const counts = await Promise.all(pages.map((page) => page.evaluate(() => ({ frames: window.__probeFrames, seconds: (performance.now() - window.__probeStart) / 1000, stats: window.__vmQa.stats?.() }))));
for (const frames of counts) {
  result.pages.push(frames);
  console.log(`${label}: ${frames.frames} frames in ${frames.seconds.toFixed(0)} s; ${frames.stats?.calls} calls, ${frames.stats?.triangles} triangles`);
}
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
await Promise.all(browsers.map((own) => own.close()));
