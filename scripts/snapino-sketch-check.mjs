// Syntax-checks generated Snapino sketches with the host C++ compiler against a minimal stub
// of Arduino.h. This proves the generated C++ is well-formed and only uses the Arduino calls
// it should; it is NOT an AVR build, upload or emulation.
//   node --experimental-strip-types scripts/snapino-sketch-check.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

globalThis.window = globalThis;
const { toArduinoSketch, EXAMPLES, sanitizeProgram, OUTPUT_PINS } = await import("../src/desktop/snapino.ts");

const compiler = ["g++", "clang++"].find((name) => spawnSync(name, ["--version"]).status === 0);
if (!compiler) {
  console.log("snapino sketch: SKIPPED (no g++ or clang++ on PATH)");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "snapino-"));
// Only what the generated sketches may use. Anything else fails to compile.
writeFileSync(join(dir, "Arduino.h"), `#pragma once
#include <stdint.h>
#define HIGH 0x1
#define LOW 0x0
#define INPUT 0x0
#define OUTPUT 0x1
void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t value);
int digitalRead(uint8_t pin);
void delay(unsigned long ms);
`);

const programs = Object.entries(EXAMPLES).map(([name, example]) => [name, example.program]);
programs.push(["empty", []]);
// Deterministic pseudo-random programs covering every statement form.
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
for (let i = 0; i < 12; i += 1) {
  const program = [];
  for (let j = 0; j < 1 + Math.floor(random() * 10); j += 1) {
    const pin = OUTPUT_PINS[Math.floor(random() * OUTPUT_PINS.length)];
    const pick = random();
    program.push(pick < 0.4 ? { op: "write", pin, value: random() < 0.5 } : pick < 0.75 ? { op: "wait", ms: Math.round(random() * 6000) } : { op: "follow", pin, invert: random() < 0.5 });
  }
  programs.push([`random-${i}`, sanitizeProgram(program)]);
}

let compiled = 0;
try {
  for (const [name, program] of programs) {
    assert.ok(program, `${name} sanitizes`);
    const sketch = toArduinoSketch(program, new Date("2026-10-25T00:00:00Z"));
    assert.match(sketch, /does not compile|did not compile/i, "the sketch header states the bench did not compile it");
    const file = join(dir, `${name}.cpp`);
    writeFileSync(file, sketch);
    execFileSync(compiler, ["-fsyntax-only", "-Wall", "-Werror", "-std=c++11", "-I", dir, "-include", "Arduino.h", file], { stdio: "pipe" });
    compiled += 1;
  }
  // A deliberately broken sketch must fail, so the check can actually catch errors.
  const broken = join(dir, "broken.cpp");
  writeFileSync(broken, "void setup() { digitalWrite(5, HIGH) }\nvoid loop() {}\n");
  assert.throws(() => execFileSync(compiler, ["-fsyntax-only", "-I", dir, "-include", "Arduino.h", broken], { stdio: "pipe" }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`snapino sketch: ${compiled} generated sketches pass ${compiler} -fsyntax-only (stub Arduino.h; not an AVR build)`);
