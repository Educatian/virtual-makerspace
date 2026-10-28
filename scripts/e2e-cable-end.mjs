// Cable ends over the real Worker (Durable Object + WebSocket), two browsers, through the
// app's own drag path (claim → snapped move → release in one task, via the ?qa hook):
// a seated end must stay seated for its mover, reach the teammate, be exactly one undo step
// (undo restores the free end on both screens, redo seats it again), and reach a late joiner;
// two people may each seat one end of the same cable. Every page waits for an explicit, measured
// readiness (scripts/lib/e2e-readiness.mjs); a failure writes diagnostics to the artifacts folder.
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799
//   node scripts/e2e-cable-end.mjs [http://vm.test:8800] [artifacts-dir]   (fresh random room)
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dumpDiagnostics, instrument, settled } from "./lib/e2e-readiness.mjs";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `W${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const artifacts = process.argv[3] ?? `${tmpdir()}/vm-e2e-cable-${room}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8799", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const press = async (page, name) => {
  const handle = await page.waitForFunction((label) => [...document.querySelectorAll("button")].find((candidate) =>
    !candidate.disabled && (candidate.getAttribute("aria-label") === label || candidate.textContent.trim() === label)), name, { timeout: 120_000, polling: 250 })
    .catch(async (error) => { await dumpDiagnostics(page, artifacts, `press-${name}`); throw error; });
  await handle.evaluate((button) => button.click());
};
const until = async (read, test, timeout = 30_000) => {
  const started = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
};
const results = [];
const trail = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

async function open(email, label) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await instrument(context);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  const page = await context.newPage();
  page.e2eLabel = label;
  page.errors = [];
  page.setDefaultTimeout(300_000);
  page.on("pageerror", (error) => { page.errors.push(error.message); console.error(`[${label}] pageerror:`, error.message); });
  page.on("crash", () => { page.errors.push("crash"); console.error(`[${label}] page crashed`); });
  await page.goto(`${base}/?room=${room}&quality=low&qa`);
  await press(page, "Enter Room");
  await page.waitForSelector("#viewport-heading", { state: "attached" });
  await page.waitForFunction(() => Boolean(window.__vmQa?.dropEnd), null, { timeout: 300_000, polling: 500 });
  await settled(page, `${label} entered`, { diagnostics: artifacts });
  return page;
}
const wire = (page) => page.evaluate(() => window.__vmQa.bench().parts["wire-red"]?.sockets ?? null);
const ready = (page, label) => settled(page, label, { diagnostics: artifacts });
/** Click by selector (labels change: "Undo: Moved …"); it must be present and enabled. */
const click = async (page, selector) => {
  await page.waitForFunction((s) => { const element = document.querySelector(s); return Boolean(element) && !element.disabled; }, selector, { timeout: 120_000, polling: 250 })
    .catch(async (error) => { await dumpDiagnostics(page, artifacts, `click-${selector}`, { trail }); throw error; });
  await page.evaluate((s) => document.querySelector(s).click(), selector);
};
const benchOf = (page) => page.evaluate(() => window.__vmQa.bench());
const note = async (label, page) => { trail.push({ at: new Date().toISOString(), label, page: page.e2eLabel, wire: await wire(page).catch((error) => error.message) }); };

const host = await open("host@example.test", "host");
const member = await open("member@example.test", "member");
const studios = [(await benchOf(host)).studio, (await benchOf(member)).studio];
check("both makers are on the Circuit Bench", studios.every((studio) => studio === "circuit"), JSON.stringify(studios));
const start = await wire(host);

// Host seats end A in c5 (socket 36) exactly as a pointer drag would.
check("the drag path accepts the drop", await host.evaluate(() => window.__vmQa.dropEnd("wire-red", 0, 36)));
// The moved cable end is new on-screen state for the teammate: wait for its frames first.
await ready(member, "member after the host's drop");
const seen = await until(() => wire(member), (sockets) => sockets?.[0] === 36);
await note("after host drop", member);
check("the teammate sees end A seated", seen?.[0] === 36, JSON.stringify(seen));
if (seen?.[0] !== 36) await dumpDiagnostics(member, artifacts, "teammate-view", { seen, hostWire: await wire(host), trail });
await host.waitForTimeout(1500);
check("the mover's end stays seated (its final move was not refused)", (await wire(host))?.[0] === 36, JSON.stringify(await wire(host)));
// Exactly one undo step: undo restores the free end on both screens and leaves nothing to undo;
// redo seats it again.
check("(the host can undo)", (await benchOf(host)).canUndo);
await click(host, "#undo-edit");
await ready(member, "member after undo");
const undone = await until(() => wire(member), (sockets) => JSON.stringify(sockets) === JSON.stringify(start));
await note("after undo", member);
check("undo restores the end's previous place on both screens", JSON.stringify(undone) === JSON.stringify(start) && JSON.stringify(await wire(host)) === JSON.stringify(start), `${JSON.stringify(start)} → ${JSON.stringify(undone)}`);
check("one drag was exactly one undo step (nothing left to undo, redo available)", !(await benchOf(host)).canUndo && (await benchOf(host)).canRedo);
await click(host, "#redo-edit");
await ready(member, "member after redo");
const redone = await until(() => wire(member), (sockets) => sockets?.[0] === 36);
await note("after redo", member);
check("redo seats it again on both screens", redone?.[0] === 36 && (await wire(host))?.[0] === 36, JSON.stringify(redone));

// The teammate seats the other end of the same cable.
check("the teammate's drop is accepted by the drag path", await member.evaluate(() => window.__vmQa.dropEnd("wire-red", 1, 39)));
await ready(host, "host after the member's drop");
const both = await until(() => wire(host), (sockets) => sockets?.[1] === 39);
await note("after member drop", host);
check("each end can be seated by a different maker", JSON.stringify(both) === "[36,39]" && JSON.stringify(await wire(member)) === "[36,39]", JSON.stringify(both));

// A late joiner gets both ends from the room.
await member.context().close();
const late = await open("late@example.test", "late");
const lateWire = await until(() => wire(late), (sockets) => JSON.stringify(sockets) === "[36,39]");
await note("late joiner", late);
check("a late joiner gets both seated ends from the room", JSON.stringify(lateWire) === "[36,39]", JSON.stringify(lateWire));
if (JSON.stringify(lateWire) !== "[36,39]") {
  await dumpDiagnostics(late, artifacts, "late-join", { lateWire, lateBench: await benchOf(late).catch((error) => error.message), hostWire: await wire(host).catch((error) => error.message), trail });
}
check("no page errors", [host, late].every((page) => page.errors.length === 0), [host, late].flatMap((page) => page.errors).join(" | "));

await browser.close();
writeFileSync(`${artifacts}-results.json`, JSON.stringify({ room, results, trail }, null, 1));
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · room ${room}`);
assert.equal(failed.length, 0);
