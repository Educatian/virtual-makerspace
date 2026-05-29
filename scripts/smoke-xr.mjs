/**
 * Quest-readiness smoke test.
 *
 * Loads the running dev server in headless Chromium (the same Blink engine the
 * Meta Quest Browser uses), and asserts the things that decide whether the app
 * "just works" on a Quest 2:
 *   1. The bundle boots (window.__VM is defined) with no console errors.
 *   2. The Havok physics wasm (~2 MB) is NOT fetched at runtime (physics is off).
 *   3. An immersive-vr WebXR session enters cleanly via the IWER emulator.
 *
 * USAGE:  URL=https://localhost:8081/ node scripts/smoke-xr.mjs
 * Requires the dev server (`npm run dev`) to be running.
 */
import { chromium } from "playwright";

const URL = process.env.URL ?? "https://localhost:8081/";

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
let havokFetched = false;

const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => pageErrors.push(String(err)));
page.on("requestfailed", (req) =>
  failedRequests.push(`${req.url()} — ${req.failure()?.errorText ?? "?"}`),
);
page.on("request", (req) => {
  if (/HavokPhysics/i.test(req.url())) havokFetched = true;
});

let booted = false;
let xrEntered = false;
let xrError = null;

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__VM !== undefined, { timeout: 20000 });
  booted = true;
  // Let asset loads + physics-init window pass so a stray Havok fetch would fire.
  await page.waitForTimeout(3500);

  // Enter an immersive-vr session through the IWER emulator (real WebXR path).
  const accepted = await page.evaluate(async () => {
    if (!window.IWER_DEVICE) return "no-iwer";
    await window.IWER_DEVICE.remote.acceptSession();
    return "accepted";
  });
  if (accepted === "accepted") {
    await page.waitForTimeout(2500);
    xrEntered = await page.evaluate(() => {
      const w = window.__VM?.world;
      return !!(w && w.session);
    });
  } else {
    xrError = accepted;
  }
} catch (e) {
  xrError = String(e);
}

await browser.close();

// Shader compiler notices from super-three are warnings, not errors; ignore any
// that slip through as info. Treat only real console errors / pageerrors as fatal.
const benign = (s) =>
  /X4008|X3081|floating point division by zero|comma expression/i.test(s);
const realConsoleErrors = consoleErrors.filter((s) => !benign(s));
const realFailedReqs = failedRequests.filter((u) => !/favicon/i.test(u));

const checks = [
  ["bundle boots (window.__VM)", booted],
  ["no console errors", realConsoleErrors.length === 0],
  ["no uncaught page errors", pageErrors.length === 0],
  ["no failed requests", realFailedReqs.length === 0],
  ["Havok wasm NOT fetched (physics off)", !havokFetched],
  ["immersive-vr session entered", xrEntered],
];

console.log("\n=== Quest-readiness smoke ===");
let allPass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) allPass = false;
}
if (realConsoleErrors.length) console.log("  console errors:", realConsoleErrors);
if (pageErrors.length) console.log("  page errors:", pageErrors);
if (realFailedReqs.length) console.log("  failed requests:", realFailedReqs);
if (xrError) console.log("  xr note:", xrError);
console.log(allPass ? "\nRESULT: PASS\n" : "\nRESULT: FAIL\n");
process.exit(allPass ? 0 : 1);
