// Diagnostic for the Snapino history run's "and on the importer" failures: an isolated
// reproduction of one step of e2e-snapino-history.mjs — an import with CHANGED parts and the SAME
// running program (parts and stop in one edit) — repeated, with a timeline per edit (opId):
//   clicked      the import confirmed in the importer's page (node clock)
//   wireSent     the importer's socket sent the edit (browser network layer, via CDP)
//   roomOut      first frame for that op out of the room (≈ when the room accepted it: the room
//                answers the sender and relays to the others in the same turn)
//   memberWire   the edit reached the teammate's socket (network layer)
//   memberJs     the teammate's page handled it (JavaScript message listener)
//   ackWire      the room's answer reached the importer's socket (network layer)
//   ackJs        the importer's page handled the answer (JavaScript message listener)
//   timeouts     8 s edit timers that fired in the importer's page meanwhile
//   memberReady  the teammate's bench showed the change (what the history run waited for)
//   hostAtMemberReady  the importer's bench sampled at that moment (what the history run then
//                checked at once), and when (and whether) it converged within a bound after.
// All clocks are this machine's (Date.now in node and in both pages). The network-layer times are
// when node received Chromium's DevTools event for the frame; for a page whose renderer is busy
// that event can itself arrive late, so `roomOut` (the earliest frame of the op on either tab)
// is the best of them, and the JavaScript times are exact for when each page handled it.
//
//   node scripts/e2e-snapino-import-probe.mjs [base] [iterations] [record.json]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const [base = "http://vm.test:8800", iterationsArg = "8", out = null] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const room = `H${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8799", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const press = async (page, name) => {
  const handle = await page.waitForFunction((label) => [...document.querySelectorAll("button")].find((candidate) =>
    !candidate.disabled && (candidate.getAttribute("aria-label") === label || candidate.textContent.trim() === label)), name, { timeout: 120_000 });
  await handle.evaluate((button) => button.click());
};
const tap = (page, selector) => page.evaluate((s) => document.querySelector(s)?.click(), selector);
const until = async (read, test, timeout = 60_000) => {
  const started = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return { value, ok: test(value), at: Date.now() };
};

/** opId → timeline (node clock). */
const ops = new Map();
const note = (opId, key, at = Date.now()) => {
  if (!opId) return;
  const entry = ops.get(opId) ?? {};
  entry[key] ??= at;
  ops.set(opId, entry);
};
const parse = (payload) => {
  try {
    return JSON.parse(typeof payload === "string" ? payload : payload.toString());
  } catch {
    return null;
  }
};

async function maker(email) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
    // When this page's JavaScript handles each room message, and when 8 s timers fire.
    window.__probe = { js: [], timeouts: [] };
    const add = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (type, listener, options) {
      if (type !== "message") return add.call(this, type, listener, options);
      return add.call(this, type, (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.kind === "edit" || message.kind === "edit-result") window.__probe.js.push({ kind: message.kind, opId: message.opId, at: Date.now() });
        } catch {}
        return listener.call(this, event);
      }, options);
    };
    const setTimer = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...rest) => setTimer(typeof callback === "function" && delay === 8000
      ? (...args) => { window.__probe.timeouts.push({ at: Date.now() }); return callback(...args); }
      : callback, delay, ...rest);
  });
  return context;
}
async function open(context, label, chooseStudio = false) {
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  page.on("pageerror", (error) => console.error(`[${label}] pageerror:`, error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = parse(payload);
      if (message?.kind === "edit") note(message.opId, `${label}:wireSent`);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = parse(payload);
      if (message?.kind === "edit" || message?.kind === "edit-result") {
        note(message.opId, "roomOut");
        note(message.opId, `${label}:wire:${message.kind}`);
      }
    });
  });
  await page.goto(`${base}/?room=${room}&quality=low&qa`);
  if (chooseStudio) await page.getByRole("radio", { name: /Snapino Bridge/ }).click();
  await press(page, "Enter Room");
  await page.waitForSelector("#viewport-heading", { state: "attached" });
  await page.waitForFunction(() => Boolean(window.__vmQa?.bench), null, { timeout: 300_000 });
  await page.waitForTimeout(2500);
  return page;
}
const bench = (page) => page.evaluate(() => window.__vmQa.bench());
const partsKey = (state) => JSON.stringify(Object.entries(state.parts).filter(([, part]) => part.sockets).sort(([a], [b]) => a.localeCompare(b)));
const status = (page) => page.evaluate(() => document.querySelector("#scene-status-copy")?.textContent ?? "");
async function importProject(page, project) {
  await page.setInputFiles("#project-file-input", { name: "project.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project)) });
  const opened = await page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open, null, { timeout: 30_000 }).then(() => true, () => false);
  if (!opened) throw new Error(`import did not ask for confirmation: ${await status(page)}`);
  await tap(page, "#confirm-ok");
}

const record = { base, room, iterations: [], summary: {} };
try {
  const host = await open(await maker("host@example.test"), "host", true);
  const member = await open(await maker("member@example.test"), "member");
  await press(host, "Load Snapino lamp");
  // The whole lamp wiring on both tabs (it arrives as one edit; the lamp itself must be seated),
  // so P and Q really differ in the lamp's orientation.
  const lamp = await until(() => bench(member), (state) => Boolean(state.parts["sno-l1"]?.sockets), 300_000);
  if (!lamp.ok) throw new Error("the lamp wiring did not reach the teammate within 300 s");
  const P = lamp.value;
  if (!(await until(() => bench(host), (state) => partsKey(state) === partsKey(P), 300_000)).ok) throw new Error("the importer does not show the teammate's lamp wiring within 300 s");
  record.lamp = partsKey(P);
  await press(host, "Run blocks");
  const running = await until(() => bench(member), (state) => state.running, 300_000);
  if (!running.ok) throw new Error("the lamp program did not start on the teammate within 300 s");
  const R = running.value.program;
  const pParts = Object.entries(P.parts).map(([id, part]) => ({ id, sockets: part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
  const qParts = pParts.map((part) => ({ ...part, sockets: part.id === "sno-l1" && part.sockets ? [part.sockets[1], part.sockets[0]] : part.sockets }));
  for (let i = 1; i <= iterations; i += 1) {
    // The same running program on both tabs before the import.
    if (!(await bench(member)).running) await press(member, "Run blocks");
    const runningBoth = await until(async () => [await bench(host), await bench(member)], ([h, m]) => h.running && m.running, 60_000);
    const parts = i % 2 ? qParts : pParts;
    const target = partsKey({ parts: Object.fromEntries(parts.map((part) => [part.id, { sockets: part.sockets }])) });
    await host.evaluate(() => { window.__probe.js.length = 0; window.__probe.timeouts.length = 0; });
    await member.evaluate(() => { window.__probe.js.length = 0; });
    const partsBefore = partsKey(await bench(host));
    if (partsBefore === target) throw new Error(`iteration ${i}: the import would not change the parts (${target})`);
    const before = new Set(ops.keys());
    const clicked = Date.now();
    await importProject(host, { format: "virtual-makerspace.project", version: 1, solver: "dc-mna-1.0.0", studio: "snapino", savedAt: new Date().toISOString(), parts, program: R });
    const memberReady = await until(() => bench(member), (state) => !state.running && partsKey(state) === target, 180_000);
    const hostAtMemberReady = await bench(host);
    const hostSampledAt = Date.now();
    const hostConverged = await until(() => bench(host), (state) => !state.running && partsKey(state) === target, 30_000);
    await host.waitForTimeout(300);
    const hostJs = await host.evaluate(() => window.__probe);
    const memberJs = await member.evaluate(() => window.__probe);
    const opId = [...ops.keys()].find((id) => !before.has(id) && ops.get(id)["host:wireSent"]);
    const times = opId ? ops.get(opId) : {};
    const rel = (at) => (typeof at === "number" ? at - clicked : null);
    const entry = {
      i,
      opId: opId?.slice(0, 8) ?? null,
      runningBeforeImport: runningBoth.ok,
      ms: {
        wireSent: rel(times["host:wireSent"]),
        roomOut: rel(times.roomOut),
        memberWire: rel(times["member:wire:edit"]),
        memberJs: rel(memberJs.js.find((m) => m.kind === "edit" && m.opId === opId)?.at),
        ackWire: rel(times["host:wire:edit-result"]),
        ackJs: rel(hostJs.js.find((m) => m.kind === "edit-result" && m.opId === opId)?.at),
        memberReady: rel(memberReady.at),
        hostSampled: rel(hostSampledAt),
        hostConverged: hostConverged.ok ? rel(hostConverged.at) : null,
      },
      timeouts: hostJs.timeouts.map((t) => rel(t.at)),
      memberReadyOk: memberReady.ok,
      hostAtMemberReady: { running: hostAtMemberReady.running, partsMatch: partsKey(hostAtMemberReady) === target },
      hostConvergedOk: hostConverged.ok,
      hostStatus: await status(host),
      partsChange: `${partsBefore} → ${target}`,
      history: { canUndo: hostConverged.value.canUndo, canRedo: hostConverged.value.canRedo },
    };
    record.iterations.push(entry);
    console.log(JSON.stringify(entry));
  }
} catch (error) {
  record.error = error.message.split("\n")[0];
  console.log(`error: ${record.error}`);
} finally {
  const its = record.iterations;
  record.summary = {
    iterations: its.length,
    hostNotYetConvergedWhenMemberReady: its.filter((e) => !(e.hostAtMemberReady.partsMatch && !e.hostAtMemberReady.running)).length,
    hostConvergedWithinBound: its.filter((e) => e.hostConvergedOk).length,
    editTimeoutsFired: its.reduce((n, e) => n + e.timeouts.length, 0),
    maxAckJsMs: Math.max(0, ...its.map((e) => e.ms.ackJs ?? 0)),
    maxAckWireToJsMs: Math.max(0, ...its.map((e) => (e.ms.ackJs ?? 0) - (e.ms.ackWire ?? 0))),
  };
  console.log(`summary ${JSON.stringify(record.summary)}`);
  if (out) writeFileSync(out, JSON.stringify(record, null, 1));
  await browser.close();
}
