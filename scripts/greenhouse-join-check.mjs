// Resource-Limited Greenhouse, same-device peer tabs: a join's state response must carry the run
// with the stamp of the revision the answering tab ACCEPTED, never a fresh one. The review
// counterexample (PR #6, app b8d099a): A (id z) steps run 1 to tick 4 (stamp [1, z]); B (id a)
// accepts it, steps to tick 8 (stamp [2, a]), and that update is held from A and C. A answers C's
// join with the unchanged tick 4 RESTAMPED [2, z]; C accepts it. B's [2, a] is then delivered: A
// accepts tick 8, C refuses it (older than [2, z]). Final A 8, B 8, C 4.
//
// This runs the real DesktopRoom (src/desktop/collaboration.ts, bundled with esbuild) for three
// tabs over a fake BroadcastChannel delivered in order by the script, with a fake clock; B's update is
// held at B by the app's own QA hold (holdPeerMessagesForQa, as `__vmQa.holdPeer` in the browser). It checks the counterexample, an idle join (nothing acted on yet), and that a reset
// (a later run id) held from the others still wins over a copy of the old run.
//
//   node scripts/greenhouse-join-check.mjs [source-root]
//
// `source-root` (default: this checkout) lets the same checks run against another commit's
// source, e.g. the code before the fix, to show they fail there. Exit code 1 if any check failed.
import { build } from "esbuild";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const repo = new URL("..", import.meta.url).pathname;
const outDir = mkdtempSync(`${tmpdir()}/gh-join-`);
const outfile = `${outDir}/collaboration.mjs`;
await build({
  entryPoints: [`${root}/src/desktop/collaboration.ts`],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
  define: { "import.meta.env.VITE_COLLAB_WS_URL": '""' },
  nodePaths: [`${repo}/node_modules`],
  logLevel: "error",
});

// ── A fake same-device world: clock, ids, window, location, BroadcastChannel ──
let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;
const nextIds = [];
const realUuid = crypto.randomUUID.bind(crypto);
crypto.randomUUID = () => nextIds.shift() ?? realUuid();
globalThis.window = globalThis;
globalThis.addEventListener ??= () => undefined;
globalThis.removeEventListener ??= () => undefined;
globalThis.location = { hostname: "localhost", protocol: "http:", host: "localhost", href: "http://localhost/" };

/** Every post is queued per recipient; the script delivers, holds and releases them. */
const bus = { channels: [], queue: [] };
class FakeChannel {
  constructor(name) {
    this.name = name;
    this.listeners = [];
    bus.channels.push(this);
  }
  addEventListener(type, listener) {
    if (type === "message") this.listeners.push(listener);
  }
  removeEventListener() {}
  postMessage(data) {
    for (const target of bus.channels) if (target !== this && target.name === this.name && !target.closed) bus.queue.push({ from: this, to: target, data: structuredClone(data) });
  }
  close() {
    this.closed = true;
  }
}
globalThis.BroadcastChannel = FakeChannel;

const { DesktopRoom } = await import(pathToFileURL(outfile).href);
const { deriveRig } = await import(pathToFileURL(`${root}/cloudflare/greenhouse-model.js`).href);
const rig = deriveRig(() => null);

/** Delivers queued messages (in order) that `allow` admits; the rest stay queued. */
function flush(allow = () => true) {
  for (let guard = 0; guard < 1000; guard += 1) {
    const index = bus.queue.findIndex(allow);
    if (index < 0) return;
    const [item] = bus.queue.splice(index, 1);
    if (process.env.GH_JOIN_TRACE && /greenhouse|state-response/.test(item.data.kind)) console.log(`  deliver ${item.data.kind} ${item.data.participantId} → ${bus.channels.indexOf(item.to)}: ${JSON.stringify(item.data.stamp ?? item.data.greenhouse?.stamp)} tick ${item.data.run?.tick ?? item.data.greenhouse?.run?.tick}`);
    for (const listener of item.to.listeners) listener({ data: item.data });
  }
  throw new Error("message storm");
}

let passed = 0;
const failed = [];
const check = (value, label, detail = "") => {
  if (value) passed += 1;
  else failed.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${value ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/** A tab whose participant id is `id`, answering state requests the way main.ts does. */
function tab(code, id) {
  clock += 10;
  nextIds.push(id);
  let room;
  room = new DesktopRoom(code, id.toUpperCase(), { onStateRequest: (target) => room.sendState(target, {}) });
  room.greenhouseRig = () => rig;
  room.initPeerGreenhouse();
  return room;
}
const tick = (room) => room.greenhouse ? `run ${room.greenhouse.runId} tick ${room.greenhouse.tick}` : "none";

// ── 1. The review counterexample ──
{
  const code = "QJOIN1";
  const A = tab(code, "z");
  flush();
  const B = tab(code, "a");
  flush();
  await A.greenhouseAction({ type: "step" });
  flush();
  check(A.greenhouse.tick === 4 && B.greenhouse.tick === 4, "1a A steps run 1 to tick 4; B accepts it", `A ${tick(A)}, B ${tick(B)}`);
  B.holdPeerMessagesForQa(true);
  await B.greenhouseAction({ type: "step" });
  check(B.greenhouse.tick === 8, "1b B steps to tick 8; its update is held from A and C", `B ${tick(B)}`);
  const C = tab(code, "m");
  flush();
  check(C.greenhouse.tick === 4, "1c C joins and gets A's run at tick 4 (B's step is still held)", `C ${tick(C)}`);
  B.holdPeerMessagesForQa(false);
  flush();
  check(A.greenhouse.tick === 8 && B.greenhouse.tick === 8 && C.greenhouse.tick === 8, "1d once B's step is delivered, all three tabs are at tick 8", `A ${tick(A)}, B ${tick(B)}, C ${tick(C)}`);
  for (const room of [A, B, C]) room.close?.();
}

// ── 2. An idle join: nothing acted on yet, then a step from the joiner's teammate ──
{
  const code = "QJOIN2";
  const A = tab(code, "z");
  flush();
  const C = tab(code, "m");
  flush();
  check(C.greenhouse?.runId === 1 && C.greenhouse.status === "idle" && C.greenhouse.tick === 0, "2a a tab joining an idle room holds the brief's day, idle", `C ${tick(C)} ${C.greenhouse?.status}`);
  const B = tab(code, "a");
  flush();
  await B.greenhouseAction({ type: "step" });
  flush();
  check([A, B, C].every((room) => room.greenhouse.tick === 4), "2b the first step by the newest tab reaches every tab (the idle copy never outranks it)", `A ${tick(A)}, B ${tick(B)}, C ${tick(C)}`);
  for (const room of [A, B, C]) room.close?.();
}

// ── 3. A held reset (run 2) still wins over a copy of the old run handed to a joiner ──
{
  const code = "QJOIN3";
  const A = tab(code, "z");
  flush();
  const B = tab(code, "a");
  flush();
  await A.greenhouseAction({ type: "step" });
  flush();
  B.holdPeerMessagesForQa(true);
  await B.greenhouseAction({ type: "reset", runId: 1 });
  await A.greenhouseAction({ type: "step" });
  const C = tab(code, "m");
  flush();
  check(C.greenhouse.runId === 1 && C.greenhouse.tick === 8, "3a C joins with A's run 1 at tick 8 while B's reset is held", `C ${tick(C)}`);
  B.holdPeerMessagesForQa(false);
  flush();
  check([A, B, C].every((room) => room.greenhouse.runId === 2 && room.greenhouse.tick === 0), "3b B's reset (run 2) reaches all three; no tab keeps the old run", `A ${tick(A)}, B ${tick(B)}, C ${tick(C)}`);
  for (const room of [A, B, C]) room.close?.();
}

Date.now = realNow;
console.log(`greenhouse join: ${passed}/${passed + failed.length} checks passed (source: ${root})`);
if (failed.length) {
  console.log(`FAILED:\n- ${failed.join("\n- ")}`);
  process.exitCode = 1;
}
writeFileSync(`${outDir}/done`, "");
