/**
 * Sound Flow Studio (Episode 2): what the room accepts about the patch desk. One source of truth
 * for the room (cloudflare/worker.js, server/collaboration.mjs through sanitize.js and
 * room-core.js) and the client (src/sound/*), so the server validates the same ids, jacks, value
 * bounds and fixture poses the client draws. Pure and plain JS (the Node check scripts import it).
 *
 * The desk: four fixed modules (Source, Filter, Drive, Speaker) and three patch cables. A cable
 * is a part whose two `sockets` are jack indices (SOUND_JACKS). Modules never move; their
 * transform carries their knob values (`props`) and, for the Speaker, its power switch (`on`).
 *
 * The room enforces, beyond the generic schema:
 * - module transforms keep the fixture pose (no moving a module), carry complete in-range values
 *   (never clamped: an out-of-range value refuses the whole message) and no sockets;
 * - cable sockets are jack indices 0..5 (or null), the two ends never in the same jack;
 * - one plug per jack across all cables (`soundJackConflict`, applied by RoomCore to live moves
 *   and edits against its authoritative state).
 * Patches a learner may get wrong on purpose (OUT→OUT, IN→IN, feedback loops) are allowed: the
 * model (src/sound/sound-model.ts) draws and diagnoses them instead.
 */

export const SOUND_MODULE_IDS = ["snd-source", "snd-filter", "snd-drive", "snd-speaker"];
export const SOUND_CABLE_IDS = ["snd-cable-a", "snd-cable-b", "snd-cable-c"];
export const SOUND_IDS = [...SOUND_MODULE_IDS, ...SOUND_CABLE_IDS];

/** Jack index → module and direction. The index is what a cable's `sockets` hold. */
export const SOUND_JACKS = [
  { index: 0, module: "snd-source", port: "out" },
  { index: 1, module: "snd-filter", port: "in" },
  { index: 2, module: "snd-filter", port: "out" },
  { index: 3, module: "snd-drive", port: "in" },
  { index: 4, module: "snd-drive", port: "out" },
  { index: 5, module: "snd-speaker", port: "in" },
];

export const SOUND_WAVES = ["sine", "square", "sawtooth"];

/** Knob ranges (inclusive). Values outside are refused, not clamped. */
export const SOUND_BOUNDS = {
  hz: { min: 55, max: 1760 },
  cutoff: { min: 80, max: 8000 },
  gain: { min: 0, max: 4 },
};

export const SOUND_DEFAULT_PROPS = {
  "snd-source": { hz: 440, wave: "sine" },
  "snd-filter": { cutoff: 2000 },
  "snd-drive": { gain: 1 },
};
export const SOUND_SPEAKER_DEFAULT_ON = true;

/** Fixture poses (world position of each module's origin on the table; rotation always 0). */
export const SOUND_MODULE_POSES = {
  "snd-source": [-3.7, 0, -0.2],
  "snd-filter": [-2.16, 0, -0.2],
  "snd-drive": [-0.62, 0, -0.2],
  "snd-speaker": [1.1, 0, -0.2],
};

const POSE_TOLERANCE = 1e-3;
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

export function isSoundId(componentId) {
  return SOUND_IDS.includes(componentId);
}

export function isSoundModule(componentId) {
  return SOUND_MODULE_IDS.includes(componentId);
}

export function isSoundCable(componentId) {
  return SOUND_CABLE_IDS.includes(componentId);
}

/** "source" | "filter" | "drive" for modules with knobs, else null. */
export function soundPropKind(componentId) {
  if (componentId === "snd-source") return "source";
  if (componentId === "snd-filter") return "filter";
  if (componentId === "snd-drive") return "drive";
  return null;
}

const inRange = (value, bounds) => value >= bounds.min && value <= bounds.max;

/**
 * Complete, in-range knob values for `kind`, rounded as the knobs step (Hz to 1 Hz, gain to
 * 0.01), or null. Unknown keys are dropped; a missing or out-of-range value is null (refused).
 */
export function sanitizeSoundProps(kind, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (kind === "source") {
    if (!isNumber(raw.hz) || typeof raw.wave !== "string" || !SOUND_WAVES.includes(raw.wave)) return null;
    const hz = Math.round(raw.hz);
    return inRange(hz, SOUND_BOUNDS.hz) ? { hz, wave: raw.wave } : null;
  }
  if (kind === "filter") {
    if (!isNumber(raw.cutoff)) return null;
    const cutoff = Math.round(raw.cutoff);
    return inRange(cutoff, SOUND_BOUNDS.cutoff) ? { cutoff } : null;
  }
  if (kind === "drive") {
    if (!isNumber(raw.gain)) return null;
    const gain = Math.round(raw.gain * 100) / 100;
    return inRange(gain, SOUND_BOUNDS.gain) ? { gain } : null;
  }
  return null;
}

const near = (a, b) => Math.abs(a - b) <= POSE_TOLERANCE;

/**
 * Sound-specific checks on a transform the generic schema already accepted (`clean`), with the
 * raw input for its `props`. Returns the transform to keep, or null to refuse the message.
 */
export function sanitizeSoundTransform(componentId, raw, clean) {
  if (isSoundModule(componentId)) {
    const pose = SOUND_MODULE_POSES[componentId];
    if (!clean.position.every((value, index) => near(value, pose[index]))) return null;
    if (!clean.rotation.every((value) => near(value, 0))) return null;
    if ((clean.sockets !== undefined && clean.sockets !== null) || clean.endpoints !== undefined || clean.activeEndpoint !== undefined) return null;
    const kind = soundPropKind(componentId);
    const next = { position: [...pose], rotation: [0, 0, 0], sockets: null };
    if (raw.props !== undefined) {
      const props = kind ? sanitizeSoundProps(kind, raw.props) : null;
      if (!props) return null;
      next.props = props;
    }
    if (clean.on !== undefined) {
      if (componentId !== "snd-speaker") return null;
      next.on = clean.on;
    } else if (raw.on !== undefined) return null;
    return next;
  }
  if (isSoundCable(componentId)) {
    if (raw.props !== undefined || raw.on !== undefined) return null;
    const sockets = clean.sockets;
    if (Array.isArray(sockets)) {
      if (!sockets.every((socket) => socket === null || (socket >= 0 && socket < SOUND_JACKS.length))) return null;
      if (sockets[0] !== null && sockets[0] === sockets[1]) return null;
    }
    return clean;
  }
  return clean;
}

/**
 * The cable's sockets once `transform` is stored over `previous` (mirrors RoomCore.store: a
 * cable-end move changes only that end).
 */
export function nextCableSockets(previous, transform) {
  const end = transform.activeEndpoint;
  if ((end === 0 || end === 1) && previous?.endpoints && transform.endpoints) {
    const base = Array.isArray(previous.sockets) ? [previous.sockets[0], previous.sockets[1]] : [null, null];
    base[end] = transform.sockets?.[end] ?? null;
    return base;
  }
  return Array.isArray(transform.sockets) ? [transform.sockets[0], transform.sockets[1]] : [null, null];
}

/**
 * One plug per jack: the first jack `componentId`'s next sockets share with another cable, as
 * `{ jack, cable }`, or null. `socketsOf(id)` gives each other cable's sockets as they would be
 * (the room's state, overlaid with the same batch's changes).
 */
export function soundJackConflict(componentId, sockets, socketsOf) {
  if (!isSoundCable(componentId) || !sockets) return null;
  for (const jack of sockets) {
    if (jack === null || jack === undefined) continue;
    for (const other of SOUND_CABLE_IDS) {
      if (other === componentId) continue;
      const theirs = socketsOf(other);
      if (Array.isArray(theirs) && (theirs[0] === jack || theirs[1] === jack)) return { jack, cable: other };
    }
  }
  return null;
}
