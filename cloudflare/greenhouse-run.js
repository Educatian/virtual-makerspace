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
 * The part of a step already elapsed is never thrown away: while running it lives in `anchorAt`
 * (back-dated by that fraction), and a paused or idle run keeps it in `sub` (0 ≤ sub < 1 step),
 * so settling, a speed change, or a pause and resume do not discard elapsed model time.
 *
 * Policies (docs/episodes.md, Episode 3):
 * - pause, step and speed changes settle the model to the current tick on the server first;
 * - reset starts a new run of the day (full tank) with a new run id; the only way to refill;
 * - the room empty → a running day pauses at that tick (no free elapsed time, no refill);
 * - the run ends at tick 96; after a server restart it continues from its anchor by server
 *   time, up to that end.
 */
import { GH_MODEL, endBuildOf, initialSnapshot, simulate, isSeed } from "./greenhouse-model.js";

/** Real milliseconds per model step at speed ×1 (a whole day takes 4 minutes; ×4: 1 minute). */
export const STEP_MS = 2500;
export const SPEEDS = [1, 4];
const STEP_HOURS_TICKS = Math.round(1 / GH_MODEL.dtHours);

export function initialRun(seed = GH_MODEL.briefSeed) {
  return { v: 1, runId: 1, seed, status: "idle", speed: 1, tick: 0, anchorAt: 0, sub: 0, snapshot: initialSnapshot(seed), records: [] };
}

/** The part of the current step already elapsed at `now` (0 ≤ f < 1), in steps. */
function elapsedFraction(run, now) {
  if (run.status !== "running") return run.sub ?? 0;
  const steps = (Math.max(0, now - run.anchorAt) * run.speed) / STEP_MS;
  return steps - Math.floor(steps);
}

/** An anchor time at `now` that keeps `fraction` of a step already elapsed at `speed`. */
const backdated = (now, fraction, speed) => now - (fraction * STEP_MS) / speed;

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

/**
 * Advances the anchor to `toTick` with `rig` (status/anchorAt unchanged). When the day reaches its
 * end, the build it ended with is recorded (`endBuild`: G1 of the verdict), once.
 */
function advance(run, rig, toTick) {
  const { snapshot, records } = simulate(run.snapshot, rig, run.seed, toTick);
  const next = { ...run, tick: snapshot.tick, snapshot, records: [...run.records, ...records.map(compactRecord)] };
  if (snapshot.tick >= GH_MODEL.steps && !run.endBuild) next.endBuild = endBuildOf(rig);
  return next;
}

/**
 * Settles a running day to `now`: a new anchor at the current tick, back-dated by the part of the
 * step already elapsed (so the next step comes exactly when it would have).
 */
export function settle(run, now, rig) {
  if (run.status !== "running") return run;
  const fraction = elapsedFraction(run, now);
  const settled = advance(run, rig, currentTick(run, now));
  if (settled.tick >= GH_MODEL.steps) return { ...settled, status: "ended", anchorAt: now, sub: 0 };
  return { ...settled, anchorAt: backdated(now, fraction, run.speed), sub: 0 };
}

/**
 * A running day whose clock has reached the end (tick 96) but whose anchor was never settled:
 * returns it settled and ended with `rig` — which must be the rig it ran on, i.e. the rig BEFORE
 * any change that the end unlocks — or null when there is nothing to settle. The room calls this
 * before handling anything, so a rig change after the end can never rewrite the finished day
 * (its resources, records and verdict) under the same run id.
 */
export function settleEndedDay(run, now, rig) {
  if (run.status !== "running" || currentTick(run, now) < GH_MODEL.steps) return null;
  return settle(run, now, rig);
}

/**
 * Applies a run action at server time `now` with the rig as built. Returns { ok: true, run } or
 * { ok: false, reason } (the run is unchanged).
 * Actions: { type: "start" } · { type: "pause" } · { type: "resume" } · { type: "step" } (one
 * model hour, while idle or paused) · { type: "speed", speed: 1 | 4 } · { type: "reset", seed? }.
 * Any action may carry `runId`, the run the sender saw: if the room has moved on to another run
 * (a teammate reset the day meanwhile), it is refused as "stale" and changes nothing, so a reset
 * decided on an old view never wipes a newer day, and a pause never lands on the wrong run.
 */
export function reduceGreenhouseRun(run, action, now, rig) {
  const type = action?.type;
  if (action?.runId !== undefined && action.runId !== run.runId) return { ok: false, reason: "stale" };
  if (type === "reset") {
    const seed = action.seed === undefined ? run.seed : action.seed;
    if (!isSeed(seed)) return { ok: false, reason: "invalid" };
    return { ok: true, run: { ...initialRun(seed), runId: run.runId + 1, speed: run.speed } };
  }
  // Settled first, with the rig the day ran on; a refusal below leaves `run` unchanged, so the
  // caller settles an ended day itself (settleEndedDay) before calling this.
  const live = settle(run, now, rig);
  switch (type) {
    case "start":
      if (live.status !== "idle") return { ok: false, reason: live.status === "running" ? "running" : live.status === "ended" ? "ended" : "paused" };
      return { ok: true, run: { ...live, status: "running", anchorAt: backdated(now, live.sub ?? 0, live.speed), sub: 0 } };
    case "resume":
      if (live.status !== "paused") return { ok: false, reason: live.status };
      return { ok: true, run: { ...live, status: "running", anchorAt: backdated(now, live.sub ?? 0, live.speed), sub: 0 } };
    case "pause":
      if (live.status !== "running") return { ok: false, reason: live.status };
      // The part of the step already elapsed is kept for the resume.
      return { ok: true, run: { ...live, status: "paused", anchorAt: now, sub: elapsedFraction(live, now) } };
    case "step": {
      if (live.status !== "idle" && live.status !== "paused") return { ok: false, reason: live.status };
      const stepped = advance(live, rig, live.tick + STEP_HOURS_TICKS);
      const ended = stepped.tick >= GH_MODEL.steps;
      return { ok: true, run: { ...stepped, status: ended ? "ended" : "paused", anchorAt: now, sub: ended ? 0 : live.sub ?? 0 } };
    }
    case "speed": {
      if (!SPEEDS.includes(action.speed)) return { ok: false, reason: "invalid" };
      // The same speed changes nothing (no anchor reset, no lost time).
      if (action.speed === run.speed) return { ok: true, run };
      if (live.status !== "running") return { ok: true, run: { ...live, speed: action.speed } };
      return { ok: true, run: { ...live, speed: action.speed, anchorAt: backdated(now, elapsedFraction(live, now), action.speed) } };
    }
    default:
      return { ok: false, reason: "invalid" };
  }
}

/** The last participant left: a running day pauses where it is (its resources are kept). */
export function onGreenhouseRoomEmpty(run, now, rig) {
  if (run.status !== "running") return null;
  const ended = currentTick(run, now) >= GH_MODEL.steps;
  return { ...settle(run, now, rig), status: ended ? "ended" : "paused", anchorAt: now, sub: ended ? 0 : elapsedFraction(run, now) };
}

/**
 * Same-device peer tabs (no room server) share whole run states stamped with a Lamport clock
 * [counter, participant]. Plain last-writer-wins on the stamp is not enough: a tab that had not
 * yet seen a teammate's reset could step the OLD run with a later stamp and bring it back. The run
 * id is the epoch: a later run always wins over an earlier one, an earlier run never replaces a
 * later one, and only within one run does the later stamp win. A total order, so every tab ends
 * on the same run state whatever the delivery order.
 */
export function peerRunWins(incoming, incomingStamp, current, currentStamp) {
  if (!current) return true;
  if (incoming.runId !== current.runId) return incoming.runId > current.runId;
  if (!currentStamp) return true;
  return incomingStamp[0] > currentStamp[0] || (incomingStamp[0] === currentStamp[0] && incomingStamp[1] > currentStamp[1]);
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
  if (!Number.isInteger(value.tick) || value.tick < 0 || value.tick > GH_MODEL.steps || !finite(value.anchorAt, -1e7, 8.64e15)) return null;
  // The part of a step already elapsed while paused or idle (older stored runs lack it: 0).
  if (value.sub !== undefined && !(typeof value.sub === "number" && value.sub >= 0 && value.sub < 1)) return null;
  if (!finiteSnapshot(value.snapshot) || value.snapshot.tick !== value.tick) return null;
  if (!Array.isArray(value.records) || value.records.length !== value.tick) return null;
  const recordOk = (record, index) => record && record.k === index && finite(record.tank, 0, GH_MODEL.tankLitres) && finite(record.air, -50, 80) && finite(record.battery, 0, GH_MODEL.batteryWh)
    && record.beds && finite(record.beds.A?.theta, 0, 1) && finite(record.beds.B?.theta, 0, 1);
  if (!value.records.every(recordOk)) return null;
  // The build the day ended with (G1), present only once the day has ended (older stored runs may lack it).
  if (value.endBuild !== undefined) {
    const build = value.endBuild;
    if (value.tick !== GH_MODEL.steps || !build || typeof build !== "object" || typeof build.complete !== "boolean" || typeof build.missing !== "string" || build.missing.length > 400) return null;
  }
  return value;
}

/** A run action from a client, validated (null if malformed). */
export function sanitizeGreenhouseAction(value) {
  if (!value || typeof value !== "object") return null;
  if (value.runId !== undefined && (!Number.isSafeInteger(value.runId) || value.runId < 1)) return null;
  const seen = value.runId === undefined ? {} : { runId: value.runId };
  if (["start", "pause", "resume", "step"].includes(value.type)) return { type: value.type, ...seen };
  if (value.type === "speed" && SPEEDS.includes(value.speed)) return { type: "speed", speed: value.speed, ...seen };
  if (value.type === "reset") {
    if (value.seed === undefined) return { type: "reset", ...seen };
    return isSeed(value.seed) ? { type: "reset", seed: value.seed, ...seen } : null;
  }
  return null;
}
