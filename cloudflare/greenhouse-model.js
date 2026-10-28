/**
 * Resource-Limited Greenhouse (Episode 3): the teaching model. Deterministic and pure (plain JS,
 * shared by the room and every client), documented in docs/episodes.md ("Goal and model"):
 *
 * - 96 steps of 15 min (06:00 → 06:00); sensors are read at the start of a step and the
 *   controller decides that step's loads from those readings.
 * - Seeded weather (xorshift32): outside temperature curve, sun, cloud spells.
 * - Greenhouse air = outside + 4 °C·sun − 7 °C when the fan ran (no thermal mass).
 * - Power: 18 W·sun solar into a 12 Wh battery (starts 6 Wh); channel 1 served before channel 2;
 *   a load runs a whole step or is starved; surplus charges, the rest is curtailed.
 * - Water: a 40 L tank, the pump (12 W, 6 L per step) through the valve manifold to two beds of
 *   20 L capacity; uptake/evaporation, gravity drainage above θ 0.8, overflow above capacity.
 *
 * Every step keeps two ledgers exactly (tests check them):
 *   water:  tank0 + bedA0 + bedB0 = tank + bedA + bedB + et + drainage + overflow
 *   energy: solarIn + battery0 = used + battery + curtailed
 * Hoses hold nothing; nothing is created; nothing goes negative.
 *
 * These are teaching numbers, not validated crop, weather or botanical predictions.
 */
import { GH_PORTS, GH_PORT, GH_HOSE_IDS, GH_CABLE_IDS, GH_DEFAULT_PROPS, GH_PROBE_ID, probeBed } from "./greenhouse-rules.js";

export const GH_MODEL = Object.freeze({
  steps: 96,
  dtHours: 0.25,
  startHour: 6,
  tankLitres: 40,
  bedCapacity: 20,
  bedStart: 11,
  batteryWh: 12,
  batteryStart: 6,
  solarW: 18,
  pumpW: 12,
  pumpLitresPerStep: 6,
  fanW: 8,
  greenhouseGain: 4,
  fanCooling: 7,
  uptake: { A: 0.8, B: 1.2 },
  dryBelow: 0.3,
  severeBelow: 0.15,
  wetAbove: 0.9,
  heatAbove: 35,
  drainAbove: 0.8,
  drainFraction: 0.25,
  briefSeed: 11,
  reserve: 8,
  stressAllowance: 8,
  heatAllowance: 4,
});

/** Model hour of day at the middle of step k (0..96). */
export const hourAt = (k) => (GH_MODEL.startHour + (k + 0.5) * GH_MODEL.dtHours) % 24;
/** Clock label of the START of step k ("06:00" … "05:45"; k = 96 is "06:00" the next day). */
export function clockAt(k) {
  const minutes = Math.round((GH_MODEL.startHour * 60 + k * GH_MODEL.dtHours * 60) % (24 * 60));
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** xorshift32, seeded (the same day for the same seed everywhere). */
function generator(seed) {
  let state = (Math.imul(seed >>> 0 || 1, 2654435761) >>> 0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

export const isSeed = (seed) => Number.isInteger(seed) && seed >= 1 && seed <= 99999;

/** The seeded day: outside temperature (°C) and sun (0..1) per step, and what set them. */
export function weatherFor(seed) {
  const random = generator(seed);
  const tMax = 31 + Math.round(random() * 60) / 10;
  const tMin = 16 + Math.round(random() * 40) / 10;
  const spells = [];
  const count = 1 + Math.floor(random() * 2);
  for (let index = 0; index < count; index += 1) {
    const start = 16 + Math.floor(random() * 36);
    const length = 4 + Math.floor(random() * 9);
    spells.push([start, Math.min(GH_MODEL.steps, start + length)]);
  }
  const outside = [];
  const sun = [];
  for (let k = 0; k < GH_MODEL.steps; k += 1) {
    const hour = hourAt(k);
    outside.push(tMin + (tMax - tMin) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (hour - 4)) / 24)));
    let light = hour >= 6 && hour <= 20 ? Math.sin((Math.PI * (hour - 6)) / 14) : 0;
    if (spells.some(([from, to]) => k >= from && k < to)) light *= 0.35;
    sun.push(light);
  }
  return { seed, tMax, tMin, spells, outside, sun };
}

const isEnd = (value) => Number.isInteger(value) && value >= 0 && value < GH_PORTS.length;

/**
 * The rig as built, from the parts' shared transforms (`transformOf(id)` → { sockets?, props? }
 * or null for a part the room never stored, which is in its default place): every hose and cable
 * with its status, what reaches where, and the named faults. Wrong builds carry nothing.
 */
export function deriveRig(transformOf) {
  const socketsOf = (id) => {
    const sockets = transformOf(id)?.sockets;
    return Array.isArray(sockets) ? [isEnd(sockets[0]) ? sockets[0] : null, isEnd(sockets[1]) ? sockets[1] : null] : [null, null];
  };
  const manifold = { ...GH_DEFAULT_PROPS["valve-manifold"], ...(transformOf("valve-manifold")?.props ?? {}) };
  const controller = { ...GH_DEFAULT_PROPS["farm-controller"], ...(transformOf("farm-controller")?.props ?? {}) };
  const probe = probeBed(transformOf(GH_PROBE_ID)?.sockets);

  const lines = [];
  const add = (id, type) => {
    const [a, b] = socketsOf(id);
    const typeOk = (end) => end === null || GH_PORTS[end].type === type;
    const line = { id, type, ends: [a, b], from: null, to: null, status: "unplugged" };
    if (a === null && b === null) line.status = "unplugged";
    else if (a === null || b === null) line.status = "loose";
    else if (!typeOk(a) || !typeOk(b)) line.status = "wrong-type";
    else {
      const ra = GH_PORTS[a].role;
      const rb = GH_PORTS[b].role;
      if (ra === rb) line.status = ra === "out" ? "out-out" : "in-in";
      else {
        line.from = ra === "out" ? a : b;
        line.to = ra === "out" ? b : a;
        line.status = "connected";
      }
    }
    lines.push(line);
  };
  for (const id of GH_HOSE_IDS) add(id, "water");
  for (const id of GH_CABLE_IDS) add(id, "power");
  // Two plugs in one port cannot be stored; if a peer race ever produced it, both are ignored.
  const plugs = new Map();
  for (const line of lines) for (const end of line.ends) if (end !== null) plugs.set(end, (plugs.get(end) ?? 0) + 1);
  for (const line of lines) if (line.ends.some((end) => end !== null && plugs.get(end) > 1)) { line.status = "shared-port"; line.from = null; line.to = null; }

  const edge = (from, to) => lines.find((line) => line.status === "connected" && line.from === from && line.to === to) ?? null;
  const into = (to) => lines.find((line) => line.status === "connected" && line.to === to) ?? null;
  const P = GH_PORT;

  // Water: classify each connected hose by what it joins.
  for (const line of lines) {
    if (line.type !== "water" || line.status !== "connected") continue;
    const key = `${GH_PORTS[line.from].key}>${GH_PORTS[line.to].key}`;
    if (key === "tank-out>pump-in") line.status = "supply";
    else if (line.from === P["pump-out"] && [P["manifold-in"], P["bed-a-in"], P["bed-b-in"]].includes(line.to)) line.status = "delivery";
    else if ((line.from === P["valve-a-out"] || line.from === P["valve-b-out"]) && (line.to === P["bed-a-in"] || line.to === P["bed-b-in"])) line.status = "branch";
    else if (line.from === P["tank-out"]) line.status = "no-pump";
    else line.status = "loop";
  }
  // Power: solar into the controller, channels out to loads.
  for (const line of lines) {
    if (line.type !== "power" || line.status !== "connected") continue;
    if (line.from === P["solar-out"] && line.to === P["ctrl-solar"]) line.status = "charging";
    else if ((line.from === P["ctrl-ch1"] || line.from === P["ctrl-ch2"]) && (line.to === P["pump-pwr"] || line.to === P["fan-pwr"])) line.status = "feed";
    else if (line.from === P["solar-out"]) line.status = "unregulated";
    else line.status = "loop";
  }

  const supply = Boolean(lines.find((line) => line.status === "supply"));
  const delivery = lines.find((line) => line.status === "delivery") ?? null;
  const viaManifold = delivery?.to === P["manifold-in"];
  const branchTo = (outlet) => lines.find((line) => line.status === "branch" && line.from === outlet)?.to ?? null;
  const bedOf = (port) => (port === P["bed-a-in"] ? "A" : port === P["bed-b-in"] ? "B" : null);
  /** Outlets that lead to a bed: { bed, opening 0..1, port } */
  const outlets = [];
  if (delivery && !viaManifold) outlets.push({ bed: bedOf(delivery.to), opening: 1, from: P["pump-out"] });
  if (delivery && viaManifold) {
    const a = branchTo(P["valve-a-out"]);
    const b = branchTo(P["valve-b-out"]);
    if (a !== null) outlets.push({ bed: bedOf(a), opening: manifold.valveA / 100, from: P["valve-a-out"] });
    if (b !== null) outlets.push({ bed: bedOf(b), opening: manifold.valveB / 100, from: P["valve-b-out"] });
  }
  const solar = Boolean(lines.find((line) => line.status === "charging"));
  const channelOf = (load) => {
    const feed = lines.find((line) => line.status === "feed" && line.to === load);
    return feed ? (feed.from === P["ctrl-ch1"] ? 1 : 2) : null;
  };
  const pumpChannel = channelOf(P["pump-pwr"]);
  const fanChannel = channelOf(P["fan-pwr"]);
  const order = [];
  for (const channel of [1, 2]) {
    if (pumpChannel === channel) order.push("pump");
    if (fanChannel === channel) order.push("fan");
  }

  const faults = [];
  const wrong = lines.filter((line) => ["out-out", "in-in", "wrong-type", "loose", "shared-port", "no-pump", "loop", "unregulated"].includes(line.status));
  for (const line of wrong) faults.push({ kind: line.status, line: line.id });
  if (!supply) faults.push({ kind: "pump-no-supply" });
  if (!delivery) faults.push({ kind: "pump-no-outlet" });
  else if (!outlets.length) faults.push({ kind: "manifold-closed" });
  for (const bed of ["A", "B"]) if (!outlets.some((outlet) => outlet.bed === bed && outlet.opening > 0)) faults.push({ kind: "bed-unwatered", bed });
  if (pumpChannel === null) faults.push({ kind: "pump-unpowered" });
  if (fanChannel === null) faults.push({ kind: "fan-unpowered" });
  if (!solar) faults.push({ kind: "no-solar" });
  if (!probe) faults.push({ kind: "no-probe" });

  return {
    lines,
    supply,
    delivery: delivery?.id ?? null,
    viaManifold,
    outlets,
    solar,
    pumpChannel,
    fanChannel,
    order,
    probe,
    manifold,
    controller,
    faults,
    /** G1 of the brief: water can reach both beds through the powered pump, solar feeds the controller, probe in a bed. */
    complete: supply && outlets.some((o) => o.bed === "A" && o.opening > 0) && outlets.some((o) => o.bed === "B" && o.opening > 0) && pumpChannel !== null && fanChannel !== null && solar && probe !== null,
  };
}

/** The resources at the start of a day. */
export function initialSnapshot(seed) {
  const weather = weatherFor(seed);
  return {
    tick: 0,
    tank: GH_MODEL.tankLitres,
    beds: { A: GH_MODEL.bedStart, B: GH_MODEL.bedStart },
    battery: GH_MODEL.batteryStart,
    // The first air reading (06:00, fan off).
    air: weather.outside[0] + GH_MODEL.greenhouseGain * weather.sun[0],
    totals: { et: 0, drainage: 0, overflow: 0, pumped: 0, solarIn: 0, used: 0, curtailed: 0 },
    stress: { A: 0, B: 0, heat: 0 },
    start: { tank: GH_MODEL.tankLitres, beds: { A: GH_MODEL.bedStart, B: GH_MODEL.bedStart }, battery: GH_MODEL.batteryStart },
  };
}

const clone = (snapshot) => ({
  ...snapshot,
  beds: { ...snapshot.beds },
  totals: { ...snapshot.totals },
  stress: { ...snapshot.stress },
  start: { ...snapshot.start, beds: { ...snapshot.start.beds } },
});

/**
 * One 15-minute step from `snapshot` (at tick k) with the rig `rig`. Returns the next snapshot and
 * the step's record (what the graph and sensors show for that step).
 */
export function stepModel(snapshot, rig, weather) {
  const k = snapshot.tick;
  if (k >= GH_MODEL.steps) return { snapshot, record: null };
  const next = clone(snapshot);
  const dt = GH_MODEL.dtHours;
  const theta = (bed) => snapshot.beds[bed] / GH_MODEL.bedCapacity;

  // Controller: readings at the start of the step.
  const reading = rig.probe ? theta(rig.probe) : null;
  const want = {
    pump: reading !== null && reading * 100 < rig.controller.pumpBelow,
    fan: snapshot.air > rig.controller.fanAbove,
  };
  // Power for the step (Wh).
  const solarIn = rig.solar ? GH_MODEL.solarW * weather.sun[k] * dt : 0;
  let solar = solarIn;
  let battery = snapshot.battery;
  const ran = { pump: false, fan: false };
  const starved = { pump: false, fan: false };
  let used = 0;
  for (const load of rig.order) {
    if (!want[load]) continue;
    const need = (load === "pump" ? GH_MODEL.pumpW : GH_MODEL.fanW) * dt;
    if (need <= solar + battery + 1e-12) {
      const fromSolar = Math.min(solar, need);
      solar -= fromSolar;
      battery = Math.max(0, battery - (need - fromSolar));
      used += need;
      ran[load] = true;
    } else starved[load] = true;
  }
  const room = GH_MODEL.batteryWh - battery;
  const charge = Math.min(room, solar);
  next.battery = battery + charge;
  const curtailed = solar - charge;
  next.totals.solarIn += solarIn;
  next.totals.used += used;
  next.totals.curtailed += curtailed;

  // Water: what the running pump moves (only along a valid supply → outlet path).
  const delivered = { A: 0, B: 0 };
  let pumpState = ran.pump ? "running" : starved.pump ? "starved" : "off";
  if (ran.pump) {
    const open = rig.outlets.reduce((sum, outlet) => sum + outlet.opening, 0);
    if (!rig.supply) pumpState = "dry-no-supply";
    else if (open <= 0) pumpState = "dead-headed";
    else if (snapshot.tank <= 0) pumpState = "dry-tank-empty";
    else {
      const flow = Math.min(GH_MODEL.pumpLitresPerStep * Math.min(1, open), snapshot.tank);
      for (const outlet of rig.outlets) if (outlet.bed && outlet.opening > 0) delivered[outlet.bed] += flow * (outlet.opening / open);
      next.tank = snapshot.tank - flow;
      next.totals.pumped += flow;
      if (flow < GH_MODEL.pumpLitresPerStep * Math.min(1, open) - 1e-12) pumpState = "tank-ran-out";
    }
  }
  const air = weather.outside[k] + GH_MODEL.greenhouseGain * weather.sun[k] - (ran.fan ? GH_MODEL.fanCooling : 0);
  next.air = air;

  const beds = {};
  for (const bed of ["A", "B"]) {
    let water = snapshot.beds[bed] + delivered[bed];
    const fraction = water / GH_MODEL.bedCapacity;
    const et = Math.min(water, Math.max(0, GH_MODEL.uptake[bed] * (0.5 + 0.05 * (air - 20)) * dt * Math.min(1, fraction / 0.4)));
    water -= et;
    let overflow = 0;
    if (water > GH_MODEL.bedCapacity) {
      overflow = water - GH_MODEL.bedCapacity;
      water = GH_MODEL.bedCapacity;
    }
    let drainage = 0;
    if (water > GH_MODEL.drainAbove * GH_MODEL.bedCapacity) {
      drainage = GH_MODEL.drainFraction * (water - GH_MODEL.drainAbove * GH_MODEL.bedCapacity);
      water -= drainage;
    }
    next.beds[bed] = water;
    next.totals.et += et;
    next.totals.overflow += overflow;
    next.totals.drainage += drainage;
    const after = water / GH_MODEL.bedCapacity;
    const stressed = after < GH_MODEL.dryBelow || after > GH_MODEL.wetAbove;
    if (stressed) next.stress[bed] += 1;
    beds[bed] = { water, theta: after, in: delivered[bed], et, drainage, overflow, state: plantState(after, air) };
  }
  if (air > GH_MODEL.heatAbove) next.stress.heat += 1;
  next.tick = k + 1;
  const record = {
    k,
    clock: clockAt(k),
    outside: weather.outside[k],
    sun: weather.sun[k],
    air,
    tank: next.tank,
    battery: next.battery,
    solarW: solarIn / dt,
    loadW: used / dt,
    curtailedWh: curtailed,
    pump: pumpState,
    fan: ran.fan ? "running" : starved.fan ? "starved" : "off",
    reading,
    beds,
  };
  return { snapshot: next, record };
}

/** Advances `snapshot` to `toTick` (bounded by the end of the day) with a constant rig. */
export function simulate(snapshot, rig, seed, toTick) {
  const weather = weatherFor(seed);
  const end = Math.min(GH_MODEL.steps, Math.max(snapshot.tick, toTick));
  let current = snapshot;
  const records = [];
  while (current.tick < end) {
    const { snapshot: next, record } = stepModel(current, rig, weather);
    current = next;
    records.push(record);
  }
  return { snapshot: current, records };
}

export function plantState(theta, air) {
  if (theta < GH_MODEL.severeBelow) return "severe-wilt";
  if (theta < GH_MODEL.dryBelow) return "wilting";
  if (theta > GH_MODEL.wetAbove) return "waterlogged";
  if (air > GH_MODEL.heatAbove) return "heat-stressed";
  return "healthy";
}

/** The two ledgers' residuals (both ~0 by construction; the tests check it). */
export function balance(snapshot) {
  const s = snapshot;
  const water = s.start.tank + s.start.beds.A + s.start.beds.B - (s.tank + s.beds.A + s.beds.B + s.totals.et + s.totals.drainage + s.totals.overflow);
  const energy = s.totals.solarIn + s.start.battery - (s.totals.used + s.battery + s.totals.curtailed);
  return { water, energy };
}

/**
 * The brief's five criteria for a run that reached `snapshot` with the current rig. `finished`:
 * the day is over (the record verdicts are final only then).
 */
export function evaluateBrief(snapshot, rig) {
  const finished = snapshot.tick >= GH_MODEL.steps;
  const hours = (steps) => steps * GH_MODEL.dtHours;
  const criteria = [
    { id: "G1", pass: rig.complete, measured: rig.complete ? "tank → pump → both beds; pump and fan on channels; solar in; probe in a bed" : rigSummaryMissing(rig) },
    { id: "G2", pass: snapshot.stress.A <= GH_MODEL.stressAllowance, measured: `bed A stressed ${hours(snapshot.stress.A)} h` },
    { id: "G3", pass: snapshot.stress.B <= GH_MODEL.stressAllowance, measured: `bed B stressed ${hours(snapshot.stress.B)} h` },
    { id: "G4", pass: snapshot.stress.heat <= GH_MODEL.heatAllowance, measured: `air above ${GH_MODEL.heatAbove} °C for ${hours(snapshot.stress.heat)} h` },
    { id: "G5", pass: snapshot.tank >= GH_MODEL.reserve - 1e-9, measured: `${snapshot.tank.toFixed(1)} L left` },
  ];
  return { finished, met: finished && criteria.every((criterion) => criterion.pass), criteria };
}

function rigSummaryMissing(rig) {
  const missing = [];
  if (!rig.supply) missing.push("no hose from the tank to the pump");
  if (!rig.outlets.some((o) => o.bed === "A" && o.opening > 0)) missing.push("no open path to bed A");
  if (!rig.outlets.some((o) => o.bed === "B" && o.opening > 0)) missing.push("no open path to bed B");
  if (rig.pumpChannel === null) missing.push("pump not on a controller channel");
  if (rig.fanChannel === null) missing.push("fan not on a controller channel");
  if (!rig.solar) missing.push("solar not into the controller");
  if (!rig.probe) missing.push("no soil probe in a bed");
  return missing.join("; ");
}

/** DI worked example (checked by scripts/greenhouse-model-check.mjs to meet the brief on its day). */
export const GH_WORKED_EXAMPLE = Object.freeze({ valveA: 30, valveB: 50, pumpBelow: 60, fanAbove: 26, pumpChannel: 1, probe: "A" });
