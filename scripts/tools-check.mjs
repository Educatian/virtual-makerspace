// Exact-code checks for WorkbenchTools (src/desktop/workbench-tools.ts) with a stub DOM, a fake
// scene and a fake room that behaves like the room core (accepted edits apply to every peer):
//   1. importing a project whose program is already running stops it (same parts or changed
//      parts, one atomic edit), on this client and on a teammate;
//   2. edited values on parts left in the tray survive autosave → reload → recovery, while a
//      bench entirely at its defaults still clears the saved copy.
//   node --experimental-strip-types scripts/tools-check.mjs
import assert from "node:assert/strict";

// ── Minimal browser surface ───────────────────────────────────────────────────────────────
const storage = new Map();
const banner = { hidden: true, innerHTML: "", onclick: null };
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = { setTimeout: () => 0, clearTimeout: () => undefined, matchMedia: () => ({ matches: false }) };
globalThis.document = { querySelector: (selector) => (selector === "#recovery-banner" ? banner : null) };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => undefined;

const { WorkbenchTools } = await import("../src/desktop/workbench-tools.ts");
const { buildProject } = await import("../src/desktop/project-file.ts");

let checks = 0;
const ok = (value, label) => { checks += 1; assert.ok(value, label); };
const eq = (a, b, label) => { checks += 1; assert.deepEqual(a, b, label); };

const DEFAULT_PROPS = { "resistor-1k": { ohms: 1000 }, "resistor-220": { ohms: 220 }, "battery-9v": { volts: 9 } };
const CATALOGS = {
  circuit: { studio: "circuit", parts: { "resistor-1k": "resistor", "resistor-220": "resistor", "battery-9v": "battery", "led-red": null }, socketCount: 192, switches: [], sharedSockets: false },
  snapino: { studio: "snapino", parts: { "sno-l1": null, "sno-w3": null, "sno-s1": null }, socketCount: 63, switches: ["sno-s1"], sharedSockets: true },
};
const home = (id) => ({ position: [id.length, 0.48, 3], rotation: [0, 0, 0], sockets: null });
const seatedAt = (sockets) => ({ position: [0, 0.48, 0], rotation: [0, 0, 0], sockets });

/** A shared room: one authoritative bench + program; every client is a view of it. */
class FakeRoom {
  constructor(studio) {
    this.bench = {};
    for (const id of Object.keys(CATALOGS[studio].parts)) {
      this.bench[id] = { ...home(id), ...(DEFAULT_PROPS[id] ? { props: { ...DEFAULT_PROPS[id] } } : {}), ...(CATALOGS[studio].switches.includes(id) ? { on: false } : {}) };
    }
    this.program = { program: [], running: false };
    this.operations = [];
  }
  client(studio, name) {
    const room = this;
    const workbench = {
      getSharedTransforms: () => structuredClone(room.bench),
      studioCatalog: (s) => CATALOGS[s] ?? null,
      placementTransform: (id, sockets) => ({ ...seatedAt([sockets[0], sockets[1]]), ...(room.bench[id].props ? { props: room.bench[id].props } : {}) }),
      homeTransform: (id) => ({ ...home(id), ...(room.bench[id].props ? { props: room.bench[id].props } : {}) }),
      defaultTransform: (id) => ({ ...home(id), ...(DEFAULT_PROPS[id] ? { props: DEFAULT_PROPS[id] } : {}) }),
      defaultPartProps: (id) => (DEFAULT_PROPS[id] ? { ...DEFAULT_PROPS[id] } : null),
    };
    const statuses = [];
    const desktopRoom = {
      submitEdit: async (changes, program) => {
        room.operations.push({ by: name, changes: changes.map((change) => change.id), program: program ? structuredClone(program) : null });
        for (const { id, transform } of changes) room.bench[id] = { ...room.bench[id], ...structuredClone(transform) };
        if (program) room.program = { program: structuredClone(program.program), running: program.running };
        return { ok: true };
      },
      recordTrace: () => undefined,
    };
    const tools = new WorkbenchTools({
      workbench: () => workbench,
      room: () => desktopRoom,
      studio: () => studio,
      phase: () => "build",
      roomCode: () => "TEST",
      holderOf: () => null,
      boltBuilding: () => false,
      roomProgram: () => structuredClone(room.program),
      draftProgram: () => null,
      loadDraft: () => undefined,
      status: (message) => statuses.push(message),
      selected: () => null,
    });
    return { tools, statuses, workbench };
  }
}

// ── 1. Importing the already-running program stops it ─────────────────────────────────────
const Q = [{ op: "write", pin: "D5", value: true }, { op: "wait", ms: 500 }];
for (const variant of ["same parts", "changed parts"]) {
  const room = new FakeRoom("snapino");
  const A = room.client("snapino", "A");
  const B = room.client("snapino", "B");
  room.bench["sno-l1"] = { ...room.bench["sno-l1"], ...seatedAt([5, 30]) };
  room.program = { program: structuredClone(Q), running: true }; // Q uploaded and running
  const exported = buildProject(CATALOGS.snapino, A.workbench.getSharedTransforms(), Q);
  if (variant === "changed parts") exported.parts.find((part) => part.id === "sno-w3").sockets = [30, 33];
  const undoBefore = A.tools.history.canUndo;
  const accepted = await A.tools.importText(JSON.stringify(exported), false);
  ok(accepted, `${variant}: the import is accepted`);
  eq(room.operations.length, 1, `${variant}: exactly one room edit (atomic)`);
  const [operation] = room.operations;
  eq(operation.program, { program: Q, running: false }, `${variant}: the edit carries an authoritative stop of the same program`);
  eq(operation.changes, variant === "changed parts" ? ["sno-w3"] : [], `${variant}: parts and stop travel in the same batch`);
  eq(room.program, { program: Q, running: false }, `${variant}: the room's program is stopped`);
  eq(B.tools.host.roomProgram().running, false, `${variant}: so is the teammate's (it reads the room's running flag)`);
  ok(!A.statuses.some((message) => /nothing to change/.test(message)), `${variant}: never reported as "nothing to change"`);
  if (variant === "same parts") {
    ok(A.statuses.some((message) => /same program, now stopped for everyone/.test(message)), "same parts: the status says what the room accepted");
    eq(A.tools.history.canUndo, undoBefore, "same parts: a stop alone adds no undo step (Run/Stop is not edit history)");
  } else {
    ok(A.tools.history.canUndo, "changed parts: the part change is one undo step");
    ok(A.statuses.some((message) => /program stopped/.test(message)), "changed parts: the status mentions the stop");
  }
}
{
  // Not running, same statements, same parts: genuinely nothing to send.
  const room = new FakeRoom("snapino");
  const A = room.client("snapino", "A");
  room.program = { program: structuredClone(Q), running: false };
  await A.tools.importText(JSON.stringify(buildProject(CATALOGS.snapino, A.workbench.getSharedTransforms(), Q)), false);
  eq(room.operations.length, 0, "a stopped identical program and bench sends nothing");
  ok(A.statuses.some((message) => /nothing to change/.test(message)), "and says so");
}
{
  // New statements while running: loaded stopped, and the statement change is undoable.
  const room = new FakeRoom("snapino");
  const A = room.client("snapino", "A");
  room.program = { program: structuredClone(Q), running: true };
  const T = [{ op: "write", pin: "D6", value: true }];
  await A.tools.importText(JSON.stringify(buildProject(CATALOGS.snapino, A.workbench.getSharedTransforms(), T)), false);
  eq(room.program, { program: T, running: false }, "a different program is loaded stopped");
  ok(A.tools.history.canUndo, "and is one undo step");
}

// ── 2. Edited values on parts in the tray survive autosave and recovery ────────────────────
{
  const room = new FakeRoom("circuit");
  const A = room.client("circuit", "A");
  A.tools.recoveryChecked = true; // (set by offerRecovery after joining)
  const key = "vm-project:TEST:circuit";
  storage.set(key, "stale");
  // Every part in the tray; the resistor's value edited 1000 → 470 (as the inspector does).
  room.bench["resistor-1k"] = { ...room.bench["resistor-1k"], props: { ohms: 470 } };
  A.tools.autosave();
  ok(storage.has(key), "a tray-only 470 Ω edit is saved, not deleted as empty");
  const saved = JSON.parse(storage.get(key));
  eq(saved.parts.find((part) => part.id === "resistor-1k"), { id: "resistor-1k", sockets: null, props: { ohms: 470 } }, "the saved project holds the off-board 470 Ω");
  // Reload into a room whose bench is back at its defaults: recovery is offered and restores 470 Ω.
  const fresh = new FakeRoom("circuit");
  const B = fresh.client("circuit", "B");
  banner.hidden = true;
  B.tools.offerRecovery();
  ok(!banner.hidden, "recovery is offered for the off-board value");
  await banner.onclick({ target: { closest: () => ({ dataset: { recovery: "restore" } }) } });
  eq(fresh.bench["resistor-1k"].props, { ohms: 470 }, "restoring brings 470 Ω back");
  // Setting it back to the default value: the bench is truly empty again and the copy is cleared.
  room.bench["resistor-1k"] = { ...room.bench["resistor-1k"], props: { ohms: 1000 } };
  A.tools.autosave();
  ok(!storage.has(key), "a bench entirely at its defaults still clears the saved copy");
  // Unseating the last part while keeping an edited battery voltage keeps the save.
  room.bench["battery-9v"] = { ...room.bench["battery-9v"], ...seatedAt([21, 23]), props: { volts: 5 } };
  A.tools.autosave();
  room.bench["battery-9v"] = { ...room.bench["battery-9v"], ...home("battery-9v") };
  A.tools.autosave();
  ok(storage.has(key) && JSON.parse(storage.get(key)).parts.find((part) => part.id === "battery-9v").props.volts === 5, "unseating the last part keeps its edited 5 V");
  // Nothing worth offering when the saved copy matches defaults: no banner.
  storage.set(key, JSON.stringify(buildProject(CATALOGS.circuit, new FakeRoom("circuit").bench)));
  banner.hidden = true;
  new FakeRoom("circuit").client("circuit", "C").tools.offerRecovery();
  ok(banner.hidden, "a default-only saved copy is never offered");
}

// ── 3. Episode 1 design: exported, saved, imported after the atomic edit, refusals reported ─
{
  const room = new FakeRoom("snapino");
  const A = room.client("snapino", "A");
  let design = { mission: "ridge", intent: ["INJURED", "NORTH"] };
  const applied = [];
  let allow = true;
  A.tools.host.episodeDesign = () => design;
  A.tools.host.applyEpisodeDesign = async (next) => { applied.push({ ...next, afterOperations: room.operations.length }); if (allow) design = next; return allow; };
  room.bench["sno-l1"] = { ...room.bench["sno-l1"], ...seatedAt([12, 30]) };
  const exported = A.tools.currentProject();
  eq(exported.episode, { id: "rescue-signal", v: 1, mission: "ridge", intent: ["INJURED", "NORTH"] }, "export carries the workshop design");
  A.tools.recoveryChecked = true;
  A.tools.autosave();
  eq(JSON.parse(storage.get("vm-project:TEST:snapino")).episode.intent, ["INJURED", "NORTH"], "autosave keeps the design");
  // Import a different design with changed parts: the parts go first (one atomic edit), then the design.
  const file = { ...exported, parts: exported.parts.map((part) => (part.id === "sno-w3" ? { ...part, sockets: [30, 33] } : part)), episode: { id: "rescue-signal", v: 1, mission: "creek", intent: ["SAFE", "WATER"] } };
  room.operations.length = 0;
  ok(await A.tools.importText(JSON.stringify(file), false), "the import is accepted");
  eq(applied.at(-1), { mission: "creek", intent: ["SAFE", "WATER"], afterOperations: 1 }, "the design is applied after the parts edit");
  eq(design.intent, ["SAFE", "WATER"], "and takes effect");
  // The room refuses the design (e.g. not the sender, or a round is open): the learner is told.
  allow = false;
  A.statuses.length = 0;
  await A.tools.importText(JSON.stringify({ ...file, episode: { id: "rescue-signal", v: 1, mission: "storm", intent: ["HELP"] } }), false);
  ok(A.statuses.some((message) => /design was not applied/.test(message)), "a refused design is reported, not silently dropped");
  // A tampered design is refused by the parser before anything is sent.
  room.operations.length = 0;
  ok(!(await A.tools.importText(JSON.stringify({ ...file, episode: { id: "rescue-signal", v: 1, mission: "ridge", intent: ["HELLO"] } }), false)) && room.operations.length === 0, "a design with non-protocol words is refused before any edit");
}

console.log(`workbench tools: ${checks} checks passed`);
