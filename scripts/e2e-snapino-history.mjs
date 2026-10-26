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
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

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
check("both makers are in the Snapino room", (await bench(host)).studio === "snapino" && (await bench(member)).studio === "snapino");

// P/S: the lamp demo wiring (P) and the uploaded blink program (S).
// Two software-rendered WebGL pages on a small CI box: allow generous time for each round trip.
await press(host, "Load Snapino lamp");
await until(() => bench(host), (state) => Object.values(state.parts).some((part) => part.sockets), 90_000);
const P = await until(() => bench(member), (state) => Object.values(state.parts).some((part) => part.sockets), 90_000);
await press(host, "Run blocks");
const S = await until(() => bench(member), (state) => state.running, 90_000);
const PS = { parts: partsKey(P), program: programKey(S) };
const hostPS = await bench(host);
check("P/S reaches the teammate (wiring + running program)", partsKey(hostPS) === PS.parts && S.running && programKey(hostPS) === PS.program,
  `member ${PS.parts} ${PS.program} running=${S.running} · host ${partsKey(hostPS)} ${programKey(hostPS)}`);

// Q/T: the same parts with the lamp turned around, and a different program.
const T = [{ op: "write", pin: "D6", value: true }, { op: "wait", ms: 300 }];
const qParts = Object.entries(P.parts).map(([id, part]) => ({ id, sockets: id === "sno-l1" && part.sockets ? [part.sockets[1], part.sockets[0]] : part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
const projectQT = { format: "virtual-makerspace.project", version: 1, solver: "dc-mna-1.0.0", studio: "snapino", savedAt: new Date().toISOString(), parts: qParts, program: T };
await importProject(host, projectQT);
const afterImport = await until(() => bench(member), (state) => programKey(state) === JSON.stringify(T));
const QT = { parts: partsKey(afterImport), program: JSON.stringify(T) };
check("import Q/T reaches both peers", QT.parts !== PS.parts && partsKey(await bench(host)) === QT.parts && programKey(await bench(host)) === QT.program);
check("an imported program is loaded stopped (policy)", !afterImport.running && !(await bench(host)).running);
check("the import is one undo step for the importer", (await bench(host)).canUndo);

await tap(host, "#undo-edit");
const undone = await until(() => bench(member), (state) => programKey(state) === PS.program);
check("Undo restores P/S on the teammate", partsKey(undone) === PS.parts && programKey(undone) === PS.program, partsKey(undone).slice(0, 80));
check("Undo restores P/S on the importer", partsKey(await bench(host)) === PS.parts && programKey(await bench(host)) === PS.program);
check("an undone program stays stopped (policy)", !undone.running);

await tap(host, "#redo-edit");
const redone = await until(() => bench(member), (state) => programKey(state) === QT.program);
check("Redo brings Q/T back on both peers", partsKey(redone) === QT.parts && partsKey(await bench(host)) === QT.parts && programKey(await bench(host)) === QT.program);

// A program-only import (same parts, program U) is one undo step and an edit trace.
const U = [{ op: "write", pin: "D3", value: true }];
const traceCount = () => host.evaluate((code) => (JSON.parse(localStorage.getItem(`vm-trace:${code}`) ?? "[]")).filter((trace) => trace.action === "edit" && /^Loaded a project/.test(trace.detail ?? "")).length, room);
const editTracesBefore = await traceCount();
await importProject(host, { ...projectQT, parts: qParts, program: U, savedAt: new Date().toISOString() });
const afterU = await until(() => bench(member), (state) => programKey(state) === JSON.stringify(U));
check("a program-only import reaches the teammate", programKey(afterU) === JSON.stringify(U) && partsKey(afterU) === QT.parts);
const editTracesAfter = await traceCount();
check("and is traced as one edit", editTracesAfter === editTracesBefore + 1, `${editTracesBefore} → ${editTracesAfter} "Loaded a project" edit traces`);
await tap(host, "#undo-edit");
const backToT = await until(() => bench(member), (state) => programKey(state) === QT.program);
check("its undo is exactly one step back to T", programKey(backToT) === QT.program && partsKey(backToT) === QT.parts);

// Stale undo: the teammate uploads R; the importer's undo (expects T) must not overwrite it.
const R = [{ op: "write", pin: "D5", value: false }, { op: "wait", ms: 500 }, { op: "write", pin: "D5", value: true }];
await member.evaluate((program) => window.__vmQa.editDraft(program), R);
await press(member, "Run blocks");
await until(() => bench(host), (state) => programKey(state) === JSON.stringify(R));
await tap(host, "#undo-edit");
await host.waitForTimeout(1500);
check("a stale undo never overwrites the teammate's newer program R", programKey(await bench(host)) === JSON.stringify(R) && programKey(await bench(member)) === JSON.stringify(R), await status(host));
check("and the parts stay as the room has them", partsKey(await bench(member)) === QT.parts);

// Importing the program that is already running (same statements) stops it for everyone —
// with the same parts (a stop alone) and with changed parts (parts + stop in one edit).
check("R is running on both peers before the import", (await bench(host)).running && (await bench(member)).running);
const undoBeforeStop = (await bench(host)).canUndo;
await importProject(host, { ...projectQT, parts: qParts, program: R, savedAt: new Date().toISOString() });
const stoppedSame = await until(() => bench(member), (state) => !state.running);
check("same parts + same running program: the import stops it on the teammate", !stoppedSame.running && programKey(stoppedSame) === JSON.stringify(R) && partsKey(stoppedSame) === QT.parts);
check("and on the importer", !(await bench(host)).running && programKey(await bench(host)) === JSON.stringify(R), await status(host));
check("a stop alone adds no undo step", (await bench(host)).canUndo === undoBeforeStop);
await press(member, "Run blocks");
await until(() => bench(host), (state) => state.running);
const pParts = Object.entries(P.parts).map(([id, part]) => ({ id, sockets: part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
await importProject(host, { ...projectQT, parts: pParts, program: R, savedAt: new Date().toISOString() });
const stoppedChanged = await until(() => bench(member), (state) => !state.running && partsKey(state) === PS.parts);
check("changed parts + same running program: parts and stop arrive together on the teammate", !stoppedChanged.running && partsKey(stoppedChanged) === PS.parts && programKey(stoppedChanged) === JSON.stringify(R));
check("and on the importer", !(await bench(host)).running && partsKey(await bench(host)) === PS.parts);

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

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · room ${room}`);
assert.equal(failed.length, 0);
