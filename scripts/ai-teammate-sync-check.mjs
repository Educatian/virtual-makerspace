// Bolt must never call a board finished from a host board that is missing Bolt's own accepted
// moves. Exact code, two connections, deterministic order:
//   - the real AiTeammate, the real DesktopRoom for Bolt AND for the hosting human (each over its own
//     simulated WebSocket), the real SyncReplica, the real planner (planCircuitLayout), and the real
//     RoomCore (cloudflare/room-core.js) as the room; a virtual clock drives every timer;
//   - the host's incoming messages can be held back, as a slow or busy host tab would receive them,
//     while Bolt's own connection keeps getting its acknowledgements in order.
// Counterexample from the parent re-review of ad5cac6: the room holds the corrected circuit; naive
// Bolt starts rebuilding and its first accepted move puts the 1 kΩ resistor in the tray; the host
// tab has not received that move when Bolt, taught again, plans from the host's board, finds nothing
// to do and says "The board already matches how I'd build it." while the room's resistor is gone.
//
// Not covered here: the 15 s part-lock bound. With one WebSocket per participant, an older move's
// acknowledgement reaches Bolt before anything that could start a newer build, so no transport-
// faithful schedule reaches that bound; Bolt now stops unconfirmed there instead of moving on.
//
//   node --experimental-strip-types scripts/ai-teammate-sync-check.mjs [path-to-ai-teammate.ts]
import assert from "node:assert/strict";
import { register } from "node:module";

// Source imports use ".js" for ".ts" files and Vite's import.meta.env: map both for Node.
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context);
    throw error;
  }
}
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.includes("/src/") && result.source) {
    const text = String(result.source);
    if (text.includes("import.meta.env")) return { ...result, source: text.replaceAll("import.meta.env", "globalThis.__viteEnv") };
  }
  return result;
}`)}`);

// ── Virtual clock and the browser surface the room client and Bolt use ─────────────────────────
let now = 1_800_000_000_000;
let timerSeq = 0;
const timers = new Map();
const schedule = (fn, ms, every = null) => { const id = ++timerSeq; timers.set(id, { at: now + Math.max(0, ms || 0), fn, every }); return id; };
const cancel = (id) => { timers.delete(id); };
Date.now = () => now;
globalThis.__viteEnv = { VITE_COLLAB_WS_URL: "ws://room.test/api/room", BASE_URL: "/" };
globalThis.location = { hostname: "room.test", protocol: "http:", host: "room.test", href: "http://room.test/" };
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
globalThis.window = {
  setTimeout: (fn, ms) => schedule(fn, ms),
  clearTimeout: cancel,
  setInterval: (fn, ms) => schedule(fn, ms, ms),
  clearInterval: cancel,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** Runs every timer due up to `target` (in order), letting promises settle after each. */
async function advance(ms) {
  const target = now + ms;
  await flush();
  for (;;) {
    let next = null;
    for (const [id, timer] of timers) if (timer.at <= target && (!next || timer.at < next[1].at || (timer.at === next[1].at && id < next[0]))) next = [id, timer];
    if (!next) break;
    const [id, timer] = next;
    now = timer.at;
    if (timer.every) timer.at += timer.every; else timers.delete(id);
    timer.fn();
    await flush();
    await flush();
  }
  now = target;
  await flush();
}
async function until(test, limitMs, stepMs = 50) {
  for (let waited = 0; waited <= limitMs; waited += stepMs) {
    if (test()) return true;
    await advance(stepMs);
  }
  return test();
}

// ── The room: the real RoomCore behind one simulated WebSocket per participant ────────────────────
const { RoomCore } = await import("../cloudflare/room-core.js");
const { sanitizeEdit, sanitizeTransform } = await import("../cloudflare/sanitize.js");
const core = new RoomCore({ now: () => now });
const connections = new Set();

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    const params = new URL(url).searchParams;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.id = params.get("participant");
    this.agent = params.get("agent") === "1";
    this.name = this.agent ? "Bolt" : "Host";
    this.label = this.agent ? "bolt" : "host";
    this.inbox = [];
    this.held = false;
    this.delivered = [];
    connections.add(this);
    schedule(() => { this.readyState = FakeWebSocket.OPEN; this.emit("open", {}); }, 0);
  }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)); }
  emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  close() { this.readyState = FakeWebSocket.CLOSED; connections.delete(this); }
  /** Client → room, in order; the room answers this socket and relays to the others. */
  send(data) {
    const raw = JSON.parse(data);
    let message = raw;
    if (raw.kind === "hello" || raw.kind === "presence") message = { kind: raw.kind, participant: { ...raw.participant, id: this.id, name: this.name, kind: this.agent ? "agent" : "human" } };
    else if (raw.kind === "chat") message = { kind: "chat", message: { ...raw.message, participantId: this.id, author: this.name, createdAt: now } };
    else if (raw.kind === "transform") message = { ...raw, participantId: this.id, transform: sanitizeTransform(raw.transform, raw.componentId) };
    else if (raw.kind === "edit") message = { kind: "edit", participantId: this.id, ...sanitizeEdit(raw) };
    else if (raw.kind === "claim" || raw.kind === "release") message = { kind: raw.kind, participantId: this.id, participantName: this.name, componentId: raw.componentId };
    const result = core.handle({ id: this.id, name: this.name }, message);
    for (const reply of result.sender) this.receive(reply);
    if (message.kind === "hello") for (const reply of core.join()) this.receive(reply);
    for (const relay of result.others) for (const peer of connections) if (peer !== this) peer.receive(relay);
  }
  /** Room → client: in order; held back while `held`, as a slow tab would receive it. */
  receive(message) {
    this.inbox.push(JSON.stringify(message));
    this.pump();
  }
  pump() {
    if (this.held || this.pumping) return;
    this.pumping = true;
    schedule(() => {
      this.pumping = false;
      while (!this.held && this.inbox.length) {
        const data = this.inbox.shift();
        this.delivered.push(JSON.parse(data).kind);
        this.emit("message", { data });
      }
    }, 5);
  }
  hold() { this.held = true; }
  releaseHold() { this.held = false; this.pump(); }
}
globalThis.WebSocket = FakeWebSocket;

const modulePath = process.argv[2] ?? "../src/desktop/ai-teammate.ts";
const { AiTeammate } = await import(modulePath);
const { DesktopRoom } = await import("../src/desktop/collaboration.ts");
const { planCircuitLayout, CIRCUIT_PARTS } = await import("../src/desktop/circuit-topology.ts");

let checks = 0;
const ok = (value, label, detail = "") => { checks += 1; assert.ok(value, `${label}${detail ? ` — ${detail}` : ""}`); };

const seat = (sockets) => ({ position: [0, 0.6, 0], rotation: [0, 0, 0], sockets });
const homeOf = (id) => ({ position: [id.length * 0.1, 0.5, 3], rotation: [0, 0, 0], sockets: null });
const ALL = [CIRCUIT_PARTS.battery, ...CIRCUIT_PARTS.resistors, ...CIRCUIT_PARTS.leds, ...CIRCUIT_PARTS.wires];
const CORRECT = { strips: true, resistor: true, loop: true };
const corrected = new Map(planCircuitLayout(CORRECT).map((part) => [part.id, part.sockets]));
const TEACH = [
  "The holes are connected in vertical columns, not across the row.",
  "It has to go all the way around back to the other side of the battery because current flows in a loop",
  "The resistor stops too much current from burning out the LED.",
];

async function scenario({ releaseHostAfterMs }) {
  // A fresh room holding the corrected circuit (as the team left it).
  core.state.clear();
  core.claims.clear();
  for (const id of ALL) core.store(id, corrected.has(id) ? seat(corrected.get(id)) : homeOf(id));
  connections.clear();
  storage.clear();

  // The hosting human tab: its board is what its own connection has applied.
  const board = {};
  const hostRoom = new DesktopRoom("SYNC1", "Host", {
    onApply: (id, transform, { propsOnly }) => { board[id] = propsOnly ? { ...board[id], props: transform.props } : structuredClone(transform); },
    onRevert: (id, transform) => { if (transform) board[id] = structuredClone(transform); },
  }, "host@example.test");
  await advance(100);
  ok(board["resistor-1k"]?.sockets?.join() === corrected.get("resistor-1k").join(), "(the host's board starts with the corrected circuit)");

  const said = [];
  const bolt = new AiTeammate({
    roomCode: "SYNC1",
    authId: "host@example.test",
    studio: () => "circuit",
    phase: () => "build",
    transforms: () => structuredClone(board),
    revOf: (id) => hostRoom.sync.revs.get(id) ?? 0,
    placementTransform: (_id, sockets) => seat([sockets[0], sockets[1]]),
    homeTransform: (id) => homeOf(id),
    yieldComponent: () => undefined,
    isHeldByOther: () => false,
    saveAttempt: () => undefined,
    onRole: () => undefined,
    onChange: () => undefined,
  }, { profile: "novice", explain: false, role: "builder" });
  const boltSocket = [...connections].find((socket) => socket.agent);
  const hostSocket = [...connections].find((socket) => !socket.agent);
  // Bolt's chat lines, as the room relays them to the host.
  const originalSend = boltSocket.send.bind(boltSocket);
  boltSocket.send = (data) => { const raw = JSON.parse(data); if (raw.kind === "chat") said.push(raw.message.body); originalSend(data); };
  hostRoom.setActivity("available"); // presence: Bolt sees one human in the room

  // Run 1 (naive beliefs) starts; from now on the host tab receives the room late.
  const started = await until(() => bolt.buildLog.some((entry) => /build started/.test(entry.event ?? "")), 20_000);
  ok(started, "(naive Bolt starts its first build)");
  hostSocket.hold();
  const resistorHome = await until(() => bolt.buildLog.some((entry) => entry.part === "resistor-1k" && entry.release === "accepted"), 20_000);
  ok(resistorHome, "Bolt's first accepted move takes the 1 kΩ resistor off the board", JSON.stringify(bolt.buildLog.slice(-3)));
  ok(core.state.get("resistor-1k")?.transform.sockets === null, "(the room now has the resistor in the tray)");
  ok(board["resistor-1k"]?.sockets?.join() === corrected.get("resistor-1k").join(), "(the host's board has not received that move yet)");

  // The human teaches the three ideas: Bolt replans 1600 ms later (its normal delay).
  for (const line of TEACH) hostRoom.sendChat(line);
  const taughtAt = now;
  if (releaseHostAfterMs !== null) {
    await advance(releaseHostAfterMs);
    hostSocket.releaseHold();
  }
  await until(() => bolt.buildLog.some((entry) => entry.at > taughtAt && /built \(|not planned/.test(entry.event ?? "")) || said.some((line) => /already matches/.test(line)), 60_000);
  await advance(12_000);
  return { bolt, said, board, hostSocket, hostRoom, taughtAt };
}

const roomResistor = () => core.state.get("resistor-1k")?.transform.sockets ?? null;
const wanted = corrected.get("resistor-1k");

// A: the host's copy arrives 2.3 s after the teaching (the reviewer's lag): Bolt must repair.
{
  const { bolt, said, hostRoom } = await scenario({ releaseHostAfterMs: 2300 });
  const falseMatch = said.some((line) => /already matches/.test(line));
  ok(!falseMatch, "A · no 'already matches' while the room's resistor is in the tray", JSON.stringify(said.slice(-3)));
  await until(() => roomResistor()?.join() === wanted.join() && said.some((line) => /^Done\./.test(line)), 60_000);
  ok(roomResistor()?.join() === wanted.join(), "A · the newest build puts the resistor back where the corrected plan wants it", `room ${JSON.stringify(roomResistor())}, wanted ${JSON.stringify(wanted)}`);
  ok(said.some((line) => /^Done\./.test(line)), "A · and then says Done", JSON.stringify(said.slice(-2)));
  ok(bolt.buildLog.some((entry) => /built \(0 skipped\)/.test(entry.event ?? "")), "A · its build log ends with every move accepted", JSON.stringify(bolt.buildLog.filter((entry) => entry.event).map((entry) => entry.event)));
  console.log("A build log:", JSON.stringify(bolt.buildLog.map(({ at, ...entry }) => entry)));
  console.log("A Bolt said:", JSON.stringify(said));
  bolt.dispose();
  hostRoom.close();
}

// B: the host's copy does not arrive at all: Bolt must stay unconfirmed, never 'finished'.
{
  const { bolt, said, hostSocket, hostRoom } = await scenario({ releaseHostAfterMs: null });
  await advance(40_000);
  const falseMatch = said.some((line) => /already matches|^Done\./.test(line));
  ok(!falseMatch, "B · with the host board behind, no 'already matches' and no 'Done.'", JSON.stringify(said.slice(-3)));
  ok(bolt.buildLog.some((entry) => /not planned: the host's board is behind on .*resistor-1k/.test(entry.event ?? "")), "B · the build log says it did not plan, and why", JSON.stringify(bolt.buildLog.filter((entry) => entry.event).map((entry) => entry.event).slice(-4)));
  ok(said.some((line) => /can't see the board's latest state/.test(line)), "B · after its bounded retries Bolt asks a person to check", JSON.stringify(said.slice(-2)));
  ok(bolt.isBuilding === false, "B · it is not left building");
  ok(roomResistor() === null, "(the room still has the resistor in the tray: nothing was claimed as done)");
  console.log("B build log:", JSON.stringify(bolt.buildLog.map(({ at, ...entry }) => entry)));
  console.log("B Bolt said:", JSON.stringify(said));
  hostSocket.releaseHold();
  bolt.dispose();
  hostRoom.close();
}

console.log(`ai-teammate sync: ${checks} checks passed (${modulePath})`);
process.exit(0);
