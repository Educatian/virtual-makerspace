/**
 * Resource-Limited Greenhouse (Episode 3): the live resource-flow diagram and its text
 * alternative (the connection list), drawn from the rig as built (greenhouse-model.js deriveRig)
 * and the current model step. Wrong builds stay wrong: OUT→OUT and IN→IN hoses, loose ends, the
 * tank straight to a bed, loops and solar wired straight to a load are drawn as built, each with a
 * text label and a stroke pattern (colour is never the only cue), and carry nothing.
 * Pure: returns SVG / HTML strings; nothing from the room is rendered raw.
 */
import { GH_PORTS, GH_FIXTURE_IDS } from "../../cloudflare/greenhouse-rules.js";
import { GH_MODEL, type GhFault, type GhLine, type GhLineStatus, type GhRig, type GhSnapshot, type PlantState } from "../../cloudflare/greenhouse-model.js";
import type { CompactRecord } from "../../cloudflare/greenhouse-run.js";
import { LINE_SPECS } from "./gh-rig.ts";

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

export const FIXTURE_NAMES: Record<string, string> = {
  "water-pump": "Water pump",
  "valve-manifold": "Valve manifold",
  "farm-controller": "Farm controller",
  "vent-fan": "Vent fan",
  "solar-panel": "Solar panel",
  "temp-sensor": "Climate sensor",
  "light-sensor": "Light sensor",
  "soil-sensor": "Soil probe",
};
/** "Hose 1" and its length, per line id. */
export const LINE_NAMES: Record<string, { name: string; length: string; css: string; hose: boolean }> = Object.fromEntries(
  LINE_SPECS.map((spec) => {
    const [name, length] = spec.name.split(" · ");
    return [spec.id, { name, length, css: spec.css, hose: spec.kind === "ghhose" }];
  }),
);
export const partName = (id: string): string => FIXTURE_NAMES[id] ?? LINE_NAMES[id]?.name ?? id;
export const portLabel = (index: number): string => GH_PORTS[index]?.label ?? "?";

const WRONG: ReadonlySet<GhLineStatus> = new Set(["out-out", "in-in", "wrong-type", "shared-port", "no-pump", "loop", "unregulated"]);
export const isWrongLine = (line: GhLine): boolean => WRONG.has(line.status);

/** What a line does, in words (also the inspector's status line). */
export const LINE_STATUS_WORDS: Record<GhLineStatus, string> = {
  unplugged: "not plugged in (coiled in the aisle)",
  loose: "one end loose: carries nothing",
  "wrong-type": "wrong connector type: carries nothing",
  "out-out": "OUT to OUT: carries nothing",
  "in-in": "IN to IN: carries nothing",
  "shared-port": "shares a port: ignored",
  supply: "supply: tank to pump inlet",
  delivery: "delivery: pump outlet onward",
  branch: "branch: valve outlet to a bed",
  "no-pump": "tank straight to a bed: no pump, carries nothing (the tank sits below the beds)",
  loop: "loop: carries nothing",
  charging: "solar into the controller",
  feed: "controller channel to a load",
  unregulated: "solar straight to a load: unregulated, not supported, carries nothing",
  connected: "connected",
};
const SHORT: Record<GhLineStatus, string> = {
  unplugged: "",
  loose: "✕ loose",
  "wrong-type": "✕ wrong type",
  "out-out": "✕ OUT→OUT",
  "in-in": "✕ IN→IN",
  "shared-port": "✕ shared port",
  supply: "supply",
  delivery: "delivery",
  branch: "branch",
  "no-pump": "✕ no pump",
  loop: "⟲ loop",
  charging: "solar",
  feed: "feed",
  unregulated: "✕ unregulated",
  connected: "",
};

const PLANT_SHORT: Record<PlantState, string> = { healthy: "healthy", wilting: "wilting", "severe-wilt": "severe wilt", waterlogged: "soggy", "heat-stressed": "heat stress" };

export const PLANT_WORDS: Record<PlantState, string> = {
  healthy: "healthy",
  wilting: "wilting (dry)",
  "severe-wilt": "severely wilted",
  waterlogged: "waterlogged",
  "heat-stressed": "heat-stressed",
};

/** Fault notes: safety notes (shown in both conditions) and explanatory notes (DI; PF after the personal gate). */
export function faultNotes(rig: GhRig, showExplanations: boolean): { shown: string[]; withheld: number } {
  const shown: string[] = [];
  let withheld = 0;
  const seen = new Set<string>();
  for (const fault of rig.faults) {
    const note = describeFault(fault, rig);
    if (!note || seen.has(note.text)) continue;
    seen.add(note.text);
    if (note.safety || showExplanations) shown.push(note.text);
    else withheld += 1;
  }
  return { shown, withheld };
}

function describeFault(fault: GhFault, rig: GhRig): { text: string; safety: boolean } | null {
  const line = fault.line ? rig.lines.find((entry) => entry.id === fault.line) : undefined;
  const name = fault.line ? partName(fault.line) : "";
  const ends = line ? line.ends.map((end) => (end === null ? "free" : portLabel(end))).join(" ↔ ") : "";
  switch (fault.kind) {
    case "out-out": return { text: `${name} joins two outlets (${ends}): water only flows from an OUT port to an IN port, so it carries nothing.`, safety: false };
    case "in-in": return { text: `${name} joins two inlets (${ends}): nothing feeds it, so it carries nothing.`, safety: false };
    case "wrong-type": return { text: `${name} is in a port of the wrong type: it carries nothing.`, safety: true };
    case "loose": return { text: `${name} has a loose end (${ends}): an open hose or cable carries nothing.`, safety: true };
    case "shared-port": return { text: `${name} shares a port with another line: both are ignored.`, safety: true };
    case "no-pump": return { text: `${name} runs from the tank straight to a bed. The tank sits below the beds, so nothing flows without the pump in between.`, safety: false };
    case "loop": return { text: `${name} loops back (${ends}): water or power going round in a circle reaches nothing.`, safety: false };
    case "unregulated": return { text: `${name} wires the solar panel straight to a load (${ends}). Unregulated power is not supported: it carries nothing. Solar goes into the controller's SOLAR IN.`, safety: true };
    case "pump-no-supply": return { text: "The pump has no supply hose from TANK OUT: if it runs, it runs dry and delivers 0 L.", safety: false };
    case "pump-no-outlet": return { text: "Nothing leaves PUMP OUT: no water reaches the manifold or a bed.", safety: false };
    case "manifold-closed": return { text: "The manifold's outlets lead nowhere (or both valves are closed): the pump pushes against a closed line and delivers 0 L.", safety: false };
    case "bed-unwatered": return { text: `No open path reaches bed ${fault.bed}: it only loses water today.`, safety: false };
    case "pump-unpowered": return { text: "The pump is not on a controller channel: it never runs.", safety: false };
    case "fan-unpowered": return { text: "The fan is not on a controller channel: nothing cools the air.", safety: false };
    case "no-solar": return { text: "The solar panel does not reach the controller's SOLAR IN: only the battery's 6 Wh are available.", safety: false };
    case "no-probe": return { text: "The soil probe is not in a bed: with no reading, the pump rule never switches the pump on.", safety: false };
    default: return null;
  }
}

// ── Layout (viewBox units ≈ CSS px in the ≈350 px dock, so text stays readable) ────────────────
// Two columns: power on the left (solar → controller → fan, the sensors), water on the right
// (tank → pump → manifold → the two beds).

const VIEW_W = 360;
const VIEW_H = 432;
interface Box { x: number; y: number; w: number; h: number }
const NODES: Record<string, Box> = {
  "solar-panel": { x: 8, y: 8, w: 150, h: 62 },
  "farm-controller": { x: 8, y: 100, w: 150, h: 112 },
  "vent-fan": { x: 8, y: 238, w: 150, h: 62 },
  "temp-sensor": { x: 8, y: 318, w: 150, h: 36 },
  "light-sensor": { x: 8, y: 360, w: 150, h: 36 },
  tank: { x: 196, y: 8, w: 156, h: 54 },
  "water-pump": { x: 196, y: 92, w: 156, h: 62 },
  "valve-manifold": { x: 196, y: 184, w: 156, h: 54 },
  bedA: { x: 196, y: 290, w: 74, h: 80 },
  bedB: { x: 278, y: 290, w: 74, h: 80 },
};
type Side = "l" | "r" | "t" | "b";
/** Port index → anchor on the diagram. */
const PORT_ANCHORS: Array<{ x: number; y: number; side: Side }> = [
  { x: 274, y: 62, side: "b" }, // tank out
  { x: 274, y: 92, side: "t" }, // pump in
  { x: 274, y: 154, side: "b" }, // pump out
  { x: 274, y: 184, side: "t" }, // manifold in
  { x: 232, y: 238, side: "b" }, // valve A out
  { x: 316, y: 238, side: "b" }, // valve B out
  { x: 233, y: 290, side: "t" }, // bed A in
  { x: 315, y: 290, side: "t" }, // bed B in
  { x: 83, y: 70, side: "b" }, // solar out
  { x: 83, y: 100, side: "t" }, // ctrl solar
  { x: 158, y: 132, side: "r" }, // ctrl CH1
  { x: 158, y: 192, side: "r" }, // ctrl CH2
  { x: 196, y: 134, side: "l" }, // pump pwr
  { x: 158, y: 269, side: "r" }, // fan pwr
  { x: 233, y: 370, side: "b" }, // bed A probe
  { x: 233, y: 370, side: "b" },
  { x: 315, y: 370, side: "b" }, // bed B probe
  { x: 315, y: 370, side: "b" },
];
const OUT: Record<Side, [number, number]> = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };

function curve(a: number, b: number): string {
  const p = PORT_ANCHORS[a];
  const q = PORT_ANCHORS[b];
  const reach = Math.max(14, Math.min(60, Math.hypot(q.x - p.x, q.y - p.y) * 0.4));
  const c1 = [p.x + OUT[p.side][0] * reach, p.y + OUT[p.side][1] * reach];
  const c2 = [q.x + OUT[q.side][0] * reach, q.y + OUT[q.side][1] * reach];
  return `M${p.x},${p.y} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${q.x},${q.y}`;
}
/** The point at parameter t of the same cubic (for labels). */
function pointOn(a: number, b: number, t: number): { x: number; y: number } {
  const p = PORT_ANCHORS[a];
  const q = PORT_ANCHORS[b];
  const reach = Math.max(14, Math.min(60, Math.hypot(q.x - p.x, q.y - p.y) * 0.4));
  const c1 = [p.x + OUT[p.side][0] * reach, p.y + OUT[p.side][1] * reach];
  const c2 = [q.x + OUT[q.side][0] * reach, q.y + OUT[q.side][1] * reach];
  const u = 1 - t;
  return {
    x: u * u * u * p.x + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * q.x,
    y: u * u * u * p.y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * q.y,
  };
}

/** What moved along each line in the shown step (litres for hoses, watts for cables). */
export interface LineFlow { litres: number; watts: number; state: "flow" | "idle" | "starved" | "wrong" | "loose" | "off" }

/** Per-line flow in the shown step (`record` = the last completed step, null before the first). */
export function lineFlows(rig: GhRig, record: CompactRecord | null): Map<string, LineFlow> {
  const flows = new Map<string, LineFlow>();
  const pumped = record ? record.beds.A.in + record.beds.B.in : 0;
  for (const line of rig.lines) {
    let flow: LineFlow = { litres: 0, watts: 0, state: "idle" };
    if (line.status === "unplugged") flow.state = "off";
    else if (line.status === "loose") flow.state = "loose";
    else if (isWrongLine(line)) flow.state = "wrong";
    else if (line.type === "water") {
      if (line.status === "supply" || line.status === "delivery") flow = { litres: pumped, watts: 0, state: pumped > 1e-9 ? "flow" : "idle" };
      else if (line.status === "branch") {
        const bed = line.to === GH_PORTS.findIndex((port) => port.key === "bed-a-in") ? "A" : "B";
        const outlet = rig.outlets.find((entry) => entry.from === line.from);
        const litres = record && outlet && outlet.opening > 0 ? record.beds[bed].in : 0;
        flow = { litres, watts: 0, state: litres > 1e-9 ? "flow" : "idle" };
      }
      // A delivery hose straight to a bed: same water as the supply.
    } else if (line.status === "charging") {
      const watts = record ? record.solarW : 0;
      flow = { litres: 0, watts, state: watts > 1e-9 ? "flow" : "idle" };
    } else if (line.status === "feed") {
      const load = line.to === GH_PORTS.findIndex((port) => port.key === "pump-pwr") ? "pump" : "fan";
      const state = !record ? "off" : load === "pump" ? record.pump : record.fan;
      const running = state === "running" || state === "tank-ran-out" || state === "dry-no-supply" || state === "dry-tank-empty" || state === "dead-headed";
      flow = { litres: 0, watts: running ? (load === "pump" ? GH_MODEL.pumpW : GH_MODEL.fanW) : 0, state: running ? "flow" : state === "starved" ? "starved" : "idle" };
    }
    flows.set(line.id, flow);
  }
  return flows;
}

export interface GhDiagramInput {
  rig: GhRig;
  snapshot: GhSnapshot;
  record: CompactRecord | null;
  selected: string | null;
}

const litres = (value: number): string => `${value.toFixed(1)} L`;

/** The resource-flow diagram as SVG. Nodes and edges carry data attributes the tests read. */
export function renderGhDiagramSvg(input: GhDiagramInput): string {
  const { rig, snapshot, record, selected } = input;
  const flows = lineFlows(rig, record);
  const parts: string[] = [];
  parts.push(`<defs>
    <marker id="gd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>
  </defs>`);
  // Lines first (under the nodes).
  for (const line of rig.lines) {
    const flow = flows.get(line.id)!;
    if (flow.state === "off") continue;
    const names = LINE_NAMES[line.id];
    const isSelected = selected === line.id;
    const [a, b] = line.ends;
    const kind = line.type === "water" ? "is-water" : "is-power";
    const state = `is-${flow.state}`;
    const label = flow.state === "flow"
      ? (line.type === "water" ? litres(flow.litres) : `${flow.watts.toFixed(flow.watts < 10 ? 1 : 0)} W`)
      : flow.state === "starved" ? "starved" : flow.state === "idle" ? `${SHORT[line.status]} · idle` : SHORT[line.status];
    const aria = `${names.name}: ${a === null ? "free" : portLabel(a)} to ${b === null ? "free" : portLabel(b)}, ${LINE_STATUS_WORDS[line.status]}${flow.state === "flow" ? `, ${label} this step` : ""}`;
    if (a !== null && b !== null) {
      const from = line.from ?? a;
      const to = line.to ?? b;
      const mid = pointOn(from, to, 0.5);
      // A short, vertical run: the label sits beside it rather than across the nodes.
      const vertical = Math.abs(PORT_ANCHORS[from].x - PORT_ANCHORS[to].x) < 30;
      parts.push(`<g class="gd-edge ${kind} ${state}${isSelected ? " is-selected" : ""}" data-line="${line.id}" data-status="${line.status}" data-flow="${flow.state}" tabindex="0" role="button" aria-label="${escape(aria)}">
        ${isSelected ? `<path class="gd-edge-halo" d="${curve(from, to)}" fill="none"/>` : ""}
        <path class="gd-edge-line" d="${curve(from, to)}" fill="none" ${flow.state === "flow" ? 'marker-end="url(#gd-arrow)"' : ""}/>
        <text class="gd-edge-label${flow.state === "wrong" ? " is-fault" : ""}" x="${(mid.x + (vertical ? 7 : 0)).toFixed(1)}" y="${(mid.y + (vertical ? 4 : -5)).toFixed(1)}" text-anchor="${vertical ? "start" : "middle"}">${escape(`${names.name} · ${label}`)}</text>
      </g>`);
    } else {
      const end = (a ?? b) as number;
      const p = PORT_ANCHORS[end];
      const dx = OUT[p.side][0] * 22 || 16;
      const dy = OUT[p.side][1] * 22 || 14;
      parts.push(`<g class="gd-edge ${kind} is-loose${isSelected ? " is-selected" : ""}" data-line="${line.id}" data-status="loose" data-flow="loose" tabindex="0" role="button" aria-label="${escape(aria)}">
        <path class="gd-edge-line" d="M${p.x},${p.y} l${dx},${dy}" fill="none"/>
        <circle class="gd-open-end" cx="${p.x + dx}" cy="${p.y + dy}" r="5"/>
        <text class="gd-edge-label is-fault" x="${p.x + dx + (dx >= 0 ? 8 : -8)}" y="${p.y + dy + 4}" text-anchor="${dx >= 0 ? "start" : "end"}">${escape(`${names.name} ✕ loose`)}</text>
      </g>`);
    }
  }
  // Probe reading (signal) to the controller.
  if (rig.probe) {
    const anchor = PORT_ANCHORS[rig.probe === "A" ? 14 : 16];
    parts.push(`<path class="gd-signal" d="M${anchor.x - 37},${anchor.y + 17} C170,${anchor.y + 17} 176,214 152,212" fill="none"/>`);
  }
  // The climate sensor's reading reaches the controller (left margin).
  parts.push(`<path class="gd-signal" d="M8,336 C1,336 1,206 8,206" fill="none"/>`);

  const node = (id: string, title: string, lines: string[], selectable: boolean, state: string): void => {
    const box = NODES[id];
    const isSelected = selected === id;
    const attrs = selectable ? ` data-select="${id}" tabindex="0" role="button" aria-label="${escape(`${title}: ${lines.join(", ")}`)}"` : ` role="img" aria-label="${escape(`${title}: ${lines.join(", ")}`)}"`;
    parts.push(`<g class="gd-node${isSelected ? " is-selected" : ""}" data-node="${id}" data-state="${state}"${attrs}>
      <rect class="gd-node-box" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="10"/>
      <text class="gd-node-name" x="${box.x + 8}" y="${box.y + 17}">${escape(title)}</text>
      ${lines.map((text, index) => `<text class="gd-node-value" x="${box.x + 8}" y="${box.y + 33 + index * 14.5}">${escape(text)}</text>`).join("")}
    </g>`);
  };
  const pumpWord = !record ? "off" : record.pump === "running" ? "running" : record.pump === "tank-ran-out" ? "ran the tank dry" : record.pump === "starved" ? "starved (no power)" : record.pump === "dry-no-supply" ? "running dry · no supply" : record.pump === "dead-headed" ? "running · outlet closed" : record.pump === "dry-tank-empty" ? "running dry · tank empty" : "off";
  const tankFraction = snapshot.tank / GH_MODEL.tankLitres;
  node("tank", "Tank", [litres(snapshot.tank), tankFraction <= 0.2 ? "low" : `of ${GH_MODEL.tankLitres} L`], false, snapshot.tank <= 1e-9 ? "fault" : tankFraction <= 0.2 ? "warn" : "ok");
  node("water-pump", "Pump", [pumpWord, `${GH_MODEL.pumpW} W · 6 L/step`], true, !record ? "off" : record.pump === "running" || record.pump === "tank-ran-out" ? "on" : record.pump === "off" ? "off" : "fault");
  node("valve-manifold", "Manifold", [`A ${rig.manifold.valveA} % · B ${rig.manifold.valveB} %`, rig.viaManifold ? "fed" : "not fed"], true, rig.viaManifold ? "ok" : "off");
  for (const bed of ["A", "B"] as const) {
    const theta = snapshot.beds[bed] / GH_MODEL.bedCapacity;
    const state = record ? record.beds[bed].state : theta < GH_MODEL.dryBelow ? "wilting" : theta > GH_MODEL.wetAbove ? "waterlogged" : "healthy";
    node(`bed${bed}`, `Bed ${bed}`, [`soil ${Math.round(theta * 100)} %`, PLANT_SHORT[state as PlantState]], false, state === "healthy" ? "ok" : "warn");
  }
  node("temp-sensor", "Climate sensor", [`air ${snapshot.air.toFixed(1)} °C`], true, snapshot.air > GH_MODEL.heatAbove ? "warn" : "ok");
  node("light-sensor", "Light sensor", [`sun ${Math.round((record?.sun ?? 0) * 100)} %`], true, "ok");
  node("solar-panel", "Solar panel", [rig.solar ? `${(record?.solarW ?? 0).toFixed(1)} W in` : "not to SOLAR IN", "18 W peak"], true, rig.solar ? "ok" : "off");
  node("farm-controller", "Controller", [`battery ${snapshot.battery.toFixed(1)} / 12 Wh`, `pump if soil < ${rig.controller.pumpBelow} %`, `fan if air > ${rig.controller.fanAbove} °C`, `CH1 ${channelWord(rig, 1)} · CH2 ${channelWord(rig, 2)}`], true, "ok");
  const fanWord = !record ? "off" : record.fan === "running" ? "running" : record.fan === "starved" ? "starved (no power)" : "off";
  node("vent-fan", "Fan", [fanWord, `${GH_MODEL.fanW} W · −7 °C`], true, record?.fan === "running" ? "on" : record?.fan === "starved" ? "fault" : "off");
  // The probe: in a bed (under it) or in its holder.
  const probeBox = rig.probe ? { x: rig.probe === "A" ? 196 : 278, y: 378, w: 74, h: 22 } : { x: 196, y: 404, w: 156, h: 22 };
  parts.push(`<g class="gd-node gd-probe${selected === "soil-sensor" ? " is-selected" : ""}" data-select="soil-sensor" data-node="soil-sensor" tabindex="0" role="button" aria-label="${escape(rig.probe ? `Soil probe in bed ${rig.probe}` : "Soil probe in its holder, not in a bed")}">
    <rect class="gd-node-box" x="${probeBox.x}" y="${probeBox.y}" width="${probeBox.w}" height="${probeBox.h}" rx="8"/>
    <text class="gd-probe-label" x="${probeBox.x + probeBox.w / 2}" y="${probeBox.y + probeBox.h / 2 + 4.5}" text-anchor="middle">${rig.probe ? "probe" : "probe · not in a bed"}</text>
  </g>`);
  // Port dots and labels.
  GH_PORTS.forEach((port, index) => {
    if (port.type === "probe") return;
    const p = PORT_ANCHORS[index];
    const used = rig.lines.some((line) => line.ends.includes(index));
    const short = port.label.replace("CONTROLLER ", "").replace(" OUT", " OUT").replace("MANIFOLD ", "").replace("BED A ", "").replace("BED B ", "").replace("VALVE ", "").replace("12 V ", "").replace("PUMP ", "").replace("FAN ", "").replace("TANK ", "").replace("SOLAR IN", "SOLAR");
    const tx = p.side === "l" ? p.x + 6 : p.side === "r" ? p.x - 6 : p.x + 7;
    const ty = p.side === "b" ? p.y - 4 : p.side === "t" ? p.y + 11 : p.y + 3;
    parts.push(`<circle class="${used ? "gd-port-dot" : "gd-port-open"}" cx="${p.x}" cy="${p.y}" r="4.5"/><text class="gd-port-label" x="${tx}" y="${ty}" text-anchor="${p.side === "r" ? "end" : "start"}">${escape(short)}</text>`);
  });
  return `<svg class="gd-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="group" aria-label="Resource flow: water from the tank through the pump and manifold to the beds; power from the solar panel through the controller to the pump and fan">${parts.join("")}</svg>`;
}

function channelWord(rig: GhRig, channel: 1 | 2): string {
  if (rig.pumpChannel === channel) return "pump";
  if (rig.fanChannel === channel) return "fan";
  return "—";
}

/** The connection list (the diagram's text alternative). Buttons select the part. */
export function renderGhConnectionList(rig: GhRig, record: CompactRecord | null): string {
  const flows = lineFlows(rig, record);
  const rows = rig.lines.map((line) => {
    const names = LINE_NAMES[line.id];
    const flow = flows.get(line.id)!;
    const ends = line.ends.every((end) => end === null) ? "in the aisle" : `${line.ends[0] === null ? "free" : portLabel(line.ends[0])} ↔ ${line.ends[1] === null ? "free" : portLabel(line.ends[1])}`;
    const now = flow.state === "flow" ? (names.hose ? ` · ${litres(flow.litres)} this step` : ` · ${flow.watts.toFixed(1)} W this step`) : flow.state === "starved" ? " · starved this step" : "";
    const wrong = flow.state === "wrong" || flow.state === "loose";
    return `<li${wrong ? ' class="gd-open"' : ""}><button type="button" class="sd-link" data-select="${line.id}"><span class="sd-swatch" style="background:${names.css}" aria-hidden="true"></span>${escape(names.name)}</button> ${escape(ends)} · ${escape(LINE_STATUS_WORDS[line.status])}${escape(now)}</li>`;
  });
  rows.push(`<li><button type="button" class="sd-link" data-select="soil-sensor">${escape(FIXTURE_NAMES["soil-sensor"])}</button> ${rig.probe ? `in bed ${rig.probe}'s slot` : "in its holder (no reading)"}</li>`);
  rows.push(`<li><button type="button" class="sd-link" data-select="valve-manifold">${escape(FIXTURE_NAMES["valve-manifold"])}</button> valve A ${rig.manifold.valveA} %, valve B ${rig.manifold.valveB} %</li>`);
  rows.push(`<li><button type="button" class="sd-link" data-select="farm-controller">${escape(FIXTURE_NAMES["farm-controller"])}</button> pump when soil &lt; ${rig.controller.pumpBelow} %, fan when air &gt; ${rig.controller.fanAbove} °C · served first: ${rig.order.length ? escape(rig.order.join(", then ")) : "nothing"}</li>`);
  return `<ul class="sd-list gd-list">${rows.join("")}</ul>`;
}

export const GH_FIXTURES = GH_FIXTURE_IDS;
