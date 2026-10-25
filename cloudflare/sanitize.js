/**
 * Validation for workbench transforms relayed by the room Worker (transform + late-join
 * state-response). Kept in its own module so scripts/project-state-check.mjs can test it.
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

function finiteTuple(value, limit = 20) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const tuple = value.map(Number);
  if (tuple.some((item) => !Number.isFinite(item) || Math.abs(item) > limit)) return null;
  return tuple;
}

export function sanitizeTransform(value, componentId = "") {
  if (!value || typeof value !== "object") return null;
  const position = finiteTuple(value.position);
  const rotation = finiteTuple(value.rotation, Math.PI * 16);
  if (!position || !rotation) return null;
  const transform = { position, rotation };
  if (value.sockets === null) transform.sockets = null;
  else if (value.sockets !== undefined) {
    if (!Array.isArray(value.sockets) || value.sockets.length !== 2) return null;
    const sockets = value.sockets.map((socket) => {
      if (socket === null) return null;
      const index = Number(socket);
      return Number.isInteger(index) && index >= 0 && index <= 2_000 ? index : undefined;
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

