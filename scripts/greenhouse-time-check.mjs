// Resource-Limited Greenhouse: model time is never lost to run actions. The review counterexample
// (PR #6, app faa7c09): a valid same-speed action (×1) every 1000 ms, 240 times, left the day at
// tick 0 after 240 000 ms — each settle floored the elapsed steps and reset the anchor to now.
// Here: same-speed no-ops, pause/resume, speed changes and settles at arbitrary moments keep the
// part of a step already elapsed, so the tick equals the running time, whatever the action rate.
//
//   node scripts/greenhouse-time-check.mjs [cloudflare-dir]
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const dir = resolve(process.argv[2] ?? new URL("../cloudflare", import.meta.url).pathname);
const load = (name) => import(pathToFileURL(`${dir}/${name}`).href);
const model = await load("greenhouse-model.js");
const runs = await load("greenhouse-run.js");

let passed = 0;
const failed = [];
const check = (value, label, detail = "") => {
  if (value) passed += 1;
  else failed.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${value ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const rig = model.deriveRig((id) => ({ "irrigation-hose": { sockets: [0, 1] }, "irrigation-hose-2": { sockets: [2, 3] }, "irrigation-hose-3": { sockets: [4, 6] }, "irrigation-hose-4": { sockets: [5, 7] }, "power-cable-1": { sockets: [8, 9] }, "power-cable-2": { sockets: [10, 12] }, "power-cable-3": { sockets: [11, 13] }, "soil-sensor": { sockets: [14, 15] }, "valve-manifold": { props: { valveA: 30, valveB: 50 } }, "farm-controller": { props: { pumpBelow: 60, fanAbove: 26 } } })[id] ?? null);
const S = runs.STEP_MS;
const apply = (run, action, now) => {
  const result = runs.reduceGreenhouseRun(run, action, now, rig);
  return result.ok ? result.run : run;
};
const roundTrip = (run) => runs.sanitizeGreenhouseRun(JSON.parse(JSON.stringify(run)));

// 1. The counterexample: speed ×1 (the same speed) every 1000 ms, 240 times.
{
  let run = apply(runs.initialRun(), { type: "start" }, 0);
  for (let i = 1; i <= 240; i += 1) run = roundTrip(apply(run, { type: "speed", speed: 1 }, i * 1000));
  const tick = runs.currentTick(run, 240_000);
  check(tick === 96, "1 a same-speed action every second for 240 s leaves the day at the tick its running time gives (96)", `tick ${tick}`);
}
// 2. Pause and resume every 1000 ms: running half the time gives half the steps.
{
  let run = apply(runs.initialRun(), { type: "start" }, 0);
  let t = 0;
  for (let i = 0; i < 100; i += 1) {
    t += 1000;
    run = roundTrip(apply(run, { type: "pause" }, t));
    t += 1000;
    run = roundTrip(apply(run, { type: "resume" }, t));
  }
  const tick = runs.currentTick(run, t);
  check(tick === 40, "2 pausing and resuming every second: 100 s of running time gives 40 steps (×1)", `tick ${tick}`);
}
// 3. A speed change keeps the part of the step already elapsed.
{
  let run = apply(runs.initialRun(), { type: "start" }, 0);
  run = apply(run, { type: "speed", speed: 4 }, S / 2); // half a step at ×1
  check(runs.currentTick(run, S / 2 + S / 8 - 1) === 0 && runs.currentTick(run, S / 2 + S / 8 + 1) === 1, "3 half a step at ×1, then ×4: the step completes after a further eighth of a ×1 step");
  run = apply(run, { type: "speed", speed: 1 }, S / 2 + S / 8 + S / 16); // a quarter step at ×4
  check(runs.currentTick(run, S / 2 + S / 8 + S / 16 + (S * 3) / 4 - 1) === 1 && runs.currentTick(run, S / 2 + S / 8 + S / 16 + (S * 3) / 4 + 1) === 2, "3 a quarter step at ×4, then ×1: the next step comes after three quarters of a ×1 step");
}
// 4. Settling (any accepted action) at random moments equals one uninterrupted day, tick by tick.
{
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let run = apply(runs.initialRun(), { type: "start" }, 0);
  let t = 0;
  let okAll = true;
  while (t < 96 * S) {
    t += Math.floor(random() * 1700) + 1;
    run = roundTrip(runs.settle(run, t, rig));
    if (runs.currentTick(run, t) !== Math.min(96, Math.floor(t / S))) okAll = false;
  }
  check(okAll && run.status === "ended", "4 settling at random moments (1–1700 ms apart) never moves the tick away from running time / step, and the day ends");
}
console.log(`greenhouse time: ${passed}/${passed + failed.length} checks passed (room code: ${dir})`);
if (failed.length) {
  console.log(`FAILED:\n- ${failed.join("\n- ")}`);
  process.exitCode = 1;
}
