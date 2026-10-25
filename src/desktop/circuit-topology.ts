/**
 * Circuit Bench topology and analysis, shared by the scene, Bolt (the AI teammate) and tests.
 *
 * Electrical truth comes from the shared DC engine (src/circuit): this module adds the
 * layout reasoning Bolt talks about (which parts share a strip, which sit side by side in a
 * row). Rows 0 and 11 are power rails, rows 1–5 and 6–10 connect vertically within each column
 * (split by the center trench). Lead A (sockets[0]) is a battery's + and an LED's anode.
 * Kept free of DOM and three.js so it runs under `node --experimental-strip-types`.
 */
import { analyzeBoard, desktopBoardParts, socketNet, type BoardAnalysis } from "../circuit/breadboard.ts";
import type { PartProps } from "../circuit/part-props.ts";

export const BREADBOARD_COLS = 16;
export const BREADBOARD_ROWS = 12;

export type SocketPair = [number, number];
/** Component id → the two sockets its leads sit in, or null when off the board. */
export type CircuitPlacements = Record<string, SocketPair | null | undefined>;
export type CircuitProps = Record<string, PartProps | null | undefined>;

export const CIRCUIT_PARTS = {
  battery: "battery-9v",
  leds: ["led-red", "led-green"],
  resistors: ["resistor-220", "resistor-1k"],
  wires: ["wire-red", "wire-blue", "wire-yellow"],
} as const;

export function socketIndex(row: number, col: number): number {
  return row * BREADBOARD_COLS + col;
}

export function socketRowCol(index: number): { row: number; col: number } {
  return { row: Math.floor(index / BREADBOARD_COLS), col: index % BREADBOARD_COLS };
}

/** Net id for a valid socket; −1 for an id that is not on the board. */
export function socketToNet(index: number): number {
  return socketNet(index) ?? -1;
}

function isWire(id: string): boolean {
  return (CIRCUIT_PARTS.wires as readonly string[]).includes(id);
}

function isResistor(id: string): boolean {
  return (CIRCUIT_PARTS.resistors as readonly string[]).includes(id);
}

function isLed(id: string): boolean {
  return (CIRCUIT_PARTS.leds as readonly string[]).includes(id);
}

function isPlaced(pair: SocketPair | null | undefined): pair is SocketPair {
  return Boolean(pair && socketNet(pair[0]) !== null && socketNet(pair[1]) !== null);
}

export interface CircuitAnalysis {
  /** Parts with both leads in sockets. */
  placed: string[];
  batteryPlaced: boolean;
  resistorPlaced: boolean;
  /** LEDs giving off any light (including overdriven ones). */
  litLeds: string[];
  /** Success: an LED lit within its rating, nothing shorted or overdriven. */
  powered: boolean;
  /** LEDs carrying more than their rated current (overdriven or burning out). */
  unsafeLeds: string[];
  /** LEDs with nothing limiting their current: they would burn out. */
  unprotectedLeds: string[];
  /** LEDs that glow but above their 20 mA rating (resistor too small for the supply). */
  overdrivenLeds: string[];
  reversedLeds: string[];
  short: boolean;
  /** Current through each placed LED (A). */
  ledAmps: Record<string, number>;
  /** A resistor carries the LED's current (it is in series in a working loop). */
  resistorInSeries: boolean;
  /** Some other part touches each battery terminal's column strip or rail. */
  bothBatteryTerminalsUsed: boolean;
  /** Parts joined by a shared column strip while sitting in different rows. */
  columnBridges: Array<[string, string]>;
  /** Parts whose leads sit side by side in one row, in different (unconnected) strips. */
  rowNeighbors: Array<[string, string]>;
  /** The full engine analysis (voltages, currents, diagnostics, solver version). */
  board: BoardAnalysis;
}

export function analyzeCircuit(placements: CircuitPlacements, props: CircuitProps = {}): CircuitAnalysis {
  const placedEntries = Object.entries(placements).filter(
    (entry): entry is [string, SocketPair] => isPlaced(entry[1]),
  );
  const placed = placedEntries.map(([id]) => id);
  const board = analyzeBoard(desktopBoardParts(placements, props));
  const ledAmps: Record<string, number> = {};
  for (const id of CIRCUIT_PARTS.leds) {
    const reading = board.result.elements[id];
    if (reading) ledAmps[id] = reading.amps;
  }
  const loopAmps = Math.max(0, ...Object.values(ledAmps));
  const resistorInSeries = loopAmps > 1e-4 && CIRCUIT_PARTS.resistors.some((id) => {
    const reading = board.result.elements[id];
    return Boolean(reading && Math.abs(Math.abs(reading.amps) - loopAmps) < loopAmps * 0.05);
  });

  const battery = placements[CIRCUIT_PARTS.battery];
  let bothBatteryTerminalsUsed = false;
  if (isPlaced(battery)) {
    const touches = (terminal: number): boolean =>
      placedEntries.some(([id, pair]) =>
        id !== CIRCUIT_PARTS.battery &&
        pair.some((socket) => socketToNet(socket) === socketToNet(terminal)),
      );
    bothBatteryTerminalsUsed = touches(battery[0]) && touches(battery[1]);
  }

  const columnBridges: Array<[string, string]> = [];
  const rowNeighbors: Array<[string, string]> = [];
  for (let i = 0; i < placedEntries.length; i += 1) {
    for (let j = i + 1; j < placedEntries.length; j += 1) {
      const [idA, pairA] = placedEntries[i];
      const [idB, pairB] = placedEntries[j];
      let bridged = false;
      let neighbors = false;
      for (const a of pairA) {
        for (const b of pairB) {
          const posA = socketRowCol(a);
          const posB = socketRowCol(b);
          const sameNet = socketToNet(a) === socketToNet(b);
          if (sameNet && posA.row !== posB.row && posA.col === posB.col) bridged = true;
          if (!sameNet && posA.row === posB.row && Math.abs(posA.col - posB.col) === 1) neighbors = true;
        }
      }
      if (bridged) columnBridges.push([idA, idB]);
      if (neighbors) rowNeighbors.push([idA, idB]);
    }
  }

  return {
    placed,
    batteryPlaced: isPlaced(battery),
    resistorPlaced: placed.some(isResistor),
    litLeds: board.glowingLeds,
    powered: board.success,
    unsafeLeds: [...board.overdrivenLeds, ...board.burntLeds],
    unprotectedLeds: board.burntLeds,
    overdrivenLeds: board.overdrivenLeds,
    reversedLeds: board.reversedLeds,
    short: board.short,
    ledAmps,
    resistorInSeries,
    bothBatteryTerminalsUsed,
    columnBridges,
    rowNeighbors,
    board,
  };
}

/** What the builder believes about each idea; false means it still holds the naive idea. */
export interface LayoutBeliefs {
  /** Holes connect in vertical column strips (naive: holes in a row are connected). */
  strips: boolean;
  /** Current needs a complete loop back to the battery (naive: one side is enough). */
  loop: boolean;
  /** A series resistor protects the LED (naive: the LED can sit straight on the battery). */
  resistor: boolean;
}

export interface PlannedPart {
  id: string;
  sockets: SocketPair;
}

function wireForSpan(span: number): string {
  if (span <= WIRE_MAX_SPAN["wire-red"]) return "wire-red";
  if (span <= WIRE_MAX_SPAN["wire-blue"]) return "wire-blue";
  return "wire-yellow";
}

/** Longest span, in columns, each jumper wire can bridge (scene snaps up to 1.86 × its length). */
export const WIRE_MAX_SPAN: Record<string, number> = { "wire-red": 3, "wire-blue": 7, "wire-yellow": 11 };

/**
 * The layout a builder would produce from its beliefs, in the order it places parts.
 * Spans match each part's natural lead spacing (battery 2, resistor 3, LED 1 column).
 * Only a builder that holds all three ideas produces a safe, lit circuit: without the
 * resistor the LED sits straight across 9 V and the engine reports it burning out. Parts go in the
 * board corner nearest the default camera (high rows and columns), with the tall battery
 * furthest back, so the result is easy to see and nothing hides behind it.
 */
export function planCircuitLayout(beliefs: LayoutBeliefs): PlannedPart[] {
  const chain: Array<{ id: string; span: number }> = [{ id: CIRCUIT_PARTS.battery, span: 2 }];
  // 1 kΩ: at 9 V the LED gets about 7 mA, inside its 20 mA rating. (A 220 Ω resistor would
  // give about 30 mA — 9 V minus the LED's ~2 V, over 220 Ω — which overdrives the LED.)
  if (beliefs.resistor) chain.push({ id: "resistor-1k", span: 3 });
  chain.push({ id: "led-red", span: 1 });
  const plan: PlannedPart[] = [];

  if (beliefs.strips) {
    // Each part starts in the column where the previous one ended, one row nearer.
    const startCol = 8;
    let row = 7;
    let col = startCol;
    for (const part of chain) {
      // The battery goes in + last, so the chain continues from its + terminal and every LED
      // meets the current anode first (lead A is a battery's + and an LED's anode).
      const from = socketIndex(row, col);
      const to = socketIndex(row, col + part.span);
      plan.push({ id: part.id, sockets: part.id === CIRCUIT_PARTS.battery ? [to, from] : [from, to] });
      col += part.span;
      row += 1;
    }
    if (beliefs.loop) {
      plan.push({
        id: wireForSpan(col - startCol),
        sockets: [socketIndex(row, col), socketIndex(row, startCol)],
      });
    }
    return plan;
  }

  // Naive "rows are connected": parts lined up end to end along one row,
  // each starting in the hole right after the previous one.
  const row = 8;
  const startCol = 6;
  let col = startCol;
  for (const part of chain) {
    const from = socketIndex(row, col);
    const to = socketIndex(row, col + part.span);
    plan.push({ id: part.id, sockets: part.id === CIRCUIT_PARTS.battery ? [to, from] : [from, to] });
    col += part.span + 1;
  }
  if (beliefs.loop) {
    plan.push({ id: wireForSpan(col - startCol + 1), sockets: [socketIndex(row, col), socketIndex(row, startCol - 1)] });
  }
  return plan;
}

export function partLabel(id: string): string {
  if (id === CIRCUIT_PARTS.battery) return "the battery";
  if (isLed(id)) return id === "led-green" ? "the green LED" : "the red LED";
  if (isResistor(id)) return "the resistor";
  if (isWire(id)) return `the ${id.replace("wire-", "")} wire`;
  return id;
}
