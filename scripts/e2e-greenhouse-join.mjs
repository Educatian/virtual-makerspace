// Resource-Limited Greenhouse, same-device peer tabs: a tab that JOINS gets the run with the
// stamp of the revision the answering tab accepted — a copy is never a newer revision. The
// review counterexample (PR #6, app b8d099a), with three real tabs (one browser,
// BroadcastChannel), the real panel buttons, and the app's QA hold on outgoing peer messages:
//   1. A steps run 1 to tick 4; B accepts it.
//   2. B steps to tick 8; its update is held (not yet sent to A or C).
//   3. C joins; A answers with run 1 at tick 4.
//   4. B's update is delivered: all three tabs must end at tick 8 (b8d099a: A 8, B 8, C 4 — A
//      had restamped its copy for C above B's step, so C refused the step).
// Then a held reset (run 2) against a copy of the old run handed to a fourth joining tab D: all
// four end on the reset.
// The tie-break between equal Lamport counters is the participant id, so each tab's ids get a
// prefix (A "z", B "a", C "m", D "n") to make the counterexample's order deterministic.
//
//   npm run build && (cd dist && python3 -m http.server 4173 --bind 127.0.0.1)
//   node scripts/e2e-greenhouse-join.mjs http://127.0.0.1:4173 [results.json]
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4173";
const resultsPath = process.argv[3] ?? null;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  return Boolean(ok);
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
const run = (page) => page.evaluate(() => window.__vmQa.greenhouse().panel.run);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const brief = (r) => (r ? [r.runId, r.seed, r.status, r.tick] : null);
const pages = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await instrument(context);
  const room = `Q${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
  const open = async (name, prefix) => {
    const page = await context.newPage();
    page.setDefaultTimeout(240_000);
    page.errors = [];
    page.on("pageerror", (error) => page.errors.push(error.message));
    await page.addInitScript((prefix) => {
      const uuid = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
      crypto.randomUUID = () => `${prefix}${uuid().slice(1)}`;
    }, prefix);
    await page.goto(`${base}/?room=${room}&name=${name}&studio=greenhouse&qa=1&condition=DI`);
    await page.click("#enter-room");
    await page.waitForFunction(() => Boolean(window.__vmQa?.greenhouse?.().panel?.run), null, { timeout: 300_000, polling: 500 });
    await settled(page, `${name} entered`);
    await page.locator('.discussion-tab[data-tab="greenhouse"]').click();
    pages.push(page);
    return page;
  };
  const waitAll = async (tabs, test, timeout = 20_000) => {
    const started = Date.now();
    let runs = await Promise.all(tabs.map(run));
    while (!runs.every(test) && Date.now() - started < timeout) {
      await sleep(250);
      runs = await Promise.all(tabs.map(run));
    }
    return runs;
  };
  scenario: {
    const a = await open("TabA", "z");
    const b = await open("TabB", "a");
    const idle = await waitAll([a, b], (r) => r.runId === 1 && r.tick === 0);
    if (!check("A and B start on the brief's day, idle", idle.every((r) => r.runId === 1 && r.tick === 0 && r.status === "idle"), JSON.stringify(idle.map(brief)))) break scenario;
    await a.locator("#gh-step").click();
    const stepped = await waitAll([a, b], (r) => r.tick === 4);
    if (!check("1. A steps run 1 to tick 4; B accepts it", stepped.every((r) => r.runId === 1 && r.tick === 4), JSON.stringify(stepped.map(brief)))) break scenario;
    await b.evaluate(() => window.__vmQa.holdPeer(true));
    await b.locator("#gh-step").click();
    const held = await waitAll([b], (r) => r.tick === 8);
    await sleep(800);
    if (!check("2. B steps to tick 8 with its update held; A still at tick 4", held[0].tick === 8 && (await run(a)).tick === 4, JSON.stringify([brief(await run(a)), brief(held[0])]))) break scenario;
    const c = await open("TabC", "m");
    const joined = await waitAll([c], (r) => r.tick === 4, 10_000);
    if (!check("3. C joins and holds A's run 1 at tick 4", joined[0].runId === 1 && joined[0].tick === 4, JSON.stringify(joined.map(brief)))) break scenario;
    const released = await b.evaluate(() => window.__vmQa.holdPeer(false));
    const end = await waitAll([a, b, c], (r) => r.tick === 8, 10_000);
    check("4. B's held step is delivered: A, B and C all end at tick 8", end.every((r) => r.runId === 1 && r.tick === 8), `${released} held message(s) released · ${JSON.stringify(end.map(brief))}`);

    // A held reset (run 2) still wins over a copy of the old run handed to a joining tab.
    await b.evaluate(() => window.__vmQa.holdPeer(true));
    await b.locator("#gh-reset").click();
    await b.locator('.gh-reset-dialog input[value="practice"]').check();
    await b.locator('.gh-reset-dialog input[name="gh-seed"]').fill("7");
    await b.locator('.gh-reset-dialog button[type="submit"]').click();
    await a.locator("#gh-step").click();
    const before = await waitAll([a, c], (r) => r.tick === 12);
    const d = await open("TabD", "n");
    const dJoined = await waitAll([d], (r) => r.tick === 12, 10_000);
    check("5. B resets (run 2, held); A steps run 1 to tick 12; D joins with run 1 at tick 12", (await run(b)).runId === 2 && before.every((r) => r.runId === 1 && r.tick === 12) && dJoined[0].runId === 1 && dJoined[0].tick === 12, JSON.stringify([brief(await run(b)), ...before.map(brief), brief(dJoined[0])]));
    await b.evaluate(() => window.__vmQa.holdPeer(false));
    const reset = await waitAll([a, b, c, d], (r) => r.runId === 2, 10_000);
    check("6. B's held reset is delivered: all four tabs end on run 2, practice seed 7, 06:00", reset.every((r) => r.runId === 2 && r.seed === 7 && r.tick === 0), JSON.stringify(reset.map(brief)));
  }
  check("no page errors", pages.every((page) => page.errors.length === 0), pages.flatMap((page) => page.errors).join(" | "));
} catch (error) {
  check("run completed", false, String(error?.message ?? error).split("\n")[0]);
} finally {
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`e2e greenhouse join: ${passed}/${results.length} checks passed`);
  if (resultsPath) writeFileSync(resultsPath, JSON.stringify({ base, results }, null, 1));
  process.exitCode = passed === results.length ? 0 : 1;
}
