/**
 * Pure breadboard topology for the Circuit Bench, shared by the AI teammate.
 *
 * Mirrors the net model in `DesktopWorkbenchScene.evaluateCircuit`: rows 0 and 11 are
 * power rails, rows 1–5 and 6–10 connect vertically within each column (the two halves
 * are split by the center channel), and wires and resistors join the nets at their leads.
 * Kept free of DOM and three.js so it runs under `node --experimental-strip-types`.
 */

export const BREADBOARD_COLS = 16;
export const BREADBOARD_ROWS = 12;

export type SocketPair = [number, number];
/** Component id → the two sockets its leads sit in, or null when off the board. */
export type CircuitPlacements = Record<string, SocketPair | null | undefined>;

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

export function socketToNet(index: number): number {
  const { row, col } = socketRowCol(index);
  if (row === 0) return 0;
  if (row === BREADBOARD_ROWS - 1) return 1;
  if (row <= 5) return 2 + col;
  return 2 + BREADBOARD_COLS + col;
}

const NET_COUNT = 2 + BREADBOARD_COLS * 2;

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
  return Boolean(pair && Number.isInteger(pair[0]) && Number.isInteger(pair[1]));
}

function makeNets(placements: CircuitPlacements, includeResistors: boolean): (socket: number) => number {
  const parent = Array.from({ length: NET_COUNT }, (_, index) => index);
  const find = (value: number): number => {
    let current = value;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  for (const [id, pair] of Object.entries(placements)) {
    if (!isPlaced(pair)) continue;
    if (!isWire(id) && !(includeResistors && isResistor(id))) continue;
    const rootA = find(socketToNet(pair[0]));
    const rootB = find(socketToNet(pair[1]));
    if (rootA !== rootB) parent[rootA] = rootB;
  }
  return (socket) => find(socketToNet(socket));
}

function litLeds(placements: CircuitPlacements, includeResistors: boolean): string[] {
  const battery = placements[CIRCUIT_PARTS.battery];
  if (!isPlaced(battery)) return [];
  const net = makeNets(placements, includeResistors);
  const sourceA = net(battery[0]);
  const sourceB = net(battery[1]);
  return CIRCUIT_PARTS.leds.filter((id) => {
    const led = placements[id];
    if (!isPlaced(led)) return false;
    const ledA = net(led[0]);
    const ledB = net(led[1]);
    return (ledA === sourceA && ledB === sourceB) || (ledA === sourceB && ledB === sourceA);
  });
}

export interface CircuitAnalysis {
  /** Parts with both leads in sockets. */
  placed: string[];
  batteryPlaced: boolean;
  resistorPlaced: boolean;
  litLeds: string[];
  powered: boolean;
  /** LEDs that would light even with every resistor removed: no current limiting. */
  unsafeLeds: string[];
  /** At least one LED lights only because a resistor completes its path. */
  resistorInSeries: boolean;
  /** Some other part touches each battery terminal's column strip or rail. */
  bothBatteryTerminalsUsed: boolean;
  /** Parts joined by a shared column strip while sitting in different rows. */
  columnBridges: Array<[string, string]>;
  /** Parts whose leads sit side by side in one row, in different (unconnected) strips. */
  rowNeighbors: Array<[string, string]>;
}

export function analyzeCircuit(placements: CircuitPlacements): CircuitAnalysis {
  const placedEntries = Object.entries(placements).filter(
    (entry): entry is [string, SocketPair] => isPlaced(entry[1]),
  );
  const placed = placedEntries.map(([id]) => id);
  const lit = litLeds(placements, true);
  const litWithoutResistors = new Set(litLeds(placements, false));
  const unsafeLeds = lit.filter((id) => litWithoutResistors.has(id));

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
    litLeds: lit,
    powered: lit.length > 0,
    unsafeLeds,
    resistorInSeries: lit.some((id) => !litWithoutResistors.has(id)),
    bothBatteryTerminalsUsed,
    columnBridges,
    rowNeighbors,
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
 * Only a builder that holds all three ideas produces a safe, lit circuit. Parts go in the
 * board corner nearest the default camera (high rows and columns), with the tall battery
 * furthest back, so the result is easy to see and nothing hides behind it.
 */
export function planCircuitLayout(beliefs: LayoutBeliefs): PlannedPart[] {
  const chain: Array<{ id: string; span: number }> = [{ id: CIRCUIT_PARTS.battery, span: 2 }];
  if (beliefs.resistor) chain.push({ id: "resistor-220", span: 3 });
  chain.push({ id: "led-red", span: 1 });
  const plan: PlannedPart[] = [];

  if (beliefs.strips) {
    // Each part starts in the column where the previous one ended, one row nearer.
    const startCol = 8;
    let row = 7;
    let col = startCol;
    for (const part of chain) {
      plan.push({ id: part.id, sockets: [socketIndex(row, col), socketIndex(row, col + part.span)] });
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
    plan.push({ id: part.id, sockets: [socketIndex(row, col), socketIndex(row, col + part.span)] });
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
