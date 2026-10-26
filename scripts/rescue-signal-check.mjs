// Rescue Signal Workshop — deterministic checks of the signal domain and the episode reducer.
//   node --experimental-strip-types scripts/rescue-signal-check.mjs
// Includes an independent oracle: a 1 ms sampler with its own block interpreter and its own
// stud-graph search, compared with lightPulses() on random programs and random snap layouts.
import assert from "node:assert/strict";

const signal = await import("../src/episodes/rescue-signal.ts");
const stateMod = await import("../src/episodes/rescue-state.ts");
const { SNAPINO_PADS } = await import("../src/circuit/snapino-circuit.ts");
const { WORDS, WORD_LIST, TIMING, classifyFlash, classifyGap, compileMessage, lightPulses, decode, compare, diagnose, programDurationMs, wiredPin } = signal;

let checks = 0;
const ok = (value, label) => { checks += 1; assert.ok(value, label); };
const eq = (a, b, label) => { checks += 1; assert.deepEqual(a, b, label); };

// A lamp from `pin` across two studs down to GND via wires, like the Snapino demo.
const benchFor = (pin, extra = {}) => ({
  "sno-l1": { sockets: [SNAPINO_PADS[pin], 30] },
  "sno-w3": { sockets: [30, 33] },
  "sno-w2a": { sockets: [33, SNAPINO_PADS.GND] },
  ...extra,
});
const run = (program, bench, stoppedAtMs = null) => ({ program, bench, durationMs: programDurationMs(program), stoppedAtMs });

// ── Protocol bands ─────────────────────────────────────────────────────────────────────────
eq([199, 200, 450, 451, 649, 650, 1500, 1501].map((ms) => classifyFlash(ms).kind), ["?", "S", "S", "?", "?", "L", "L", "?"], "flash bands are inclusive at 200/450 and 650/1500");
eq([199, 200, 600, 601, 1199, 1200, 9000].map((ms) => classifyGap(ms).kind), ["?", "within", "within", "?", "?", "pause", "pause"], "gap bands: within 200–600, pause ≥ 1200");
ok(new Set(WORD_LIST.map((word) => WORDS[word].join(""))).size === WORD_LIST.length, "the six words have distinct patterns");

// ── Every message of 1–3 words round-trips on every output pin ──────────────────────────────
let roundTrips = 0;
for (const pin of ["D3", "D5", "D6"]) {
  for (const a of WORD_LIST) {
    for (const message of [[a], ...WORD_LIST.map((b) => [a, b]), ...WORD_LIST.slice(0, 2).flatMap((b) => WORD_LIST.slice(0, 2).map((c) => [a, b, c]))]) {
      const program = compileMessage(message, pin, 48);
      if (!program) continue;
      const decoded = decode(lightPulses(run(program, benchFor(pin))));
      assert.deepEqual(decoded.words, message, `${pin} ${message.join(" ")}`);
      assert.equal(decoded.ambiguous, false);
      roundTrips += 1;
    }
  }
}
checks += roundTrips;
ok(roundTrips > 100, `compiled messages decode to themselves (${roundTrips})`);
eq(compileMessage(["HELP", "HELP", "HELP"], "D5", 48)?.length, 35, "three words fit in 48 blocks");

// ── Positive and negative outcomes ─────────────────────────────────────────────────────────
const intent = ["INJURED", "NORTH"];
const good = run(compileMessage(intent, "D5", 48), benchFor("D5"));
const goodDecoded = decode(lightPulses(good));
eq(compare(intent, goodDecoded, intent).outcome, "delivered", "correct signal, correct reading: delivered");
const misread = compare(intent, goodDecoded, ["INJURED", "SOUTH"]);
eq([misread.outcome, misread.delivered], ["read-differently", false], "a wrong reading of a clear signal is not accepted");
const wrongPattern = run(compileMessage(["INJURED", "SOUTH"], "D5", 48), benchFor("D5"));
const luck = compare(intent, decode(lightPulses(wrongPattern)), intent);
eq([luck.outcome, luck.understood, luck.delivered], ["signal-differs", true, false], "a lucky guess on a signal that says something else is not delivery");
ok(diagnose(wrongPattern, intent, intent).some((finding) => finding.code === "differs"), "and the diagnosis states what the signal says");

// Open circuit: the lamp has no path to GND. The code runs, no light → never delivered.
const open = run(good.program, { "sno-l1": { sockets: [SNAPINO_PADS.D5, 30] } });
eq(lightPulses(open), [], "an open lamp gives no light");
eq(compare(intent, decode(lightPulses(open)), intent).outcome, "no-signal", "and cannot deliver even with the 'right' reading");
ok(diagnose(open, intent, intent).some((finding) => finding.code === "not-grounded"), "diagnosed as not reaching GND");
// Wrong pin: lamp on D5, program on D3.
const wrongPin = run(compileMessage(intent, "D3", 48), benchFor("D5"));
eq(lightPulses(wrongPin), [], "a program on another pin lights nothing");
ok(diagnose(wrongPin, intent, null).some((finding) => finding.code === "wrong-pin" && /D5/.test(finding.message) && /D3/.test(finding.message)), "diagnosed with both pins named");
// Unpowered: no light part at all.
ok(diagnose(run(good.program, {}), intent, null).some((finding) => finding.code === "no-light-part"), "no lamp seated is diagnosed");
// Always on (5V to GND through the lamp): one flash for the whole transmission → ambiguous.
const always = run(good.program, { "sno-l1": { sockets: [SNAPINO_PADS["5V"], 30] }, "sno-w3": { sockets: [30, SNAPINO_PADS.GND] } });
eq(lightPulses(always).length, 1, "a lamp on 5V gives one long light");
eq(compare(intent, decode(lightPulses(always)), intent).outcome, "ambiguous-signal", "which is ambiguous, not a message");
ok(diagnose(always, intent, null).some((finding) => finding.code === "always-on"), "diagnosed as always on");
// Short circuit: 5V straight to GND.
const shorted = run(good.program, { ...benchFor("D5"), "sno-w4a": { sockets: [SNAPINO_PADS["5V"], SNAPINO_PADS.GND] } });
eq(lightPulses(shorted), [], "a 5V–GND short lights nothing");
ok(diagnose(shorted, intent, null).some((finding) => finding.code === "short"), "diagnosed as a short");

// Ambiguous timing: a 500 ms flash, and a 900 ms gap between words.
const pulse = (ms) => [{ op: "write", pin: "D5", value: true }, { op: "wait", ms }, { op: "write", pin: "D5", value: false }];
const between = run([...pulse(900), { op: "wait", ms: 300 }, ...pulse(500)], benchFor("D5"));
const betweenDecoded = decode(lightPulses(between));
eq([betweenDecoded.ambiguous, betweenDecoded.flashes[1].reason], [true, "between"], "a 500 ms flash is between short and long");
ok(diagnose(between, ["INJURED"], null).some((finding) => finding.code === "flash-between" && /500 ms/.test(finding.message)), "the diagnosis gives the measured length");
const vagueGap = run([...pulse(900), { op: "wait", ms: 300 }, ...pulse(900), { op: "wait", ms: 900 }, ...pulse(900), { op: "wait", ms: 300 }, ...pulse(300), { op: "wait", ms: 300 }, ...pulse(300)], benchFor("D5"));
const vagueDecoded = decode(lightPulses(vagueGap));
eq([vagueDecoded.ambiguous, vagueDecoded.groups.length, vagueDecoded.words], [true, 1, [null]], "a 900 ms gap is neither a gap nor a pause: one ambiguous group, no word");
eq(compare(intent, vagueDecoded, intent).outcome, "ambiguous-signal", "an ambiguous signal is never delivery, whatever the reading");
// Stopped early: the light is cut where the transmission stopped.
const cut = run(good.program, benchFor("D5"), 2500);
ok(lightPulses(cut).every((p) => p.end <= 2500), "a stopped transmission's light ends at the stop");
ok(diagnose(cut, intent, null).some((finding) => finding.code === "stopped"), "diagnosed as cut off");
// Light left on at the end of the blocks.
const leftOn = run([{ op: "write", pin: "D5", value: true }, { op: "wait", ms: 300 }], benchFor("D5"));
ok(diagnose(leftOn, ["HELP"], null).some((finding) => finding.code === "on-at-end"), "a light left on by the blocks is reported");
// S1 follow: D5 follows D2, which S1 bridges to 5V while on.
const followBench = (on) => ({ ...benchFor("D5"), "sno-s1": { sockets: [SNAPINO_PADS.D2, SNAPINO_PADS["5V"]], on } });
const follow = [{ op: "follow", pin: "D5", invert: false }, { op: "wait", ms: 300 }, { op: "write", pin: "D5", value: false }];
eq([lightPulses(run(follow, followBench(true))).length, lightPulses(run(follow, followBench(false))).length], [1, 0], "follow reads the switch fixed for the transmission");
eq([wiredPin(benchFor("D6")), wiredPin({})], ["D6", null], "the helper finds the wired pin");

// ── Independent oracle: 1 ms sampling with its own interpreter and stud search ────────────
{
  let seed = 77;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const pads = SNAPINO_PADS;
  /** Lit at time t, computed from scratch: run blocks to t, then flood-fill studs. */
  const litAt = (program, bench, t) => {
    const pins = { D3: false, D5: false, D6: false };
    let clock = 0;
    const adjacency = new Map();
    const link = (a, b) => { (adjacency.get(a) ?? adjacency.set(a, []).get(a)).push(b); (adjacency.get(b) ?? adjacency.set(b, []).get(b)).push(a); };
    for (const id of ["sno-w2a", "sno-w2b", "sno-w3", "sno-w4a", "sno-w4b"]) if (bench[id]) link(...bench[id].sockets);
    const reach = (start) => { const seen = new Set([start]); const stack = [start]; while (stack.length) for (const next of adjacency.get(stack.pop()) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); } return seen; };
    const gndSet = reach(pads.GND);
    if (gndSet.has(pads["5V"])) return false;
    for (const statement of program) {
      if (statement.op === "wait") { if (t < clock + statement.ms) break; clock += statement.ms; continue; }
      pins[statement.pin] = statement.value;
    }
    if (t >= clock && clock === program.reduce((sum, s) => sum + (s.op === "wait" ? s.ms : 0), 0)) return false; // after the end
    const highNets = [reach(pads["5V"]), ...["D3", "D5", "D6"].filter((pin) => pins[pin]).map((pin) => reach(pads[pin]))];
    const isHigh = (stud) => highNets.some((net) => net.has(stud));
    const lamp = bench["sno-l1"]?.sockets;
    if (!lamp) return false;
    const [a, b] = lamp;
    return (isHigh(a) && gndSet.has(b)) || (isHigh(b) && gndSet.has(a));
  };
  let compared = 0;
  for (let trial = 0; trial < 300; trial += 1) {
    const studs = () => Math.floor(random() * 63);
    const bench = { "sno-l1": { sockets: [pick([pads.D3, pads.D5, pads.D6, pads["5V"], studs()]), studs()] } };
    for (const id of ["sno-w2a", "sno-w3", "sno-w4a"]) if (random() < 0.8) bench[id] = { sockets: [pick([pads.GND, studs(), bench["sno-l1"].sockets[1]]), pick([pads.GND, studs(), bench["sno-l1"].sockets[1]])] };
    for (const [id, part] of Object.entries(bench)) if (part.sockets[0] === part.sockets[1]) delete bench[id];
    if (!bench["sno-l1"]) continue;
    const program = [];
    for (let i = 0; i < 10; i += 1) {
      program.push(random() < 0.5 ? { op: "write", pin: pick(["D3", "D5", "D6"]), value: random() < 0.6 } : { op: "wait", ms: 50 * (1 + Math.floor(random() * 20)) });
    }
    const duration = programDurationMs(program);
    if (!duration) continue;
    const pulses = lightPulses({ program, bench, durationMs: duration, stoppedAtMs: null });
    const lit = (t) => pulses.some((p) => t >= p.start && t < p.end);
    for (let t = 0; t < duration; t += 1) {
      if (lit(t) !== litAt(program, bench, t)) assert.fail(`oracle disagrees at trial ${trial}, t=${t}: ${JSON.stringify({ bench, program })}`);
    }
    compared += 1;
  }
  checks += compared;
  ok(compared > 200, `lightPulses matches the 1 ms oracle on ${compared} random programs and layouts`);
}

// ── Reducer: roles, phases, first readings, stale and hostile actions ──────────────────────
{
  const { initialRescueState, reduceRescue, sanitizeRescueAction, sanitizeRescueState, onTransmitterChanged, onParticipantLeft, onRoomEmpty, transmitting } = stateMod;
  const A = { id: "a", name: "Ana" };
  const B = { id: "b", name: "Ben" };
  const C = { id: "c", name: "Cy" };
  const bench = (id) => benchFor("D5")[id] ?? null;
  let state = initialRescueState();
  // As the room does: validate, then reduce.
  const act = (action, actor, now = 0) => {
    const clean = sanitizeRescueAction(action);
    assert.ok(clean, `valid action ${JSON.stringify(action).slice(0, 60)}`);
    const result = reduceRescue(state, clean, actor, now, bench);
    if (result.ok) state = result.state;
    return result;
  };
  eq(act({ type: "claim-role", role: "sender" }, A).reason, "inactive", "nothing happens before the episode is opened");
  act({ type: "open" }, A);
  ok(act({ type: "claim-role", role: "sender" }, A).ok, "A becomes sender");
  eq(act({ type: "claim-role", role: "sender" }, B).reason, "role-taken", "B cannot take the sender role");
  eq(act({ type: "claim-role", role: "receiver" }, A).reason, "one-role", "A cannot hold both roles");
  ok(act({ type: "claim-role", role: "receiver" }, B).ok, "B becomes receiver");
  eq(act({ type: "set-design", mission: "ridge", words: ["INJURED", "NORTH"] }, B).reason, "not-sender", "only the sender designs the message");
  ok(act({ type: "set-design", mission: "ridge", words: ["INJURED", "NORTH"] }, A).ok, "the sender sets the intention");
  const program = compileMessage(["INJURED", "NORTH"], "D5", 48);
  eq(act({ type: "transmit", program }, B).reason, "not-sender", "the receiver cannot transmit");
  const sent = act({ type: "transmit", program }, A, 1000);
  ok(sent.ok && sent.program?.running === false, "the sender transmits; the room program becomes the sent one, stopped");
  eq(state.round.bench["sno-l1"].sockets, [SNAPINO_PADS.D5, 30], "the round snapshots the transmitter");
  ok(transmitting(state, 1000 + 100), "it is running");
  eq(act({ type: "read", round: 1, words: ["INJURED", "NORTH"], confidence: "sure" }, B, 1100).reason, "not-ended", "no reading while it still runs");
  eq(act({ type: "transmit", program }, A, 1200).reason, "transmitting", "no second transmission over a running one");
  eq(act({ type: "swap-roles" }, B, 1200).reason, "transmitting", "no role swap while transmitting");
  const end = 1000 + programDurationMs(program);
  eq(act({ type: "read", round: 1, words: ["INJURED", "NORTH"], confidence: "sure" }, A, end).reason, "not-receiver", "the sender cannot answer for the receiver");
  eq(act({ type: "read", round: 2, words: ["INJURED"], confidence: "sure" }, B, end).reason, "stale-round", "a reading for another round is refused");
  ok(act({ type: "read", round: 1, words: ["INJURED", "?"], confidence: "unsure" }, B, end).ok, "the receiver's first reading is recorded");
  eq(act({ type: "read", round: 1, words: ["INJURED", "NORTH"], confidence: "sure" }, B, end + 1).reason, "already-read", "the first reading never changes");
  eq(act({ type: "transmit", program }, A, end + 2).reason, "round-open", "a read round must be closed before the next transmission");
  eq(act({ type: "set-design", mission: "ridge", words: ["HELP"] }, A, end + 2).reason, "round-open", "the intention is fixed for an open round");
  ok(act({ type: "explain", round: 1, text: "  The second word's gap was too long.  " }, B, end + 3).ok && state.round.explanation === "The second word's gap was too long.", "either role writes the team explanation");
  eq(act({ type: "explain", round: 1, text: "x" }, C, end + 3).reason, "not-in-role", "a bystander cannot");
  ok(act({ type: "close-round", round: 1 }, A, end + 4).ok && state.history.length === 1 && state.round === null, "closing moves the round to history");
  ok(act({ type: "swap-roles" }, A, end + 5).ok && state.roles.sender.id === "b" && state.roles.receiver.id === "a", "roles swap between rounds");
  ok(act({ type: "set-design", mission: "creek", words: ["SAFE", "WATER"] }, B, end + 6).ok, "the new sender designs round 2");
  const second = act({ type: "transmit", program: compileMessage(["SAFE", "WATER"], "D5", 48) }, B, end + 10);
  ok(second.ok && state.round.n === 2, "round 2 starts");
  // The room changes the transmitter mid-transmission: the transmission ends there.
  const changed = onTransmitterChanged(state, end + 1000, "bench-changed");
  ok(changed && changed.round.stopReason === "bench-changed" && changed.round.stoppedAtMs === 990, "a bench change stops it at that moment");
  ok(onTransmitterChanged(changed, end + 1100, "bench-changed") === null, "an ended transmission is not stopped twice");
  state = changed;
  // Retransmission before any reading replaces the round's transmission.
  ok(act({ type: "transmit", program: compileMessage(["SAFE", "WATER"], "D5", 48) }, B, end + 2000).ok && state.round.n === 2 && state.round.transmissions === 2, "a retransmission keeps the round and counts it");
  const stop = act({ type: "stop", round: 2 }, A, end + 2400);
  ok(stop.ok && state.round.stoppedAtMs === 400 && state.round.stopReason === "stopped", "anyone in the room can stop it");
  // Leaving frees roles; an empty room ends transmissions but keeps rounds.
  ok(onParticipantLeft(state, "b").roles.sender === null, "a leaver's role is free");
  state = act({ type: "transmit", program }, B, end + 3000).ok ? state : state;
  const emptied = onRoomEmpty(state, end + 3100);
  ok(emptied.roles.sender === null && emptied.round.stopReason === "room-empty" && emptied.history.length === 1, "an empty room stops the transmission and keeps the history");
  // Hostile input.
  for (const bad of [null, [], "transmit", { type: "transmit", program: "x" }, { type: "read", round: "1", words: ["HELP"], confidence: "sure" }, { type: "read", round: 1, words: ["HELLO"], confidence: "sure" },
    { type: "read", round: 1, words: [], confidence: "sure" }, { type: "read", round: 1, words: ["HELP", "HELP", "HELP", "HELP"], confidence: "sure" }, { type: "set-design", mission: { toString: 0 }, words: ["HELP"] },
    { type: "claim-role", role: { valueOf: 0 } }, { type: "explain", round: 1, text: { toString: 0 } }, { type: "transmit", program: [{ op: "wait", ms: { valueOf: 0 } }] }, { type: "eval" }]) {
    let out;
    assert.doesNotThrow(() => { out = sanitizeRescueAction(bad); }, `hostile ${JSON.stringify(bad)}`);
    eq(out, null, `hostile action ${JSON.stringify(bad)?.slice(0, 60)} rejected`);
  }
  eq(sanitizeRescueState(JSON.parse(JSON.stringify(state))), state, "a valid state survives validation unchanged");
  for (const bad of [{ ...state, v: 2 }, { ...state, intent: ["HELLO"] }, { ...state, round: { ...state.round, durationMs: 1 } }, { ...state, roles: { sender: { id: {}, name: "x" }, receiver: null } }, { toString: 0 }]) {
    eq(sanitizeRescueState(JSON.parse(JSON.stringify(bad))), null, "a tampered state is rejected");
  }
  eq(reduceRescue(state, { type: "transmit", program: [{ op: "wait", ms: 5000 }].concat(Array(30).fill({ op: "wait", ms: 5000 })) }, B, end + 9999, bench).reason, "bad-program", "an over-long transmission is refused");
}

// Review fixes: who may read, design and reset; stale transmissions; older stored states.
{
  const { initialRescueState, reduceRescue, sanitizeRescueAction, sanitizeRescueState } = stateMod;
  const A = { id: "a", name: "Ana" };
  const B = { id: "b", name: "Ben" };
  const C = { id: "c", name: "Cy" };
  const bench = (id) => benchFor("D5")[id] ?? null;
  let state = initialRescueState();
  const act = (action, actor, now = 0) => {
    const clean = sanitizeRescueAction(action);
    assert.ok(clean, `valid action ${JSON.stringify(action).slice(0, 60)}`);
    const result = reduceRescue(state, clean, actor, now, bench);
    if (result.ok) state = result.state;
    return result;
  };
  act({ type: "open" }, A);
  eq(act({ type: "set-design", mission: "ridge", words: ["HELP"] }, B).reason, "not-sender", "with no sender, nobody else designs the message");
  act({ type: "claim-role", role: "sender" }, A);
  act({ type: "claim-role", role: "receiver" }, B);
  act({ type: "set-design", mission: "ridge", words: ["HELP"] }, A);
  const program = compileMessage(["HELP"], "D5", 48);
  const end = 100 + programDurationMs(program);
  eq(act({ type: "transmit", program, round: 1 }, A, 100).reason, "stale-round", "a transmission for a round that is not open is refused");
  ok(act({ type: "transmit", program, round: null }, A, 100).ok && state.round.sentBy.join() === "a", "the round records who transmitted it");
  eq(act({ type: "transmit", program, round: null }, A, end + 1).reason, "stale-round", "'Transmit once' from a stale view does not open another round");
  eq(act({ type: "reset" }, A, end - 10).reason, "transmitting", "no reset over a running transmission");
  eq(act({ type: "swap-roles" }, A, end + 2).reason, "round-open", "no role swap while the round is unread (the sender would read their own message)");
  ok(act({ type: "release-role", role: "receiver" }, B, end + 3).ok && act({ type: "release-role", role: "sender" }, A, end + 3).ok, "both leave their roles");
  eq(act({ type: "claim-role", role: "receiver" }, A, end + 4).reason, "sent-this-round", "whoever transmitted an unread round cannot become its receiver");
  ok(act({ type: "claim-role", role: "sender" }, C, end + 5).ok && act({ type: "transmit", program, round: 1 }, C, end + 6).ok && state.round.sentBy.join() === "a,c", "a new sender's retransmission is recorded too");
  ok(act({ type: "claim-role", role: "receiver" }, B, end + 7).ok, "someone who did not transmit can read it");
  eq(act({ type: "reset" }, A, end * 3).reason, "not-in-role", "a bystander cannot reset while roles are held");
  ok(act({ type: "read", round: 1, words: ["HELP"], confidence: "sure" }, B, end * 3).ok, "the receiver reads");
  ok(act({ type: "claim-role", role: "receiver" }, B, end * 3).ok, "(re-claiming one's own role is a no-op)");
  ok(act({ type: "swap-roles" }, B, end * 3 + 1).ok, "after the reading, roles may swap");
  ok(act({ type: "reset" }, C, end * 3 + 2).ok && state.history.length === 0 && state.round === null, "someone in a role resets");
  // Older stored states without sentBy are accepted (nobody is restricted); hostile sentBy is not.
  act({ type: "set-design", mission: "storm", words: ["HELP"] }, B, end * 4);
  ok(act({ type: "transmit", program, round: null }, B, end * 4).ok, "(the new sender transmits)");
  const legacy = JSON.parse(JSON.stringify(state));
  delete legacy.round.sentBy;
  eq(sanitizeRescueState(legacy)?.round.sentBy, [], "a stored round without sentBy loads with no restriction");
  for (const bad of [{ x: 1 }, [1], Array(9).fill("a"), ["x".repeat(301)]]) {
    eq(sanitizeRescueState({ ...legacy, round: { ...legacy.round, sentBy: bad } }), null, `hostile sentBy ${JSON.stringify(bad).slice(0, 30)} rejected`);
  }
  for (const bad of [{ type: "transmit", program, round: "1" }, { type: "transmit", program, round: 0 }, { type: "transmit", program, round: 1.5 }]) {
    eq(sanitizeRescueAction(bad), null, `hostile transmit round ${JSON.stringify(bad.round)} rejected`);
  }
}

console.log(`rescue signal: ${checks} checks passed`);
