/**
 * Resource-Limited Greenhouse (Episode 3): what the room accepts about the greenhouse rig. One
 * source of truth for the room (cloudflare/worker.js, server/collaboration.mjs through
 * sanitize.js and room-core.js) and the client (src/greenhouse/*), so the server validates the
 * same ids, typed ports, value bounds and fixture poses the client draws. Pure and plain JS.
 *
 * The rig (docs/episodes.md, Episode 3): fixed equipment (pump, valve manifold, farm controller,
 * vent fan, solar panel, climate and light sensors), four irrigation hoses, three power cables and
 * one soil probe. A hose or cable is a part whose two `sockets` are port indices (GH_PORTS); the
 * probe's two pins sit in one bed's probe slot. Fixtures never move; the manifold carries its two
 * valve openings and the controller its two rule thresholds (`props`).
 *
 * The room enforces, beyond the generic schema:
 * - fixture transforms keep the fixture pose, carry complete in-range values (never clamped: an
 *   out-of-range value refuses the whole message) and no sockets;
 * - typed ports: a hose's ends go only into water ports, a power cable's only into power ports,
 *   the probe only into a probe slot's two pins (a wrong connector type cannot be stored);
 * - one plug per port across hoses and cables (`greenhousePortConflict`, applied by RoomCore to
 *   live moves and edits against its authoritative, end-merged state).
 * Builds a learner may get wrong on purpose (OUT→OUT, IN→IN, the tank straight to a bed, a pump
 * fed from its own outlet, solar straight to a load) are allowed: the model
 * (cloudflare/greenhouse-model.js) carries nothing through them, draws and names them.
 */

export const GH_FIXTURE_IDS = ["water-pump", "valve-manifold", "farm-controller", "vent-fan", "solar-panel", "temp-sensor", "light-sensor"];
export const GH_HOSE_IDS = ["irrigation-hose", "irrigation-hose-2", "irrigation-hose-3", "irrigation-hose-4"];
export const GH_CABLE_IDS = ["power-cable-1", "power-cable-2", "power-cable-3"];
export const GH_PROBE_ID = "soil-sensor";
export const GH_LINE_IDS = [...GH_HOSE_IDS, ...GH_CABLE_IDS];
export const GH_IDS = [...GH_FIXTURE_IDS, ...GH_LINE_IDS, GH_PROBE_ID];

/**
 * Port index → where it is, which way it faces and which connector it takes. `role` "out" ports
 * feed, "in" ports receive. The index is what a hose's or cable's `sockets` hold.
 */
export const GH_PORTS = [
  { index: 0, key: "tank-out", module: "tank", role: "out", type: "water", label: "TANK OUT" },
  { index: 1, key: "pump-in", module: "water-pump", role: "in", type: "water", label: "PUMP IN" },
  { index: 2, key: "pump-out", module: "water-pump", role: "out", type: "water", label: "PUMP OUT" },
  { index: 3, key: "manifold-in", module: "valve-manifold", role: "in", type: "water", label: "MANIFOLD IN" },
  { index: 4, key: "valve-a-out", module: "valve-manifold", role: "out", type: "water", label: "VALVE A OUT" },
  { index: 5, key: "valve-b-out", module: "valve-manifold", role: "out", type: "water", label: "VALVE B OUT" },
  { index: 6, key: "bed-a-in", module: "bed-a", role: "in", type: "water", label: "BED A INLET" },
  { index: 7, key: "bed-b-in", module: "bed-b", role: "in", type: "water", label: "BED B INLET" },
  { index: 8, key: "solar-out", module: "solar-panel", role: "out", type: "power", label: "SOLAR OUT" },
  { index: 9, key: "ctrl-solar", module: "farm-controller", role: "in", type: "power", label: "CONTROLLER SOLAR IN" },
  { index: 10, key: "ctrl-ch1", module: "farm-controller", role: "out", type: "power", label: "CONTROLLER CH1" },
  { index: 11, key: "ctrl-ch2", module: "farm-controller", role: "out", type: "power", label: "CONTROLLER CH2" },
  { index: 12, key: "pump-pwr", module: "water-pump", role: "in", type: "power", label: "PUMP 12 V IN" },
  { index: 13, key: "fan-pwr", module: "vent-fan", role: "in", type: "power", label: "FAN 12 V IN" },
  { index: 14, key: "bed-a-probe-1", module: "bed-a", role: "in", type: "probe", label: "BED A PROBE SLOT" },
  { index: 15, key: "bed-a-probe-2", module: "bed-a", role: "in", type: "probe", label: "BED A PROBE SLOT" },
  { index: 16, key: "bed-b-probe-1", module: "bed-b", role: "in", type: "probe", label: "BED B PROBE SLOT" },
  { index: 17, key: "bed-b-probe-2", module: "bed-b", role: "in", type: "probe", label: "BED B PROBE SLOT" },
];
export const GH_PORT = Object.fromEntries(GH_PORTS.map((port) => [port.key, port.index]));
/** The probe's two pins seat as one of these pairs (either order). */
export const GH_PROBE_SLOTS = { A: [14, 15], B: [16, 17] };

/** Knob ranges (inclusive) and steps. Values outside, or off the step, are refused, not clamped. */
export const GH_BOUNDS = {
  valveA: { min: 0, max: 100, step: 5 },
  valveB: { min: 0, max: 100, step: 5 },
  pumpBelow: { min: 10, max: 90, step: 5 },
  fanAbove: { min: 20, max: 40, step: 1 },
};
export const GH_DEFAULT_PROPS = {
  "valve-manifold": { valveA: 100, valveB: 100 },
  "farm-controller": { pumpBelow: 50, fanAbove: 30 },
};

/** Fixture poses (world position of each fixture's origin; rotation always 0). */
export const GH_FIXTURE_POSES = {
  "water-pump": [-1.4, 0, 1.98],
  "valve-manifold": [0.25, 0, 1.98],
  "farm-controller": [2.05, 0, 1.98],
  "vent-fan": [1.02, 0, -0.62],
  "solar-panel": [3.55, 0, 0.82],
  "temp-sensor": [-0.25, 0, -1.72],
  "light-sensor": [-2.45, 0, -1.72],
};

const POSE_TOLERANCE = 1e-3;
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isGreenhouseId = (componentId) => GH_IDS.includes(componentId);
export const isGreenhouseFixture = (componentId) => GH_FIXTURE_IDS.includes(componentId);
export const isGreenhouseHose = (componentId) => GH_HOSE_IDS.includes(componentId);
export const isGreenhouseCable = (componentId) => GH_CABLE_IDS.includes(componentId);
/** Hoses and power cables: the parts whose ends go into one-plug ports. */
export const isGreenhouseLine = (componentId) => GH_LINE_IDS.includes(componentId);

/** Which value set a fixture carries: "manifold", "controller", or null. */
export function greenhousePropKind(componentId) {
  if (componentId === "valve-manifold") return "manifold";
  if (componentId === "farm-controller") return "controller";
  return null;
}

/** The port type a line's ends take: "water" (hoses) or "power" (cables); null for other ids. */
export function lineType(componentId) {
  if (isGreenhouseHose(componentId)) return "water";
  if (isGreenhouseCable(componentId)) return "power";
  return null;
}

const onStep = (value, bound) => isNumber(value) && value >= bound.min && value <= bound.max && Math.abs((value - bound.min) / bound.step - Math.round((value - bound.min) / bound.step)) < 1e-9;

/** Complete, in-range, on-step values for a fixture's kind, or null (the message is refused). */
export function sanitizeGreenhouseProps(kind, raw) {
  if (!isObject(raw)) return null;
  if (kind === "manifold") {
    if (!onStep(raw.valveA, GH_BOUNDS.valveA) || !onStep(raw.valveB, GH_BOUNDS.valveB)) return null;
    return { valveA: Math.round(raw.valveA), valveB: Math.round(raw.valveB) };
  }
  if (kind === "controller") {
    if (!onStep(raw.pumpBelow, GH_BOUNDS.pumpBelow) || !onStep(raw.fanAbove, GH_BOUNDS.fanAbove)) return null;
    return { pumpBelow: Math.round(raw.pumpBelow), fanAbove: Math.round(raw.fanAbove) };
  }
  return null;
}

const near = (a, b) => Math.abs(a - b) <= POSE_TOLERANCE;
const portOk = (socket, type) => socket === null || (Number.isInteger(socket) && socket >= 0 && socket < GH_PORTS.length && GH_PORTS[socket].type === type);

/**
 * Greenhouse-specific checks on a transform the generic schema already accepted (`clean`), with
 * the raw input for its `props`. Returns the transform to keep, or null to refuse the message.
 */
export function sanitizeGreenhouseTransform(componentId, raw, clean) {
  if (isGreenhouseFixture(componentId)) {
    const pose = GH_FIXTURE_POSES[componentId];
    if (!clean.position.every((value, index) => near(value, pose[index]))) return null;
    if (!clean.rotation.every((value) => near(value, 0))) return null;
    if ((clean.sockets !== undefined && clean.sockets !== null) || clean.endpoints !== undefined || clean.activeEndpoint !== undefined) return null;
    if (raw.on !== undefined) return null;
    const kind = greenhousePropKind(componentId);
    const next = { position: [...pose], rotation: [0, 0, 0], sockets: null };
    if (raw.props !== undefined) {
      const props = kind ? sanitizeGreenhouseProps(kind, raw.props) : null;
      if (!props) return null;
      next.props = props;
    }
    return next;
  }
  if (isGreenhouseLine(componentId)) {
    if (raw.props !== undefined || raw.on !== undefined) return null;
    const type = lineType(componentId);
    const sockets = clean.sockets;
    if (Array.isArray(sockets)) {
      if (!sockets.every((socket) => portOk(socket, type))) return null;
      if (sockets[0] !== null && sockets[0] === sockets[1]) return null;
    }
    return clean;
  }
  if (componentId === GH_PROBE_ID) {
    if (raw.props !== undefined || raw.on !== undefined || clean.endpoints !== undefined || clean.activeEndpoint !== undefined) return null;
    const sockets = clean.sockets;
    if (Array.isArray(sockets)) {
      const pair = [...sockets].sort((a, b) => a - b);
      const slot = Object.values(GH_PROBE_SLOTS).some(([a, b]) => pair[0] === a && pair[1] === b);
      if (!slot) return null;
    }
    return clean;
  }
  return clean;
}

/**
 * One plug per port: the first port `componentId`'s next sockets share with another line (or
 * both of its own ends in one port, reported with `line` = itself), as `{ port, line }`, or null.
 * `socketsOf(id)` gives each other line's sockets as they would be (the room's state, overlaid
 * with the same batch's changes). Probe slots are separate (only the probe uses them).
 */
export function greenhousePortConflict(componentId, sockets, socketsOf) {
  if (!isGreenhouseLine(componentId) || !sockets) return null;
  if (sockets[0] !== null && sockets[0] !== undefined && sockets[0] === sockets[1]) return { port: sockets[0], line: componentId };
  for (const port of sockets) {
    if (port === null || port === undefined) continue;
    for (const other of GH_LINE_IDS) {
      if (other === componentId) continue;
      const theirs = socketsOf(other);
      if (Array.isArray(theirs) && (theirs[0] === port || theirs[1] === port)) return { port, line: other };
    }
  }
  return null;
}

/** The probe's bed ("A" or "B") from its sockets, or null when it is not seated in a slot. */
export function probeBed(sockets) {
  if (!Array.isArray(sockets) || sockets[0] === null || sockets[1] === null) return null;
  const pair = [...sockets].sort((a, b) => a - b);
  for (const [bed, [a, b]] of Object.entries(GH_PROBE_SLOTS)) if (pair[0] === a && pair[1] === b) return bed;
  return null;
}
