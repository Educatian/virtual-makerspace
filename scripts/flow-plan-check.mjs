// The Circuit Bench flow view (src/desktop/flow-plan.ts) on real solves (analyzeCircuit → dc-engine):
// what it draws, and that a real but small current is called too small to draw, never zero.
// Parent re-review of ad5cac6 (P3): battery [21,23], 100 kΩ resistor [36,39], red LED [53,54] and
// the red jumper [70,68] solve OK with 70.99 µA in the jumper, yet the note said "no current through
// any jumper wire".
//   node --experimental-strip-types scripts/flow-plan-check.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context);
    throw error;
  }
}`)}`);

const { analyzeCircuit, CIRCUIT_PARTS } = await import("../src/desktop/circuit-topology.ts");
const { planFlow, FLOW_DRAW_MIN_AMPS } = await import("../src/desktop/flow-plan.ts");

let checks = 0;
const ok = (value, label, detail = "") => { checks += 1; assert.ok(value, `${label}${detail ? ` — ${detail}` : ""}`); };
const WIRES = ["wire-red", "wire-blue", "wire-yellow"];
const IDS = [CIRCUIT_PARTS.battery, ...CIRCUIT_PARTS.resistors, ...CIRCUIT_PARTS.leds, ...CIRCUIT_PARTS.wires];
function solve(seated, props = {}) {
  const placements = Object.fromEntries(IDS.map((id) => [id, seated[id] ?? null]));
  const allProps = Object.fromEntries(IDS.map((id) => [id, props[id] ?? null]));
  const analysis = analyzeCircuit(placements, allProps);
  return { analysis, plan: planFlow(analysis.board.result, Boolean(analysis.short), WIRES) };
}

// The re-review's exact bench.
const SMALL = { "battery-9v": [21, 23], "resistor-1k": [36, 39], "led-red": [53, 54], "wire-red": [70, 68] };
{
  const { analysis, plan } = solve(SMALL, { "resistor-1k": { ohms: 100000 } });
  const amps = analysis.board.result.elements["wire-red"]?.amps ?? 0;
  ok(analysis.board.result.status === "ok", "(the small-current bench solves OK)", analysis.board.result.status);
  ok(Math.abs(Math.abs(amps) - 70.98861344090324e-6) < 1e-12, "(the red jumper carries 70.99 µA, as the re-review found)", `${amps}`);
  ok(plan.wires.length === 0, "no arrows below the drawing threshold", JSON.stringify(plan.wires));
  ok(plan.small.length === 1 && plan.small[0].id === "wire-red" && plan.small[0].amps === amps, "the jumper is listed as carrying a small current", JSON.stringify(plan.small));
  ok(!/no current/.test(plan.reason) && /below .*too small to draw \(not zero\)/.test(plan.reason), "the reason says too small to draw, not zero", plan.reason);
}
// The same bench with the stock 1 kΩ: about 7 mA, drawn.
{
  const { analysis, plan } = solve(SMALL);
  ok(plan.reason === "solved" && plan.wires.length === 1 && plan.wires[0].id === "wire-red" && plan.small.length === 0, "1 kΩ: the jumper current is drawn", JSON.stringify(plan));
  const amps = analysis.board.result.elements["wire-red"].amps;
  ok(plan.wires[0].direction === (amps > 0 ? 1 : -1) && Math.abs(amps) > FLOW_DRAW_MIN_AMPS, "drawn in the solved direction", `${amps}`);
}
// Open: the jumper is off the board.
{
  const { analysis, plan } = solve({ ...SMALL, "wire-red": null });
  ok(analysis.board.result.status === "open-circuit" && plan.reason === "open circuit" && !plan.wires.length && !plan.small.length, "open circuit: nothing drawn, and it says why", `${analysis.board.result.status} · ${plan.reason}`);
}
// No supply: the battery is off the board.
{
  const { analysis, plan } = solve({ ...SMALL, "battery-9v": null });
  ok(!plan.wires.length && !plan.small.length && plan.reason !== "solved", "no supply: nothing drawn", `${analysis.board.result.status} · ${plan.reason}`);
}
// Short: a jumper straight across the battery's columns.
{
  const { analysis, plan } = solve({ "battery-9v": [21, 23], "wire-blue": [37, 39] });
  ok(!plan.wires.length && !plan.small.length && /short|could not/.test(plan.reason), "short: nothing drawn", `${analysis.short} ${analysis.board.result.status} · ${plan.reason}`);
}
// Not solved yet, and a pure zero.
ok(planFlow(null, false, WIRES).reason === "not solved yet", "no solve yet: nothing drawn");
ok(planFlow({ status: "ok", elements: { "wire-red": { connected: true, amps: 0 } } }, false, WIRES).reason === "no current through any jumper wire", "a zero current is called no current");

console.log(`flow plan: ${checks} checks passed`);
