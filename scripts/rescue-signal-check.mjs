// Rescue Signal Workshop — deterministic checks of the signal domain and the episode reducer.
//   node --experimental-strip-types scripts/rescue-signal-check.mjs
// Includes an independent oracle: a 1 ms sampler with its own block interpreter and its own
// stud-graph search, compared with lightPulses() on random programs and random snap layouts.
import assert from "node:assert/strict";

const signal = await import("../src/episodes/rescue-signal.ts");
const stateMod = await import("../src/episodes/rescue-state.ts");
const { SNAPINO_PADS, analyzeSnapino, lightDrivers } = await import("../src/circuit/snapino-circuit.ts");
const { WORDS, WORD_LIST, TIMING, classifyFlash, classifyGap, compileMessage, lightPulses, decode, compare, diagnose, programDurationMs, wiredPin, pinShorts } = signal;

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
    // Every 1-, 2- and 3-word message (6 + 36 + 216 per pin; 648 three-word cases in all).
    for (const message of [[a], ...WORD_LIST.map((b) => [a, b]), ...WORD_LIST.flatMap((b) => WORD_LIST.map((c) => [a, b, c]))]) {
      const program = compileMessage(message, pin, 48);
      if (!program) continue;
      const decoded = decode(lightPulses(run(program, benchFor(pin))));
      assert.deepEqual(decoded.words, message, `${pin} ${message.join(" ")}`);
      assert.equal(decoded.ambiguous, false);
      assert.equal(compare(message, decoded, message).delivered, true, `${pin} ${message.join(" ")} delivers`);
      roundTrips += 1;
    }
  }
}
checks += roundTrips;
eq(roundTrips, 3 * (6 + 36 + 216), `every 1–3-word message compiles within 48 blocks and decodes to itself on every pin (${roundTrips})`);
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
// Review counterexample: a 5V lamp keeps shining after the window ends (pins LOW): the record
// must not invent a falling edge, and the diagnosis must not say the transmitter switched it off.
{
  const fiveVolt = run([{ op: "wait", ms: 300 }], { "sno-l1": { sockets: [14, 32] }, "sno-w3": { sockets: [32, 15] } });
  const pulses = lightPulses(fiveVolt);
  eq(pulses, [{ start: 0, end: 300, sources: ["sno-l1"], continues: true }], "a 5V lamp's light is recorded as continuing past the window end");
  ok(analyzeSnapino(fiveVolt.bench, { D3: false, D5: false, D6: false }).running.has("sno-l1"), "(it really is still lit with every pin LOW)");
  const decoded = decode(pulses);
  eq([decoded.flashes[0].kind, decoded.flashes[0].reason, decoded.ambiguous], ["?", "unended", true], "a light with no end has no measurable length: ambiguous");
  const codes = diagnose(fiveVolt, ["HELP"], null).map((finding) => finding.code);
  ok(codes.includes("always-on") && codes.includes("still-lit") && !codes.includes("on-at-end"), `still lit, never 'switched off' (${codes})`);
  // Cut off while a 5V lamp shines: the same, the stop is not a falling edge of that light.
  ok(lightPulses({ ...always, stoppedAtMs: 1000 }).at(-1).continues === true, "a stopped transmission with a 5V lamp still continues");
  // A D-pin lamp left HIGH by the blocks is really switched off at the end (pins go LOW).
  const dLeft = run([{ op: "write", pin: "D5", value: true }, { op: "wait", ms: 300 }], benchFor("D5"));
  ok(!lightPulses(dLeft).at(-1).continues && diagnose(dLeft, ["HELP"], null).some((finding) => finding.code === "on-at-end"), "a D-pin light left on ends where the pins go LOW, and is reported as such");
}
// Review counterexample: lamp L1 on D6–GND with a snap wire across it (D6 shorted to GND).
{
  const bridged = { "sno-l1": { sockets: [13, 15] }, "sno-w2a": { sockets: [13, 15] } };
  const program = compileMessage(["HELP"], "D6", 48);
  const tx = run(program, bridged);
  const state = analyzeSnapino(bridged, { D3: false, D5: false, D6: true });
  eq([state.pinShort, [...state.running]], ["D6", []], "a bypassed lamp on a shorted pin does not run (same net, and the GND net is never HIGH)");
  eq(lightPulses(tx), [], "no light at all");
  const result = compare(["HELP"], decode(lightPulses(tx)), ["HELP"]);
  eq([result.outcome, result.delivered], ["no-signal", false], "so it can never be delivered");
  const codes = diagnose(tx, ["HELP"], ["HELP"]).map((finding) => finding.code);
  ok(codes.includes("pin-short") && codes.includes("bypassed"), `diagnosed as a pin short and a bypassed lamp (${codes})`);
  eq(pinShorts(tx), ["D6"], "the shorted pin is named");
  eq(lightDrivers(bridged).lights.find((light) => light.id === "sno-l1").pins, [], "and no pin is listed as able to drive it");
}
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
  /**
   * Lit at time t, computed from scratch with a different formulation from the product code:
   * label every stud with a component (BFS over wires and a closed S1), give each component a
   * potential — "0" if it contains the GND pad, else "5" if it contains 5V or a HIGH pin, else
   * floating — and light the lamp only across two DIFFERENT components at "5" and "0". (The
   * earlier oracle treated any net reached from a HIGH pin as HIGH, including GND, and so
   * shared the product's pin-short mistake.)
   */
  const components = (bench) => {
    const adjacency = Array.from({ length: 63 }, () => []);
    const edge = (sockets) => { const [a, b] = sockets; adjacency[a].push(b); adjacency[b].push(a); };
    for (const id of ["sno-w2a", "sno-w2b", "sno-w3", "sno-w4a", "sno-w4b"]) if (bench[id]) edge(bench[id].sockets);
    if (bench["sno-s1"]?.on) edge(bench["sno-s1"].sockets);
    const label = new Array(63).fill(-1);
    let next = 0;
    for (let start = 0; start < 63; start += 1) {
      if (label[start] !== -1) continue;
      const queue = [start];
      label[start] = next;
      while (queue.length) for (const neighbour of adjacency[queue.shift()]) if (label[neighbour] === -1) { label[neighbour] = next; queue.push(neighbour); }
      next += 1;
    }
    return label;
  };
  const lampLit = (bench, pins) => {
    const label = components(bench);
    if (label[pads["5V"]] === label[pads.GND]) return false;
    const potential = (component) => {
      if (label[pads.GND] === component) return "0";
      if (label[pads["5V"]] === component || ["D3", "D5", "D6"].some((pin) => pins[pin] && label[pads[pin]] === component)) return "5";
      return "z";
    };
    const lamp = bench["sno-l1"]?.sockets;
    if (!lamp) return false;
    const [a, b] = lamp.map((stud) => label[stud]);
    return a !== b && [potential(a), potential(b)].sort().join("") === "05";
  };
  const litAt = (program, bench, t) => {
    const pins = { D3: false, D5: false, D6: false };
    let clock = 0;
    for (const statement of program) {
      if (statement.op === "wait") { if (t < clock + statement.ms) break; clock += statement.ms; continue; }
      pins[statement.pin] = statement.value;
    }
    if (t >= clock && clock === program.reduce((sum, s) => sum + (s.op === "wait" ? s.ms : 0), 0)) return false; // after the end
    return lampLit(bench, pins);
  };
  // Hand-made topologies with their expected light, independent of both implementations.
  const D = { D3: false, D5: false, D6: false };
  const topologies = [
    ["D5 lamp to GND via wires, D5 HIGH", { "sno-l1": { sockets: [pads.D5, 30] }, "sno-w3": { sockets: [30, pads.GND] } }, { ...D, D5: true }, true],
    ["same, D5 LOW", { "sno-l1": { sockets: [pads.D5, 30] }, "sno-w3": { sockets: [30, pads.GND] } }, D, false],
    ["lamp across D6–GND with a wire across it (pin short)", { "sno-l1": { sockets: [pads.D6, pads.GND] }, "sno-w2a": { sockets: [pads.D6, pads.GND] } }, { ...D, D6: true }, false],
    ["lamp bridged by a wire on a D5 loop", { "sno-l1": { sockets: [pads.D5, 30] }, "sno-w3": { sockets: [30, pads.GND] }, "sno-w2a": { sockets: [pads.D5, 30] } }, { ...D, D5: true }, false],
    ["both lamp ends on GND", { "sno-l1": { sockets: [pads.GND, 30] }, "sno-w3": { sockets: [30, pads.GND] } }, { ...D, D5: true }, false],
    ["5V lamp to GND (always on)", { "sno-l1": { sockets: [pads["5V"], 30] }, "sno-w3": { sockets: [30, pads.GND] } }, D, true],
    ["5V to a LOW pin (LOW is not a sink here)", { "sno-l1": { sockets: [pads["5V"], pads.D5] } }, D, false],
    ["two HIGH pins, no GND", { "sno-l1": { sockets: [pads.D5, pads.D6] } }, { ...D, D5: true, D6: true }, false],
    ["D5 lamp lit while D6 is shorted to GND elsewhere", { "sno-l1": { sockets: [pads.D5, 30] }, "sno-w3": { sockets: [30, pads.GND] }, "sno-w4a": { sockets: [pads.D6, pads.GND] } }, { ...D, D5: true, D6: true }, true],
    ["5V–GND short kills everything", { "sno-l1": { sockets: [pads.D5, 30] }, "sno-w3": { sockets: [30, pads.GND] }, "sno-w4a": { sockets: [pads["5V"], pads.GND] } }, { ...D, D5: true }, false],
    ["D5 pad joined to 5V (always HIGH)", { "sno-l1": { sockets: [pads.D5, 30] }, "sno-w3": { sockets: [30, pads.GND] }, "sno-w4a": { sockets: [pads.D5, pads["5V"]] } }, D, true],
    ["S1 on bridges the lamp", { "sno-l1": { sockets: [pads.D5, 30] }, "sno-w3": { sockets: [30, pads.GND] }, "sno-s1": { sockets: [pads.D5, 30], on: true } }, { ...D, D5: true }, false],
    ["S1 off leaves it working", { "sno-l1": { sockets: [pads.D5, 30] }, "sno-w3": { sockets: [30, pads.GND] }, "sno-s1": { sockets: [pads.D5, 30], on: false } }, { ...D, D5: true }, true],
  ];
  for (const [label, bench, pins, expected] of topologies) {
    eq(lampLit(bench, pins), expected, `oracle: ${label}`);
    eq(analyzeSnapino(bench, pins).running.has("sno-l1"), expected, `product: ${label}`);
  }
  let compared = 0;
  for (let trial = 0; trial < 300; trial += 1) {
    const studs = () => Math.floor(random() * 63);
    const bench = { "sno-l1": { sockets: [pick([pads.D3, pads.D5, pads.D6, pads["5V"], pads.GND, studs()]), pick([pads.GND, studs(), studs()])] } };
    const [l0, l1] = bench["sno-l1"].sockets;
    // Wires among GND, the pads, the lamp's own studs and random studs: this produces bridged
    // (same-net) lamps, pins shorted to GND, 5V-powered lamps and 5V–GND shorts.
    const endpoint = () => pick([pads.GND, pads.GND, pads["5V"], pads.D3, pads.D5, pads.D6, l0, l1, studs()]);
    for (const id of ["sno-w2a", "sno-w3", "sno-w4a", "sno-w4b"]) if (random() < 0.7) bench[id] = { sockets: [endpoint(), endpoint()] };
    if (random() < 0.3) bench["sno-s1"] = { sockets: [endpoint(), endpoint()], on: random() < 0.5 };
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
  // The two descriptions of a light (analyzeSnapino per pin state, lightDrivers per layout) and
  // the oracle agree on random layouts: always-on ⇔ lit with every pin LOW; pin P listed ⇔ lit
  // with only P HIGH.
  let layouts = 0;
  for (let trial = 0; trial < 3000; trial += 1) {
    const studs = () => Math.floor(random() * 63);
    const endpoint = () => pick([pads.GND, pads["5V"], pads.D3, pads.D5, pads.D6, studs(), studs()]);
    const bench = { "sno-l1": { sockets: [endpoint(), endpoint()] } };
    for (const id of ["sno-w2a", "sno-w3", "sno-w4a"]) if (random() < 0.6) bench[id] = { sockets: [endpoint(), endpoint()] };
    for (const [id, part] of Object.entries(bench)) if (part.sockets[0] === part.sockets[1]) delete bench[id];
    if (!bench["sno-l1"]) continue;
    const driver = lightDrivers(bench).lights.find((light) => light.id === "sno-l1");
    const nets = analyzeSnapino(bench, D);
    if (nets.short) { ok(!driver.always && !driver.pins.length, "a 5V–GND short drives nothing"); continue; }
    eq(driver.always, lampLit(bench, D), `always-on agrees with the oracle ${JSON.stringify(bench)}`);
    for (const pin of ["D3", "D5", "D6"]) {
      const only = { ...D, [pin]: true };
      if (driver.always) continue;
      eq(driver.pins.includes(pin), lampLit(bench, only), `${pin} listed ⇔ lit with only ${pin} HIGH ${JSON.stringify(bench)}`);
      eq(analyzeSnapino(bench, only).running.has("sno-l1"), lampLit(bench, only), `analyzeSnapino agrees with the oracle ${JSON.stringify(bench)} ${pin}`);
    }
    layouts += 1;
  }
  ok(layouts > 2000, `drivers, circuit and oracle agree on ${layouts} random layouts`);
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
  eq(act({ type: "transmit", program, tx: null }, B).reason, "not-sender", "the receiver cannot transmit");
  const sent = act({ type: "transmit", program, tx: null }, A, 1000);
  ok(sent.ok && sent.program?.running === false, "the sender transmits; the room program becomes the sent one, stopped");
  eq(state.round.bench["sno-l1"].sockets, [SNAPINO_PADS.D5, 30], "the round snapshots the transmitter");
  ok(transmitting(state, 1000 + 100), "it is running");
  eq(act({ type: "read", tx: state.round.tx, words: ["INJURED", "NORTH"], confidence: "sure" }, B, 1100).reason, "not-ended", "no reading while it still runs");
  eq(act({ type: "transmit", program, tx: state.round.tx }, A, 1200).reason, "transmitting", "no second transmission over a running one");
  eq(act({ type: "swap-roles" }, B, 1200).reason, "transmitting", "no role swap while transmitting");
  const end = 1000 + programDurationMs(program);
  eq(act({ type: "read", tx: state.round.tx, words: ["INJURED", "NORTH"], confidence: "sure" }, A, end).reason, "not-receiver", "the sender cannot answer for the receiver");
  eq(act({ type: "read", tx: state.round.tx + 1000, words: ["INJURED"], confidence: "sure" }, B, end).reason, "stale-round", "a reading for another transmission is refused");
  ok(act({ type: "read", tx: state.round.tx, words: ["INJURED", "?"], confidence: "unsure" }, B, end).ok, "the receiver's first reading is recorded");
  eq(act({ type: "read", tx: state.round.tx, words: ["INJURED", "NORTH"], confidence: "sure" }, B, end + 1).reason, "already-read", "the first reading never changes");
  eq(act({ type: "transmit", program, tx: state.round.tx }, A, end + 2).reason, "round-open", "a read round must be closed before the next transmission");
  eq(act({ type: "set-design", mission: "ridge", words: ["HELP"] }, A, end + 2).reason, "round-open", "the intention is fixed for an open round");
  ok(act({ type: "explain", tx: state.round.tx, text: "  The second word's gap was too long.  " }, B, end + 3).ok && state.round.explanation === "The second word's gap was too long.", "either role writes the team explanation");
  eq(act({ type: "explain", tx: state.round.tx, text: "x" }, C, end + 3).reason, "not-in-role", "a bystander cannot");
  ok(act({ type: "close-round", tx: state.round.tx }, A, end + 4).ok && state.history.length === 1 && state.round === null, "closing moves the round to history");
  ok(act({ type: "swap-roles" }, A, end + 5).ok && state.roles.sender.id === "b" && state.roles.receiver.id === "a", "roles swap between rounds");
  ok(act({ type: "set-design", mission: "creek", words: ["SAFE", "WATER"] }, B, end + 6).ok, "the new sender designs round 2");
  const second = act({ type: "transmit", program: compileMessage(["SAFE", "WATER"], "D5", 48), tx: null }, B, end + 10);
  ok(second.ok && state.round.n === 2, "round 2 starts");
  // The room changes the transmitter mid-transmission: the transmission ends there.
  const changed = onTransmitterChanged(state, end + 1000, "bench-changed");
  ok(changed && changed.round.stopReason === "bench-changed" && changed.round.stoppedAtMs === 990, "a bench change stops it at that moment");
  ok(onTransmitterChanged(changed, end + 1100, "bench-changed") === null, "an ended transmission is not stopped twice");
  state = changed;
  // Retransmission before any reading replaces the round's transmission.
  const firstTx = state.round.tx;
  ok(act({ type: "transmit", program: compileMessage(["SAFE", "WATER"], "D5", 48), tx: firstTx }, B, end + 2000).ok && state.round.n === 2 && state.round.transmissions === 2, "a retransmission keeps the round number and counts it");
  ok(state.round.tx > firstTx, "but it is a new transmission (new tx)");
  eq(act({ type: "stop", tx: firstTx }, A, end + 2300).reason, "stale-round", "a Stop aimed at the replaced transmission is refused");
  const stop = act({ type: "stop", tx: state.round.tx }, A, end + 2400);
  ok(stop.ok && state.round.stoppedAtMs === 400 && state.round.stopReason === "stopped", "anyone in the room can stop it");
  // Leaving frees roles; an empty room ends transmissions but keeps rounds.
  ok(onParticipantLeft(state, "b").roles.sender === null, "a leaver's role is free");
  state = act({ type: "transmit", program, tx: state.round?.tx ?? null }, B, end + 3000).ok ? state : state;
  const emptied = onRoomEmpty(state, end + 3100);
  ok(emptied.roles.sender === null && emptied.round.stopReason === "room-empty" && emptied.history.length === 1, "an empty room stops the transmission and keeps the history");
  // Hostile input.
  for (const bad of [null, [], "transmit", { type: "transmit", program: "x", tx: null }, { type: "transmit", program }, { type: "read", tx: "1", words: ["HELP"], confidence: "sure" }, { type: "read", tx: 1, words: ["HELLO"], confidence: "sure" },
    { type: "read", round: 1, words: ["HELP"], confidence: "sure" }, { type: "stop", round: 1 },
    { type: "read", tx: 1, words: [], confidence: "sure" }, { type: "read", tx: 1, words: ["HELP", "HELP", "HELP", "HELP"], confidence: "sure" }, { type: "set-design", mission: { toString: 0 }, words: ["HELP"] },
    { type: "claim-role", role: { valueOf: 0 } }, { type: "explain", tx: 1, text: { toString: 0 } }, { type: "transmit", program: [{ op: "wait", ms: { valueOf: 0 } }], tx: null }, { type: "eval" }]) {
    let out;
    assert.doesNotThrow(() => { out = sanitizeRescueAction(bad); }, `hostile ${JSON.stringify(bad)}`);
    eq(out, null, `hostile action ${JSON.stringify(bad)?.slice(0, 60)} rejected`);
  }
  eq(sanitizeRescueState(JSON.parse(JSON.stringify(state))), state, "a valid state survives validation unchanged");
  for (const bad of [{ ...state, v: 1 }, { ...state, v: 3 }, { ...state, round: { ...state.round, tx: 0 } }, { ...state, intent: ["HELLO"] }, { ...state, round: { ...state.round, durationMs: 1 } }, { ...state, roles: { sender: { id: {}, name: "x" }, receiver: null } }, { toString: 0 }]) {
    eq(sanitizeRescueState(JSON.parse(JSON.stringify(bad))), null, "a tampered state is rejected");
  }
  eq(reduceRescue(state, { type: "transmit", program: [{ op: "wait", ms: 5000 }].concat(Array(30).fill({ op: "wait", ms: 5000 })), tx: state.round?.tx ?? null }, B, end + 9999, bench).reason, "bad-program", "an over-long transmission is refused");
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
  eq(act({ type: "transmit", program, tx: 99 }, A, 100).reason, "stale-round", "a transmission for a round that is not open is refused");
  ok(act({ type: "transmit", program, tx: null }, A, 100).ok && state.round.sentBy.join() === "a", "the round records who transmitted it");
  eq(act({ type: "transmit", program, tx: null }, A, end + 1).reason, "stale-round", "'Transmit once' from a stale view does not open another round");
  eq(act({ type: "reset" }, A, end - 10).reason, "transmitting", "no reset over a running transmission");
  eq(act({ type: "swap-roles" }, A, end + 2).reason, "round-open", "no role swap while the round is unread (the sender would read their own message)");
  ok(act({ type: "release-role", role: "receiver" }, B, end + 3).ok && act({ type: "release-role", role: "sender" }, A, end + 3).ok, "both leave their roles");
  eq(act({ type: "claim-role", role: "receiver" }, A, end + 4).reason, "sent-this-round", "whoever transmitted an unread round cannot become its receiver");
  ok(act({ type: "claim-role", role: "sender" }, C, end + 5).ok && act({ type: "transmit", program, tx: state.round.tx }, C, end + 6).ok && state.round.sentBy.join() === "a,c", "a new sender's retransmission is recorded too");
  ok(act({ type: "claim-role", role: "receiver" }, B, end + 7).ok, "someone who did not transmit can read it");
  eq(act({ type: "reset" }, A, end * 3).reason, "not-in-role", "a bystander cannot reset while roles are held");
  ok(act({ type: "read", tx: state.round.tx, words: ["HELP"], confidence: "sure" }, B, end * 3).ok, "the receiver reads");
  ok(act({ type: "claim-role", role: "receiver" }, B, end * 3).ok, "(re-claiming one's own role is a no-op)");
  ok(act({ type: "swap-roles" }, B, end * 3 + 1).ok, "after the reading, roles may swap");
  ok(act({ type: "reset" }, C, end * 3 + 2).ok && state.history.length === 0 && state.round === null, "someone in a role resets");
  // Older stored states without sentBy are accepted (nobody is restricted); hostile sentBy is not.
  act({ type: "set-design", mission: "storm", words: ["HELP"] }, B, end * 4);
  ok(act({ type: "transmit", program, tx: null }, B, end * 4).ok, "(the new sender transmits)");
  const legacy = JSON.parse(JSON.stringify(state));
  delete legacy.round.sentBy;
  eq(sanitizeRescueState(legacy)?.round.sentBy, [], "a stored round without sentBy loads with no restriction");
  for (const bad of [{ x: 1 }, [1], Array(9).fill("a"), ["x".repeat(301)]]) {
    eq(sanitizeRescueState({ ...legacy, round: { ...legacy.round, sentBy: bad } }), null, `hostile sentBy ${JSON.stringify(bad).slice(0, 30)} rejected`);
  }
  for (const bad of [{ type: "transmit", program, tx: "1" }, { type: "transmit", program, tx: 0 }, { type: "transmit", program, tx: 1.5 }]) {
    eq(sanitizeRescueAction(bad), null, `hostile transmit tx ${JSON.stringify(bad.tx)} rejected`);
  }
}

// Parent review counterexamples: reset convergence and transmission identity.
{
  const { initialRescueState, reduceRescue, sanitizeRescueAction, sanitizeRescueState, supersedes } = stateMod;
  const A = { id: "a", name: "Ana" };
  const B = { id: "b", name: "Ben" };
  const bench = (id) => benchFor("D5")[id] ?? null;
  let state = initialRescueState();
  const act = (action, actor, now) => {
    const clean = sanitizeRescueAction(action);
    assert.ok(clean, `valid action ${JSON.stringify(action).slice(0, 60)}`);
    const result = reduceRescue(state, clean, actor, now, bench);
    if (result.ok) state = result.state;
    return result;
  };
  const P = compileMessage(["HELP"], "D5", 48);
  const Q = [{ op: "wait", ms: 500 }];
  const endP = programDurationMs(P);
  act({ type: "open" }, A, 0);
  act({ type: "claim-role", role: "sender" }, A, 0);
  act({ type: "claim-role", role: "receiver" }, B, 0);
  act({ type: "set-design", mission: "storm", words: ["HELP"] }, A, 0);
  // Retransmission: the receiver's reading made for P must not be recorded against Q.
  act({ type: "transmit", program: P, tx: null }, A, 10_000);
  const txP = state.round.tx;
  const delayedRead = { type: "read", tx: txP, words: ["HELP"], confidence: "sure" }; // made after P ended, arrives late
  act({ type: "transmit", program: Q, tx: txP }, A, 10_000 + endP + 100);
  const txQ = state.round.tx;
  ok(txQ !== txP && state.round.n === 1 && state.round.transmissions === 2, "a retransmission keeps round 1 but has a new tx");
  eq(act(delayedRead, B, 10_000 + endP + 2000).reason, "stale-round", "a delayed reading of the first transmission is refused after the second one ended");
  ok(act({ type: "read", tx: txQ, words: ["?"], confidence: "unsure" }, B, 10_000 + endP + 2000).ok, "a reading of the current transmission is accepted");
  act({ type: "explain", tx: txQ, text: "Nothing came through the second time." }, B, 20_000);
  const archivedTx = state.round.tx;
  act({ type: "close-round", tx: archivedTx }, A, 20_001);
  // Reset at a high revision: the revision continues, so every connected client applies it.
  for (let i = 0; i < 4; i += 1) act({ type: "set-design", mission: "storm", words: ["HELP"] }, A, 20_002);
  const before = state.rev;
  ok(before >= 12, `(the room is at revision ${before})`);
  ok(act({ type: "reset" }, A, 21_000).ok, "the sender resets");
  ok(state.rev === before + 1 && state.history.length === 0 && state.round === null, "reset clears rounds and CONTINUES the revision");
  ok(supersedes({ ...state, rev: before }, state), "a client holding the pre-reset state applies the reset");
  ok(!supersedes(state, { ...state, rev: before }), "a late duplicate of the pre-reset state is still dropped");
  // After the reset, round numbers restart at 1 but transmission ids do not.
  act({ type: "set-design", mission: "storm", words: ["HELP"] }, A, 21_100);
  act({ type: "transmit", program: P, tx: null }, A, 30_000);
  ok(state.round.n === 1 && state.round.tx > archivedTx && state.round.tx > txQ, "the new round 1 has a new, larger tx");
  for (const stale of [{ type: "read", tx: txQ, words: ["HELP"], confidence: "sure" }, { type: "explain", tx: archivedTx, text: "old" }, { type: "close-round", tx: archivedTx }, { type: "stop", tx: txP }]) {
    eq(act(stale, stale.type === "read" ? B : A, 30_000 + (stale.type === "stop" ? 10 : endP + 10)).reason, "stale-round", `a pre-reset ${stale.type} for round 1 is refused against the new round 1`);
  }
  // A stored v1 state (round numbers as identity) is not loaded: the room starts a fresh v2 state.
  const v1 = JSON.parse(JSON.stringify(state));
  v1.v = 1;
  delete v1.round.tx;
  eq(sanitizeRescueState(v1), null, "a v1 stored state is refused (fresh state instead)");
  eq(sanitizeRescueState(JSON.parse(JSON.stringify(state))), state, "the v2 state round-trips through storage");
}

// Parent review: the header/stepper describe the current round, never an earlier success.
{
  const { currentPhase, deliveredRound } = await import("../src/episodes/rescue-panel.ts");
  const { initialRescueState, reduceRescue, sanitizeRescueAction, transmitting } = stateMod;
  const A = { id: "a", name: "Ana" };
  const B = { id: "b", name: "Ben" };
  let benchNow = benchFor("D5");
  let state = initialRescueState();
  let now = 0;
  const act = (action, actor, at = now) => {
    const result = reduceRescue(state, sanitizeRescueAction(action), actor, at, (id) => benchNow[id] ?? null);
    assert.ok(result.ok, `${action.type}: ${result.reason}`);
    state = result.state;
  };
  const phase = () => currentPhase(state, transmitting(state, now));
  act({ type: "open" }, A);
  eq(phase().label, "Choose roles", "no sender yet");
  act({ type: "claim-role", role: "sender" }, A);
  act({ type: "claim-role", role: "receiver" }, B);
  act({ type: "set-design", mission: "ridge", words: ["SAFE"] }, A);
  const safe = compileMessage(["SAFE"], "D5", 48);
  // Round 1: delivered and explained → the workshop goal is met.
  act({ type: "transmit", program: safe, tx: null }, A, (now = 1000));
  eq(phase().label, "Transmitting", "running");
  now += programDurationMs(safe);
  eq([phase().step, phase().label], [3, "Reading"], "ended, unread");
  act({ type: "read", tx: state.round.tx, words: ["SAFE"], confidence: "sure" }, B);
  act({ type: "explain", tx: state.round.tx, text: "Long then short." }, B);
  eq([phase().label, phase().tone], ["Delivered", "valid"], "the delivered round is shown as delivered");
  act({ type: "close-round", tx: state.round.tx }, A);
  ok(deliveredRound(state)?.n === 1, "(milestone: round 1)");
  eq(phase().label, "Round 2 · design", "after closing: the next round's design, not 'Delivered'");
  const notDelivered = (label) => { const p = phase(); ok(p.label !== "Delivered" && p.tone !== "valid", `${label}: the header does not claim delivery (${p.label})`); };
  // Round 2 running.
  act({ type: "transmit", program: safe, tx: null }, A, (now += 10));
  notDelivered("next round running");
  // Unread after it ends.
  now += programDurationMs(safe);
  notDelivered("next round unread");
  eq(phase().label, "Reading", "it is the reading step");
  // Ambiguous (a 500 ms flash).
  act({ type: "transmit", program: [{ op: "write", pin: "D5", value: true }, { op: "wait", ms: 500 }, { op: "write", pin: "D5", value: false }], tx: state.round.tx }, A, (now += 10));
  now += 600;
  act({ type: "read", tx: state.round.tx, words: ["SAFE"], confidence: "sure" }, B);
  eq([phase().label, phase().tone], ["Not delivered", "warning"], "an ambiguous round, read 'right', is not delivered");
  act({ type: "close-round", tx: state.round.tx }, A);
  // Open circuit.
  benchNow = { "sno-l1": benchFor("D5")["sno-l1"] };
  act({ type: "transmit", program: safe, tx: null }, A, (now += 10));
  now += programDurationMs(safe);
  act({ type: "read", tx: state.round.tx, words: ["SAFE"], confidence: "sure" }, B);
  eq(phase().label, "Not delivered", "an open-circuit round is not delivered");
  act({ type: "close-round", tx: state.round.tx }, A);
  // Cut off.
  benchNow = benchFor("D5");
  act({ type: "transmit", program: safe, tx: null }, A, (now += 10));
  state = stateMod.onTransmitterChanged(state, now + 100, "bench-changed");
  now += 200;
  notDelivered("a cut-off round");
  ok(deliveredRound(state)?.n === 1, "the earlier milestone is still recorded (shown in the history)");
}

// Parent review: PF and DI both see the protocol's timing rules; only DI gets solution guidance.
{
  globalThis.document ??= { addEventListener() {}, removeEventListener() {}, hidden: false, querySelector: () => null };
  globalThis.cancelAnimationFrame ??= () => {};
  globalThis.requestAnimationFrame ??= () => 0;
  const { RescueEpisode } = await import("../src/episodes/rescue-panel.ts");
  const { initialRescueState } = stateMod;
  const panelFor = (condition) => new RescueEpisode({
    room: () => null, workbench: () => null, inSnapino: () => true, condition: () => condition, editorProgram: () => [],
    loadEditor() {}, openCodeEditor() {}, setTransmitting() {}, setPins() {}, humans: () => 2, status() {}, trace() {}, confirm: async () => true, layoutChanged() {},
  });
  const state = { ...initialRescueState(), active: true, intent: ["HELP"] };
  for (const condition of ["PF", "DI"]) {
    const panel = panelFor(condition);
    const protocol = panel.protocolHtml(state, false);
    ok(protocol.includes(`${TIMING.shortMin}–${TIMING.shortMax} ms`) && protocol.includes(`${TIMING.longMin}–${TIMING.longMax} ms`) && protocol.includes(`${TIMING.pauseMin} ms or more`), `${condition}: the timing bands are published before any round`);
    ok(!/Decide with your team how long/.test(protocol), `${condition}: no invitation to invent timings the decoder would not accept`);
    eq(/Worked example/.test(protocol), condition === "DI", `${condition}: worked example ${condition === "DI" ? "shown" : "hidden"}`);
    eq(/data-episode="write-blocks"/.test(panel.designHtml(state)), condition === "DI", `${condition}: block-writing helper ${condition === "DI" ? "shown" : "hidden"}`);
    panel.dispose();
  }
}

console.log(`rescue signal: ${checks} checks passed`);
