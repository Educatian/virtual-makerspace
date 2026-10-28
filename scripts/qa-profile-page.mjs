// CPU profile of one idle Snapino page (workshop open, lamp seated) for 40 s: where its time goes.
// Developer environment (SwiftShader); a diagnosis aid, not a performance claim.
//
//   node scripts/qa-profile-page.mjs <base-url> <out.json> [WIDTHxHEIGHT=800x544]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";
const [base, out, size = "800x544"] = process.argv.slice(2);
const [vw, vh] = size.split("x").map(Number);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
const context = await browser.newContext({ viewport: { width: vw, height: vh } });
await instrument(context);
const page = await context.newPage();
page.setDefaultTimeout(900_000);
await page.goto(`${base}/?room=PRF${Math.floor(Math.random()*9)}&quality=low&qa`);
await page.waitForSelector("#enter-room", { state: "attached" });
await page.getByRole("radio", { name: /Snapino Bridge/ }).click();
await page.evaluate(() => { const box = document.querySelector("#lobby-episode"); if (box && !box.checked) box.click(); });
await page.locator("#enter-room").click();
await page.waitForFunction(() => Boolean(window.__vmQa?.place), null, { polling: 500 });
await page.evaluate(() => { for (const [id, [a, b]] of Object.entries({ "sno-l1": [12, 30], "sno-w3": [30, 33], "sno-w2a": [33, 15] })) window.__vmQa.place(id, a, b); });
await settled(page, "profile page", { budgetMs: 900_000 });
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
await page.evaluate(() => { window.__f = 0; const t = () => { window.__f++; requestAnimationFrame(t); }; requestAnimationFrame(t); });
await cdp.send("Profiler.start");
await new Promise((r) => setTimeout(r, 40_000));
const { profile } = await cdp.send("Profiler.stop");
const frames = await page.evaluate(() => window.__f);
// self time per function
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas; let total = 0;
profile.samples.forEach((id, i) => { const n = byId.get(id); const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; const d = dt[i] / 1000; total += d; self.set(key, (self.get(key) ?? 0) + d); });
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
const result = { frames, seconds: 40, totalSampledMs: Math.round(total), top: top.map(([k, v]) => [k, Math.round(v)]) };
console.log(JSON.stringify(result, null, 1));
writeFileSync(out, JSON.stringify(result, null, 1));
await browser.close();
