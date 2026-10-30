// Resource-Limited Greenhouse, same-device peer tabs (no room server): a reset in one tab and a
// concurrent step of the old run in another — neither tab has seen the other's action — must end
// on the reset in BOTH tabs, whichever tab's message is delivered first. Two real tabs (one
// browser, BroadcastChannel), the real panel buttons; the QA hook only holds each tab's outgoing
// peer messages until both actions are taken, then releases them in a chosen order.
//
//   npm run build && (cd dist && python3 -m http.server 4173 --bind 127.0.0.1)
//   node scripts/e2e-greenhouse-peer.mjs http://127.0.0.1:4173 [results.json]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4173";
const resultsPath = process.argv[3] ?? null;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
const run = (page) => page.evaluate(() => window.__vmQa.greenhouse().panel.run);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await instrument(context);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  const room = `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
  const open = async (name) => {
    const page = await context.newPage();
    page.setDefaultTimeout(240_000);
    page.errors = [];
    page.on("pageerror", (error) => page.errors.push(error.message));
    await page.goto(`${base}/?room=${room}&name=${name}&studio=greenhouse&qa=1&condition=DI`);
    await page.click("#enter-room");
    await page.waitForFunction(() => Boolean(window.__vmQa?.greenhouse?.().panel?.run), null, { timeout: 300_000, polling: 500 });
    await settled(page, `${name} entered`);
    return page;
  };
  const a = await open("TabA");
  const z = await open("TabZ");
  for (const [round, firstReleased] of [[1, "a"], [2, "z"]]) {
    // Both tabs on the same run first.
    await sleep(1500);
    const start = [await run(a), await run(z)];
    check(`round ${round}: both tabs start on the same run`, start[0].runId === start[1].runId && start[0].tick === start[1].tick, JSON.stringify(start.map((r) => [r.runId, r.status, r.tick])));
    await a.evaluate(() => window.__vmQa.holdPeer(true));
    await z.evaluate(() => window.__vmQa.holdPeer(true));
    // Tab a: reset to practice seed 7 (the dialog); tab z: step the old run one hour.
    await a.locator('.discussion-tab[data-tab="greenhouse"]').click();
    await a.locator("#gh-reset").click();
    await a.locator('.gh-reset-dialog input[value="practice"]').check();
    await a.locator('.gh-reset-dialog input[name="gh-seed"]').fill(String(5 + round));
    await a.locator('.gh-reset-dialog button[type="submit"]').click();
    await z.locator('.discussion-tab[data-tab="greenhouse"]').click();
    await z.locator("#gh-step").click();
    await sleep(800);
    const local = [await run(a), await run(z)];
    check(`round ${round}: before delivery, tab a holds its reset (new run) and tab z its step of the old run`, local[0].runId === start[0].runId + 1 && local[1].runId === start[0].runId && local[1].tick === start[1].tick + 4, JSON.stringify(local.map((r) => [r.runId, r.seed, r.tick])));
    const [first, second] = firstReleased === "a" ? [a, z] : [z, a];
    await first.evaluate(() => window.__vmQa.holdPeer(false));
    await sleep(600);
    await second.evaluate(() => window.__vmQa.holdPeer(false));
    await sleep(2500);
    const end = [await run(a), await run(z)];
    check(`round ${round} (tab ${firstReleased}'s message delivered first): both tabs end on the reset — run ${start[0].runId + 1}, practice seed ${5 + round}, 06:00 — never back on the stepped old run`, end.every((r) => r.runId === start[0].runId + 1 && r.seed === 5 + round && r.tick === 0), JSON.stringify(end.map((r) => [r.runId, r.seed, r.status, r.tick])));
  }
  check("no page errors", a.errors.length === 0 && z.errors.length === 0, [...a.errors, ...z.errors].join(" | "));
} catch (error) {
  check("run completed", false, String(error?.message ?? error).split("\n")[0]);
} finally {
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`e2e greenhouse peer: ${passed}/${results.length} checks passed`);
  if (resultsPath) writeFileSync(resultsPath, JSON.stringify({ results }, null, 1));
  process.exitCode = passed === results.length ? 0 : 1;
}
