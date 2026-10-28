/**
 * Resource-Limited Greenhouse (Episode 3): the room's run state — model time and resources — and
 * the actions that change it. Pure (no sockets or storage); RoomCore applies it in arrival order
 * and persists the result. Same-device peer rooms apply it in each tab with their shared clock.
 *
 * The run state is an ANCHOR: the resource snapshot at `tick`, taken at server time `anchorAt`,
 * plus the per-step record up to that tick. While running, the current tick at server time t is
 *   tick + floor((t − anchorAt) · speed / STEP_MS), at most 96,
 * and the current resources are `simulate(snapshot, rig, seed, that tick)` with the rig as built
 * (the rig cannot change while running: the room refuses rig edits then). Every client computes
 * the same values from the same anchor, so nothing depends on frame rate.
 *
 * Policies (docs/episodes.md, Episode 3):
 * - pause, step and speed changes settle the model to the current tick on the server first;
 * - reset starts a new run of the day (full tank) with a new run id; the only way to refill;
 * - the room empty → a running day pauses at that tick (no free elapsed time, no refill);
 * - the run ends at tick 96; after a server restart it continues from its anchor by server
 *   time, up to that end.
 */
import { GH_MODEL, initialSnapshot, simulate, isSeed } from "./greenhouse-model.js";

/** Real milliseconds per model step at speed ×1 (a whole day takes 4 minutes; ×4: 1 minute). */
export const STEP_MS = 2500;
export const SPEEDS = [1, 4];
const STEP_HOURS_TICKS = Math.round(1 / GH_MODEL.dtHours);

export function initialRun(seed = GH_MODEL.briefSeed) {
  return { v: 1, runId: 1, seed, status: "idle", speed: 1, tick: 0, anchorAt: 0, snapshot: initialSnapshot(seed), records: [] };
}

/** The tick the run is at, at server time `now`. */
export function currentTick(run, now) {
  if (run.status !== "running") return run.tick;
  const elapsed = Math.max(0, now - run.anchorAt);
  return Math.min(GH_MODEL.steps, run.tick + Math.floor((elapsed * run.speed) / STEP_MS));
}

/** Record digits kept in the room (display only; the snapshot keeps full precision). */
const round = (value) => Math.round(value * 1000) / 1000;
export function compactRecord(record) {
  return {
    k: record.k,
    air: round(record.air),
    outside: round(record.outside),
    sun: round(record.sun),
    tank: round(record.tank),
    battery: round(record.battery),
    solarW: round(record.solarW),
    loadW: round(record.loadW),
    pump: record.pump,
    fan: record.fan,
    reading: record.reading === null ? null : round(record.reading),
    beds: Object.fromEntries(Object.entries(record.beds).map(([bed, value]) => [bed, { theta: round(value.theta), in: round(value.in), et: round(value.et), drainage: round(value.drainage + value.overflow), state: value.state }])),
  };
}

/** Advances the anchor to `toTick` with `rig` (status/anchorAt unchanged). */
function advance(run, rig, toTick) {
  const { snapshot, records } = simulate(run.snapshot, rig, run.seed, toTick);
  return { ...run, tick: snapshot.tick, snapshot, records: [...run.records, ...records.map(compactRecord)] };
}

/** Settles a running day to `now` (a new anchor at the current tick, at `now`). */
export function settle(run, now, rig) {
  if (run.status !== "running") return run;
  const settled = advance(run, rig, currentTick(run, now));
  if (settled.tick >= GH_MODEL.steps) return { ...settled, status: "ended", anchorAt: now };
  return { ...settled, anchorAt: now };
}

/**
 * Applies a run action at server time `now` with the rig as built. Returns { ok: true, run } or
 * { ok: false, reason } (the run is unchanged).
 * Actions: { type: "start" } · { type: "pause" } · { type: "resume" } · { type: "step" } (one
 * model hour, while idle or paused) · { type: "speed", speed: 1 | 4 } · { type: "reset", seed? }.
 */
export function reduceGreenhouseRun(run, action, now, rig) {
  const type = action?.type;
  if (type === "reset") {
    const seed = action.seed === undefined ? run.seed : action.seed;
    if (!isSeed(seed)) return { ok: false, reason: "invalid" };
    return { ok: true, run: { ...initialRun(seed), runId: run.runId + 1, speed: run.speed } };
  }
  const live = settle(run, now, rig);
  switch (type) {
    case "start":
      if (live.status !== "idle") return { ok: false, reason: live.status === "running" ? "running" : live.status === "ended" ? "ended" : "paused" };
      return { ok: true, run: { ...live, status: "running", anchorAt: now } };
    case "resume":
      if (live.status !== "paused") return { ok: false, reason: live.status };
      return { ok: true, run: { ...live, status: "running", anchorAt: now } };
    case "pause":
      if (live.status !== "running") return { ok: false, reason: live.status };
      return { ok: true, run: { ...live, status: "paused", anchorAt: now } };
    case "step": {
      if (live.status !== "idle" && live.status !== "paused") return { ok: false, reason: live.status };
      const stepped = advance(live, rig, live.tick + STEP_HOURS_TICKS);
      return { ok: true, run: { ...stepped, status: stepped.tick >= GH_MODEL.steps ? "ended" : "paused", anchorAt: now } };
    }
    case "speed":
      if (!SPEEDS.includes(action.speed)) return { ok: false, reason: "invalid" };
      return { ok: true, run: { ...live, speed: action.speed, anchorAt: now } };
    default:
      return { ok: false, reason: "invalid" };
  }
}

/** The last participant left: a running day pauses where it is (its resources are kept). */
export function onGreenhouseRoomEmpty(run, now, rig) {
  if (run.status !== "running") return null;
  return { ...settle(run, now, rig), status: run.status === "running" && currentTick(run, now) >= GH_MODEL.steps ? "ended" : "paused", anchorAt: now };
}

/** Whether rig edits are refused now (a day is running). */
export const rigLocked = (run, now) => run.status === "running" && currentTick(run, now) < GH_MODEL.steps;

const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const finiteSnapshot = (s) => s && typeof s === "object"
  && Number.isInteger(s.tick) && s.tick >= 0 && s.tick <= GH_MODEL.steps
  && finite(s.tank, 0, GH_MODEL.tankLitres) && finite(s.battery, 0, GH_MODEL.batteryWh) && finite(s.air, -50, 80)
  && s.beds && finite(s.beds.A, 0, GH_MODEL.bedCapacity) && finite(s.beds.B, 0, GH_MODEL.bedCapacity)
  && s.totals && ["et", "drainage", "overflow", "pumped", "solarIn", "used", "curtailed"].every((key) => finite(s.totals[key], 0, 1e6))
  && s.stress && ["A", "B", "heat"].every((key) => Number.isInteger(s.stress[key]) && s.stress[key] >= 0 && s.stress[key] <= GH_MODEL.steps)
  && s.start && finite(s.start.tank, 0, GH_MODEL.tankLitres) && finite(s.start.battery, 0, GH_MODEL.batteryWh) && s.start.beds && finite(s.start.beds.A, 0, GH_MODEL.bedCapacity) && finite(s.start.beds.B, 0, GH_MODEL.bedCapacity);

/** A stored or received run state, validated (null if not one). */
export function sanitizeGreenhouseRun(value) {
  if (!value || typeof value !== "object" || value.v !== 1) return null;
  if (!Number.isSafeInteger(value.runId) || value.runId < 1 || !isSeed(value.seed)) return null;
  if (!["idle", "running", "paused", "ended"].includes(value.status) || !SPEEDS.includes(value.speed)) return null;
  if (!Number.isInteger(value.tick) || value.tick < 0 || value.tick > GH_MODEL.steps || !finite(value.anchorAt, 0, 8.64e15)) return null;
  if (!finiteSnapshot(value.snapshot) || value.snapshot.tick !== value.tick) return null;
  if (!Array.isArray(value.records) || value.records.length !== value.tick) return null;
  const recordOk = (record, index) => record && record.k === index && finite(record.tank, 0, GH_MODEL.tankLitres) && finite(record.air, -50, 80) && finite(record.battery, 0, GH_MODEL.batteryWh)
    && record.beds && finite(record.beds.A?.theta, 0, 1) && finite(record.beds.B?.theta, 0, 1);
  if (!value.records.every(recordOk)) return null;
  return value;
}

/** A run action from a client, validated (null if malformed). */
export function sanitizeGreenhouseAction(value) {
  if (!value || typeof value !== "object") return null;
  if (["start", "pause", "resume", "step"].includes(value.type)) return { type: value.type };
  if (value.type === "speed" && SPEEDS.includes(value.speed)) return { type: "speed", speed: value.speed };
  if (value.type === "reset") {
    if (value.seed === undefined) return { type: "reset" };
    return isSeed(value.seed) ? { type: "reset", seed: value.seed } : null;
  }
  return null;
}
