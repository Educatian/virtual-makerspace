// Live Snapino diagram (src/circuit/snapino-diagram.ts) against an independent oracle.
//
// The oracle below re-derives connectivity with its own breadth-first search over the snap
// placements (it does not call snapino-circuit.ts), then checks that the diagram:
//  - draws every seated part between exactly the nets its studs are on (wrong wiring stays wrong),
//  - groups studs into rows exactly by snap-wire connectivity,
//  - marks running loads and the switch state as the model defines them,
//  - reports the structural faults the wiring has, and withholds the notes when asked to.
// Curated cases first, then 4,000 random benches.
import { buildSnapinoDiagram, renderSnapinoDiagramSvg, studLabel } from "../src/circuit/snapino-diagram.ts";

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (!ok) {
    failures += 1;
    if (failures <= 25) console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const PADS = { D2: 10, D3: 11, D5: 12, D6: 13, "5V": 14, GND: 15 };
const LOADS = ["sno-l1", "sno-d1", "sno-m1"];
const WIRES = ["sno-w2a", "sno-w2b", "sno-w3", "sno-w4a", "sno-w4b"];
const OUT = ["D3", "D5", "D6"];
const LOW = { D3: false, D5: false, D6: false };

/** Independent connectivity: BFS over edges (wires, and the switch when `withSwitch` and on). */
function components(bench, withSwitch) {
  const edges = new Map();
  const link = (a, b) => {
    edges.set(a, [...(edges.get(a) ?? []), b]);
    edges.set(b, [...(edges.get(b) ?? []), a]);
  };
  const ok = (s) => Array.isArray(s) && s.length === 2 && s[0] !== s[1] && s.every((v) => Number.isInteger(v) && v >= 0 && v < 63);
  for (const id of WIRES) if (ok(bench[id]?.sockets)) link(...bench[id].sockets);
  if (withSwitch && bench["sno-s1"]?.on && ok(bench["sno-s1"]?.sockets)) link(...bench["sno-s1"].sockets);
  const label = new Array(63).fill(-1);
  for (let start = 0; start < 63; start += 1) {
    if (label[start] >= 0) continue;
    const queue = [start];
    label[start] = start;
    while (queue.length) {
      const node = queue.shift();
      for (const next of edges.get(node) ?? []) if (label[next] < 0) { label[next] = start; queue.push(next); }
    }
  }
  return label;
}

function oracle(bench, pins) {
  const ok = (s) => Array.isArray(s) && s.length === 2 && s[0] !== s[1] && s.every((v) => Number.isInteger(v) && v >= 0 && v < 63);
  const net = components(bench, true);
  const short = net[PADS["5V"]] === net[PADS.GND];
  const running = new Set();
  const faults = new Set();
  if (short) faults.add("short");
  else {
    for (const pin of OUT) {
      if (net[PADS[pin]] === net[PADS.GND]) faults.add(`pin-ground:${pin}`);
      else if (net[PADS[pin]] === net[PADS["5V"]]) faults.add(`pin-supply:${pin}`);
    }
    const groups = new Map();
    for (const pin of OUT) {
      const n = net[PADS[pin]];
      if (n === net[PADS.GND] || n === net[PADS["5V"]]) continue;
      groups.set(n, [...(groups.get(n) ?? []), pin]);
    }
    for (const list of groups.values()) if (list.length > 1) faults.add("pins-joined");
  }
  const high = (n) => n !== net[PADS.GND] && (n === net[PADS["5V"]] || OUT.some((pin) => pins[pin] && net[PADS[pin]] === n));
  for (const id of LOADS) {
    const s = bench[id]?.sockets;
    if (!ok(s)) continue;
    const [a, b] = [net[s[0]], net[s[1]]];
    if (a === b) { faults.add(`bypassed:${id}`); continue; }
    const gnd = net[PADS.GND];
    if (a !== gnd && b !== gnd) { faults.add(`no-ground:${id}`); continue; }
    const other = a === gnd ? b : a;
    if (!short) {
      if (other === net[PADS["5V"]]) faults.add(`always-on:${id}`);
      else if (!OUT.some((pin) => net[PADS[pin]] === other)) faults.add(`no-source:${id}`);
      if (high(other)) running.add(id);
    }
  }
  return { short, running, faults };
}

function verify(name, bench, pins) {
  const diagram = buildSnapinoDiagram(bench, pins);
  const truth = oracle(bench, pins);
  const layout = components(bench, false);
  const ok = (s) => Array.isArray(s) && s.length === 2 && s[0] !== s[1] && s.every((v) => Number.isInteger(v) && v >= 0 && v < 63);
  // Rows partition the touched studs exactly by snap-wire connectivity.
  const rowOf = new Map();
  for (const row of diagram.rows) for (const stud of row.studs) rowOf.set(stud, row.key);
  let partitionOk = true;
  for (const [x, rx] of rowOf) for (const [y, ry] of rowOf) if ((rx === ry) !== (layout[x] === layout[y])) partitionOk = false;
  check(`${name}: rows group studs by wire connectivity`, partitionOk);
  check(`${name}: all six pads are on the diagram`, Object.values(PADS).every((stud) => rowOf.has(stud)));
  // Every seated part is drawn between the rows its studs are on — as built.
  for (const id of [...LOADS, "sno-s1"]) {
    const s = bench[id]?.sockets;
    const rung = diagram.rungs.find((entry) => entry.id === id);
    if (!ok(s)) {
      check(`${name}: ${id} unseated is in the tray, not drawn`, !rung && diagram.tray.includes(id));
      continue;
    }
    check(`${name}: ${id} drawn between its studs' rows`, rung && rung.ends[0] === rowOf.get(s[0]) && rung.ends[1] === rowOf.get(s[1]), JSON.stringify(rung?.ends));
    const expected = id === "sno-s1" ? bench[id].on === true : truth.running.has(id);
    check(`${name}: ${id} active state`, rung?.active === expected, `${rung?.active} vs ${expected}`);
  }
  check(`${name}: short flag`, diagram.short === truth.short);
  const got = new Set(diagram.faults.map((fault) => (fault.part ? `${fault.kind}:${fault.part}` : fault.kind === "pin-ground" || fault.kind === "pin-supply" ? `${fault.kind}:${fault.text.slice(0, 2)}` : fault.kind)));
  const same = got.size === truth.faults.size && [...got].every((key) => truth.faults.has(key));
  check(`${name}: structural faults`, same, `diagram ${[...got].join(",")} vs oracle ${[...truth.faults].join(",")}`);
  // Rendering: one focusable element per row and rung; notes withheld when asked.
  const svg = renderSnapinoDiagramSvg(diagram, { showFaults: true, selected: diagram.rungs[0]?.id ?? null });
  const hidden = renderSnapinoDiagramSvg(diagram, { showFaults: false, selected: null });
  check(`${name}: svg rows`, (svg.match(/data-row="/g) ?? []).length === diagram.rows.length);
  check(`${name}: svg rungs`, (svg.match(/data-part="/g) ?? []).length === diagram.rungs.length);
  check(`${name}: every rung and row is keyboard focusable`, (svg.match(/tabindex="0"/g) ?? []).length === diagram.rows.length + diagram.rungs.length);
  const partFaults = diagram.faults.some((fault) => fault.part);
  check(`${name}: fault flags drawn when shown`, !partFaults || svg.includes("dg-flag"));
  check(`${name}: no fault marks when withheld`, !hidden.includes("dg-flag") && !hidden.includes("is-fault"));
  // Logical drive: exactly the loads the independent oracle says run get an overlay.
  const driveSvg = renderSnapinoDiagramSvg(diagram, { showFaults: false, showDrive: true });
  const drivenIds = [...driveSvg.matchAll(/class="dg-rung[^"]*is-driving[^"]*" data-part="([^"]+)"/g)].map((m) => m[1]).sort();
  check(`${name}: drive overlay = running loads only`, JSON.stringify(drivenIds) === JSON.stringify([...truth.running].sort()), `${drivenIds} vs ${[...truth.running]}`);
  return diagram;
}

// ── Curated benches ─────────────────────────────────────────────────────────────
const demo = { "sno-l1": { sockets: [12, 30] }, "sno-w3": { sockets: [30, 33] }, "sno-w2a": { sockets: [33, 15] } };
let d = verify("demo L1 D5→GND, D5 LOW", demo, LOW);
check("demo: L1 between D5 and GND rows", JSON.stringify(d.rungs.find((r) => r.id === "sno-l1").ends) === '["D5","GND"]');
check("demo: no faults", d.faults.length === 0, JSON.stringify(d.faults));
check("demo: L1 can be switched by D5", JSON.stringify(d.drivers["sno-l1"]) === '["D5"]');
d = verify("demo, D5 HIGH", demo, { ...LOW, D5: true });
check("demo D5 HIGH: L1 running, D5 row HIGH", d.rungs.find((r) => r.id === "sno-l1").active && d.rows.find((r) => r.key === "D5").level === "high");

// Wrong: L1 from D5 to D6 (no GND) — drawn exactly so.
d = verify("L1 D5→D6", { "sno-l1": { sockets: [12, 13] } }, { ...LOW, D5: true });
check("D5→D6: rung stays D5–D6", JSON.stringify(d.rungs[0].ends) === '["D5","D6"]');
check("D5→D6: no-ground fault", d.faults.some((f) => f.kind === "no-ground"));

// Bypassed: a wire across L1's studs.
d = verify("bypassed L1", { "sno-l1": { sockets: [12, 30] }, "sno-w2a": { sockets: [12, 30] } }, { ...LOW, D5: true });
check("bypassed: both ends on one row", d.rungs[0].ends[0] === d.rungs[0].ends[1]);
check("bypassed: drawn as a loop", renderSnapinoDiagramSvg(d, { showFaults: true }).includes(" C "));

// Pins joined by a wire: one row labelled "D3 = D5".
d = verify("D3 joined to D5", { "sno-w2a": { sockets: [11, 12] } }, LOW);
check("D3=D5 row label", d.rows.some((r) => r.label === "D3 = D5"));

// Short: 5V wired to GND.
d = verify("5V to GND", { "sno-w2a": { sockets: [14, 15] }, "sno-l1": { sockets: [12, 30] } }, LOW);
check("short: row 5V = GND, short fault", d.rows.some((r) => r.label === "5V = GND" && r.level === "short") && d.faults.some((f) => f.kind === "short"));

// Always-on: L1 from 5V to GND via W2a.
d = verify("always-on", { "sno-l1": { sockets: [14, 32] }, "sno-w2a": { sockets: [32, 15] } }, LOW);
check("always-on: L1 running with all pins LOW", d.rungs[0].active && d.faults.some((f) => f.kind === "always-on"));

// Pin short: D5 wired to GND.
d = verify("D5 to GND", { "sno-w2a": { sockets: [12, 15] } }, { ...LOW, D5: true });
check("D5 on GND: pin-ground fault", d.faults.some((f) => f.kind === "pin-ground"));

// S1 between 5V and D2: open → D2 LOW row; closed → D2 HIGH (input reads high).
d = verify("S1 open", { "sno-s1": { sockets: [14, 10], on: false } }, LOW);
check("S1 open: input low, rung open", !d.inputHigh && d.rungs[0].active === false && d.rows.find((r) => r.key === "D2").level === "low");
d = verify("S1 closed", { "sno-s1": { sockets: [14, 10], on: true } }, LOW);
check("S1 closed: input high, D2 row at 5 V, rung stays visible", d.inputHigh && d.rungs[0].active && d.rows.find((r) => r.key === "D2").level === "supply");
check("stud labels", studLabel(0) === "A-1" && studLabel(12) === "B-4" && studLabel(62) === "G-9");
// A rung crossing rows it does not touch hops over them, and its symbol never sits on one.
{
  const crossing = buildSnapinoDiagram({ "sno-l1": { sockets: [12, 30] }, "sno-w3": { sockets: [30, 33] }, "sno-w2a": { sockets: [33, 15] } }, LOW);
  const svg = renderSnapinoDiagramSvg(crossing, { showFaults: true });
  const lead = svg.match(/data-part="sno-l1"[\s\S]*?class="dg-lead" d="([^"]+)"/)?.[1] ?? "";
  check("D5→GND rung hops over the D6 row (arc, no junction)", / A 5 5 /.test(lead), lead);
  const rowY = [...svg.matchAll(/class="dg-net" x1="[^"]+" y1="([\d.]+)"/g)].map((m) => Number(m[1]));
  const symbolY = Number(svg.match(/data-part="sno-l1"[\s\S]*?<circle cx="[\d.]+" cy="([\d.]+)" r="9"/)?.[1]);
  check("the lamp symbol is not drawn on any row line", Number.isFinite(symbolY) && !rowY.includes(symbolY), `${symbolY} vs rows ${rowY}`);
}

// ── Selection tones (one contract with the 3D rings) and the logical drive overlay ──
{
  const { hotRowTones } = await import("../src/circuit/snapino-diagram.ts");
  const { NET_TONES } = await import("../src/desktop/selection-style.ts");
  const lamp = buildSnapinoDiagram(demo, { ...LOW, D5: true });
  const tones = hotRowTones(lamp, "sno-l1", null);
  check("selected lamp: end A's row is tone a, end B's row tone b", tones.get("D5") === "a" && tones.get("GND") === "b", JSON.stringify([...tones]));
  const svg = renderSnapinoDiagramSvg(lamp, { selected: "sno-l1", showFaults: true });
  check("rows carry the tone classes and letter badges", /data-row="D5"[^>]*|class="dg-row[^"]*is-hot-a[^"]*" data-row="D5"/.test(svg) && /class="dg-row[^"]*is-hot-a[^"]*" data-row="D5"/.test(svg) && /class="dg-row[^"]*is-hot-b[^"]*" data-row="GND"/.test(svg) && />A<\/text><\/g>/.test(svg) && />B<\/text><\/g>/.test(svg));
  check("the contract's colours reach the SVG as CSS variables", svg.includes(`--tone-a:${NET_TONES.a.css}`) && svg.includes(`--tone-b:${NET_TONES.b.css}`));
  check("tone cues are not colour-only (letters and patterns differ)", NET_TONES.a.letter !== NET_TONES.b.letter && NET_TONES.a.pattern !== NET_TONES.b.pattern && NET_TONES.fault.pattern !== NET_TONES.a.pattern);
  const bypass = buildSnapinoDiagram({ "sno-l1": { sockets: [12, 30] }, "sno-w2a": { sockets: [12, 30] } }, LOW);
  check("a bypassed selection is one 'fault' row", JSON.stringify([...hotRowTones(bypass, "sno-l1", null)]) === JSON.stringify([[bypass.rungs[0].ends[0], "fault"]]));
  check("a chosen row without a selection is tone a", JSON.stringify([...hotRowTones(lamp, null, "D5")]) === '[["D5","a"]]');
  // Drive overlay: only on a running load, pointing at its GND end.
  const driven = renderSnapinoDiagramSvg(lamp, { showFaults: true, showDrive: true });
  check("drive overlay drawn for the running lamp", /data-part="sno-l1"[^>]*is-driving|class="dg-rung[^"]*is-driving[^"]*" data-part="sno-l1"/.test(driven) && driven.includes("dg-drive-head"));
  const idle = renderSnapinoDiagramSvg(buildSnapinoDiagram(demo, LOW), { showFaults: true, showDrive: true });
  check("no drive overlay when the lamp is not running (pin LOW)", !idle.includes("dg-drive"));
  const shorted = renderSnapinoDiagramSvg(buildSnapinoDiagram({ ...demo, "sno-w4a": { sockets: [14, 15] } }, { ...LOW, D5: true }), { showFaults: true, showDrive: true });
  check("no drive overlay through a short (5V = GND: nothing runs)", !shorted.includes("dg-drive"));
  const open = renderSnapinoDiagramSvg(buildSnapinoDiagram({ "sno-l1": { sockets: [12, 13] } }, { ...LOW, D5: true }), { showFaults: true, showDrive: true });
  check("no drive overlay on an open path (no GND)", !open.includes("dg-drive"));
  const bypassDriven = renderSnapinoDiagramSvg(buildSnapinoDiagram({ "sno-l1": { sockets: [12, 30] }, "sno-w2a": { sockets: [12, 30] }, "sno-w3": { sockets: [30, 33] } }, { ...LOW, D5: true }), { showFaults: true, showDrive: true });
  check("no drive overlay on a bypassed lamp", !bypassDriven.includes("dg-drive"));
  // Direction: the arrowhead sits at the GND row's end of the rung.
  const rowY = Object.fromEntries([...driven.matchAll(/data-row="([^"]+)"[\s\S]*?class="dg-net" x1="[^"]+" y1="([\d.]+)"/g)].map((m) => [m[1], Number(m[2])]));
  const head = driven.match(/class="dg-drive-head" d="M [\d.]+ ([\d.]+) L [\d.]+ ([\d.]+)/);
  check("the drive arrow points at GND (its tip is next to the GND row)", head && Math.abs(Number(head[2]) - rowY.GND) <= 4, `${head?.[2]} vs GND ${rowY.GND}`);
  // A lamp drawn upside down (GND row above? never: GND sorts last), so also check a 5V-driven lamp.
  const fiveV = renderSnapinoDiagramSvg(buildSnapinoDiagram({ "sno-l1": { sockets: [14, 32] }, "sno-w3": { sockets: [32, 15] } }, LOW), { showFaults: true, showDrive: true });
  check("an always-on 5V lamp is drawn as driven (it does run)", fiveV.includes("dg-drive-head"));
}

// A lamp whose GND end is reached only through a closed S1: still driven, arrow toward that end.
{
  const viaSwitch = buildSnapinoDiagram({ "sno-l1": { sockets: [12, 30] }, "sno-s1": { sockets: [30, 15], on: true } }, { ...LOW, D5: true });
  check("lamp grounded through closed S1 runs and gets a drive overlay", viaSwitch.rungs.find((r) => r.id === "sno-l1").active && renderSnapinoDiagramSvg(viaSwitch, { showFaults: true, showDrive: true }).includes("dg-drive-head"));
  check("its sink is the end that reaches GND through the switch", viaSwitch.rungs.find((r) => r.id === "sno-l1").sink === 1);
}

// ── Random benches ──────────────────────────────────────────────────────────────
let seed = 20261026;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = () => Math.floor(rand() * 63);
for (let index = 0; index < 4000; index += 1) {
  const bench = {};
  for (const id of [...LOADS, "sno-s1", ...WIRES]) {
    if (rand() < 0.35) continue;
    // Bias toward pads so faults and running loads are common.
    const a = rand() < 0.4 ? 10 + Math.floor(rand() * 6) : pick();
    let b = rand() < 0.3 ? 10 + Math.floor(rand() * 6) : pick();
    if (b === a) b = (a + 9) % 63;
    bench[id] = { sockets: [a, b], ...(id === "sno-s1" ? { on: rand() < 0.5 } : {}) };
  }
  const pins = { D3: rand() < 0.5, D5: rand() < 0.5, D6: rand() < 0.5 };
  verify(`random ${index}`, bench, pins);
}

console.log(`${checks - failures}/${checks} diagram checks passed`);
if (failures) process.exit(1);
