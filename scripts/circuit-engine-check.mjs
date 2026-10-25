// Numerical checks for the shared DC circuit engine (src/circuit).
//   node --experimental-strip-types scripts/circuit-engine-check.mjs
import assert from "node:assert/strict";

const { solveCircuit, solveLinear, SOLVER_VERSION, formatAmps, formatOhms } = await import("../src/circuit/dc-engine.ts");
const { analyzeBoard, desktopBoardParts, socketNet, buildBoardNetlist } = await import("../src/circuit/breadboard.ts");
const { sanitizeProps, parseOhms, resistorBands, roundOhms } = await import("../src/circuit/part-props.ts");

let checks = 0;
const near = (actual, expected, tolerance, label) => {
  checks += 1;
  assert.ok(Number.isFinite(actual), `${label}: not finite (${actual})`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
};
const is = (actual, expected, label) => {
  checks += 1;
  assert.deepEqual(actual, expected, label);
};
const codes = (result) => result.diagnostics.map((d) => d.code);
const IDEAL = 0.001; // near-ideal source for textbook checks

// ── Series and parallel resistance (Ohm's law, voltage divider) ─────────────────────────────
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "V", pos: "p", neg: "g", volts: 9, internalOhms: IDEAL },
    { kind: "resistor", id: "R1", a: "p", b: "m", ohms: 1000 },
    { kind: "resistor", id: "R2", a: "m", b: "g", ohms: 2000 },
  ] });
  is(r.status, "ok", "series status");
  near(r.elements.R1.amps, 0.003, 1e-6, "series current = 9 V / 3 kΩ");
  near(r.nodeVolts.m, 6, 1e-3, "divider midpoint = 6 V");
  near(r.elements.V.amps, 0.003, 1e-6, "source delivers the loop current");
  near(r.elements.V.watts, 0.027, 1e-5, "source power = V·I");
  is(r.solver, SOLVER_VERSION, "solver version stamped");
}
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "V", pos: "p", neg: "g", volts: 9, internalOhms: IDEAL },
    { kind: "resistor", id: "R1", a: "p", b: "g", ohms: 1000 },
    { kind: "resistor", id: "R2", a: "p", b: "g", ohms: 1000 },
  ] });
  near(r.elements.V.amps, 0.018, 1e-5, "two 1 kΩ in parallel = 500 Ω → 18 mA");
  near(r.elements.R1.amps, 0.009, 1e-5, "each branch carries half");
}
{
  // KCL at an internal node with three branches.
  const r = solveCircuit({ elements: [
    { kind: "source", id: "V", pos: "p", neg: "g", volts: 12, internalOhms: IDEAL },
    { kind: "resistor", id: "Ra", a: "p", b: "x", ohms: 470 },
    { kind: "resistor", id: "Rb", a: "x", b: "g", ohms: 1000 },
    { kind: "resistor", id: "Rc", a: "x", b: "g", ohms: 2200 },
  ] });
  near(r.elements.Ra.amps - r.elements.Rb.amps - r.elements.Rc.amps, 0, 1e-9, "Kirchhoff's current law holds");
  const parallel = 1 / (1 / 1000 + 1 / 2200);
  near(r.elements.Ra.amps, 12 / (470 + parallel), 1e-6, "series-parallel current");
}

// ── Battery internal resistance (default 1 Ω) ──────────────────────────────────────────────
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "V", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R", a: "p", b: "g", ohms: 9 },
  ] });
  near(r.elements.V.amps, 0.9, 1e-6, "9 V into 9 Ω + 1 Ω internal = 0.9 A");
  near(r.nodeVolts.p, 8.1, 1e-6, "terminal voltage sags under load");
}

// ── LEDs: orientation, 220 Ω vs 1 kΩ, unprotected ──────────────────────────────────────────
const ledLoop = (ohms, reversed = false, volts = 9) => solveCircuit({ elements: [
  { kind: "source", id: "B", pos: "p", neg: "g", volts },
  { kind: "resistor", id: "R", a: "p", b: "m", ohms },
  reversed
    ? { kind: "led", id: "D", anode: "g", cathode: "m", color: "red" }
    : { kind: "led", id: "D", anode: "m", cathode: "g", color: "red" },
] });
{
  const r = ledLoop(1000);
  near(r.elements.D.amps, (9 - 1.9) / (1000 + 15 + 1), 1e-6, "1 kΩ: ~7 mA through a red LED");
  is(r.elements.D.led.state, "lit", "1 kΩ LED is lit within rating");
  is(r.status, "ok", "1 kΩ loop is ok");
  assert.ok(!codes(r).includes("led-overcurrent"));
  near(r.elements.D.volts, 1.9 + r.elements.D.amps * 15, 1e-6, "LED drop = Vf + I·Rs");
  near(r.elements.D.led.brightness, r.elements.D.amps / 0.02, 1e-9, "brightness tracks current");
}
{
  const r = ledLoop(220);
  const amps = r.elements.D.amps;
  near(amps, (9 - 1.9) / (220 + 15 + 1), 1e-6, "220 Ω: ~30 mA");
  assert.ok(amps > 0.028 && amps < 0.033, "9 V − ~2 V over 220 Ω is about 32 mA, not a safe 20 mA example");
  is(r.elements.D.led.state, "overcurrent", "220 Ω at 9 V overdrives the LED");
  assert.ok(codes(r).includes("led-overcurrent"));
  checks += 2;
}
{
  const r = ledLoop(220, false, 5);
  is(r.elements.D.led.state, "lit", "220 Ω is a safe example at 5 V (~13 mA)");
  near(r.elements.D.amps, (5 - 1.9) / 236, 1e-6, "5 V / 220 Ω current");
}
{
  const r = ledLoop(1000, true);
  is(r.elements.D.led.state, "reverse", "reversed LED is detected");
  assert.ok(Math.abs(r.elements.D.amps) < 1e-6, "reversed LED blocks current");
  assert.ok(codes(r).includes("reverse-led"));
  is(r.status, "open-circuit", "no current flows with the LED backwards");
  checks += 2;
}
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "led", id: "D", anode: "p", cathode: "g", color: "red" },
  ] });
  is(r.elements.D.led.state, "burnout", "LED straight on 9 V burns out");
  is(r.elements.D.led.brightness, 0, "a burnt LED is dark, not shown working");
  assert.ok(r.elements.D.amps < 1, "current-limited model keeps currents finite (< 1 A)");
  assert.ok(codes(r).includes("led-burnout"));
  checks += 2;
}
{
  // Green LED has a higher forward drop than red.
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: 1000 },
    { kind: "led", id: "D", anode: "m", cathode: "g", color: "green" },
  ] });
  near(r.elements.D.amps, (9 - 2.1) / 1016, 1e-6, "green LED current");
}
{
  // Two LEDs in series need more voltage: at 3 V nothing lights.
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 3 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: 100 },
    { kind: "led", id: "D1", anode: "m", cathode: "k", color: "red" },
    { kind: "led", id: "D2", anode: "k", cathode: "g", color: "green" },
  ] });
  is(r.elements.D1.led.on, false, "3 V cannot push through two LEDs (needs ~4 V)");
  is(r.status, "open-circuit", "series LEDs below threshold behave as open");
}
{
  // Parallel LEDs of different colors: the converged state must be self-consistent.
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: 330 },
    { kind: "led", id: "Dr", anode: "m", cathode: "g", color: "red" },
    { kind: "led", id: "Dg", anode: "m", cathode: "g", color: "green" },
  ] });
  is(r.solved, true, "parallel LEDs converge");
  assert.ok(r.elements.Dr.amps > r.elements.Dg.amps, "the lower-Vf red LED takes more of the current");
  near(r.elements.R.amps, r.elements.Dr.amps + r.elements.Dg.amps, 1e-7, "KCL with LEDs");
  checks += 1;
}

// ── Open and short circuits ───────────────────────────────────────────────────────────────
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: 1000 },
    { kind: "led", id: "D", anode: "m", cathode: "dangling", color: "red" },
  ] });
  is(r.status, "open-circuit", "open loop status");
  near(r.elements.B.amps, 0, 1e-6, "open loop: no current");
  assert.ok(codes(r).includes("open-circuit"));
  checks += 1;
}
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "wire", id: "W", a: "p", b: "g" },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: 1000 },
    { kind: "led", id: "D", anode: "m", cathode: "g", color: "red" },
  ] });
  is(r.status, "short-circuit", "a wire across the battery is a short");
  is(r.elements.D.led.on, false, "the shorted LED is not shown lit");
  assert.ok(r.elements.W.amps > 1, "short current is large but finite");
  checks += 1;
}
{
  // Battery terminals joined by an ideal strip.
  const r = solveCircuit({ elements: [{ kind: "source", id: "B", pos: "p", neg: "g", volts: 9 }], joins: [["p", "g"]] });
  is(r.status, "short-circuit", "terminals in one strip are a short");
}

// ── Floating parts and islands ───────────────────────────────────────────────────────────
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R", a: "p", b: "g", ohms: 1000 },
    { kind: "led", id: "D", anode: "x", cathode: "y", color: "red" },
  ] });
  is(r.elements.D.led.state, "floating", "an LED in unconnected strips floats");
  is(r.nodeVolts.x, null, "floating nets have no voltage");
  assert.ok(codes(r).includes("floating"));
  checks += 1;
}
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B1", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R1", a: "p", b: "g", ohms: 1000 },
    { kind: "source", id: "B2", pos: "q", neg: "h", volts: 5 },
    { kind: "resistor", id: "R2", a: "q", b: "h", ohms: 500 },
  ] });
  near(r.elements.R2.amps, 0.01 * 500 / 501, 1e-6, "a second, separate battery loop still solves");
  is(r.status, "ok", "two islands status");
}
{
  const r = solveCircuit({ elements: [{ kind: "resistor", id: "R", a: "a", b: "b", ohms: 100 }] });
  is(r.status, "no-source", "no battery → no-source");
  is(r.solved, false, "nothing claimed as solved without a source");
}

// ── Bad input never throws, never passes as valid ───────────────────────────────────────────
for (const [label, netlist] of [
  ["null netlist", null],
  ["elements not an array", { elements: "x" }],
  ["NaN volts", { elements: [{ kind: "source", id: "B", pos: "p", neg: "g", volts: Number.NaN }] }],
  ["Infinity ohms", { elements: [{ kind: "source", id: "B", pos: "p", neg: "g", volts: 9 }, { kind: "resistor", id: "R", a: "p", b: "g", ohms: Infinity }] }],
  ["negative ohms", { elements: [{ kind: "source", id: "B", pos: "p", neg: "g", volts: 9 }, { kind: "resistor", id: "R", a: "p", b: "g", ohms: -5 }] }],
  ["zero ohms", { elements: [{ kind: "source", id: "B", pos: "p", neg: "g", volts: 9 }, { kind: "resistor", id: "R", a: "p", b: "g", ohms: 0 }] }],
  ["string volts", { elements: [{ kind: "source", id: "B", pos: "p", neg: "g", volts: "9" }] }],
  ["huge volts", { elements: [{ kind: "source", id: "B", pos: "p", neg: "g", volts: 1e9 }] }],
  ["missing node", { elements: [{ kind: "source", id: "B", pos: "", neg: "g", volts: 9 }] }],
  ["unknown kind", { elements: [{ kind: "capacitor", id: "C", a: "p", b: "g" }] }],
  ["non-object element", { elements: [42, null, "led"] }],
]) {
  let r;
  assert.doesNotThrow(() => { r = solveCircuit(netlist); }, label);
  assert.ok(r.status !== "ok" || r.rejected.length === 0, `${label}: not reported ok with rejected parts`);
  assert.ok(!Object.values(r.elements).some((e) => e.led?.on), `${label}: nothing lights`);
  for (const reading of Object.values(r.elements)) assert.ok(Number.isFinite(reading.amps) && Number.isFinite(reading.volts), `${label}: finite readings`);
  checks += 1;
}
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: Number.NaN },
    { kind: "led", id: "D", anode: "m", cathode: "g", color: "red" },
  ] });
  is(r.status, "invalid", "a NaN resistor makes the result invalid, not ok");
  is(r.rejected, ["R"], "the invalid part is named");
  is(r.elements.D.led.on, false, "the LED is not shown lit through a missing resistor");
}
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
  ] });
  assert.ok(codes(r).includes("invalid-input"), "duplicate ids are rejected");
  checks += 1;
}
is(solveLinear([[1, 2], [2, 4]], [1, 2]), null, "singular matrix detected");
is(solveLinear([[Number.NaN, 0], [0, 1]], [1, 1]), null, "non-finite matrix rejected");
{
  const x = solveLinear([[0, 1], [1, 0]], [3, 4]);
  near(x[0], 4, 1e-12, "pivoting handles a zero leading entry");
}
{
  // Many parts: bounded time, no hang.
  const elements = [{ kind: "source", id: "B", pos: "n0", neg: "g", volts: 9 }];
  for (let i = 0; i < 150; i += 1) elements.push({ kind: "resistor", id: `R${i}`, a: `n${i}`, b: `n${i + 1}`, ohms: 10 });
  for (let i = 0; i < 20; i += 1) elements.push({ kind: "led", id: `D${i}`, anode: `n${i * 5}`, cathode: "g", color: i % 2 ? "green" : "red" });
  elements.push({ kind: "resistor", id: "Rend", a: "n150", b: "g", ohms: 1000 });
  const started = performance.now();
  const r = solveCircuit({ elements });
  const ms = performance.now() - started;
  assert.ok(r.solved, "large netlist solves");
  assert.ok(ms < 2000, `large netlist solves quickly (${ms.toFixed(0)} ms)`);
  checks += 2;
}

// ── Regressions from the independent review ──────────────────────────────────────────────
for (const joins of [{}, 5, true, "ab"]) {
  assert.doesNotThrow(() => solveCircuit({ elements: [{ kind: "source", id: "B", pos: "p", neg: "g", volts: 9 }], joins }), `joins=${JSON.stringify(joins)}`);
  checks += 1;
}
{
  // A stiff source plus a floating part must not make a working circuit "singular".
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9, internalOhms: 0.001 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: 1000 },
    { kind: "led", id: "D", anode: "m", cathode: "g", color: "red" },
    { kind: "resistor", id: "F", a: "x", b: "y", ohms: 1e6 },
  ] });
  is(r.status, "ok", "stiff source + floating resistor still solves");
  is(r.elements.D.led.state, "lit", "and the LED is lit");
  const many = [{ kind: "source", id: "B", pos: "p", neg: "g", volts: 9 }, { kind: "resistor", id: "R", a: "p", b: "g", ohms: 1000 }];
  for (let i = 0; i < 60; i += 1) many.push({ kind: "wire", id: `W${i}`, a: `f${i}`, b: `f${i + 1}` });
  is(solveCircuit({ elements: many }).status, "ok", "60 floating wires do not make the system singular");
}
{
  // A closed loop with a tiny current is closed, not open.
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 1.5 },
    { kind: "resistor", id: "R1", a: "p", b: "m", ohms: 1e6 },
    { kind: "resistor", id: "R2", a: "m", b: "g", ohms: 1e6 },
  ] });
  is(r.status, "ok", "1.5 V across 2 MΩ is a closed loop (0.75 µA)");
  near(r.elements.R1.amps, 0.75e-6, 1e-9, "tiny loop current");
}
{
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "led", id: "D", anode: "p", cathode: "g", color: "red" },
  ] });
  is(r.status, "unsafe", "a burning-out LED makes the status unsafe, not ok");
  is(ledLoop(220).status, "unsafe", "an overdriven LED makes the status unsafe");
  is(ledLoop(1000).status, "ok", "a safe loop is ok");
}
{
  // Out of iterations: readings stay consistent with the reported LED states, and nothing glows.
  const r = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: 1000 },
    { kind: "led", id: "L", anode: "m", cathode: "g", color: "red" },
    { kind: "led", id: "M", anode: "g", cathode: "m", color: "red" },
  ] }, { maxIterations: 1 });
  is(r.status, "non-convergence", "iteration cap reported");
  for (const id of ["L", "M"]) {
    const reading = r.elements[id];
    assert.ok(!reading.led.on && reading.led.brightness === 0, `${id} is not shown lit when unsolved`);
    assert.ok(Number.isFinite(reading.amps) && reading.led.state !== "lit", `${id}: finite reading, never reported lit when unsolved`);
    checks += 2;
  }
}
{
  const nl = buildBoardNetlist([{ id: "led-red", kind: "led", sockets: [20, 20] }]);
  assert.match(nl.diagnostics[0].message, /both leads in the same hole/);
  checks += 1;
}

// ── Breadboard adapter ────────────────────────────────────────────────────────────────────
is(socketNet(0), 0, "row 0 is the top rail");
is(socketNet(11 * 16 + 3), 1, "row 11 is the bottom rail");
is(socketNet(1 * 16 + 4), socketNet(5 * 16 + 4), "rows 1–5 join in a column");
assert.notEqual(socketNet(5 * 16 + 4), socketNet(6 * 16 + 4), "the trench splits the column");
assert.notEqual(socketNet(3 * 16 + 4), socketNet(3 * 16 + 5), "holes in a row are not joined");
checks += 2;
for (const bad of [-1, 192, 3.5, Number.NaN, "7", null]) is(socketNet(bad), null, `socket ${String(bad)} is rejected`);
{
  const nl = buildBoardNetlist([{ id: "led-red", kind: "led", sockets: [52, 999] }]);
  assert.ok(nl.diagnostics.some((d) => d.code === "invalid-input"), "invalid socket ids are diagnosed");
  is(nl.placed, [], "and excluded");
}
{
  // The scene demo: battery + at r1c5, − at r1c7; 1 kΩ r2c4→c7; LED anode r3c5, cathode r3c4.
  const demo = analyzeBoard(desktopBoardParts({ "battery-9v": [21, 23], "resistor-1k": [36, 39], "led-red": [53, 52] }));
  is(demo.success, true, "demo circuit is a safe success");
  near(demo.result.elements["led-red"].amps, 7.1 / 1016, 1e-5, "demo LED ~7 mA");
  const old = analyzeBoard(desktopBoardParts({ "battery-9v": [21, 23], "resistor-220": [36, 39], "led-red": [52, 53] }));
  is(old.success, false, "the legacy demo (220 Ω, LED reversed) is not a success");
  is(old.reversedLeds, ["led-red"], "legacy demo had the LED backwards");
  // Regression (found in visual QA): floating jumpers elsewhere on the board must not make the
  // working loop "singular".
  const busy = analyzeBoard(desktopBoardParts({ "battery-9v": [21, 23], "resistor-1k": [36, 39], "led-red": [53, 52], "wire-blue": [115, 119], "wire-yellow": [105, 109], "wire-red": [10, 28], "led-green": [137, 138] }));
  is([busy.result.status, busy.success], ["ok", true], "busy board with floating jumpers still solves");
  is(busy.result.elements["led-green"].led.state, "floating", "the unconnected green LED floats");
  const edited = analyzeBoard(desktopBoardParts({ "battery-9v": [21, 23], "resistor-220": [36, 39], "led-red": [53, 52] }, { "resistor-220": { ohms: 470 } }));
  near(edited.result.elements["led-red"].amps, 7.1 / 486, 1e-5, "edited resistance is used");
  const lowVolt = analyzeBoard(desktopBoardParts({ "battery-9v": [21, 23], "resistor-220": [36, 39], "led-red": [53, 52] }, { "battery-9v": { volts: 5 } }));
  is(lowVolt.success, true, "220 Ω at an edited 5 V supply is safe");
}

// ── Fuzz: random breadboard layouts never fail to solve, and success always means a safe LED ──
{
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ids = ["battery-9v", "led-red", "led-green", "resistor-220", "resistor-1k", "wire-red", "wire-blue", "wire-yellow"];
  let successes = 0;
  for (let trial = 0; trial < 3000; trial += 1) {
    const placements = {};
    const used = new Set();
    for (const id of ids) {
      if (random() < 0.25) continue;
      const a = Math.floor(random() * 192);
      // Most parts land near their own column so loops actually form.
      const b = random() < 0.7 ? Math.min(191, Math.max(0, a + Math.floor(random() * 9) - 4 + (random() < 0.5 ? 16 : 0))) : Math.floor(random() * 192);
      if (a === b || used.has(a) || used.has(b)) continue;
      used.add(a);
      used.add(b);
      placements[id] = [a, b];
    }
    const props = { "resistor-220": { ohms: [10, 100, 220, 1000, 1e6][Math.floor(random() * 5)] }, "battery-9v": { volts: [1, 1.5, 5, 9, 12][Math.floor(random() * 5)] } };
    const result = analyzeBoard(desktopBoardParts(placements, props));
    assert.ok(!["singular", "non-convergence", "invalid"].includes(result.result.status), `trial ${trial}: ${result.result.status} ${JSON.stringify(placements)}`);
    if (result.success) {
      successes += 1;
      assert.ok(result.safeLitLeds.every((id) => result.result.elements[id].amps <= 0.021), `trial ${trial}: success means ≤ 20 mA`);
    }
  }
  checks += 3000;
  console.log(`fuzz: 3000 random layouts solved (${successes} safe successes)`);
}

// ── Property validation shared with the room relay ───────────────────────────────────────
is(sanitizeProps("resistor", { ohms: 4700 }), { ohms: 4700 }, "valid ohms");
is(sanitizeProps("resistor", { ohms: 4712 }), { ohms: 4710 }, "ohms rounded to 3 significant figures");
is(sanitizeProps("resistor", { ohms: 5 }), null, "below range rejected");
is(sanitizeProps("resistor", { ohms: 2e6 }), null, "above range rejected");
is(sanitizeProps("resistor", { ohms: "220" }), null, "strings rejected");
is(sanitizeProps("resistor", { volts: 9 }), null, "wrong field for kind rejected");
is(sanitizeProps("battery", { volts: 4.54 }), { volts: 4.5 }, "volts rounded to 0.1 V");
is(sanitizeProps("battery", { volts: 0.2 }), null, "volts below range rejected");
is(sanitizeProps("battery", { volts: Infinity }), null, "non-finite volts rejected");
is(sanitizeProps("battery", ["x"]), null, "arrays rejected");
is(sanitizeProps("battery", { volts: 9, __proto__: { polluted: true } }), { volts: 9 }, "only known fields copied");
is(parseOhms("4.7k"), 4700, "parse 4.7k");
is(parseOhms("220 Ω"), 220, "parse 220 Ω");
is(parseOhms("1M"), 1e6, "parse 1M");
assert.ok(Number.isNaN(parseOhms("1m")), "lowercase m (milli) rejected");
assert.ok(Number.isNaN(parseOhms("<img src=x>")), "markup rejected");
checks += 2;
is(resistorBands(220), ["red", "red", "brown", "gold"], "220 Ω bands");
is(resistorBands(1000), ["brown", "black", "red", "gold"], "1 kΩ bands");
is(resistorBands(4700), ["yellow", "violet", "red", "gold"], "4.7 kΩ bands");
is(resistorBands(10), ["brown", "black", "black", "gold"], "10 Ω bands");
is(resistorBands(4710), null, "three-digit values get a printed label instead");
is(roundOhms(999.6), 1000, "rounding carries");
is(formatAmps(0.00699), "7.0 mA", "format mA");
is(formatOhms(4700), "4.7 kΩ", "format kΩ");

console.log(`circuit engine: ${checks} checks passed (${SOLVER_VERSION})`);
