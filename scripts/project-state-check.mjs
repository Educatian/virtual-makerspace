// Checks for project state: conflict-safe undo/redo, project file validation and privacy,
// and agreement between the client's and the Worker relay's property validation.
//   node --experimental-strip-types scripts/project-state-check.mjs
import assert from "node:assert/strict";

const { EditHistory, sameTransform, sameProgram, planProgramLoad } = await import("../src/desktop/edit-history.ts");
const { buildProject, parseProject, isDefaultProject, PROJECT_FORMAT, MAX_PROJECT_BYTES } = await import("../src/desktop/project-file.ts");
const { sanitizeProps } = await import("../src/circuit/part-props.ts");
const worker = await import("../cloudflare/sanitize.js");

let checks = 0;
const ok = (value, label) => { checks += 1; assert.ok(value, label); };
const eq = (a, b, label) => { checks += 1; assert.deepEqual(a, b, label); };

const home = (x) => ({ position: [x, 0.48, 2], rotation: [0, 0, 0], sockets: null });
const seated = (a, b, props) => ({ position: [0, 0.48, 0], rotation: [0, 0, 0], sockets: [a, b], ...(props ? { props } : {}) });

// ── Undo/redo ───────────────────────────────────────────────────────────────────────────
{
  const live = { "led-red": home(3), "resistor-1k": seated(36, 39, { ohms: 1000 }) };
  const current = (id) => live[id] ?? null;
  const free = () => false;
  const history = new EditHistory();
  ok(!history.record("noop", [{ id: "led-red", before: home(3), after: home(3) }]), "no-op edits are not recorded");

  live["led-red"] = seated(53, 52);
  history.record("Moved LED", [{ id: "led-red", before: home(3), after: seated(53, 52) }]);
  live["resistor-1k"] = seated(36, 39, { ohms: 470 });
  history.record("Set 470 Ω", [{ id: "resistor-1k", before: seated(36, 39, { ohms: 1000 }), after: seated(36, 39, { ohms: 470 }) }]);

  let verdict = history.undo(current, free);
  ok(verdict.ok, "undo the property edit");
  eq(verdict.apply[0].transform.props, { ohms: 1000 }, "undo restores the previous value");
  live["resistor-1k"] = verdict.apply[0].transform;
  verdict = history.redo(current, free);
  ok(verdict.ok && verdict.apply[0].transform.props.ohms === 470, "redo reapplies it");
  live["resistor-1k"] = verdict.apply[0].transform;

  // A teammate (or Bolt) moves the LED after our edit: our older undo must not clobber it.
  history.undo(current, free); // undo 470 → 1000 (ours, still clean)
  live["resistor-1k"] = seated(36, 39, { ohms: 1000 });
  live["led-red"] = seated(100, 101); // peer move
  verdict = history.undo(current, free);
  eq([verdict.ok, verdict.reason, verdict.partId], [false, "stale", "led-red"], "a peer's newer move makes our undo stale");
  eq(live["led-red"].sockets, [100, 101], "the peer's move is untouched");
  ok(!history.canUndo, "the stale entry is discarded");

  // Held parts: refused without discarding.
  const held = new EditHistory();
  held.record("Moved LED", [{ id: "led-red", before: home(3), after: seated(100, 101) }]);
  verdict = held.undo(current, (id) => id === "led-red");
  eq([verdict.ok, verdict.reason], [false, "held"], "a part held by someone else (human or Bolt) is not undone");
  ok(held.canUndo, "the entry stays for later");
  verdict = held.undo(current, free);
  ok(verdict.ok, "undo succeeds once released");

  // A new edit clears redo.
  const fresh = new EditHistory();
  fresh.record("a", [{ id: "x", before: home(1), after: home(2) }]);
  fresh.undo((id) => (id === "x" ? home(2) : null), free);
  ok(fresh.canRedo, "redo available");
  fresh.record("b", [{ id: "x", before: home(1), after: home(5) }]);
  ok(!fresh.canRedo, "a new edit clears redo");
  ok(sameTransform(seated(1, 2, { ohms: 220 }), { ...seated(1, 2, { ohms: 220 }), position: [9, 9, 9] }), "seated parts compare by sockets, not drift");
  ok(!sameTransform(home(3), { ...home(3), rotation: [0, 1.2, 0] }), "a peer's rotation of an unseated part counts as a change");
  ok(!sameTransform({ ...home(3), sockets: [] }, { ...home(4), sockets: [] }), "empty socket arrays are not 'seated'");
  {
    const rotated = new EditHistory();
    rotated.record("Moved LED", [{ id: "led-green", before: home(1), after: home(3) }]);
    const verdict = rotated.undo(() => ({ ...home(3), rotation: [0, 1.2, 0] }), () => false);
    eq([verdict.ok, verdict.reason], [false, "stale"], "undo refuses after a peer only rotated the part");
  }
  ok(!sameTransform(seated(1, 2, { ohms: 220 }), seated(1, 2, { ohms: 221 })), "props differences count");
}

// ── Project files ───────────────────────────────────────────────────────────────────────
const circuit = {
  studio: "circuit",
  parts: { "battery-9v": "battery", "led-red": null, "led-green": null, "resistor-220": "resistor", "resistor-1k": "resistor", "wire-red": null, "wire-blue": null, "wire-yellow": null },
  socketCount: 192,
  switches: [],
};
const snapino = { studio: "snapino", parts: { "sno-l1": null, "sno-s1": null }, socketCount: 63, switches: ["sno-s1"] };
const catalogFor = (studio) => (studio === "circuit" ? circuit : studio === "snapino" ? snapino : null);
{
  const transforms = {
    "battery-9v": { ...seated(21, 23, { volts: 9 }), participantId: "secret-auth-id", ownerName: "Ana" },
    "led-red": seated(53, 52),
    "resistor-1k": seated(36, 39, { ohms: 1000 }),
    "resistor-220": { ...home(3), props: { ohms: 4700 } },
  };
  const project = buildProject(circuit, transforms, null, new Date("2026-10-25T10:00:00Z"));
  const text = JSON.stringify(project);
  eq(project.format, PROJECT_FORMAT, "format tag");
  ok(!/secret-auth-id|Ana|participant|chat|trace|token|position/i.test(text), "export holds no ids, names, chat, traces, tokens or raw positions");
  eq(project.parts.find((p) => p.id === "resistor-220").props, { ohms: 4700 }, "off-board edited values are kept");
  const parsed = parseProject(text, catalogFor);
  ok(parsed.ok, "round trip parses");
  eq(parsed.project.parts, project.parts, "round trip is lossless");

  const bad = (mutate, label, pattern) => {
    const copy = JSON.parse(text);
    mutate(copy);
    const result = parseProject(JSON.stringify(copy), catalogFor);
    ok(!result.ok, `rejects ${label}`);
    if (pattern) assert.match(result.error, pattern);
  };
  bad((p) => { p.format = "other"; }, "a foreign format");
  bad((p) => { p.version = 2; }, "a future version", /not supported/);
  bad((p) => { p.studio = "kitchen"; }, "an unknown studio");
  bad((p) => { p.parts.push({ id: "<img src=x onerror=alert(1)>", sockets: null }); }, "HTML in a part id");
  bad((p) => { p.parts.push({ id: "led-red", sockets: null }); }, "duplicate parts");
  bad((p) => { p.parts[1].sockets = [53, 999]; }, "out-of-range sockets");
  bad((p) => { p.parts[1].sockets = [53, 53]; }, "a part in one hole");
  bad((p) => { p.parts[1].sockets = [21, 52]; }, "two parts in one hole");
  bad((p) => { p.parts[1].sockets = [53.5, 52]; }, "fractional sockets");
  bad((p) => { p.parts[1].sockets = "53,52"; }, "string sockets");
  bad((p) => { p.parts[0].props = { volts: 400 }; }, "an out-of-range voltage");
  bad((p) => { p.parts[0].props = { volts: "9" }; }, "a string voltage");
  bad((p) => { p.parts[2].props = { ohms: 1000 }; }, "props on a part without values");
  bad((p) => { p.parts = {}; }, "a non-array part list");
  bad((p) => { p.program = [{ op: "write", pin: "D5", value: true }]; }, "a program outside Snapino");
  ok(!parseProject("{", catalogFor).ok, "rejects broken JSON");
  ok(!parseProject("x".repeat(MAX_PROJECT_BYTES + 1), catalogFor).ok, "rejects oversized input");
  ok(!parseProject(42, catalogFor).ok, "rejects non-text");
  ok(!parseProject("[]", catalogFor).ok, "rejects arrays");
  const extra = JSON.parse(text);
  extra.parts[0].__proto__ = { polluted: true };
  extra.parts[0].ownerName = "Ana";
  extra.chat = ["hi"];
  const cleaned = parseProject(JSON.stringify(extra), catalogFor);
  ok(cleaned.ok && !JSON.stringify(cleaned.project).includes("Ana") && !("chat" in cleaned.project), "unknown fields are dropped, not imported");
  ok(!({}).polluted, "no prototype pollution");
  const solverInjection = JSON.parse(text);
  solverInjection.solver = "<script>x</script>";
  eq(parseProject(JSON.stringify(solverInjection), catalogFor).project.solver.includes("<"), false, "solver tag is sanitized");

  // Snapino programs travel only with Snapino projects, sanitized.
  const sno = buildProject(snapino, { "sno-s1": { ...home(1), on: true } }, [{ op: "write", pin: "D5", value: true }, { op: "wait", ms: 1 }]);
  eq(sno.program, [{ op: "write", pin: "D5", value: true }, { op: "wait", ms: 50 }], "program sanitized on export");
  eq(sno.parts.find((p) => p.id === "sno-s1").on, true, "switch state exported");
  const snoBad = JSON.parse(JSON.stringify(sno));
  snoBad.program = [{ op: "eval", code: "fetch('x')" }];
  ok(!parseProject(JSON.stringify(snoBad), catalogFor).ok, "an invalid program is rejected");
}

// ── Client and Worker agree on electrical values ─────────────────────────────────────────
for (const [kind, raw] of [
  ["resistor", { ohms: 220 }], ["resistor", { ohms: 4712 }], ["resistor", { ohms: 9.99 }], ["resistor", { ohms: 10 }],
  ["resistor", { ohms: 1e6 }], ["resistor", { ohms: 1.0004e6 }], ["resistor", { ohms: NaN }], ["resistor", { ohms: "220" }],
  ["battery", { volts: 9 }], ["battery", { volts: 0.95 }], ["battery", { volts: 12.04 }], ["battery", { volts: 12.06 }],
  ["battery", { volts: -9 }], ["battery", null], ["battery", [9]], ["resistor", { volts: 9 }],
]) {
  eq(worker.sanitizeProps(kind, raw), sanitizeProps(kind, raw), `client/worker agree on ${kind} ${JSON.stringify(raw)}`);
}
{
  // The Worker keeps valid props on transforms and late-join state responses, drops invalid ones.
  const base = { position: [0, 0.48, 0], rotation: [0, 0, 0], sockets: [36, 39] };
  eq(worker.sanitizeTransform({ ...base, props: { ohms: 470 } }, "resistor-1k").props, { ohms: 470 }, "worker relays valid ohms");
  eq(worker.sanitizeTransform({ ...base, props: { volts: 5 } }, "battery-9v").props, { volts: 5 }, "worker relays valid volts");
  eq(worker.sanitizeTransform({ ...base, props: { ohms: -1 } }, "resistor-1k").props, undefined, "worker drops invalid ohms");
  eq(worker.sanitizeTransform({ ...base, props: { ohms: 470 } }, "led-red").props, undefined, "worker drops props on parts without values");
  eq(worker.sanitizeTransform({ ...base, props: { ohms: 470, html: "<b>" } }, "resistor-1k").props, { ohms: 470 }, "worker copies only known fields");
  ok(worker.sanitizeTransform({ ...base, sockets: [36, 39.5] }, "resistor-1k") === null, "worker still rejects bad sockets");
}

// ── Hostile JSON: strict types, never a throw (PR #3 review) ──────────────────────────────
{
  const valid = JSON.parse(JSON.stringify(buildProject(catalogFor("circuit"), { "led-red": seated(53, 52), "resistor-1k": seated(36, 39, { ohms: 1000 }) })));
  const hostile = [{ toString: 0 }, { toString: 0, valueOf: 0 }, { valueOf: 0 }, [], [1], { length: 2 }, "1", true, null, 1e309];
  let refused = 0;
  for (const field of ["format", "version", "studio", "solver", "savedAt", "parts", "program", "draftProgram"]) {
    for (const value of hostile) {
      const project = { ...valid, [field]: value };
      let result;
      assert.doesNotThrow(() => { result = parseProject(JSON.stringify(project), catalogFor); }, `${field}=${JSON.stringify(value)} does not throw`);
      checks += 1;
      if (!result.ok) refused += 1;
      else ok(typeof result.project.solver === "string" && typeof result.project.savedAt === "string", `${field} hostile value is sanitized when tolerated`);
    }
  }
  ok(refused > 30, "hostile top-level values are refused");
  const versionObject = parseProject(JSON.stringify({ ...valid, version: { toString: 0 } }), catalogFor);
  eq([versionObject.ok, /version is not supported/.test(versionObject.error)], [false, true], "version {toString:0} is refused with a truthful error (not a crash)");
  for (const part of [
    { id: "led-red", sockets: [{ toString: 0, valueOf: 0 }, 52] },
    { id: "led-red", sockets: [true, ""] },
    { id: "led-red", sockets: [false, "", null].slice(0, 2) },
    { id: "led-red", sockets: ["53", "52"] },
    { id: "led-red", sockets: [53.5, 52] },
    { id: { toString: 0 }, sockets: [53, 52] },
    { id: "resistor-1k", sockets: [36, 39], props: { ohms: { valueOf: 0 } } },
    { id: "resistor-1k", sockets: [36, 39], props: { ohms: "1000" } },
    { id: "led-red", sockets: [53, 52], on: "true" },
  ]) {
    let result;
    assert.doesNotThrow(() => { result = parseProject(JSON.stringify({ ...valid, parts: [part] }), catalogFor); }, `part ${JSON.stringify(part)} does not throw`);
    eq(result.ok, false, `part ${JSON.stringify(part)} is refused, not coerced`);
  }
  const snoBase = JSON.parse(JSON.stringify(buildProject(catalogFor("snapino"), {}, [{ op: "write", pin: "D5", value: true }])));
  for (const program of [[{ op: "wait", ms: { valueOf: 0 } }], [{ op: "wait", ms: "500" }], [{ op: "write", pin: "D5", value: "true" }], [{ op: "write", pin: { toString: 0 }, value: true }], { 0: { op: "wait", ms: 50 }, length: 1 }]) {
    let result;
    assert.doesNotThrow(() => { result = parseProject(JSON.stringify({ ...snoBase, program }), catalogFor); }, "hostile program does not throw");
    eq(result.ok, false, `program ${JSON.stringify(program)} is refused`);
  }
  ok(parseProject("x".repeat(70_000), catalogFor).ok === false, "oversized text refused");
  ok(parseProject({ toString: 0 }, catalogFor).ok === false, "a non-string input is refused without a throw");
}

// ── Worker sanitizers: strict types, never a throw ─────────────────────────────────────────
{
  const base = { position: [0, 0.48, 0], rotation: [0, 0, 0], sockets: [36, 39] };
  for (const position of [[{ toString: 0, valueOf: 0 }, 0, 0], [false, "", null], ["0", 0, 0], [0, 0], [0, 0, 0, 0], [Number.NaN, 0, 0], [99, 0, 0]]) {
    let out;
    assert.doesNotThrow(() => { out = worker.sanitizeTransform({ ...base, position }, "resistor-1k"); }, `position ${JSON.stringify(position)} does not throw`);
    eq(out, null, `position ${JSON.stringify(position)} is rejected, not coerced`);
  }
  for (const sockets of [[true, ""], [{ valueOf: 1 }, 2], ["36", 39], [36], [36, 39, 40], [-1, 39], [36.5, 39]]) {
    eq(worker.sanitizeTransform({ ...base, sockets }, "resistor-1k"), null, `sockets ${JSON.stringify(sockets)} rejected`);
  }
  eq(worker.sanitizeTransform([1, 2, 3], "resistor-1k"), null, "an array is not a transform");
  eq(worker.sanitizeTransform({ ...base, endpoints: [[{ toString: 0 }, 0, 0], [0, 0, 0]] }, "wire-red"), null, "hostile endpoints rejected");
  const edit = { opId: "op-1", changes: [{ componentId: "resistor-1k", transform: base, expectRev: 0 }] };
  ok(worker.sanitizeEdit(edit) !== null, "a valid edit passes");
  for (const bad of [
    { ...edit, opId: { toString: 0 } }, { ...edit, opId: "has space" }, { ...edit, changes: "x" }, { ...edit, changes: [] },
    { ...edit, changes: [{ ...edit.changes[0], expectRev: "0" }] }, { ...edit, changes: [{ ...edit.changes[0], expectRev: -1 }] },
    { ...edit, changes: [{ ...edit.changes[0], componentId: "led-red::endpoint-0" }] },
    { ...edit, changes: [edit.changes[0], edit.changes[0]] },
    { ...edit, changes: [{ ...edit.changes[0], transform: { ...base, activeEndpoint: 0 } }] },
    { ...edit, program: { program: [], running: "false", expectRev: 0 } },
    { ...edit, program: { program: [{ op: "wait", ms: { valueOf: 0 } }], running: false, expectRev: 0 } },
    { ...edit, program: { program: [], running: false, expectRev: "0" } },
    null, [], "edit",
  ]) {
    let out;
    assert.doesNotThrow(() => { out = worker.sanitizeEdit(bad); }, "hostile edit does not throw");
    eq(out, null, `edit ${JSON.stringify(bad)?.slice(0, 80)} rejected`);
  }
  ok(worker.sanitizeEdit({ opId: "op-2", changes: [], program: { program: [], running: true, expectRev: null } }) !== null, "an unconditional program-only edit passes");
  for (const program of [[{ op: "wait", ms: { valueOf: 0 } }], [{ op: "wait", ms: "50" }], [null], "x", [{ op: "write", pin: "D5", value: 1 }]]) {
    eq(worker.sanitizeProgram(program), null, `worker program ${JSON.stringify(program)} rejected`);
  }
}

// ── Snap-style studs may be shared; breadboard holes may not ───────────────────────────────
{
  const studs = { studio: "snapino", parts: { "sno-l1": null, "sno-w3": null }, socketCount: 63, switches: [], sharedSockets: true };
  const stacked = buildProject(studs, { "sno-l1": seated(5, 30), "sno-w3": seated(30, 33) });
  ok(parseProject(JSON.stringify(stacked), () => studs).ok, "a Snapino demo with parts stacked on one stud re-imports");
  const holes = { studio: "circuit", parts: { "led-red": null, "resistor-1k": "resistor" }, socketCount: 192, switches: [] };
  const clash = buildProject(holes, { "led-red": seated(53, 52), "resistor-1k": seated(52, 39, { ohms: 1000 }) });
  eq(parseProject(JSON.stringify(clash), () => holes).ok, false, "two leads in one breadboard hole are refused");
}

// ── Snapino programs in history, export and recovery (PR #3 review) ───────────────────────
{
  const P = [{ op: "write", pin: "D5", value: true }];
  const Q = [{ op: "write", pin: "D6", value: true }];
  const R = [{ op: "write", pin: "D3", value: true }];
  const history = new EditHistory();
  // A program-only import is one undo entry.
  ok(history.record("Loaded a project", [], { before: P, after: Q }), "a program-only import is recorded");
  ok(!history.record("noop", [], { before: Q, after: Q }), "an unchanged program is not recorded");
  let room = Q;
  let verdict = history.peek("undo", () => null, () => false, () => room);
  eq([verdict.ok, verdict.program], [true, P], "undo of a program-only import restores the previous program");
  history.commit("undo");
  room = P;
  verdict = history.peek("redo", () => null, () => false, () => room);
  eq([verdict.ok, verdict.program], [true, Q], "redo brings the imported program back");
  history.commit("redo");
  room = R; // a teammate uploads R after the import
  verdict = history.peek("undo", () => null, () => false, () => room);
  eq([verdict.ok, verdict.reason, verdict.partId], [false, "stale", "program"], "a stale undo never overwrites a teammate's newer program R");
  ok(!history.canUndo, "and the stale entry is discarded");
  // Parts and program together are one step; the room's refusal keeps or drops it.
  const both = new EditHistory();
  both.record("Loaded a project", [{ id: "sno-l1", before: home(1), after: seated(10, 28) }], { before: P, after: Q });
  verdict = both.peek("undo", (id) => (id === "sno-l1" ? seated(10, 28) : null), () => false, () => Q);
  eq([verdict.ok, verdict.apply.length, verdict.program], [true, 1, P], "parts + program undo as one step");
  ok(both.canUndo, "peek does not move the entry");
  both.drop("undo");
  ok(!both.canUndo && !both.canRedo, "a room-stale step is dropped");
  ok(sameProgram(null, []) && !sameProgram(P, Q), "programs compare by statements");

  // Two quick Undo presses peek the same entry; the second's refusal must not drop another one.
  const twice = new EditHistory();
  twice.record("E2", [{ id: "led-red", before: home(1), after: home(2) }]);
  twice.record("E1", [{ id: "led-red", before: home(2), after: home(3) }]);
  const first = twice.peek("undo", () => home(3), () => false);
  const second = twice.peek("undo", () => home(3), () => false);
  twice.commit("undo", first.entry);
  twice.drop("undo", second.entry); // refused as stale by the room (already undone)
  eq([twice.undoLabel, twice.redoLabel], ["E2", "E1"], "a duplicate step's refusal never drops an unrelated entry");

  // Export separates the room's program from an unsaved editor draft.
  const exported = buildProject(catalogFor("snapino"), {}, P, new Date(0), Q);
  eq([exported.program, exported.draftProgram], [P, Q], "export keeps the room program and the unsaved draft apart");
  eq(buildProject(catalogFor("snapino"), {}, P, new Date(0), P).draftProgram, undefined, "no draft when the editor matches the room");
  const reparsed = parseProject(JSON.stringify(exported), catalogFor);
  eq([reparsed.ok, reparsed.project.program, reparsed.project.draftProgram], [true, P, Q], "both survive a round trip");
  const draftOnCircuit = JSON.parse(JSON.stringify(buildProject(catalogFor("circuit"), {})));
  draftOnCircuit.draftProgram = Q;
  eq(parseProject(JSON.stringify(draftOnCircuit), catalogFor).ok, false, "only Snapino projects carry a draft");
}

// ── Final acceptance patch: program loads always stop; off-board values are not "empty" ────
{
  const Q = [{ op: "write", pin: "D5", value: true }];
  const T = [{ op: "write", pin: "D6", value: true }];
  eq(planProgramLoad(Q, true, Q), { send: { program: Q, running: false }, statementsChanged: false, stops: true }, "same statements while running: an authoritative stop is sent");
  eq(planProgramLoad(Q, false, Q), { statementsChanged: false, stops: false }, "same statements, already stopped: nothing to send");
  eq(planProgramLoad(Q, true, T), { send: { program: T, running: false }, statementsChanged: true, stops: true }, "new statements while running: loaded stopped");
  eq(planProgramLoad(Q, false, T), { send: { program: T, running: false }, statementsChanged: true, stops: false }, "new statements while stopped: loaded stopped");
  eq(planProgramLoad(Q, true, undefined), { statementsChanged: false, stops: false }, "a project without a program leaves the room program alone");

  const defaults = (id) => ({ "resistor-1k": { ohms: 1000 }, "battery-9v": { volts: 9 } })[id] ?? null;
  const cat = { studio: "circuit", parts: { "resistor-1k": "resistor", "battery-9v": "battery", "led-red": null }, socketCount: 192, switches: [] };
  const tray = (overrides = {}) => buildProject(cat, {
    "resistor-1k": { ...home(1), props: { ohms: 1000 } }, "battery-9v": { ...home(2), props: { volts: 9 } }, "led-red": home(3), ...overrides,
  });
  ok(isDefaultProject(tray(), defaults), "every part in the tray at default values is empty");
  const edited = tray({ "resistor-1k": { ...home(1), props: { ohms: 470 } } });
  ok(!isDefaultProject(edited, defaults), "a tray-only 470 Ω resistor is not empty");
  const reparsed = parseProject(JSON.stringify(edited), () => cat);
  ok(reparsed.ok && !isDefaultProject(reparsed.project, defaults) && reparsed.project.parts.find((part) => part.id === "resistor-1k").props.ohms === 470, "and survives save → parse");
  ok(!isDefaultProject(tray({ "battery-9v": { ...home(2), props: { volts: 5 } } }), defaults), "an off-board 5 V battery is not empty");
  ok(!isDefaultProject(tray({ "led-red": seated(53, 52) }), defaults), "a seated part is not empty");
  const sw = { studio: "snap", parts: { "snap-s1": null }, socketCount: 63, switches: ["snap-s1"], sharedSockets: true };
  ok(!isDefaultProject(buildProject(sw, { "snap-s1": { ...home(1), on: true } }), () => null), "a switch left on is not empty");
  ok(isDefaultProject(buildProject(sw, { "snap-s1": { ...home(1), on: false } }), () => null), "a switch off in the tray is empty");
  ok(!isDefaultProject(buildProject({ studio: "snapino", parts: {}, socketCount: 63 }, {}, Q), () => null), "a program alone is not empty");
}

// ── Episode 1 design in project files ──────────────────────────────────────────────────────
{
  const sno = { studio: "snapino", parts: { "sno-l1": null }, socketCount: 63, switches: [], sharedSockets: true };
  const withDesign = buildProject(sno, {}, [{ op: "wait", ms: 50 }], new Date(0), null, { mission: "ridge", intent: ["INJURED", "NORTH"] });
  eq(withDesign.episode, { id: "rescue-signal", v: 1, mission: "ridge", intent: ["INJURED", "NORTH"] }, "a Snapino project carries the design");
  const back = parseProject(JSON.stringify(withDesign), () => sno);
  eq(back.ok && back.project.episode, withDesign.episode, "and it round-trips");
  for (const episode of [{ id: "rescue-signal", v: 2, mission: "ridge", intent: [] }, { id: "rescue-signal", v: 1, mission: "moon", intent: [] }, { id: "rescue-signal", v: 1, mission: "ridge", intent: ["HELLO"] },
    { id: "rescue-signal", v: 1, mission: "ridge", intent: ["HELP", "HELP", "HELP", "HELP"] }, { id: "rescue-signal", v: 1, mission: { toString: 0 }, intent: [] }, "rescue", null, [] ]) {
    let result;
    assert.doesNotThrow(() => { result = parseProject(JSON.stringify({ ...withDesign, episode }), () => sno); });
    eq(result.ok, false, `design ${JSON.stringify(episode)} refused`);
  }
  const circuitWithDesign = { ...JSON.parse(JSON.stringify(buildProject(catalogFor("circuit"), {}))), episode: withDesign.episode };
  eq(parseProject(JSON.stringify(circuitWithDesign), catalogFor).ok, false, "only Snapino projects carry a design");
  ok(!isDefaultProject({ ...buildProject(sno, {}, null), episode: withDesign.episode }, () => null), "a design with words is worth saving");
  ok(isDefaultProject({ ...buildProject(sno, {}, null), episode: { id: "rescue-signal", v: 1, mission: "ridge", intent: [] } }, () => null), "the default design alone is not");
  ok(parseProject(JSON.stringify(buildProject(sno, {}, [{ op: "wait", ms: 50 }])), () => sno).ok, "older Snapino projects without a design still import");
}

console.log(`project state: ${checks} checks passed`);
