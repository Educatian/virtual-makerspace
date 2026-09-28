// Self-check for src/desktop/snapino.ts: node --experimental-strip-types scripts/snapino-check.mjs
import assert from "node:assert/strict";
globalThis.window = globalThis;
const { sanitizeProgram, toArduino, clampMs, SnapinoRunner, EXAMPLES } = await import("../src/desktop/snapino.ts");

assert.deepEqual(sanitizeProgram(EXAMPLES.blink.program), EXAMPLES.blink.program);
assert.equal(sanitizeProgram([{ op: "write", pin: "D9", value: true }]), null);
assert.equal(sanitizeProgram([{ op: "eval", code: "x" }]), null);
assert.equal(sanitizeProgram(new Array(25).fill({ op: "wait", ms: 100 })), null);
assert.deepEqual(sanitizeProgram([{ op: "wait", ms: 1 }]), [{ op: "wait", ms: 50 }]);
assert.equal(clampMs(99999), 5000);

const code = toArduino(EXAMPLES.switch.program);
assert.match(code, /pinMode\(5, OUTPUT\)/);
assert.match(code, /pinMode\(2, INPUT\)/);
assert.match(code, /digitalWrite\(5, digitalRead\(2\)\);/);

// runner: follow mirrors the switch, blink toggles, stop drives pins low
let switchOn = true;
const seen = [];
const runner = new SnapinoRunner((pins) => seen.push({ ...pins }), () => switchOn);
runner.start(EXAMPLES.switch.program);
await new Promise((r) => setTimeout(r, 120));
assert.equal(seen.at(-1).D5, true);
switchOn = false;
await new Promise((r) => setTimeout(r, 150));
assert.equal(seen.at(-1).D5, false);
runner.start(EXAMPLES.blink.program);
await new Promise((r) => setTimeout(r, 750));
assert.ok(seen.some((p) => p.D5) && seen.at(-1).D5 === false, "blink toggled");
runner.stop();
assert.deepEqual(seen.at(-1), { D3: false, D5: false, D6: false });
assert.equal(runner.running, false);
console.log("snapino self-check passed");
