/**
 * Sound Flow Studio (Episode 2): the live signal-flow diagram and its text alternative (the
 * connection list), drawn from the patch graph (sound-model.ts) — the same graph that builds the
 * Web Audio graph. Wrong builds stay wrong: OUT→OUT and IN→IN cables, loose ends, loops and
 * unpatched inputs are drawn as patched, each with a text label and a stroke pattern (colour is
 * never the only cue). Pure: returns SVG / HTML strings; nothing from the room is rendered raw.
 */
import {
  CABLE_NAMES,
  describeFault,
  formatDb,
  isSafetyFault,
  jackLabel,
  MODULE_NAMES,
  SOUND_CABLE_IDS,
  SOUND_JACKS,
  SOUND_MODULE_IDS,
  toDb,
  type EdgeStatus,
  type SignalAnalysis,
  type SoundCableId,
  type SoundGraph,
  type SoundModuleId,
} from "./sound-model.ts";

export const CABLE_COLORS: Record<SoundCableId, string> = { "snd-cable-a": "#e0483f", "snd-cable-b": "#e7b416", "snd-cable-c": "#4f86e6" };

// Sized to fit the dock (≈330 px) without horizontal scrolling: the text sizes are in viewBox units.
const NODE_X: Record<SoundModuleId, number> = { "snd-source": 12, "snd-filter": 158, "snd-drive": 304, "snd-speaker": 450 };
const NODE_Y = 64;
const NODE_W = 112;
const NODE_H = 84;
const VIEW_W = 574;
const VIEW_H = NODE_Y + NODE_H + 100;

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

/** Where a jack's port sits on the diagram: IN on the node's left edge, OUT on its right. */
export function portPoint(jack: number): { x: number; y: number } {
  const entry = SOUND_JACKS[jack];
  const x = NODE_X[entry.module];
  return { x: entry.port === "in" ? x : x + NODE_W, y: NODE_Y + NODE_H / 2 };
}

const STATUS_WORDS: Record<EdgeStatus, string> = {
  signal: "carries the tone",
  idle: "connected, but no signal reaches it",
  "out-out": "OUT to OUT: carries nothing",
  "in-in": "IN to IN: carries nothing",
  loop: "feedback loop: silenced (unsupported)",
  "shared-jack": "shares a jack: ignored",
};
const STATUS_SHORT: Record<EdgeStatus, string> = {
  signal: "signal",
  idle: "no signal",
  "out-out": "✕ OUT→OUT",
  "in-in": "✕ IN→IN",
  loop: "⟲ loop · silenced",
  "shared-jack": "✕ shared jack",
};

export interface DiagramOptions {
  /** The selected module or cable (its node/edges are marked). */
  selected: string | null;
  /** Explanatory fault notes allowed (DI always; PF after this learner's own first Test in this session). Safety notes always. */
  showNotes: boolean;
}

/** The signal-flow graph as SVG. Every edge and node carries data attributes the tests read. */
export function renderSoundDiagramSvg(graph: SoundGraph, signal: SignalAnalysis, options: DiagramOptions): string {
  const parts: string[] = [];
  const selectedCable = SOUND_CABLE_IDS.includes(options.selected as SoundCableId) ? options.selected : null;
  const selectedModule = SOUND_MODULE_IDS.includes(options.selected as SoundModuleId) ? (options.selected as SoundModuleId) : null;
  const touchesSelected = (jacks: number[]): boolean => Boolean(selectedModule && jacks.some((jack) => SOUND_JACKS[jack].module === selectedModule));
  parts.push(`<defs>
    <marker id="sd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>
    <pattern id="sd-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="var(--sd-fault)" stroke-width="2.4" opacity="0.55"/></pattern>
  </defs>`);
  // Edges first (under the nodes).
  for (const edge of graph.edges) {
    const color = CABLE_COLORS[edge.cable];
    const [a, b] = edge.from !== undefined && edge.to !== undefined ? [edge.from, edge.to] : edge.jacks;
    const p = portPoint(a);
    const q = portPoint(b);
    const forward = q.x > p.x;
    // Forward OUT→IN edges arch above; anything going back or sideways routes below the nodes.
    const below = !forward || edge.status !== "signal" && edge.status !== "idle";
    const lift = below ? NODE_Y + NODE_H + 40 + SOUND_CABLE_IDS.indexOf(edge.cable) * 30 : NODE_Y - 30 - SOUND_CABLE_IDS.indexOf(edge.cable) * 6;
    const d = `M${p.x},${p.y} C${p.x + (SOUND_JACKS[a].port === "out" ? 60 : -60)},${lift} ${q.x + (SOUND_JACKS[b].port === "out" ? 60 : -60)},${lift} ${q.x},${q.y}`;
    const invalid = edge.status === "out-out" || edge.status === "in-in" || edge.status === "shared-jack";
    const dash = edge.status === "signal" ? "" : edge.status === "idle" ? "10 7" : edge.status === "loop" ? "4 4" : "2 7";
    const selected = edge.cable === selectedCable || touchesSelected(edge.jacks);
    const label = `${CABLE_NAMES[edge.cable]}: ${jackLabel(edge.from ?? edge.jacks[0])} ${edge.from !== undefined ? "→" : "—"} ${jackLabel(edge.to ?? edge.jacks[1])}, ${STATUS_WORDS[edge.status]}`;
    // The curve's extreme is at 0.25·port + 0.75·lift; the label sits just outside it, clear of the curve.
    const extreme = 0.25 * p.y + 0.75 * lift;
    const mid = { x: (p.x + q.x) / 2, y: below ? extreme + 16 : extreme - 8 };
    parts.push(`<g class="sd-edge${selected ? " is-selected" : ""}" data-cable="${edge.cable}" data-status="${edge.status}" data-from="${edge.from ?? edge.jacks[0]}" data-to="${edge.to ?? edge.jacks[1]}" tabindex="0" role="button" aria-label="${escape(label)}" style="color:${color}">
      ${selected ? `<path d="${d}" class="sd-edge-halo" fill="none"/>` : ""}
      <path d="${d}" class="sd-edge-line" fill="none" stroke="${color}" stroke-width="${edge.status === "signal" ? 5 : 4}" ${dash ? `stroke-dasharray="${dash}"` : ""} ${edge.from !== undefined && !invalid ? 'marker-end="url(#sd-arrow)"' : ""}/>
      <text x="${mid.x}" y="${mid.y}" class="sd-edge-label${invalid || edge.status === "loop" ? " is-fault" : ""}" text-anchor="middle">${escape(`${CABLE_NAMES[edge.cable].replace(" cable", "")} · ${STATUS_SHORT[edge.status]}`)}</text>
    </g>`);
  }
  for (const { cable, jack } of graph.loose) {
    const p = portPoint(jack);
    const out = SOUND_JACKS[jack].port === "out";
    const end = { x: p.x + (out ? 34 : -34), y: p.y + 52 };
    const selected = cable === selectedCable || touchesSelected([jack]);
    parts.push(`<g class="sd-edge sd-loose${selected ? " is-selected" : ""}" data-cable="${cable}" data-status="loose" data-from="${jack}" tabindex="0" role="button" aria-label="${escape(`${CABLE_NAMES[cable]}: plugged into ${jackLabel(jack)} only; the other end is loose`)}" style="color:${CABLE_COLORS[cable]}">
      <path d="M${p.x},${p.y} Q${p.x + (out ? 30 : -30)},${p.y + 10} ${end.x},${end.y}" fill="none" stroke="${CABLE_COLORS[cable]}" stroke-width="4" stroke-dasharray="2 7"/>
      <rect x="${end.x - 6}" y="${end.y}" width="12" height="16" rx="3" class="sd-plug"/>
      <text x="${end.x}" y="${end.y + 30}" text-anchor="middle" class="sd-edge-label is-fault">loose end</text>
    </g>`);
  }
  // Nodes.
  const loopModules = new Set(graph.loops.flat());
  for (const id of SOUND_MODULE_IDS) {
    const x = NODE_X[id];
    const live = graph.live[id];
    const inLoop = loopModules.has(id);
    const stage = signal.stages.find((entry) => entry.module === id);
    const level = stage && stage.peak > 1e-6 ? formatDb(toDb(stage.peak)).replace(" dBFS", "") : inLoop ? "silenced" : "—";
    const selected = id === selectedModule;
    const state = inLoop ? "loop" : live ? "signal" : "silent";
    const words = `${MODULE_NAMES[id]}: ${inLoop ? "in a feedback loop, silenced" : live ? `signal ${id === "snd-speaker" ? "received" : "out"}, peak ${level} dBFS` : "no signal"}`;
    parts.push(`<g class="sd-node${selected ? " is-selected" : ""}" data-module="${id}" data-state="${state}" tabindex="0" role="button" aria-label="${escape(words)}">
      <rect x="${x}" y="${NODE_Y}" width="${NODE_W}" height="${NODE_H}" rx="10" class="sd-node-box"/>
      ${inLoop ? `<rect x="${x}" y="${NODE_Y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="url(#sd-hatch)"/>` : ""}
      <text x="${x + NODE_W / 2}" y="${NODE_Y + 32}" text-anchor="middle" class="sd-node-name">${MODULE_NAMES[id]}</text>
      <text x="${x + NODE_W / 2}" y="${NODE_Y + 56}" text-anchor="middle" class="sd-node-level">${escape(state === "signal" ? `${level} dBFS` : state === "loop" ? "⟲ silenced" : "no signal")}</text>
    </g>`);
  }
  // Ports (on top): filled = patched, hollow = open; a ring marks the selected item's ports.
  for (const jack of SOUND_JACKS) {
    const p = portPoint(jack.index);
    const patched = graph.edges.some((edge) => edge.jacks.includes(jack.index)) || graph.loose.some((entry) => entry.jack === jack.index);
    const selected = (selectedModule === jack.module) || graph.edges.some((edge) => edge.cable === selectedCable && edge.jacks.includes(jack.index)) || graph.loose.some((entry) => entry.cable === selectedCable && entry.jack === jack.index);
    parts.push(`<g class="sd-port" data-jack="${jack.index}" data-patched="${patched}">
      ${selected ? `<circle cx="${p.x}" cy="${p.y}" r="13" class="sd-port-ring"/>` : ""}
      <circle cx="${p.x}" cy="${p.y}" r="7" class="${patched ? "sd-port-dot" : "sd-port-open"}"/>
      <text x="${p.x + (jack.port === "out" ? -8 : 8)}" y="${NODE_Y + NODE_H - 8}" text-anchor="${jack.port === "out" ? "end" : "start"}" class="sd-port-label">${jack.port.toUpperCase()}${patched ? "" : " · open"}</text>
    </g>`);
  }
  const notes = graph.faults.filter((fault) => options.showNotes || isSafetyFault(fault));
  return `<svg class="sd-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="group" aria-label="Signal-flow diagram of the patch as built" data-edges="${graph.edges.length}" data-loose="${graph.loose.length}" data-notes="${notes.length}">${parts.join("")}</svg>`;
}

/** The connection list: the diagram's text alternative (every cable and every port, as patched). */
export function renderConnectionList(graph: SoundGraph, signal: SignalAnalysis): string {
  const rows: string[] = [];
  for (const cable of SOUND_CABLE_IDS) {
    const edge = graph.edges.find((entry) => entry.cable === cable);
    const loose = graph.loose.find((entry) => entry.cable === cable);
    let text: string;
    if (edge) {
      const from = edge.from ?? edge.jacks[0];
      const to = edge.to ?? edge.jacks[1];
      const stage = edge.status === "signal" ? signal.stages.find((entry) => entry.module === SOUND_JACKS[from].module) : null;
      text = `${jackLabel(from)} ${edge.from !== undefined ? "→" : "—"} ${jackLabel(to)} · ${STATUS_WORDS[edge.status]}${stage ? ` (${formatDb(toDb(stage.peak))} peak)` : ""}`;
    } else if (loose) text = `${jackLabel(loose.jack)} only · the other end is loose, so it carries nothing`;
    else text = "on the mat, not plugged in";
    rows.push(`<li data-cable="${cable}"><button type="button" class="sd-link" data-select="${cable}"><span class="sd-swatch" style="background:${CABLE_COLORS[cable]}" aria-hidden="true"></span>${escape(CABLE_NAMES[cable])}</button> ${escape(text)}</li>`);
  }
  const open = SOUND_JACKS.filter((jack) => jack.port === "in" && !graph.edges.some((edge) => edge.jacks.includes(jack.index)) && !graph.loose.some((entry) => entry.jack === jack.index));
  if (open.length) rows.push(`<li class="sd-open">Unpatched inputs: ${open.map((jack) => escape(jackLabel(jack.index))).join(", ")}</li>`);
  if (graph.loops.length) rows.push(`<li class="sd-open">Feedback loops (silenced): ${graph.loops.map((loop) => escape(loop.map((id) => MODULE_NAMES[id]).join(" → "))).join("; ")}</li>`);
  return `<ol class="sd-list" aria-label="Connections, as patched">${rows.join("")}</ol>`;
}

/** Fault notes for under the diagram: safety facts always, explanations per the PF/DI rule. */
export function faultNotes(graph: SoundGraph, showNotes: boolean): { shown: string[]; withheld: number } {
  const shown: string[] = [];
  let withheld = 0;
  for (const fault of graph.faults) {
    if (showNotes || isSafetyFault(fault)) shown.push(describeFault(fault));
    else withheld += 1;
  }
  return { shown, withheld };
}
