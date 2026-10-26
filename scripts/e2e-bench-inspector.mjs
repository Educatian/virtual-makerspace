// Snapino bench inspector, live diagram and camera views — two real browsers over the real
// Worker (Durable Object + WebSocket). Developer-environment run (headless Chromium, SwiftShader),
// not CI. A fresh random room every run (never 7K3M).
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799
//   node --experimental-strip-types scripts/e2e-bench-inspector.mjs [http://vm.test:8800] [artifacts-dir]
//
// Checks, with real pointer and keyboard input (Playwright mouse/keyboard, not element.click()):
//  - a pointer click on a part in 3D selects it, focuses the inspector, highlights its rung and both
//    nets on the diagram and the same studs in 3D (compared against an independent rebuild of the
//    diagram from the bench the page reports);
//  - keyboard only: Tab to a diagram rung, Enter selects that part in 3D; Tab to "Switch S1 on",
//    Enter submits ONE room edit; when accepted, both clients' bench, diagram, D2 input LED agree,
//    and the code editor's unsaved draft is untouched;
//  - declined: while a teammate holds S1, the inspector says so and offers no switch, a double-click
//    on S1 changes nothing for anyone;
//  - stale: two simultaneous flips — the room accepts one, the other client shows "Not changed" and
//    holds exactly the room's state (attempted up to 6 times; reported as observed or not);
//  - camera views by pointer and by key: bench framing inside the free view, top view, table, lamp,
//    fit-part; renderer counters per view.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dumpDiagnostics, instrument, settled } from "./lib/e2e-readiness.mjs";
import { buildSnapinoDiagram } from "../src/circuit/snapino-diagram.ts";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `I${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const artifacts = process.argv[3] ?? `${tmpdir()}/vm-e2e-inspector-${room}`;
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8799", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const ready = (page, label) => settled(page, label, { diagnostics: artifacts });
const until = async (read, test, timeout = 180_000) => {
  const started = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    value = await read();
  }
  return value;
};
const bench = (page) => page.evaluate(() => window.__vmQa.bench());
const seatOf = (snapshot, id) => JSON.stringify(snapshot?.parts?.[id]?.sockets ?? null);
const LOW = { D3: false, D5: false, D6: false };

async function maker(email, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await instrument(context);
  // http://vm.test is not a secure origin, where Chromium has no crypto.randomUUID (as in the other e2e tests).
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  return context;
}
async function join(context, label, host) {
  const page = await context.newPage();
  page.e2eLabel = label;
  page.setDefaultTimeout(300_000);
  page.errors = [];
  page.on("pageerror", (error) => { page.errors.push(error.message); console.error(`[${label}] pageerror:`, error.message); });
  await page.goto(`${base}/?room=${room}&quality=low&qa`);
  await page.waitForSelector("#enter-room", { state: "attached" });
  if (host) await page.getByRole("radio", { name: /Snapino Bridge/ }).click();
  await page.locator("#enter-room").click();
  await page.waitForFunction(() => Boolean(window.__vmQa?.bench) && window.__vmQa.bench().studio === "snapino", null, { timeout: 300_000, polling: 500 });
  await ready(page, `${label} entered`);
  return page;
}
/** Center of a part on screen (its glowing surface for lamps, else the whole part). */
async function partCenter(page, id) {
  const rect = await page.evaluate((part) => window.__vmQa.partScreenRect(part), id);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
/** Tab through the page until the focused element matches `selector` (keyboard only). */
async function tabTo(page, selector, max = 80) {
  for (let step = 0; step < max; step += 1) {
    if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return step;
    await page.keyboard.press("Tab");
  }
  return -1;
}
/** Expected highlights, rebuilt in node from the bench the page reports. */
function expectedHighlights(snapshot, id, pins = LOW) {
  const diagram = buildSnapinoDiagram(snapshot.parts, pins);
  const sockets = snapshot.parts[id]?.sockets;
  if (!sockets) return [];
  const rowA = diagram.rows.find((row) => row.studs.includes(sockets[0]));
  const rowB = diagram.rows.find((row) => row.studs.includes(sockets[1]));
  const out = [];
  for (const [row, tone] of [[rowA, "a"], [rowB, "b"]]) for (const stud of row.studs) {
    if (out.some((entry) => entry.socket === stud)) continue;
    out.push({ socket: stud, tone: rowA === rowB ? "fault" : tone, terminal: stud === sockets[0] || stud === sockets[1] });
  }
  return out.sort((a, b) => a.socket - b.socket);
}
const sorted = (list) => [...list].sort((a, b) => a.socket - b.socket);

try {
  const hostContext = await maker("host@example.test", { width: 1000, height: 700 });
  const memberContext = await maker("member@example.test", { width: 1000, height: 700 });
  const host = await join(hostContext, "host", true);
  const member = await join(memberContext, "member", false);

  // ── Bench: the field-test layout (L1 D5 → GND) plus S1 from 5V to D2, through the room ──
  await host.locator("#load-field-test").click();
  await until(() => bench(member), (snapshot) => seatOf(snapshot, "sno-l1") === "[12,30]");
  const seated = await host.evaluate(() => window.__vmQa.seatShared({ "sno-s1": [14, 32], "sno-w4a": [32, 28], "sno-w2b": [28, 10] }));
  const memberBench = await until(() => bench(member), (snapshot) => seatOf(snapshot, "sno-s1") === "[14,32]" && seatOf(snapshot, "sno-w2b") === "[28,10]");
  check("bench built through the room (layout button + one atomic edit)", seated && seatOf(memberBench, "sno-l1") === "[12,30]" && seatOf(memberBench, "sno-s1") === "[14,32]");
  await ready(host, "host after bench");
  await ready(member, "member after bench");

  // ── 1. Pointer: click the lamp in 3D ──
  const lamp = await partCenter(host, "sno-l1");
  await host.mouse.move(lamp.x, lamp.y);
  await host.mouse.down();
  await host.mouse.up();
  await ready(host, "host after lamp click");
  const afterClick = await until(() => host.evaluate(() => ({
    title: document.querySelector("#si-part-title")?.textContent ?? null,
    tab: document.querySelector(".discussion-tab.is-active")?.dataset.tab ?? null,
    rung: document.querySelector('#si-diagram [data-part="sno-l1"]')?.getAttribute("aria-pressed") ?? null,
    hot: [...document.querySelectorAll("#si-diagram .dg-row.is-hot")].map((row) => row.dataset.row),
    highlights: window.__vmQa.highlights(),
  })), (value) => value.title === "Lamp L1" && value.rung === "true");
  check("pointer click on the 3D lamp selects it and focuses the inspector tab", afterClick.title === "Lamp L1" && afterClick.tab === "inspect", JSON.stringify({ title: afterClick.title, tab: afterClick.tab }));
  check("the lamp's rung is selected and both of its nets are highlighted on the diagram", afterClick.rung === "true" && JSON.stringify(afterClick.hot.sort()) === JSON.stringify(["D5", "GND"]), afterClick.hot.join(","));
  const hostBench1 = await bench(host);
  const expected1 = expectedHighlights(hostBench1, "sno-l1");
  check("3D highlights = the studs of the lamp's two nets (independent rebuild), terminals marked", JSON.stringify(sorted(afterClick.highlights)) === JSON.stringify(expected1), `${afterClick.highlights.length} rings`);
  check("the click did not move the lamp (both clients)", seatOf(hostBench1, "sno-l1") === "[12,30]" && seatOf(await bench(member), "sno-l1") === "[12,30]");
  await host.screenshot({ path: `${artifacts}/01-host-lamp-selected.png` });

  // ── 2. Keyboard only: diagram rung → S1, then the switch ──
  await host.evaluate(() => document.querySelector('.discussion-tab[data-tab="inspect"]')?.focus());
  const steps = await tabTo(host, '#si-diagram [data-part="sno-s1"]');
  check("Tab reaches the S1 rung on the diagram", steps >= 0, `${steps} Tab presses`);
  await host.keyboard.press("Enter");
  const s1Selected = await until(() => host.evaluate(() => ({ title: document.querySelector("#si-part-title")?.textContent ?? null, highlights: window.__vmQa.highlights() })), (value) => value.title === "Slide switch S1");
  const terminals = s1Selected.highlights.filter((entry) => entry.terminal).map((entry) => entry.socket).sort((a, b) => a - b);
  check("Enter on the rung selects S1 (inspector + its two studs ringed in 3D)", s1Selected.title === "Slide switch S1" && JSON.stringify(terminals) === "[14,32]", JSON.stringify(terminals));
  const DRAFT = [{ op: "write", pin: "D6", value: true }, { op: "wait", ms: 700 }];
  await host.evaluate((program) => window.__vmQa.editDraft(program), DRAFT);
  const switchSteps = await tabTo(host, '#si-part [data-act="switch"]');
  check("Tab reaches the inspector's Switch S1 button", switchSteps >= 0, `${switchSteps} Tab presses`);
  await host.keyboard.press("Enter");
  const both = await until(async () => [await bench(host), await bench(member)], ([a, b]) => a.parts["sno-s1"]?.on === true && b.parts["sno-s1"]?.on === true);
  check("Enter on Switch S1 on: accepted, S1 on for both clients", both[0].parts["sno-s1"]?.on === true && both[1].parts["sno-s1"]?.on === true);
  await ready(host, "host after switch");
  await ready(member, "member after switch");
  const view = (page) => page.evaluate(() => ({
    note: document.querySelector("#si-part .si-edit")?.textContent ?? null,
    s1: document.querySelector('#si-diagram [data-part="sno-s1"]')?.classList.contains("is-active") ?? null,
    d2: [...(document.querySelector('#si-diagram [data-row="D2"]')?.classList ?? [])].find((name) => name.startsWith("is-") && name !== "is-hot") ?? null,
    connections: document.querySelector("#si-connections")?.textContent ?? "",
    leds: document.querySelector("#pin-leds")?.textContent.replace(/\s+/g, " ") ?? "",
    draft: window.__vmQa.bench().draft,
  }));
  const hostView = await until(() => view(host), (value) => value.s1 === true && /D2\s*HIGH/.test(value.leds) && /room accepted it/.test(value.note ?? ""));
  const memberView = await until(() => view(member), (value) => value.s1 === true && /D2\s*HIGH/.test(value.leds));
  check("host: inspector reports the room accepted it (immediately, or when a late answer lands)", /room accepted it.*S1 is on/.test(hostView.note ?? ""), hostView.note ?? "");
  check("diagram on both: S1 closed, D2's net at 5 V", hostView.s1 && memberView.s1 && hostView.d2 === "is-supply" && memberView.d2 === "is-supply", `${hostView.d2}/${memberView.d2}`);
  check("code panel on both: D2 input reads HIGH", /D2\s*HIGH/.test(hostView.leds) && /D2\s*HIGH/.test(memberView.leds), `${hostView.leds} | ${memberView.leds}`);
  check("both clients' diagrams list the same connections", hostView.connections.length > 0 && hostView.connections === memberView.connections, hostView.connections);
  check("the unsaved code draft is untouched by the accepted edit", JSON.stringify(hostView.draft) === JSON.stringify(DRAFT));
  const memberHighlightsOff = await member.evaluate(() => window.__vmQa.highlights());
  check("the member, with nothing selected, has no stud rings (selection is local)", memberHighlightsOff.length === 0);
  await host.screenshot({ path: `${artifacts}/02-host-s1-on.png` });

  // ── 3. Declined: the member holds S1 ──
  const memberS1 = await partCenter(member, "sno-s1");
  await member.mouse.move(memberS1.x, memberS1.y);
  await member.mouse.down();
  await member.mouse.move(memberS1.x + 2, memberS1.y + 1);
  const held = await until(() => host.evaluate(() => ({
    held: document.querySelector("#si-part .si-held")?.textContent ?? null,
    button: Boolean(document.querySelector('#si-part [data-act="switch"]')),
    disabled: document.querySelector('#si-part [data-act="switch"]')?.disabled ?? null,
  })), (value) => Boolean(value.held));
  check("while the member holds S1, the host's inspector says so and the switch is disabled", Boolean(held.held) && held.disabled === true, JSON.stringify(held));
  const hostS1 = await partCenter(host, "sno-s1");
  await host.mouse.dblclick(hostS1.x, hostS1.y);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const declined = [await bench(host), await bench(member)];
  check("a double-click on held S1 changes nothing for anyone", declined.every((snapshot) => snapshot.parts["sno-s1"]?.on === true));
  await member.mouse.move(memberS1.x, memberS1.y);
  await member.mouse.up();
  const released = await until(async () => [await bench(host), await bench(member)], ([a, b]) => seatOf(a, "sno-s1") === "[14,32]" && seatOf(b, "sno-s1") === "[14,32]" && !a.parts["sno-s1"]?.held);
  check("after the member lets go, S1 is still seated on both", released.every((snapshot) => seatOf(snapshot, "sno-s1") === "[14,32]"));
  await ready(host, "host after release");
  await ready(member, "member after release");
  await until(() => host.evaluate(() => !document.querySelector("#si-part .si-held")), Boolean);

  // ── 4. Stale: both flip at once ──
  await member.evaluate(() => document.querySelector('.discussion-tab[data-tab="inspect"]')?.click());
  await member.evaluate(() => document.querySelector('#si-diagram [data-part="sno-s1"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await until(() => member.evaluate(() => Boolean(document.querySelector('#si-part [data-act="switch"]:not([disabled])'))), Boolean);
  let staleSeen = null;
  const attempts = [];
  for (let attempt = 1; attempt <= 6 && !staleSeen; attempt += 1) {
    await until(() => Promise.all([host, member].map((page) => page.evaluate(() => Boolean(document.querySelector('#si-part [data-act="switch"]:not([disabled])'))))), (list) => list.every(Boolean));
    const before = (await bench(host)).parts["sno-s1"]?.on;
    await Promise.all([host, member].map((page) => page.evaluate(() => document.querySelector('#si-part [data-act="switch"]')?.click())));
    const notes = await until(() => Promise.all([host, member].map((page) => page.evaluate(() => document.querySelector("#si-part .si-edit")?.textContent ?? null))), (list) => list.every(Boolean));
    const states = await until(async () => [await bench(host), await bench(member)], ([a, b]) => a.parts["sno-s1"]?.on === b.parts["sno-s1"]?.on, 60_000);
    const refused = notes.map((note) => /^Not changed/.test(note ?? ""));
    // A page stalled past the 8 s edit deadline reports "Not confirmed in time" (it may still land):
    // that attempt is recorded, never counted as a stale refusal.
    attempts.push({ attempt, before, notes, after: states.map((snapshot) => snapshot.parts["sno-s1"]?.on) });
    check(`flip attempt ${attempt}: a refused flip's client holds the room's state; no note claims a change that did not happen`, notes.every((note, index) => !/room accepted it: S1 is (on|off)/.test(note ?? "") || states[index].parts["sno-s1"]?.on === /S1 is on/.test(note)), JSON.stringify(notes));
    if (refused.filter(Boolean).length === 1) staleSeen = { attempt, refusedBy: refused[0] ? "host" : "member", notes, states: states.map((snapshot) => snapshot.parts["sno-s1"]?.on) };
    // Clear the notes for the next attempt by reselecting.
    for (const page of [host, member]) await page.evaluate(() => document.querySelector('#si-diagram [data-part="sno-s1"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await ready(host, `host after flip ${attempt}`);
  }
  writeFileSync(`${artifacts}/stale-attempts.json`, JSON.stringify(attempts, null, 1));
  check("concurrent flips: one accepted, the other refused as stale (observed)", Boolean(staleSeen), staleSeen ? `attempt ${staleSeen.attempt}, refused on ${staleSeen.refusedBy}` : `not observed in ${attempts.length} attempts`);
  if (staleSeen) check("after the refusal both clients hold the same S1 state (the refused flip left no local change)", staleSeen.states[0] === staleSeen.states[1], JSON.stringify(staleSeen));

  // ── 5. Camera views, pointer and keyboard ──
  const cam = async (page) => until(() => page.evaluate(() => window.__vmQa.camera()), (value) => value && !value.moving, 60_000);
  const statsAt = async (page, label) => { await ready(page, `host view ${label}`); return page.evaluate(() => window.__vmQa.stats()); };
  const stats = {};
  await host.locator('#view-presets [data-view="bench"]').click();
  const benchCam = await cam(host);
  const rect = await host.evaluate(() => window.__vmQa.benchRect());
  stats.bench = await statsAt(host, "bench");
  const inside = rect.bench.x >= rect.free.x - 2 && rect.bench.x + rect.bench.width <= rect.free.x + rect.free.width + 2;
  check("Bench view: the base and carrier sit inside the free view and fill most of its width", inside && rect.bench.width >= 0.6 * rect.free.width, `bench ${Math.round(rect.bench.width)} px of ${Math.round(rect.free.width)} px free`);
  await host.screenshot({ path: `${artifacts}/03-view-bench.png` });
  await host.locator('#view-presets [data-view="top"]').click();
  const topCam = await cam(host);
  const dx = topCam.position[0] - topCam.target[0];
  const dy = topCam.position[1] - topCam.target[1];
  check("Top view: camera above the bench, columns left to right", Math.abs(dx) < 0.01 && dy > 0.9 * Math.hypot(dx, dy, topCam.position[2] - topCam.target[2]), JSON.stringify(topCam));
  stats.top = await statsAt(host, "top");
  await host.screenshot({ path: `${artifacts}/04-view-top.png` });
  await host.locator('#view-presets [data-view="table"]').click();
  const tableCam = await cam(host);
  const distance = (c) => Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1], c.position[2] - c.target[2]);
  check("Table view: pulled back past the bench view (tray included)", distance(tableCam) > distance(benchCam), `${distance(tableCam).toFixed(2)} vs ${distance(benchCam).toFixed(2)}`);
  stats.table = await statsAt(host, "table");
  await host.mouse.click(5, 690); // move focus off any control, onto the page
  await host.keyboard.press("4");
  const lampCam = await cam(host);
  check("key 4: receiver's view of the lamp", distance(lampCam) < distance(tableCam), JSON.stringify(lampCam.target.map((v) => Number(v.toFixed(2)))));
  stats.receiver = await statsAt(host, "receiver");
  await host.keyboard.press("1");
  const keyBench = await cam(host);
  check("key 1: back to the bench view", Math.abs(distance(keyBench) - distance(benchCam)) < 0.05);
  const lampAgain = await partCenter(host, "sno-l1");
  await host.mouse.click(lampAgain.x, lampAgain.y);
  await ready(host, "host select for fit");
  await host.keyboard.press("f");
  const fitCam = await cam(host);
  check("F fits the selected part (closer than the bench view)", distance(fitCam) < distance(benchCam), distance(fitCam).toFixed(2));
  stats.fit = await statsAt(host, "fit");
  await host.screenshot({ path: `${artifacts}/05-view-fit-lamp.png` });
  writeFileSync(`${artifacts}/render-stats.json`, JSON.stringify(stats, null, 1));
  check("renderer counters recorded per view", Object.values(stats).every((entry) => entry && entry.calls > 0), Object.entries(stats).map(([key, entry]) => `${key}: ${entry.calls} calls, ${entry.triangles} tris`).join("; "));
  check("no page errors on either client", host.errors.length === 0 && member.errors.length === 0, [...host.errors, ...member.errors].join(" | "));
} catch (error) {
  console.error(error);
  check("test ran to completion", false, error.message.split("\n")[0]);
} finally {
  writeFileSync(`${artifacts}/results.json`, JSON.stringify({ room, results }, null, 1));
  const passed = results.filter((result) => result.ok).length;
  console.log(`${passed}/${results.length} checks passed · room ${room} · artifacts ${artifacts}`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
}
