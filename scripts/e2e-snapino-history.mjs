// Snapino project history over the real Worker (Durable Object + WebSocket), two browsers:
// parts P + program S → import Q/T → Undo (P/S) → Redo (Q/T) on BOTH peers; a program-only
// import is one undo step; a stale undo never overwrites a teammate's newer program R; export
// keeps the room's program apart from an unsaved draft; autosave keeps program-only changes;
// recovery compares programs too.
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799
//   node scripts/e2e-snapino-history.mjs          # → http://vm.test:8800 (fresh random room)
//
// Running-state policy under test: import, undo and redo restore a program STOPPED.
//
// Every shared change is waited for on BOTH peers (the room answers the sender and relays to the
// teammate separately; the sender applies its own change only on that answer) and then for the
// importer's history, each bounded, with the timings in the output. The import/undo/redo
// sequence is dependent: at its first failed check the rest of it is reported NOT RUN instead of
// acting on the state that failure left. (Before d06712c's review round the script sampled the
// importer right after the teammate showed a change, and kept going after a failure.)
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `H${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8799", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const press = async (page, name) => {
  const handle = await page.waitForFunction((label) => [...document.querySelectorAll("button")].find((candidate) =>
    !candidate.disabled && (candidate.getAttribute("aria-label") === label || candidate.textContent.trim() === label)), name, { timeout: 120_000 });
  await handle.evaluate((button) => button.click());
};
const tap = (page, selector) => page.evaluate((s) => document.querySelector(s)?.click(), selector);
const until = async (read, test, timeout = 60_000) => {
  const started = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
};
const results = [];
/**
 * The checks of one dependent sequence: once one fails, the rest of that sequence is NOT RUN
 * (reported, and counted as not passed) instead of acting on a state the failure left behind.
 */
let blockedBy = null;
const check = (name, ok, detail = "") => {
  if (blockedBy) {
    results.push({ name, ok: false, notRun: true });
    console.log(`NOT RUN ${name} — prerequisite failed: ${blockedBy}`);
    return false;
  }
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) blockedBy = name;
  return ok;
};
const independent = () => { blockedBy = null; };

async function maker(email) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, acceptDownloads: true });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  return context;
}
async function open(context, label, chooseStudio = false) {
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  page.on("pageerror", (error) => console.error(`[${label}] pageerror:`, error.message));
  await page.goto(`${base}/?room=${room}&quality=low&qa`);
  if (chooseStudio) await page.getByRole("radio", { name: /Snapino Bridge/ }).click();
  await press(page, "Enter Room");
  await page.waitForSelector("#viewport-heading", { state: "attached" });
  await page.waitForFunction(() => Boolean(window.__vmQa?.bench), null, { timeout: 300_000 });
  await page.waitForTimeout(2500);
  return page;
}
const bench = (page) => page.evaluate(() => window.__vmQa.bench());
const partsKey = (state) => JSON.stringify(Object.entries(state.parts).filter(([, part]) => part.sockets).sort(([a], [b]) => a.localeCompare(b)));
const programKey = (state) => JSON.stringify(state.program);
const status = (page) => page.evaluate(() => document.querySelector("#scene-status-copy")?.textContent ?? "");
async function importProject(page, project) {
  await page.setInputFiles("#project-file-input", { name: "project.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project)) });
  const opened = await page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open, null, { timeout: 30_000 }).then(() => true, () => false);
  if (!opened) throw new Error(`import did not ask for confirmation: ${await status(page)}`);
  await tap(page, "#confirm-ok");
}

const hostContext = await maker("host@example.test");
const memberContext = await maker("member@example.test");
const host = await open(hostContext, "host", true);
const member = await open(memberContext, "member");

/**
 * Waits for a shared change on BOTH peers, then for the importer's history to be ready. The
 * room answers the sender and relays to the teammate separately (the sender applies its own
 * change only on that answer), so the teammate showing it says nothing about the importer yet:
 * each is waited for, bounded, and the timings are reported. The history bound is past the
 * client's 8 s edit timeout, so an answer that arrives after it still counts — the app now
 * records such a late answer — but a history that never follows still fails.
 */
const MEMBER_BOUND = 180_000;
const HOST_BOUND = 30_000;
const HISTORY_BOUND = 30_000;
async function converge(memberTest, hostTest, historyTest = () => true) {
  const started = Date.now();
  const atMember = await until(() => bench(member), memberTest, MEMBER_BOUND);
  const memberAt = Date.now();
  const hostFirst = await bench(host);
  const atHost = await until(() => bench(host), hostTest, HOST_BOUND);
  const hostAt = Date.now();
  const history = await until(() => bench(host), historyTest, HISTORY_BOUND);
  const historyAt = Date.now();
  const timing = `teammate ${memberAt - started} ms; importer ${hostTest(hostFirst) ? "already there" : `+${hostAt - memberAt} ms later`}; history ${historyTest(hostFirst) ? "already ready" : `+${historyAt - hostAt} ms`}`;
  return { member: atMember, host: atHost, history, memberOk: memberTest(atMember), hostOk: hostTest(atHost), historyOk: historyTest(history), timing };
}

// ── The dependent sequence: each step builds on the state the previous one checked ──
sequence: {
  if (!check("both makers are in the Snapino room", (await bench(host)).studio === "snapino" && (await bench(member)).studio === "snapino")) break sequence;

  // P/S: the lamp demo wiring (P) and the uploaded blink program (S).
  await press(host, "Load Snapino lamp");
  // The whole lamp wiring (one edit; the lamp itself seated), the same on both peers.
  const lampSeated = (state) => Boolean(state.parts["sno-l1"]?.sockets);
  const seated = await converge(lampSeated, lampSeated);
  if (!check("the lamp wiring P reaches both peers", seated.memberOk && seated.hostOk && partsKey(seated.member) === partsKey(seated.host), `${seated.timing} · ${partsKey(seated.member)}`)) break sequence;
  const P = seated.member;
  await press(host, "Run blocks");
  const ran = await converge((state) => state.running, (state) => state.running);
  const S = ran.member;
  const PS = { parts: partsKey(P), program: programKey(S) };
  if (!check("P/S reaches the teammate (wiring + running program)", ran.memberOk && ran.hostOk && partsKey(ran.host) === PS.parts && programKey(ran.host) === PS.program,
    `member ${PS.parts} ${PS.program} running=${S.running} · host ${partsKey(ran.host)} ${programKey(ran.host)} · ${ran.timing}`)) break sequence;

  // Q/T: the same parts with the lamp turned around, and a different program.
  const T = [{ op: "write", pin: "D6", value: true }, { op: "wait", ms: 300 }];
  const qParts = Object.entries(P.parts).map(([id, part]) => ({ id, sockets: id === "sno-l1" && part.sockets ? [part.sockets[1], part.sockets[0]] : part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
  const projectQT = { format: "virtual-makerspace.project", version: 1, solver: "dc-mna-1.0.0", studio: "snapino", savedAt: new Date().toISOString(), parts: qParts, program: T };
  const QTparts = partsKey({ parts: Object.fromEntries(qParts.map((part) => [part.id, { sockets: part.sockets }])) });
  const atQT = (state) => partsKey(state) === QTparts && programKey(state) === JSON.stringify(T);
  const atPS = (state) => partsKey(state) === PS.parts && programKey(state) === PS.program;
  await importProject(host, projectQT);
  const imported = await converge(atQT, atQT, (state) => state.canUndo);
  if (!check("import Q/T reaches both peers", imported.memberOk && imported.hostOk && QTparts !== PS.parts, `${imported.timing} · member ${partsKey(imported.member)} ${programKey(imported.member)} · host ${partsKey(imported.host)} ${programKey(imported.host)}`)) break sequence;
  if (!check("an imported program is loaded stopped (policy)", !imported.member.running && !imported.host.running)) break sequence;
  if (!check("the import is one undo step for the importer", imported.historyOk, `${imported.timing} · ${await status(host)}`)) break sequence;

  await tap(host, "#undo-edit");
  const undone = await converge(atPS, atPS, (state) => state.canRedo);
  if (!check("Undo restores P/S on the teammate", undone.memberOk, `${partsKey(undone.member).slice(0, 80)} · ${undone.timing}`)) break sequence;
  if (!check("Undo restores P/S on the importer", undone.hostOk, `${undone.timing} · ${await status(host)}`)) break sequence;
  if (!check("an undone program stays stopped (policy)", !undone.member.running && !undone.host.running)) break sequence;
  if (!check("the accepted undo is redoable for the importer", undone.historyOk, `${undone.timing} · ${await status(host)}`)) break sequence;

  await tap(host, "#redo-edit");
  const redone = await converge(atQT, atQT, (state) => state.canUndo);
  if (!check("Redo brings Q/T back on both peers", redone.memberOk && redone.hostOk && redone.historyOk, `${redone.timing} · ${await status(host)}`)) break sequence;

  // A program-only import (same parts, program U) is one undo step and an edit trace.
  const U = [{ op: "write", pin: "D3", value: true }];
  const atQU = (state) => partsKey(state) === QTparts && programKey(state) === JSON.stringify(U);
  const traceCount = () => host.evaluate((code) => (JSON.parse(localStorage.getItem(`vm-trace:${code}`) ?? "[]")).filter((trace) => trace.action === "edit" && /^Loaded a project/.test(trace.detail ?? "")).length, room);
  const editTracesBefore = await traceCount();
  await importProject(host, { ...projectQT, parts: qParts, program: U, savedAt: new Date().toISOString() });
  const programOnly = await converge(atQU, atQU, (state) => state.canUndo);
  if (!check("a program-only import reaches both peers", programOnly.memberOk && programOnly.hostOk, programOnly.timing)) break sequence;
  const traced = await until(traceCount, (count) => count === editTracesBefore + 1, 10_000);
  if (!check("and is traced as one edit", traced === editTracesBefore + 1, `${editTracesBefore} → ${traced} "Loaded a project" edit traces`)) break sequence;
  await tap(host, "#undo-edit");
  const backToT = await converge(atQT, atQT, (state) => state.canRedo);
  if (!check("its undo is exactly one step back to T", backToT.memberOk && backToT.hostOk && backToT.historyOk, `${backToT.timing} · ${await status(host)}`)) break sequence;

  // Stale undo: the teammate uploads R; the importer's undo (expects T) must not overwrite it.
  const R = [{ op: "write", pin: "D5", value: false }, { op: "wait", ms: 500 }, { op: "write", pin: "D5", value: true }];
  const atR = (state) => programKey(state) === JSON.stringify(R) && state.running;
  await member.evaluate((program) => window.__vmQa.editDraft(program), R);
  await press(member, "Run blocks");
  const uploaded = await converge(atR, atR);
  if (!check("the teammate's program R reaches both peers, running", uploaded.memberOk && uploaded.hostOk, uploaded.timing)) break sequence;
  await tap(host, "#undo-edit");
  // The importer's answer (refused locally or by the room) is its status; wait for it, bounded.
  await until(() => status(host), (copy) => /Can't undo|refused/.test(copy), HISTORY_BOUND);
  if (!check("a stale undo never overwrites the teammate's newer program R", programKey(await bench(host)) === JSON.stringify(R) && programKey(await bench(member)) === JSON.stringify(R), await status(host))) break sequence;
  if (!check("and the parts stay as the room has them", partsKey(await bench(member)) === QTparts && partsKey(await bench(host)) === QTparts)) break sequence;

  // Importing the program that is already running (same statements) stops it for everyone —
  // with the same parts (a stop alone) and with changed parts (parts + stop in one edit).
  if (!check("R is running on both peers before the import", (await bench(host)).running && (await bench(member)).running)) break sequence;
  const undoBeforeStop = (await bench(host)).canUndo;
  await importProject(host, { ...projectQT, parts: qParts, program: R, savedAt: new Date().toISOString() });
  const stoppedR = (state) => !state.running && programKey(state) === JSON.stringify(R) && partsKey(state) === QTparts;
  const stopSame = await converge(stoppedR, stoppedR);
  if (!check("same parts + same running program: the import stops it on the teammate", stopSame.memberOk, stopSame.timing)) break sequence;
  if (!check("and on the importer", stopSame.hostOk, `${stopSame.timing} · ${await status(host)}`)) break sequence;
  if (!check("a stop alone adds no undo step", (await bench(host)).canUndo === undoBeforeStop)) break sequence;
  await press(member, "Run blocks");
  const rerun = await converge(atR, atR);
  if (!check("R runs again on both peers", rerun.memberOk && rerun.hostOk, rerun.timing)) break sequence;
  const pParts = Object.entries(P.parts).map(([id, part]) => ({ id, sockets: part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
  await importProject(host, { ...projectQT, parts: pParts, program: R, savedAt: new Date().toISOString() });
  const stoppedP = (state) => !state.running && programKey(state) === JSON.stringify(R) && partsKey(state) === PS.parts;
  const stopChanged = await converge(stoppedP, stoppedP);
  if (!check("changed parts + same running program: parts and stop arrive together on the teammate", stopChanged.memberOk, stopChanged.timing)) break sequence;
  if (!check("and on the importer", stopChanged.hostOk, `${stopChanged.timing} · ${await status(host)}`)) break sequence;
}
// Everything after needs the room program R (the teammate's upload above); it is checked first.
independent();
const R = [{ op: "write", pin: "D5", value: false }, { op: "wait", ms: 500 }, { op: "write", pin: "D5", value: true }];
const T = [{ op: "write", pin: "D6", value: true }, { op: "wait", ms: 300 }];
check("(precondition for export, autosave and recovery) the room program is R on both peers", programKey(await bench(host)) === JSON.stringify(R) && programKey(await bench(member)) === JSON.stringify(R));

tail: {
  if (blockedBy) {
    for (const name of ["export carries the room's program (R) and the unsaved draft (D) separately", "autosave holds the latest room program and the draft", "rejoining after everyone left: the bench was reset but the room kept its program", "recovery is offered (saved parts and program differ from the room's)", "restoring brings back the saved parts and program as one edit"]) check(name, false);
    break tail;
  }
  // Export: the room's program and the importer's unsaved draft are kept apart.
  const D = [{ op: "follow", pin: "D5", invert: false }];
  await host.evaluate((program) => window.__vmQa.editDraft(program), D);
  const [download] = await Promise.all([host.waitForEvent("download"), tap(host, "#export-project")]);
  const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
  check("export carries the room's program (R) and the unsaved draft (D) separately", JSON.stringify(exported.program) === JSON.stringify(R) && JSON.stringify(exported.draftProgram) === JSON.stringify(D));

  // Autosave keeps program-only changes and the draft.
  const saved = await until(() => host.evaluate((code) => localStorage.getItem(`vm-project:${code}:snapino`), room), (text) => Boolean(text) && text.includes('"D3"') === false && text.includes('"follow"'));
  const savedProject = saved ? JSON.parse(saved) : null;
  check("autosave holds the latest room program and the draft", JSON.stringify(savedProject?.program) === JSON.stringify(R) && JSON.stringify(savedProject?.draftProgram) === JSON.stringify(D));

  // Recovery compares programs: same parts, different saved program → offered.
  const savedParts = partsKey(await bench(host));
  await memberContext.close();
  await host.evaluate(([code, program]) => {
    const key = `vm-project:${code}:snapino`;
    const project = JSON.parse(localStorage.getItem(key));
    project.program = program;
    delete project.draftProgram;
    localStorage.setItem(key, JSON.stringify(project));
  }, [room, T]);
  await host.close();
  const back = await open(hostContext, "host-again");
  const banner = await until(() => back.evaluate(() => !document.querySelector("#recovery-banner")?.hidden), Boolean, 20_000);
  const roomNow = await bench(back);
  check("rejoining after everyone left: the bench was reset but the room kept its program", !Object.values(roomNow.parts).some((part) => part.sockets) && programKey(roomNow) === JSON.stringify(R));
  check("recovery is offered (saved parts and program differ from the room's)", banner);
  await tap(back, '[data-recovery="restore"]');
  const restored = await until(() => bench(back), (state) => programKey(state) === JSON.stringify(T));
  check("restoring brings back the saved parts and program as one edit", partsKey(restored) === savedParts && programKey(restored) === JSON.stringify(T) && !restored.running);
}

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · room ${room}`);
assert.equal(failed.length, 0);
