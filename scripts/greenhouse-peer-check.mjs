// Resource-Limited Greenhouse, same-device peer tabs (no room server): a reset must not be undone
// by a teammate tab's action on the OLD run. The review counterexample (PR #6, app faa7c09), with
// the actual reducer and SyncReplica: both tabs at run 1 with equal Lamport clocks; tab a resets
// (run 2, stamp [n+1, "a"]) while tab z, before seeing it, steps run 1 to tick 4 (stamp [n+1, "z"]).
// Under whole-run last-writer-wins on the stamp, both tabs converged BACK to run 1 / tick 4 and
// the reset was lost.
//
// Each tab here is a real SyncReplica plus the real reducer; `rule` decides whether an arriving
// stamped run replaces the tab's: "stamp" is the code before the fix (SyncReplica.acceptTransform,
// collaboration.ts at faa7c09), "epoch" is the fix (peerRunWins: run id first, then the stamp).
// Every delivery order of every pair of concurrent actions must converge, never on an older run.
//
//   node --experimental-strip-types scripts/greenhouse-peer-check.mjs [rule]   (rule: epoch | stamp)
const rule = process.argv[2] ?? "epoch";
const runs = await import("../cloudflare/greenhouse-run.js");
const model = await import("../cloudflare/greenhouse-model.js");
const { SyncReplica } = await import("../src/desktop/sync-replica.ts");

let passed = 0;
const failed = [];
const check = (value, label, detail = "") => {
  if (value) passed += 1;
  else failed.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${value ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const rig = model.deriveRig(() => null);

function tab(id) {
  const sync = new SyncReplica(id, "peer");
  const t = { id, sync, run: runs.initialRun(), stamp: null };
  t.act = (action, now) => {
    const result = runs.reduceGreenhouseRun(t.run, action, now, rig);
    if (!result.ok) return null;
    const stamp = sync.stampTransform("greenhouse");
    t.run = result.run;
    t.stamp = stamp;
    return { run: result.run, stamp };
  };
  t.receive = (message) => {
    if (rule === "stamp") {
      if (!sync.acceptTransform("greenhouse", message.stamp)) return;
    } else {
      sync.observeClock(message.stamp[0]);
      if (!runs.peerRunWins(message.run, message.stamp, t.run, t.stamp)) return;
    }
    t.run = message.run;
    t.stamp = message.stamp;
  };
  return t;
}
/** Two tabs that have exchanged the same run 1 (equal clocks). */
function pair(prepare) {
  const a = tab("a");
  const z = tab("z");
  // The first tab's brief day, shared: both tabs hold run 1 with equal Lamport clocks.
  const stamp = a.sync.stampTransform("greenhouse");
  a.stamp = stamp;
  z.receive({ run: a.run, stamp });
  if (prepare) prepare(a, z);
  return { a, z };
}
const describe = (t) => `run ${t.run.runId} ${t.run.status} tick ${t.run.tick} seed ${t.run.seed}`;

// 1. The counterexample, both delivery orders.
for (const order of ["a-first", "z-first"]) {
  const { a, z } = pair();
  const base = a.run.runId;
  const reset = a.act({ type: "reset", seed: 7 }, 1000);
  const step = z.act({ type: "step" }, 1000);
  if (order === "a-first") { z.receive(reset); a.receive(step); } else { a.receive(step); z.receive(reset); }
  check(a.run.runId === base + 1 && z.run.runId === base + 1 && a.run.tick === 0 && z.run.tick === 0 && a.run.seed === 7 && z.run.seed === 7, `1 ${order}: a's reset (new run) and z's concurrent step on the old run: both tabs keep the reset`, `a: ${describe(a)}; z: ${describe(z)}`);
}
// 2. Every pair of concurrent actions (same run or across a reset), both delivery orders: the two
//    tabs converge on one state, and never on a run older than the newest either produced.
const actions = [{ type: "start" }, { type: "pause" }, { type: "resume" }, { type: "step" }, { type: "speed", speed: 4 }, { type: "reset", seed: 5 }, { type: "reset", seed: 9 }];
let pairs = 0;
let converged = 0;
let neverOlder = 0;
for (const startRunning of [false, true]) {
  for (const x of actions) {
    for (const y of actions) {
      for (const order of [0, 1]) {
        const { a, z } = pair(startRunning ? (a0, z0) => z0.receive(a0.act({ type: "start" }, 100)) : undefined);
        const ma = a.act(x, 2600);
        const mz = z.act(y, 2600);
        if (order === 0) { if (ma) z.receive(ma); if (mz) a.receive(mz); } else { if (mz) a.receive(mz); if (ma) z.receive(ma); }
        pairs += 1;
        if (JSON.stringify(a.run) === JSON.stringify(z.run)) converged += 1;
        const newest = Math.max(ma?.run.runId ?? 0, mz?.run.runId ?? 0, a.run.runId);
        if (a.run.runId === newest && z.run.runId === newest) neverOlder += 1;
      }
    }
  }
}
check(converged === pairs, `2 every pair of concurrent run actions, both delivery orders (${pairs} cases): both tabs converge on the same run state`, `${converged}/${pairs}`);
check(neverOlder === pairs, `2 …and never on a run older than the newest one either tab made (a reset is never undone)`, `${neverOlder}/${pairs}`);
// 3. A late duplicate of an older run state never replaces a newer one.
{
  const { a, z } = pair();
  const old = { run: a.run, stamp: [999, "zz"] };
  a.act({ type: "reset" }, 5000);
  a.receive(old);
  check(a.run.runId === z.run.runId + 1, "3 an older run's state with a high stamp (a late or replayed message) never replaces a newer run", describe(a));
}
console.log(`greenhouse peer (${rule}): ${passed}/${passed + failed.length} checks passed`);
if (failed.length) process.exitCode = 1;
