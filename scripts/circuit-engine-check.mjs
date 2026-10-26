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
  // Backwards at 3 V: blocked (open), and within the LED's 5 V reverse maximum.
  const r = ledLoop(1000, true, 3);
  is(r.elements.D.led.state, "reverse", "reversed LED is detected");
  assert.ok(Math.abs(r.elements.D.amps) < 1e-6, "reversed LED blocks current");
  assert.ok(codes(r).includes("reverse-led"));
  assert.ok(!codes(r).includes("led-reverse-overvoltage"), "3 V reverse is within the 5 V maximum");
  is(r.status, "open-circuit", "no current flows with the LED backwards");
  checks += 3;
}
{
  // Backwards at 9 V: the whole ~9 V sits across the LED in reverse — beyond a typical 5 V
  // maximum, so it is unsafe (never "ok", never a success), not merely open.
  const r = ledLoop(1000, true, 9);
  is(r.elements.D.led.state, "reverse", "reversed LED at 9 V is detected");
  near(r.elements.D.volts, -9, 0.01, "nearly the full 9 V is across the reversed LED");
  assert.ok(codes(r).includes("led-reverse-overvoltage"));
  is(r.diagnostics.find((d) => d.code === "led-reverse-overvoltage").severity, "error", "reverse overvoltage is an error");
  is(r.status, "unsafe", "9 V in reverse is unsafe");
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

// ── Regressions from the PR #3 acceptance review (exact reported cases) ──────────────────────
{
  // A forward red LED lit safely, plus a green LED wired backwards across the 9 V supply
  // (through the red jumper): the green LED sees ~9 V in reverse. Previously a "success".
  const board = analyzeBoard(desktopBoardParts({
    "battery-9v": [21, 23], "resistor-1k": [36, 39], "led-red": [53, 52], "led-green": [71, 70], "wire-red": [86, 85],
  }));
  is(board.result.elements["led-red"].led.state, "lit", "the red LED itself is lit");
  is(board.result.elements["led-green"].led.state, "reverse", "the green LED is reversed");
  assert.ok(board.result.elements["led-green"].volts < -5, "with more than 5 V in reverse");
  assert.ok(codes(board.result).includes("led-reverse-overvoltage"), "reverse overvoltage is diagnosed");
  is(board.result.status, "unsafe", "the board is unsafe");
  is(board.success, false, "and is never a success");
  checks += 2;
}
{
  // The 330 Ω preset at 9 V: (9 − 1.9) / (330 + 15 + 1) = 20.52 mA, above the 20 mA rating.
  const expected = (9 - 1.9) / (330 + 15 + 1);
  const board = analyzeBoard(desktopBoardParts({ "battery-9v": [21, 23], "resistor-220": [36, 39], "led-red": [53, 52] }, { "resistor-220": { ohms: 330 } }));
  near(board.result.elements["led-red"].amps, expected, 1e-9, "330 Ω at 9 V = 20.52 mA");
  is(board.result.elements["led-red"].led.state, "overcurrent", "20.52 mA is over the 20 mA rating (no 5% grace)");
  is([board.result.status, board.success], ["unsafe", false], "so it is unsafe, not a success");
}
{
  // A direct jumper short at 1 V: 1 V / (1 Ω internal + 0.05 Ω) ≈ 0.95 A, under the 1 A
  // current threshold — still a short (jumpers alone between the terminals).
  const board = analyzeBoard(desktopBoardParts({ "battery-9v": [21, 23], "wire-red": [37, 39] }, { "battery-9v": { volts: 1 } }));
  near(board.result.elements["battery-9v"].amps, 1 / 1.05, 1e-6, "≈ 0.95 A");
  is(board.result.status, "short-circuit", "a 1 V jumper short is a short circuit");
  is(board.short, true, "reported as short");
  is(board.success, false, "never a success");
}
{
  // Cells in series: each cell's loop runs through the other one. Previously "open-circuit".
  const r = solveCircuit({ elements: [
    { kind: "source", id: "A", pos: "x", neg: "g", volts: 1.5 },
    { kind: "source", id: "B", pos: "p", neg: "x", volts: 1.5 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: 47 },
    { kind: "led", id: "D", anode: "m", cathode: "g", color: "red" },
  ] });
  const expected = (3 - 1.9) / (47 + 15 + 2);
  near(r.elements.D.amps, expected, 1e-9, "two 1.5 V cells in series drive (3 − 1.9) / 64 Ω");
  is(r.status, "ok", "series cells form a closed loop");
  is(r.elements.D.led.state, "lit", "and light the LED");
  // Opposing cells: the net 0 V cannot push the LED on — open, as expected.
  const opposed = solveCircuit({ elements: [
    { kind: "source", id: "A", pos: "x", neg: "g", volts: 1.5 },
    { kind: "source", id: "B", pos: "x", neg: "p", volts: 1.5 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: 47 },
    { kind: "led", id: "D", anode: "m", cathode: "g", color: "red" },
  ] });
  is(opposed.status, "open-circuit", "opposing cells leave the LED off: open");
}
{
  // Invalid input is the most severe status, whatever else is wrong.
  const unsafe = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: Number.NaN },
    { kind: "led", id: "D", anode: "p", cathode: "g", color: "red" },
  ] });
  is(unsafe.elements.D.led.state, "burnout", "the remaining LED burns out");
  is(unsafe.status, "invalid", "but a NaN resistor makes the status invalid (not unsafe)");
  const shorted = solveCircuit({ elements: [
    { kind: "source", id: "B", pos: "p", neg: "g", volts: 9 },
    { kind: "resistor", id: "R", a: "p", b: "m", ohms: -5 },
    { kind: "wire", id: "W", a: "p", b: "g" },
  ] });
  is(shorted.status, "invalid", "invalid outranks a short circuit");
  const board = analyzeBoard(desktopBoardParts({ "battery-9v": [21, 23], "resistor-1k": [36, 39], "led-red": [53, 52] }, { "resistor-1k": { ohms: Number.NaN } }));
  is(board.result.status, "invalid", "a NaN resistance on the board is invalid");
  is(board.success, false, "and never a success");
}
{
  // Exact rating boundary: I = (9 − 1.9) / (R + 16). R = 339 Ω gives 20 mA; just above the
  // resistance is within rating, just below is over it.
  const at = (ohms) => ledLoop(ohms, false, 9);
  const below = at(339.5);
  assert.ok(below.elements.D.amps < 0.02, "339.5 Ω is just under 20 mA");
  is([below.elements.D.led.state, below.status], ["lit", "ok"], "just under the rating: lit and ok");
  const above = at(338.5);
  assert.ok(above.elements.D.amps > 0.02, "338.5 Ω is just over 20 mA");
  is([above.elements.D.led.state, above.status], ["overcurrent", "unsafe"], "just over the rating: overcurrent and unsafe");
  near(at(339).elements.D.amps, 0.02, 1e-9, "339 Ω sits on the 20 mA boundary");
  // Reverse-voltage boundary: 4.9 V backwards is tolerated, 5.1 V is not.
  is(codes(ledLoop(1000, true, 4.9)).includes("led-reverse-overvoltage"), false, "4.9 V reverse is within the maximum");
  is(codes(ledLoop(1000, true, 5.1)).includes("led-reverse-overvoltage"), true, "5.1 V reverse exceeds it");
  checks += 2;
}

// ── Generated loops vs an independent closed-form expectation ─────────────────────────────
// Battery + → resistor → LED → battery − at random columns, halves, orientations, colors and
// values. Expected current from the documented model alone (not the engine):
//   I = max(0, V − Vf) / (R + 15 Ω LED series + 1 Ω battery);  safe success ⇔ 2 mA < I ≤ 20 mA.
// Each safe base also gets unsafe variants that must never succeed.
const generatedLoops = [];
{
  let seed = 2026;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const VF = { red: 1.9, green: 2.1 };
  let successes = 0;
  let unsafeCount = 0;
  let variants = 0;
  for (let trial = 0; trial < 2000; trial += 1) {
    const cols = [];
    while (cols.length < 3) {
      const col = Math.floor(random() * 16);
      if (!cols.includes(col)) cols.push(col);
    }
    const [pCol, nCol, mCol] = cols;
    const half = random() < 0.5 ? 1 : 6; // first row of the top or bottom half
    const hole = (rowOffset, col) => (half + rowOffset) * 16 + col;
    const volts = Math.round((1 + random() * 11) * 10) / 10;
    const ohms = random() < 0.5 ? pick([100, 220, 330, 470, 1000, 2200, 4700, 10000]) : roundOhms(10 + random() * 4990);
    const ledId = random() < 0.5 ? "led-red" : "led-green";
    const color = ledId === "led-red" ? "red" : "green";
    const resistorId = random() < 0.5 ? "resistor-220" : "resistor-1k";
    const flipResistor = random() < 0.5;
    const placements = {
      "battery-9v": [hole(0, pCol), hole(0, nCol)],
      [resistorId]: flipResistor ? [hole(1, mCol), hole(1, pCol)] : [hole(1, pCol), hole(1, mCol)],
      [ledId]: [hole(2, mCol), hole(2, nCol)],
    };
    const props = { "battery-9v": { volts }, [resistorId]: { ohms } };
    const expected = Math.max(0, volts - VF[color]) / (ohms + 16);
    if (Math.abs(expected - 0.02) < 1e-7 || Math.abs(expected - 0.002) < 1e-7) continue;
    const expectSuccess = expected > 0.002 && expected <= 0.02;
    const board = analyzeBoard(desktopBoardParts(placements, props));
    near(board.result.elements[ledId].amps, expected, 1e-7, `generated ${trial}: LED current matches the closed form`);
    is(board.success, expectSuccess, `generated ${trial}: success iff 2 mA < I ≤ 20 mA (I = ${(expected * 1000).toFixed(2)} mA)`);
    if (expectSuccess) {
      successes += 1;
      generatedLoops.push({ placements, props });
      is(board.result.status, "ok", `generated ${trial}: a safe loop is ok`);
      // Unsafe variants of a safe loop never succeed.
      const reversed = analyzeBoard(desktopBoardParts({ ...placements, [ledId]: [hole(2, nCol), hole(2, mCol)] }, props));
      is(reversed.success, false, `generated ${trial}: reversed LED is not a success`);
      is(reversed.result.status, volts > 5 + 1e-9 ? "unsafe" : "open-circuit", `generated ${trial}: reversed LED is ${volts > 5 ? "unsafe (over 5 V reverse)" : "open"}`);
      const otherResistor = resistorId === "resistor-220" ? "resistor-1k" : "resistor-220";
      const bypassed = analyzeBoard(desktopBoardParts({ ...placements, [resistorId]: null, "wire-red": placements[resistorId] }, props));
      // Without the resistor only the LED's 15 Ω, the 1 Ω cell and the 0.05 Ω jumper limit it.
      const bypassAmps = Math.max(0, volts - VF[color]) / 16.05;
      if (Math.abs(bypassAmps - 0.02) > 1e-7) {
        is(bypassed.success, bypassAmps > 0.002 && bypassAmps <= 0.02, `generated ${trial}: a jumper instead of the resistor succeeds only if ${(bypassAmps * 1000).toFixed(1)} mA is safe`);
        if (bypassAmps > 0.02) is(bypassed.result.status, "unsafe", `generated ${trial}: bypassed resistor overdrives the LED`);
      }
      const shorted = analyzeBoard(desktopBoardParts({ ...placements, "wire-blue": [hole(3, pCol), hole(3, nCol)] }, props));
      is([shorted.result.status, shorted.success], ["short-circuit", false], `generated ${trial}: a jumper across the battery is a short`);
      const tooSmall = analyzeBoard(desktopBoardParts({ ...placements, [resistorId]: null, [otherResistor]: placements[resistorId] }, { ...props, [otherResistor]: { ohms: 10 } }));
      if ((volts - VF[color]) / 26 > 0.02) is(tooSmall.success, false, `generated ${trial}: 10 Ω overdrives the LED`);
      variants += 4;
    } else if (expected > 0.02) {
      unsafeCount += 1;
      is(board.result.status, "unsafe", `generated ${trial}: an overdriven loop is unsafe`);
    }
  }
  assert.ok(successes > 100, `generated loops include safe successes (${successes})`);
  assert.ok(unsafeCount > 100, `and overdriven ones (${unsafeCount})`);
  console.log(`generated: ${successes} safe loops succeeded, ${unsafeCount} overdriven loops refused, ${variants} variants checked (reversed, bypassed, shorted, 10 Ω)`);
}

// ── Fuzz: random breadboard layouts never fail to solve, and success always means a safe LED ──
{
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ids = ["battery-9v", "led-red", "led-green", "resistor-220", "resistor-1k", "wire-red", "wire-blue", "wire-yellow"];
  let successes = 0;
  for (let trial = 0; trial < 3000; trial += 1) {
    // Some trials start from a known safe loop and scatter the remaining parts around it.
    const base = random() < 0.4 ? generatedLoops[Math.floor(random() * generatedLoops.length)] : null;
    const placements = base ? { ...base.placements } : {};
    const used = new Set(Object.values(placements).flat());
    for (const id of ids) {
      if (placements[id]) continue;
      if (random() < 0.25) continue;
      const a = Math.floor(random() * 192);
      // Most parts land near their own column so loops actually form.
      const b = random() < 0.7 ? Math.min(191, Math.max(0, a + Math.floor(random() * 9) - 4 + (random() < 0.5 ? 16 : 0))) : Math.floor(random() * 192);
      if (a === b || used.has(a) || used.has(b)) continue;
      used.add(a);
      used.add(b);
      placements[id] = [a, b];
    }
    const props = base ? base.props : { "resistor-220": { ohms: [10, 100, 220, 1000, 1e6][Math.floor(random() * 5)] }, "battery-9v": { volts: [1, 1.5, 5, 9, 12][Math.floor(random() * 5)] } };
    const result = analyzeBoard(desktopBoardParts(placements, props));
    assert.ok(!["singular", "non-convergence", "invalid"].includes(result.result.status), `trial ${trial}: ${result.result.status} ${JSON.stringify(placements)}`);
    if (result.success) {
      successes += 1;
      assert.ok(result.safeLitLeds.length > 0 && result.safeLitLeds.every((id) => result.result.elements[id].amps <= 0.02), `trial ${trial}: success means a lit LED at ≤ 20 mA`);
      assert.ok(result.result.status === "ok", `trial ${trial}: success means status ok`);
      assert.ok(!result.diagnostics.some((d) => d.severity === "error"), `trial ${trial}: success means no error anywhere`);
      for (const reading of Object.values(result.result.elements)) {
        if (reading.led) assert.ok(!["overcurrent", "burnout"].includes(reading.led.state) && !(reading.led.state === "reverse" && reading.volts < -5), `trial ${trial}: no LED is unsafe in a success`);
      }
      checks += 4;
    }
  }
  assert.ok(successes > 0, "the fuzz exercises the success path");
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
