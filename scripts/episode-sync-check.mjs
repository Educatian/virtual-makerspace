// Rescue Signal Workshop on the real room core (cloudflare/room-core.js, as used by the
// Durable Object and the local relay), with a controllable server clock and delayed delivery:
// roles, transmissions, readings, late join/reconnect, concurrent bench/program edits during a
// transmission, atomic imports, stale role actions and program revisions.
//   node --experimental-strip-types scripts/episode-sync-check.mjs
import assert from "node:assert/strict";

const { RoomCore } = await import("../cloudflare/room-core.js");
const { sanitizeEdit, sanitizeTransform } = await import("../cloudflare/sanitize.js");
const { sanitizeRescueAction, transmitting, supersedes } = await import("../src/episodes/rescue-state.ts");
const { compileMessage, programDurationMs, lightPulses, decode, compare } = await import("../src/episodes/rescue-signal.ts");
const { SNAPINO_PADS } = await import("../src/circuit/snapino-circuit.ts");

let checks = 0;
const ok = (value, label) => { checks += 1; assert.ok(value, label); };
const eq = (a, b, label) => { checks += 1; assert.deepEqual(a, b, label); };

let clock = 1_000_000;
const core = new RoomCore({ now: () => clock });
const seat = (sockets) => ({ position: [0, 0.48, 0], rotation: [0, 0, 0], sockets });

class Client {
  constructor(id) {
    this.id = id;
    this.inbox = [];
    this.episode = null;
    this.programRev = 0;
    this.program = null;
    this.results = new Map();
    this.op = 0;
    this.serverOffset = 0;
  }
  deliver() {
    while (this.inbox.length) {
      const message = this.inbox.shift();
      if (message.serverNow !== undefined) this.serverOffset = message.serverNow - clock;
      if (message.kind === "room-state") {
        this.episode = message.episode;
        this.programRev = message.programRev;
      } else if (message.kind === "episode-state") {
        // The client's own rule (collaboration.ts): never apply an older revision.
        if (!supersedes(this.episode, message.state)) { this.dropped = (this.dropped ?? 0) + 1; continue; }
        this.episode = message.state;
        if (message.program) {
          this.programRev = message.program.rev;
          this.program = message.program;
        }
      } else if (message.kind === "episode-result") this.results.set(message.opId, message);
      else if (message.kind === "edit-result" && message.programRev !== undefined) this.programRev = message.programRev;
      else if (message.kind === "edit" && message.program) this.programRev = message.program.rev;
    }
  }
}
const clients = new Map();
const send = (client, raw) => {
  let message = raw;
  if (raw.kind === "episode") {
    const action = sanitizeRescueAction(raw.action);
    if (!action) return null;
    message = { kind: "episode", participantId: client.id, opId: raw.opId, action };
  } else if (raw.kind === "edit") {
    const edit = sanitizeEdit(raw);
    if (!edit) return null;
    message = { kind: "edit", participantId: client.id, ...edit };
  } else if (raw.kind === "transform") {
    message = { ...raw, transform: sanitizeTransform(raw.transform, raw.componentId) };
  }
  const result = core.handle({ id: client.id, name: client.id }, message);
  for (const reply of result.sender) client.inbox.push(structuredClone(reply));
  for (const relay of result.others) for (const other of clients.values()) if (other !== client) other.inbox.push(structuredClone(relay));
  return result;
};
const join = (id) => {
  const client = new Client(id);
  clients.set(id, client);
  for (const message of core.join()) client.inbox.push(structuredClone(message));
  client.deliver();
  return client;
};
const leave = (client) => {
  clients.delete(client.id);
  for (const message of core.leave({ id: client.id, name: client.id })) for (const other of clients.values()) other.inbox.push(structuredClone(message));
  if (clients.size === 0) core.reset();
};
const act = (client, action) => {
  const opId = `${client.id}-${(client.op += 1)}`;
  send(client, { kind: "episode", opId, action });
  return opId;
};
const settle = () => { for (const client of clients.values()) client.deliver(); };
const resultOf = (client, opId) => client.results.get(opId);
/** What a client renders: elapsed into the transmission, from the server time it estimates. */
const elapsedFor = (client) => clock + client.serverOffset - client.episode.round.startedAt;

const lampOnD5 = [
  ["sno-l1", seat([SNAPINO_PADS.D5, 30])],
  ["sno-w3", seat([30, 33])],
  ["sno-w2a", seat([33, SNAPINO_PADS.GND])],
];

const A = join("A");
const B = join("B");
act(A, { type: "open" });
act(A, { type: "claim-role", role: "sender" });
act(B, { type: "claim-role", role: "receiver" });
settle();
eq([A.episode.roles.sender?.id, B.episode.roles.receiver?.id], ["A", "B"], "roles are room state, seen by both");

// The sender builds the transmitter (an ordinary room edit) and designs the message.
send(A, { kind: "edit", opId: "build", changes: lampOnD5.map(([componentId, transform]) => ({ componentId, transform, expectRev: 0 })) });
act(A, { type: "set-design", mission: "ridge", words: ["INJURED", "NORTH"] });
settle();
const program = compileMessage(["INJURED", "NORTH"], "D5", 48);
const duration = programDurationMs(program);

// Two clients act at once: B tries to transmit (refused: not sender), A transmits.
const refused = act(B, { type: "transmit", program, tx: null });
const sent = act(A, { type: "transmit", program, tx: null });
settle();
eq(resultOf(B, refused)?.reason, "not-sender", "only the sender's transmit is accepted");
ok(resultOf(A, sent)?.ok, "the sender's transmit is accepted");
eq(A.episode, B.episode, "both clients hold the same episode state");
eq(A.programRev, B.programRev, "and the same program revision (the sent program is the room's)");
ok(A.program?.running === false && JSON.stringify(A.program.program) === JSON.stringify(program), "the room program is the transmitted one, stopped");
eq(B.episode.round.bench["sno-l1"].sockets, [SNAPINO_PADS.D5, 30], "the round's bench is the room's (server snapshot)");

// Late joiner mid-transmission: lands at the same elapsed time (± transit, here zero).
clock += 2000;
const C = join("C");
eq(elapsedFor(C), 2000, "a late joiner computes the shared elapsed time from the room's clock");
eq(elapsedFor(A), 2000, "the same as the sender");
ok(transmitting(C.episode, clock), "and sees it running");
// The receiver cannot read before the end; reading after the end is accepted once.
const early = act(B, { type: "read", tx: B.episode.round.tx, words: ["INJURED", "NORTH"], confidence: "sure" });
settle();
eq(resultOf(B, early)?.reason, "not-ended", "no reading before the transmission ends");
clock += duration;
const reading = act(B, { type: "read", tx: B.episode.round.tx, words: ["INJURED", "NORTH"], confidence: "sure" });
settle();
ok(resultOf(B, reading)?.ok, "the receiver's reading is accepted after the end");
eq(C.episode.round.reading, { words: ["INJURED", "NORTH"], confidence: "sure" }, "everyone sees the same reading");
// The comparison every client derives from the same state is identical — and correct.
const outcomeFor = (client) => {
  const round = client.episode.round;
  return compare(round.intent, decode(lightPulses({ program: round.program, bench: round.bench, durationMs: round.durationMs, stoppedAtMs: round.stoppedAtMs })), round.reading.words);
};
eq(outcomeFor(A).outcome, "delivered", "a correct transmission read correctly is delivered");
eq([outcomeFor(B), outcomeFor(C)], [outcomeFor(A), outcomeFor(A)], "every client derives the same outcome");

// Round 2: a concurrent bench edit during the transmission ends it for everyone.
act(A, { type: "close-round", tx: A.episode.round.tx });
act(A, { type: "set-design", mission: "creek", words: ["SAFE", "WATER"] });
act(A, { type: "transmit", program: compileMessage(["SAFE", "WATER"], "D5", 48), tx: null });
settle();
clock += 1500;
const revOf = (id) => core.rev(id);
send(B, { kind: "edit", opId: "unplug", changes: [{ componentId: "sno-w2a", transform: seat(null), expectRev: revOf("sno-w2a") }] });
settle();
eq([A.episode.round.stopReason, A.episode.round.stoppedAtMs], ["bench-changed", 1500], "a bench edit during a transmission ends it at that moment");
eq(A.episode, B.episode, "for everyone");
ok(A.episode.round.bench["sno-w2a"].sockets[0] === 33, "the round still records the transmitter as it was when it ran");
// The receiver may now read the cut-off signal; the outcome is honest about it.
act(B, { type: "read", tx: B.episode.round.tx, words: ["SAFE", "WATER"], confidence: "sure" });
settle();
ok(!outcomeFor(A).delivered, "a cut-off transmission is not delivered even with the intended reading");

// Round 3: a program edit (e.g. importing the identical program, which sends a stop) ends it.
act(A, { type: "close-round", tx: A.episode.round.tx });
send(A, { kind: "edit", opId: "rebuild", changes: [{ componentId: "sno-w2a", transform: seat([33, SNAPINO_PADS.GND]), expectRev: revOf("sno-w2a") }] });
act(A, { type: "set-design", mission: "storm", words: ["HELP", "SOUTH"] });
const helpSouth = compileMessage(["HELP", "SOUTH"], "D5", 48);
act(A, { type: "transmit", program: helpSouth, tx: null });
settle();
clock += 700;
send(B, { kind: "edit", opId: "same-program", changes: [], program: { program: helpSouth, running: false, expectRev: B.programRev } });
settle();
eq(A.episode.round.stopReason, "program-changed", "an accepted program edit (identical program, stopped) ends the running transmission");
// Round 4: a changed-parts + program import is ONE atomic edit and stops it once.
act(A, { type: "close-round", tx: A.episode.round.tx });
act(A, { type: "transmit", program: helpSouth, tx: null });
settle();
ok(resultOf(A, `A-${A.op}`)?.ok, "round 4 transmits");
const revBefore = A.episode.rev;
clock += 300;
send(B, { kind: "edit", opId: "import", changes: [{ componentId: "sno-l1", transform: seat([SNAPINO_PADS.D6, 30]), expectRev: revOf("sno-l1") }], program: { program: compileMessage(["HELP", "SOUTH"], "D6", 48), running: false, expectRev: B.programRev } });
settle();
eq([A.episode.round.stopReason, A.episode.rev - revBefore], ["program-changed", 1], "parts + program in one import: one atomic edit, the transmission stops once");
eq(A.episode, C.episode, "every client agrees");
// A stale program revision is refused (the transmit bumped the room's program revision).
const staleProgram = send(C, { kind: "edit", opId: "stale", changes: [], program: { program: helpSouth, running: true, expectRev: 0 } });
settle();
ok(staleProgram.sender.some((reply) => reply.kind === "edit-result" && reply.reason === "stale"), "an edit based on an older program revision is refused");

// Roles: swap between rounds, stale role actions after a leave, reconnect.
act(A, { type: "close-round", tx: A.episode.round.tx });
const swap = act(B, { type: "swap-roles" });
settle();
ok(resultOf(B, swap)?.ok && A.episode.roles.sender.id === "B", "roles swap between rounds");
leave(B); // the new sender drops out
settle();
eq(A.episode.roles.sender, null, "the leaver's role is free");
const B2 = join("B2"); // B reconnects with a new session id
const ghost = act(B2, { type: "transmit", program: helpSouth, tx: null });
settle();
eq(resultOf(B2, ghost)?.reason, "not-sender", "a reconnected session must claim the role again (no stale role)");
act(B2, { type: "claim-role", role: "sender" });
settle();
eq(A.episode.roles.sender?.id, "B2", "it can");
eq(B2.episode.history.length, 4, "the reconnecting client gets the full round history from the room");

// Everyone leaves mid-transmission: the transmission ends, rounds stay, roles clear.
act(B2, { type: "set-design", mission: "ridge", words: ["HELP"] });
act(B2, { type: "transmit", program: compileMessage(["HELP"], "D5", 48), tx: null });
settle();
clock += 200;
for (const client of [...clients.values()]) leave(client);
eq([core.episode.round.stopReason, core.episode.roles.sender, core.episode.history.length], ["room-empty", null, 4], "an emptied room stops the transmission and keeps the history");
const D = join("D");
ok(!transmitting(D.episode, clock), "a later joiner does not see a phantom running transmission");

// ── Parent review: reset convergence and transmission identity on the real room core ────────
{
  // Fresh room, two connected clients and a later joiner; delivery is delayed per client.
  clock += 10_000;
  const E = join("E");
  const F = join("F");
  act(E, { type: "open" });
  act(E, { type: "claim-role", role: "sender" });
  act(F, { type: "claim-role", role: "receiver" });
  act(E, { type: "set-design", mission: "storm", words: ["HELP"] });
  const help = compileMessage(["HELP"], "D5", 48);
  act(E, { type: "transmit", program: help, tx: null });
  settle();
  const txP = F.episode.round.tx;
  clock += programDurationMs(help) + 50;
  // F makes a reading of P, but its packet is "slow": we send it only after a retransmission.
  const slowRead = { type: "read", tx: txP, words: ["HELP"], confidence: "sure" };
  act(E, { type: "transmit", program: [{ op: "wait", ms: 500 }], tx: txP });
  settle();
  ok(F.episode.round.tx !== txP && F.episode.round.n === E.episode.round.n, "a retransmission keeps the round number with a new tx, on both clients");
  clock += 600;
  const late = act(F, slowRead);
  settle();
  eq(resultOf(F, late)?.reason, "stale-round", "the room refuses a delayed reading of the replaced transmission");
  ok(F.episode.round.reading === null, "and records nothing");
  act(F, { type: "read", tx: F.episode.round.tx, words: ["?"], confidence: "unsure" });
  act(F, { type: "explain", tx: F.episode.round.tx, text: "Nothing came the second time." });
  const archived = E.episode.round.tx;
  act(E, { type: "close-round", tx: archived });
  for (let i = 0; i < 6; i += 1) act(E, { type: "set-design", mission: "storm", words: ["HELP"] });
  settle();
  const before = E.episode.rev;
  ok(before >= 12 && E.episode.history.length >= 1, `(revision ${before}, history ${E.episode.history.length})`);
  const reset = act(E, { type: "reset" });
  settle();
  ok(resultOf(E, reset)?.ok, "the reset is accepted");
  eq([E.episode.rev, E.episode.history.length, F.episode.rev, F.episode.history.length], [before + 1, 0, before + 1, 0], "both CONNECTED clients apply the reset immediately (revision continues)");
  eq(E.episode, core.episode, "and hold exactly the room's state");
  const G = join("G");
  eq(G.episode, core.episode, "a late joiner gets the same state");
  // After the reset: the next design and transmission reach everyone.
  act(E, { type: "set-design", mission: "storm", words: ["HELP"] });
  act(E, { type: "transmit", program: help, tx: null });
  settle();
  ok(E.episode.round?.n === 1 && F.episode.round?.tx === E.episode.round.tx && G.episode.round?.tx === E.episode.round.tx, "the next transmission reaches every client (round 1 again, new tx)");
  ok(F.episode.round.tx > archived, "its tx is new");
  clock += programDurationMs(help) + 50;
  for (const [client, stale] of [[F, { type: "read", tx: txP, words: ["HELP"], confidence: "sure" }], [E, { type: "close-round", tx: archived }], [F, { type: "explain", tx: archived, text: "old" }]]) {
    const op = act(client, stale);
    settle();
    eq(resultOf(client, op)?.reason, "stale-round", `a pre-reset ${stale.type} is refused against the new round 1`);
  }
  // A late duplicate of a pre-reset state is still dropped by connected clients.
  const dropped = F.dropped ?? 0;
  F.inbox.push({ kind: "episode-state", state: { ...F.episode, rev: before, history: [{ fake: true }] }, serverNow: clock });
  F.deliver();
  ok((F.dropped ?? 0) === dropped + 1 && F.episode.rev > before, "an older (pre-reset) revision arriving late is dropped");
  // Storage round trip (what the Durable Object persists and reloads) keeps the revision.
  const { sanitizeRescueState } = await import("../src/episodes/rescue-state.ts");
  const reloaded = new RoomCore({ now: () => clock, episode: sanitizeRescueState(JSON.parse(JSON.stringify(core.episode))) });
  ok(reloaded.episode.rev === core.episode.rev && reloaded.episode.round.tx === core.episode.round.tx, "a reloaded room keeps the revision and the transmission id");
}

// Clock samples: the room echoes the client's t0 with its own time (no state change, no relay).
{
  const echo = core.handle({ id: "Z", name: "Z" }, { kind: "clock", t0: 123.5 });
  eq([echo.sender, echo.others, echo.persist], [[{ kind: "clock", t0: 123.5, serverNow: clock }], [], {}], "a clock ping is answered to the sender only");
}

// The client's rule for keeping a clock sample (src/desktop/room-clock.ts). A busy page's sample
// (round trip of seconds) must never replace a good estimate, even a minute-old one: a final
// developer-environment run caught a sender whose 9-ms-class estimate was "refreshed" after a
// minute by a 5.3 s sample, leaving it 2.6 s off while the light ran.
{
  const { acceptClockSample } = await import("../src/desktop/room-clock.ts");
  ok(acceptClockSample(null, 4000, 0), "a first sample is always taken, however slow");
  ok(acceptClockSample({ rtt: 4000, at: 0 }, 300, 1000), "a shorter round trip replaces a longer one");
  ok(!acceptClockSample({ rtt: 12, at: 0 }, 40, 30_000), "a longer round trip does not replace a recent estimate");
  ok(!acceptClockSample({ rtt: 12, at: 0 }, 5271, 61_000), "a busy page's 5.3 s sample never replaces a good minute-old estimate");
  ok(acceptClockSample({ rtt: 12, at: 0 }, 300, 61_000), "a comparable sample may refresh a minute-old estimate (drift)");
  ok(!acceptClockSample({ rtt: 900, at: 0 }, 1900, 61_000), "a refresh may at most double a poor estimate's round trip");
  ok(!acceptClockSample({ rtt: 12, at: 0 }, -1, 1) && !acceptClockSample(null, 70_000, 1) && !acceptClockSample(null, Number.NaN, 1), "negative, absurd and non-numeric round trips are ignored");
  // The failing sequence, replayed: good start, then a busy minute of slow samples every 20 s.
  let estimate = null;
  for (const [rtt, at] of [[9, 0], [5271, 20_000], [4800, 40_000], [5271, 61_000], [5100, 81_000]]) if (acceptClockSample(estimate, rtt, at)) estimate = { rtt, at };
  eq(estimate, { rtt: 9, at: 0 }, "through a busy minute the 9 ms estimate is kept (error bound 4.5 ms, not 2.6 s)");
}

console.log(`episode sync: ${checks} checks passed`);
