/**
 * Versioned, validated project files (export/import and local recovery).
 *
 * A project file holds only what defines a build: which socket pair each part sits in, its
 * electrical values, a slide switch's state, and (on the Snapino studio) the block program.
 * It never holds participant ids, names, chat, traces, recordings or tokens. Positions are not
 * stored: the importing scene recomputes them from the sockets, so a file cannot place parts
 * anywhere the board would not.
 *
 * `parseProject` treats its input as hostile: size-capped, strict schema (no type coercion:
 * values must already be numbers, booleans or strings), unknown fields dropped, only catalog
 * part ids, in-range socket ids, sanitized values and programs. It never throws — any input,
 * including objects with hostile `toString`/`valueOf`, yields `{ ok: false, error }`.
 * Nothing from a file is ever rendered as HTML.
 *
 * Snapino projects distinguish the program the room is running (`program`, what an import
 * shares) from an unsaved editor draft (`draftProgram`, loaded only into the importer's own
 * editor).
 *
 * Versions: the four original studios write and read version 1, unchanged, so older apps and
 * older files keep working. Sound Flow Studio projects (Episode 2) are version 2: their parts
 * carry knob values (`hz`/`wave`, `cutoff`, `gain`), the Speaker's switch and patch cables'
 * jacks. A version-1 file naming the sound studio, or a version-2 file naming another studio,
 * is refused. Fixture modules never carry sockets.
 *
 * Resource-Limited Greenhouse projects (Episode 3) are version 3: the equipment's values (valve
 * openings, rule thresholds), each hose's and power cable's two ports (either end may be out,
 * `null`), and the soil probe's slot. Ports are typed (a hose only in water couplers, a cable only
 * in power sockets, the probe only in a bed's probe slot) and take one line each. A project never
 * carries the day's run: model time, tank, beds, battery and records stay in the room, so an
 * import can never refill the tank or add elapsed time. A version-1 greenhouse file (the earlier
 * placeholder rig, whose generic terminals do not map onto the typed ports) is MIGRATED to the
 * default rig: equipment at default values, every line and the probe out, with a notice.
 */
import { SOLVER_VERSION } from "../circuit/dc-engine.ts";
import { sanitizeProps, type PartProps, type PropKind } from "../circuit/part-props.ts";
import { sanitizeSoundProps, type SoundPropKind, type SoundProps } from "../../cloudflare/sound-rules.js";
import { GH_PORTS, GH_PROBE_ID, isGreenhouseFixture, isGreenhouseLine, lineType, probeBed, sanitizeGreenhouseProps, type GhPropKind, type GhProps } from "../../cloudflare/greenhouse-rules.js";
import type { SharedTransform, StudioChoice } from "./collaboration.js";
import { sanitizeProgram, type SnapinoStatement } from "./snapino.ts";
import { isMission, isWord, MAX_WORDS, MISSIONS, type Word } from "../episodes/rescue-signal.ts";

/** Sound projects carry no DC readings: their stamp names the signal model instead. */
export const SOUND_MODEL_VERSION = "sound-flow-signal-1";

/** Episode 1's design in a Snapino project: the mission and the sender's intended words. */
export interface ProjectEpisode {
  id: "rescue-signal";
  v: 1;
  mission: string;
  intent: Word[];
}

export const PROJECT_FORMAT = "virtual-makerspace.project";
/** The version the original four studios write (and older apps read). */
export const PROJECT_VERSION = 1;
/** Sound Flow Studio projects. */
export const SOUND_PROJECT_VERSION = 2;
/** Resource-Limited Greenhouse projects. */
export const GREENHOUSE_PROJECT_VERSION = 3;
/** Greenhouse projects carry no run: their stamp names the water/energy model the rig was built for. */
export const GREENHOUSE_MODEL_VERSION = "greenhouse-water-energy-1";
export const MAX_PROJECT_BYTES = 64 * 1024;
const STUDIOS: readonly StudioChoice[] = ["circuit", "greenhouse", "snap", "snapino", "sound"];
type ProjectVersion = 1 | 2 | 3;
const versionFor = (studio: StudioChoice): ProjectVersion => (studio === "sound" ? SOUND_PROJECT_VERSION : studio === "greenhouse" ? GREENHOUSE_PROJECT_VERSION : PROJECT_VERSION);
const stampFor = (studio: StudioChoice): string => (studio === "sound" ? SOUND_MODEL_VERSION : studio === "greenhouse" ? GREENHOUSE_MODEL_VERSION : SOLVER_VERSION);

export type PartKind = PropKind | SoundPropKind | GhPropKind;
export type AnyPartProps = PartProps & SoundProps & GhProps;

/** Values for any kind family (Circuit Bench parts, Sound modules, greenhouse equipment), or null. */
export function sanitizePartProps(kind: PartKind | null | undefined, raw: unknown): AnyPartProps | null {
  if (!kind) return null;
  if (kind === "manifold" || kind === "controller") return sanitizeGreenhouseProps(kind, raw) as AnyPartProps | null;
  return kind === "resistor" || kind === "battery" ? sanitizeProps(kind, raw) : sanitizeSoundProps(kind, raw);
}

export interface ProjectPart {
  id: string;
  /** Two sockets; greenhouse hoses and cables may have one end out (`null`). */
  sockets: [number, number] | [number | null, number | null] | null;
  props?: AnyPartProps;
  on?: boolean;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: ProjectVersion;
  /** The model behind any readings the learner saw (the DC solver, the Sound Flow signal model, the greenhouse model); informative only. */
  solver: string;
  studio: StudioChoice;
  savedAt: string;
  parts: ProjectPart[];
  /** The program uploaded to the room (Snapino only). */
  program?: SnapinoStatement[];
  /** Unsaved edits in the exporter's code editor, if they differ from `program`. */
  draftProgram?: SnapinoStatement[];
  /**
   * Rescue Signal Workshop design (Snapino only): mission and intended words. Rounds,
   * readings and explanations are session activity and are never exported.
   */
  episode?: ProjectEpisode;
}

/** What the importing scene accepts for a studio. */
export interface StudioCatalog {
  studio: StudioChoice;
  /** Part id → value kind (for props) or null. */
  parts: Record<string, PartKind | null>;
  socketCount: number;
  /** Parts that carry a slide-switch state. */
  switches?: readonly string[];
  /**
   * Snap-style bases: parts stack on shared studs (a wire and a lamp on the same stud), so a
   * socket may be used by more than one part. Breadboard holes take one lead each.
   */
  sharedSockets?: boolean;
  /** Parts that are fixtures (never seated in sockets), e.g. the Sound desk's modules. */
  fixtures?: readonly string[];
}

export function buildProject(
  catalog: StudioCatalog,
  transforms: Record<string, SharedTransform>,
  program?: readonly SnapinoStatement[] | null,
  now = new Date(),
  draftProgram?: readonly SnapinoStatement[] | null,
  episode?: { mission: string; intent: readonly Word[] } | null,
): ProjectFile {
  const parts: ProjectPart[] = [];
  for (const [id, kind] of Object.entries(catalog.parts)) {
    const transform = transforms[id];
    const sockets = transform?.sockets;
    const seated = Array.isArray(sockets) && Number.isInteger(sockets[0]) && Number.isInteger(sockets[1]);
    const part: ProjectPart = { id, sockets: seated ? [sockets[0] as number, sockets[1] as number] : null };
    if (catalog.studio === "greenhouse" && isGreenhouseLine(id) && Array.isArray(sockets) && !seated) {
      const one = (value: unknown): number | null => (Number.isInteger(value) ? value as number : null);
      const half: [number | null, number | null] = [one(sockets[0]), one(sockets[1])];
      if (half[0] !== null || half[1] !== null) part.sockets = half;
    }
    const props = sanitizePartProps(kind, transform?.props);
    if (props) part.props = props;
    if (catalog.fixtures?.includes(id)) part.sockets = null;
    if (catalog.switches?.includes(id) && typeof transform?.on === "boolean") part.on = transform.on;
    parts.push(part);
  }
  const project: ProjectFile = {
    format: PROJECT_FORMAT,
    version: versionFor(catalog.studio),
    solver: stampFor(catalog.studio),
    studio: catalog.studio,
    savedAt: now.toISOString(),
    parts,
  };
  if (catalog.studio === "snapino" && program) {
    const clean = sanitizeProgram(program);
    if (clean) project.program = clean;
  }
  if (catalog.studio === "snapino" && draftProgram) {
    const clean = sanitizeProgram(draftProgram);
    if (clean && JSON.stringify(clean) !== JSON.stringify(project.program ?? [])) project.draftProgram = clean;
  }
  if (catalog.studio === "snapino" && episode && isMission(episode.mission) && episode.intent.length <= MAX_WORDS && episode.intent.every(isWord)) {
    project.episode = { id: "rescue-signal", v: 1, mission: episode.mission, intent: [...episode.intent] };
  }
  return project;
}

/** `notice`: the file was read under an older format and migrated (shown to the importer). */
export type ParseResult = { ok: true; project: ProjectFile; notice?: string } | { ok: false; error: string };

export function parseProject(text: unknown, catalogFor: (studio: StudioChoice) => StudioCatalog | null): ParseResult {
  try {
    return parseUnsafe(text, catalogFor);
  } catch {
    // Defense in depth: a validation bug must refuse the file, never crash the bench.
    return { ok: false, error: "The file is not a valid workbench project." };
  }
}

function parseUnsafe(text: unknown, catalogFor: (studio: StudioChoice) => StudioCatalog | null): ParseResult {
  if (typeof text !== "string") return { ok: false, error: "The file could not be read as text." };
  if (text.length > MAX_PROJECT_BYTES || new TextEncoder().encode(text).length > MAX_PROJECT_BYTES) return { ok: false, error: "The file is larger than 64 KB, so it is not a workbench project." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file is not valid JSON." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The file is not a workbench project." };
  const input = raw as Record<string, unknown>;
  if (input.format !== PROJECT_FORMAT) return { ok: false, error: "The file is not a Virtual Makerspace project." };
  if (input.version !== PROJECT_VERSION && input.version !== SOUND_PROJECT_VERSION && input.version !== GREENHOUSE_PROJECT_VERSION) {
    // Only a plain number is echoed back; anything else (strings, objects) is not.
    const shown = typeof input.version === "number" && Number.isFinite(input.version) ? ` ${String(input.version).slice(0, 12)}` : "";
    return { ok: false, error: `Project version${shown} is not supported (expected ${PROJECT_VERSION}, ${SOUND_PROJECT_VERSION} for Sound Flow Studio or ${GREENHOUSE_PROJECT_VERSION} for the greenhouse).` };
  }
  if (!STUDIOS.includes(input.studio as StudioChoice)) return { ok: false, error: "The project names an unknown studio." };
  const studio = input.studio as StudioChoice;
  const catalog = catalogFor(studio);
  if (studio === "greenhouse" && input.version === PROJECT_VERSION) {
    // The earlier placeholder greenhouse: migrate to the default rig (nothing of its layout maps).
    if (!catalog) return { ok: false, error: "That studio cannot be imported here." };
    if (!Array.isArray(input.parts) || input.parts.length > 16) return { ok: false, error: "The part list is missing or too long." };
    return {
      ok: true,
      project: { format: PROJECT_FORMAT, version: GREENHOUSE_PROJECT_VERSION, solver: GREENHOUSE_MODEL_VERSION, studio, savedAt: new Date(0).toISOString(), parts: Object.keys(catalog.parts).map((id) => ({ id, sockets: null })) },
      notice: "This is an earlier greenhouse file (version 1). Its layout does not fit the typed water and power ports, so it loads as the default rig: everything unplugged, valves and rules at their defaults.",
    };
  }
  if (input.version !== versionFor(studio)) {
    const named = studio === "sound" ? ": Sound Flow Studio projects are version 2" : studio === "greenhouse" ? ": greenhouse projects are version 3" : "";
    return { ok: false, error: `Project version ${String(input.version)} is not supported for this studio (expected ${versionFor(studio)}${named}).` };
  }
  if (!catalog) return { ok: false, error: "That studio cannot be imported here." };
  if (!Array.isArray(input.parts) || input.parts.length > Object.keys(catalog.parts).length) {
    return { ok: false, error: "The part list is missing or too long." };
  }
  const seen = new Set<string>();
  const usedSockets = new Set<number>();
  const parts: ProjectPart[] = [];
  for (const entry of input.parts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, error: "A part entry is malformed." };
    const item = entry as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(catalog.parts, id)) {
      return { ok: false, error: "The project contains a part this studio does not have." };
    }
    if (seen.has(id)) return { ok: false, error: "A part appears twice in the project." };
    seen.add(id);
    const part: ProjectPart = { id, sockets: null };
    if (item.sockets !== null && item.sockets !== undefined) {
      if (catalog.fixtures?.includes(id)) return { ok: false, error: `${id} is fixed to the desk and cannot be placed in sockets.` };
      const sockets = item.sockets;
      if (!Array.isArray(sockets) || sockets.length !== 2) return { ok: false, error: `${id} has malformed sockets.` };
      const [a, b] = sockets;
      const valid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < catalog.socketCount;
      if (studio === "greenhouse") {
        const checked = greenhouseSockets(id, a, b, valid, usedSockets);
        if (typeof checked === "string") return { ok: false, error: checked };
        part.sockets = checked;
        for (const socket of checked) if (socket !== null) usedSockets.add(socket);
        const kind = catalog.parts[id];
        if (item.props !== undefined) {
          const props = sanitizePartProps(kind, item.props);
          if (!props) return { ok: false, error: `${id} has a value outside the allowed range (or off its step).` };
          part.props = props;
        }
        if (item.on !== undefined) return { ok: false, error: `${id} has an invalid switch state.` };
        parts.push(part);
        continue;
      }
      if (!valid(a) || !valid(b) || a === b) return { ok: false, error: `${id} uses a socket that does not exist.` };
      if (!catalog.sharedSockets && (usedSockets.has(a) || usedSockets.has(b))) return { ok: false, error: studio === "sound" ? `${id} shares a jack with another cable (one plug per jack).` : `${id} shares a hole with another part.` };
      usedSockets.add(a);
      usedSockets.add(b);
      part.sockets = [a, b];
    }
    const kind = catalog.parts[id];
    if (item.props !== undefined) {
      const props = sanitizePartProps(kind, item.props);
      if (!props) return { ok: false, error: `${id} has ${studio === "sound" ? "a knob" : studio === "greenhouse" ? "a" : "an electrical"} value outside the allowed range${studio === "greenhouse" ? " (or off its step)" : ""}.` };
      part.props = props;
    }
    if (item.on !== undefined) {
      if (typeof item.on !== "boolean" || !catalog.switches?.includes(id)) return { ok: false, error: `${id} has an invalid switch state.` };
      part.on = item.on;
    }
    parts.push(part);
  }
  if (studio === "greenhouse" && input.run !== undefined) return { ok: false, error: "Greenhouse projects never carry a run (model time and resources stay in the room)." };
  const project: ProjectFile = {
    format: PROJECT_FORMAT,
    version: versionFor(studio),
    solver: typeof input.solver === "string" ? input.solver.slice(0, 40).replace(/[^\w.-]/g, "") : "unknown",
    studio,
    savedAt: typeof input.savedAt === "string" && input.savedAt.length <= 40 && Number.isFinite(Date.parse(input.savedAt)) ? new Date(Date.parse(input.savedAt)).toISOString() : new Date(0).toISOString(),
    parts,
  };
  if (input.program !== undefined) {
    if (studio !== "snapino") return { ok: false, error: "Only Snapino projects carry a program." };
    const program = sanitizeProgram(input.program);
    if (!program) return { ok: false, error: "The Snapino program is invalid." };
    project.program = program;
  }
  if (input.draftProgram !== undefined) {
    if (studio !== "snapino") return { ok: false, error: "Only Snapino projects carry a program." };
    const draft = sanitizeProgram(input.draftProgram);
    if (!draft) return { ok: false, error: "The unsaved Snapino draft is invalid." };
    project.draftProgram = draft;
  }
  if (input.episode !== undefined) {
    if (studio !== "snapino") return { ok: false, error: "Only Snapino projects carry a Rescue Signal design." };
    const raw = input.episode as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.id !== "rescue-signal" || raw.v !== 1) return { ok: false, error: "The Rescue Signal design is not a supported version." };
    if (!isMission(raw.mission)) return { ok: false, error: "The Rescue Signal design names an unknown mission." };
    if (!Array.isArray(raw.intent) || raw.intent.length > MAX_WORDS || !raw.intent.every(isWord)) return { ok: false, error: "The Rescue Signal design uses words outside the protocol." };
    project.episode = { id: "rescue-signal", v: 1, mission: raw.mission, intent: [...(raw.intent as Word[])] };
  }
  return { ok: true, project };
}

/**
 * True only for a bench with nothing worth recovering: no part seated, every electrical value
 * at its default, no slide switch on, and no program or draft. Edited values on parts left in
 * the tray (e.g. a resistor set to 470 Ω) are NOT empty.
 */
export function isDefaultProject(project: ProjectFile, defaultsFor: (id: string) => AnyPartProps | null, defaultOn: (id: string) => boolean = () => false): boolean {
  if (project.program?.length || project.draftProgram?.length) return false;
  if (project.episode && (project.episode.intent.length > 0 || project.episode.mission !== MISSIONS[0].id)) return false;
  return project.parts.every((part) => {
    if (part.sockets) return false;
    if (part.on !== undefined && part.on !== defaultOn(part.id)) return false;
    if (!part.props) return true;
    const defaults = defaultsFor(part.id) ?? {};
    const keys = new Set([...Object.keys(part.props), ...Object.keys(defaults)]) as Set<keyof AnyPartProps>;
    return [...keys].every((key) => (part.props?.[key] ?? null) === (defaults[key] ?? null));
  });
}

export function projectFileName(project: ProjectFile): string {
  const stamp = project.savedAt.slice(0, 16).replace(/[:T]/g, "-");
  return `makerspace-${project.studio}-${stamp}.json`;
}

/**
 * A greenhouse part's sockets from a file: typed ports, one line per port, the probe only as a
 * bed slot's pin pair, fixtures never. Returns the sockets, or the reason the file is refused.
 */
function greenhouseSockets(id: string, a: unknown, b: unknown, valid: (value: unknown) => value is number, used: Set<number>): [number | null, number | null] | string {
  if (isGreenhouseFixture(id)) return `${id} is fixed in the greenhouse and cannot be placed in ports.`;
  if (id === GH_PROBE_ID) {
    if (!valid(a) || !valid(b) || !probeBed([a, b])) return "The soil probe can only sit in one bed's probe slot.";
    return [a, b];
  }
  if (!isGreenhouseLine(id)) return "The project contains a part this studio does not have.";
  const ends = [a, b].map((value) => (value === null ? null : value)) as [unknown, unknown];
  if (ends.every((value) => value === null)) return [null, null];
  const type = lineType(id);
  for (const end of ends) {
    if (end === null) continue;
    if (!valid(end)) return `${id} uses a port that does not exist.`;
    if (GH_PORTS[end].type !== type) return `${id} is a ${type === "water" ? "hose" : "power cable"} and cannot go into ${GH_PORTS[end].label}.`;
    if (used.has(end)) return `${id} shares ${GH_PORTS[end].label} with another line (one line per port).`;
  }
  if (ends[0] !== null && ends[0] === ends[1]) return `${id} has both ends in one port.`;
  return [ends[0] as number | null, ends[1] as number | null];
}
