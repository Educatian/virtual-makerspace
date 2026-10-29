// The local development relay (server/collaboration.mjs) keeps a room's greenhouse day when the
// last socket closes, as the Durable Object does: the review counterexample (PR #6, app faa7c09)
// stepped a day to tick 4 (paused), closed the last socket and rejoined — the relay had deleted the
// room, so the day came back idle at tick 0. Real sockets against the real relay process.
//
//   node scripts/greenhouse-relay-check.mjs [server-script]
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { WebSocket } from "ws";

const script = resolve(process.argv[2] ?? new URL("../server/collaboration.mjs", import.meta.url).pathname);
const port = 18000 + Math.floor(Math.random() * 1000);
const relay = spawn(process.execPath, ["--experimental-strip-types", script], { env: { ...process.env, COLLAB_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
await new Promise((resolveReady, reject) => {
  relay.stdout.on("data", (chunk) => { if (String(chunk).includes("listening")) resolveReady(); });
  relay.on("exit", (code) => reject(new Error(`relay exited ${code}`)));
  setTimeout(() => reject(new Error("relay did not start")), 20_000);
});
const room = `R${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
function connect(participant) {
  return new Promise((resolveOpen) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?room=${room}&participant=${participant}`);
    const messages = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    socket.on("open", () => {
      socket.send(JSON.stringify({ kind: "hello", participantId: participant, participant: { id: participant, name: participant } }));
      resolveOpen({ socket, messages });
    });
  });
}
const until = async (test, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = test();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
};
let passed = 0;
const failed = [];
const check = (value, label, detail = "") => {
  if (value) passed += 1;
  else failed.push(label);
  console.log(`${value ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
try {
  const a = await connect("alice");
  await until(() => a.messages.find((m) => m.kind === "room-state"));
  a.socket.send(JSON.stringify({ kind: "greenhouse", participantId: "alice", opId: "step1", action: { type: "step" } }));
  const stepped = await until(() => a.messages.find((m) => m.kind === "greenhouse-state"));
  check(stepped?.run.status === "paused" && stepped.run.tick === 4, "a step gives a paused day at tick 4", `${stepped?.run.status} ${stepped?.run.tick}`);
  a.socket.close();
  await new Promise((r) => setTimeout(r, 400));
  const b = await connect("bob");
  const joined = await until(() => b.messages.find((m) => m.kind === "room-state"));
  check(joined?.greenhouse?.status === "paused" && joined.greenhouse.tick === 4 && joined.greenhouse.runId === stepped?.run.runId, "after the last socket closed, a rejoin gets the same paused day (tick 4), not a fresh idle day", `${joined?.greenhouse?.status} tick ${joined?.greenhouse?.tick}`);
  check(Object.keys(joined?.transforms ?? {}).length === 0 && joined?.fresh === true, "the bench itself reset (as in the Durable Object)");
  b.socket.close();
} finally {
  relay.kill();
}
console.log(`greenhouse relay: ${passed}/${passed + failed.length} checks passed (relay: ${script})`);
if (failed.length) process.exitCode = 1;
