// Checks for project state: conflict-safe undo/redo, project file validation and privacy,
// and agreement between the client's and the Worker relay's property validation.
//   node --experimental-strip-types scripts/project-state-check.mjs
import assert from "node:assert/strict";

const { EditHistory, sameTransform } = await import("../src/desktop/edit-history.ts");
const { buildProject, parseProject, PROJECT_FORMAT, MAX_PROJECT_BYTES } = await import("../src/desktop/project-file.ts");
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

console.log(`project state: ${checks} checks passed`);
