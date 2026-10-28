// Sound Flow Studio (Episode 2) domain checks:
//  1. the patch graph (src/sound/sound-model.ts) against an INDEPENDENT oracle written here
//     (adjacency matrix + Warshall closure, not the product's Tarjan/propagation), on every
//     possible patch of the three cables (43^3 = 79,507 states, two-plug jacks included) and on
//     curated cases with stated expectations;
//  2. the signal model against analytic references (sine through the Butterworth magnitude,
//     clipped-sine fraction 1 − (2/π)·asin(1/a), a densely sampled band-limited sawtooth);
//  3. the brief's five criteria on curated builds, and the cutoff range in which it can be met;
//  4. the room's rules (cloudflare/sound-rules.js via sanitize.js and RoomCore): ids, fixture
//     poses, value bounds, jack range, one plug per jack, for live moves and atomic edits.
//   node --experimental-strip-types scripts/sound-model-check.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context);
    throw error;
  }
}`)}`);

const model = await import("../src/sound/sound-model.ts");
const rules = await import("../cloudflare/sound-rules.js");
const { sanitizeTransform, sanitizeEdit, COMPONENT_IDS } = await import("../cloudflare/sanitize.js");
const { RoomCore } = await import("../cloudflare/room-core.js");

let checks = 0;
const ok = (value, label, detail = "") => {
  checks += 1;
  assert.ok(value, `${label}${detail ? ` — ${detail}` : ""}`);
};
const eq = (actual, expected, label) => {
  checks += 1;
  assert.deepEqual(actual, expected, label);
};

// ── The spec, restated independently ─────────────────────────────────────────────
const MODULES = ["snd-source", "snd-filter", "snd-drive", "snd-speaker"];
const CABLES = ["snd-cable-a", "snd-cable-b", "snd-cable-c"];
const JACKS = [["snd-source", "out"], ["snd-filter", "in"], ["snd-filter", "out"], ["snd-drive", "in"], ["snd-drive", "out"], ["snd-speaker", "in"]];
eq(rules.SOUND_JACKS.map((jack) => [jack.module, jack.port]), JACKS, "jack table matches the spec");
eq(rules.SOUND_MODULE_IDS, MODULES, "module ids");
eq(rules.SOUND_CABLE_IDS, CABLES, "cable ids");

function oracle(cables, speakerOn = true) {
  const plugs = new Map();
  for (const cable of CABLES) for (const jack of cables[cable]) if (jack !== null) plugs.set(jack, (plugs.get(jack) ?? 0) + 1);
  const shared = new Set([...plugs].filter(([, n]) => n > 1).map(([jack]) => jack));
  const m = (jack) => MODULES.indexOf(JACKS[jack][0]);
  const A = MODULES.map(() => MODULES.map(() => false));
  const valid = []; // { cable, from, to } (jack indices)
  const statuses = {};
  const faults = new Set();
  for (const cable of CABLES) {
    const [a, b] = cables[cable];
    if (a === null && b === null) continue;
    if (a === null || b === null) { faults.add(`loose-end:${cable}:${a ?? b}`); continue; }
    if (shared.has(a) || shared.has(b)) { statuses[cable] = "shared-jack"; continue; }
    const pa = JACKS[a][1], pb = JACKS[b][1];
    if (pa === "out" && pb === "out") { statuses[cable] = "out-out"; faults.add(`out-out:${cable}`); continue; }
    if (pa === "in" && pb === "in") { statuses[cable] = "in-in"; faults.add(`in-in:${cable}`); continue; }
    const from = pa === "out" ? a : b, to = pa === "out" ? b : a;
    valid.push({ cable, from, to });
    A[m(from)][m(to)] = true;
  }
  const R = A.map((row) => [...row]);
  for (let k = 0; k < 4; k += 1) for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) if (R[i][k] && R[k][j]) R[i][j] = true;
  const cyclic = MODULES.map((_, i) => R[i][i]);
  const inLoopEdge = (edge) => R[m(edge.to)][m(edge.from)] || m(edge.to) === m(edge.from);
  // Loops: groups of mutually reachable cyclic modules.
  const loops = [];
  const seen = new Set();
  for (let i = 0; i < 4; i += 1) {
    if (!cyclic[i] || seen.has(i)) continue;
    const group = [];
    for (let j = 0; j < 4; j += 1) if (j === i || (R[i][j] && R[j][i])) { group.push(MODULES[j]); seen.add(j); }
    loops.push(group);
  }
  for (const loop of loops) faults.add(`loop:${loop.join(",")}`);
  // Live: reachable from the Source through valid, non-loop edges and non-cyclic modules.
  const live = MODULES.map(() => false);
  live[0] = !cyclic[0];
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of valid) {
      if (inLoopEdge(edge)) continue;
      if (live[m(edge.from)] && !cyclic[m(edge.to)] && !live[m(edge.to)]) { live[m(edge.to)] = true; grew = true; }
    }
  }
  for (const edge of valid) statuses[edge.cable] = inLoopEdge(edge) ? "loop" : live[m(edge.from)] ? "signal" : "idle";
  for (const jack of shared) faults.add(`shared-jack:${jack}`);
  JACKS.forEach(([module, port], jack) => {
    if (port !== "in") return;
    const i = MODULES.indexOf(module);
    if (!plugs.has(jack)) faults.add(`unpatched-input:${module}`);
    else if (valid.some((edge) => edge.to === jack && !inLoopEdge(edge)) && !live[i] && !cyclic[i]) faults.add(`no-signal-in:${module}`);
  });
  JACKS.forEach(([module, port], jack) => {
    if (port !== "out" || !live[MODULES.indexOf(module)]) return;
    if (!plugs.has(jack)) faults.add(`open-output:${module}`);
  });
  if (!speakerOn) faults.add("speaker-off:snd-speaker");
  // Chain: from the Source, follow its OUT's signal cable.
  const chain = [];
  if (live[0]) {
    let current = 0;
    while (current !== null && !chain.includes(MODULES[current])) {
      chain.push(MODULES[current]);
      const out = JACKS.findIndex(([module, port]) => module === MODULES[current] && port === "out");
      const edge = valid.find((candidate) => candidate.from === out && statuses[candidate.cable] === "signal");
      current = edge ? m(edge.to) : null;
    }
  }
  const ordered = Object.fromEntries(CABLES.filter((cable) => statuses[cable]).map((cable) => [cable, statuses[cable]]));
  return { live: Object.fromEntries(MODULES.map((id, i) => [id, live[i]])), statuses: ordered, faults: [...faults].sort(), chain, reachesSpeaker: live[3], loops: loops.map((loop) => loop.join(",")).sort() };
}

function productView(state) {
  const graph = model.derivePatchGraph(state);
  const faults = graph.faults.map((fault) => {
    if (fault.code === "loose-end") return `loose-end:${fault.cable}:${fault.jack}`;
    if (fault.code === "out-out" || fault.code === "in-in") return `${fault.code}:${fault.cable}`;
    if (fault.code === "loop") return `loop:${fault.modules.join(",")}`;
    if (fault.code === "shared-jack") return `shared-jack:${fault.jack}`;
    return `${fault.code}:${fault.module}`;
  }).sort();
  return {
    live: graph.live,
    statuses: Object.fromEntries(graph.edges.map((edge) => [edge.cable, edge.status])),
    faults,
    chain: graph.chain,
    reachesSpeaker: graph.reachesSpeaker,
    loops: graph.loops.map((loop) => loop.join(",")).sort(),
  };
}

const stateWith = (cables, extra = {}) => ({ ...model.defaultSoundState(), cables: { "snd-cable-a": [null, null], "snd-cable-b": [null, null], "snd-cable-c": [null, null], ...cables }, ...extra });

// ── 1a. Curated patches with stated expectations (oracle and product) ────────────
const CURATED = [
  { name: "canonical path", cables: { "snd-cable-a": [0, 1], "snd-cable-b": [2, 3], "snd-cable-c": [4, 5] }, chain: ["snd-source", "snd-filter", "snd-drive", "snd-speaker"], speaker: true, faults: [] },
  { name: "ends reversed (B→A) still OUT→IN", cables: { "snd-cable-a": [1, 0], "snd-cable-b": [3, 2], "snd-cable-c": [5, 4] }, chain: ["snd-source", "snd-filter", "snd-drive", "snd-speaker"], speaker: true, faults: [] },
  { name: "drive before filter", cables: { "snd-cable-a": [0, 3], "snd-cable-b": [4, 1], "snd-cable-c": [2, 5] }, chain: ["snd-source", "snd-drive", "snd-filter", "snd-speaker"], speaker: true, faults: [] },
  { name: "bypass straight to the speaker", cables: { "snd-cable-a": [0, 5] }, chain: ["snd-source", "snd-speaker"], speaker: true, faults: ["unpatched-input:snd-drive", "unpatched-input:snd-filter"] },
  { name: "OUT→OUT", cables: { "snd-cable-a": [0, 2] }, chain: ["snd-source"], speaker: false, faults: ["out-out:snd-cable-a", "unpatched-input:snd-drive", "unpatched-input:snd-filter", "unpatched-input:snd-speaker"] },
  { name: "IN→IN", cables: { "snd-cable-a": [1, 5] }, chain: ["snd-source"], speaker: false, faults: ["in-in:snd-cable-a", "open-output:snd-source", "unpatched-input:snd-drive"] },
  { name: "loose end", cables: { "snd-cable-a": [0, null] }, chain: ["snd-source"], speaker: false, faults: ["loose-end:snd-cable-a:0", "unpatched-input:snd-drive", "unpatched-input:snd-filter", "unpatched-input:snd-speaker"] },
  { name: "filter ↔ drive loop", cables: { "snd-cable-a": [2, 3], "snd-cable-b": [4, 1], "snd-cable-c": [0, 5] }, chain: ["snd-source", "snd-speaker"], speaker: true, faults: ["loop:snd-filter,snd-drive"] },
  { name: "filter patched to itself", cables: { "snd-cable-a": [2, 1], "snd-cable-b": [0, 3], "snd-cable-c": [4, 5] }, chain: ["snd-source", "snd-drive", "snd-speaker"], speaker: true, faults: ["loop:snd-filter"] },
  { name: "open at the drive", cables: { "snd-cable-a": [0, 1], "snd-cable-b": [2, 3] }, chain: ["snd-source", "snd-filter", "snd-drive"], speaker: false, faults: ["open-output:snd-drive", "unpatched-input:snd-speaker"] },
  { name: "speaker fed from a silent filter", cables: { "snd-cable-a": [2, 5] }, chain: ["snd-source"], speaker: false, faults: ["no-signal-in:snd-speaker", "open-output:snd-source", "unpatched-input:snd-drive", "unpatched-input:snd-filter"] },
  { name: "two plugs in Filter IN (peer race)", cables: { "snd-cable-a": [0, 1], "snd-cable-b": [4, 1], "snd-cable-c": [2, 5] }, chain: ["snd-source"], speaker: false, faults: ["no-signal-in:snd-speaker", "shared-jack:1", "unpatched-input:snd-drive"] },
  { name: "nothing patched", cables: {}, chain: ["snd-source"], speaker: false, faults: ["open-output:snd-source", "unpatched-input:snd-drive", "unpatched-input:snd-filter", "unpatched-input:snd-speaker"] },
];
for (const testCase of CURATED) {
  const state = stateWith(testCase.cables);
  const product = productView(state);
  const reference = oracle(state.cables);
  eq(product.chain, testCase.chain, `${testCase.name}: chain`);
  eq(product.reachesSpeaker, testCase.speaker, `${testCase.name}: reaches speaker`);
  eq(product.faults, [...testCase.faults].sort(), `${testCase.name}: faults`);
  eq(reference.chain, testCase.chain, `${testCase.name}: oracle chain`);
  eq(reference.faults, [...testCase.faults].sort(), `${testCase.name}: oracle faults`);
}
{
  const off = productView(stateWith({ "snd-cable-a": [0, 1], "snd-cable-b": [2, 3], "snd-cable-c": [4, 5] }, { speakerOn: false }));
  ok(off.reachesSpeaker && off.faults.join() === "speaker-off:snd-speaker", "speaker switched off: the patch still reaches it; the only fault is the switch (not a broken patch)", off.faults.join());
}

// ── 1b. Every possible patch (exhaustive), product vs oracle ─────────────────────
const ENDS = [[null, null]];
for (let a = 0; a < 6; a += 1) {
  ENDS.push([a, null], [null, a]);
  for (let b = 0; b < 6; b += 1) if (a !== b) ENDS.push([a, b]);
}
ok(ENDS.length === 43, "43 placements per cable");
let exhaustive = 0;
for (const a of ENDS) for (const b of ENDS) for (const c of ENDS) {
  const state = stateWith({ "snd-cable-a": a, "snd-cable-b": b, "snd-cable-c": c }, { speakerOn: (exhaustive & 1) === 0 });
  const product = productView(state);
  const reference = oracle(state.cables, state.speakerOn);
  checks += 1;
  if (JSON.stringify(product) !== JSON.stringify({ live: reference.live, statuses: reference.statuses, faults: reference.faults, chain: reference.chain, reachesSpeaker: reference.reachesSpeaker, loops: reference.loops })) {
    assert.fail(`exhaustive mismatch for ${JSON.stringify(state.cables)}:\nproduct ${JSON.stringify(product)}\noracle  ${JSON.stringify(reference)}`);
  }
  exhaustive += 1;
}
ok(exhaustive === 79_507, "every patch compared", String(exhaustive));

// ── 1c. The diagram and the connection list are drawn from the patch as built ───────────────
const diagram = await import("../src/sound/sound-diagram.ts");
let drawn = 0;
for (const a of ENDS) for (const b of ENDS) for (const c of ENDS) {
  if ((drawn += 1) % 25 !== 0) continue;
  const state = stateWith({ "snd-cable-a": a, "snd-cable-b": b, "snd-cable-c": c });
  const graph = model.derivePatchGraph(state);
  const signal = model.analyzeSignal(state, graph);
  const reference = oracle(state.cables);
  const svg = diagram.renderSoundDiagramSvg(graph, signal, { selected: null, showNotes: true });
  const edges = [...svg.matchAll(/class="sd-edge[^"]*" data-cable="([^"]+)" data-status="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  const expected = CABLES.flatMap((cable) => {
    const [x, y] = state.cables[cable];
    if (x === null && y === null) return [];
    if (x === null || y === null) return [[cable, "loose"]];
    return [[cable, reference.statuses[cable]]];
  });
  const sort = (list) => [...list].sort((p, q) => p[0].localeCompare(q[0]));
  checks += 1;
  if (JSON.stringify(sort(edges)) !== JSON.stringify(sort(expected))) assert.fail(`diagram edges for ${JSON.stringify(state.cables)}: ${JSON.stringify(edges)} vs oracle ${JSON.stringify(expected)}`);
  const list = diagram.renderConnectionList(graph, signal);
  checks += 1;
  if (!CABLES.every((cable) => list.includes(`data-cable="${cable}"`))) assert.fail("connection list misses a cable");
  const nodes = [...svg.matchAll(/data-module="([^"]+)" data-state="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  const expectedNodes = MODULES.map((id) => `${id}:${reference.loops.some((loop) => loop.split(",").includes(id)) ? "loop" : reference.live[id] ? "signal" : "silent"}`);
  checks += 1;
  if (JSON.stringify(nodes) !== JSON.stringify(expectedNodes)) assert.fail(`diagram nodes for ${JSON.stringify(state.cables)}: ${nodes} vs ${expectedNodes}`);
}
ok(drawn === 79_507, "diagram compared with the oracle on every 25th patch (3,180 patches)");

// ── 2. Signal model vs analytic references ────────────────────────────────────────
const H = (f, fc) => 1 / Math.sqrt((1 - (f / fc) ** 2) ** 2 + 2 * (f / fc) ** 2);
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const chainState = (cables, source, cutoff, gain, speakerOn = true) => stateWith(cables, { source, filter: { cutoff }, drive: { gain }, speakerOn });
const FILTER_ONLY = { "snd-cable-a": [0, 1], "snd-cable-c": [2, 5] };
const DRIVE_ONLY = { "snd-cable-a": [0, 3], "snd-cable-c": [4, 5] };
const FULL = { "snd-cable-a": [0, 1], "snd-cable-b": [2, 3], "snd-cable-c": [4, 5] };
for (const [hz, cutoff] of [[220, 300], [440, 440], [1000, 250], [110, 4000], [1760, 80]]) {
  const signal = model.analyzeSignal(chainState(FILTER_ONLY, { hz, wave: "sine" }, cutoff, 1));
  const expected = 0.5 * H(hz, cutoff);
  ok(near(signal.speakerIn.peak, expected, 1e-6 + expected * 1e-6), `sine ${hz} Hz through a ${cutoff} Hz Butterworth: peak = 0.5·|H|`, `${signal.speakerIn.peak} vs ${expected}`);
  ok(near(signal.speakerIn.harmonics[0], expected, 1e-9 + expected * 1e-9), `… and its fundamental amplitude`, `${signal.speakerIn.harmonics[0]}`);
}
ok(near(model.butterworthDb(300, 300), -10 * Math.log10(2), 1e-12), "−3.01 dB at the cutoff");
for (const gain of [0, 0.5, 1, 2, 2.5, 3, 4]) {
  const signal = model.analyzeSignal(chainState(DRIVE_ONLY, { hz: 440, wave: "sine" }, 1000, gain));
  const a = 0.5 * gain;
  const fraction = a > 1 ? 1 - (2 / Math.PI) * Math.asin(1 / a) : 0;
  const drive = signal.stages.find((stage) => stage.module === "snd-drive");
  ok(near(drive.clipped, fraction, 2 / 1024), `sine × ${gain}: clipped fraction ${fraction.toFixed(4)}`, `${drive.clipped}`);
  ok(near(drive.peak, Math.min(a, 1), a > 1 ? 0.02 : 1e-9), `sine × ${gain}: output peak min(a, 1)`, `${drive.peak}`);
  // Clipped sine's fundamental, by dense independent integration.
  const N = 200_000;
  let b1 = 0;
  for (let i = 0; i < N; i += 1) {
    const t = (2 * Math.PI * i) / N;
    b1 += Math.max(-1, Math.min(1, a * Math.sin(t))) * Math.sin(t);
  }
  b1 *= 2 / N;
  ok(near(drive.harmonics[0], Math.abs(b1), 1e-4), `sine × ${gain}: fundamental of the clipped wave`, `${drive.harmonics[0]} vs ${b1}`);
  ok(signal.clipping === (a > 1), `sine × ${gain}: clipping flag`);
}
// Band-limited sawtooth. Web Audio divides the coefficients by the full-band Gibbs peak
// (2/π)·Si(π), measured in Chromium by sound-dsp-check.mjs; Si(π) is integrated here.
let si = 0;
for (let i = 0, N = 1_000_000; i < N; i += 1) {
  const t = (Math.PI * (i + 0.5)) / N;
  si += (Math.sin(t) / t) * (Math.PI / N);
}
const gibbs = (2 / Math.PI) * si;
ok(near(gibbs, model.GIBBS_PEAK, 1e-9), "Gibbs peak (2/π)·Si(π)", String(gibbs));
for (const [hz, cutoff] of [[220, 300], [220, 2000], [55, 120], [880, 1500]]) {
  const top = Math.floor((24_000 - 1e-9) / hz);
  const b = (n) => (2 / (Math.PI * n)) * (n % 2 ? 1 : -1);
  const peak = gibbs;
  const signal = model.analyzeSignal(chainState(FILTER_ONLY, { hz, wave: "sawtooth" }, cutoff, 1));
  for (let n = 1; n <= 8; n += 1) {
    const expected = n <= top ? (0.5 * Math.abs(b(n)) / peak) * H(n * hz, cutoff) : 0;
    ok(near(signal.speakerIn.harmonics[n - 1], expected, 2e-4 * 0.5 + expected * 3e-3), `sawtooth ${hz} Hz, cutoff ${cutoff}: harmonic ${n}`, `${signal.speakerIn.harmonics[n - 1]} vs ${expected}`);
  }
}
// Square wave: only odd harmonics; the Speaker's output cap and switch.
{
  const signal = model.analyzeSignal(chainState({ "snd-cable-a": [0, 5] }, { hz: 440, wave: "square" }, 1000, 1));
  ok(signal.speakerIn.harmonics[1] < 1e-9 && signal.speakerIn.harmonics[3] < 1e-9 && signal.speakerIn.harmonics[2] > 0.05, "square: even harmonics absent");
  ok(near(signal.speakerOutPeak, 0.5 * 0.25, 0.125 * 2e-3), "Speaker sends min(1, peak) × 0.25 (true peak of the band-limited square)", String(signal.speakerOutPeak));
  const clipped = model.analyzeSignal(chainState(DRIVE_ONLY, { hz: 440, wave: "square" }, 1000, 4));
  ok(clipped.speakerOutPeak <= 0.25 + 1e-12, "Speaker output never above 0.25 FS", String(clipped.speakerOutPeak));
  const off = model.analyzeSignal(chainState({ "snd-cable-a": [0, 5] }, { hz: 440, wave: "sine" }, 1000, 1, false));
  ok(off.speakerIn.peak > 0.49 && off.speakerOutPeak === 0, "Speaker off: input present, output zero");
  const open = model.analyzeSignal(chainState({ "snd-cable-a": [0, 1] }, { hz: 440, wave: "sine" }, 1000, 1));
  ok(open.speakerIn === null && open.speakerOutPeak === 0, "open patch: nothing at the Speaker");
  const loop = model.analyzeSignal(chainState({ "snd-cable-a": [2, 3], "snd-cable-b": [4, 1] }, { hz: 440, wave: "sine" }, 1000, 4));
  ok(loop.speakerIn === null && !loop.stages.some((stage) => stage.module !== "snd-source"), "loop: silenced, nothing invented");
}

// ── 3. The brief ──────────────────────────────────────────────────────────────────
const brief = (cables, source, cutoff, gain, speakerOn = true) => model.evaluateBrief(chainState(cables, source, cutoff, gain, speakerOn));
const SAW = { hz: 220, wave: "sawtooth" };
const verdict = (outcome) => outcome.criteria.map((criterion) => (criterion.pass ? "1" : "0")).join("");
const BRIEF_CASES = [
  { name: "worked example (300 Hz, ×1.70)", args: [FULL, SAW, 300, 1.7], expect: "11111" },
  { name: "300 Hz at ×1.00", args: [FULL, SAW, 300, 1], expect: "11111" },
  { name: "no filtering (2 kHz)", args: [FULL, SAW, 2000, 1], expect: "11011" },
  { name: "Drive ×4 (clipped, and the clipped peak is 0 dBFS)", args: [FULL, SAW, 300, 4], expect: "11100" },
  { name: "80 Hz at ×4 (too quiet)", args: [FULL, SAW, 80, 4], expect: "11110" },
  { name: "drive first, ×3 at 300 Hz (clipped, and too loud)", args: [{ "snd-cable-a": [0, 3], "snd-cable-b": [4, 1], "snd-cable-c": [2, 5] }, SAW, 300, 3], expect: "11100" },
  { name: "drive first, ×3 at 200 Hz (dark and in level, but clipped before the filter)", args: [{ "snd-cable-a": [0, 3], "snd-cable-b": [4, 1], "snd-cable-c": [2, 5] }, SAW, 200, 3], expect: "11101" },
  { name: "drive first, ×1.2", args: [{ "snd-cable-a": [0, 3], "snd-cable-b": [4, 1], "snd-cable-c": [2, 5] }, SAW, 300, 1.2], expect: "11111" },
  { name: "speaker switched off", args: [FULL, SAW, 300, 1.7, false], expect: "01111" },
  { name: "square wave at ×1.2", args: [FULL, { hz: 220, wave: "square" }, 300, 1.2], expect: "10111" },
  { name: "wrong pitch (440 Hz, cutoff 600 Hz)", args: [FULL, { hz: 440, wave: "sawtooth" }, 600, 1.7], expect: "10111" },
  { name: "bypass to the speaker (raw sawtooth at −6 dBFS: level ok, bright)", args: [{ "snd-cable-a": [0, 5] }, SAW, 300, 1.7], expect: "01001" },
  { name: "filter↔drive loop (silenced; Source straight to the Speaker)", args: [{ "snd-cable-a": [2, 3], "snd-cable-b": [4, 1], "snd-cable-c": [0, 5] }, SAW, 300, 1.7], expect: "01001" },
  { name: "open at the drive", args: [{ "snd-cable-a": [0, 1], "snd-cable-b": [2, 3] }, SAW, 300, 1.7], expect: "01010" },
];
for (const testCase of BRIEF_CASES) {
  const outcome = brief(...testCase.args);
  eq(verdict(outcome), testCase.expect, `brief: ${testCase.name} (${outcome.criteria.map((c) => c.measured).join(" | ")})`);
  ok(outcome.met === (testCase.expect === "11111"), `brief: ${testCase.name} met flag`);
}
{
  const example = model.workedExample();
  ok(example.cutoff === 300 && example.gain > 1 && example.gain < 2.5 && near(example.peakDb, -6, 0.3) && example.belowDb >= 18, "the DI worked example meets the brief by the model's own numbers", JSON.stringify(example));
}
// The cutoff range in which some Drive gain (0.01 steps) meets the brief (documented).
const metCutoffs = [];
for (let cutoff = 80; cutoff <= 1000; cutoff += 5) {
  let met = false;
  for (let gain = 0.5; gain <= 4 && !met; gain += 0.05) met = brief(FULL, SAW, cutoff, Math.round(gain * 100) / 100).met;
  if (met) metCutoffs.push(cutoff);
}
ok(metCutoffs.length > 20 && metCutoffs.every((value, index) => index === 0 || value - metCutoffs[index - 1] === 5), "the brief is met on one contiguous cutoff range", `${metCutoffs[0]}–${metCutoffs.at(-1)} Hz`);
console.log(`brief met for cutoffs ${metCutoffs[0]}–${metCutoffs.at(-1)} Hz (5 Hz grid, gain grid 0.05)`);

// ── 4. The room's rules ─────────────────────────────────────────────────────────
for (const id of rules.SOUND_IDS) ok(COMPONENT_IDS.has(id), `${id} is a room part`);
const pose = (id) => ({ position: [...rules.SOUND_MODULE_POSES[id]], rotation: [0, 0, 0], sockets: null });
eq(rules.sanitizeSoundProps("source", { hz: 220.4, wave: "sawtooth", extra: 1 }), { hz: 220, wave: "sawtooth" }, "source props rounded, unknown keys dropped");
for (const [kind, raw, label] of [
  ["source", { hz: 54, wave: "sine" }, "hz below range"], ["source", { hz: 1761, wave: "sine" }, "hz above range"], ["source", { hz: 440, wave: "triangle" }, "unknown wave"],
  ["source", { hz: "440", wave: "sine" }, "string hz"], ["source", { wave: "sine" }, "missing hz"], ["filter", { cutoff: 79 }, "cutoff below"], ["filter", { cutoff: 8001 }, "cutoff above"],
  ["filter", { cutoff: Number.NaN }, "NaN cutoff"], ["drive", { gain: -0.01 }, "negative gain"], ["drive", { gain: 4.01 }, "gain above ×4"], ["drive", { gain: true }, "boolean gain"], ["drive", null, "null props"], ["speaker", { gain: 1 }, "speaker has no knobs"],
]) ok(rules.sanitizeSoundProps(kind, raw) === null, `props refused: ${label}`);
eq(rules.sanitizeSoundProps("drive", { gain: 1.234 }), { gain: 1.23 }, "gain to 0.01");
eq(sanitizeTransform({ ...pose("snd-filter"), props: { cutoff: 300 } }, "snd-filter"), { ...pose("snd-filter"), props: { cutoff: 300 } }, "filter edit accepted");
ok(sanitizeTransform({ ...pose("snd-filter"), props: { cutoff: 9000 } }, "snd-filter") === null, "out-of-range cutoff refuses the whole transform (never clamped or dropped)");
ok(sanitizeTransform({ ...pose("snd-filter"), position: [0, 0, 0], props: { cutoff: 300 } }, "snd-filter") === null, "a moved module is refused");
ok(sanitizeTransform({ ...pose("snd-filter"), rotation: [0, 0.5, 0] }, "snd-filter") === null, "a rotated module is refused");
ok(sanitizeTransform({ ...pose("snd-filter"), sockets: [1, 2] }, "snd-filter") === null, "a module with sockets is refused");
ok(sanitizeTransform({ ...pose("snd-filter"), on: true }, "snd-filter") === null, "only the Speaker has a switch");
eq(sanitizeTransform({ ...pose("snd-speaker"), on: false }, "snd-speaker"), { ...pose("snd-speaker"), on: false }, "speaker switch accepted");
ok(sanitizeTransform({ ...pose("snd-speaker"), props: { gain: 1 } }, "snd-speaker") === null, "speaker props refused");
const cable = (sockets) => ({ position: [-1, 0.48, 1], rotation: [0, 0, 0], sockets, endpoints: [[-0.3, 0.1, 0], [0.3, 0.1, 0]] });
ok(sanitizeTransform(cable([0, 5]), "snd-cable-a") !== null, "cable OUT→IN accepted");
ok(sanitizeTransform(cable([0, 2]), "snd-cable-a") !== null, "cable OUT→OUT accepted (a learner's wrong patch is drawn, not refused)");
ok(sanitizeTransform(cable([0, 6]), "snd-cable-a") === null, "jack 6 does not exist");
ok(sanitizeTransform(cable([3, 3]), "snd-cable-a") === null, "both ends in one jack refused");
ok(sanitizeTransform({ ...cable([0, 1]), props: { gain: 1 } }, "snd-cable-a") === null, "cable props refused");
ok(sanitizeTransform({ ...cable([0, 1]), on: true }, "snd-cable-a") === null, "cable switch refused");
ok(sanitizeEdit({ opId: "op-1", changes: [{ componentId: "snd-drive", expectRev: 0, transform: { ...pose("snd-drive"), props: { gain: 9 } } }] }) === null, "an edit with an out-of-range gain is refused whole");
ok(sanitizeEdit({ opId: "op-2", changes: [{ componentId: "snd-drive", expectRev: 0, transform: { ...pose("snd-drive"), props: { gain: 2 } } }] }) !== null, "an in-range edit passes");

// Edit history and WorkbenchTools.submit compare transforms with sameTransform: a knob value change
// must count as a change (an e2e run found Sound edits treated as "nothing to change").
{
  const { sameTransform } = await import("../src/desktop/edit-history.ts");
  const at = (props) => ({ ...pose("snd-source"), props });
  ok(!sameTransform(at({ hz: 440, wave: "sine" }), at({ hz: 220, wave: "sine" })), "sameTransform: hz differs");
  ok(!sameTransform(at({ hz: 440, wave: "sine" }), at({ hz: 440, wave: "sawtooth" })), "sameTransform: wave differs");
  ok(!sameTransform({ ...pose("snd-filter"), props: { cutoff: 2000 } }, { ...pose("snd-filter"), props: { cutoff: 300 } }), "sameTransform: cutoff differs");
  ok(!sameTransform({ ...pose("snd-drive"), props: { gain: 1 } }, { ...pose("snd-drive"), props: { gain: 1.7 } }), "sameTransform: gain differs");
  ok(sameTransform(at({ hz: 440, wave: "sine" }), at({ wave: "sine", hz: 440 })), "sameTransform: same knobs in another key order are the same");
  ok(!sameTransform({ ...pose("snd-speaker"), on: true }, { ...pose("snd-speaker"), on: false }), "sameTransform: speaker switch differs");
}

// RoomCore: one plug per jack, for live moves and edits (batch-aware), as the room applies them.
{
  const core = new RoomCore();
  const alice = { id: "alice", name: "Alice" };
  const bob = { id: "bob", name: "Bob" };
  const edit = (who, opId, changes) => core.handle(who, { kind: "edit", opId, changes });
  let out = edit(alice, "e1", [{ componentId: "snd-cable-a", expectRev: 0, transform: cable([0, 1]) }]);
  ok(out.sender[0].ok === true, "Alice patches Source OUT → Filter IN");
  out = edit(bob, "e2", [{ componentId: "snd-cable-b", expectRev: 0, transform: cable([1, 2]) }]);
  ok(out.sender[0].ok === false && out.sender[0].reason === "occupied" && out.others.length === 0, "Bob's edit into the occupied Filter IN is refused (occupied) and relayed to nobody", JSON.stringify(out.sender[0]));
  out = edit(bob, "e3", [
    { componentId: "snd-cable-a", expectRev: 1, transform: cable([0, 3]) },
    { componentId: "snd-cable-b", expectRev: 0, transform: cable([2, 1]) },
  ]);
  ok(out.sender[0].ok === true, "one edit that moves A out of Filter IN and B into it is accepted (judged on the batch's result)", JSON.stringify(out.sender[0]));
  // Live move: claim an end, drop it into an occupied jack.
  core.handle(bob, { kind: "claim", componentId: "snd-cable-c::endpoint-0" });
  out = core.handle(bob, { kind: "transform", componentId: "snd-cable-c", sequence: 1, transform: { ...cable([3, null]), activeEndpoint: 0 } });
  ok(out.sender[0].kind === "transform-rejected" && out.sender[0].reason === "occupied" && out.others.length === 0, "a live drop into Drive IN (held by cable A) is rejected with the room's state", JSON.stringify(out.sender[0]));
  out = core.handle(bob, { kind: "transform", componentId: "snd-cable-c", sequence: 2, transform: { ...cable([4, null]), activeEndpoint: 0 } });
  ok(out.sender[0].kind === "rev-ack", "a live drop into the free Drive OUT is accepted");
  core.handle(bob, { kind: "claim", componentId: "snd-cable-c::endpoint-1" });
  out = core.handle(bob, { kind: "transform", componentId: "snd-cable-c", sequence: 3, transform: { ...cable([null, 5]), activeEndpoint: 1 } });
  ok(out.sender[0].kind === "rev-ack" && JSON.stringify(core.state.get("snd-cable-c").transform.sockets) === "[4,5]", "the other end's move keeps end A (room merge), sockets [4,5]", JSON.stringify(core.state.get("snd-cable-c").transform.sockets));
  out = edit(alice, "e4", [{ componentId: "snd-drive", expectRev: 0, transform: { ...pose("snd-drive"), props: { gain: 2 } } }]);
  ok(out.sender[0].ok === true && out.others[0].changes[0].transform.props.gain === 2, "a knob edit is relayed with its value");
  out = edit(bob, "e5", [{ componentId: "snd-drive", expectRev: 0, transform: { ...pose("snd-drive"), props: { gain: 3 } } }]);
  ok(out.sender[0].ok === false && out.sender[0].reason === "stale", "a knob edit based on an old revision is stale");
}

// Review findings (independent reviewers, PR #5 head 5e1a595), through the REAL sanitizer and RoomCore,
// exactly as the Worker and the local relay deliver messages.
{
  // What the Worker/relay hands RoomCore for a client's raw message (sanitize first; null = dropped).
  const deliver = (core, who, raw) => {
    if (raw.kind === "transform") {
      const transform = sanitizeTransform(raw.transform, raw.componentId);
      if (!transform) return { dropped: true, sender: [], others: [] };
      return core.handle(who, { kind: "transform", participantId: who.id, componentId: raw.componentId, transform, sequence: raw.sequence });
    }
    if (raw.kind === "edit") {
      const edit = sanitizeEdit(raw);
      if (!edit) return { dropped: true, sender: [], others: [] };
      return core.handle(who, { kind: "edit", participantId: who.id, ...edit });
    }
    return core.handle(who, raw);
  };
  const ends = [[-0.3, 0.1, 0], [0.3, 0.1, 0]];
  const endMove = (componentId, sockets, end, sequence, extra = {}) => ({ kind: "transform", componentId, sequence, transform: { position: [-1, 0.48, 1], rotation: [0, 0, 0], sockets, endpoints: ends, activeEndpoint: end, ...extra } });
  const socketsIn = (core, id) => JSON.stringify(core.join()[0].transforms[id]?.transform.sockets ?? null);
  const seeded = () => {
    const core = new RoomCore();
    const alice = { id: "alice", name: "Alice" };
    const bob = { id: "bob", name: "Bob" };
    // A real cable state with endpoints and nothing plugged (an accepted edit).
    const seed = deliver(core, alice, { kind: "edit", opId: "seed", changes: [{ componentId: "snd-cable-a", expectRev: 0, transform: { position: [-1, 0.48, 1], rotation: [0, 0, 0], sockets: [null, null], endpoints: ends } }] });
    ok(seed.sender[0]?.ok === true, "review B1: the cable is seeded with endpoints and no plugs");
    deliver(core, alice, { kind: "claim", componentId: "snd-cable-a::endpoint-0" });
    deliver(core, bob, { kind: "claim", componentId: "snd-cable-a::endpoint-1" });
    return { core, alice, bob };
  };

  // BLOCKER 1: opposite holders, each moving their end into the SAME jack before seeing the other's move.
  for (const first of ["alice", "bob"]) {
    const { core, alice, bob } = seeded();
    const moves = { alice: [alice, endMove("snd-cable-a", [1, null], 0, 1)], bob: [bob, endMove("snd-cable-a", [null, 1], 1, 1)] };
    const second = first === "alice" ? "bob" : "alice";
    const a = deliver(core, ...moves[first]);
    ok(a.sender[0]?.kind === "rev-ack", `review B1 (${first} first): the first end into Filter IN is accepted`, JSON.stringify(a.sender[0]));
    const b = deliver(core, ...moves[second]);
    ok(b.sender[0]?.kind === "transform-rejected" && b.sender[0].reason === "occupied" && b.others.length === 0 && !b.persist.state,
      `review B1 (${first} first): the other holder's delayed move of the other end into the same jack is refused (occupied), relayed to nobody, persisted nowhere`, JSON.stringify(b.sender[0]));
    const expected = first === "alice" ? "[1,null]" : "[null,1]";
    ok(socketsIn(core, "snd-cable-a") === expected, `review B1 (${first} first): the room keeps one plug in the jack`, socketsIn(core, "snd-cable-a"));
    ok(JSON.stringify(b.sender[0].transform?.sockets ?? null) === expected, `review B1 (${first} first): the refusal carries the room's state back to the sender`, JSON.stringify(b.sender[0].transform));
    // A late joiner gets the valid state; then the refused holder places their end elsewhere.
    const later = deliver(core, moves[second][0], endMove("snd-cable-a", first === "alice" ? [1, 2] : [2, 1], second === "alice" ? 0 : 1, 2));
    ok(later.sender[0]?.kind === "rev-ack", `review B1 (${first} first): the refused holder's next move to a free jack is accepted`, JSON.stringify(later.sender[0]));
    const after = JSON.parse(socketsIn(core, "snd-cable-a"));
    ok(after.length === 2 && after[0] !== after[1] && after.includes(1) && after.includes(2), `review B1 (${first} first): the later state is valid ([1,2] or [2,1])`, JSON.stringify(after));
  }

  // Finding (b): a crafted end move that omits `endpoints` must not replace the other holder's end.
  {
    const { core, alice, bob } = seeded();
    deliver(core, alice, endMove("snd-cable-a", [1, null], 0, 1));
    deliver(core, bob, endMove("snd-cable-a", [null, 2], 1, 1));
    ok(socketsIn(core, "snd-cable-a") === "[1,2]", "review (b): Alice holds end 0 in jack 1, Bob holds end 1 in jack 2", socketsIn(core, "snd-cable-a"));
    const crafted = { kind: "transform", componentId: "snd-cable-a", sequence: 2, transform: { position: [-1, 0.48, 1], rotation: [0, 0, 0], sockets: [3, 4], activeEndpoint: 0 } };
    const dropped = deliver(core, alice, crafted);
    ok(dropped.dropped === true && socketsIn(core, "snd-cable-a") === "[1,2]", "review (b): an end move without endpoints is refused by the sanitizer; Bob's end is untouched", socketsIn(core, "snd-cable-a"));
    // With endpoints, the room still applies only the claimed end, whatever the payload says about the other.
    const merged = deliver(core, alice, endMove("snd-cable-a", [3, 4], 0, 3));
    ok(merged.sender[0]?.kind === "rev-ack" && socketsIn(core, "snd-cable-a") === "[3,2]", "review (b): an end-0 move carrying a different end-1 socket changes only end 0 ([3,2])", socketsIn(core, "snd-cable-a"));
    // And RoomCore on its own (no sanitizer in front) merges the authorized end unconditionally.
    const raw = core.handle(alice, { kind: "transform", participantId: "alice", componentId: "snd-cable-a", sequence: 4, transform: { position: [-1, 0.48, 1], rotation: [0, 0, 0], sockets: [0, 5], activeEndpoint: 0 } });
    ok(raw.sender[0]?.kind === "rev-ack" && socketsIn(core, "snd-cable-a") === "[0,2]", "review (b): RoomCore alone keeps the other holder's end for a payload without endpoints ([0,2])", socketsIn(core, "snd-cable-a"));
    // Bob's end is still his: a move of end 1 by Alice (not her claim) is refused.
    const notHers = deliver(core, alice, endMove("snd-cable-a", [0, 4], 1, 5));
    ok(notHers.sender[0]?.kind === "transform-rejected" && socketsIn(core, "snd-cable-a") === "[0,2]", "review (b): Alice cannot move Bob's end", JSON.stringify(notHers.sender[0]));
  }

  // Independent review of ad7fd3c: a cable the room has NEVER stored (fresh room, or after everyone
  // left) — an end move must still change only its end (clients start every cable on the mat).
  for (const after of ["fresh", "reset"]) {
    const core = new RoomCore();
    const alice = { id: "alice", name: "Alice" };
    const bob = { id: "bob", name: "Bob" };
    const carol = { id: "carol", name: "Carol" };
    if (after === "reset") {
      deliver(core, alice, { kind: "edit", opId: "s", changes: [{ componentId: "snd-cable-a", expectRev: 0, transform: { position: [-1, 0.48, 1], rotation: [0, 0, 0], sockets: [2, 3], endpoints: ends } }] });
      core.reset();
    }
    deliver(core, alice, { kind: "claim", componentId: "snd-cable-a::endpoint-0" });
    deliver(core, bob, { kind: "claim", componentId: "snd-cable-a::endpoint-1" });
    const moved = deliver(core, alice, endMove("snd-cable-a", [1, 5], 0, 1));
    ok(moved.sender[0]?.kind === "rev-ack" && socketsIn(core, "snd-cable-a") === "[1,null]", `review (never stored, ${after}): an end-0 move claiming the other end is in jack 5 stores only end 0 ([1,null]), as clients apply it`, socketsIn(core, "snd-cable-a"));
    deliver(core, carol, { kind: "claim", componentId: "snd-cable-b" });
    const carolMove = deliver(core, carol, { kind: "transform", componentId: "snd-cable-b", sequence: 1, transform: { position: [0, 0.48, 0], rotation: [0, 0, 0], sockets: [5, 2], endpoints: ends } });
    ok(carolMove.sender[0]?.kind === "rev-ack", `review (never stored, ${after}): jack 5, empty on every client, is empty in the room too`, JSON.stringify(carolMove.sender[0]));
    const same = deliver(core, bob, endMove("snd-cable-a", [null, 1], 1, 1));
    ok(same.sender[0]?.kind === "transform-rejected" && same.sender[0].reason === "occupied" && socketsIn(core, "snd-cable-a") === "[1,null]", `review (never stored, ${after}): Bob's end into Alice's jack is still refused`, JSON.stringify(same.sender[0]));
  }

  // Batch atomicity: an edit that would leave one cable with both plugs in one jack is refused whole.
  {
    const core = new RoomCore();
    const alice = { id: "alice", name: "Alice" };
    const direct = core.handle(alice, { kind: "edit", opId: "x", changes: [
      { componentId: "snd-cable-c", expectRev: 0, transform: cable([4, 5]) },
      { componentId: "snd-cable-b", expectRev: 0, transform: cable([3, 3]) },
    ] });
    ok(direct.sender[0].ok === false && direct.sender[0].reason === "occupied" && core.rev("snd-cable-c") === 0 && !core.state.has("snd-cable-b"),
      "review B1: a batch with one cable's two plugs in one jack is refused whole (nothing stored)", JSON.stringify(direct.sender[0]));
    const viaSanitizer = deliver(core, alice, { kind: "edit", opId: "y", changes: [{ componentId: "snd-cable-b", expectRev: 0, transform: cable([3, 3]) }] });
    ok(viaSanitizer.dropped === true, "review B1: the sanitizer already refuses an edit with both ends in one jack");
  }

  // Randomized: two holders of opposite ends with delayed views, and a third cable mover; the room
  // never holds two plugs in one jack, and every refusal leaves the state unchanged.
  {
    let seed = 12345;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const unseeded = () => {
      const core = new RoomCore();
      const alice = { id: "alice", name: "Alice" };
      const bob = { id: "bob", name: "Bob" };
      deliver(core, alice, { kind: "claim", componentId: "snd-cable-a::endpoint-0" });
      deliver(core, bob, { kind: "claim", componentId: "snd-cable-a::endpoint-1" });
      return { core, alice, bob };
    };
    for (let run = 0; run < 400; run += 1) {
      // Half the runs start from a cable the room has never stored.
      const { core, alice, bob } = run % 2 === 0 ? seeded() : unseeded();
      deliver(core, bob, { kind: "claim", componentId: "snd-cable-b" });
      let sequence = 1;
      for (let step = 0; step < 12; step += 1) {
        const before = JSON.stringify(core.join()[0].transforms);
        const pick = rand(3);
        const jack = rand(7) - 1; // -1 = unplug
        const socket = jack < 0 ? null : jack;
        let out;
        if (pick === 0) out = deliver(core, alice, endMove("snd-cable-a", [socket, rand(6)], 0, sequence++));
        else if (pick === 1) out = deliver(core, bob, endMove("snd-cable-a", [rand(6), socket], 1, sequence++));
        else out = deliver(core, bob, { kind: "transform", componentId: "snd-cable-b", sequence: sequence++, transform: { position: [-1, 0.48, 1], rotation: [0, 0, 0], sockets: socket === null ? null : [socket, (socket + 1 + rand(5)) % 6], endpoints: ends } });
        const used = [];
        for (const id of ["snd-cable-a", "snd-cable-b", "snd-cable-c"]) for (const jackIn of core.join()[0].transforms[id]?.transform.sockets ?? []) if (jackIn !== null) used.push(jackIn);
        if (new Set(used).size !== used.length) ok(false, "review B1 random: two plugs in one jack", JSON.stringify(core.join()[0].transforms));
        if (out.sender[0]?.kind === "transform-rejected" && JSON.stringify(core.join()[0].transforms) !== before) ok(false, "review B1 random: a refusal changed the room", before);
      }
    }
    ok(true, "review B1 random: 400 runs × 12 moves (half from a never-stored cable) by opposite end holders and a whole-cable mover never left two plugs in one jack");
  }
}

// ── 5. Project files: Sound is version 2; the other studios stay version 1 ──────────────
{
  const project = await import("../src/desktop/project-file.ts");
  const catalog = {
    studio: "sound",
    parts: { "snd-source": "source", "snd-filter": "filter", "snd-drive": "drive", "snd-speaker": null, "snd-cable-a": null, "snd-cable-b": null, "snd-cable-c": null },
    socketCount: 6,
    switches: ["snd-speaker"],
    sharedSockets: false,
    fixtures: ["snd-source", "snd-filter", "snd-drive", "snd-speaker"],
  };
  const circuit = { studio: "circuit", parts: { "resistor-1k": "resistor", "battery-9v": "battery", "led-red": null }, socketCount: 192, switches: [], sharedSockets: false };
  const catalogFor = (studio) => (studio === "sound" ? catalog : studio === "circuit" ? circuit : null);
  const transforms = {
    "snd-source": { ...pose("snd-source"), props: { hz: 220, wave: "sawtooth" } },
    "snd-filter": { ...pose("snd-filter"), props: { cutoff: 300 } },
    "snd-drive": { ...pose("snd-drive"), props: { gain: 1.7 } },
    "snd-speaker": { ...pose("snd-speaker"), on: true },
    "snd-cable-a": cable([0, 1]),
    "snd-cable-b": cable([2, 3]),
    "snd-cable-c": cable([4, null]),
  };
  const built = project.buildProject(catalog, transforms, null, new Date("2026-10-27T10:00:00Z"));
  ok(built.version === 2 && built.studio === "sound", "a Sound project is written as version 2");
  ok(built.solver === "sound-flow-signal-1", "a Sound project names the signal model, not the DC solver", built.solver);
  eq(built.parts.map((part) => [part.id, part.sockets, part.props ?? null, part.on ?? null]), [
    ["snd-source", null, { hz: 220, wave: "sawtooth" }, null], ["snd-filter", null, { cutoff: 300 }, null], ["snd-drive", null, { gain: 1.7 }, null], ["snd-speaker", null, null, true],
    ["snd-cable-a", [0, 1], null, null], ["snd-cable-b", [2, 3], null, null], ["snd-cable-c", null, null, null],
  ], "export holds knob values, the switch and only fully plugged cables' jacks (a half-plugged cable is exported unplugged)");
  ok(!/name|chat|predict|explan|participant|trace/i.test(JSON.stringify(built)), "no names, chat, predictions, explanations or traces in the file");
  const round = project.parseProject(JSON.stringify(built), catalogFor);
  ok(round.ok && JSON.stringify(round.project.parts) === JSON.stringify(built.parts), "round trip");
  const bad = (mutate, label) => {
    const copy = JSON.parse(JSON.stringify(built));
    mutate(copy);
    const result = project.parseProject(JSON.stringify(copy), catalogFor);
    ok(!result.ok, `refused: ${label}`, result.ok ? "accepted" : result.error);
  };
  bad((p) => { p.version = 1; }, "a version-1 file naming the sound studio");
  bad((p) => { p.parts[4].sockets = [0, 6]; }, "a jack that does not exist");
  bad((p) => { p.parts[5].sockets = [1, 4]; }, "two plugs in Filter IN");
  bad((p) => { p.parts[0].sockets = [0, 1]; }, "a fixture module placed in sockets");
  bad((p) => { p.parts[2].props = { gain: 4.5 }; }, "gain above ×4");
  bad((p) => { p.parts[0].props = { hz: 440, wave: "triangle" }; }, "an unknown waveform");
  bad((p) => { p.parts[4].props = { gain: 1 }; }, "a cable with knob values");
  bad((p) => { p.parts[0].on = true; }, "a switch on a module without one");
  bad((p) => { p.parts.push({ id: "snd-cable-d", sockets: null }); }, "an unknown part");
  const legacy = { format: "virtual-makerspace.project", version: 1, solver: "x", studio: "circuit", savedAt: "2026-01-01T00:00:00.000Z", parts: [{ id: "resistor-1k", sockets: [36, 39], props: { ohms: 470 } }] };
  ok(project.parseProject(JSON.stringify(legacy), catalogFor).ok, "an older version-1 Circuit Bench file still imports");
  ok(!project.parseProject(JSON.stringify({ ...legacy, version: 2 }), catalogFor).ok, "a version-2 file naming another studio is refused");
  ok(project.buildProject(circuit, { "resistor-1k": { position: [0, 0, 0], rotation: [0, 0, 0], sockets: [36, 39], props: { ohms: 470 } } }, null).version === 1, "other studios still write version 1");
  const defaults = (id) => (id === "snd-source" ? { hz: 440, wave: "sine" } : id === "snd-filter" ? { cutoff: 2000 } : id === "snd-drive" ? { gain: 1 } : null);
  const fresh = project.buildProject(catalog, {
    "snd-source": { ...pose("snd-source"), props: { hz: 440, wave: "sine" } }, "snd-filter": { ...pose("snd-filter"), props: { cutoff: 2000 } }, "snd-drive": { ...pose("snd-drive"), props: { gain: 1 } }, "snd-speaker": { ...pose("snd-speaker"), on: true },
  }, null);
  ok(project.isDefaultProject(fresh, defaults, (id) => id === "snd-speaker"), "a default desk (Speaker on) is empty: nothing to recover");
  ok(!project.isDefaultProject(built, defaults, (id) => id === "snd-speaker"), "a patched desk is worth recovering");
  const off = JSON.parse(JSON.stringify(fresh));
  off.parts[3].on = false;
  ok(!project.isDefaultProject(off, defaults, (id) => id === "snd-speaker"), "the Speaker switched off is not the default");
}

console.log(`sound model: ${checks} checks passed`);
