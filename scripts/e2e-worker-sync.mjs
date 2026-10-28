// Protocol check against the real Worker + Durable Object (wrangler dev), no browsers:
// concurrent accepted-edit races, cable-end vs whole-part claims, a refused edit whose holder
// disconnects, a stale program undo, and hostile messages — with plain WebSocket clients that
// use the app's own sync rules (src/desktop/sync-replica.ts).
//
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799      # stands in for Cloudflare Access
//   node --experimental-strip-types scripts/e2e-worker-sync.mjs   # → http://vm.test:8800
//
// Uses a fresh random room code (never the shared room 7K3M).
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const { SyncReplica } = await import("../src/desktop/sync-replica.ts");

const origin = process.argv[2] ?? "http://vm.test:8800";
const port = Number(new URL(origin).port || 80);
const lookup = (_host, options, callback) => (options?.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4));
const room = `S${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function api(email, path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: `e2e_email=${encodeURIComponent(email)}`, host: new URL(origin).host, "content-type": "application/json" },
  });
  return response.json();
}

const seat = (sockets, props) => ({ position: [0, 0.48, 0], rotation: [0, 0, 0], sockets, ...(props ? { props } : {}) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Client {
  constructor(name, email) {
    this.name = name;
    this.email = email;
    this.state = new Map();
    this.results = new Map();
    this.claims = new Map();
    this.program = null;
    this.inbox = [];
    this.op = 0;
  }
  async connect() {
    const me = await api(this.email, "/api/me");
    this.id = `${me.id}:${crypto.randomUUID()}`;
    this.replica = new SyncReplica(this.id, "server");
    const url = `ws://${new URL(origin).host}/api/room?room=${room}&participant=${encodeURIComponent(this.id)}`;
    this.socket = new WebSocket(url, { headers: { origin, cookie: `e2e_email=${encodeURIComponent(this.email)}` }, lookup });
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.closed = false;
    this.socket.on("close", () => { this.closed = true; });
    this.socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      this.inbox.push(message);
      if (message.kind === "claim") this.claims.set(message.componentId, message.participantId);
      if (message.kind === "release") this.claims.delete(message.componentId);
      this.run(this.replica.receive(message));
    });
    this.send({ kind: "hello", participant: { id: this.id, name: this.name, joinedAt: Date.now(), voiceReady: false, muted: true, role: "builder", ready: false, activity: "available", lastActiveAt: Date.now() } });
    await this.until(() => this.inbox.some((message) => message.kind === "room-state"), "room-state");
  }
  run(effects) {
    for (const effect of effects) {
      if (effect.type === "apply") {
        if (effect.propsOnly) {
          if (effect.transform.props) this.state.set(effect.componentId, { ...(this.state.get(effect.componentId) ?? {}), props: effect.transform.props });
          continue;
        }
        const next = { ...effect.transform };
        delete next.activeEndpoint;
        if (next.props === undefined && this.state.get(effect.componentId)?.props) next.props = this.state.get(effect.componentId).props;
        this.state.set(effect.componentId, next);
      } else if (effect.type === "revert" && !effect.superseded) {
        if (effect.transform) this.state.set(effect.componentId, { ...effect.transform });
        else this.state.delete(effect.componentId);
      } else if (effect.type === "room-state") {
        for (const id of [...this.state.keys()]) if (!effect.componentIds.includes(id) && !effect.ownMovesInFlight.includes(id)) this.state.delete(id);
      } else if (effect.type === "program") {
        this.program = { program: effect.program, running: effect.running };
      } else if (effect.type === "resolve") {
        this.results.set(effect.opId, effect.result);
      } else if (effect.type === "claim-result") {
        this.lastClaim = { resourceId: effect.resourceId, granted: effect.granted };
      }
    }
  }
  send(message) {
    this.socket.send(JSON.stringify(message));
  }
  edit(changes, program) {
    const opId = `${this.name}-${(this.op += 1)}`;
    const { message } = this.replica.createEdit(opId, changes.map(([componentId, transform]) => ({ componentId, transform })), program);
    this.send(message);
    return opId;
  }
  claim(resourceId) {
    this.lastClaim = null;
    this.replica.beginHold(resourceId);
    this.send({ kind: "claim", participantId: this.id, participantName: this.name, componentId: resourceId });
  }
  move(componentId, transform, sequence) {
    this.state.set(componentId, { ...transform });
    this.replica.noteOwnTransform(componentId);
    this.send({ kind: "transform", participantId: this.id, componentId, transform, sequence });
  }
  release(resourceId) {
    this.send({ kind: "release", participantId: this.id, participantName: this.name, componentId: resourceId });
  }
  async until(test, label, timeout = 10_000) {
    const started = Date.now();
    while (!test()) {
      if (Date.now() - started > timeout) throw new Error(`${this.name}: timed out waiting for ${label}`);
      await sleep(20);
    }
  }
  view() {
    return JSON.stringify([...this.state].sort(([a], [b]) => a.localeCompare(b)));
  }
  close() {
    this.socket.close();
  }
}

// The admin creates the room (Circuit Bench).
const created = await api("host@example.test", `/api/rooms/${room}/join`, { method: "POST", body: JSON.stringify({ studio: "circuit" }) });
check("a fresh test room is created", created.joined === true, room);

const A = new Client("A", "host@example.test");
const B = new Client("B", "member@example.test");
await A.connect();
await B.connect();
check("both clients get the room's state on join", A.replica.hasRoomState && B.replica.hasRoomState);

// ── 1. Accepted-edit race: A sets 470 Ω, B sets 220 Ω before either sees the other ──────
{
  const a = A.edit([["resistor-1k", seat([36, 39], { ohms: 470 })]]);
  const b = B.edit([["resistor-1k", seat([36, 39], { ohms: 220 })]]);
  check("edits are not applied before the room answers", !A.state.has("resistor-1k") && !B.state.has("resistor-1k"));
  await A.until(() => A.results.has(a), "A's result");
  await B.until(() => B.results.has(b), "B's result");
  await sleep(300);
  const outcomes = [A.results.get(a), B.results.get(b)];
  check("exactly one concurrent edit is accepted, the other refused as stale", outcomes.filter((r) => r.ok).length === 1 && outcomes.some((r) => r.reason === "stale"), JSON.stringify(outcomes));
  check("A and B end identical", A.view() === B.view(), A.state.get("resistor-1k")?.props?.ohms);
  const C = new Client("C", "late@example.test");
  await C.connect();
  check("a late joiner gets the same state from the room", C.view() === A.view(), C.view().slice(0, 120));
  C.close();
}

// ── 2. Cable end vs whole part, both ways; a batch touching a held end is refused whole ──
{
  A.claim("wire-red::endpoint-0");
  await A.until(() => A.lastClaim, "A's end claim");
  check("A's cable-end claim is granted", A.lastClaim.granted);
  B.claim("wire-red");
  await B.until(() => B.lastClaim, "B's whole claim");
  check("a whole-part claim is denied while an end is held", !B.lastClaim.granted);
  const op = B.edit([["led-red", seat([53, 52])], ["wire-red", seat(null)]]);
  await B.until(() => B.results.has(op), "B's batch");
  check("an import/undo batch touching the held end is refused as held", B.results.get(op).reason === "held", JSON.stringify(B.results.get(op)));
  await sleep(200);
  check("and nothing in the batch was committed", !A.state.has("led-red") && !B.state.has("led-red"));
  A.release("wire-red::endpoint-0");
  await sleep(200);
  A.claim("wire-blue");
  await A.until(() => A.lastClaim, "A's whole claim");
  B.claim("wire-blue::endpoint-1");
  await B.until(() => B.lastClaim, "B's end claim");
  check("an end claim is denied while the whole cable is held", A.lastClaim.granted && !B.lastClaim.granted);
  A.release("wire-blue");
  await sleep(200);
}

// ── 3. A refused move + edit, then the holder disconnects without a final move ──────────
{
  A.claim("resistor-1k");
  await A.until(() => A.lastClaim, "A's claim");
  B.move("resistor-1k", seat([100, 103]), 1); // B never claimed it
  const refused = B.edit([["resistor-1k", seat([36, 39], { ohms: 4700 })]]);
  await B.until(() => B.results.has(refused), "B's refused edit");
  await sleep(200);
  A.close();
  await sleep(500);
  check("B's edit on a held part was refused", B.results.get(refused).ok === false, B.results.get(refused).reason);
  check("B's refused move was replaced by the room's state", JSON.stringify(B.state.get("resistor-1k")?.sockets) === "[36,39]", JSON.stringify(B.state.get("resistor-1k")));
  const D = new Client("D", "late@example.test");
  await D.connect();
  check("B and a new joiner are identical though the holder left without a final move", D.view() === B.view());
  D.close();
}

// ── 4. Program: a stale undo never overwrites a teammate's newer upload ─────────────────
{
  const E = new Client("E", "host@example.test");
  await E.connect();
  const Q = [{ op: "write", pin: "D5", value: true }];
  const R = [{ op: "write", pin: "D6", value: true }];
  const imported = E.edit([], { program: Q, running: false });
  await E.until(() => E.results.has(imported), "import");
  check("a program-only import is accepted", E.results.get(imported).ok);
  await B.until(() => JSON.stringify(B.program?.program) === JSON.stringify(Q), "B sees Q");
  // B uploads R unconditionally while E's undo (based on the old revision) is in flight.
  const upload = B.edit([], { program: R, running: true, conditional: false });
  const undo = E.edit([], { program: [], running: false });
  await E.until(() => E.results.has(undo), "undo");
  await B.until(() => B.results.has(upload), "upload");
  await sleep(300);
  const undoResult = E.results.get(undo);
  check("the room orders both; the undo is refused as stale if R came first, else R wins after it",
    (undoResult.ok === false && undoResult.reason === "stale") || (undoResult.ok && JSON.stringify(E.program?.program) === JSON.stringify(R)), JSON.stringify(undoResult));
  check("both clients run the same program", JSON.stringify(E.program) === JSON.stringify(B.program), JSON.stringify(B.program));
  E.close();
}

// ── 5. Hostile messages are dropped without closing the room ──────────────────────────────
{
  for (const payload of [
    "{not json",
    JSON.stringify({ kind: "transform", componentId: "resistor-1k", transform: { position: [{ toString: 0, valueOf: 0 }, 0, 0], rotation: [0, 0, 0] }, sequence: 9 }),
    JSON.stringify({ kind: "transform", componentId: "resistor-1k", transform: { position: [false, "", null], rotation: [0, 0, 0], sockets: [true, ""] }, sequence: 10 }),
    JSON.stringify({ kind: "edit", opId: { toString: 0 }, changes: [] }),
    JSON.stringify({ kind: "edit", opId: "x", changes: [{ componentId: "resistor-1k", transform: seat([1, 2]), expectRev: "0" }] }),
    JSON.stringify({ kind: "program", program: [{ op: "wait", ms: { valueOf: 0 } }], running: true }),
  ]) B.socket.send(payload);
  await sleep(500);
  const probe = B.edit([["led-green", seat([71, 70])]]);
  await B.until(() => B.results.has(probe), "probe");
  check("hostile messages are dropped and the connection keeps working", !B.closed && B.results.get(probe).ok === true);
}

B.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · room ${room}`);
assert.equal(failed.length, 0);
process.exit(0);
