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
 */
import { SOLVER_VERSION } from "../circuit/dc-engine.ts";
import { sanitizeProps, type PartProps, type PropKind } from "../circuit/part-props.ts";
import type { SharedTransform, StudioChoice } from "./collaboration.js";
import { sanitizeProgram, type SnapinoStatement } from "./snapino.ts";

export const PROJECT_FORMAT = "virtual-makerspace.project";
export const PROJECT_VERSION = 1;
export const MAX_PROJECT_BYTES = 64 * 1024;
const STUDIOS: readonly StudioChoice[] = ["circuit", "greenhouse", "snap", "snapino"];

export interface ProjectPart {
  id: string;
  sockets: [number, number] | null;
  props?: PartProps;
  on?: boolean;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  /** DC solver that produced any readings the learner saw; informative only. */
  solver: string;
  studio: StudioChoice;
  savedAt: string;
  parts: ProjectPart[];
  /** The program uploaded to the room (Snapino only). */
  program?: SnapinoStatement[];
  /** Unsaved edits in the exporter's code editor, if they differ from `program`. */
  draftProgram?: SnapinoStatement[];
}

/** What the importing scene accepts for a studio. */
export interface StudioCatalog {
  studio: StudioChoice;
  /** Part id → electrical kind (for props) or null. */
  parts: Record<string, PropKind | null>;
  socketCount: number;
  /** Parts that carry a slide-switch state. */
  switches?: readonly string[];
  /**
   * Snap-style bases: parts stack on shared studs (a wire and a lamp on the same stud), so a
   * socket may be used by more than one part. Breadboard holes take one lead each.
   */
  sharedSockets?: boolean;
}

export function buildProject(
  catalog: StudioCatalog,
  transforms: Record<string, SharedTransform>,
  program?: readonly SnapinoStatement[] | null,
  now = new Date(),
  draftProgram?: readonly SnapinoStatement[] | null,
): ProjectFile {
  const parts: ProjectPart[] = [];
  for (const [id, kind] of Object.entries(catalog.parts)) {
    const transform = transforms[id];
    const sockets = transform?.sockets;
    const seated = Array.isArray(sockets) && Number.isInteger(sockets[0]) && Number.isInteger(sockets[1]);
    const part: ProjectPart = { id, sockets: seated ? [sockets[0] as number, sockets[1] as number] : null };
    const props = kind ? sanitizeProps(kind, transform?.props) : null;
    if (props) part.props = props;
    if (catalog.switches?.includes(id) && typeof transform?.on === "boolean") part.on = transform.on;
    parts.push(part);
  }
  const project: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    solver: SOLVER_VERSION,
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
  return project;
}

export type ParseResult = { ok: true; project: ProjectFile } | { ok: false; error: string };

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
  if (input.version !== PROJECT_VERSION) {
    // Only a plain number is echoed back; anything else (strings, objects) is not.
    const shown = typeof input.version === "number" && Number.isFinite(input.version) ? ` ${String(input.version).slice(0, 12)}` : "";
    return { ok: false, error: `Project version${shown} is not supported (expected ${PROJECT_VERSION}).` };
  }
  if (!STUDIOS.includes(input.studio as StudioChoice)) return { ok: false, error: "The project names an unknown studio." };
  const studio = input.studio as StudioChoice;
  const catalog = catalogFor(studio);
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
      const sockets = item.sockets;
      if (!Array.isArray(sockets) || sockets.length !== 2) return { ok: false, error: `${id} has malformed sockets.` };
      const [a, b] = sockets;
      const valid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < catalog.socketCount;
      if (!valid(a) || !valid(b) || a === b) return { ok: false, error: `${id} uses a socket that does not exist.` };
      if (!catalog.sharedSockets && (usedSockets.has(a) || usedSockets.has(b))) return { ok: false, error: `${id} shares a hole with another part.` };
      usedSockets.add(a);
      usedSockets.add(b);
      part.sockets = [a, b];
    }
    const kind = catalog.parts[id];
    if (item.props !== undefined) {
      const props = kind ? sanitizeProps(kind, item.props) : null;
      if (!props) return { ok: false, error: `${id} has an electrical value outside the allowed range.` };
      part.props = props;
    }
    if (item.on !== undefined) {
      if (typeof item.on !== "boolean" || !catalog.switches?.includes(id)) return { ok: false, error: `${id} has an invalid switch state.` };
      part.on = item.on;
    }
    parts.push(part);
  }
  const project: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
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
  return { ok: true, project };
}

/**
 * True only for a bench with nothing worth recovering: no part seated, every electrical value
 * at its default, no slide switch on, and no program or draft. Edited values on parts left in
 * the tray (e.g. a resistor set to 470 Ω) are NOT empty.
 */
export function isDefaultProject(project: ProjectFile, defaultsFor: (id: string) => PartProps | null): boolean {
  if (project.program?.length || project.draftProgram?.length) return false;
  return project.parts.every((part) => {
    if (part.sockets) return false;
    if (part.on === true) return false;
    if (!part.props) return true;
    const defaults = defaultsFor(part.id);
    return (part.props.ohms ?? null) === (defaults?.ohms ?? null) && (part.props.volts ?? null) === (defaults?.volts ?? null);
  });
}

export function projectFileName(project: ProjectFile): string {
  const stamp = project.savedAt.slice(0, 16).replace(/[:T]/g, "-");
  return `makerspace-${project.studio}-${stamp}.json`;
}
