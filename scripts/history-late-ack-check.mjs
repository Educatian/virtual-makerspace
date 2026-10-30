// Snapino project history when the room's answer to the SENDER comes late (after the client's
// 8 s edit timeout) while the teammate already has the change. Deterministic: the real RoomCore
// (cloudflare/room-core.js, with the room's edit sanitizer), the real DesktopRoom and SyncReplica
// in server mode (src/desktop/collaboration.ts, sync-replica.ts), the real EditHistory and
// WorkbenchTools (edit-history.ts, workbench-tools.ts), bundled with esbuild and run in node over
// a fake WebSocket whose deliveries keep order per socket (as TCP does) and can be delayed.
//
// The chain under test: the sender's answer arrives after EDIT_TIMEOUT_MS → its waiter resolved
// "timeout" and was removed → WorkbenchTools returned before history.record/commit → the late
// accepted answer applies the state, but nothing moves in the history. Three cases, each with
// an immediate-answer control:
//   import  — a parts + program import (one undo step)
//   undo    — Undo of that import
//   redo    — Redo of it
// For each it reports the history (canUndo/canRedo, labels, the buttons' disabled state), both
// tabs' state, the edit traces and every opId's timeline (sent, member applied, sender answer,
// timeout), as JSON.
//
//   node scripts/history-late-ack-check.mjs [source-root] [record.json]
//
// `source-root` (default: this checkout) runs the same cases against another commit's source.
// Exit code 1 if any check failed.
import { build } from "esbuild";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const recordPath = process.argv[3] ?? null;
const repo = new URL("..", import.meta.url).pathname;
const outDir = mkdtempSync(`${tmpdir()}/late-ack-`);
const outfile = `${outDir}/bundle.mjs`;
await build({
  stdin: {
    contents: `
      export { DesktopRoom } from "./src/desktop/collaboration.ts";
      export { WorkbenchTools } from "./src/desktop/workbench-tools.ts";
      export { RoomCore } from "./cloudflare/room-core.js";
      export { sanitizeEdit, sanitizeProgram } from "./cloudflare/sanitize.js";
    `,
    resolveDir: root,
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
  define: { "import.meta.env.VITE_COLLAB_WS_URL": '"ws://room.test/api/room"' },
  nodePaths: [`${repo}/node_modules`],
  loader: { ".css": "empty" },
  logLevel: "error",
});

// ── A fake browser: window, location, storage, animation frames, two history buttons ──
const T0 = Date.now();
const t = () => Date.now() - T0;
globalThis.window = globalThis;
globalThis.addEventListener = () => undefined;
globalThis.removeEventListener = () => undefined;
globalThis.location = { hostname: "room.test", protocol: "http:", host: "room.test", href: "http://room.test/" };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const button = () => ({ disabled: true, dataset: {}, title: "", setAttribute() {}, addEventListener() {} });
const buttons = { "#undo-edit": button(), "#redo-edit": button() };
globalThis.document = { querySelector: (selector) => buttons[selector] ?? null, querySelectorAll: () => [], addEventListener() {} };

const { DesktopRoom, WorkbenchTools, RoomCore, sanitizeEdit, sanitizeProgram } = await import(pathToFileURL(outfile).href);

// ── The room: RoomCore behind a fake WebSocket with per-socket ordered, delayable delivery ──
const core = new RoomCore();
const sockets = new Set();
const timeline = new Map();
const mark = (opId, event) => {
  if (!opId) return;
  const entry = timeline.get(opId) ?? {};
  entry[event] ??= t();
  timeline.set(opId, entry);
};
/** (socket, message) → extra delay in ms for that delivery. */
let delayOf = () => 0;
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    const query = new URL(url).searchParams;
    this.participant = { id: query.get("participant"), name: "Maker" };
    this.readyState = 0;
    this.listeners = { open: [], message: [], close: [] };
    this.lastAt = 0;
    sockets.add(this);
    setTimeout(() => {
      this.readyState = 1;
      for (const listener of this.listeners.open) listener({});
    }, 0);
  }
  addEventListener(type, listener) {
    this.listeners[type]?.push(listener);
  }
  removeEventListener() {}
  close() {
    this.readyState = 3;
    sockets.delete(this);
  }
  /** The connection drops (as a network loss would): the room forgets the socket, the client hears "close". */
  drop() {
    this.close();
    for (const peer of sockets) for (const message of core.leave(this.participant)) peer.deliver(message);
    for (const listener of this.listeners.close) listener({ code: 1006 });
  }
  deliver(message) {
    const at = Math.max(Date.now() + delayOf(this, message), this.lastAt);
    this.lastAt = at;
    setTimeout(() => {
      if (this.readyState !== 1) return;
      if (message.kind === "edit-result") mark(message.opId, "senderAnswer");
      for (const listener of this.listeners.message) listener({ data: JSON.stringify(message) });
      if (message.kind === "edit") mark(message.opId, `applied:${this.participant.name}`);
    }, at - Date.now());
  }
  send(text) {
    const raw = JSON.parse(text);
    if (raw.kind === "hello" && typeof raw.participant?.name === "string") this.participant.name = raw.participant.name;
    let message = raw;
    if (raw.kind === "edit") {
      const edit = sanitizeEdit(raw);
      message = edit ? { kind: "edit", participantId: this.participant.id, ...edit } : null;
      mark(raw.opId, "sent");
    } else if (raw.kind === "program") {
      const program = sanitizeProgram(raw.program);
      message = program ? { kind: "program", participantId: this.participant.id, program, running: raw.running } : null;
    } else if (raw.kind === "clock") {
      message = { kind: "clock", t0: raw.t0 };
    }
    if (!message) return;
    const out = core.handle(this.participant, message);
    if (message.kind === "edit") mark(message.opId, "roomAccepted");
    for (const reply of out.sender) this.deliver(reply);
    if (message.kind === "hello") for (const reply of core.join()) this.deliver(reply);
    for (const relay of out.others) for (const peer of sockets) if (peer !== this) peer.deliver(relay);
  }
}
globalThis.WebSocket = FakeSocket;

// ── Two tabs: the importer (with the real WorkbenchTools) and a teammate ──
const BASE = { position: [0, 0.05, 0], rotation: [0, 0, 0] };
function tab(name) {
  const parts = new Map();
  const view = { name, parts, program: [], running: false, traces: [], statuses: [] };
  view.room = new DesktopRoom("QLATE", name, {
    onApply: (componentId, transform) => parts.set(componentId, JSON.parse(JSON.stringify(transform))),
    onProgram: (program, running) => { view.program = program; view.running = running; },
    onRoomState: () => undefined,
    onTrace: (trace) => { if (trace.action === "edit") view.traces.push(trace.detail); },
  });
  view.workbench = {
    getSharedTransforms: () => Object.fromEntries([...parts].map(([id, transform]) => [id, JSON.parse(JSON.stringify(transform))])),
    setCurrentFlow() {},
    studioCatalog: () => ({ parts: { "sno-l1": {}, "sno-w3": {} } }),
  };
  return view;
}
const host = tab("Host");
const member = tab("Member");
host.tools = new WorkbenchTools({
  workbench: () => host.workbench,
  room: () => host.room,
  studio: () => "snapino",
  phase: () => "build",
  roomCode: () => "QLATE",
  holderOf: () => null,
  boltBuilding: () => false,
  roomProgram: () => ({ program: host.program, running: host.running }),
  draftProgram: () => null,
  loadDraft() {},
  status: (message, tone) => host.statuses.push({ t: t(), tone, message }),
  selected: () => null,
});

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(test, timeout = 30_000) {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > timeout) return false;
    await wait(20);
  }
  return true;
}
let passed = 0;
const failed = [];
const record = { source: root, cases: [] };
const check = (value, label, detail = "") => {
  if (value) passed += 1;
  else failed.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${value ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const key = (view) => JSON.stringify({ l1: view.parts.get("sno-l1")?.sockets ?? null, w3: view.parts.get("sno-w3")?.sockets ?? null, program: view.program });
const history = () => ({
  canUndo: host.tools.history.canUndo,
  canRedo: host.tools.history.canRedo,
  undoLabel: host.tools.history.undoLabel,
  redoLabel: host.tools.history.redoLabel,
  undoButtonDisabled: buttons["#undo-edit"].disabled,
  redoButtonDisabled: buttons["#redo-edit"].disabled,
});

await until(() => host.parts.size >= 0 && sockets.size === 2 && [...sockets].every((s) => s.readyState === 1));
await wait(100);

const P = { "sno-l1": [12, 30], "sno-w3": [30, 33] };
const Q = { "sno-l1": [30, 12], "sno-w3": [30, 33] };
const S = [{ op: "write", pin: "D5", value: true }, { op: "wait", ms: 500 }];
const T = [{ op: "write", pin: "D6", value: true }, { op: "wait", ms: 300 }];
const changesFor = (sockets) => Object.entries(sockets).map(([id, pair]) => ({ id, transform: { ...BASE, sockets: [...pair] } }));
const stateKey = (sockets, program) => JSON.stringify({ l1: sockets["sno-l1"], w3: sockets["sno-w3"], program });

/** The room's bench is P with program S (this tab's own edit, not part of the cases). */
async function seedPS() {
  delayOf = () => 0;
  host.tools.history.clear();
  await host.tools.submit(changesFor(P), "Set up P/S", { program: S, record: false });
  await until(() => key(member) === stateKey(P, S) && key(host) === stateKey(P, S));
}

/**
 * One case: `act` runs the history action with the sender's answer delayed by `late` ms (0: the
 * control). Waits for the teammate, then for the late answer, and records what happened.
 */
async function runCase(name, late, prepare, act, expected) {
  await prepare();
  delayOf = () => 0;
  const tracesBefore = host.traces.length;
  const statusesBefore = host.statuses.length;
  const opsBefore = new Set(timeline.keys());
  delayOf = (socket, message) => (late && socket.participant.name === "Host" && message.kind === "edit-result" ? late : 0);
  const started = t();
  const action = act();
  const memberReady = await until(() => key(member) === expected, 20_000);
  const memberAt = t();
  const atMember = { host: key(host), member: key(member), history: history() };
  await action;
  await wait(late ? late + 600 : 300);
  delayOf = () => 0;
  const settled = { host: key(host), member: key(member), history: history() };
  const ops = [...timeline].filter(([opId]) => !opsBefore.has(opId)).map(([opId, events]) => ({ opId: opId.slice(0, 8), ...events, timeoutStatus: host.statuses.slice(statusesBefore).find((s) => /not confirmed/.test(s.message))?.t ?? null }));
  const result = {
    name,
    senderAnswerDelayMs: late,
    startedAt: started,
    memberReady,
    memberReadyAt: memberAt,
    atMemberReady: atMember,
    afterLateAnswer: settled,
    traces: host.traces.slice(tracesBefore),
    statuses: host.statuses.slice(statusesBefore),
    ops,
  };
  record.cases.push(result);
  return result;
}

const importQT = () => host.tools.submit(changesFor(Q), "Loaded a project", { program: T, tone: "valid" });
const LATE = 9_000;
for (const late of [0, LATE]) {
  const tag = late ? `late answer (${late} ms > 8 s timeout)` : "control: immediate answer";
  // import
  const imported = await runCase(`import · ${tag}`, late, seedPS, importQT, stateKey(Q, T));
  check(imported.afterLateAnswer.host === stateKey(Q, T), `import · ${tag}: the importer ends with Q/T`, imported.afterLateAnswer.host);
  check(imported.afterLateAnswer.history.canUndo && imported.afterLateAnswer.history.undoLabel === "Loaded a project" && !imported.afterLateAnswer.history.undoButtonDisabled, `import · ${tag}: the accepted import is one undo step (Undo enabled)`, JSON.stringify(imported.afterLateAnswer.history));
  check(imported.traces.filter((d) => /^Loaded a project/.test(d)).length === 1, `import · ${tag}: traced exactly once`, JSON.stringify(imported.traces));
  // undo
  const undone = await runCase(`undo · ${tag}`, late, async () => {
    await seedPS();
    await importQT();
    await until(() => key(member) === stateKey(Q, T));
  }, () => new Promise((done) => { host.tools.undo(); done(); }), stateKey(P, S));
  check(undone.afterLateAnswer.host === stateKey(P, S) && undone.afterLateAnswer.member === stateKey(P, S), `undo · ${tag}: both tabs end at P/S`, `host ${undone.afterLateAnswer.host}`);
  check(undone.afterLateAnswer.history.canRedo && undone.afterLateAnswer.history.redoLabel === "Loaded a project" && !undone.afterLateAnswer.history.redoButtonDisabled && !undone.afterLateAnswer.history.canUndo, `undo · ${tag}: the accepted undo moved the entry to Redo (Redo enabled, Undo empty)`, JSON.stringify(undone.afterLateAnswer.history));
  check(undone.traces.filter((d) => /^Undid/.test(d)).length === 1, `undo · ${tag}: traced exactly once`, JSON.stringify(undone.traces));
  // redo (after an immediate undo)
  const redone = await runCase(`redo · ${tag}`, late, async () => {
    await seedPS();
    await importQT();
    await until(() => key(member) === stateKey(Q, T));
    host.tools.undo();
    await until(() => host.tools.history.canRedo && key(member) === stateKey(P, S));
  }, () => new Promise((done) => { host.tools.redo(); done(); }), stateKey(Q, T));
  check(redone.afterLateAnswer.host === stateKey(Q, T) && redone.afterLateAnswer.member === stateKey(Q, T), `redo · ${tag}: both tabs end at Q/T`, `host ${redone.afterLateAnswer.host}`);
  check(redone.afterLateAnswer.history.canUndo && redone.afterLateAnswer.history.undoLabel === "Loaded a project" && !redone.afterLateAnswer.history.canRedo && !redone.afterLateAnswer.history.undoButtonDisabled, `redo · ${tag}: the accepted redo moved the entry back to Undo`, JSON.stringify(redone.afterLateAnswer.history));
  check(redone.traces.filter((d) => /^Redid/.test(d)).length === 1, `redo · ${tag}: traced exactly once`, JSON.stringify(redone.traces));
  // Once settled, the next undo works (the history matches the room).
  const next = await runCase(`undo after the redo · ${tag}`, 0, async () => undefined, () => new Promise((done) => { host.tools.undo(); done(); }), stateKey(P, S));
  check(next.afterLateAnswer.host === stateKey(P, S) && next.afterLateAnswer.history.canRedo, `undo after the redo · ${tag}: the next undo applies (the history matched the room)`, `${next.afterLateAnswer.host} ${JSON.stringify(next.afterLateAnswer.history)}`);
}

// A stale late answer: the room refuses the undo (a teammate changed the part first); the entry is dropped, nothing applies.
{
  await seedPS();
  await importQT();
  await until(() => key(member) === stateKey(Q, T));
  // Everything to the importer is delayed: the teammate's change of the lamp reaches the room
  // first, the importer has not seen it, so the ROOM refuses the undo (stale), and says so late.
  delayOf = (socket) => (socket.participant.name === "Host" ? LATE : 0);
  await member.room.submitEdit([{ id: "sno-l1", transform: { ...BASE, sockets: [31, 12] } }]);
  const statusesBefore = host.statuses.length;
  host.tools.undo();
  await wait(LATE + 1_500);
  delayOf = () => 0;
  const h = history();
  record.cases.push({ name: "undo refused stale, answered late", history: h, host: key(host), member: key(member), statuses: host.statuses.slice(statusesBefore) });
  check(!h.canRedo && !h.canUndo && key(host) === key(member) && key(host) === stateKey({ "sno-l1": [31, 12], "sno-w3": Q["sno-w3"] }, T), "stale undo answered late: nothing applies, the entry is dropped (not moved to Redo), both tabs keep the teammate's change", `${JSON.stringify(h)} host ${key(host)}`);
}

// A program-only import (same parts) answered late: one undo step, traced once.
{
  await seedPS();
  const U = [{ op: "write", pin: "D3", value: true }];
  const result = await runCase(`program-only import · late answer (${LATE} ms)`, LATE, async () => undefined, () => host.tools.submit([], "Loaded a project", { program: U, tone: "valid" }), stateKey(P, U));
  check(result.afterLateAnswer.host === stateKey(P, U) && result.afterLateAnswer.history.canUndo && result.afterLateAnswer.history.undoLabel === "Loaded a project", "program-only import · late answer: the importer has U and one undo step", `${result.afterLateAnswer.host} ${JSON.stringify(result.afterLateAnswer.history)}`);
  check(result.traces.filter((d) => /^Loaded a project/.test(d)).length === 1, "program-only import · late answer: traced exactly once", JSON.stringify(result.traces));
  host.tools.undo();
  const back = await until(() => key(member) === stateKey(P, S) && key(host) === stateKey(P, S) && host.tools.history.canRedo, 10_000);
  check(back, "program-only import · late answer: its undo goes back to S on both tabs", `${key(host)}`);
}

// The connection drops while an undo waits for its late answer: the room accepted it, the
// answer never comes ("disconnected"). Nothing is committed on a guess and nothing is traced
// twice; the reconnect brings the room's state. (The entry stays in Undo, as for any edit whose
// answer was lost with the connection; the next Undo finds it stale and says so.)
{
  await seedPS();
  await importQT();
  await until(() => key(member) === stateKey(Q, T));
  const tracesBefore = host.traces.length;
  const statusesBefore = host.statuses.length;
  delayOf = (socket, message) => (socket.participant.name === "Host" && message.kind === "edit-result" ? LATE : 0);
  host.tools.undo();
  await until(() => key(member) === stateKey(P, S), 10_000);
  await wait(8_400);
  const hostSocket = [...sockets].find((socket) => socket.participant.name === "Host");
  hostSocket.drop();
  delayOf = () => 0;
  const reconnected = await until(() => [...sockets].some((socket) => socket.participant.name === "Host" && socket.readyState === 1) && key(host) === stateKey(P, S), 20_000);
  await wait(500);
  const h = history();
  record.cases.push({ name: "undo answered late, connection dropped first", reconnected, history: h, host: key(host), member: key(member), traces: host.traces.slice(tracesBefore), statuses: host.statuses.slice(statusesBefore) });
  check(reconnected && key(host) === stateKey(P, S) && key(member) === stateKey(P, S), "dropped before the late answer: after reconnecting both tabs show the room's P/S", `${key(host)}`);
  check(!h.canRedo && h.canUndo && host.traces.slice(tracesBefore).length === 0, "and nothing was committed or traced on a guess (the entry stays in Undo)", `${JSON.stringify(h)} traces ${JSON.stringify(host.traces.slice(tracesBefore))}`);
  check(host.statuses.slice(statusesBefore).some((s) => /connection closed/.test(s.message)), "and the importer is told the connection closed before the room answered", JSON.stringify(host.statuses.slice(statusesBefore).map((s) => s.message)));
}

for (const view of [host, member]) view.room.close?.();
host.tools.dispose?.();
console.log(`history late answer: ${passed}/${passed + failed.length} checks passed (source: ${root})`);
if (failed.length) {
  console.log(`FAILED:\n- ${failed.join("\n- ")}`);
  process.exitCode = 1;
}
if (recordPath) writeFileSync(recordPath, JSON.stringify(record, null, 1));
setTimeout(() => process.exit(process.exitCode ?? 0), 50);
