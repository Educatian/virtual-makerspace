/**
 * Validation for everything the room Worker (and the local relay) accepts about the shared
 * bench: part ids, transforms, electrical values, Snapino programs and edit batches. Pure, so
 * scripts/project-state-check.mjs and scripts/sync-check.mjs can test it. Every function
 * returns null for anything outside the schema and never throws on JSON input: values are
 * type-checked, never coerced with Number()/String().
 *
 * `sanitizeProps` mirrors src/circuit/part-props.ts (same bounds and rounding); the check
 * script asserts both agree on a table of inputs.
 */

export const RESISTANCE_RANGE = { min: 10, max: 1_000_000 };
export const VOLTAGE_RANGE = { min: 1, max: 12 };
const RESISTOR_IDS = new Set(["resistor-220", "resistor-1k"]);
const BATTERY_IDS = new Set(["battery-9v"]);

export function propKind(componentId) {
  if (RESISTOR_IDS.has(componentId)) return "resistor";
  if (BATTERY_IDS.has(componentId)) return "battery";
  return null;
}

function roundOhms(value) {
  if (!Number.isFinite(value) || value <= 0) return Number.NaN;
  const step = 10 ** (Math.floor(Math.log10(value)) - 2);
  return Math.round(value / step) * step;
}

export function sanitizeProps(kind, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (kind === "resistor" && typeof raw.ohms === "number" && Number.isFinite(raw.ohms)) {
    const ohms = roundOhms(raw.ohms);
    if (ohms >= RESISTANCE_RANGE.min && ohms <= RESISTANCE_RANGE.max) return { ohms };
  }
  if (kind === "battery" && typeof raw.volts === "number" && Number.isFinite(raw.volts)) {
    const volts = Math.round(raw.volts * 10) / 10;
    if (volts >= VOLTAGE_RANGE.min && volts <= VOLTAGE_RANGE.max) return { volts };
  }
  return null;
}

/** Strict number check: JSON numbers only (no coercion of strings, booleans, null or objects). */
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function finiteTuple(value, limit = 20) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (!value.every((item) => isNumber(item) && Math.abs(item) <= limit)) return null;
  return [value[0], value[1], value[2]];
}

export function sanitizeTransform(value, componentId = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const position = finiteTuple(value.position);
  const rotation = finiteTuple(value.rotation, Math.PI * 16);
  if (!position || !rotation) return null;
  const transform = { position, rotation };
  if (value.sockets === null) transform.sockets = null;
  else if (value.sockets !== undefined) {
    if (!Array.isArray(value.sockets) || value.sockets.length !== 2) return null;
    const sockets = value.sockets.map((socket) => {
      if (socket === null) return null;
      return typeof socket === "number" && Number.isInteger(socket) && socket >= 0 && socket <= 2_000 ? socket : undefined;
    });
    if (sockets.includes(undefined)) return null;
    transform.sockets = sockets;
  }
  if (value.endpoints !== undefined) {
    if (!Array.isArray(value.endpoints) || value.endpoints.length !== 2) return null;
    const endpoints = value.endpoints.map((endpoint) => finiteTuple(endpoint, 20));
    if (endpoints.some((endpoint) => !endpoint)) return null;
    transform.endpoints = endpoints;
  }
  if (value.activeEndpoint !== undefined) {
    if (value.activeEndpoint !== 0 && value.activeEndpoint !== 1) return null;
    transform.activeEndpoint = value.activeEndpoint;
  }
  if (typeof value.on === "boolean") transform.on = value.on;
  if (value.props !== undefined) {
    const props = sanitizeProps(propKind(componentId), value.props);
    // Invalid electrical values are dropped (the part keeps its current value), never relayed.
    if (props) transform.props = props;
  }
  return transform;
}


export const COMPONENT_IDS = new Set([
  "led-red", "led-green", "resistor-220", "resistor-1k", "wire-red", "wire-blue", "wire-yellow", "battery-9v",
  "soil-sensor", "temp-sensor", "light-sensor", "farm-controller", "water-pump", "irrigation-hose", "vent-fan", "solar-panel",
  "snap-b1", "snap-s1", "snap-l1", "snap-m1", "snap-w2", "snap-w3a", "snap-w3b", "snap-w4",
  "sno-l1", "sno-d1", "sno-m1", "sno-s1", "sno-w2a", "sno-w2b", "sno-w3", "sno-w4a", "sno-w4b",
]);

/** A part id, or (with allowEndpoint) one cable end `id::endpoint-0|1`. */
export function componentResource(value, allowEndpoint = true) {
  if (typeof value !== "string" || value.length > 160) return null;
  const match = value.match(/^([a-z0-9-]+)(?:::endpoint-([01]))?$/);
  if (!match || !COMPONENT_IDS.has(match[1]) || (!allowEndpoint && match[2] !== undefined)) return null;
  return value;
}

const SNAPINO_PINS = new Set(["D3", "D5", "D6"]);

export function sanitizeProgram(value) {
  if (!Array.isArray(value) || value.length > 24) return null;
  const program = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (item.op === "write" && SNAPINO_PINS.has(item.pin) && typeof item.value === "boolean") {
      program.push({ op: "write", pin: item.pin, value: item.value });
    } else if (item.op === "wait" && isNumber(item.ms)) {
      program.push({ op: "wait", ms: Math.min(5000, Math.max(50, Math.round(item.ms / 50) * 50)) });
    } else if (item.op === "follow" && SNAPINO_PINS.has(item.pin) && typeof item.invert === "boolean") {
      program.push({ op: "follow", pin: item.pin, invert: item.invert });
    } else {
      return null;
    }
  }
  return program;
}

const isRev = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const MAX_EDIT_CHANGES = COMPONENT_IDS.size;

/**
 * An atomic batch of whole-part changes (value edits, undo/redo, import, reset, return to
 * tray), each with the component revision the sender last saw. A program change may ride along.
 */
export function sanitizeEdit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.opId !== "string" || !/^[\w-]{1,80}$/.test(value.opId)) return null;
  if (!Array.isArray(value.changes) || value.changes.length > MAX_EDIT_CHANGES) return null;
  const seen = new Set();
  const changes = [];
  for (const change of value.changes) {
    if (!change || typeof change !== "object" || Array.isArray(change)) return null;
    const componentId = componentResource(change.componentId, false);
    if (!componentId || seen.has(componentId) || !isRev(change.expectRev)) return null;
    const transform = sanitizeTransform(change.transform, componentId);
    if (!transform || transform.activeEndpoint !== undefined) return null;
    seen.add(componentId);
    changes.push({ componentId, transform, expectRev: change.expectRev });
  }
  let program;
  if (value.program !== undefined) {
    const raw = value.program;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const statements = sanitizeProgram(raw.program);
    // expectRev null: an unconditional upload/stop (ordered by the room, never optimistic).
    if (!statements || typeof raw.running !== "boolean" || (raw.expectRev !== null && !isRev(raw.expectRev))) return null;
    program = { program: statements, running: raw.running, expectRev: raw.expectRev };
  }
  if (!changes.length && !program) return null;
  return { opId: value.opId, changes, ...(program ? { program } : {}) };
}
