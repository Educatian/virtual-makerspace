// Resource-Limited Greenhouse (Episode 3): the model, the room's rules and the run state, checked
// against an INDEPENDENT oracle written here from the specification in docs/episodes.md (its own
// random generator, weather, hose/cable classification and step equations — none of the product's
// code), plus invariants, curated cases and seeded random builds.
//   node --experimental-strip-types scripts/greenhouse-model-check.mjs
//
//  1. weather: the oracle's seeded day equals the product's for 200 seeds;
//  2. the rig as built: curated builds with stated expectations (both), then 30,000 seeded random
//     builds (hoses, cables, probe, knobs) — supply, outlets and openings, channels, probe,
//     every line's status — product vs oracle;
//  3. the day: 2,000 random builds × whole seeded days, the product's snapshots vs the oracle's
//     at every step (1e-9), plus invariants on every step: nothing negative or above capacity,
//     water and energy ledgers closed (1e-9 L / Wh), wrong builds carrying 0 L and 0 W;
//  4. the brief: the default rig fails on the brief's day; the DI worked example meets it; the
//     share of a strategy grid that meets it (reported); named failure cases (empty tank, pump
//     without supply, starved loads, no probe, waterlogging, heat);
//  5. the run state: tick from server time, settle/pause/resume/step/speed/reset, determinism
//     (any pause schedule = one uninterrupted run), JSON round trip, refusals, bounded catch-up;
//  6. the room: typed ports, fixture poses, bounds, one plug per port (incl. merged end moves and
//     never-stored lines), rig locked while running (live moves, edits, imports), room empty →
//     paused with resources kept, late join gets the same run, stale edits.
import assert from "node:assert/strict";

const rules = await import("../cloudflare/greenhouse-rules.js");
const model = await import("../cloudflare/greenhouse-model.js");
const runs = await import("../cloudflare/greenhouse-run.js");
const { sanitizeTransform, sanitizeEdit } = await import("../cloudflare/sanitize.js");
const { RoomCore } = await import("../cloudflare/room-core.js");

let checks = 0;
const ok = (value, label, detail = "") => {
  checks += 1;
  assert.ok(value, `${label}${detail ? ` — ${detail}` : ""}`);
};
const close = (a, b, tolerance, label) => {
  checks += 1;
  if (!(Math.abs(a - b) <= tolerance)) assert.fail(`${label}: ${a} vs ${b}`);
};

// ── The specification, restated independently ─────────────────────────────────────────────
const SPEC = { steps: 96, dt: 0.25, tank: 40, cap: 20, bed0: 11, battCap: 12, batt0: 6, solar: 18, pumpW: 12, pumpL: 6, fanW: 8, gain: 4, cool: 7, k: { A: 0.8, B: 1.2 }, dry: 0.3, wet: 0.9, heat: 35, drainAt: 0.8, drainFrac: 0.25 };
// Port names in the order of the spec's table.
const PORTS = ["tank-out", "pump-in", "pump-out", "manifold-in", "valve-a-out", "valve-b-out", "bed-a-in", "bed-b-in", "solar-out", "ctrl-solar", "ctrl-ch1", "ctrl-ch2", "pump-pwr", "fan-pwr", "probe-a1", "probe-a2", "probe-b1", "probe-b2"];
const WATER = new Set(PORTS.slice(0, 8));
const POWER = new Set(PORTS.slice(8, 14));
const OUTS = new Set(["tank-out", "pump-out", "valve-a-out", "valve-b-out", "solar-out", "ctrl-ch1", "ctrl-ch2"]);
const HOSES = ["irrigation-hose", "irrigation-hose-2", "irrigation-hose-3", "irrigation-hose-4"];
const CABLES = ["power-cable-1", "power-cable-2", "power-cable-3"];

function oracleXorshift(seed) {
  let x = (Number(BigInt.asUintN(32, BigInt(seed) * 2654435761n))) || 1;
  return () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x / 2 ** 32;
  };
}
function oracleWeather(seed) {
  const r = oracleXorshift(seed);
  const tMax = 31 + Math.round(r() * 60) / 10;
  const tMin = 16 + Math.round(r() * 40) / 10;
  const n = 1 + Math.floor(r() * 2);
  const spells = [];
  for (let i = 0; i < n; i += 1) { const a = 16 + Math.floor(r() * 36); spells.push([a, Math.min(96, a + 4 + Math.floor(r() * 9))]); }
  const out = [];
  const sun = [];
  for (let k = 0; k < 96; k += 1) {
    const h = (6 + (k + 0.5) / 4) % 24;
    out.push(tMin + (tMax - tMin) * (1 - Math.cos((2 * Math.PI * (h - 4)) / 24)) / 2);
    const cloudy = spells.some(([a, b]) => k >= a && k < b);
    sun.push((h >= 6 && h <= 20 ? Math.sin((Math.PI * (h - 6)) / 14) : 0) * (cloudy ? 0.35 : 1));
  }
  return { tMax, tMin, spells, out, sun };
}

/** The rig as built, from a plain build description { hoses: {id: [a,b]}, cables, probe: [a,b]|null, vA, vB, pumpBelow, fanAbove }. */
function oracleRig(build) {
  const status = {};
  const edges = [];
  const plugs = {};
  for (const id of [...HOSES, ...CABLES]) for (const end of build.lines[id] ?? [null, null]) if (end !== null) plugs[end] = (plugs[end] ?? 0) + 1;
  for (const id of [...HOSES, ...CABLES]) {
    const [a, b] = build.lines[id] ?? [null, null];
    const allowed = HOSES.includes(id) ? WATER : POWER;
    if (a === null && b === null) { status[id] = "unplugged"; continue; }
    if (a === null || b === null) { status[id] = "loose"; continue; }
    const pa = PORTS[a];
    const pb = PORTS[b];
    if (!allowed.has(pa) || !allowed.has(pb)) { status[id] = "wrong-type"; continue; }
    if (plugs[a] > 1 || plugs[b] > 1) { status[id] = "shared-port"; continue; }
    const outA = OUTS.has(pa);
    const outB = OUTS.has(pb);
    if (outA === outB) { status[id] = outA ? "out-out" : "in-in"; continue; }
    const from = outA ? pa : pb;
    const to = outA ? pb : pa;
    const table = {
      "tank-out>pump-in": "supply",
      "pump-out>manifold-in": "delivery", "pump-out>bed-a-in": "delivery", "pump-out>bed-b-in": "delivery",
      "valve-a-out>bed-a-in": "branch", "valve-a-out>bed-b-in": "branch", "valve-b-out>bed-a-in": "branch", "valve-b-out>bed-b-in": "branch",
      "solar-out>ctrl-solar": "charging",
      "ctrl-ch1>pump-pwr": "feed", "ctrl-ch1>fan-pwr": "feed", "ctrl-ch2>pump-pwr": "feed", "ctrl-ch2>fan-pwr": "feed",
    };
    status[id] = table[`${from}>${to}`] ?? (from === "tank-out" ? "no-pump" : from === "solar-out" ? "unregulated" : "loop");
    edges.push({ id, from, to, kind: status[id] });
  }
  const has = (kind, from, to) => edges.some((e) => e.kind === kind && (from === undefined || e.from === from) && (to === undefined || e.to === to));
  const supply = has("supply");
  const pumpTo = edges.find((e) => e.kind === "delivery")?.to ?? null;
  const open = { A: 0, B: 0 };
  const openings = [];
  if (pumpTo === "bed-a-in" || pumpTo === "bed-b-in") openings.push({ bed: pumpTo === "bed-a-in" ? "A" : "B", v: 1 });
  if (pumpTo === "manifold-in") {
    for (const [outlet, v] of [["valve-a-out", build.vA / 100], ["valve-b-out", build.vB / 100]]) {
      const branch = edges.find((e) => e.kind === "branch" && e.from === outlet);
      if (branch) openings.push({ bed: branch.to === "bed-a-in" ? "A" : "B", v });
    }
  }
  for (const o of openings) open[o.bed] += o.v;
  const channel = (load) => { const f = edges.find((e) => e.kind === "feed" && e.to === load); return f ? (f.from === "ctrl-ch1" ? 1 : 2) : null; };
  const pumpCh = channel("pump-pwr");
  const fanCh = channel("fan-pwr");
  const order = [];
  for (const ch of [1, 2]) { if (pumpCh === ch) order.push("pump"); if (fanCh === ch) order.push("fan"); }
  let probe = null;
  if (build.probe && build.probe[0] !== null && build.probe[1] !== null) {
    const pair = [...build.probe].sort((x, y) => x - y).join(",");
    probe = pair === "14,15" ? "A" : pair === "16,17" ? "B" : null;
  }
  return { status, supply, openings, open, pumpCh, fanCh, order, solar: has("charging"), probe, pumpBelow: build.pumpBelow, fanAbove: build.fanAbove };
}

/** One whole day (or `steps` steps) from the start, every step's state. */
function oracleDay(rig, seed, steps = 96) {
  const w = oracleWeather(seed);
  let tank = SPEC.tank;
  let A = SPEC.bed0;
  let B = SPEC.bed0;
  let batt = SPEC.batt0;
  let lastAir = w.out[0] + SPEC.gain * w.sun[0];
  const sum = { et: 0, drain: 0, over: 0, solar: 0, used: 0, curt: 0 };
  const stress = { A: 0, B: 0, heat: 0 };
  const states = [];
  for (let k = 0; k < steps; k += 1) {
    const probeTheta = rig.probe === "A" ? A / SPEC.cap : rig.probe === "B" ? B / SPEC.cap : null;
    const wantPump = probeTheta !== null && probeTheta * 100 < rig.pumpBelow;
    const wantFan = lastAir > rig.fanAbove;
    const solarWh = rig.solar ? SPEC.solar * w.sun[k] * SPEC.dt : 0;
    let left = solarWh;
    let bank = batt;
    let pumpOn = false;
    let fanOn = false;
    let used = 0;
    for (const load of rig.order) {
      const want = load === "pump" ? wantPump : wantFan;
      if (!want) continue;
      const need = (load === "pump" ? SPEC.pumpW : SPEC.fanW) * SPEC.dt;
      if (left + bank + 1e-12 >= need) {
        const fromSun = Math.min(left, need);
        left -= fromSun;
        bank = Math.max(0, bank - (need - fromSun));
        used += need;
        if (load === "pump") pumpOn = true; else fanOn = true;
      }
    }
    const charge = Math.min(SPEC.battCap - bank, left);
    batt = bank + charge;
    sum.solar += solarWh;
    sum.used += used;
    sum.curt += left - charge;
    let toA = 0;
    let toB = 0;
    if (pumpOn && rig.supply) {
      const total = rig.openings.reduce((s, o) => s + o.v, 0);
      if (total > 0 && tank > 0) {
        const q = Math.min(SPEC.pumpL * Math.min(1, total), tank);
        tank -= q;
        for (const o of rig.openings) { if (o.v > 0) { if (o.bed === "A") toA += (q * o.v) / total; else toB += (q * o.v) / total; } }
      }
    }
    const air = w.out[k] + SPEC.gain * w.sun[k] - (fanOn ? SPEC.cool : 0);
    const bedStep = (water, add, kk) => {
      let x = water + add;
      const et = Math.min(x, Math.max(0, kk * (0.5 + 0.05 * (air - 20)) * SPEC.dt * Math.min(1, x / SPEC.cap / 0.4)));
      x -= et;
      const over = Math.max(0, x - SPEC.cap);
      x = Math.min(x, SPEC.cap);
      const drain = x > SPEC.drainAt * SPEC.cap ? SPEC.drainFrac * (x - SPEC.drainAt * SPEC.cap) : 0;
      x -= drain;
      return { x, et, over, drain };
    };
    const a = bedStep(A, toA, SPEC.k.A);
    const b = bedStep(B, toB, SPEC.k.B);
    A = a.x; B = b.x;
    sum.et += a.et + b.et; sum.drain += a.drain + b.drain; sum.over += a.over + b.over;
    if (A / SPEC.cap < SPEC.dry || A / SPEC.cap > SPEC.wet) stress.A += 1;
    if (B / SPEC.cap < SPEC.dry || B / SPEC.cap > SPEC.wet) stress.B += 1;
    if (air > SPEC.heat) stress.heat += 1;
    lastAir = air;
    states.push({ tank, A, B, batt, air, pumpOn, fanOn, toA, toB, et: sum.et, drain: sum.drain, over: sum.over, solar: sum.solar, used: sum.used, curt: sum.curt, stress: { ...stress } });
  }
  return states;
}

// Builds → the product's transforms.
const transformsOf = (build) => (id) => {
  if (build.lines[id]) return { sockets: build.lines[id] };
  if (id === "soil-sensor") return build.probe ? { sockets: build.probe } : null;
  if (id === "valve-manifold") return { props: { valveA: build.vA, valveB: build.vB } };
  if (id === "farm-controller") return { props: { pumpBelow: build.pumpBelow, fanAbove: build.fanAbove } };
  return null;
};
const CORRECT = {
  lines: { "irrigation-hose": [0, 1], "irrigation-hose-2": [2, 3], "irrigation-hose-3": [4, 6], "irrigation-hose-4": [5, 7], "power-cable-1": [8, 9], "power-cable-2": [10, 12], "power-cable-3": [11, 13] },
  probe: [14, 15], vA: 100, vB: 100, pumpBelow: 50, fanAbove: 30,
};
const withBuild = (changes) => ({ ...CORRECT, ...changes, lines: { ...CORRECT.lines, ...(changes.lines ?? {}) } });

// ── 1. Weather ────────────────────────────────────────────────────────────────────────────
for (let seed = 1; seed <= 200; seed += 1) {
  const p = model.weatherFor(seed);
  const o = oracleWeather(seed);
  ok(p.tMax === o.tMax && p.tMin === o.tMin && JSON.stringify(p.spells) === JSON.stringify(o.spells), `weather seed ${seed}: parameters agree`, JSON.stringify([p.tMax, o.tMax, p.spells, o.spells]));
  for (let k = 0; k < 96; k += 1) { close(p.outside[k], o.out[k], 1e-12, `weather seed ${seed} k ${k} outside`); close(p.sun[k], o.sun[k], 1e-12, `weather seed ${seed} k ${k} sun`); }
}
const brief = model.weatherFor(model.GH_MODEL.briefSeed);
ok(brief.tMax >= 36 && brief.tMax <= 37, "the brief's day is hot", String(brief.tMax));
ok(model.weatherFor(11).outside.every((t, k) => t === model.weatherFor(11).outside[k]), "the same seed gives the same day");

// ── 2. The rig as built ───────────────────────────────────────────────────────────────────
const compareRig = (build, label) => {
  const p = model.deriveRig(transformsOf(build));
  const o = oracleRig(build);
  for (const line of p.lines) ok(line.status === o.status[line.id], `${label}: ${line.id} status`, `${line.status} vs ${o.status[line.id]}`);
  ok(p.supply === o.supply && p.solar === o.solar && p.probe === o.probe && p.pumpChannel === o.pumpCh && p.fanChannel === o.fanCh && JSON.stringify(p.order) === JSON.stringify(o.order), `${label}: supply, solar, probe, channels`, JSON.stringify({ p: [p.supply, p.solar, p.probe, p.pumpChannel, p.fanChannel, p.order], o: [o.supply, o.solar, o.probe, o.pumpCh, o.fanCh, o.order] }));
  const sumBy = (list, bed) => list.filter((x) => x.bed === bed).reduce((s, x) => s + (x.opening ?? x.v), 0);
  for (const bed of ["A", "B"]) close(sumBy(p.outlets, bed), sumBy(o.openings, bed), 1e-12, `${label}: opening to bed ${bed}`);
  return { p, o };
};
const curated = [
  ["the full correct rig", CORRECT, (r) => r.p.complete && r.p.faults.length === 0],
  ["tank straight to bed A (no pump)", withBuild({ lines: { "irrigation-hose": [0, 6], "irrigation-hose-3": [null, null] } }), (r) => r.p.lines.find((l) => l.id === "irrigation-hose").status === "no-pump" && !r.p.supply && !r.p.complete],
  ["pump fed from its own outlet", withBuild({ lines: { "irrigation-hose": [2, 1], "irrigation-hose-2": [null, null] } }), (r) => r.p.lines.find((l) => l.id === "irrigation-hose").status === "loop" && !r.p.supply],
  ["OUT→OUT hose", withBuild({ lines: { "irrigation-hose-3": [4, 2], "irrigation-hose-2": [null, null] } }), (r) => r.p.lines.find((l) => l.id === "irrigation-hose-3").status === "out-out"],
  ["IN→IN hose", withBuild({ lines: { "irrigation-hose-4": [7, 3], "irrigation-hose-2": [null, null] } }), (r) => r.p.lines.find((l) => l.id === "irrigation-hose-4").status === "in-in"],
  ["a loose hose end", withBuild({ lines: { "irrigation-hose-3": [4, null] } }), (r) => r.p.lines.find((l) => l.id === "irrigation-hose-3").status === "loose" && !r.p.outlets.some((o) => o.bed === "A")],
  ["solar straight to the pump", withBuild({ lines: { "power-cable-1": [8, 12], "power-cable-2": [null, null] } }), (r) => r.p.lines.find((l) => l.id === "power-cable-1").status === "unregulated" && r.p.pumpChannel === null && !r.p.solar],
  ["fan on CH1, pump on CH2", withBuild({ lines: { "power-cable-2": [10, 13], "power-cable-3": [11, 12] } }), (r) => r.p.fanChannel === 1 && r.p.pumpChannel === 2 && JSON.stringify(r.p.order) === '["fan","pump"]'],
  ["pump straight to bed B (no manifold)", withBuild({ lines: { "irrigation-hose-2": [2, 7], "irrigation-hose-3": [null, null], "irrigation-hose-4": [null, null] } }), (r) => r.p.outlets.length === 1 && r.p.outlets[0].bed === "B" && r.p.outlets[0].opening === 1],
  ["both valves to one bed is impossible (one plug per inlet); valve B to bed A, A unplugged", withBuild({ lines: { "irrigation-hose-3": [null, null], "irrigation-hose-4": [5, 6] } }), (r) => r.p.outlets.length === 1 && r.p.outlets[0].bed === "A"],
  ["probe in bed B", withBuild({ probe: [17, 16] }), (r) => r.p.probe === "B"],
  ["no probe", withBuild({ probe: null }), (r) => r.p.probe === null && r.p.faults.some((f) => f.kind === "no-probe")],
  ["power cable in a hose port (a peer race; the room refuses it)", withBuild({ lines: { "power-cable-3": [11, 6], "irrigation-hose-3": [null, null] } }), (r) => r.p.lines.find((l) => l.id === "power-cable-3").status === "wrong-type" && r.p.fanChannel === null],
  ["valves both closed", withBuild({ vA: 0, vB: 0 }), (r) => r.p.outlets.every((o) => o.opening === 0) && r.p.faults.some((f) => f.kind === "bed-unwatered")],
];
for (const [label, build, expect] of curated) {
  const result = compareRig(build, label);
  ok(expect(result), `curated: ${label}`, JSON.stringify(result.p.faults));
}
let seed = 20261028;
const random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
const pick = (list) => list[Math.floor(random() * list.length)];
const randomBuild = () => {
  const lines = {};
  const free = (pool) => pool.filter((p) => !Object.values(lines).some(([a, b]) => a === p || b === p));
  for (const id of HOSES) lines[id] = random() < 0.15 ? [null, null] : [pick([null, ...free([0, 1, 2, 3, 4, 5, 6, 7])]), pick([null, ...free([0, 1, 2, 3, 4, 5, 6, 7])])];
  for (const id of CABLES) lines[id] = random() < 0.15 ? [null, null] : [pick([null, ...free([8, 9, 10, 11, 12, 13])]), pick([null, ...free([8, 9, 10, 11, 12, 13])])];
  for (const id of Object.keys(lines)) if (lines[id][0] !== null && lines[id][0] === lines[id][1]) lines[id][1] = null;
  return {
    lines,
    probe: pick([null, [14, 15], [15, 14], [16, 17], [17, 16]]),
    vA: pick([0, 5, 25, 30, 50, 75, 100]),
    vB: pick([0, 5, 25, 50, 60, 100]),
    pumpBelow: pick([10, 30, 45, 50, 60, 70, 90]),
    fanAbove: pick([20, 24, 26, 30, 35, 40]),
  };
};
for (let i = 0; i < 30000; i += 1) compareRig(randomBuild(), `random build ${i}`);
// Biased: mostly-correct builds (so the day comparisons below see working irrigation often).
const nearCorrect = () => {
  const b = random() < 0.5 ? withBuild({}) : randomBuild();
  b.vA = pick([0, 10, 20, 30, 40, 50, 60, 100]); b.vB = pick([0, 20, 30, 50, 60, 80, 100]);
  b.pumpBelow = pick([10, 30, 50, 60, 70, 90]); b.fanAbove = pick([20, 24, 26, 30, 34, 40]);
  if (random() < 0.3) { const [h] = [pick(HOSES)]; b.lines[h] = [b.lines[h][0], null]; }
  if (random() < 0.2) b.lines["power-cable-2"] = [11, 12], b.lines["power-cable-3"] = [10, 13];
  if (random() < 0.2) b.probe = pick([null, [16, 17]]);
  return b;
};

// ── 3. The day: product vs oracle at every step, with invariants ──────────────────────────
const daySeeds = [11, 2417, 4242, 1, 99999, 777];
for (let i = 0; i < 2000; i += 1) {
  const build = nearCorrect();
  const daySeed = daySeeds[i % daySeeds.length];
  const rig = model.deriveRig(transformsOf(build));
  const oracle = oracleDay(oracleRig(build), daySeed);
  let snapshot = model.initialSnapshot(daySeed);
  const weather = model.weatherFor(daySeed);
  for (let k = 0; k < 96; k += 1) {
    const { snapshot: next, record } = model.stepModel(snapshot, rig, weather);
    snapshot = next;
    const o = oracle[k];
    const label = `day ${i} (seed ${daySeed}) step ${k}`;
    close(snapshot.tank, o.tank, 1e-9, `${label}: tank`);
    close(snapshot.beds.A, o.A, 1e-9, `${label}: bed A`);
    close(snapshot.beds.B, o.B, 1e-9, `${label}: bed B`);
    close(snapshot.battery, o.batt, 1e-9, `${label}: battery`);
    close(snapshot.air, o.air, 1e-9, `${label}: air`);
    close(snapshot.totals.et, o.et, 1e-9, `${label}: ET`);
    close(snapshot.totals.drainage + snapshot.totals.overflow, o.drain + o.over, 1e-9, `${label}: drainage + overflow`);
    close(snapshot.totals.curtailed, o.curt, 1e-9, `${label}: curtailed`);
    ok(JSON.stringify(snapshot.stress) === JSON.stringify(o.stress), `${label}: stress counts`, JSON.stringify([snapshot.stress, o.stress]));
    ok((record.pump === "running" || record.pump === "tank-ran-out") === (o.toA + o.toB > 0) || (o.toA + o.toB === 0 && record.beds.A.in + record.beds.B.in === 0), `${label}: the pump delivered iff the oracle's did`);
    const b = model.balance(snapshot);
    if (!(Math.abs(b.water) <= 1e-9 && Math.abs(b.energy) <= 1e-9)) assert.fail(`${label}: ledger ${JSON.stringify(b)}`);
    const nonNegative = snapshot.tank >= 0 && snapshot.beds.A >= 0 && snapshot.beds.B >= 0 && snapshot.battery >= 0 && Object.values(snapshot.totals).every((v) => v >= 0);
    const bounded = snapshot.tank <= 40 && snapshot.beds.A <= 20 + 1e-12 && snapshot.beds.B <= 20 + 1e-12 && snapshot.battery <= 12 + 1e-12;
    if (!nonNegative || !bounded) assert.fail(`${label}: out of bounds ${JSON.stringify(snapshot)}`);
    if (!rig.supply || !rig.outlets.length) { if (record.beds.A.in + record.beds.B.in !== 0) assert.fail(`${label}: water through an invalid path`); }
    checks += 3;
  }
}
// The same builds with the oracle's own ledger (independent of the product's balance()).
for (let i = 0; i < 200; i += 1) {
  const build = nearCorrect();
  const daySeed = daySeeds[i % daySeeds.length];
  const last = oracleDay(oracleRig(build), daySeed).at(-1);
  close(SPEC.tank + 2 * SPEC.bed0, last.tank + last.A + last.B + last.et + last.drain + last.over, 1e-9, `oracle's own water ledger, day ${i}`);
  close(last.solar + SPEC.batt0, last.used + last.batt + last.curt, 1e-9, `oracle's own energy ledger, day ${i}`);
}

// ── 4. The brief ───────────────────────────────────────────────────────────────────────────
const dayOf = (build, daySeed = 11) => {
  const rig = model.deriveRig(transformsOf(build));
  const { snapshot, records } = model.simulate(model.initialSnapshot(daySeed), rig, daySeed, 96);
  return { rig, snapshot, records, verdict: model.evaluateBrief(snapshot, rig) };
};
const defaults = dayOf(CORRECT);
ok(defaults.verdict.finished && !defaults.verdict.met, "the default allocation (valves 100/100, pump below 50 %, fan above 30 °C) fails the brief", JSON.stringify(defaults.snapshot.stress));
ok(!defaults.verdict.criteria.find((c) => c.id === "G3").pass, "…because bed B is stressed too long", defaults.verdict.criteria.find((c) => c.id === "G3").measured);
const W = model.GH_WORKED_EXAMPLE;
const worked = dayOf(withBuild({ vA: W.valveA, vB: W.valveB, pumpBelow: W.pumpBelow, fanAbove: W.fanAbove, probe: W.probe === "A" ? [14, 15] : [16, 17] }));
ok(worked.verdict.met, "the DI worked example meets the brief on its day", JSON.stringify(worked.verdict.criteria));
let grid = 0;
let met = 0;
for (let vA = 0; vA <= 100; vA += 5) for (let vB = 0; vB <= 100; vB += 5) for (let pb = 10; pb <= 90; pb += 5) for (const fa of [24, 26, 28, 30, 32]) for (const pumpFirst of [true, false]) for (const probe of [[14, 15], [16, 17]]) {
  grid += 1;
  const build = withBuild({ vA, vB, pumpBelow: pb, fanAbove: fa, probe, lines: pumpFirst ? {} : { "power-cable-2": [11, 12], "power-cable-3": [10, 13] } });
  if (dayOf(build).verdict.met) met += 1;
}
ok(met > 0 && met / grid < 0.05, "the brief has a narrow region of solutions (more than none, under 5 % of the strategy grid)", `${met} of ${grid}`);
console.log(`brief met by ${met} of ${grid} grid strategies (${((100 * met) / grid).toFixed(2)} %)`);
// Named failure cases.
const noSupply = dayOf(withBuild({ lines: { "irrigation-hose": [null, null] } }));
ok(noSupply.records.some((r) => r.pump === "dry-no-supply") && noSupply.snapshot.tank === 40 && noSupply.snapshot.totals.used > 0, "pump without a supply runs dry: uses power, moves no water");
const noProbe = dayOf(withBuild({ probe: null }));
ok(noProbe.records.every((r) => r.pump === "off") && noProbe.snapshot.tank === 40, "no probe: no reading, the pump never runs");
const flood = dayOf(withBuild({ vA: 100, vB: 0, pumpBelow: 90 }));
ok(flood.snapshot.totals.drainage + flood.snapshot.totals.overflow > 1 && flood.snapshot.tank < 1, "over-watering bed A drains water away and empties the tank");
ok(flood.records.some((r) => r.pump === "dry-tank-empty" || r.pump === "tank-ran-out"), "…and the empty tank is named", flood.records.map((r) => r.pump).filter((p) => p !== "off" && p !== "running").join(","));
ok(flood.records.some((r) => r.beds.A.state === "waterlogged"), "…bed A is waterlogged at some point");
const noFan = dayOf(withBuild({ lines: { "power-cable-3": [null, null] } }));
ok(noFan.snapshot.stress.heat > 4 && noFan.records.every((r) => r.fan === "off"), "no fan: the afternoon overheats", String(noFan.snapshot.stress.heat));
const noSolar = dayOf(withBuild({ lines: { "power-cable-1": [null, null] } }));
ok(noSolar.records.some((r) => r.pump === "starved" || r.fan === "starved") && noSolar.snapshot.totals.solarIn === 0, "no solar: loads starve once the battery is spent");
const tankToBed = dayOf(withBuild({ lines: { "irrigation-hose": [0, 6], "irrigation-hose-3": [null, null] } }));
ok(tankToBed.snapshot.tank === 40 && tankToBed.records.every((r) => r.beds.A.in === 0 && r.beds.B.in === 0), "tank straight to a bed: 0 L moved all day");

// ── 5. The run state ───────────────────────────────────────────────────────────────────────
const rig = model.deriveRig(transformsOf(withBuild({ vA: 30, vB: 50, pumpBelow: 60, fanAbove: 26 })));
let run = runs.initialRun();
ok(run.status === "idle" && run.tick === 0 && run.seed === 11 && run.snapshot.tank === 40, "a new room's run: idle at 06:00 with a full tank");
let r = runs.reduceGreenhouseRun(run, { type: "start" }, 1_000_000, rig);
ok(r.ok && r.run.status === "running" && r.run.anchorAt === 1_000_000, "start runs from 06:00");
run = r.run;
ok(runs.currentTick(run, 1_000_000 + runs.STEP_MS * 10 + 1) === 10, "10 steps of server time later the tick is 10 (×1)");
ok(runs.currentTick(run, 1_000_000 + runs.STEP_MS * 1000) === 96, "the tick never passes the end of the day (bounded catch-up)");
ok(!runs.reduceGreenhouseRun(run, { type: "start" }, 1_000_100, rig).ok, "start while running is refused");
r = runs.reduceGreenhouseRun(run, { type: "pause" }, 1_000_000 + runs.STEP_MS * 10 + 5, rig);
ok(r.ok && r.run.status === "paused" && r.run.tick === 10 && r.run.records.length === 10, "pause settles the anchor to the current tick, with its records");
const pausedAt10 = r.run;
ok(runs.currentTick(pausedAt10, 9e12) === 10, "a paused day's time does not advance (no free elapsed time)");
r = runs.reduceGreenhouseRun(pausedAt10, { type: "step" }, 2_000_000, rig);
ok(r.ok && r.run.tick === 14 && r.run.status === "paused", "step advances one model hour (4 steps) and stays paused");
// Determinism: any pause schedule equals one uninterrupted day.
const straight = model.simulate(model.initialSnapshot(11), rig, 11, 96).snapshot;
for (let trial = 0; trial < 60; trial += 1) {
  let t = 5_000_000;
  let current = runs.reduceGreenhouseRun(runs.initialRun(), { type: "start" }, t, rig).run;
  let guard = 0;
  while (current.status !== "ended" && guard < 400) {
    guard += 1;
    const choice = random();
    t += Math.floor(random() * runs.STEP_MS * 9);
    // An action that the (settled) state refuses — e.g. a pause after the day ended — leaves the settled state.
    const act = (action) => { const result = runs.reduceGreenhouseRun(current, action, t, rig); return result.ok ? result.run : runs.settle(current, t, rig); };
    if (current.status === "running" && choice < 0.4) current = act({ type: "pause" });
    else if (current.status === "paused" && choice < 0.5) current = act({ type: "resume" });
    else if (current.status === "paused") current = act({ type: "step" });
    else if (choice < 0.55) current = act({ type: "speed", speed: current.speed === 1 ? 4 : 1 });
    else current = runs.settle(current, t, rig);
    // A JSON round trip (storage, the wire) in between changes nothing.
    current = runs.sanitizeGreenhouseRun(JSON.parse(JSON.stringify(current)));
    if (!current) assert.fail("a run state failed its own validation after a round trip");
  }
  ok(current.status === "ended" && current.tick === 96, `schedule ${trial}: the day ends`, `${current.status} ${current.tick}`);
  for (const key of ["tank", "battery", "air"]) close(current.snapshot[key], straight[key], 1e-12, `schedule ${trial}: ${key} equals the uninterrupted day`);
  for (const bed of ["A", "B"]) close(current.snapshot.beds[bed], straight.beds[bed], 1e-12, `schedule ${trial}: bed ${bed} equals the uninterrupted day`);
  ok(JSON.stringify(current.snapshot.stress) === JSON.stringify(straight.stress) && current.records.length === 96, `schedule ${trial}: stress and records equal the uninterrupted day`);
}
r = runs.reduceGreenhouseRun(pausedAt10, { type: "reset" }, 3_000_000, rig);
ok(r.ok && r.run.status === "idle" && r.run.tick === 0 && r.run.snapshot.tank === 40 && r.run.runId === pausedAt10.runId + 1 && r.run.records.length === 0, "reset starts a new run (new id, full tank) — the only refill");
ok(runs.reduceGreenhouseRun(pausedAt10, { type: "reset", seed: 4242 }, 3_000_000, rig).run.seed === 4242, "reset may choose another day's seed");
ok(!runs.reduceGreenhouseRun(pausedAt10, { type: "reset", seed: 0 }, 3_000_000, rig).ok && runs.sanitizeGreenhouseAction({ type: "reset", seed: 1.5 }) === null, "invalid seeds are refused");
ok(runs.sanitizeGreenhouseAction({ type: "speed", speed: 3 }) === null && runs.sanitizeGreenhouseAction({ type: "warp" }) === null && runs.sanitizeGreenhouseAction(null) === null, "malformed actions are dropped");
ok(runs.sanitizeGreenhouseAction({ type: "pause", runId: 1.5 }) === null && runs.sanitizeGreenhouseAction({ type: "pause", runId: "2" }) === null && runs.sanitizeGreenhouseAction({ type: "pause", runId: 0 }) === null, "a malformed run id drops the action");
ok(JSON.stringify(runs.sanitizeGreenhouseAction({ type: "reset", seed: 7, runId: 3, extra: "x" })) === JSON.stringify({ type: "reset", seed: 7, runId: 3 }), "a run id is kept; unknown keys are dropped");
ok(runs.reduceGreenhouseRun(pausedAt10, { type: "resume", runId: pausedAt10.runId + 1 }, 3_000_000, rig).reason === "stale", "an action for another run is stale");
const tampered = JSON.parse(JSON.stringify(pausedAt10));
tampered.snapshot.tank = 400;
ok(runs.sanitizeGreenhouseRun(tampered) === null, "a stored run with an impossible tank is refused");
const negative = JSON.parse(JSON.stringify(pausedAt10));
negative.snapshot.beds.A = -1;
ok(runs.sanitizeGreenhouseRun(negative) === null, "a stored run with negative water is refused");
const shortRecords = JSON.parse(JSON.stringify(pausedAt10));
shortRecords.records.pop();
ok(runs.sanitizeGreenhouseRun(shortRecords) === null, "a stored run whose records do not match its tick is refused");
const emptied = runs.onGreenhouseRoomEmpty(runs.reduceGreenhouseRun(runs.initialRun(), { type: "start" }, 0, rig).run, runs.STEP_MS * 7 + 3, rig);
ok(emptied && emptied.status === "paused" && emptied.tick === 7, "the room empty: a running day pauses where it is");

// ── 6. The room ────────────────────────────────────────────────────────────────────────────
const pose = (id) => ({ position: [...rules.GH_FIXTURE_POSES[id]], rotation: [0, 0, 0], sockets: null });
const line = (sockets, extra = {}) => ({ position: [0, 0.5, 2.6], rotation: [0, 0, 0], sockets, endpoints: [[-0.5, 0, 0], [0.5, 0, 0]], ...extra });
ok(sanitizeTransform(line([0, 1]), "irrigation-hose") !== null, "a hose from TANK OUT to PUMP IN is accepted");
ok(sanitizeTransform(line([0, 9]), "irrigation-hose") === null, "a hose into a power port is refused (wrong connector type)");
ok(sanitizeTransform(line([8, 6]), "power-cable-1") === null, "a power cable into a hose port is refused");
ok(sanitizeTransform(line([14, 1]), "irrigation-hose") === null, "a hose into a probe slot is refused");
ok(sanitizeTransform(line([3, 3]), "irrigation-hose-2") === null, "both ends of one hose in one port are refused");
ok(sanitizeTransform(line([18, null]), "irrigation-hose-2") === null, "a port index outside the rig is refused");
ok(sanitizeTransform(line([0, 2]), "irrigation-hose-2") !== null, "an OUT→OUT hose is stored (a wrong build the model draws)");
ok(sanitizeTransform({ ...pose("water-pump"), position: [0, 0, 0] }, "water-pump") === null, "a moved pump is refused");
ok(sanitizeTransform({ ...pose("valve-manifold"), props: { valveA: 30, valveB: 50 } }, "valve-manifold")?.props.valveA === 30, "valve openings on the step are accepted");
ok(sanitizeTransform({ ...pose("valve-manifold"), props: { valveA: 33, valveB: 50 } }, "valve-manifold") === null, "a valve opening off the 5 % step is refused, not rounded");
ok(sanitizeTransform({ ...pose("valve-manifold"), props: { valveA: 120, valveB: 50 } }, "valve-manifold") === null, "a valve above 100 % is refused, not clamped");
ok(sanitizeTransform({ ...pose("farm-controller"), props: { pumpBelow: 60, fanAbove: 26 } }, "farm-controller") !== null, "controller thresholds in range are accepted");
ok(sanitizeTransform({ ...pose("farm-controller"), props: { pumpBelow: 60, fanAbove: 41 } }, "farm-controller") === null, "a fan threshold above 40 °C is refused");
ok(sanitizeTransform({ ...pose("farm-controller"), props: { pumpBelow: 60 } }, "farm-controller") === null, "incomplete controller values are refused");
ok(sanitizeTransform({ ...pose("vent-fan"), on: true }, "vent-fan") === null, "a fan switch value is refused (the controller decides)");
ok(sanitizeTransform({ position: [0, 0.4, 0], rotation: [0, 0, 0], sockets: [14, 15] }, "soil-sensor") !== null && sanitizeTransform({ position: [0, 0.4, 0], rotation: [0, 0, 0], sockets: [15, 16] }, "soil-sensor") === null, "the probe seats only in one bed's slot");
ok(sanitizeEdit({ kind: "edit", opId: "x", changes: [{ componentId: "irrigation-hose-2", expectRev: 0, transform: line([5, 9]) }] }) === null, "an edit with a wrong-type hose is refused whole");

// RoomCore: one plug per port, merged end moves, never-stored lines, the lock while running.
{
  let now = 10_000_000;
  const core = new RoomCore({ now: () => now });
  const alice = { id: "alice", name: "Alice" };
  const bob = { id: "bob", name: "Bob" };
  const edit = (who, opId, changes) => core.handle(who, { kind: "edit", opId, changes });
  let out = edit(alice, "e1", [{ componentId: "irrigation-hose", expectRev: 0, transform: line([0, 1]) }]);
  ok(out.sender[0].ok === true, "Alice plumbs TANK OUT → PUMP IN");
  out = edit(bob, "e2", [{ componentId: "irrigation-hose-2", expectRev: 0, transform: line([1, 6]) }]);
  ok(out.sender[0].ok === false && out.sender[0].reason === "occupied", "Bob's hose into the occupied PUMP IN is refused (occupied)");
  // Never-stored hose: an end move stores only that end.
  core.handle(alice, { kind: "claim", componentId: "irrigation-hose-3::endpoint-0" });
  out = core.handle(alice, { kind: "transform", componentId: "irrigation-hose-3", sequence: 1, transform: { ...line([4, 7]), activeEndpoint: 0 } });
  ok(out.sender[0].kind === "rev-ack" && JSON.stringify(core.state.get("irrigation-hose-3").transform.sockets) === "[4,null]", "a never-stored hose's end move stores only that end ([4,null])", JSON.stringify(core.state.get("irrigation-hose-3")?.transform.sockets));
  core.handle(bob, { kind: "claim", componentId: "irrigation-hose-3::endpoint-1" });
  out = core.handle(bob, { kind: "transform", componentId: "irrigation-hose-3", sequence: 1, transform: { ...line([null, 4]), activeEndpoint: 1 } });
  ok(out.sender[0].kind === "transform-rejected" && out.sender[0].reason === "occupied", "the other holder's end into the same port is refused (merged pair)");
  // Run: start, then every rig change is refused while running.
  out = core.handle(alice, { kind: "greenhouse", opId: "g1", action: { type: "start" } });
  ok(out.sender.some((m) => m.kind === "greenhouse-result" && m.ok) && out.others.some((m) => m.kind === "greenhouse-state" && m.run.status === "running"), "start is accepted and broadcast with the run state");
  now += runs.STEP_MS * 3;
  out = edit(bob, "e3", [{ componentId: "valve-manifold", expectRev: 0, transform: { ...pose("valve-manifold"), props: { valveA: 30, valveB: 50 } } }]);
  ok(out.sender[0].ok === false && out.sender[0].reason === "running", "a valve edit while the day runs is refused (running)");
  core.handle(bob, { kind: "claim", componentId: "irrigation-hose-4::endpoint-0" });
  out = core.handle(bob, { kind: "transform", componentId: "irrigation-hose-4", sequence: 2, transform: { ...line([5, null]), activeEndpoint: 0 } });
  ok(out.sender[0].kind === "transform-rejected" && out.sender[0].reason === "running" && out.others.length === 0, "a live hose move while running is refused and relayed to nobody");
  out = edit(bob, "e4", [{ componentId: "led-red", expectRev: 0, transform: { position: [0, 0.5, 0], rotation: [0, 0, 0], sockets: null } }]);
  ok(out.sender[0].ok === true, "edits of other studios' parts are not locked by the greenhouse day");
  // Pause settles at the server's tick; then the edit goes through.
  out = core.handle(bob, { kind: "greenhouse", opId: "g2", action: { type: "pause" } });
  const pausedRun = out.others.find((m) => m.kind === "greenhouse-state")?.run;
  ok(pausedRun?.status === "paused" && pausedRun.tick === 3, "pause settles at the room's tick (3)", JSON.stringify(pausedRun?.tick));
  out = edit(bob, "e5", [{ componentId: "valve-manifold", expectRev: 0, transform: { ...pose("valve-manifold"), props: { valveA: 30, valveB: 50 } } }]);
  ok(out.sender[0].ok === true, "after the pause the valve edit is accepted");
  // A late joiner gets the same run (anchor) and server time.
  const joined = core.join()[0];
  ok(joined.greenhouse.tick === 3 && joined.greenhouse.status === "paused" && joined.greenhouse.records.length === 3 && typeof joined.serverNow === "number", "a late joiner receives the run state and the server time");
  // Stale reset race: two resets in a row both apply in order (new run ids), never resurrecting.
  out = core.handle(alice, { kind: "greenhouse", opId: "g3", action: { type: "reset" } });
  const firstReset = out.others.find((m) => m.kind === "greenhouse-state").run;
  out = core.handle(bob, { kind: "greenhouse", opId: "g4", action: { type: "resume" } });
  ok(out.sender.some((m) => m.kind === "greenhouse-result" && !m.ok && m.reason === "idle"), "a resume based on a stale view (the day was just reset) is refused (idle)");
  ok(firstReset.tick === 0 && firstReset.snapshot.tank === 40, "reset: tick 0, full tank");
  // A stale reset (decided on the run before the one just started) is refused and wipes nothing.
  core.handle(alice, { kind: "greenhouse", opId: "g3b", action: { type: "step", runId: firstReset.runId } });
  const stepped = core.greenhouse;
  out = core.handle(bob, { kind: "greenhouse", opId: "g3c", action: { type: "reset", runId: firstReset.runId - 1 } });
  ok(out.sender.some((m) => m.kind === "greenhouse-result" && !m.ok && m.reason === "stale") && out.others.length === 0 && core.greenhouse === stepped && core.greenhouse.tick === 4, "a reset decided on an older run is refused (stale): the newer day keeps its hour", JSON.stringify(core.greenhouse.tick));
  out = core.handle(bob, { kind: "greenhouse", opId: "g3d", action: { type: "pause", runId: firstReset.runId + 7 } });
  ok(out.sender.some((m) => m.kind === "greenhouse-result" && !m.ok && m.reason === "stale"), "an action naming a run the room never had is refused (stale)");
  out = core.handle(bob, { kind: "greenhouse", opId: "g3e", action: { type: "reset", runId: firstReset.runId } });
  ok(out.others.some((m) => m.kind === "greenhouse-state" && m.run.runId === firstReset.runId + 1 && m.run.tick === 0), "a reset naming the current run applies");
  // Running again, then the room empties: the run pauses where it is and keeps its resources.
  core.handle(alice, { kind: "greenhouse", opId: "g5", action: { type: "start" } });
  now += runs.STEP_MS * 5 + 10;
  const tickBefore = runs.currentTick(core.greenhouse, now);
  core.leave(alice);
  core.leave(bob);
  core.reset();
  ok(core.greenhouse.status === "paused" && core.greenhouse.tick === tickBefore && core.greenhouse.tick === 5, "everyone left: the day paused at the room's tick with its resources", `${core.greenhouse.status} ${core.greenhouse.tick}`);
  now += 3_600_000;
  ok(runs.currentTick(core.greenhouse, now) === 5, "an hour away grants no model time");
  ok(core.state.size === 0, "the bench itself resets as in every studio (Recovery restores it)");
  // An import (an edit) while running is refused like any rig edit.
  core.handle(alice, { kind: "greenhouse", opId: "g6", action: { type: "resume" } });
  out = edit(alice, "e6", [{ componentId: "irrigation-hose", expectRev: 0, transform: line([0, 1]) }, { componentId: "irrigation-hose-2", expectRev: 0, transform: line([2, 3]) }]);
  ok(out.sender[0].ok === false && out.sender[0].reason === "running" && core.rev("irrigation-hose") === 0, "an import (one atomic edit) while running is refused and stores nothing");
}

console.log(`greenhouse model: ${checks} checks passed`);
