/**
 * A small, pure DC operating-point solver for the makerspace's educational circuits.
 *
 * Method: modified nodal analysis (MNA). Unknowns are the node voltages plus one branch current
 * per voltage source; the dense system is solved by Gaussian elimination with partial pivoting.
 * LEDs are piecewise-linear (off = tiny leakage conductance; on = forward drop Vf in series with
 * a small resistance) and the solver iterates their on/off states until they are consistent.
 *
 * Educational approximations (documented in docs/circuit-engine.md):
 * - Batteries are ideal sources with a fixed internal resistance (default 1 Ω). Real 9 V cells
 *   sag non-linearly under load; their internal resistance is roughly 1–2 Ω fresh.
 * - LEDs are a two-segment model (Vf + Rs), not the Shockley exponential. Currents are
 *   representative within ~10–20 % for the 1–30 mA range taught here, not datasheet-exact.
 * - Jumper wires are small fixed resistances (0.05 Ω); breadboard strips are ideal joins.
 * - No temperature, no transients, no AC, no capacitors or inductors.
 *
 * Every number that comes in is validated; invalid elements are rejected with a diagnostic and
 * never silently treated as working parts. The solver never throws on bad input and never runs
 * unbounded loops.
 */

export const SOLVER_VERSION = "dc-mna-1.0.0";

export type LedColor = "red" | "green" | "yellow" | "blue" | "white";

/** Typical forward voltage at ~10 mA (V). */
export const LED_FORWARD_VOLTS: Record<LedColor, number> = {
  red: 1.9,
  green: 2.1,
  yellow: 2.0,
  blue: 3.0,
  white: 3.0,
};

export const DEFAULTS = {
  batteryInternalOhms: 1,
  wireOhms: 0.05,
  ledSeriesOhms: 15,
  /** Rated continuous current for a 5 mm indicator LED (A). */
  ledRatedAmps: 0.02,
  /** Above this the LED would fail within seconds (A). */
  ledBurnoutAmps: 0.1,
  /** Typical datasheet maximum reverse voltage for an indicator LED (V); more is unsafe. */
  ledReverseMaxVolts: 5,
  ledOffSiemens: 1e-9,
  /** Any source or wire carrying more than this is treated as a short circuit (A). */
  shortAmps: 1,
  /** Below this a source is considered to deliver no current: the loop is open (A). */
  openAmps: 1e-6,
  /** Conductance from every node to ground so floating islands keep the matrix regular. */
  gmin: 1e-12,
  maxIterations: 60,
};

/** Accepted physical ranges. Anything outside is rejected as invalid input. */
export const LIMITS = {
  volts: { min: 0.1, max: 48 },
  ohms: { min: 0.01, max: 1e9 },
  internalOhms: { min: 0.001, max: 1e6 },
  forwardVolts: { min: 0.5, max: 5 },
};

export interface SourceElement {
  /** Human-readable name used in diagnostics (defaults to the id). */
  label?: string;
  kind: "source";
  id: string;
  /** Positive terminal node. */
  pos: string;
  /** Negative terminal node. */
  neg: string;
  volts: number;
  internalOhms?: number;
}
export interface ResistorElement {
  /** Human-readable name used in diagnostics (defaults to the id). */
  label?: string;
  kind: "resistor";
  id: string;
  a: string;
  b: string;
  ohms: number;
}
export interface WireElement {
  /** Human-readable name used in diagnostics (defaults to the id). */
  label?: string;
  kind: "wire";
  id: string;
  a: string;
  b: string;
  ohms?: number;
}
export interface LedElement {
  /** Human-readable name used in diagnostics (defaults to the id). */
  label?: string;
  kind: "led";
  id: string;
  anode: string;
  cathode: string;
  color?: LedColor;
  forwardVolts?: number;
  seriesOhms?: number;
  ratedAmps?: number;
  burnoutAmps?: number;
}
export type CircuitElement = SourceElement | ResistorElement | WireElement | LedElement;

export interface Netlist {
  elements: CircuitElement[];
  /** Nodes that are joined with zero resistance (e.g. a breadboard strip): groups of node names. */
  joins?: string[][];
}

export type DiagnosticCode =
  | "invalid-input"
  | "no-source"
  | "open-circuit"
  | "short-circuit"
  | "reverse-led"
  | "led-reverse-overvoltage"
  | "led-overcurrent"
  | "led-burnout"
  | "floating"
  | "singular"
  | "non-convergence";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "error" | "warning" | "info";
  elementId?: string;
  message: string;
}

export type LedState = "off" | "lit" | "dim" | "overcurrent" | "burnout" | "reverse" | "floating";

export interface ElementReading {
  id: string;
  kind: CircuitElement["kind"];
  /** Voltage across the element: a − b (resistor/wire), anode − cathode (LED), pos − neg (source). */
  volts: number;
  /** Current through the element (A): a→b, anode→cathode, or out of the + terminal for a source. */
  amps: number;
  watts: number;
  /** Whether both terminals sit on nets that are tied to the circuit's reference. */
  connected: boolean;
  led?: { state: LedState; brightness: number; on: boolean };
}

/**
 * Overall verdict, most severe first: invalid input (always wins: the readings are of a
 * circuit missing the rejected parts), singular/non-convergence, short circuit, unsafe (an
 * LED above its rated current, burning out, or reverse-biased beyond its maximum), open
 * circuit (no conducting loop), no source, ok.
 * `ok` means solved with current flowing and nothing unsafe — not necessarily that an LED is lit.
 */
export type SolveStatus = "ok" | "no-source" | "open-circuit" | "short-circuit" | "unsafe" | "invalid" | "singular" | "non-convergence";

export interface SolveResult {
  solver: typeof SOLVER_VERSION;
  status: SolveStatus;
  /** True when the operating point was computed (even if the circuit is unsafe). */
  solved: boolean;
  /** Node voltage relative to the reference (first valid source's − terminal); null = floating/unknown. */
  nodeVolts: Record<string, number | null>;
  elements: Record<string, ElementReading>;
  diagnostics: Diagnostic[];
  iterations: number;
  rejected: string[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const inRange = (value: unknown, range: { min: number; max: number }): value is number =>
  finite(value) && value >= range.min && value <= range.max;
const validName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;

function validate(element: CircuitElement): string | null {
  if (!element || typeof element !== "object") return "not an element";
  if (!validName(element.id)) return "missing id";
  switch (element.kind) {
    case "source":
      if (!validName(element.pos) || !validName(element.neg)) return "terminal not connected";
      if (!inRange(element.volts, LIMITS.volts)) return `voltage must be ${LIMITS.volts.min}–${LIMITS.volts.max} V`;
      if (element.internalOhms !== undefined && !inRange(element.internalOhms, LIMITS.internalOhms)) return "internal resistance out of range";
      return null;
    case "resistor":
      if (!validName(element.a) || !validName(element.b)) return "lead not connected";
      if (!inRange(element.ohms, LIMITS.ohms)) return `resistance must be ${LIMITS.ohms.min}–${LIMITS.ohms.max} Ω`;
      return null;
    case "wire":
      if (!validName(element.a) || !validName(element.b)) return "end not connected";
      if (element.ohms !== undefined && !inRange(element.ohms, LIMITS.ohms)) return "wire resistance out of range";
      return null;
    case "led":
      if (!validName(element.anode) || !validName(element.cathode)) return "lead not connected";
      if (element.forwardVolts !== undefined && !inRange(element.forwardVolts, LIMITS.forwardVolts)) return "forward voltage out of range";
      if (element.seriesOhms !== undefined && !inRange(element.seriesOhms, LIMITS.ohms)) return "series resistance out of range";
      if (element.ratedAmps !== undefined && !inRange(element.ratedAmps, { min: 1e-4, max: 5 })) return "rated current out of range";
      if (element.burnoutAmps !== undefined && !inRange(element.burnoutAmps, { min: 1e-4, max: 10 })) return "burnout current out of range";
      return null;
    default:
      return "unknown element kind";
  }
}

class DisjointSet {
  private readonly parent = new Map<string, string>();
  find(name: string): string {
    let root = this.parent.get(name) ?? name;
    if (root === name) {
      if (!this.parent.has(name)) this.parent.set(name, name);
      return name;
    }
    while (this.parent.get(root) !== root) root = this.parent.get(root) ?? root;
    // path compression
    let walk = name;
    while (walk !== root) {
      const next = this.parent.get(walk) ?? root;
      this.parent.set(walk, root);
      walk = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Solves A·x = b in place by Gaussian elimination with partial pivoting.
 * Returns null when a pivot is (numerically) zero — the circuit is singular.
 */
export function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  if (matrix.length !== n) return null;
  const a = matrix.map((row) => row.slice());
  const b = rhs.slice();
  // Pivots are judged against their own row's magnitude, not the whole matrix: a stiff part
  // (a 1 mΩ source) must not make a tiny-but-valid floating-node pivot look singular.
  const rowScale = a.map((row) => row.reduce((max, value) => Math.max(max, Math.abs(value)), 0));
  if (rowScale.some((value) => !Number.isFinite(value))) return null;
  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let best = Math.abs(a[col][col]);
    for (let row = col + 1; row < n; row += 1) {
      const candidate = Math.abs(a[row][col]);
      if (candidate > best) {
        best = candidate;
        pivotRow = row;
      }
    }
    if (!(best > rowScale[pivotRow] * 1e-13) || best === 0) return null;
    if (pivotRow !== col) {
      [a[col], a[pivotRow]] = [a[pivotRow], a[col]];
      [b[col], b[pivotRow]] = [b[pivotRow], b[col]];
      [rowScale[col], rowScale[pivotRow]] = [rowScale[pivotRow], rowScale[col]];
    }
    const pivot = a[col][col];
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row][col] / pivot;
      if (factor === 0) continue;
      for (let k = col; k < n; k += 1) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row];
    for (let k = row + 1; k < n; k += 1) sum -= a[row][k] * x[k];
    x[row] = sum / a[row][row];
    if (!Number.isFinite(x[row])) return null;
  }
  // Reject numerically meaningless answers (near-singular systems that slipped through).
  for (let row = 0; row < n; row += 1) {
    let residual = -rhs[row];
    let magnitude = Math.abs(rhs[row]);
    for (let k = 0; k < n; k += 1) {
      residual += matrix[row][k] * x[k];
      magnitude += Math.abs(matrix[row][k] * x[k]);
    }
    if (Math.abs(residual) > 1e-7 * Math.max(magnitude, 1e-30)) return null;
  }
  return x;
}

interface LedModel {
  element: LedElement;
  vf: number;
  rs: number;
  rated: number;
  burnout: number;
  on: boolean;
}

const nameOf = (element: CircuitElement): string =>
  typeof element.label === "string" && element.label.length > 0 && element.label.length <= 60 ? element.label : element.id;

/** Computes the DC operating point of `netlist`. Pure; never throws. */
export function solveCircuit(netlist: Netlist, options: Partial<typeof DEFAULTS> = {}): SolveResult {
  const cfg = { ...DEFAULTS, ...options };
  const diagnostics: Diagnostic[] = [];
  const rejected: string[] = [];
  const result = (status: SolveStatus, solved: boolean, extra: Partial<SolveResult> = {}): SolveResult => ({
    solver: SOLVER_VERSION,
    status,
    solved,
    nodeVolts: {},
    elements: {},
    diagnostics,
    iterations: 0,
    rejected,
    ...extra,
  });

  const input = Array.isArray(netlist?.elements) ? netlist.elements : [];
  const seen = new Set<string>();
  const elements: CircuitElement[] = [];
  for (const element of input.slice(0, 512)) {
    const problem = validate(element);
    const id = validName(element?.id) ? element.id : "(unnamed)";
    if (!problem && seen.has(id)) {
      rejected.push(id);
      diagnostics.push({ code: "invalid-input", severity: "error", elementId: id, message: `Duplicate part id ${id}; it was ignored.` });
      continue;
    }
    if (problem) {
      rejected.push(id);
      diagnostics.push({ code: "invalid-input", severity: "error", elementId: id, message: `${id}: ${problem}. It is left out of the simulation.` });
      continue;
    }
    seen.add(id);
    elements.push(element);
  }

  // Ideal joins (breadboard strips) collapse node names into nets.
  const sets = new DisjointSet();
  for (const group of Array.isArray(netlist?.joins) ? netlist.joins.slice(0, 1024) : []) {
    if (!Array.isArray(group)) continue;
    const names = group.filter(validName);
    for (let i = 1; i < names.length; i += 1) sets.union(names[0], names[i]);
  }
  const terminals = (element: CircuitElement): [string, string] => {
    switch (element.kind) {
      case "source": return [element.pos, element.neg];
      case "led": return [element.anode, element.cathode];
      default: return [element.a, element.b];
    }
  };
  const allNodes = new Set<string>();
  for (const element of elements) for (const node of terminals(element)) allNodes.add(node);
  for (const group of Array.isArray(netlist?.joins) ? netlist.joins.slice(0, 1024) : []) {
    if (Array.isArray(group)) for (const node of group) if (validName(node)) allNodes.add(node);
  }

  const sources = elements.filter((element): element is SourceElement => element.kind === "source");
  const invalidStatus = rejected.length > 0;
  const readingsFor = (nodeVolts: Record<string, number | null>, live: Set<string>, x: number[] | null, index: Map<string, number>, leds: LedModel[], sourceCurrent: Map<string, number>): Record<string, ElementReading> => {
    const out: Record<string, ElementReading> = {};
    const v = (node: string): number => {
      const net = sets.find(node);
      const i = index.get(net);
      return i === undefined || !x ? 0 : x[i];
    };
    for (const element of elements) {
      const [p, q] = terminals(element);
      const connected = live.has(sets.find(p)) && live.has(sets.find(q));
      const volts = connected ? v(p) - v(q) : 0;
      let amps = 0;
      let led: ElementReading["led"];
      if (element.kind === "resistor") amps = volts / element.ohms;
      if (element.kind === "wire") amps = volts / (element.ohms ?? cfg.wireOhms);
      if (element.kind === "source") amps = connected ? (sourceCurrent.get(element.id) ?? 0) : 0;
      if (element.kind === "led") {
        const model = leds.find((entry) => entry.element.id === element.id);
        if (model) {
          amps = model.on ? (volts - model.vf) / model.rs : volts * cfg.ledOffSiemens;
          led = { state: "off", brightness: 0, on: model.on && connected };
        }
      }
      if (!connected) amps = 0;
      const watts = element.kind === "source" ? (element.volts * amps) : volts * amps;
      out[element.id] = { id: element.id, kind: element.kind, volts, amps, watts, connected, ...(led ? { led } : {}) };
    }
    return out;
  };

  if (sources.length === 0) {
    diagnostics.push({ code: "no-source", severity: "info", message: "No battery is connected, so no current can flow." });
    const nodeVolts: Record<string, number | null> = {};
    for (const node of allNodes) nodeVolts[node] = null;
    const leds = elements.filter((e): e is LedElement => e.kind === "led").map((element) => ({ element, vf: 0, rs: 1, rated: 1, burnout: 1, on: false }));
    const readings = readingsFor(nodeVolts, new Set(), null, new Map(), leds, new Map());
    for (const reading of Object.values(readings)) if (reading.led) reading.led.state = "floating";
    return result(invalidStatus ? "invalid" : "no-source", false, { nodeVolts, elements: readings });
  }

  const ground = sets.find(sources[0].neg);

  // Which nets are tied (through any element) to the reference? The rest float.
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };
  for (const element of elements) {
    const [p, q] = terminals(element);
    link(sets.find(p), sets.find(q));
  }
  const live = new Set<string>();
  const flood = (start: string): void => {
    live.add(start);
    const queue = [start];
    while (queue.length) {
      const node = queue.pop()!;
      for (const next of adjacency.get(node) ?? []) {
        if (!live.has(next)) {
          live.add(next);
          queue.push(next);
        }
      }
    }
  };
  flood(ground);
  // A second battery in its own separate loop is still a live circuit. Its potential relative to
  // the first is undefined, so pin its − terminal to the reference with one tie (a single bridge
  // between two isolated islands carries no current, so no reading changes).
  const islandTies: string[] = [];
  for (const source of sources) {
    const neg = sets.find(source.neg);
    if (!live.has(neg)) {
      islandTies.push(neg);
      flood(neg);
    }
  }

  // Index every non-ground net (floating ones too, held by gmin), then one row per source.
  // Only nets tied to a battery enter the equations. Floating islands are reported as such
  // (null voltage, "not connected") and kept out of the matrix, where their only path to the
  // reference would be gmin — numerically meaningless next to a 0.05 Ω wire.
  const nets = [...new Set([...allNodes].map((node) => sets.find(node)))].filter((net) => net !== ground && live.has(net)).sort();
  const index = new Map<string, number>();
  nets.forEach((net, i) => index.set(net, i));
  const internal = new Map<string, number>();
  for (const source of sources) internal.set(source.id, nets.length + internal.size);
  const nodeCount = nets.length + sources.length;
  const size = nodeCount + sources.length;

  const leds: LedModel[] = elements
    .filter((element): element is LedElement => element.kind === "led")
    .map((element) => ({
      element,
      vf: element.forwardVolts ?? LED_FORWARD_VOLTS[element.color ?? "red"] ?? LED_FORWARD_VOLTS.red,
      rs: element.seriesOhms ?? cfg.ledSeriesOhms,
      rated: element.ratedAmps ?? cfg.ledRatedAmps,
      burnout: element.burnoutAmps ?? cfg.ledBurnoutAmps,
      on: true,
    }));

  /** Matrix row for a node: −1 = the reference, −2 = floating (not in the system). */
  const nodeIndex = (node: string): number => {
    const net = sets.find(node);
    return net === ground ? -1 : index.get(net) ?? -2;
  };

  let x: number[] | null = null;
  let iterations = 0;
  let converged = false;
  let lastFlipped: LedModel | null = null;
  for (; iterations < cfg.maxIterations; iterations += 1) {
    const matrix = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    const rhs = new Array<number>(size).fill(0);
    const conduct = (i: number, j: number, g: number): void => {
      if (i === -2 || j === -2) return;
      if (i >= 0) matrix[i][i] += g;
      if (j >= 0) matrix[j][j] += g;
      if (i >= 0 && j >= 0) {
        matrix[i][j] -= g;
        matrix[j][i] -= g;
      }
    };
    for (let i = 0; i < nodeCount; i += 1) matrix[i][i] += cfg.gmin;
    for (const net of islandTies) matrix[index.get(net)!][index.get(net)!] += 1;
    for (const element of elements) {
      if (element.kind === "resistor") conduct(nodeIndex(element.a), nodeIndex(element.b), 1 / element.ohms);
      if (element.kind === "wire") conduct(nodeIndex(element.a), nodeIndex(element.b), 1 / (element.ohms ?? cfg.wireOhms));
    }
    for (const model of leds) {
      const a = nodeIndex(model.element.anode);
      const c = nodeIndex(model.element.cathode);
      if (a === -2 || c === -2) continue;
      if (model.on) {
        const g = 1 / model.rs;
        conduct(a, c, g);
        // I(a→c) = g·(Va − Vc − Vf): the −g·Vf term moves to the right-hand side.
        if (a >= 0) rhs[a] += g * model.vf;
        if (c >= 0) rhs[c] -= g * model.vf;
      } else {
        conduct(a, c, cfg.ledOffSiemens);
      }
    }
    sources.forEach((source, k) => {
      // pos ─ Rint ─ (internal node) ─ ideal V ─ neg
      const inner = internal.get(source.id)!;
      conduct(nodeIndex(source.pos), inner, 1 / (source.internalOhms ?? cfg.batteryInternalOhms));
      const row = nodeCount + k;
      const neg = nodeIndex(source.neg);
      matrix[inner][row] += 1;
      matrix[row][inner] += 1;
      if (neg >= 0) {
        matrix[neg][row] -= 1;
        matrix[row][neg] -= 1;
      }
      rhs[row] = source.volts;
    });

    x = solveLinear(matrix, rhs);
    if (!x) break;
    const voltage = (node: string): number => {
      const i = nodeIndex(node);
      return i < 0 ? 0 : x![i];
    };
    // Flip only the LED whose assumed state is most wrong, so states cannot oscillate.
    let worst: LedModel | null = null;
    let worstMargin = 1e-9;
    for (const model of leds) {
      if (nodeIndex(model.element.anode) === -2 || nodeIndex(model.element.cathode) === -2) continue;
      const vd = voltage(model.element.anode) - voltage(model.element.cathode);
      const margin = model.on ? model.vf - vd : vd - model.vf;
      if (margin > worstMargin) {
        worstMargin = margin;
        worst = model;
      }
    }
    if (!worst) {
      converged = true;
      iterations += 1;
      break;
    }
    worst.on = !worst.on;
    lastFlipped = worst;
  }
  // Out of iterations: undo the last flip so every reading matches the solution `x` it came
  // from (the result is still flagged non-convergence and never treated as working).
  if (!converged && lastFlipped) lastFlipped.on = !lastFlipped.on;

  if (!x) {
    diagnostics.push({ code: "singular", severity: "error", message: "The circuit equations have no unique solution (an ideal loop or an unsupported arrangement). Nothing is shown as working." });
    return result(invalidStatus ? "invalid" : "singular", false, { iterations });
  }
  if (!converged) {
    diagnostics.push({ code: "non-convergence", severity: "error", message: "The LED states did not settle; the readings are not reliable, so the circuit is not treated as working." });
  }

  const sourceCurrent = new Map<string, number>();
  sources.forEach((source, k) => {
    // The MNA branch current flows into the ideal source's + node from the circuit; current
    // delivered out of the battery's + terminal is its negation.
    sourceCurrent.set(source.id, -x![nodeCount + k]);
  });
  const nodeVolts: Record<string, number | null> = {};
  for (const node of allNodes) {
    const net = sets.find(node);
    nodeVolts[node] = !live.has(net) ? null : net === ground ? 0 : x![index.get(net)!];
  }
  const readings = readingsFor(nodeVolts, live, x, index, leds, sourceCurrent);

  const floatingParts = elements.filter((element) => !readings[element.id].connected).map(nameOf);
  if (floatingParts.length) {
    diagnostics.push({
      code: "floating",
      severity: "info",
      message: `${floatingParts.join(", ")} ${floatingParts.length === 1 ? "is" : "are"} not connected to the battery's circuit.`,
    });
  }

  let short = false;
  // Jumpers alone between a source's terminals are a short at any voltage, even when the
  // current stays under the amps threshold (a 1 V cell through two wires draws ~0.9 A).
  const wiresOnly = new DisjointSet();
  for (const element of elements) if (element.kind === "wire") wiresOnly.union(sets.find(element.a), sets.find(element.b));
  for (const source of sources) {
    const amps = readings[source.id].amps;
    if (sets.find(source.pos) === sets.find(source.neg)) {
      short = true;
      diagnostics.push({ code: "short-circuit", severity: "error", elementId: source.id, message: `${nameOf(source)}'s + and − terminals are joined directly: a short circuit. A real battery would heat up quickly.` });
    } else if (wiresOnly.find(sets.find(source.pos)) === wiresOnly.find(sets.find(source.neg))) {
      short = true;
      diagnostics.push({ code: "short-circuit", severity: "error", elementId: source.id, message: `${nameOf(source)}'s + and − terminals are joined by jumper wires alone (${formatAmps(Math.abs(amps))} with nothing to limit it): a short circuit.` });
    } else if (Math.abs(amps) > cfg.shortAmps) {
      short = true;
      diagnostics.push({ code: "short-circuit", severity: "error", elementId: source.id, message: `${nameOf(source)} is delivering ${formatAmps(Math.abs(amps))}: something bridges its terminals with almost no resistance (a short circuit).` });
    }
  }
  for (const element of elements) {
    if (element.kind !== "wire") continue;
    if (Math.abs(readings[element.id].amps) > cfg.shortAmps) {
      short = true;
      diagnostics.push({ code: "short-circuit", severity: "error", elementId: element.id, message: `${nameOf(element)} carries ${formatAmps(Math.abs(readings[element.id].amps))}: it is shorting the battery.` });
    }
  }

  const reverseStressed = new Set<string>();
  for (const model of leds) {
    const reading = readings[model.element.id];
    const led = reading.led!;
    if (!reading.connected) {
      led.state = "floating";
      continue;
    }
    const amps = reading.amps;
    if (short && Math.abs(amps) < cfg.openAmps) {
      led.state = "off";
    } else if (!model.on && reading.volts < -0.5) {
      led.state = "reverse";
      diagnostics.push({
        code: "reverse-led",
        severity: "warning",
        elementId: model.element.id,
        message: `${nameOf(model.element)} is in backwards (${reading.volts.toFixed(1)} V across it): an LED only conducts from its anode (long lead) to its cathode (flat side).`,
      });
      if (reading.volts < -cfg.ledReverseMaxVolts) {
        reverseStressed.add(model.element.id);
        diagnostics.push({
          code: "led-reverse-overvoltage",
          severity: "error",
          elementId: model.element.id,
          message: `${nameOf(model.element)} has ${Math.abs(reading.volts).toFixed(1)} V across it in reverse, more than the ${cfg.ledReverseMaxVolts} V a typical LED tolerates: it can be damaged. Turn it around (or lower the voltage).`,
        });
      }
    } else if (model.on && amps >= model.burnout) {
      led.state = "burnout";
      diagnostics.push({
        code: "led-burnout",
        severity: "error",
        elementId: model.element.id,
        message: `${nameOf(model.element)} would draw about ${formatAmps(amps)} — far above its ${formatAmps(model.rated)} rating. A real LED would burn out almost at once; add a series resistor.`,
      });
    } else if (model.on && amps > model.rated) {
      led.state = "overcurrent";
      diagnostics.push({
        code: "led-overcurrent",
        severity: "warning",
        elementId: model.element.id,
        message: `${nameOf(model.element)} carries about ${formatAmps(amps)}, above its ${formatAmps(model.rated)} rating. It glows, but it is overdriven and will fail early; use a larger resistor.`,
      });
    } else if (model.on && amps > model.rated * 0.1) {
      led.state = "lit";
    } else if (model.on && amps > 1e-5) {
      led.state = "dim";
    } else {
      led.state = "off";
    }
    // An unsolved circuit never reports a working LED.
    if (!converged && (led.state === "lit" || led.state === "dim" || led.state === "overcurrent")) led.state = "off";
    // Brightness tracks current up to the rating; a burnt-out LED (or an unsolved circuit) is dark.
    const trusted = converged && led.state !== "burnout";
    led.brightness = trusted ? Math.max(0, Math.min(1, amps / model.rated)) : 0;
    led.on = trusted && (led.state === "lit" || led.state === "dim" || led.state === "overcurrent");
  }

  // Open circuit: no source has a *conducting* path (resistors, wires, LEDs that are on) from
  // its + back to its −. This is topological, so a closed loop with a tiny current (1 MΩ at
  // 1.5 V) is not mistaken for an open one, and a loop blocked only by an off LED is.
  // Other sources conduct too (cells in series), so each source is checked with every other.
  const anyLoop = sources.some((source) => {
    const conducting = new DisjointSet();
    for (const element of elements) {
      if (element.kind === "resistor" || element.kind === "wire") conducting.union(sets.find(element.a), sets.find(element.b));
      if (element.kind === "source" && element !== source) conducting.union(sets.find(element.pos), sets.find(element.neg));
    }
    for (const model of leds) if (model.on) conducting.union(sets.find(model.element.anode), sets.find(model.element.cathode));
    return conducting.find(sets.find(source.pos)) === conducting.find(sets.find(source.neg));
  });
  const unsafe = reverseStressed.size > 0 || leds.some((model) => {
    const state = readings[model.element.id].led?.state;
    return state === "burnout" || state === "overcurrent";
  });
  let status: SolveStatus = "ok";
  if (!converged) status = "non-convergence";
  else if (short) status = "short-circuit";
  else if (unsafe) status = "unsafe";
  else if (!anyLoop) {
    status = "open-circuit";
    const blocked = leds.some((model) => readings[model.element.id].led?.state === "reverse");
    diagnostics.push({
      code: "open-circuit",
      severity: "info",
      message: blocked
        ? "The loop is closed, but a backwards LED blocks it, so no current flows."
        : "The battery is connected but the path does not return to its other terminal, so no current flows (an open circuit).",
    });
  }
  if (invalidStatus) status = "invalid";
  return result(status, converged, { nodeVolts, elements: readings, iterations });
}

export function formatAmps(amps: number): string {
  const magnitude = Math.abs(amps);
  if (!Number.isFinite(magnitude)) return "—";
  if (magnitude >= 1) return `${amps.toFixed(2)} A`;
  if (magnitude >= 1e-3) return `${(amps * 1e3).toFixed(magnitude >= 0.1 ? 0 : 1)} mA`;
  if (magnitude >= 1e-6) return `${(amps * 1e6).toFixed(0)} µA`;
  return "0 mA";
}

export function formatVolts(volts: number | null | undefined): string {
  if (volts === null || volts === undefined || !Number.isFinite(volts)) return "—";
  return `${Math.abs(volts) < 0.005 ? "0.00" : volts.toFixed(2)} V`;
}

export function formatOhms(ohms: number): string {
  if (!Number.isFinite(ohms)) return "—";
  if (ohms >= 1e6) return `${trim(ohms / 1e6)} MΩ`;
  if (ohms >= 1e3) return `${trim(ohms / 1e3)} kΩ`;
  return `${trim(ohms)} Ω`;
}
const trim = (value: number): string => String(Number(value.toPrecision(3)));
