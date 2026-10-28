/**
 * Breadboard → netlist adapter: the single electrical model for every Circuit Bench view.
 *
 * Board topology (desktop: 16 columns × 12 rows; XR: N columns, `rowsPerHalf` rows per half):
 * the first and last rows are power rails (each one net along its whole length); the rows in
 * between connect vertically within a column, split into two halves by the center trench.
 * A part's lead A (sockets[0]) is a battery's + terminal and an LED's anode.
 */
import {
  solveCircuit,
  SOLVER_VERSION,
  type CircuitElement,
  type Diagnostic,
  type LedColor,
  type SolveResult,
} from "./dc-engine.ts";
import type { PartProps } from "./part-props.ts";

export interface BoardGeometry {
  cols: number;
  rowsPerHalf: number;
}
export const DESKTOP_BOARD: BoardGeometry = { cols: 16, rowsPerHalf: 5 };

export const socketCount = (geometry: BoardGeometry = DESKTOP_BOARD): number => geometry.cols * (2 + 2 * geometry.rowsPerHalf);

/** The breadboard net a socket belongs to, or null for a socket id that does not exist. */
export function socketNet(socket: unknown, geometry: BoardGeometry = DESKTOP_BOARD): number | null {
  if (typeof socket !== "number" || !Number.isInteger(socket) || socket < 0 || socket >= socketCount(geometry)) return null;
  const totalRows = 2 + 2 * geometry.rowsPerHalf;
  const row = Math.floor(socket / geometry.cols);
  const col = socket % geometry.cols;
  if (row === 0) return 0;
  if (row === totalRows - 1) return 1;
  if (row <= geometry.rowsPerHalf) return 2 + col;
  return 2 + geometry.cols + col;
}

export type BoardPartKind = "led" | "resistor" | "wire" | "battery";

export interface BoardPart {
  id: string;
  kind: BoardPartKind;
  /** [lead A, lead B]; null or a null entry = not (fully) in the board. */
  sockets: readonly (number | null | undefined)[] | null | undefined;
  /** Nominal value: ohms for a resistor, volts for a battery. */
  ohms?: number;
  volts?: number;
  color?: LedColor;
  /** Name used in diagnostics, e.g. "The red LED". */
  label?: string;
}

export interface BoardNetlist {
  elements: CircuitElement[];
  /** Fully seated parts that entered the simulation. */
  placed: string[];
  /** Parts with only one lead in the board. */
  partial: string[];
  diagnostics: Diagnostic[];
}

const netNode = (net: number): string => `n${net}`;

export function buildBoardNetlist(parts: readonly BoardPart[], geometry: BoardGeometry = DESKTOP_BOARD): BoardNetlist {
  const elements: CircuitElement[] = [];
  const placed: string[] = [];
  const partial: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const part of parts) {
    const sockets = part.sockets;
    if (!sockets) continue;
    const [a, b] = [sockets[0], sockets[1]];
    if ((a === null || a === undefined) && (b === null || b === undefined)) continue;
    if (a === null || a === undefined || b === null || b === undefined) {
      partial.push(part.id);
      continue;
    }
    const netA = socketNet(a, geometry);
    const netB = socketNet(b, geometry);
    if (netA === null || netB === null || a === b) {
      diagnostics.push({
        code: "invalid-input",
        severity: "error",
        elementId: part.id,
        message: a === b
          ? `${part.id} has both leads in the same hole (${a}); it is left out of the simulation.`
          : `${part.id} reports socket ${netA === null ? a : b} that does not exist on this board; it is left out of the simulation.`,
      });
      continue;
    }
    const [nodeA, nodeB] = [netNode(netA), netNode(netB)];
    const label = part.label;
    placed.push(part.id);
    switch (part.kind) {
      case "battery":
        elements.push({ kind: "source", id: part.id, label, pos: nodeA, neg: nodeB, volts: part.volts ?? 9 });
        break;
      case "resistor":
        elements.push({ kind: "resistor", id: part.id, label, a: nodeA, b: nodeB, ohms: part.ohms ?? Number.NaN });
        break;
      case "wire":
        elements.push({ kind: "wire", id: part.id, label, a: nodeA, b: nodeB });
        break;
      case "led":
        elements.push({ kind: "led", id: part.id, label, anode: nodeA, cathode: nodeB, color: part.color ?? "red" });
        break;
    }
  }
  return { elements, placed, partial, diagnostics };
}

export interface BoardAnalysis {
  solver: typeof SOLVER_VERSION;
  result: SolveResult;
  placed: string[];
  partial: string[];
  diagnostics: Diagnostic[];
  /** LEDs giving off light at all (including overdriven ones). */
  glowingLeds: string[];
  /** LEDs lit within their rating. */
  safeLitLeds: string[];
  /** LEDs above their rating but not yet burnt out. */
  overdrivenLeds: string[];
  /** LEDs that would burn out (no current limiting). */
  burntLeds: string[];
  reversedLeds: string[];
  /** Reversed LEDs with more than their maximum reverse voltage (about 5 V) across them. */
  reverseStressedLeds: string[];
  short: boolean;
  /** The task succeeds only with a safely lit LED and no error anywhere. */
  success: boolean;
  /** Net voltage relative to the battery's − terminal, by breadboard net id; null = floating. */
  netVolts: Map<number, number | null>;
}

export function analyzeBoard(parts: readonly BoardPart[], geometry: BoardGeometry = DESKTOP_BOARD): BoardAnalysis {
  const netlist = buildBoardNetlist(parts, geometry);
  const result = solveCircuit({ elements: netlist.elements });
  const diagnostics = [...netlist.diagnostics, ...result.diagnostics];
  const leds = netlist.elements.filter((element) => element.kind === "led").map((element) => element.id);
  const ledState = (id: string) => result.elements[id]?.led?.state;
  const glowingLeds = leds.filter((id) => result.elements[id]?.led?.on);
  const safeLitLeds = leds.filter((id) => ledState(id) === "lit");
  const overdrivenLeds = leds.filter((id) => ledState(id) === "overcurrent");
  const burntLeds = leds.filter((id) => ledState(id) === "burnout");
  const reversedLeds = leds.filter((id) => ledState(id) === "reverse");
  const reverseStressedLeds = result.diagnostics.filter((d) => d.code === "led-reverse-overvoltage" && d.elementId).map((d) => d.elementId as string);
  const short = result.status === "short-circuit";
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const netVolts = new Map<number, number | null>();
  for (const [node, volts] of Object.entries(result.nodeVolts)) {
    if (node.startsWith("n")) netVolts.set(Number(node.slice(1)), volts);
  }
  return {
    solver: SOLVER_VERSION,
    result,
    placed: netlist.placed,
    partial: netlist.partial,
    diagnostics,
    glowingLeds,
    safeLitLeds,
    overdrivenLeds,
    burntLeds,
    reversedLeds,
    reverseStressedLeds,
    short,
    success: result.solved && !hasError && safeLitLeds.length > 0 && overdrivenLeds.length === 0,
    netVolts,
  };
}

/** Desktop Circuit Bench part catalog: id → electrical kind and nominal values. */
export const DESKTOP_PARTS: Record<string, Omit<BoardPart, "sockets" | "id">> = {
  "battery-9v": { kind: "battery", volts: 9, label: "The battery" },
  "led-red": { kind: "led", color: "red", label: "The red LED" },
  "led-green": { kind: "led", color: "green", label: "The green LED" },
  "resistor-220": { kind: "resistor", ohms: 220, label: "Resistor A" },
  "resistor-1k": { kind: "resistor", ohms: 1000, label: "Resistor B" },
  "wire-red": { kind: "wire", label: "The red jumper" },
  "wire-blue": { kind: "wire", label: "The blue jumper" },
  "wire-yellow": { kind: "wire", label: "The yellow jumper" },
};

/** Builds board parts from desktop placements plus any edited properties. Unknown ids are skipped. */
export function desktopBoardParts(
  placements: Record<string, readonly (number | null | undefined)[] | null | undefined>,
  props: Record<string, PartProps | null | undefined> = {},
): BoardPart[] {
  const parts: BoardPart[] = [];
  for (const [id, catalog] of Object.entries(DESKTOP_PARTS)) {
    const edited = props[id] ?? {};
    parts.push({
      id,
      ...catalog,
      ...(catalog.kind === "resistor" && edited.ohms !== undefined ? { ohms: edited.ohms } : {}),
      ...(catalog.kind === "battery" && edited.volts !== undefined ? { volts: edited.volts } : {}),
      sockets: placements[id] ?? null,
    });
  }
  return parts;
}
