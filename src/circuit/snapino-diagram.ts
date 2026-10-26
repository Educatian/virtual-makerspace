/**
 * Live Snapino circuit diagram, derived only from the bench's actual snap placements (the same
 * canonical state the 3D bench, the episode timeline and the room use, `snapino-circuit.ts`).
 *
 * It is a ladder schematic: every horizontal row is one conductor net (the studs a set of snap
 * wires joins, plus any Snapino pads on it), and every vertical rung is a part with two ends —
 * a load (lamp, LED, motor) or the slide switch. Snap wires do not appear as rungs because a
 * wire IS a net; each row lists the wires that form it. The switch is drawn as a rung (open or
 * closed) instead of being merged, so the learner sees where it sits.
 *
 * Nothing is "corrected": a lamp wired D5 → D6, a load bridged by a wire, two pads joined, 5V
 * joined to GND are all drawn exactly as built. Fault notes are a separate layer the caller can
 * withhold (productive-failure condition before a team's first compared round).
 *
 * Pure functions, no DOM: unit-checked in `scripts/snapino-diagram-check.mjs`.
 */
import { OUTPUT_PINS, type PinStates, type SnapinoPin } from "../desktop/snapino.ts";
import {
  analyzeSnapino,
  snapinoNets,
  SNAPINO_CONDUCTORS,
  SNAPINO_LOADS,
  SNAPINO_PADS,
  SNAPINO_SOCKET_COUNT,
  SNAPINO_SWITCH,
  type SnapinoBench,
} from "./snapino-circuit.ts";

export type PadName = keyof typeof SNAPINO_PADS;
const PAD_ORDER: PadName[] = ["5V", "D2", "D3", "D5", "D6", "GND"];
const SNAP_COLUMNS = 9;
const ROW_LETTERS = "ABCDEFG";

export const SNAPINO_SHORT_NAMES: Record<string, string> = {
  "sno-l1": "L1",
  "sno-d1": "D1",
  "sno-m1": "M1",
  "sno-s1": "S1",
  "sno-w2a": "W2a",
  "sno-w2b": "W2b",
  "sno-w3": "W3",
  "sno-w4a": "W4a",
  "sno-w4b": "W4b",
};

const PART_NAMES: Record<string, string> = {
  "sno-l1": "Lamp L1",
  "sno-d1": "LED D1",
  "sno-m1": "Motor M1",
  "sno-s1": "Slide switch S1",
};

/**
 * Stud name on the 9 × 7 snap base: the row letter printed on the base (A next to the Snapino
 * carrier) and the column number 1–9, joined by a dash ("D-4") so a stud is never confused with a
 * Snapino pin name (D2, D3, D5, D6).
 */
export function studLabel(socket: number): string {
  return `${ROW_LETTERS[Math.floor(socket / SNAP_COLUMNS)] ?? "?"}-${(socket % SNAP_COLUMNS) + 1}`;
}

/** The Snapino pad on a stud, if any. */
export function padAt(socket: number): PadName | null {
  return (Object.entries(SNAPINO_PADS).find(([, stud]) => stud === socket)?.[0] as PadName | undefined) ?? null;
}

export type RowLevel = "short" | "supply" | "ground" | "high" | "low" | "free";

export interface DiagramRow {
  /** Stable key: the first pad on the row ("5V", "D5"…) or "n<stud>" for a free net. */
  key: string;
  label: string;
  pads: PadName[];
  /** Studs on this net that something touches (pads and part ends), sorted. */
  studs: number[];
  /** Snap wires that form this net. */
  via: string[];
  level: RowLevel;
}

export type RungKind = "lamp" | "led" | "motor" | "switch";

export interface DiagramRung {
  id: string;
  short: string;
  name: string;
  kind: RungKind;
  /** Row keys of the part's two ends (equal when both ends share one net). */
  ends: [string, string];
  studs: [number, number];
  /** Load running right now, or switch closed. */
  active: boolean;
}

export type FaultKind = "short" | "pin-ground" | "pin-supply" | "pins-joined" | "bypassed" | "no-ground" | "no-source" | "always-on";

export interface DiagramFault {
  kind: FaultKind;
  /** Part the fault belongs to, if any. */
  part?: string;
  /** Row the fault sits on, if any. */
  row?: string;
  text: string;
}

export interface SnapinoDiagram {
  rows: DiagramRow[];
  rungs: DiagramRung[];
  /** Parts still in the tray (not seated on two studs). */
  tray: string[];
  faults: DiagramFault[];
  short: boolean;
  /** D2 reads HIGH. */
  inputHigh: boolean;
  /** Which output pins can drive each seated light/motor (empty: none). */
  drivers: Record<string, Array<PadName>>;
}

const seated = (sockets: readonly (number | null)[] | null | undefined): sockets is [number, number] =>
  Array.isArray(sockets) && sockets.length === 2 && sockets.every((socket) => Number.isInteger(socket) && (socket as number) >= 0 && (socket as number) < SNAPINO_SOCKET_COUNT) && sockets[0] !== sockets[1];

const kindOf = (id: string): RungKind => (id === "sno-l1" ? "lamp" : id === "sno-d1" ? "led" : id === "sno-m1" ? "motor" : "switch");

/** Builds the diagram for a bench and the pin levels the board drives right now. */
export function buildSnapinoDiagram(bench: SnapinoBench, pins: PinStates): SnapinoDiagram {
  // Layout nets: snap wires only (the switch stays a visible rung).
  const parent = Array.from({ length: SNAPINO_SOCKET_COUNT }, (_, index) => index);
  const find = (value: number): number => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const wiresOf = new Map<number, string[]>();
  for (const id of SNAPINO_CONDUCTORS) {
    const sockets = bench[id]?.sockets;
    if (seated(sockets)) parent[find(sockets[0])] = find(sockets[1]);
  }
  for (const id of SNAPINO_CONDUCTORS) {
    const sockets = bench[id]?.sockets;
    if (!seated(sockets)) continue;
    const root = find(sockets[0]);
    wiresOf.set(root, [...(wiresOf.get(root) ?? []), SNAPINO_SHORT_NAMES[id]]);
  }
  // Electrical nets (wires AND a closed switch): levels, faults, what runs.
  const nets = snapinoNets(bench);
  const state = analyzeSnapino(bench, pins);

  // Every pad is always on the diagram; free nets appear when a part end touches them.
  const studsOf = new Map<number, Set<number>>();
  const touch = (stud: number): void => {
    const root = find(stud);
    if (!studsOf.has(root)) studsOf.set(root, new Set());
    studsOf.get(root)!.add(stud);
  };
  for (const pad of PAD_ORDER) touch(SNAPINO_PADS[pad]);
  const partIds = [...SNAPINO_LOADS, SNAPINO_SWITCH];
  const tray: string[] = [];
  for (const id of partIds) {
    const sockets = bench[id]?.sockets;
    if (seated(sockets)) sockets.forEach(touch);
    else tray.push(id);
  }
  // Wires whose net touches nothing else still show as a row (a wire on its own is "as built").
  for (const id of SNAPINO_CONDUCTORS) {
    const sockets = bench[id]?.sockets;
    if (seated(sockets)) sockets.forEach(touch);
  }

  const levelOf = (root: number, pads: PadName[]): RowLevel => {
    const electrical = nets.net(root);
    if (nets.short && electrical === nets.vcc) return "short";
    if (electrical === nets.gnd) return "ground";
    if (electrical === nets.vcc) return "supply";
    if (OUTPUT_PINS.some((pin) => pins[pin] && nets.net(SNAPINO_PADS[pin]) === electrical)) return "high";
    if (pads.length || OUTPUT_PINS.some((pin) => nets.net(SNAPINO_PADS[pin]) === electrical) || nets.net(SNAPINO_PADS.D2) === electrical) return "low";
    return "free";
  };

  const rows: DiagramRow[] = [];
  const rowKey = new Map<number, string>();
  for (const [root, studSet] of studsOf) {
    const studs = [...studSet].sort((a, b) => a - b);
    const pads = PAD_ORDER.filter((pad) => find(SNAPINO_PADS[pad]) === root);
    const key = pads[0] ?? `n${studs[0]}`;
    rowKey.set(root, key);
    rows.push({
      key,
      label: pads.length ? pads.join(" = ") : `net ${studLabel(studs[0])}`,
      pads,
      studs,
      via: (wiresOf.get(root) ?? []).sort(),
      level: levelOf(root, pads),
    });
  }
  // 5V first, then D2…D6, free nets by stud, GND last (a row holding GND sorts last unless it
  // also holds 5V: a short stays at the top, as built).
  const rank = (row: DiagramRow): number => {
    if (row.pads.includes("5V")) return 0;
    if (row.pads.includes("GND")) return 1000;
    if (row.pads.length) return 10 + PAD_ORDER.indexOf(row.pads[0]);
    return 100 + row.studs[0];
  };
  rows.sort((a, b) => rank(a) - rank(b));

  const rungs: DiagramRung[] = [];
  for (const id of partIds) {
    const sockets = bench[id]?.sockets;
    if (!seated(sockets)) continue;
    const ends: [string, string] = [rowKey.get(find(sockets[0]))!, rowKey.get(find(sockets[1]))!];
    rungs.push({
      id,
      short: SNAPINO_SHORT_NAMES[id],
      name: PART_NAMES[id],
      kind: kindOf(id),
      ends,
      studs: [sockets[0], sockets[1]],
      active: id === SNAPINO_SWITCH ? bench[id]?.on === true : state.running.has(id),
    });
  }

  // ── Faults: structural, independent of the program (what the wiring allows) ──
  const faults: DiagramFault[] = [];
  const keyOfElectrical = (electrical: number): string | undefined => rows.find((row) => nets.net(row.studs[0]) === electrical)?.key;
  if (nets.short) faults.push({ kind: "short", row: keyOfElectrical(nets.vcc), text: "5V and GND are on one net: a short circuit. Nothing on the bench runs until it is opened." });
  if (!nets.short) {
    for (const pin of OUTPUT_PINS) {
      const electrical = nets.net(SNAPINO_PADS[pin]);
      if (electrical === nets.gnd) faults.push({ kind: "pin-ground", row: keyOfElectrical(electrical), text: `${pin}'s pad is on the GND net. Set HIGH it drives nothing (a pin short); a load needs to sit between ${pin} and GND.` });
      else if (electrical === nets.vcc) faults.push({ kind: "pin-supply", row: keyOfElectrical(electrical), text: `${pin}'s pad is joined to 5V. Anything on it runs whenever the board is powered; the code cannot switch it off.` });
    }
    const joined = new Map<number, SnapinoPin[]>();
    for (const pin of OUTPUT_PINS) {
      const electrical = nets.net(SNAPINO_PADS[pin]);
      if (electrical === nets.gnd || electrical === nets.vcc) continue;
      joined.set(electrical, [...(joined.get(electrical) ?? []), pin]);
    }
    for (const [electrical, list] of joined) {
      if (list.length > 1) faults.push({ kind: "pins-joined", row: keyOfElectrical(electrical), text: `${list.join(" and ")} are joined. One HIGH and one LOW would fight each other on a real board; they cannot signal separately.` });
    }
  }
  const drivers: Record<string, PadName[]> = {};
  for (const id of SNAPINO_LOADS) {
    const sockets = bench[id]?.sockets;
    if (!seated(sockets)) continue;
    const ends = [nets.net(sockets[0]), nets.net(sockets[1])];
    const short = SNAPINO_SHORT_NAMES[id];
    const sourcesOf = (electrical: number): PadName[] => [
      ...(electrical === nets.vcc ? (["5V"] as PadName[]) : []),
      ...OUTPUT_PINS.filter((pin) => nets.net(SNAPINO_PADS[pin]) === electrical),
    ];
    if (ends[0] === ends[1]) {
      drivers[id] = [];
      faults.push({ kind: "bypassed", part: id, text: `Both ends of ${short} are on the same net, so there is no difference across it: it can never run.` });
      continue;
    }
    const grounded = ends.indexOf(nets.gnd);
    if (grounded < 0) {
      drivers[id] = [];
      faults.push({ kind: "no-ground", part: id, text: `Neither end of ${short} reaches GND, so no current path can close through it.` });
      continue;
    }
    const other = ends[1 - grounded];
    const sources = nets.short ? [] : sourcesOf(other);
    drivers[id] = sources;
    if (nets.short) continue;
    if (!sources.length) faults.push({ kind: "no-source", part: id, text: `${short} reaches GND, but its other end is on a net with no 5V or output pin: nothing can drive it.` });
    else if (sources.includes("5V")) faults.push({ kind: "always-on", part: id, text: `${short} runs from 5V to GND whenever the board is powered; the code cannot switch it off.` });
  }

  return { rows, rungs, tray, faults, short: nets.short, inputHigh: state.inputHigh, drivers };
}

// ── SVG rendering ──────────────────────────────────────────────────────────────────

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const LEVEL_COPY: Record<RowLevel, string> = {
  short: "short",
  supply: "5 V",
  ground: "0 V",
  high: "HIGH",
  low: "LOW",
  free: "floating",
};

export interface DiagramRenderOptions {
  selected?: string | null;
  /** Fault notes and markers (withheld in PF before the first compared round). */
  showFaults: boolean;
  /** A highlighted row (net) key. */
  focusRow?: string | null;
}

const ROW_GAP = 36;
const TOP = 26;
const LABEL_W = 78;
const RUNG_X0 = 112;
const RUNG_GAP = 58;

/** Rows → y; rungs → x; one SVG string. Every row and rung is a focusable button. */
export function renderSnapinoDiagramSvg(diagram: SnapinoDiagram, options: DiagramRenderOptions): string {
  const width = Math.max(RUNG_X0 + diagram.rungs.length * RUNG_GAP + 8, 300);
  const height = TOP + Math.max(diagram.rows.length - 1, 0) * ROW_GAP + 26;
  const y = new Map(diagram.rows.map((row, index) => [row.key, TOP + index * ROW_GAP]));
  const selected = diagram.rungs.find((rung) => rung.id === options.selected) ?? null;
  const hotRows = new Set<string>(selected ? selected.ends : options.focusRow ? [options.focusRow] : []);
  const faultParts = new Set(options.showFaults ? diagram.faults.flatMap((fault) => (fault.part ? [fault.part] : [])) : []);
  const faultRows = new Set(options.showFaults ? diagram.faults.flatMap((fault) => (fault.row ? [fault.row] : [])) : []);

  const rowSvg = diagram.rows.map((row) => {
    const rowY = y.get(row.key)!;
    const classes = ["dg-row", `is-${row.level}`, hotRows.has(row.key) ? "is-hot" : "", faultRows.has(row.key) ? "is-fault" : ""].filter(Boolean).join(" ");
    const studs = row.studs.map((stud) => padAt(stud) ? `${padAt(stud)} pad (${studLabel(stud)})` : studLabel(stud)).join(", ");
    const label = `Net ${row.label}: ${LEVEL_COPY[row.level]}${row.via.length ? `, joined by ${row.via.join(", ")}` : ""}; studs ${studs}`;
    return `<g class="${classes}" data-row="${escapeXml(row.key)}" tabindex="0" role="button" aria-label="${escapeXml(label)}">
      <rect class="dg-hit" x="0" y="${rowY - 14}" width="${width}" height="28" />
      <line class="dg-net" x1="${LABEL_W - 6}" y1="${rowY}" x2="${width - 6}" y2="${rowY}" />
      <text class="dg-label" x="4" y="${rowY + 4}">${escapeXml(row.label)}</text>
      <text class="dg-level" x="${LABEL_W - 10}" y="${rowY - 5}" text-anchor="end">${escapeXml(LEVEL_COPY[row.level])}</text>
      ${row.via.length ? `<text class="dg-via" x="${LABEL_W - 2}" y="${rowY + 13}">${escapeXml(row.via.join(" · "))}</text>` : ""}
    </g>`;
  }).join("");

  const rungSvg = diagram.rungs.map((rung, index) => {
    const x = RUNG_X0 + index * RUNG_GAP;
    const [a, b] = [y.get(rung.ends[0])!, y.get(rung.ends[1])!];
    const fault = faultParts.has(rung.id);
    const classes = ["dg-rung", `is-${rung.kind}`, rung.active ? "is-active" : "", rung.id === options.selected ? "is-selected" : "", fault ? "is-fault" : ""].filter(Boolean).join(" ");
    const [label0, label1] = rung.studs.map((stud) => padAt(stud) ?? studLabel(stud));
    const rows = diagram.rows;
    const rowName = (key: string): string => rows.find((row) => row.key === key)?.label ?? key;
    const state = rung.kind === "switch" ? (rung.active ? "closed" : "open") : rung.active ? "running" : "off";
    const aria = `${rung.name}: ${rowName(rung.ends[0])} to ${rowName(rung.ends[1])}, ${state}`;
    let path: string;
    let mid: [number, number];
    if (a === b) {
      // Both ends on one net: drawn as a loop off the row, exactly as built.
      path = `M ${x - 14} ${a} C ${x - 14} ${a - 30}, ${x + 14} ${a - 30}, ${x + 14} ${a}`;
      mid = [x, a - 22];
    } else {
      const top = Math.min(a, b);
      const bottom = Math.max(a, b);
      // Rows the rung passes without connecting get a hop (no junction), and the symbol sits in
      // the last gap above the lower end, never on a row it does not touch.
      const crossed = [...y.values()].filter((rowY) => rowY > top && rowY < bottom).sort((m, n) => m - n);
      path = `M ${x} ${top}`;
      for (const rowY of crossed) path += ` L ${x} ${rowY - 5} A 5 5 0 0 1 ${x} ${rowY + 5}`;
      path += ` L ${x} ${bottom}`;
      mid = [x, bottom - ROW_GAP / 2];
    }
    return `<g class="${classes}" data-part="${rung.id}" tabindex="0" role="button" aria-pressed="${rung.id === options.selected}" aria-label="${escapeXml(aria)}">
      <rect class="dg-hit" x="${x - 22}" y="${Math.min(a, b) - (a === b ? 34 : 6)}" width="44" height="${Math.max(Math.abs(b - a) + 12, 44)}" />
      <path class="dg-lead" d="${path}" />
      ${a === b ? `<circle class="dg-dot" cx="${x - 14}" cy="${a}" r="3" /><circle class="dg-dot" cx="${x + 14}" cy="${a}" r="3" />` : `<circle class="dg-dot" cx="${x}" cy="${a}" r="3" /><circle class="dg-dot" cx="${x}" cy="${b}" r="3" />`}
      ${symbol(rung, mid)}
      <text class="dg-name" x="${mid[0] + 15}" y="${mid[1] + 4}">${escapeXml(rung.short)}</text>
      <text class="dg-stud" x="${a === b ? x - 14 : x + 5}" y="${a + 12}"${a === b ? ' text-anchor="middle"' : ""}>${escapeXml(label0)}</text>
      <text class="dg-stud" x="${a === b ? x + 14 : x + 5}" y="${b + 12}"${a === b ? ' text-anchor="middle"' : ""}>${escapeXml(label1)}</text>
      ${fault ? `<g class="dg-flag"><circle cx="${mid[0] - 15}" cy="${mid[1] - 12}" r="7" /><text x="${mid[0] - 15}" y="${mid[1] - 8.5}" text-anchor="middle">!</text></g>` : ""}
    </g>`;
  }).join("");

  return `<svg class="snapino-diagram" viewBox="0 0 ${width} ${height}" width="100%" role="group" aria-label="Live circuit diagram of the Snapino bench">${rowSvg}${rungSvg}</svg>`;
}

/** A small schematic symbol centred on `mid` (lamp ⊗, LED ▷|, motor Ⓜ, switch blade). */
function symbol(rung: DiagramRung, [x, y]: [number, number]): string {
  if (rung.kind === "lamp") {
    return `<g class="dg-symbol"><circle cx="${x}" cy="${y}" r="9" /><path d="M ${x - 6} ${y - 6} L ${x + 6} ${y + 6} M ${x + 6} ${y - 6} L ${x - 6} ${y + 6}" /></g>`;
  }
  if (rung.kind === "led") {
    return `<g class="dg-symbol"><path d="M ${x - 8} ${y - 7} L ${x + 8} ${y - 7} L ${x} ${y + 5} Z" /><path d="M ${x - 8} ${y + 6} L ${x + 8} ${y + 6}" /></g>`;
  }
  if (rung.kind === "motor") {
    return `<g class="dg-symbol"><circle cx="${x}" cy="${y}" r="9" /><text x="${x}" y="${y + 4}" text-anchor="middle">M</text></g>`;
  }
  // Switch: a gap with a blade, closed when on.
  return rung.active
    ? `<g class="dg-symbol is-switch"><rect class="dg-gap" x="${x - 5}" y="${y - 9}" width="10" height="18" /><path d="M ${x} ${y - 9} L ${x} ${y + 9}" /><circle cx="${x}" cy="${y - 9}" r="2.4" /><circle cx="${x}" cy="${y + 9}" r="2.4" /></g>`
    : `<g class="dg-symbol is-switch"><rect class="dg-gap" x="${x - 5}" y="${y - 9}" width="10" height="18" /><path d="M ${x} ${y + 9} L ${x + 9} ${y - 7}" /><circle cx="${x}" cy="${y - 9}" r="2.4" /><circle cx="${x}" cy="${y + 9}" r="2.4" /></g>`;
}
