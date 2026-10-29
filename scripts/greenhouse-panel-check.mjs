// Resource-Limited Greenhouse: the dock panel's personal record and run-control answers, in a real
// browser (headless Chromium), with the real GreenhousePanel bundled from source and a scripted
// host (no room server): the host decides each action's answer and hands the panel the room's
// run states, so the review counterexamples are reproduced exactly.
//
//   node scripts/greenhouse-panel-check.mjs [results.json]      (GH_SOURCE_ROOT=<dir> to test other source)
//
// A. Participation: a day that had already finished when this learner arrived (an earlier team's,
//    or one that ended while they were away) is the room's result, not their attempt; it never
//    unlocks the PF notes or writes their `test` trace. A day they were present for before its end
//    is theirs — also after a studio switch (a new panel) or a reconnect.
// B. Answers: a run control whose answer did not arrive is confirmed only by a run state that
//    names its op id; a teammate's action, however similar, never confirms it.
import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// GH_SOURCE_ROOT: another checkout's source (e.g. the code before the fix) to show these checks fail there.
const repo = fileURLToPath(new URL("..", import.meta.url));
const root = process.env.GH_SOURCE_ROOT ? resolve(process.env.GH_SOURCE_ROOT) : repo;
const out = mkdtempSync(join(tmpdir(), "gh-panel-check-"));
const resultsPath = process.argv[2] ?? null;
writeFileSync(join(out, "entry.ts"), `
import { GreenhousePanel } from ${JSON.stringify(join(root, "src/greenhouse/gh-panel.ts"))};
import { deriveRig, GH_MODEL } from ${JSON.stringify(join(root, "cloudflare/greenhouse-model.js"))};
import { initialRun, reduceGreenhouseRun, settle, STEP_MS } from ${JSON.stringify(join(root, "cloudflare/greenhouse-run.js"))};
const LINES = { "irrigation-hose": [0, 1], "irrigation-hose-2": [2, 3], "irrigation-hose-3": [4, 6], "irrigation-hose-4": [5, 7], "power-cable-1": [8, 9], "power-cable-2": [10, 12], "power-cable-3": [11, 13], "soil-sensor": [14, 15] };
const rigWith = (valveA, valveB, pumpBelow, fanAbove) => deriveRig((id) => id === "valve-manifold" ? { props: { valveA, valveB } } : id === "farm-controller" ? { props: { pumpBelow, fanAbove } } : LINES[id] ? { sockets: LINES[id] } : null);
const rig = rigWith(100, 100, 50, 30);
const worked = rigWith(30, 50, 60, 26);
const h = (window as any).h = {
  clock: 1_000_000,
  traces: [] as string[],
  answers: [] as Array<(value: unknown) => void>,
  selects: [] as string[],
  sent: [] as unknown[],
  panel: null as GreenhousePanel | null,
  rig, worked, STEP_MS, steps: GH_MODEL.steps,
  initialRun, reduceGreenhouseRun, settle,
  mount(condition: "PF" | "DI", room: string, active: boolean) {
    document.body.innerHTML = GreenhousePanel.hudMarkup() + GreenhousePanel.markup();
    h.panel?.dispose();
    const panel = new GreenhousePanel({
      workbench: () => null, condition: () => condition, roomCode: () => room,
      serverTime: () => h.clock,
      action: (action) => { h.sent.push(action); return new Promise((resolve) => h.answers.push(resolve as (value: unknown) => void)); },
      selectedId: () => null, select: (id) => { h.selects.push(id); }, holderOf: () => null,
      submit: async () => ({ ok: true, reason: null }), returnHome: async () => true,
      trace: (action, detail) => { h.traces.push(action + " " + detail); },
      status: () => undefined, confirm: async () => true, showTab: () => undefined, active: () => active,
    });
    panel.bind();
    panel.setRig(rig);
    h.panel = panel;
    return true;
  },
  state: () => h.panel!.qaState(),
  useRig(name: "default" | "worked") { h.rig = name === "worked" ? worked : rig; h.panel!.setRig(h.rig); },
  /** Answers the oldest pending action. */
  answer(value: unknown) { const resolve = h.answers.shift(); if (!resolve) throw new Error("no pending action"); resolve(value); },
};
`);
await build({ entryPoints: [join(out, "entry.ts")], bundle: true, format: "esm", outfile: join(out, "bundle.js"), platform: "browser", logLevel: "error", loader: { ".ts": "ts" }, nodePaths: [join(repo, "node_modules")] });
console.log(`panel source: ${root === repo ? "this checkout" : root}`);
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>gh panel check</title><body></body><script type="module" src="bundle.js"></script>`);
const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const name = path === "/" ? "index.html" : path.slice(1);
  try {
    const body = readFileSync(join(out, name));
    res.writeHead(200, { "content-type": name.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
/** A section that throws (e.g. an element the code under test lacks) is a recorded failure; the run goes on. */
const guard = async (name, fn) => {
  try {
    await fn();
  } catch (error) {
    check(`${name} section completed`, false, String(error?.message ?? error).split("\n")[0]);
  }
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [];
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(30_000);
  const fresh = async (condition, room, active = false) => {
    await page.goto(`${base}?r=${room}`);
    await page.waitForFunction(() => Boolean(window.h));
    await page.evaluate(([c, r, a]) => window.h.mount(c, r, a), [condition, room, active]);
  };
  const settleFrames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const state = async () => { await settleFrames(); return page.evaluate(() => window.h.state()); };
  // Run states, built with the real reducer (the room's code) in the page.
  const runAt = (spec) => page.evaluate((spec) => {
    const h = window.h;
    let run = h.initialRun(spec.seed ?? 11);
    run = { ...run, runId: spec.runId ?? 1 };
    if (spec.start !== undefined) run = h.reduceGreenhouseRun(run, { type: "start" }, spec.start, h.rig).run;
    if (spec.settleAt !== undefined) run = h.settle(run, spec.settleAt, h.rig);
    return run;
  }, spec);
  const setRun = (run, cause = null) => page.evaluate(([run, cause]) => window.h.panel.setRun(run, cause), [run, cause]);
  const setClock = (ms) => page.evaluate((ms) => { window.h.clock = ms; }, ms);
  const traces = () => page.evaluate(() => window.h.traces.slice());
  const END = 2500 * 96 + 500;

  // ── A. Participation ──
  // A1: the review counterexample. A fresh, inactive PF panel, zero learner actions, joins a room
  // whose day already ended (the room's run still running/tick 0; its clock past the end).
  await fresh("PF", "A1");
  await setClock(1_000_000 + END);
  await setRun(await runAt({ start: 1_000_000 }));
  let s = await state();
  check("A1 PF learner joining a room whose day already ended (unsettled run): the day is shown as over", s.shown?.tick === 96, `tick ${s.shown?.tick}`);
  check("A1 that day is not this learner's attempt: no result, PF notes still locked, no personal test trace", s.resultRun === null && s.notesUnlocked === false && !(await traces()).some((t) => t.startsWith("test")), JSON.stringify({ resultRun: s.resultRun, notesUnlocked: s.notesUnlocked, afterRun: s.afterRun, liveRuns: s.liveRuns, traces: await traces() }));
  const a1Copy = await page.locator("#gh-run-summary").textContent();
  check("A1 the attempt card says the shown day finished without this learner (the room's result)", /finished without you/.test(a1Copy ?? ""), a1Copy ?? "");
  // A2: the same with the room's run already settled (status ended), DI as well.
  for (const condition of ["PF", "DI"]) {
    await fresh(condition, `A2${condition}`);
    await setClock(1_000_000 + END);
    await setRun(await runAt({ start: 1_000_000, settleAt: 1_000_000 + END }));
    s = await state();
    check(`A2 ${condition}: joining after the day was settled as ended: no attempt result, no test trace${condition === "PF" ? ", notes locked" : ""}`, s.resultRun === null && !(await traces()).some((t) => t.startsWith("test")) && (condition === "DI" || s.notesUnlocked === false), JSON.stringify({ resultRun: s.resultRun, notesUnlocked: s.notesUnlocked, afterRun: s.afterRun }));
  }
  // A3: the learner was present while the day ran, then switched studio (the panel is rebuilt from
  // this tab's session) and came back after the end: their own day.
  await fresh("PF", "A3", true);
  await setClock(1_000_000 + 2500 * 10);
  const running = await runAt({ start: 1_000_000 });
  await setRun(running);
  s = await state();
  check("A3 present during the day (tick 10): the run is recorded as one this learner was present for", (s.liveRuns ?? []).includes(1) && s.afterRun === 0 && s.resultRun === null, JSON.stringify({ liveRuns: s.liveRuns, afterRun: s.afterRun }));
  await page.evaluate(() => window.h.mount("PF", "A3", false));
  await setClock(1_000_000 + END);
  await setRun(running);
  s = await state();
  check("A3 after a studio switch, the day they were present for ends: it is their attempt, notes unlock, one test trace", s.resultRun === 1 && s.notesUnlocked === true && (await traces()).filter((t) => t.startsWith("test")).length === 1, JSON.stringify({ resultRun: s.resultRun, notesUnlocked: s.notesUnlocked, traces: await traces() }));
  // A4: present, then a reconnect delivers the room's ended run (settled by the room).
  await fresh("PF", "A4", true);
  await setClock(1_000_000 + 2500 * 50);
  await setRun(await runAt({ start: 1_000_000 }));
  await setClock(1_000_000 + END + 9_000);
  await setRun(await runAt({ start: 1_000_000, settleAt: 1_000_000 + END }));
  s = await state();
  check("A4 present at tick 50, reconnected after the end: their attempt (run 1), notes unlocked", s.resultRun === 1 && s.notesUnlocked === true, JSON.stringify({ resultRun: s.resultRun, notesUnlocked: s.notesUnlocked }));
  // A5: after A1's observed day, the learner starts a new day (reset): that one is theirs.
  await fresh("PF", "A5", true);
  await setClock(1_000_000 + END);
  await setRun(await runAt({ start: 1_000_000 }));
  await page.locator("#gh-run-toggle").click();
  await page.locator('.gh-reset-dialog button[type="submit"]').click();
  await page.waitForFunction(() => window.h.answers.length === 1);
  const sentReset = await page.evaluate(() => window.h.sent.at(-1));
  await setRun(await runAt({ runId: 2 }), { opId: "x-reset", type: "reset" });
  await page.evaluate(() => window.h.answer({ ok: true, reason: null }));
  await setClock(2_000_000);
  await setRun(await runAt({ runId: 2, start: 2_000_000 }));
  await setClock(2_000_000 + END);
  await page.evaluate(() => window.h.panel.refresh());
  s = await state();
  check("A5 the observed day was not credited; after the learner's reset, the new day (run 2) is their attempt", sentReset?.type === "reset" && s.resultRun === 2 && s.notesUnlocked === true && (await traces()).filter((t) => t.startsWith("test")).length === 1, JSON.stringify({ sent: sentReset, resultRun: s.resultRun, notesUnlocked: s.notesUnlocked }));
  // A6: a late joiner arriving while the day still runs (tick 95) was present before its end.
  await fresh("PF", "A6", true);
  await setClock(1_000_000 + 2500 * 95 + 10);
  await setRun(await runAt({ start: 1_000_000 }));
  await setClock(1_000_000 + END);
  await page.evaluate(() => window.h.panel.refresh());
  s = await state();
  check("A6 (boundary) a learner who arrived at tick 95, before the end, is credited with that day", s.resultRun === 1, JSON.stringify({ resultRun: s.resultRun, liveRuns: s.liveRuns }));

  // ── B. Answers ──
  // B1: the review counterexample: my reset to the brief's day (seed 11) times out; a teammate's
  // reset to practice seed 7 (run 2) arrives. That must not be reported as my reset.
  await fresh("DI", "B1", true);
  await setClock(1_000_000 + 2500 * 20);
  await setRun(await runAt({ start: 1_000_000, settleAt: 1_000_000 + 2500 * 20 }));
  await page.locator("#gh-reset").click();
  await page.locator('.gh-reset-dialog input[value="brief"]').check();
  await page.locator('.gh-reset-dialog button[type="submit"]').click();
  await page.waitForFunction(() => window.h.answers.length === 1);
  await page.evaluate(() => window.h.answer({ ok: false, reason: "timeout", opId: "op-mine" }));
  s = await state();
  check("B1 my reset's answer timed out: the outcome is uncertain (pending confirmation)", s.unconfirmed === "op-mine" && !/for everyone/.test(s.runNote ?? ""), s.runNote ?? "");
  await setRun(await runAt({ runId: 2, seed: 7 }), { opId: "op-theirs", type: "reset" });
  s = await state();
  check("B1 a teammate's reset to seed 7 (run 2) is never reported as my reset; the note names what the room now shows", s.unconfirmed === "op-mine" && !/Reset to the brief's day \(seed 11\): tank refilled to 40 L · for everyone/.test(s.runNote ?? "") && /not confirmed/.test(s.runNote ?? "") && /practice day seed 7, run 2/.test(s.runNote ?? ""), s.runNote ?? "");
  await setRun(await runAt({ runId: 2, seed: 7 }));
  s = await state();
  check("B1 a run state without a cause (a join or reconnect) does not confirm it either", s.unconfirmed === "op-mine" && /not confirmed/.test(s.runNote ?? ""), s.runNote ?? "");
  await setRun(await runAt({ runId: 3, seed: 11 }), { opId: "op-mine", type: "reset" });
  s = await state();
  check("B1 the room's state naming my op id confirms it (late answer)", s.unconfirmed === null && /for everyone in the room \(the room's answer arrived after the wait\)/.test(s.runNote ?? ""), s.runNote ?? "");
  // B2: the same for pause, resume, step and speed: a teammate's identical-looking action never confirms mine.
  const cases = [
    ["pause", "#gh-run-toggle", { start: 1_000_000 }, 1_000_000 + 2500 * 5, (r) => ({ ...r, status: "paused" })],
    ["resume", "#gh-run-toggle", { start: 1_000_000, settleAt: 1_000_000 + 2500 * 5 }, 1_000_000 + 2500 * 5, null],
    ["step", "#gh-step", { start: 1_000_000, settleAt: 1_000_000 + 2500 * 5 }, 1_000_000 + 2500 * 5, null],
    ["speed", '#gh-panel [data-speed="4"]', { start: 1_000_000 }, 1_000_000 + 2500 * 5, (r) => ({ ...r, speed: 4 })],
  ];
  for (const [type, selector, spec, clock, mutate] of cases) {
    await fresh("DI", `B2${type}`, true);
    await setClock(clock);
    let base = await runAt(spec);
    if (type === "resume" || type === "step") base = { ...base, status: "paused" };
    await setRun(base);
    await page.locator(selector).click();
    await page.waitForFunction(() => window.h.answers.length === 1);
    const sent = await page.evaluate(() => window.h.sent.at(-1));
    await page.evaluate(() => window.h.answer({ ok: false, reason: "timeout", opId: "mine" }));
    const theirs = mutate ? mutate(base) : type === "resume" ? { ...base, status: "running", anchorAt: clock } : { ...base, tick: base.tick };
    await setRun(theirs, { opId: "theirs", type });
    s = await state();
    check(`B2 ${type}: after my ${type} timed out, a teammate's ${type} does not confirm mine`, sent?.type === type && s.unconfirmed === "mine" && /not confirmed/.test(s.runNote ?? "") && !/for everyone in the room/.test(s.runNote ?? ""), `${s.runNote}`);
    await setRun(theirs, { opId: "mine", type });
    s = await state();
    check(`B2 ${type}: the state naming my op id confirms it`, s.unconfirmed === null && /answer arrived after the wait/.test(s.runNote ?? ""), `${s.runNote}`);
  }
  // ── C. The attempt's own record: saved explanation and fixed prediction ──
  const label = (value) => page.locator(`#gh-predictions input[value="${value}"] + span`).textContent();
  const typeInto = async (selector, text) => {
    await page.locator(selector).fill(text);
    await page.locator(selector).dispatchEvent("input");
  };
  await guard("C1", async () => {
  // C1: a passing day, explained and saved; then the draft is erased and changed.
  await fresh("DI", "C1", true);
  await page.evaluate(() => window.h.useRig("worked"));
  await page.locator('#gh-predictions input[value="meets"]').check();
  await typeInto("#gh-why", "Bed B gets the larger share.");
  await setClock(1_000_000 + 2500 * 10);
  await setRun(await runAt({ start: 1_000_000 }));
  await setClock(1_000_000 + END);
  await page.evaluate(() => window.h.panel.refresh());
  s = await state();
  check("C1 the worked allocation's day, which this learner was present for, meets the brief", s.verdict?.met === true && s.resultRun === 1, JSON.stringify(s.verdict?.met));
  const firstText = "Bed B dried less because valve B gets 50 %.";
  await typeInto("#gh-explain", firstText);
  await page.locator("#gh-explain-save").click();
  s = await state();
  check("C1 saved: the attempt is met and explained with the saved text", s.explained === true && s.savedExplanation === firstText && /brief met · explained/.test(await page.locator("#gh-pill").textContent()), JSON.stringify({ explained: s.explained, saved: s.savedExplanation }));
  await typeInto("#gh-explain", "");
  s = await state();
  const saveDisabledEmpty = await page.locator("#gh-explain-save").isDisabled();
  const statusEmpty = await page.evaluate(() => document.querySelector("#gh-explain-status")?.textContent ?? null);
  const pillEmpty = await page.locator("#gh-pill").textContent();
  check("C1 erasing the draft does not erase the saved explanation: it stays saved, the page says the draft differs", s.savedExplanation === firstText && s.draftExplanation === "" && s.explained === true && saveDisabledEmpty && /Edited since you saved it/.test(statusEmpty ?? ""), JSON.stringify({ saved: s.savedExplanation, draft: s.draftExplanation, explained: s.explained, pill: pillEmpty, status: statusEmpty }));
  const secondText = "Valve B at 50 % kept bed B above 30 % all afternoon.";
  await typeInto("#gh-explain", secondText);
  const saveEnabledChanged = !(await page.locator("#gh-explain-save").isDisabled());
  s = await state();
  check("C1 a changed draft is not saved until Save: the saved text is still the first one", saveEnabledChanged && s.savedExplanation === firstText, JSON.stringify({ saved: s.savedExplanation }));
  await page.locator("#gh-explain-save").click();
  s = await state();
  const reflects = (await traces()).filter((t) => t.startsWith("reflect")).length;
  check("C1 re-saving replaces the saved explanation (a second reflect trace)", s.savedExplanation === secondText && reflects === 2, JSON.stringify({ saved: s.savedExplanation, reflects }));
  await page.evaluate(() => window.h.mount("DI", "C1", true));
  await page.evaluate(() => window.h.useRig("worked"));
  await setRun(await runAt({ start: 1_000_000 }));
  s = await state();
  check("C1 after a session reload (panel rebuilt from this tab's storage): the saved explanation and the result are kept", s.savedExplanation === secondText && s.explained === true && s.resultRun === 1, JSON.stringify({ saved: s.savedExplanation, resultRun: s.resultRun }));
  });
  await guard("C2", async () => {
  // C2: the prediction is fixed when the day begins; later changes do not rewrite it.
  await fresh("DI", "C2", true);
  await page.locator('#gh-predictions input[value="dry"]').check();
  await typeInto("#gh-why", "Both valves wide open starve bed B.");
  await setClock(1_000_000 + 2500 * 6);
  await setRun(await runAt({ start: 1_000_000 }));
  s = await state();
  const disabledMid = await page.locator('#gh-predictions input[value="meets"]').isDisabled();
  await page.evaluate(() => { const input = document.querySelector('#gh-predictions input[value="meets"]'); input.checked = true; input.dispatchEvent(new Event("change", { bubbles: true })); });
  s = await state();
  check("C2 mid-day (tick 6): the prediction made before the day is fixed (dry, with its why); the choices are disabled and a forced change does not alter it", disabledMid && s.predicted?.prediction === "dry" && s.predicted?.why === "Both valves wide open starve bed B." && s.predicted?.runId === 1, JSON.stringify(s.predicted));
  await setClock(1_000_000 + END);
  await page.evaluate(() => window.h.panel.refresh());
  await settleFrames();
  const summaryAfter = await page.locator("#gh-run-summary").textContent();
  check("C2 the finished day's summary compares with the fixed prediction", summaryAfter?.includes(`You predicted: ${await label("dry")} (before the day began)`) === true, summaryAfter ?? "");
  await page.evaluate(() => { const input = document.querySelector('#gh-predictions input[value="meets"]'); input.checked = true; input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settleFrames();
  const summaryLater = await page.locator("#gh-run-summary").textContent();
  check("C2 a change after the result does not rewrite what was predicted", summaryLater === summaryAfter && (await state()).predicted?.prediction === "dry", summaryLater ?? "");
  await page.evaluate(() => window.h.mount("DI", "C2", true));
  await setRun(await runAt({ start: 1_000_000 }));
  await settleFrames();
  check("C2 after a session reload the same prediction and summary", (await state()).predicted?.prediction === "dry" && (await page.locator("#gh-run-summary").textContent()) === summaryAfter);
  });
  await guard("C3", async () => {
  // C3: no prediction before the day: none is invented.
  await fresh("DI", "C3", true);
  await setClock(1_000_000 + 2500 * 3);
  await setRun(await runAt({ start: 1_000_000 }));
  await setClock(1_000_000 + END);
  await page.evaluate(() => window.h.panel.refresh());
  s = await state();
  const summaryNone = await page.locator("#gh-run-summary").textContent();
  check("C3 no prediction made before the day: none is recorded or shown as made", s.predicted !== null && s.predicted.prediction === null && /no prediction was made before the day began/.test(summaryNone ?? ""), summaryNone ?? "");
  });
  await guard("C4", async () => {
  // C4: a new attempt predicts again.
  await page.locator("#gh-new-attempt").click();
  await page.locator('.gh-reset-dialog button[type="submit"]').click();
  await page.waitForFunction(() => window.h.answers.length === 1);
  await setRun(await runAt({ runId: 2 }), { opId: "c4", type: "reset" });
  await page.evaluate(() => window.h.answer({ ok: true, reason: null }));
  await settleFrames();
  s = await state();
  check("C4 a new attempt: no fixed prediction yet, and the choices are enabled again", s.attempt === 2 && s.predicted === null && !(await page.locator('#gh-predictions input[value="meets"]').isDisabled()), JSON.stringify({ attempt: s.attempt, predicted: s.predicted }));

  });
  await guard("D1", async () => {
  // ── D. Keyboard focus in the live connection list while the day runs at ×4 ──
  await fresh("DI", "D1", true);
  await setClock(1_000_000 + 2500 * 40);
  await setRun({ ...(await runAt({ start: 1_000_000 })) });
  await settleFrames();
  await page.locator('#gh-list button[data-select="irrigation-hose-2"]').focus();
  await page.keyboard.press("Tab");
  const focusedKey = await page.evaluate(() => { const el = document.activeElement; el.dataset.qaMark = "kept"; return el.getAttribute("data-select"); });
  const before = await page.locator("#gh-list").textContent();
  for (let k = 1; k <= 12; k += 1) {
    await setClock(1_000_000 + 2500 * (40 + k));
    await page.evaluate(() => window.h.panel.refresh());
    await settleFrames();
  }
  const after = await page.locator("#gh-list").textContent();
  const still = await page.evaluate(() => ({ key: document.activeElement?.getAttribute("data-select"), mark: document.activeElement?.dataset?.qaMark ?? null }));
  check("D1 the list's flow values changed over 12 steps while a list button had keyboard focus", before !== after, `${before?.length} → ${after?.length} chars`);
  check("D1 keyboard focus stayed on the same button (the same element) through those updates", still.key === focusedKey && still.mark === "kept" && focusedKey === "irrigation-hose-3", JSON.stringify({ focusedKey, still }));
  await page.keyboard.press("Enter");
  check("D1 Enter on it still works: it selects that part", (await page.evaluate(() => window.h.selects.at(-1))) === "irrigation-hose-3");
  });
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  server.close();
}
const passed = results.filter((r) => r.ok).length;
console.log(`greenhouse panel: ${passed}/${results.length} checks passed`);
if (resultsPath) writeFileSync(resultsPath, JSON.stringify({ results }, null, 1));
if (passed !== results.length) process.exitCode = 1;
