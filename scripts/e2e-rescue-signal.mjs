// Episode 1 · Rescue Signal Workshop — two real browsers over the real Worker (Durable Object
// + WebSocket), clicking the actual panel:
//   roles → design → build (demo lamp) → transmit → the RECEIVER's bench lamp follows the
//   timeline frame by frame → first reading → comparison (delivered) → explanation → close;
//   an ambiguous-timing round; an open-circuit round and its recovery; a reconnect mid-
//   transmission (shared elapsed time, role must be retaken); a teammate's bench change and an
//   identical-program import both ending a running transmission; the sender's Stop; role swap; export carrying
//   the design; leaving mid-transmission with no errors. Screenshots go to the given folder.
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799
//   node scripts/e2e-rescue-signal.mjs [http://vm.test:8800] [screenshot-dir]
//
// Uses a fresh random room (never 7K3M). Developer-environment run, not a CI workflow.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://vm.test:8800";
const shots = process.argv[3] ?? null;
if (shots) mkdirSync(shots, { recursive: true });
const room = `R${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8799", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const tap = async (page, selector) => {
  // Like a person: wait until the button is there and enabled (one room action at a time).
  await page.waitForFunction((s) => { const element = document.querySelector(s); return element && !element.disabled; }, selector, { timeout: 120_000 }).catch(() => undefined);
  return page.evaluate((s) => { const element = document.querySelector(s); element?.click(); return Boolean(element); }, selector);
};
const until = async (read, test, timeout = 120_000) => {
  const started = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    value = await read();
  }
  return value;
};
const D5 = (value) => ({ op: "write", pin: "D5", value });
const flash = (ms, after) => [D5(true), { op: "wait", ms }, D5(false), ...(after ? [{ op: "wait", ms: after }] : [])];
// Software rendering in two browsers takes seconds per frame, so the frame-by-frame lamp check uses
// INJURED · NORTH at the slow end of every band (~12 s, still exactly that message under the protocol).
const SLOW_INJURED_NORTH = [...flash(1450, 550), ...flash(1450, 4000), { op: "wait", ms: 4000 }, ...flash(1450, 550), ...flash(420, 550), ...flash(420, 0)];
// SAFE followed by 20 s of silence: a transmission still running when a teammate acts on it.
const LONG_SAFE = [...flash(900, 300), ...flash(300, 0), ...Array.from({ length: 4 }, () => ({ op: "wait", ms: 5000 }))];
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const panelText = (page) => page.evaluate(() => document.querySelector("#episode-body")?.innerText.replace(/\s+/g, " ") ?? "");
const episode = (page) => page.evaluate(() => window.__vmQa?.episode?.() ?? { state: null, role: null, elapsed: null });

async function maker(email, viewport = { width: 1000, height: 680 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  return context;
}
async function open(context, label, host = false) {
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(`[${label}] pageerror:`, error.message); });
  page.errors = errors;
  await page.goto(`${base}/?room=${room}&quality=low&qa`);
  await page.waitForSelector("#enter-room", { state: "attached" });
  if (host) {
    await page.getByRole("radio", { name: /Snapino Bridge/ }).click();
    await page.evaluate(() => { const box = document.querySelector("#lobby-episode"); if (box && !box.checked) box.click(); });
  }
  await tap(page, "#enter-room");
  await page.waitForFunction(() => Boolean(window.__vmQa?.episode), null, { timeout: 300_000 });
  await page.waitForFunction(() => !document.querySelector("#episode-panel")?.hidden, null, { timeout: 300_000 });
  return page;
}
/** Every frame the transmission drove: was the bench lamp lit exactly when the timeline says? */
async function lampAgreement(page, pulses, end) {
  const log = await page.evaluate(() => window.__vmQa.lightLog());
  const frames = log.filter((frame) => frame.elapsed >= 0 && frame.elapsed < end);
  const wrong = frames.filter((frame) => frame.lights.includes("sno-l1") !== pulses.some((pulse) => frame.elapsed >= pulse.start && frame.elapsed < pulse.end));
  return { frames: frames.length, wrong: wrong.length, lit: frames.filter((frame) => frame.lights.includes("sno-l1")).length };
}
async function waitEnded(page) {
  return until(() => episode(page), (state) => state.state?.round && (state.state.round.stopReason || state.elapsed >= state.state.round.durationMs + 200));
}
async function importProject(page, project) {
  await page.setInputFiles("#project-file-input", { name: "project.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project)) });
  await page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open, null, { timeout: 60_000 });
  await tap(page, "#confirm-ok");
}

const hostContext = await maker("host@example.test");
const memberContext = await maker("member@example.test");
const host = await open(hostContext, "host", true);
const member = await open(memberContext, "member");
check("the workshop panel opens for both makers (room state, not a local overlay)", (await episode(host)).state?.active && (await episode(member)).state?.active);

// Roles.
await tap(host, '[data-episode="claim-role"][data-role="sender"]');
await until(() => episode(member), (state) => state.state?.roles.sender);
await tap(member, '[data-episode="claim-role"][data-role="receiver"]');
const roles = await until(() => episode(host), (state) => state.state?.roles.receiver);
check("sender and receiver are taken by different makers", roles.role === "sender" && (await episode(member)).role === "receiver");

// Design + build (demo lamp on D5) + DI helper blocks.
await tap(host, "#load-field-test");
await until(() => host.evaluate(() => window.__vmQa.bench().parts["sno-l1"]?.sockets), Boolean);
await tap(host, '[data-episode="mission"][data-mission="ridge"]');
await until(() => episode(host), (state) => state.state?.mission === "ridge");
await tap(host, '[data-episode="intent-add"][data-word="INJURED"]');
await until(() => episode(host), (state) => state.state?.intent.length === 1);
await tap(host, '[data-episode="intent-add"][data-word="NORTH"]');
await until(() => episode(host), (state) => state.state?.intent.length === 2);
await tap(host, '[data-episode="write-blocks"]');
await shot(host, "01-sender-design");
await host.evaluate((program) => window.__vmQa.editDraft(program), SLOW_INJURED_NORTH);
const receiverBefore = await panelText(member);
check("the receiver's panel does not show the intended message", !/Intended message|INJURED ▬ ▬ NORTH/.test(receiverBefore) && !(await member.evaluate(() => document.querySelector("#episode-body .episode-words"))), receiverBefore.slice(0, 120));

// Round 1: transmit; the receiver's own bench lamp follows the shared timeline.
await host.evaluate(() => window.__vmQa.lightLog());
await member.evaluate(() => window.__vmQa.lightLog());
await tap(host, '[data-episode="transmit"]');
const running = await until(() => episode(member), (state) => state.state?.round?.n === 1);
const round1 = running.state.round;
check("the transmission reaches the receiver as room state", round1 && round1.intent.join() === "INJURED,NORTH");
await tap(member, '[data-episode="receiver-view"]');
await shot(member, "02-receiver-watching");
await waitEnded(member);
const expected1 = await member.evaluate(() => {
  const round = window.__vmQa.episode().state.round;
  return round;
});
// Recompute the expected light from the round itself (same pure model the test suite checks).
const { lightPulses, decode } = await import("../src/episodes/rescue-signal.ts");
const pulses1 = lightPulses({ program: expected1.program, bench: expected1.bench, durationMs: expected1.durationMs, stoppedAtMs: expected1.stoppedAtMs });
check("the round's light under the protocol is INJURED · NORTH", decode(pulses1).words.join() === "INJURED,NORTH");
const memberLamp = await lampAgreement(member, pulses1, expected1.durationMs);
const hostLamp = await lampAgreement(host, pulses1, expected1.durationMs);
// Software rendering gives only a few frames per transmission; every one of them must agree.
// Lit and dark frames are both required across the run (dark ones also come from round 5 below).
const lampFrames = { frames: 0, lit: 0, dark: 0 };
const tally = (agreement) => { lampFrames.frames += agreement.frames; lampFrames.lit += agreement.lit; lampFrames.dark += agreement.frames - agreement.lit; };
tally(memberLamp); tally(hostLamp);
check("every frame the receiver's bench lamp showed matched the timeline", memberLamp.frames >= 1 && memberLamp.wrong === 0, JSON.stringify(memberLamp));
check("so did the sender's", hostLamp.frames >= 1 && hostLamp.wrong === 0, JSON.stringify(hostLamp));

// First reading: correct.
await until(() => panelText(member), (text) => /Record reading/.test(text));
await shot(member, "03-receiver-reading");
await tap(member, '[data-episode="reading-add"][data-word="INJURED"]');
await until(() => panelText(member), (text) => /INJURED/.test(text));
await tap(member, '[data-episode="reading-add"][data-word="NORTH"]');
await member.waitForTimeout(300);
await tap(member, '[data-episode="read"]');
const compared = await until(() => panelText(host), (text) => /Message delivered/.test(text));
const comparedMember = await until(() => panelText(member), (text) => /Message delivered/.test(text), 60_000);
check("the comparison says the message was delivered — on both screens", /Message delivered/.test(compared) && /Message delivered/.test(comparedMember));
await shot(host, "04-sender-compare-delivered");
await shot(member, "04-receiver-compare-delivered");
// The first reading is final.
const second = await member.evaluate(() => window.__vmQa.episode().state.round.reading);
check("the receiver's first reading is recorded as given", JSON.stringify(second?.words) === '["INJURED","NORTH"]');
await member.evaluate(() => { document.querySelector("#episode-explanation").value = "Two long flashes, a long pause, then long-short-short."; });
await tap(member, '[data-episode="explain"]');
await until(() => episode(host), (state) => state.state?.round?.explanation?.length > 10);
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 1);
// (The panel re-renders on the next animation frame, which takes seconds under software rendering.)
const goal = await until(() => panelText(member), (text) => /Workshop goal met in round 1/.test(text), 60_000);
check("the explained, delivered round meets the workshop goal", /Workshop goal met in round 1/.test(goal));

// Round 2: deliberately ambiguous timing (a 500 ms flash).
await tap(host, '[data-episode="intent-remove"][data-index="1"]');
await until(() => episode(host), (state) => state.state?.intent.length === 1);
await tap(host, '[data-episode="intent-remove"][data-index="0"]');
await until(() => episode(host), (state) => state.state?.intent.length === 0);
await tap(host, '[data-episode="intent-add"][data-word="SAFE"]');
await until(() => episode(host), (state) => state.state?.intent.join() === "SAFE");
await host.evaluate(() => window.__vmQa.editDraft([
  { op: "write", pin: "D5", value: true }, { op: "wait", ms: 900 }, { op: "write", pin: "D5", value: false }, { op: "wait", ms: 300 },
  { op: "write", pin: "D5", value: true }, { op: "wait", ms: 500 }, { op: "write", pin: "D5", value: false },
]));
await tap(host, '[data-episode="transmit"]');
await until(() => episode(member), (state) => state.state?.round?.n === 2);
await waitEnded(member);
await until(() => panelText(member), (text) => /Record reading/.test(text));
await tap(member, '[data-episode="reading-add"][data-word="SAFE"]');
await member.waitForTimeout(300);
await tap(member, '[data-episode="read"]');
const ambiguous = await until(() => panelText(host), (text) => /ambiguous/.test(text));
check("a 500 ms flash makes the round ambiguous, even with the 'right' reading", /ambiguous under the protocol/.test(ambiguous) && !/Message delivered/.test(ambiguous.split("Rounds")[0]));
check("the diagnosis states the measured flash against the bands", /Flash 2 lasted 500 ms: between short/.test(ambiguous));
await shot(host, "05-ambiguous-diagnosis");
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 2);

// Round 3: an open circuit (the return wire off the base) — the code runs, no light.
const benchNow = await host.evaluate(() => window.__vmQa.bench());
const parts = Object.entries(benchNow.parts).map(([id, part]) => ({ id, sockets: id === "sno-w2a" ? null : part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
await importProject(host, { format: "virtual-makerspace.project", version: 1, solver: "x", studio: "snapino", savedAt: new Date().toISOString(), parts });
await until(() => member.evaluate(() => window.__vmQa.bench().parts["sno-w2a"]?.sockets), (sockets) => !sockets);
await host.evaluate(() => window.__vmQa.editDraft([{ op: "write", pin: "D5", value: true }, { op: "wait", ms: 900 }, { op: "write", pin: "D5", value: false }, { op: "wait", ms: 300 }, { op: "write", pin: "D5", value: true }, { op: "wait", ms: 300 }, { op: "write", pin: "D5", value: false }]));
await host.evaluate(() => window.__vmQa.lightLog());
await member.evaluate(() => window.__vmQa.lightLog());
await tap(host, '[data-episode="transmit"]');
const round3 = await until(() => episode(member), (state) => state.state?.round?.n === 3);
await waitEnded(member);
const openLamp = await member.evaluate(() => window.__vmQa.lightLog());
check("with the circuit open, the receiver's lamp never lit although the code ran", openLamp.length > 0 && openLamp.every((frame) => !frame.lights.includes("sno-l1")), `${openLamp.length} frames`);
await until(() => panelText(member), (text) => /Record reading/.test(text));
await tap(member, '[data-episode="reading-add"][data-word="SAFE"]');
await member.waitForTimeout(300);
await tap(member, '[data-episode="read"]');
const noLight = await until(() => panelText(host), (text) => /No light reached the receiver/.test(text));
check("an open circuit cannot deliver a message", /No light reached the receiver/.test(noLight) && /no end reaching GND|not on a D pin|No lamp/.test(noLight));
await shot(member, "06-open-circuit-no-light");
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 3);
check("(round 3 recorded the open transmitter)", round3.state.round.n === 3);

// Recovery: rebuild, retransmit the same intention → delivered.
await tap(host, "#load-field-test");
await until(() => member.evaluate(() => window.__vmQa.bench().parts["sno-w2a"]?.sockets), Boolean);
await tap(host, '[data-episode="write-blocks"]');
await host.waitForTimeout(300);
// The helper's SAFE blocks, then 110 s of silence (under the 120 s transmission cap): long enough
// for a dropped connection to come back inside the running transmission.
// (The helper's blocks may equal the room's program, in which case there is no separate draft.)
await host.evaluate(() => { const bench = window.__vmQa.bench(); window.__vmQa.editDraft([...(bench.draft ?? bench.program), ...Array.from({ length: 22 }, () => ({ op: "wait", ms: 5000 }))]); });
await tap(host, '[data-episode="transmit"]');
const started4 = await until(() => episode(member), (state) => state.state?.round?.n === 4);
check("(round 4 is a long transmission, under the 120 s cap)", started4.state?.round?.durationMs > 100_000 && started4.state.round.durationMs <= 120_000, String(started4.state?.round?.durationMs));

// Mid-transmission network drop: the room releases the receiver; the client reconnects by itself,
// gets the running round and the shared clock from the room, and must retake its role.
check("(the receiver's socket is dropped mid-transmission)", await member.evaluate(() => window.__vmQa.dropConnection()));
const released = await until(() => episode(host), (state) => state.state?.roles.receiver === null, 60_000);
check("the room released the dropped receiver's role", released.state?.roles.receiver === null);
const back = await until(() => episode(member), (state) => state.online && state.state?.roles.receiver === null, 120_000);
check("the dropped client reconnected by itself and holds the room's state (no role)", back.online && back.role === null && back.state?.round?.n === 4);
await tap(member, '[data-episode="claim-role"][data-role="receiver"]');
const rejoined = await until(() => episode(member), (state) => state.role === "receiver");
const hostNow = await episode(host);
check("after reconnecting, the receiver retook its role inside the running transmission", rejoined.role === "receiver" && rejoined.state?.round?.n === 4 && rejoined.elapsed < rejoined.state.round.durationMs && !rejoined.state.round.stopReason, `${Math.round(rejoined.elapsed)} of ${rejoined.state?.round?.durationMs} ms`);
check("its elapsed time agrees with the sender's (shared room clock)", Math.abs((rejoined.elapsed ?? 1e9) - (hostNow.elapsed ?? 0)) < 15_000, `${Math.round(rejoined.elapsed)} vs ${Math.round(hostNow.elapsed)} ms (sampled at different moments)`);
await member.evaluate(() => window.__vmQa.lightLog());
await member.waitForTimeout(8000);
{
  const round4 = (await episode(member)).state.round;
  const pulses4 = lightPulses({ program: round4.program, bench: round4.bench, durationMs: round4.durationMs, stoppedAtMs: null });
  const after = await lampAgreement(member, pulses4, round4.durationMs);
  tally(after);
  check("after reconnecting, every driven frame of the receiver's lamp agrees with the timeline", after.frames >= 1 && after.wrong === 0, JSON.stringify(after));
}

// A full reload (a new page) lands in the lobby of the same link; entering again restores the
// round from the room and, again, no role.
await member.reload();
await member.waitForSelector("#enter-room", { state: "attached" });
await tap(member, "#enter-room");
await member.waitForFunction(() => Boolean(window.__vmQa?.episode?.()?.state), null, { timeout: 300_000 }).catch(() => undefined);
const reloaded = await until(() => episode(member), (state) => Boolean(state.state));
check("after a reload the receiver gets round 4 from the room, and no role", reloaded.state?.round?.n === 4 && reloaded.role === null);
await tap(member, '[data-episode="claim-role"][data-role="receiver"]');
await until(() => episode(member), (state) => state.role === "receiver");
// The sender stops the long silence if it is still running; the message itself was complete.
if (!(await episode(host)).state.round.stopReason && (await episode(host)).elapsed < (await episode(host)).state.round.durationMs) await tap(host, '[data-episode="stop"]');
await waitEnded(member);
await until(() => panelText(member), (text) => /Record reading/.test(text));
await tap(member, '[data-episode="reading-add"][data-word="SAFE"]');
await member.waitForTimeout(300);
await tap(member, '[data-episode="read"]');
const recovered = await until(() => panelText(host), (text) => /Round 4 · Message delivered/.test(text));
check("after rebuilding, the same message is delivered (recovery)", /Round 4 · Message delivered/.test(recovered));
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 4);

// A teammate's bench change during a transmission ends it for both.
await host.evaluate((program) => window.__vmQa.editDraft(program), LONG_SAFE);
await host.evaluate(() => window.__vmQa.lightLog());
await member.evaluate(() => window.__vmQa.lightLog());
await tap(host, '[data-episode="transmit"]');
await until(() => episode(member), (state) => state.state?.round?.n === 5);
const memberBench = await member.evaluate(() => window.__vmQa.bench());
const moved = Object.entries(memberBench.parts).map(([id, part]) => ({ id, sockets: id === "sno-w3" ? [30, 31] : part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
await importProject(member, { format: "virtual-makerspace.project", version: 1, solver: "x", studio: "snapino", savedAt: new Date().toISOString(), parts: moved });
const cut = await until(() => episode(host), (state) => state.state?.round?.stopReason);
check("a teammate's bench edit ends the running transmission for everyone", cut.state.round.stopReason === "bench-changed" && (await episode(member)).state.round.stopReason === "bench-changed");
await shot(host, "07-cut-off-by-bench-change");
{
  const round5 = cut.state.round;
  const pulses5 = lightPulses({ program: round5.program, bench: round5.bench, durationMs: round5.durationMs, stoppedAtMs: round5.stoppedAtMs });
  const end5 = round5.stoppedAtMs ?? round5.durationMs;
  const lamp5 = [await lampAgreement(member, pulses5, end5), await lampAgreement(host, pulses5, end5)];
  lamp5.forEach(tally);
  check("frames driven before the cut-off agree with that round's timeline too", lamp5.every((agreement) => agreement.wrong === 0), JSON.stringify(lamp5));
  check("across the run the lamp was seen lit and dark exactly when the timeline said", lampFrames.lit > 0 && lampFrames.dark > 0 && lampFrames.frames >= 4, JSON.stringify(lampFrames));
}
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null);
await tap(host, "#load-field-test");
await until(() => member.evaluate(() => window.__vmQa.bench().parts["sno-w3"]?.sockets?.[1]), (socket) => socket === 33);

// Importing the identical program (same parts) while it transmits stops it.
await host.evaluate((program) => window.__vmQa.editDraft(program), LONG_SAFE);
await tap(host, '[data-episode="transmit"]');
await until(() => episode(member), (state) => state.state?.round?.n === 6);
const same = await host.evaluate(() => ({ bench: window.__vmQa.bench(), program: window.__vmQa.bench().program }));
const sameParts = Object.entries(same.bench.parts).map(([id, part]) => ({ id, sockets: part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
await importProject(host, { format: "virtual-makerspace.project", version: 1, solver: "x", studio: "snapino", savedAt: new Date().toISOString(), parts: sameParts, program: same.program });
const stopped = await until(() => episode(member), (state) => state.state?.round?.stopReason);
check("importing the identical program while transmitting stops it (program-changed)", stopped.state.round.stopReason === "program-changed");
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null);

// The sender's Stop ends the transmission for everyone, and the receiver's lamp goes dark.
await host.evaluate((program) => window.__vmQa.editDraft(program), LONG_SAFE);
await tap(host, '[data-episode="transmit"]');
await until(() => episode(member), (state) => state.state?.round?.n === 7);
await tap(host, '[data-episode="stop"]');
const halted = await until(() => episode(member), (state) => state.state?.round?.stopReason);
check("the sender's Stop ends the transmission on both screens", halted.state.round.stopReason === "stopped" && (await episode(host)).state.round.stopReason === "stopped");
const dark = await until(() => member.evaluate(() => window.__vmQa.lights()), (lights) => !lights.includes("sno-l1"), 60_000);
check("after Stop the receiver's bench lamp is dark", !dark.includes("sno-l1"));
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null);

// Role swap between rounds.
await tap(member, '[data-episode="swap-roles"]');
const swapped = await until(() => episode(host), (state) => state.role === "receiver");
check("roles swap between rounds, on both screens", swapped.role === "receiver" && (await episode(member)).role === "sender");

// Export carries the design (never rounds, readings or explanations).
const [download] = await Promise.all([member.waitForEvent("download"), tap(member, "#export-project")]);
const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
check("export carries the episode design and no session activity", exported.episode?.id === "rescue-signal" && Array.isArray(exported.episode.intent) && !JSON.stringify(exported).includes("Two long flashes") && !("history" in exported.episode));

// Leaving mid-transmission: no errors, no running loop left behind.
await member.evaluate((program) => window.__vmQa.editDraft(program), LONG_SAFE);
await tap(member, '[data-episode="transmit"]');
const leaving = await until(() => episode(host), (state) => state.state?.round?.n === 8);
check("(the new sender's transmission is running when the receiver leaves)", leaving.state?.round?.n === 8 && leaving.elapsed < leaving.state.round.durationMs);
const exitButton = await host.evaluate(() => { const button = [...document.querySelectorAll("button")].find((b) => /leave|exit/i.test(b.getAttribute("aria-label") ?? "")); button?.click(); return button?.getAttribute("aria-label") ?? null; });
await host.waitForSelector("#enter-room", { state: "attached", timeout: 120_000 });
await host.waitForTimeout(2500);
check("leaving during a transmission returns to the lobby without errors", exitButton && host.errors.length === 0 && !(await host.evaluate(() => document.querySelector("#episode-panel"))), `${exitButton} · ${host.errors.join(" | ")}`);
const afterLeave = await until(() => episode(member), (state) => state.state?.roles.receiver === null, 60_000);
check("the leaver's receiver role is freed; the sender keeps theirs", afterLeave.state.roles.receiver === null && afterLeave.role === "sender");
check("no page errors on the page that stayed", member.errors.length === 0, member.errors.join(" | "));

// A late joiner on a phone-width viewport (after the receiver left; fewer software-rendered pages).
await hostContext.close();
const phoneContext = await maker("phone@example.test", { width: 390, height: 844 });
const phone = await open(phoneContext, "phone");
await shot(phone, "08-phone-panel");
const late = await episode(phone);
check("a late joiner gets the room's rounds, the running round and the roles", late.state?.history.length === 7 && late.state.round?.n === 8 && late.state.roles.sender && late.role === null, JSON.stringify({ history: late.state?.history.length, round: late.state?.round?.n, sender: late.state?.roles.sender?.name }));
check("the panel renders on a phone-width viewport", await phone.evaluate(() => { const panel = document.querySelector("#episode-panel").getBoundingClientRect(); return panel.width <= 390 && panel.left >= 0; }));
await phoneContext.close();

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · room ${room}`);
assert.equal(failed.length, 0);
