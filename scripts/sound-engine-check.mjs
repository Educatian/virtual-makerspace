// Sound Flow Studio (Episode 2): the live engine's start/stop lifecycle with a FAKE AudioContext
// whose resume() settles only when the test says so, and which starts "suspended" (as when the
// browser has not started its audio device yet). It covers review finding B2 on PR #5: a click
// creates the context, the status still says "off" while its resume is pending, and a disconnect
// or a studio exit at that moment must still close it, so the late resume never plays. The exit
// path is the panel's own helper (`stopEngineForExit`, called by SoundPanel.stopAudio). Also:
// a stale start's late failure must not touch a newer running start (finding (a)).
// No real audio: this checks the engine's state machine, not a signal and not a speaker.
//   node --experimental-strip-types scripts/sound-engine-check.mjs
import assert from "node:assert/strict";

let checks = 0;
const ok = (value, label, detail = "") => {
  checks += 1;
  assert.ok(value, `${label}${detail ? ` — ${detail}` : ""}`);
};

// ── A minimal fake Web Audio ─────────────────────────────────────────────────────────────
const created = [];
const oscillators = { started: 0, stopped: 0 };
class FakeParam {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; return this; }
  linearRampToValueAtTime(value) { this.value = value; return this; }
  setTargetAtTime(value) { this.value = value; return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  constructor(context, options = {}) {
    this.context = context;
    this.gain = new FakeParam(options.gain ?? 1);
    this.frequency = new FakeParam(options.frequency ?? 0);
    this.Q = new FakeParam(options.Q ?? 0);
    this.type = options.type;
    this.curve = options.curve;
  }
  connect(target) { return target; }
  disconnect() {}
}
class FakeOscillator extends FakeNode {
  start() { oscillators.started += 1; }
  stop() { oscillators.stopped += 1; }
}
class FakeAnalyser extends FakeNode {
  getFloatTimeDomainData(buffer) { buffer.fill(this.context.state === "running" ? 0.5 : 0); }
}
class FakeAudioContext {
  constructor() {
    this.state = "suspended";
    this.currentTime = 0;
    this.destination = new FakeNode(this);
    this.listeners = new Set();
    this.pending = [];
    created.push(this);
  }
  addEventListener(type, listener) { if (type === "statechange") this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === "statechange") this.listeners.delete(listener); }
  setState(state) { this.state = state; for (const listener of [...this.listeners]) listener(); }
  /** Held until the test calls settle(true|false). */
  resume() {
    return new Promise((resolve, reject) => {
      this.pending.push((succeed) => {
        if (!succeed) return reject(new Error("resume failed late"));
        if (this.state === "closed") return reject(new Error("InvalidStateError: closed"));
        this.setState("running");
        resolve();
      });
    });
  }
  settle(succeed = true) { const next = this.pending.shift(); next?.(succeed); return new Promise((r) => setTimeout(r, 0)); }
  close() { this.setState("closed"); return Promise.resolve(); }
}
globalThis.window = globalThis;
globalThis.AudioContext = FakeAudioContext;
globalThis.GainNode = FakeNode;
globalThis.WaveShaperNode = FakeNode;
globalThis.BiquadFilterNode = FakeNode;
globalThis.ChannelMergerNode = FakeNode;
globalThis.OscillatorNode = FakeOscillator;
globalThis.AnalyserNode = FakeAnalyser;
Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: true } }, configurable: true, writable: true });

const { SoundEngine, stopEngineForExit } = await import("../src/sound/sound-audio.ts");
const PATCH = { cables: { "snd-cable-a": [0, 5], "snd-cable-b": [null, null], "snd-cable-c": [null, null] }, source: { hz: 440, wave: "sine" }, filter: { cutoff: 2000 }, drive: { gain: 1 }, speakerOn: true };
const engineWithLog = () => {
  const statuses = [];
  const engine = new SoundEngine((status) => statuses.push(status));
  engine.apply(PATCH);
  return { engine, statuses };
};

// Control: the previous exit logic (stop only when the status is not "off") misses a pending start.
{
  const { engine } = engineWithLog();
  void engine.start();
  const context = created.at(-1);
  ok(engine.status === "off" && engine.active === true && context.state === "suspended", "a click created a suspended context; its resume is pending and the status still says off");
  if (engine.status !== "off") engine.stop("old guard");
  await context.settle(true);
  ok(engine.status === "running" && context.state === "running", "control: with the previous guard, the late resume starts audio after the exit (the reviewers' reproduction)", engine.status);
  engine.stop("control done");
}

for (const [name, reason] of [["disconnect", "Connection to the room lost · audio stopped"], ["studio exit", "Left Sound Flow Studio · audio stopped"]]) {
  // Each case gets its own fresh pending start: the late resume then succeeds, or fails.
  for (const late of ["succeeds", "fails"]) {
    const { engine, statuses } = engineWithLog();
    const before = { ...oscillators };
    void engine.start();
    const context = created.at(-1);
    ok(engine.status === "off" && engine.active === true && context.pending.length === 1, `${name} (late resume ${late}): pending start (status off, context exists, one resume outstanding)`);
    const stopped = stopEngineForExit(engine, reason);
    ok(stopped === true && context.state === "closed" && engine.active === false, `${name} (late resume ${late}): the exit helper closes the pending context and reports that it stopped something`);
    await context.settle(late === "succeeds");
    ok(context.pending.length === 0, `${name} (late resume ${late}): the outstanding resume settled in this case`);
    ok(engine.status === "off" && !statuses.includes("running") && !statuses.includes("error") && engine.levels() === null, `${name} (late resume ${late}): no "running", no error afterwards`, JSON.stringify(statuses));
    ok(oscillators.started - before.started === oscillators.stopped - before.stopped, `${name} (late resume ${late}): every oscillator the pending start built was stopped`, JSON.stringify({ before, oscillators }));
  }
}

// Nothing to stop: the helper says so and posts no reason.
{
  const { engine, statuses } = engineWithLog();
  ok(stopEngineForExit(engine, "Left the studio") === false && engine.status === "off" && statuses.length === 1, "an exit with no audio stops nothing and reports nothing to stop");
}

// (a) start A → stop → start B → B runs → A's resume settles late (fails, or succeeds): B keeps
// running, no error. Each outcome on its own fresh pair of starts.
for (const late of ["fails", "succeeds"]) {
  const { engine, statuses } = engineWithLog();
  void engine.start();
  const first = created.at(-1);
  engine.stop("restart");
  void engine.start();
  const second = created.at(-1);
  ok(first !== second && first.pending.length === 1 && second.pending.length === 1, `(a, stale ${late}) a second click after a stop creates a new context; both resumes outstanding`);
  await second.settle(true);
  ok(engine.status === "running", `(a, stale ${late}) the second start runs`);
  await first.settle(late === "succeeds");
  ok(first.pending.length === 0 && engine.status === "running" && second.state === "running" && !statuses.includes("error") && statuses.filter((status) => status === "running").length >= 1,
    `(a) the stale start's late ${late === "fails" ? "failure" : "success"} does not touch the running second start`, JSON.stringify(statuses));
  engine.stop("done");
}

// A pending start that is stopped, then resumes, leaves no context alive; a new click starts afresh.
{
  const { engine } = engineWithLog();
  void engine.start();
  const first = created.at(-1);
  stopEngineForExit(engine, "Left the room");
  await first.settle(true);
  void engine.start();
  const second = created.at(-1);
  await second.settle(true);
  ok(first.state === "closed" && second.state === "running" && engine.status === "running", "after an exit during a pending start, only a new click starts audio, in a new context");
  engine.stop("done");
}

// Inspector edits (review UI concerns): drafts typed while an edit is pending survive its
// acceptance, and a timeout is never reported as a definite "nothing changed".
{
  const { clearSubmittedDrafts, notAppliedCopy } = await import("../src/sound/sound-panel.ts");
  const drafts = new Map([["snd-source:hz", "220"], ["snd-source:wave", "sawtooth"], ["snd-filter:cutoff", "300"]]);
  const submitted = new Map([...drafts].filter(([key]) => key.startsWith("snd-source:")));
  drafts.set("snd-source:hz", "330"); // typed (Enter) while the edit was on its way
  const newer = clearSubmittedDrafts(drafts, "snd-source", submitted);
  ok(newer === true && drafts.get("snd-source:hz") === "330" && !drafts.has("snd-source:wave") && drafts.get("snd-filter:cutoff") === "300",
    "an accepted edit clears only the drafts it carried; a value typed meanwhile and other modules' drafts stay", JSON.stringify([...drafts]));
  const fresh = new Map([["snd-drive:gain", "1.70"]]);
  drafts.set("snd-drive:gain", "1.70");
  drafts.set("snd-drive:extra", "x");
  ok(clearSubmittedDrafts(drafts, "snd-drive", fresh) === true && !drafts.has("snd-drive:gain") && drafts.has("snd-drive:extra"), "a draft key not in the submitted edit is kept as newer");
  for (const reason of ["timeout", "disconnected", undefined, "something-new"]) {
    const copy = notAppliedCopy(reason, "Not applied", "Your draft is kept below");
    ok(!/; nothing changed\./.test(copy) && /If the room accepted it, the new value will appear here on its own; otherwise nothing changed/.test(copy), `unconfirmed (${reason ?? "no reason"}) copy states the uncertainty`, copy);
  }
  for (const reason of ["held", "stale", "invalid", "occupied", "offline"]) {
    const copy = notAppliedCopy(reason, "Not switched", "");
    ok(/; nothing changed\.$/.test(copy) && !/If the room accepted/.test(copy), `a definite refusal (${reason}) says nothing changed`, copy);
  }
  const timeout = notAppliedCopy("timeout", "Not applied", "Your draft is kept below");
  ok(!/nothing changed\.?$/.test(timeout.split(";")[0]) && /If the room accepted it, the new value will appear here on its own; otherwise nothing changed/.test(timeout), "timeout copy states the uncertainty, not a definite 'nothing changed'", timeout);
  const stale = notAppliedCopy("stale", "Not applied", "Your draft is kept below");
  ok(/; nothing changed\. Your draft is kept below\.$/.test(stale), "a definite refusal says nothing changed", stale);
}

// Review (parent, ad7fd3c): the room ACCEPTS an edit, but the answer is lost when the connection
// closes. The client's result is "disconnected", which must not be reported as "nothing changed":
// the canonical state (what a late joiner and the reconnect get) has the new value.
{
  const { SyncReplica } = await import("../src/desktop/sync-replica.ts");
  const { RoomCore } = await import("../cloudflare/room-core.js");
  const { sanitizeEdit } = await import("../cloudflare/sanitize.js");
  const { notAppliedCopy } = await import("../src/sound/sound-panel.ts");
  const core = new RoomCore();
  const alice = { id: "alice", name: "Alice" };
  const replica = new SyncReplica("alice", "server");
  const { message } = replica.createEdit("op-1", [{ componentId: "snd-drive", transform: { position: [-0.62, 0, -0.2], rotation: [0, 0, 0], sockets: null, props: { gain: 2 } } }]);
  const out = core.handle(alice, { kind: "edit", participantId: "alice", ...sanitizeEdit(message) });
  ok(out.sender[0]?.ok === true, "the room accepts the Drive edit (gain ×2)", JSON.stringify(out.sender[0]));
  // The answer never arrives: the socket closes first.
  replica.resetForReconnect();
  const result = replica.failPending("disconnected").find((effect) => effect.type === "resolve")?.result;
  ok(result && result.ok === false && result.reason === "disconnected", "the client's own result is 'disconnected'", JSON.stringify(result));
  ok(core.join()[0].transforms["snd-drive"].transform.props.gain === 2, "the room's canonical state (late join, reconnect) has gain ×2");
  const copy = notAppliedCopy(result.reason, "Not applied", "Your draft is kept below");
  ok(!/; nothing changed/.test(copy) && /If the room accepted it, the new value will appear here on its own/.test(copy) && /connection closed before the room's answer arrived/.test(copy) && /Your draft is kept below\.$/.test(copy), "the panel says the outcome is uncertain (the value appears if accepted) and keeps the draft, never 'nothing changed'", copy);
}

console.log(`sound engine: ${checks} checks passed (fake AudioContext; lifecycle only, no audio; inspector draft and refusal copy)`);
