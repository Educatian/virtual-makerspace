// Deterministic multi-client sync checks: the real room core (cloudflare/room-core.js +
// sanitizers) and the real client replica rules (src/desktop/sync-replica.ts), connected by
// in-memory queues whose delivery order the test controls. Covers accepted concurrent edits,
// endpoint vs whole-part claims, refused drags with a disconnecting holder, atomic batches,
// program edits, late joiners, and thousands of random interleavings.
//   node --experimental-strip-types scripts/sync-check.mjs
import assert from "node:assert/strict";

const { RoomCore } = await import("../cloudflare/room-core.js");
const { sanitizeEdit, sanitizeTransform, componentResource, sanitizeProgram } = await import("../cloudflare/sanitize.js");
const { SyncReplica } = await import("../src/desktop/sync-replica.ts");

let checks = 0;
let DEBUG = "";
const DEBUG_PART = process.env.SYNC_DEBUG ?? "";
const DEBUG_TRIAL = Number(process.env.SYNC_TRIAL ?? -1);
const ok = (value, label) => { checks += 1; assert.ok(value, label); };
const eq = (a, b, label) => { checks += 1; assert.deepEqual(a, b, label); };

/** Server-side validation, as the Worker does before the core sees a message. */
function sanitize(message, participant) {
  switch (message.kind) {
    case "claim":
    case "release": {
      const componentId = componentResource(message.componentId, true);
      return componentId ? { kind: message.kind, participantId: participant.id, participantName: participant.name, componentId } : null;
    }
    case "transform": {
      const transform = sanitizeTransform(message.transform, message.componentId);
      return transform ? { kind: "transform", participantId: participant.id, componentId: message.componentId, transform, sequence: message.sequence } : null;
    }
    case "edit": {
      const edit = sanitizeEdit(message);
      return edit ? { kind: "edit", participantId: participant.id, ...edit } : null;
    }
    case "program": {
      const program = sanitizeProgram(message.program);
      return program ? { kind: "program", participantId: participant.id, program, running: message.running } : null;
    }
    default:
      return message;
  }
}

/** One room server with per-client FIFO links in both directions. */
class Net {
  constructor() {
    this.core = new RoomCore();
    this.clients = new Map();
    this.toServer = [];
  }
  connect(client) {
    this.clients.set(client.id, client);
    client.net = this;
    client.inbox = [];
    this.toServer.push({ from: client.id, message: { kind: "hello", participant: { id: client.id, name: client.name } } });
  }
  disconnect(client) {
    this.clients.delete(client.id);
    // Anything still queued from this client is lost with the socket.
    this.toServer = this.toServer.filter((item) => item.from !== client.id);
    for (const message of this.core.leave({ id: client.id, name: client.name })) this.broadcast(client.id, message);
    for (const other of this.clients.values()) other.inbox.push({ kind: "goodbye", participantId: client.id });
    // Like the Durable Object: the last one out resets the bench.
    if (this.clients.size === 0) this.core.reset();
  }
  broadcast(fromId, message) {
    for (const client of this.clients.values()) if (client.id !== fromId) client.inbox.push(structuredClone(message));
  }
  /** The server processes the next queued client message. */
  serverStep() {
    const item = this.toServer.shift();
    if (!item) return false;
    const client = this.clients.get(item.from);
    if (!client) return true;
    const message = sanitize(structuredClone(item.message), { id: client.id, name: client.name });
    if (!message) return true;
    const result = this.core.handle({ id: client.id, name: client.name }, message);
    for (const reply of result.sender) client.inbox.push(structuredClone(reply));
    if (message.kind === "hello") for (const reply of this.core.join()) client.inbox.push(structuredClone(reply));
    for (const relay of result.others) this.broadcast(client.id, relay);
    return true;
  }
  /** Drains everything in a fixed, fair order. */
  settle() {
    for (let guard = 0; guard < 100_000; guard += 1) {
      let moved = this.serverStep();
      for (const client of this.clients.values()) moved = client.deliver() || moved;
      if (!moved) return;
    }
    throw new Error("network did not settle");
  }
}

/** A client: replica rules + a plain map standing in for the 3D scene. */
class Client {
  constructor(id, name = id) {
    this.id = id;
    this.name = name;
    this.replica = new SyncReplica(id, "server");
    this.state = new Map();
    this.owners = new Map();
    this.dragging = null;
    this.results = new Map();
    this.op = 0;
    this.sequence = 0;
    this.claimResults = new Map();
    this.settled = new Map();
  }
  send(message) {
    if (DEBUG && JSON.stringify(message).includes(DEBUG)) console.log(`${this.id} =>`, JSON.stringify(message).slice(0, 220));
    this.net.toServer.push({ from: this.id, message: structuredClone(message) });
  }
  apply(componentId, transform) {
    const current = this.state.get(componentId);
    const end = transform.activeEndpoint;
    if ((end === 0 || end === 1) && transform.endpoints) {
      // Like the scene: a teammate's cable-end move changes only that end.
      const base = current ?? { ...DEFAULT_WIRE };
      const endpoints = [base.endpoints[0], base.endpoints[1]];
      endpoints[end] = transform.endpoints[end];
      const sockets = Array.isArray(base.sockets) ? [base.sockets[0], base.sockets[1]] : [null, null];
      sockets[end] = transform.sockets?.[end] ?? null;
      this.state.set(componentId, { ...base, endpoints, sockets: sockets.some((socket) => socket !== null) ? sockets : null });
      return;
    }
    const next = { ...transform };
    delete next.activeEndpoint;
    // Like the scene: absent values / switch state mean "unchanged".
    if (next.props === undefined && current?.props !== undefined) next.props = current.props;
    if (next.on === undefined && current?.on !== undefined) next.on = current.on;
    this.state.set(componentId, next);
  }
  run(effects) {
    for (const effect of effects) {
      if (effect.type === "apply") {
        // Like the scene: an authoritative (force) change the room ordered before this client's
        // first move ends a local drag that has not moved yet; otherwise the drag keeps its spot.
        if (effect.force && !effect.propsOnly && this.dragging === effect.componentId) this.dragging = null;
        if (effect.propsOnly || this.dragging === effect.componentId) {
          // Like the scene: a part being moved here keeps its local position; values still apply.
          // (The scene always has a state for every part; here an absent entry is the default.)
          const current = { ...(this.state.get(effect.componentId) ?? DEFAULT) };
          if (effect.transform.props !== undefined) current.props = effect.transform.props;
          if (effect.transform.on !== undefined) current.on = effect.transform.on;
          if (effect.transform.props !== undefined || effect.transform.on !== undefined) this.state.set(effect.componentId, current);
          continue;
        }
        this.apply(effect.componentId, effect.transform);
      } else if (effect.type === "revert") {
        if (effect.superseded) {
          // A newer move of this client's is still in flight: an active drag continues.
          const current = { ...(this.state.get(effect.componentId) ?? DEFAULT) };
          if (effect.transform?.props !== undefined) current.props = effect.transform.props;
          if (effect.transform?.on !== undefined) current.on = effect.transform.on;
          if (effect.transform?.props !== undefined || effect.transform?.on !== undefined) this.state.set(effect.componentId, current);
          continue;
        }
        if (this.dragging === effect.componentId) this.dragging = null;
        if (effect.transform) this.state.set(effect.componentId, { ...effect.transform });
        else this.state.delete(effect.componentId);
      } else if (effect.type === "claim-denied") {
        if (this.dragging && (effect.componentId === this.dragging || effect.componentId.startsWith(`${this.dragging}::`))) this.deniedDrag = true;
      } else if (effect.type === "room-state") {
        if (effect.fresh) {
          // Like main.ts: a bench the room has never seen seeds the room (one atomic edit).
          if (this.state.size) this.seedOp = this.edit([...this.state].map(([componentId, transform]) => ({ componentId, transform })));
          continue;
        }
        // Parts the room does not list are at their defaults there.
        for (const componentId of [...this.state.keys()]) {
          if (!effect.componentIds.includes(componentId) && !effect.ownMovesInFlight.includes(componentId)) this.state.delete(componentId);
        }
      } else if (effect.type === "claim-result") {
        this.claimResults.set(effect.resourceId, effect.granted);
      } else if (effect.type === "settled") {
        this.settled.set(effect.componentId, effect.ok);
      } else if (effect.type === "claims") {
        for (const claim of effect.claims) this.owners.set(claim.componentId, claim.participantId);
      } else if (effect.type === "program") {
        this.program = { program: effect.program, running: effect.running };
      } else if (effect.type === "resolve") {
        this.results.set(effect.opId, effect.result);
        // A refused seed means someone else's bench got there first: take the room's.
        if (effect.opId === this.seedOp && !effect.result.ok) this.send({ kind: "room-state-request" });
      }
    }
  }
  deliver() {
    const message = this.inbox.shift();
    if (!message) return false;
    if (DEBUG && JSON.stringify(message).includes(DEBUG)) console.log(`  ${this.id} <=`, JSON.stringify(message).slice(0, 220), "| dragging", this.dragging);
    if (message.kind === "claim") this.owners.set(message.componentId, message.participantId);
    if (message.kind === "release") this.owners.delete(message.componentId);
    this.run(this.replica.receive(message));
    return true;
  }
  /** The socket dropped and came back: pending work fails, the room's state decides again. */
  reconnect(net) {
    if (DEBUG) console.log(`${this.id} reconnects`);
    if (net.clients.has(this.id)) net.disconnect(this);
    this.replica.resetForReconnect();
    this.run(this.replica.failPending("disconnected"));
    this.dragging = null;
    this.owners.clear();
    net.connect(this);
  }
  edit(changes, program) {
    const opId = `${this.id}-op${(this.op += 1)}`;
    const { message, immediate } = this.replica.createEdit(opId, changes, program);
    this.send(message);
    this.run(immediate);
    return opId;
  }
  /** Optimistic live drag: claim, move locally and send. */
  startDrag(resourceId) {
    this.dragging = resourceId.split("::")[0];
    this.deniedDrag = false;
    this.owners.set(resourceId, this.id);
    this.replica.beginHold(resourceId);
    this.send({ kind: "claim", componentId: resourceId });
  }
  move(componentId, moved) {
    if (this.dragging !== componentId) return;
    const { props: _props, on: _on, ...transform } = moved;
    this.apply(componentId, transform);
    this.replica.noteOwnTransform(componentId);
    this.send({ kind: "transform", componentId, transform, sequence: (this.sequence += 1) });
  }
  /** Like the scene: letting go always sends the part's final state, then releases. */
  release(resourceId) {
    const componentId = resourceId.split("::")[0];
    if (this.dragging === componentId && this.state.has(componentId)) {
      // Live moves never carry electrical values (the scene's emitTransform omits them).
      const { props: _props, on: _on, ...transform } = this.state.get(componentId);
      this.replica.noteOwnTransform(componentId);
      this.send({ kind: "transform", componentId, transform, sequence: (this.sequence += 1) });
    }
    this.dragging = null;
    this.owners.delete(resourceId);
    this.send({ kind: "release", componentId: resourceId });
    // Like DesktopRoom.release: the hold counts only once all its moves were answered.
    const now = this.replica.settleRelease(componentId);
    if (now !== null) this.settled.set(componentId, now);
    else this.settled.delete(componentId);
  }
}

const DEFAULT = { position: [9, 0.48, 9], rotation: [0, 0, 0], sockets: null };
const DEFAULT_WIRE = { position: [9, 0.48, 9], rotation: [0, 0, 0], sockets: null, endpoints: [[-0.2, 0, 0], [0.2, 0, 0]] };
const seat = (sockets, props) => ({ position: [0, 0.48, 0], rotation: [0, 0, 0], sockets, ...(props ? { props } : {}) });
const views = (...clients) => clients.map((client) => JSON.stringify([...client.state].sort(([a], [b]) => a.localeCompare(b))));
const serverView = (net) => JSON.stringify([...net.core.state].map(([id, entry]) => [id, entry.transform]).sort(([a], [b]) => a.localeCompare(b)));

// ── P1: two accepted-looking concurrent edits must not diverge ─────────────────────────────
{
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  net.connect(A);
  net.connect(B);
  net.settle();
  // Both edit before seeing any of each other's traffic.
  const a = A.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 470 }) }]);
  const b = B.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 220 }) }]);
  ok(!A.state.has("resistor-1k") && !B.state.has("resistor-1k"), "edits are not applied before the room accepts them");
  // The room handles A's edit, then B's; replies are delivered late, B's queue first.
  net.serverStep();
  net.serverStep();
  B.deliver();
  B.deliver();
  A.deliver();
  net.settle();
  eq(A.results.get(a), { ok: true }, "A's edit accepted");
  eq(B.results.get(b)?.reason, "stale", "B's concurrent edit is refused as stale, not silently accepted");
  eq(views(A)[0], views(B)[0], "A and B end identical");
  eq(A.state.get("resistor-1k").props, { ohms: 470 }, "both hold the accepted value");
  const C = new Client("C");
  net.connect(C);
  net.settle();
  eq(views(C)[0], views(A)[0], "a late joiner matches");
  eq(serverView(net), views(A)[0], "and matches the room's authoritative state");
}

// ── P1: endpoint vs whole-part claims ───────────────────────────────────────────────────────
{
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  net.connect(A);
  net.connect(B);
  net.settle();
  A.startDrag("wire-red::endpoint-0");
  net.serverStep(); // A's claim accepted
  B.startDrag("wire-red"); // B has not seen A's claim yet
  B.move("wire-red", { ...seat(null), endpoints: [[-0.2, 0, 0], [0.2, 0, 0]] });
  net.settle();
  ok(B.deniedDrag, "a whole-part claim is denied while a cable end is held");
  ok(!B.dragging, "and B's drag is cancelled");
  ok(!net.core.state.has("wire-red"), "B's whole-part move was not accepted");
  ok(!B.state.has("wire-red"), "B reverted to the room's state");
  A.move("wire-red", { ...DEFAULT_WIRE, sockets: [16, null], endpoints: [[0, 0, 0], DEFAULT_WIRE.endpoints[1]], activeEndpoint: 0 });
  net.settle();
  // An import/undo that touches the cable is refused while the end is held, atomically.
  const op = B.edit([
    { componentId: "led-red", transform: seat([53, 52]) },
    { componentId: "wire-red", transform: seat(null) },
  ]);
  net.settle();
  eq(B.results.get(op)?.reason, "held", "an edit touching a held cable end is refused");
  ok(!net.core.state.has("led-red") && !B.state.has("led-red"), "and nothing in the batch was committed");
  A.release("wire-red::endpoint-0");
  net.settle();
  eq(views(A)[0], views(B)[0], "A and B identical after the end is released");
  // The reverse: whole part held, an end claim is denied.
  A.startDrag("wire-blue");
  net.settle();
  B.startDrag("wire-blue::endpoint-1");
  B.move("wire-blue", { ...seat([1, 2]), endpoints: [[0, 0, 0], [0.4, 0, 0]], activeEndpoint: 1 });
  net.settle();
  ok(B.deniedDrag && !net.core.state.has("wire-blue"), "an end claim is denied while the whole cable is held");
  A.release("wire-blue");
  net.settle();
  eq(views(A)[0], views(B)[0], "still identical");
}

// ── P1: a refused drag with a holder who disconnects without a final move ──────────────────
{
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  const C = new Client("C");
  net.connect(A);
  net.connect(B);
  net.connect(C);
  net.settle();
  A.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 1000 }) }]);
  net.settle();
  A.startDrag("resistor-1k");
  net.serverStep();
  // B has not seen A's claim; it drags optimistically, then A drops off.
  B.startDrag("resistor-1k");
  B.move("resistor-1k", seat([100, 103]));
  const refusedEdit = B.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 470 }) }]);
  // The room refuses B's claim, move and edit (A holds the part)…
  net.serverStep();
  net.serverStep();
  net.serverStep();
  // …then A disconnects before sending any final move.
  net.disconnect(A);
  net.settle();
  eq(B.results.get(refusedEdit)?.ok, false, "B's edit was refused");
  eq(B.state.get("resistor-1k")?.sockets, [36, 39], "B's refused move was replaced by the room's state");
  eq(B.state.get("resistor-1k")?.props, { ohms: 1000 }, "B keeps the room's value, not its refused 470");
  eq(views(B)[0], views(C)[0], "B and C identical though the holder never sent a final move");
  const D = new Client("D");
  net.connect(D);
  net.settle();
  eq(views(D)[0], views(C)[0], "a late joiner matches");
}

// ── Atomic program + parts edits, stale program refused ────────────────────────────────────
{
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  net.connect(A);
  net.connect(B);
  net.settle();
  const Q = [{ op: "write", pin: "D5", value: true }];
  const R = [{ op: "write", pin: "D6", value: true }];
  A.edit([{ componentId: "sno-l1", transform: seat([10, 28]) }], { program: Q, running: false });
  net.settle();
  eq(B.program, { program: Q, running: false }, "a program import reaches the teammate");
  // B uploads R while A's undo (based on the old program revision) is in flight.
  B.send({ kind: "program", program: R, running: true });
  const undo = A.edit([{ componentId: "sno-l1", transform: seat(null) }], { program: [], running: false });
  net.settle();
  eq(A.results.get(undo)?.reason, "stale", "an undo based on an older program is refused");
  ok(net.core.state.get("sno-l1").transform.sockets[0] === 10, "and its parts were not committed either");
}

// ── History/traces follow the room: a refused drag never counts, an accepted one does ───
{
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  net.connect(A);
  net.connect(B);
  net.settle();
  A.startDrag("led-red");
  net.serverStep();
  B.startDrag("led-red"); // not yet seen A's claim
  B.move("led-red", seat([60, 61]));
  B.release("led-red");
  eq(B.settled.has("led-red"), false, "B's drag is not counted before the room answers");
  net.settle();
  eq(B.claimResults.get("led-red"), false, "B's claim was denied");
  eq(B.settled.get("led-red"), false, "B's drag settles as refused (no history entry, no move trace)");
  eq(A.claimResults.get("led-red"), true, "A's claim was granted");
  A.move("led-red", seat([53, 52]));
  A.release("led-red");
  net.settle();
  eq(A.settled.get("led-red"), true, "A's accepted drag settles as counted");
  eq(views(A)[0], views(B)[0], "A and B identical");
}

// ── Program uploads: ordered by the room, never optimistic; joiners get the program ───────
{
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  net.connect(A);
  net.connect(B);
  net.settle();
  const R = [{ op: "write", pin: "D5", value: true }];
  const S = [{ op: "write", pin: "D6", value: true }];
  const a = A.edit([], { program: R, running: true, conditional: false });
  const b = B.edit([], { program: S, running: true, conditional: false });
  eq(A.program, undefined, "an upload is not applied before the room orders it");
  net.serverStep();
  net.serverStep();
  B.deliver();
  B.deliver();
  net.settle();
  ok(A.results.get(a)?.ok && B.results.get(b)?.ok, "both unconditional uploads are accepted");
  eq(A.program, B.program, "and both clients run the same program (the room's last)");
  eq(A.program, { program: S, running: true }, "which is the one the room ordered last");
  const C = new Client("C");
  net.connect(C);
  net.settle();
  eq(C.program, A.program, "a late joiner gets the room's program");
}

// ── Reconnects: the room's state wins; an emptied room is re-seeded by the returning bench ─
{
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  net.connect(A);
  net.connect(B);
  net.settle();
  A.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 1000 }) }]);
  net.settle();
  // A drops mid-drag (its moves never reach the room); B keeps working meanwhile.
  A.startDrag("resistor-1k");
  A.move("resistor-1k", seat([100, 103]));
  net.disconnect(A);
  B.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 220 }) }, { componentId: "led-red", transform: seat([53, 52]) }]);
  net.settle();
  A.reconnect(net);
  net.settle();
  eq(views(A)[0], views(B)[0], "a reconnecting client takes the room's state over its offline drag");
  // Everyone leaves; A comes back alone to an emptied room and re-seeds it with its bench.
  net.disconnect(B);
  A.reconnect(net);
  net.settle();
  eq(serverView(net), views(A)[0], "an emptied room is re-seeded from the returning bench");
  const C = new Client("C");
  net.connect(C);
  net.settle();
  eq(views(C)[0], views(A)[0], "and a joiner after that matches");
}

// ── Two people each holding one end of the same cable ─────────────────────────────────────
{
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  net.connect(A);
  net.connect(B);
  net.settle();
  const endMove = (client, end, socket, x) => {
    const base = client.state.get("wire-yellow") ?? DEFAULT_WIRE;
    const endpoints = [base.endpoints[0], base.endpoints[1]];
    endpoints[end] = [x, 0, 0];
    const sockets = Array.isArray(base.sockets) ? [...base.sockets] : [null, null];
    sockets[end] = socket;
    const transform = { position: base.position, rotation: base.rotation, sockets, endpoints, activeEndpoint: end };
    client.apply("wire-yellow", { ...transform, activeEndpoint: undefined });
    client.replica.noteOwnTransform("wire-yellow");
    client.send({ kind: "transform", componentId: "wire-yellow", transform, sequence: (client.sequence += 1) });
  };
  A.startDrag("wire-yellow::endpoint-0");
  B.startDrag("wire-yellow::endpoint-1");
  A.dragging = null;
  B.dragging = null;
  // Each moves its own end before seeing the other's.
  endMove(A, 0, 16, -1);
  endMove(B, 1, 40, 2);
  endMove(A, 0, 17, -0.9);
  net.settle();
  A.send({ kind: "release", componentId: "wire-yellow::endpoint-0" });
  B.send({ kind: "release", componentId: "wire-yellow::endpoint-1" });
  net.settle();
  eq(A.state.get("wire-yellow").sockets, [17, 40], "A sees both ends where their holders left them");
  eq(views(A)[0], views(B)[0], "A and B identical");
  const C = new Client("C");
  net.connect(C);
  net.settle();
  eq(views(C)[0], views(A)[0], "a late joiner gets both ends (the room merges cable-end moves)");
}

// ── PR #3 follow-up review: timeouts, room resets, switch state, peer clocks ───────────────
{
  // An edit answered after the sender gave up still applies there (the room accepted it).
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  net.connect(A);
  net.connect(B);
  net.settle();
  const op = A.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 470 }) }]);
  A.run(A.replica.expire(op));
  eq(A.results.get(op)?.reason, "timeout", "the sender stops waiting");
  net.settle();
  eq(views(A)[0], views(B)[0], "the late acceptance still applies for the sender");
  eq(A.state.get("resistor-1k").props, { ohms: 470 }, "with the accepted value");
  const next = A.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 220 }) }]);
  net.settle();
  eq(A.results.get(next)?.ok, true, "and its revisions stay current (the next edit is not refused)");
}
{
  // Alone in a room that resets (last socket closed): old revisions must not cause false refusals.
  const net = new Net();
  const A = new Client("A");
  net.connect(A);
  net.settle();
  A.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 470 }) }]);
  net.settle();
  net.disconnect(A); // the room resets
  A.state.clear(); // (seeding is covered above; here the bench is back at its defaults)
  A.reconnect(net);
  net.settle();
  const op = A.edit([{ componentId: "resistor-1k", transform: seat([36, 39], { ohms: 1000 }) }]);
  net.settle();
  eq(A.results.get(op)?.ok, true, "an edit after a room reset is not refused as stale");
}
{
  // A switch flip racing a quick drag of the switch: everyone ends with the room's switch state.
  const net = new Net();
  const A = new Client("A");
  const B = new Client("B");
  net.connect(A);
  net.connect(B);
  net.settle();
  B.edit([{ componentId: "snap-s1", transform: { ...seat([1, 2]), on: true } }]);
  A.startDrag("snap-s1");
  A.move("snap-s1", { ...seat([3, 4]), on: false });
  net.settle();
  A.release("snap-s1");
  net.settle();
  eq(views(A)[0], views(B)[0], "A and B agree on the switch after the race");
  eq(net.core.state.get("snap-s1").transform.on, true, "a move never overwrites the accepted switch state");
  const C = new Client("C");
  net.connect(C);
  net.settle();
  eq(views(C)[0], views(A)[0], "and a late joiner too");
}
{
  // Peer mode: a tab that joins after a lot of activity adopts the sender's clock, so its first
  // change is not ignored by the older tabs.
  const old = new SyncReplica("A", "peer");
  for (let i = 0; i < 200; i += 1) old.stampTransform("led-red");
  const joiner = new SyncReplica("C", "peer");
  joiner.observeClock(old.clock);
  const { message } = joiner.createEdit("C-1", [{ componentId: "led-red", transform: seat([53, 52]) }]);
  ok(old.receive(structuredClone(message)).some((effect) => effect.type === "apply"), "the joiner's first edit wins over the older tab's moves");
  ok(old.acceptTransform("led-red", joiner.stampTransform("led-red")), "and so does its first move");
}

// ── Random interleavings: everyone always ends identical ───────────────────────────────────
{
  let seed = Number(process.env.SYNC_SEED ?? 42);
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const parts = ["resistor-1k", "resistor-220", "led-red", "wire-red", "battery-9v", "snap-s1"];
  let schedules = 0;
  let refusals = 0;
  let accepted = 0;
  for (let trial = 0; trial < Number(process.env.SYNC_TRIALS ?? 400); trial += 1) {
    DEBUG = trial === DEBUG_TRIAL ? DEBUG_PART : "";
    const net = new Net();
    const clients = ["A", "B", "C"].map((id) => new Client(id));
    for (const client of clients) net.connect(client);
    net.settle();
    for (let step = 0; step < 60; step += 1) {
      const roll = random();
      const client = pick(clients.filter((candidate) => net.clients.has(candidate.id)));
      if (!client) break;
      void 0;
      if (roll < 0.3) {
        const count = 1 + Math.floor(random() * 2);
        const changes = [...new Set(Array.from({ length: count }, () => pick(parts)))].map((componentId) => ({
          componentId,
          transform: {
            ...seat(random() < 0.3 ? null : [Math.floor(random() * 190), 191], componentId.startsWith("resistor") ? { ohms: pick([220, 470, 1000]) } : undefined),
            // A switch flip, or (sometimes) an edit that leaves the switch state out.
            ...(componentId === "snap-s1" && random() < 0.7 ? { on: random() < 0.5 } : {}),
          },
        }));
        const programRoll = random();
        const program = programRoll < 0.25
          ? { program: [{ op: "write", pin: pick(["D5", "D6", "D9"]), value: random() < 0.5 }], running: random() < 0.5, conditional: programRoll < 0.12 }
          : undefined;
        client.edit(programRoll < 0.06 ? [] : changes, program);
      } else if (roll < 0.45 && !client.dragging) {
        const part = pick(parts);
        client.startDrag(part === "wire-red" && random() < 0.5 ? `wire-red::endpoint-${random() < 0.5 ? 0 : 1}` : part);
      } else if (roll < 0.6 && client.dragging) {
        client.move(client.dragging, seat([Math.floor(random() * 190), 191]));
      } else if (roll < 0.7 && client.dragging) {
        const held = [...client.owners].find(([, owner]) => owner === client.id)?.[0] ?? client.dragging;
        client.release(held);
      } else if (roll < 0.72 && net.clients.size > 2) {
        net.disconnect(client);
      } else if (roll < 0.74) {
        client.reconnect(net);
      } else if (roll < 0.95) {
        net.serverStep();
      } else {
        for (const other of clients) if (random() < 0.5) other.deliver();
      }
      // Random partial delivery between steps.
      for (const other of clients) if (net.clients.has(other.id) && random() < 0.3) other.deliver();
    }
    // Everyone still connected lets go, then the network drains.
    for (const client of clients) {
      if (!net.clients.has(client.id)) continue;
      for (const [resourceId, owner] of [...client.owners]) if (owner === client.id) client.release(resourceId);
    }
    net.settle();
    const connected = clients.filter((client) => net.clients.has(client.id));
    const late = new Client("Z");
    net.connect(late);
    net.settle();
    const all = views(...connected, late);
    assert.ok(all.every((view) => view === all[0]), `trial ${trial}: clients diverged\n${[...connected.map((c) => c.id), "Z"].map((id, i) => `${id}: ${all[i]}`).join("\n")}\nroom: ${serverView(net)}`);
    assert.equal(all[0], serverView(net), `trial ${trial}: clients differ from the room`);
    const programs = [...connected, late].map((client) => JSON.stringify(client.program ?? null));
    const roomProgram = JSON.stringify(net.core.program ?? null);
    assert.ok(programs.every((value) => value === roomProgram), `trial ${trial}: programs diverged\n${programs.join("\n")}\nroom: ${roomProgram}`);
    for (const client of connected) for (const result of client.results.values()) if (!result.ok) refusals += 1; else accepted += 1;
    schedules += 1;
  }
  checks += schedules * 2;
  ok(refusals > 0, "random schedules exercised refusals");
  ok(accepted > 0, "random schedules accepted edits too");
  console.log(`sync: ${schedules} random multi-client schedules converged (${accepted} edits accepted, ${refusals} refused)`);
}

// ── Peer mode (same-device tabs): concurrent edits converge by Lamport order ───────────────
{
  const tabs = ["A", "B", "C"].map((id) => ({ id, replica: new SyncReplica(id, "peer"), state: new Map() }));
  const run = (tab, effects) => {
    for (const effect of effects) if (effect.type === "apply") tab.state.set(effect.componentId, effect.transform.props?.ohms);
  };
  const messages = [];
  for (const [tab, ohms] of [[tabs[0], 470], [tabs[1], 220], [tabs[2], 330]]) {
    const { message, immediate } = tab.replica.createEdit(`${tab.id}-1`, [{ componentId: "resistor-1k", transform: seat([1, 2], { ohms }) }]);
    run(tab, immediate);
    messages.push({ from: tab.id, message });
  }
  // Deliver in a different order to each tab.
  for (const [index, tab] of tabs.entries()) {
    const order = index === 0 ? messages : index === 1 ? [...messages].reverse() : [messages[1], messages[0], messages[2]];
    for (const { from, message } of order) if (from !== tab.id) run(tab, tab.replica.receive(structuredClone(message)));
  }
  eq(new Set(tabs.map((tab) => tab.state.get("resistor-1k"))).size, 1, "same-device tabs converge on one value");
  // Concurrent live moves of one part converge by stamp too, whatever the delivery order.
  const moves = tabs.map((tab, index) => {
    const stamp = tab.replica.stampTransform("led-red");
    tab.state.set("led-red", index);
    return { from: tab.id, stamp, value: index };
  });
  for (const [index, tab] of tabs.entries()) {
    const order = index === 1 ? [...moves].reverse() : moves;
    for (const move of order) if (move.from !== tab.id && tab.replica.acceptTransform("led-red", move.stamp)) tab.state.set("led-red", move.value);
  }
  eq(new Set(tabs.map((tab) => tab.state.get("led-red"))).size, 1, "same-device tabs converge on concurrent moves");
}

console.log(`sync: ${checks} checks passed`);
