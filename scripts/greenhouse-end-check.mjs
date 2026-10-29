// Resource-Limited Greenhouse: a day that reaches its natural end (tick 96) is FINISHED. A rig
// change that the end unlocks must never rewrite it — not its resources (spent water restored),
// records, or verdict — under the same run id, in the room, after a JSON restore, for a late joiner,
// after a reconnect or a server restart, or through a pause, live move, import or Undo/Redo.
//
// The review counterexample (PR #6, app faa7c09): build the default rig, start, let the clock
// pass the end with no message in between (the stored run still says running, tick 0), then
// unplug the tank hose: the room accepted it and every client recomputed the day from the
// tick-0 anchor with the new rig — final tank 16 L → 40 L, pumped 24 L → 0, same run id.
//
//   node scripts/greenhouse-end-check.mjs [cloudflare-dir]
//
// `cloudflare-dir` (default: this checkout's) lets the same checks run against another commit's
// room code, e.g. the code before the fix, to show they fail there. Every check is reported; the
// exit code is 1 if any failed.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const dir = resolve(process.argv[2] ?? new URL("../cloudflare", import.meta.url).pathname);
const load = (name) => import(pathToFileURL(`${dir}/${name}`).href);
const rules = await load("greenhouse-rules.js");
const model = await load("greenhouse-model.js");
const runs = await load("greenhouse-run.js");
const { RoomCore } = await load("room-core.js");

let passed = 0;
const failed = [];
const check = (value, label, detail = "") => {
  if (value) passed += 1;
  else failed.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${value ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const near = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9;

const pose = (id, props) => ({ position: [...rules.GH_FIXTURE_POSES[id]], rotation: [0, 0, 0], sockets: null, ...(props ? { props } : {}) });
const line = (sockets) => ({ position: [0, 0.5, 2.6], rotation: [0, 0, 0], sockets, endpoints: [[-0.5, 0, 0], [0.5, 0, 0]] });
const LINES = { "irrigation-hose": [0, 1], "irrigation-hose-2": [2, 3], "irrigation-hose-3": [4, 6], "irrigation-hose-4": [5, 7], "power-cable-1": [8, 9], "power-cable-2": [10, 12], "power-cable-3": [11, 13] };
const alice = { id: "alice", name: "Alice" };
const bob = { id: "bob", name: "Bob" };
const END_MS = runs.STEP_MS * 96 + 700;

/** A room with the default rig (both valves 100 %, pump below 50 %, fan above 30 °C) built by Alice. */
function room(start = 50_000_000) {
  const clock = { now: start };
  const core = new RoomCore({ now: () => clock.now });
  const changes = [
    ...Object.entries(LINES).map(([componentId, sockets]) => ({ componentId, transform: line(sockets) })),
    { componentId: "soil-sensor", transform: { position: [0, 0.4, 0], rotation: [0, 0, 0], sockets: [14, 15] } },
    { componentId: "valve-manifold", transform: pose("valve-manifold", { valveA: 100, valveB: 100 }) },
    { componentId: "farm-controller", transform: pose("farm-controller", { pumpBelow: 50, fanAbove: 30 }) },
  ].map((change) => ({ ...change, expectRev: core.rev(change.componentId) }));
  const out = core.handle(alice, { kind: "edit", opId: "build", changes });
  if (out.sender.at(-1)?.ok !== true) throw new Error(`building the rig was refused: ${JSON.stringify(out.sender.at(-1))}`);
  return { core, clock };
}
const edit = (core, who, opId, changes) => core.handle(who, { kind: "edit", opId, changes: changes.map(([componentId, transform]) => ({ componentId, expectRev: core.rev(componentId), transform })) });
const editResult = (out) => out.sender.find((message) => message.kind === "edit-result");
/** What every client shows: the run brought to the room's tick with the rig the room now holds. */
const shown = (core, now) => model.simulate(core.greenhouse.snapshot, core.greenhouseRig(), core.greenhouse.seed, runs.currentTick(core.greenhouse, now)).snapshot;

// The day the default rig gives on the brief's day (seed 11), computed straight through.
const reference = room();
const expected = model.simulate(model.initialSnapshot(11), reference.core.greenhouseRig(), 11, 96).snapshot;
const expectedVerdict = model.evaluateBrief(expected, reference.core.greenhouseRig());
console.log(`reference day (default rig, seed 11): tank ${expected.tank.toFixed(3)} L, pumped ${expected.totals.pumped.toFixed(3)} L, stress A ${expected.stress.A} B ${expected.stress.B} heat ${expected.stress.heat}; G1 ${expectedVerdict.criteria[0].pass}`);

// ── 1. The counterexample: the tank hose unplugged after the end, with no message in between ──
{
  const { core, clock } = room();
  core.handle(alice, { kind: "greenhouse", opId: "start", action: { type: "start" } });
  clock.now += END_MS;
  console.log(`  before the unplug: stored run ${core.greenhouse.status}, tick ${core.greenhouse.tick} (the clock says ${runs.currentTick(core.greenhouse, clock.now)})`);
  const out = edit(core, bob, "unplug", [["irrigation-hose", line([null, 1])]]);
  check(editResult(out)?.ok === true, "1a after the end the rig is unlocked: Bob's unplug of the tank hose is accepted", JSON.stringify(editResult(out)));
  const run = core.greenhouse;
  check(run.status === "ended" && run.tick === 96 && run.runId === 1, "1b the room holds the day ended at tick 96, same run id", `${run.status} tick ${run.tick} run ${run.runId}`);
  check(near(run.snapshot.tank, expected.tank) && near(run.snapshot.totals.pumped, expected.totals.pumped), "1c the room's final tank and pumped water are the day as it ran (not restored by the unplug)", `tank ${run.snapshot.tank} (expected ${expected.tank}); pumped ${run.snapshot.totals.pumped} (expected ${expected.totals.pumped})`);
  const view = shown(core, clock.now);
  check(near(view.tank, expected.tank) && near(view.totals.pumped, expected.totals.pumped) && JSON.stringify(view.stress) === JSON.stringify(expected.stress), "1d what every client computes from the room's run and the changed rig is still that day", `tank ${view.tank}, pumped ${view.totals.pumped}, stress ${JSON.stringify(view.stress)}`);
  const order = out.others.map((message) => message.kind === "greenhouse-state" ? `run:${message.run.status}` : message.kind);
  check(order.indexOf("run:ended") !== -1 && order.indexOf("run:ended") < order.indexOf("edit"), "1e teammates receive the ended day before the change that followed it", JSON.stringify(order));
  check(Boolean(out.persist.greenhouse) && out.persist.greenhouse.status === "ended", "1f the ended day is persisted with that change", JSON.stringify(out.persist.greenhouse?.status));
  const verdict = model.evaluateBrief(view, core.greenhouseRig(), run.endBuild ?? null);
  check(verdict.criteria[0].pass === expectedVerdict.criteria[0].pass, "1g the verdict's G1 is the build the day ended with, not the unplugged rig", `G1 ${verdict.criteria[0].pass} (${verdict.criteria[0].measured})`);
  // JSON restore (storage) and a late joiner.
  const stored = runs.sanitizeGreenhouseRun(JSON.parse(JSON.stringify(core.greenhouse)));
  const restored = new RoomCore({ now: () => clock.now, entries: JSON.parse(JSON.stringify([...core.state])), greenhouse: stored });
  const restoredView = shown(restored, clock.now);
  check(stored !== null && near(restoredView.tank, expected.tank) && near(restoredView.totals.pumped, expected.totals.pumped), "1h after a JSON restore of the room, the day is unchanged", `tank ${restoredView.tank}`);
  const late = core.join()[0].greenhouse;
  check(late.status === "ended" && near(model.simulate(late.snapshot, core.greenhouseRig(), late.seed, runs.currentTick(late, clock.now)).snapshot.tank, expected.tank), "1i a late joiner gets the ended day with its final tank", `${late.status} tank ${late.snapshot.tank}`);
  // Replugging (an Undo of the unplug) changes nothing either; only a reset refills.
  edit(core, bob, "replug", [["irrigation-hose", line([0, 1])]]);
  check(near(shown(core, clock.now).tank, expected.tank) && core.greenhouse.runId === 1, "1j an Undo (the hose plugged back) leaves the finished day as it was");
  const refused = ["start", "resume", "step"].map((type) => core.handle(bob, { kind: "greenhouse", opId: type, action: { type } }).sender.find((m) => m.kind === "greenhouse-result"));
  check(refused.every((result) => result && result.ok === false && result.reason === "ended") && near(core.greenhouse.snapshot.tank, expected.tank), "1k start, resume and step on the finished day are refused (ended); nothing is refilled", JSON.stringify(refused.map((r) => r?.reason)));
  const reset = core.handle(bob, { kind: "greenhouse", opId: "reset", action: { type: "reset", runId: 1 } });
  check(reset.others.some((m) => m.kind === "greenhouse-state" && m.run.runId === 2 && m.run.snapshot.tank === 40), "1l only a reset refills the tank, as a new run (id 2)");
}

// ── 2. A pause after the end commits the ended day (it used to answer "ended" and drop it) ──
{
  const { core, clock } = room();
  core.handle(alice, { kind: "greenhouse", opId: "start", action: { type: "start" } });
  clock.now += END_MS;
  const out = core.handle(bob, { kind: "greenhouse", opId: "pause", action: { type: "pause", runId: 1 } });
  const result = out.sender.find((m) => m.kind === "greenhouse-result");
  check(result?.ok === false && result.reason === "ended", "2a a pause after the end is answered 'ended'", JSON.stringify(result));
  check(core.greenhouse.status === "ended" && core.greenhouse.tick === 96 && out.persist.greenhouse?.status === "ended", "2b and the room has committed and persisted the ended day", `${core.greenhouse.status} tick ${core.greenhouse.tick}; persisted ${out.persist.greenhouse?.status}`);
  edit(core, bob, "unplug", [["irrigation-hose", line([null, 1])]]);
  check(near(shown(core, clock.now).tank, expected.tank), "2c a change after that leaves the day as it was", `tank ${shown(core, clock.now).tank}`);
}

// ── 3. A live move (cable-end drag) after the end ──
{
  const { core, clock } = room();
  core.handle(alice, { kind: "greenhouse", opId: "start", action: { type: "start" } });
  clock.now += END_MS;
  const claim = core.handle(bob, { kind: "claim", componentId: "irrigation-hose::endpoint-0" });
  const move = core.handle(bob, { kind: "transform", componentId: "irrigation-hose", sequence: 1, transform: { ...line([null, 1]), activeEndpoint: 0 } });
  check(move.sender[0]?.kind === "rev-ack", "3a after the end a live hose-end move is accepted", JSON.stringify(move.sender[0]?.kind));
  check([...claim.others, ...claim.sender].some((m) => m.kind === "greenhouse-state" && m.run.status === "ended"), "3b the room settled the day and told everyone at the claim, before the move", JSON.stringify([...claim.others, ...claim.sender].map((m) => m.kind)));
  check(near(shown(core, clock.now).tank, expected.tank) && near(shown(core, clock.now).totals.pumped, expected.totals.pumped), "3c the moved hose does not rewrite the day", `tank ${shown(core, clock.now).tank}`);
}

// ── 4. An import (one atomic edit of the whole rig) after the end ──
{
  const { core, clock } = room();
  core.handle(alice, { kind: "greenhouse", opId: "start", action: { type: "start" } });
  clock.now += END_MS;
  const out = edit(core, bob, "import", [["irrigation-hose", line([null, null])], ["irrigation-hose-2", line([null, null])], ["valve-manifold", pose("valve-manifold", { valveA: 30, valveB: 50 })]]);
  check(editResult(out)?.ok === true && near(shown(core, clock.now).tank, expected.tank) && near(shown(core, clock.now).totals.pumped, expected.totals.pumped), "4a an import after the end is accepted and leaves the day as it was", `tank ${shown(core, clock.now).tank}`);
}

// ── 5. Reconnect: a hello after the end, nothing else ──
{
  const { core, clock } = room();
  core.handle(alice, { kind: "greenhouse", opId: "start", action: { type: "start" } });
  clock.now += END_MS;
  const out = core.handle(bob, { kind: "hello", participantId: "bob", participantName: "Bob" });
  check(out.persist.greenhouse?.status === "ended" && core.join()[0].greenhouse.status === "ended", "5a a reconnecting client's hello settles and persists the ended day; its join shows it ended", `${out.persist.greenhouse?.status} / ${core.join()[0].greenhouse.status}`);
}

// ── 6. Server restart: the stored run is from before the end; the room restarts after it ──
{
  const { core, clock } = room();
  core.handle(alice, { kind: "greenhouse", opId: "start", action: { type: "start" } });
  clock.now += runs.STEP_MS * 40;
  const storedRun = JSON.parse(JSON.stringify(core.greenhouse));
  const storedEntries = JSON.parse(JSON.stringify([...core.state]));
  clock.now += END_MS;
  const restarted = new RoomCore({ now: () => clock.now, entries: storedEntries, greenhouse: runs.sanitizeGreenhouseRun(storedRun) });
  restarted.handle(bob, { kind: "hello", participantId: "bob", participantName: "Bob" });
  const out = edit(restarted, bob, "unplug", [["irrigation-hose", line([null, 1])]]);
  check(editResult(out)?.ok === true && restarted.greenhouse.status === "ended" && near(shown(restarted, clock.now).tank, expected.tank), "6a after a restart past the end, the day ends with the stored rig; a later unplug does not rewrite it", `${restarted.greenhouse.status} tank ${shown(restarted, clock.now).tank}`);
}

// ── 7. The room empties after the end, then someone comes back ──
{
  const { core, clock } = room();
  core.handle(alice, { kind: "greenhouse", opId: "start", action: { type: "start" } });
  clock.now += END_MS;
  core.leave(alice);
  core.reset();
  check(core.greenhouse.status === "ended" && near(core.greenhouse.snapshot.tank, expected.tank), "7a everyone left after the end: the day is stored ended with its final tank", `${core.greenhouse.status} tank ${core.greenhouse.snapshot.tank}`);
}

// ── 8. Not over-frozen: a change while PAUSED mid-day still shapes the rest of the day ──
{
  const { core, clock } = room();
  core.handle(alice, { kind: "greenhouse", opId: "start", action: { type: "start" } });
  clock.now += runs.STEP_MS * 10 + 5;
  core.handle(alice, { kind: "greenhouse", opId: "pause", action: { type: "pause", runId: 1 } });
  const out = edit(core, bob, "unplug", [["irrigation-hose", line([null, 1])]]);
  core.handle(alice, { kind: "greenhouse", opId: "resume", action: { type: "resume", runId: 1 } });
  clock.now += END_MS;
  const pumped = shown(core, clock.now).totals.pumped;
  check(editResult(out)?.ok === true && pumped < expected.totals.pumped, "8a (control) a hose unplugged while paused at tick 10 does change the rest of that day: pumping stops", `pumped ${pumped} < ${expected.totals.pumped}`);
}

// ── 9. Peer tabs use the same helper (no room server) ──
check(typeof runs.settleEndedDay === "function", "9a the run module exports settleEndedDay for same-device peer tabs");
if (typeof runs.settleEndedDay === "function") {
  const { core } = room();
  const rig = core.greenhouseRig();
  const started = runs.reduceGreenhouseRun(runs.initialRun(), { type: "start" }, 0, rig).run;
  const ended = runs.settleEndedDay(started, END_MS, rig);
  check(ended?.status === "ended" && near(ended.snapshot.tank, expected.tank) && ended.endBuild?.complete === true && runs.settleEndedDay(ended, END_MS * 2, rig) === null && runs.settleEndedDay(started, runs.STEP_MS * 50, rig) === null, "9b settleEndedDay ends a day past its end once (with its build), and leaves a day before its end alone");
}

console.log(`greenhouse end: ${passed}/${passed + failed.length} checks passed (room code: ${dir})`);
if (failed.length) {
  console.log(`FAILED:\n- ${failed.join("\n- ")}`);
  process.exitCode = 1;
}
