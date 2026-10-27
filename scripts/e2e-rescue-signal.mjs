// Episode 1 · Rescue Signal Workshop — two real browsers over the real Worker (Durable Object +
// WebSocket), clicking the actual panel. Developer-environment run (headless Chromium with
// SwiftShader), not a CI workflow. A fresh random room every run (never 7K3M).
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799
//   node --experimental-strip-types scripts/e2e-rescue-signal.mjs [http://vm.test:8800] [artifacts-dir]
//
// What counts as evidence here, and what does not:
// - "Driven frames": the panel sets the bench pins in the scene's pre-render hook and the ?qa probe
//   logs, for that very frame, the elapsed time and the loads the scene shows running. Each client
//   must log lit AND dark frames that agree with the round's timeline. This is the scene state at
//   render time, not pixels.
// - "Pixels": separately, screenshots cropped to the receiver's lamp, taken while its probe says lit
//   (and still lit afterwards) versus dark, must differ in brightness.
// - Software rendering takes seconds per frame and minutes per new shader; nothing here is a frame
//   rate or a real-device timing claim. Clock agreement is measured as the difference between two
//   pages' estimates of the room clock on the same machine.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dumpDiagnostics, instrument, settled } from "./lib/e2e-readiness.mjs";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `R${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const artifacts = process.argv[3] ?? `${tmpdir()}/vm-e2e-rescue-${room}`;
mkdirSync(artifacts, { recursive: true });
const launchOptions = {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8799", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
};
// Every maker runs in a browser process of its own (its own GPU process), as on separate machines.
// In one shared browser SwiftShader serves the pages unevenly: measured on this machine, two pages
// drew a frame every 6 s and every 26 s; a third page got no room state within 300 s (two runs).
// Each in its own process: about one frame per 10 s each (scripts/qa-render-cost.mjs).
const browsers = [];
const launch = async () => { const own = await chromium.launch(launchOptions); browsers.push(own); return own; };
const browser = await launch();
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const ready = (page, label) => settled(page, label, { diagnostics: artifacts });
/**
 * While one page's frames are sampled, pages whose frames are not under test stop drawing (?qa hook;
 * their room traffic, clocks and timers keep running and they log no frames), so the sampled page
 * gets the CPU. Used only where a single page is checked; both pages draw wherever both are checked.
 */
const drawing = (pages, enabled) => Promise.all(pages.map((page) => page.evaluate((on) => window.__vmQa.drawing(on), enabled)));
/** The workshop and inspector are dock tabs: bring an element's tab (and the dock) to the front, as a person would. */
async function showTabOf(page, selector) {
  await page.evaluate((s) => {
    const element = document.querySelector(s);
    const panel = element?.closest(".discussion-panel");
    if (!panel || panel.classList.contains("is-active")) return;
    if (document.querySelector(".workspace-shell.is-dock-collapsed")) document.querySelector("#dock-reopen")?.click();
    document.querySelector(`.discussion-tab[data-tab="${panel.dataset.panel}"]`)?.click();
  }, selector);
}
/** Click a button like a person: it must exist and be enabled; otherwise fail now, with diagnostics. */
async function tap(page, selector) {
  try {
    await page.waitForFunction((s) => { const element = document.querySelector(s); return Boolean(element) && !element.disabled; }, selector, { timeout: 120_000, polling: 250 });
  } catch (error) {
    await dumpDiagnostics(page, artifacts, `tap-${selector}`);
    throw new Error(`${page.e2eLabel}: ${selector} not present/enabled within 120 s (${error.message.split("\n")[0]})`);
  }
  await showTabOf(page, selector);
  const clicked = await page.evaluate((s) => { const element = document.querySelector(s); if (!element || element.disabled || element.getClientRects().length === 0) return false; element.click(); return true; }, selector);
  if (!clicked) throw new Error(`${page.e2eLabel}: ${selector} became unavailable (or not visible) before the click`);
}
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
// INJURED · NORTH at the slow end of every band (14.8 s of flashes; still exactly that message under the protocol),
const SLOW_INJURED_NORTH = [...flash(1450, 550), ...flash(1450, 4000), { op: "wait", ms: 4000 }, ...flash(1450, 550), ...flash(420, 550), ...flash(420, 0),
  // ...then 30 s dark: the message is unchanged (checked below), and a page that draws a frame every
  // ~11 s here has frames of this transmission to check (the final run's receiver had none in 15 s).
  ...Array.from({ length: 6 }, () => ({ op: "wait", ms: 5000 }))];
// SAFE followed by 60 s of silence: still running when a teammate acts on it.
const LONG_SAFE = [...flash(900, 300), ...flash(300, 0), ...Array.from({ length: 12 }, () => ({ op: "wait", ms: 5000 }))];
// A recurring light (not a protocol word) with irregular on/off lengths. Long phases let
// seconds-per-frame clients log both states. Irregular, because a software renderer can take a
// steady ~9 s per frame, and sampling a strictly periodic 9 s light (4 s on, 5 s off, as these rounds
// used before) can land on the same phase every time: aliasing. Two runs saw it, once after the
// reconnect (7 fresh frames, all lit) and once in round 5 (5 frames, all lit).
// Irregular phases cannot lock to a frame period, so the frames must see both states.
// (Each wait block is at most 5 s, so every phase is 2.5–5 s; 107.5 s in all, under the 120 s cap,
// long enough for a late joiner that needs minutes to render its first frames.)
const ON = [5, 3.5, 5, 4, 2.5, 3, 4.5, 5, 5, 3.5, 5, 4.5];
const OFF = [5, 5, 4.5, 5, 4, 5, 5, 4.5, 5, 5, 4, 5];
const IRREGULAR = ON.flatMap((on, index) => flash(on * 1000, OFF[index] * 1000));
const IRREGULAR_MS = (ON.reduce((a, b) => a + b, 0) + OFF.reduce((a, b) => a + b, 0)) * 1000;
// One steady 60 s light, then 55 s dark (115 s): a headless screenshot takes ~40 s under SwiftShader,
// so a pixel sample needs a phase that outlasts the capture.
const STEADY = [D5(true), ...Array.from({ length: 12 }, () => ({ op: "wait", ms: 5000 })), D5(false), ...Array.from({ length: 11 }, () => ({ op: "wait", ms: 5000 }))];
const shot = async (page, name) => { await page.screenshot({ path: `${artifacts}/${name}.png` }); };
const panelText = async (page) => { await showTabOf(page, "#episode-body"); return page.evaluate(() => document.querySelector("#episode-body")?.innerText.replace(/\s+/g, " ") ?? ""); };
const header = (page) => page.evaluate(() => ({ pill: document.querySelector("#episode-pill")?.textContent ?? null, step: document.querySelector('.episode-steps [aria-current="step"]')?.textContent ?? null }));
const episode = (page) => page.evaluate(() => window.__vmQa?.episode?.() ?? { state: null, role: null, elapsed: null });
const { lightPulses, decode } = await import("../src/episodes/rescue-signal.ts");
const pulsesOf = (round, stopped = round.stoppedAtMs) => lightPulses({ program: round.program, bench: round.bench, durationMs: round.durationMs, stoppedAtMs: stopped });
const litIn = (pulses, ms) => pulses.some((pulse) => ms >= pulse.start && ms < pulse.end);

// 800×544: a smaller canvas than the 1000×680 used before. On this machine's current speed two
// SwiftShader pages drew one frame per ~16 s each at 1000×680 (533 draw calls) and the short rounds
// (an 18 s message) could pass with no frame at all; at 800×544 (303 calls) a probe measured about
// twice the frames. The checks themselves are unchanged.
async function maker(email, viewport = { width: 800, height: 544 }) {
  const context = await (await launch()).newContext({ viewport, acceptDownloads: true });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await instrument(context);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  return context;
}
async function lobby(context, label, host = false) {
  const page = await context.newPage();
  page.e2eLabel = label;
  page.setDefaultTimeout(300_000);
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(`[${label}] pageerror:`, error.message); });
  page.on("crash", () => { errors.push("crash"); console.error(`[${label}] page crashed`); });
  page.errors = errors;
  await page.goto(`${base}/?room=${room}&quality=low&qa`);
  await page.waitForSelector("#enter-room", { state: "attached" });
  if (host) {
    await page.getByRole("radio", { name: /Snapino Bridge/ }).click();
    await page.evaluate(() => { const box = document.querySelector("#lobby-episode"); if (box && !box.checked) box.click(); });
  }
  return page;
}
async function enter(page) {
  await tap(page, "#enter-room");
  await page.waitForFunction(() => Boolean(window.__vmQa?.episode), null, { timeout: 300_000, polling: 500 });
  // The panel must exist AND be shown (an absent panel is not "not hidden").
  await page.waitForFunction(() => { const panel = document.querySelector("#episode-panel"); return Boolean(panel) && !panel.hidden && panel.getClientRects().length > 0; }, null, { timeout: 300_000, polling: 500 });
  await ready(page, `${page.e2eLabel} entered`);
  return page;
}
/**
 * Frames the transmission drove since the last call (the probe log is drained). Only frames of
 * THIS transmission (its tx) count, and with `since` (the page's own Date.now()) only frames
 * rendered after that moment: an earlier round of the same program, or frames from before a
 * reconnect, can never satisfy a later check.
 */
async function drivenFrames(page, round, since = null) {
  return summarize(await page.evaluate(() => window.__vmQa.lightLog()), round, since);
}
/** Drains a page's probe log into `into` (reading the log empties it), for a later summary. */
async function drain(page, into) {
  into.push(...await page.evaluate(() => window.__vmQa.lightLog()));
  return into;
}
function summarize(log, round, since = null) {
  const pulses = pulsesOf(round, null);
  const end = round.stoppedAtMs ?? round.durationMs;
  const frames = log.filter((frame) => frame.tx === round.tx && (since === null || frame.at > since) && frame.elapsed >= 0 && frame.elapsed < end);
  const lit = frames.filter((frame) => frame.lights.includes("sno-l1"));
  const wrong = frames.filter((frame) => frame.lights.includes("sno-l1") !== litIn(pulses, frame.elapsed));
  return { frames: frames.length, lit: lit.length, dark: frames.length - lit.length, wrong: wrong.length, wrongAt: wrong.slice(0, 3).map((frame) => Math.round(frame.elapsed)) };
}
/** Collects driven frames until the page has logged at least one lit and one dark agreeing frame. */
async function observeLitAndDark(page, label, timeoutMs, since = null) {
  const total = { frames: 0, lit: 0, dark: 0, wrong: 0, wrongAt: [], tx: null, since };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { state } = await episode(page);
    if (!state?.round) break;
    const part = await drivenFrames(page, state.round, since);
    total.tx = state.round.tx;
    for (const key of ["frames", "lit", "dark", "wrong"]) total[key] += part[key];
    total.wrongAt.push(...part.wrongAt);
    if (total.lit > 0 && total.dark > 0) break;
    if (state.round.stopReason) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(`  [frames] ${label}: ${JSON.stringify(total)}`);
  return total;
}
/** Mean brightness (0–255) of a page area, measured in a separate lightweight page. */
const analysis = await (await browser.newContext()).newPage();
async function brightness(png) {
  return analysis.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let sum = 0;
    for (let index = 0; index < pixels.length; index += 4) sum += 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    return sum / (pixels.length / 4);
  }, png.toString("base64"));
}
/**
 * A screenshot of the receiver's lamp taken while the probe says it is lit (or dark) before AND after
 * the capture, inside one phase of the timeline. Returns its brightness, or null if no clean sample.
 */
async function lampSample(page, wantLit, deadline) {
  const tries = { screenshots: 0, phaseChanged: 0 };
  while (Date.now() < deadline) {
    const before = await episode(page);
    const round = before.state?.round;
    if (!round || before.elapsed >= round.durationMs || round.stopReason) return { failed: "the light ended", ...tries };
    const lights = await page.evaluate(() => window.__vmQa.lights());
    if (lights.includes("sno-l1") !== wantLit) { await new Promise((resolve) => setTimeout(resolve, 300)); continue; }
    const rect = await page.evaluate(() => window.__vmQa.partScreenRect("sno-l1"));
    if (!rect || rect.width < 4 || rect.height < 4) return { failed: "no lamp on screen", rect, ...tries };
    const clip = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(rect.width, 400), height: Math.min(rect.height, 400) };
    const png = await page.screenshot({ clip });
    tries.screenshots += 1;
    const after = await episode(page);
    const lightsAfter = await page.evaluate(() => window.__vmQa.lights());
    const pulses = pulsesOf(round, null);
    const samePhase = lightsAfter.includes("sno-l1") === wantLit && litIn(pulses, before.elapsed) === wantLit && litIn(pulses, after.elapsed) === wantLit
      && pulses.every((pulse) => !(before.elapsed < pulse.start && pulse.start < after.elapsed) && !(before.elapsed < pulse.end && pulse.end < after.elapsed));
    if (!samePhase) { tries.phaseChanged += 1; continue; }
    writeFileSync(`${artifacts}/pixel-${wantLit ? "lit" : "dark"}.png`, png);
    return { brightness: await brightness(png), clip, elapsed: [Math.round(before.elapsed), Math.round(after.elapsed)] };
  }
  return { failed: "deadline", ...tries };
}
/**
 * Clean-up between rounds: Stop the light if it still runs. The light can end on its own between the
 * check and the click; only a round verified as ended right after a failed click excuses it.
 */
async function stopIfStillRunning(page) {
  const ended = (now) => !now.state?.round || Boolean(now.state.round.stopReason) || now.elapsed >= now.state.round.durationMs;
  if (ended(await episode(page))) return;
  try {
    await tap(page, '[data-episode="stop"]');
  } catch (error) {
    if (!ended(await episode(page))) throw error;
  }
}
async function waitEnded(page) {
  return until(() => episode(page), (state) => state.state?.round && (state.state.round.stopReason || state.elapsed >= state.state.round.durationMs + 200));
}
async function importProject(page, project) {
  await page.setInputFiles("#project-file-input", { name: "project.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project)) });
  await page.waitForFunction(() => document.querySelector("#confirm-dialog")?.open, null, { timeout: 120_000, polling: 250 });
  await tap(page, "#confirm-ok");
}
async function readAs(page, words) {
  await until(() => panelText(page), (text) => /Record reading/.test(text));
  for (const word of words) await tap(page, `[data-episode="reading-add"][data-word="${word}"]`);
  await tap(page, '[data-episode="read"]');
}
const notDelivered = async (page, label) => {
  const now = await until(() => header(page), (value) => value.pill !== null, 30_000);
  check(`${label}: the header does not claim delivery`, now.pill !== "Delivered", JSON.stringify(now));
  return now;
};

const hostContext = await maker("host@example.test");
const memberContext = await maker("member@example.test");
const host = await enter(await lobby(hostContext, "host", true));
const member = await enter(await lobby(memberContext, "member"));
check("the workshop panel opens for both makers (room state, not a local overlay)", (await episode(host)).state?.active && (await episode(member)).state?.active);

// ── Roles, design, build ──────────────────────────────────────────────────────────────────────
await tap(host, '[data-episode="claim-role"][data-role="sender"]');
await until(() => episode(member), (state) => state.state?.roles.sender);
await tap(member, '[data-episode="claim-role"][data-role="receiver"]');
const roles = await until(() => episode(host), (state) => state.state?.roles.receiver);
// Each client reports its own role from the room state it has applied; a slow page may apply the
// claim later than the host sees it, so wait (bounded) for the member's own view too.
const memberRoles = await until(() => episode(member), (state) => state.role === "receiver", 60_000);
check("sender and receiver are taken by different makers", roles.role === "sender" && memberRoles.role === "receiver", JSON.stringify({ host: roles.role, member: memberRoles.role }));
await tap(host, "#load-field-test");
await until(() => host.evaluate(() => window.__vmQa.bench().parts["sno-l1"]?.sockets), Boolean);
await ready(host, "host after the lamp was placed");
await ready(member, "member after the lamp was placed");
// Shader warm-up (developer machine): SwiftShader links a new program the first time the lamp is drawn
// lit, and that froze the receiver's page for 120 s inside the 18 s first round (attempt 5: the round
// had ended before its "Receiver's view" button could be pressed). Each page lights its own lamp once
// locally (display only, no room traffic), settles, and turns it off again before any transmission.
// The receiver frames the lamp while waiting, as the panel tells them to (before the warm-up, so the
// warm-up draws the view the receiver will watch).
await tap(member, '[data-episode="receiver-view"]');
for (const page of [host, member]) {
  await page.evaluate(() => window.__vmQa.pins({ D5: true }));
  await ready(page, `${page.e2eLabel} lamp warm-up (lit)`);
  await page.evaluate(() => window.__vmQa.pins({ D5: false }));
  await ready(page, `${page.e2eLabel} lamp warm-up (dark)`);
}
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
// (The shared vocabulary lists every word with its flashes; the INTENT is the sender's choice.)
check("the receiver's panel does not show the intended message", !/Intended message|INJURED ▬ ▬ NORTH|INJURED · NORTH/.test(receiverBefore) && !(await member.evaluate(() => document.querySelector('#episode-body [aria-label="Intended words"]'))), receiverBefore.slice(0, 100));

// The receiver's framing, captured before the round: a SwiftShader screenshot takes tens of seconds and
// holds the GPU process both pages share, so one taken inside the 18 s round left the sender with no
// frame at all in attempts 4 and 6.
await shot(member, "02-receiver-view");
// Both pages settle after the design steps (the sender's editor was just rewritten) before the
// short first round, whose 18 s must be drawn by both.
await ready(host, "host before round 1");
await ready(member, "member before round 1");
// ── Round 1: a working message, read correctly ───────────────────────────────────────────────
await host.evaluate(() => window.__vmQa.lightLog());
await member.evaluate(() => window.__vmQa.lightLog());
await tap(host, '[data-episode="transmit"]');
const running1 = await until(() => episode(member), (state) => state.state?.round?.n === 1);
check("the transmission reaches the receiver as room state", running1.state?.round?.intent.join() === "INJURED,NORTH");
await waitEnded(member);
const round1 = (await episode(member)).state.round;
check("the round's light under the protocol is INJURED · NORTH", decode(pulsesOf(round1)).words.join() === "INJURED,NORTH");
for (const [page, label] of [[member, "receiver"], [host, "sender"]]) {
  const frames = await drivenFrames(page, round1);
  if (frames.frames === 0) await dumpDiagnostics(page, artifacts, `round-1-${label}-no-frames`);
  check(`round 1: every driven frame of the ${label}'s lamp agrees with the timeline (and there were some)`, frames.frames >= 1 && frames.wrong === 0, JSON.stringify(frames));
}
check("unread round: the header shows the reading step", (await until(() => header(member), (value) => value.pill === "Reading", 60_000)).pill === "Reading");
await shot(member, "03-receiver-reading");
await readAs(member, ["INJURED", "NORTH"]);
const compared = await until(() => panelText(host), (text) => /Message delivered/.test(text));
const comparedMember = await until(() => panelText(member), (text) => /Message delivered/.test(text), 60_000);
check("the comparison says the message was delivered — on both screens", /Message delivered/.test(compared) && /Message delivered/.test(comparedMember));
await shot(host, "04-sender-compare-delivered");
await shot(member, "04-receiver-compare-delivered");
// The first reading is final: a second attempt (as a raw room action) is refused, and the UI offers none.
const firstTx = (await episode(member)).state.round.tx;
const secondTry = await member.evaluate((tx) => window.__vmQa.episodeAction({ type: "read", tx, words: ["HELP"], confidence: "sure" }), firstTx);
const afterSecond = await episode(host);
check("a second reading is refused by the room and the first stays", secondTry?.ok === false && secondTry.reason === "already-read" && JSON.stringify(afterSecond.state.round.reading.words) === '["INJURED","NORTH"]', JSON.stringify(secondTry));
check("and the receiver's panel offers no second 'Record reading'", !(await member.evaluate(() => document.querySelector('[data-episode="read"]'))));
await member.evaluate(() => { document.querySelector("#episode-explanation").value = "Two long flashes, a long pause, then long-short-short."; });
await tap(member, '[data-episode="explain"]');
await until(() => episode(host), (state) => state.state?.round?.explanation?.length > 10);
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 1);
const goal = await until(() => panelText(member), (text) => /Workshop goal met in round 1/.test(text), 60_000);
check("the explained, delivered round meets the workshop goal (history milestone)", /Workshop goal met in round 1/.test(goal));
await notDelivered(member, "after closing the delivered round (next round's design)");

// ── Round 2: ambiguous timing (a 500 ms flash) ───────────────────────────────────────────────
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
await notDelivered(member, "round 2 ended, unread");
await shot(member, "08-unread-after-success");
await readAs(member, ["SAFE"]);
const ambiguous = await until(() => panelText(host), (text) => /ambiguous/.test(text));
check("a 500 ms flash makes the round ambiguous, even with the 'right' reading", /ambiguous under the protocol/.test(ambiguous) && !/Message delivered/.test(ambiguous.split("Rounds")[0]));
check("the diagnosis states the measured flash against the bands", /Flash 2 lasted 500 ms: between short/.test(ambiguous));
await notDelivered(host, "ambiguous round 2");
await shot(host, "05-ambiguous-diagnosis");
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 2);

// ── Round 3: an open circuit (the return wire off the base) ──────────────────────────────────
const benchNow = await host.evaluate(() => window.__vmQa.bench());
const parts = Object.entries(benchNow.parts).map(([id, part]) => ({ id, sockets: id === "sno-w2a" ? null : part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
await importProject(host, { format: "virtual-makerspace.project", version: 1, solver: "x", studio: "snapino", savedAt: new Date().toISOString(), parts });
await until(() => member.evaluate(() => window.__vmQa.bench().parts["sno-w2a"]?.sockets), (sockets) => !sockets);
await ready(member, "member after the return wire was removed");
// 30 s with D5 HIGH: long enough for software-rendered frames (up to ~15 s each here) to be driven
// while it runs (a 10 s run left the receiver with no frame in attempt 6).
await host.evaluate(() => window.__vmQa.editDraft([{ op: "write", pin: "D5", value: true }, ...Array.from({ length: 6 }, () => ({ op: "wait", ms: 5000 })), { op: "write", pin: "D5", value: false }]));
await host.evaluate(() => window.__vmQa.lightLog());
await member.evaluate(() => window.__vmQa.lightLog());
await drawing([host], false); // only the receiver's frames are checked in this round
await tap(host, '[data-episode="transmit"]');
await until(() => episode(member), (state) => state.state?.round?.n === 3);
await waitEnded(member);
await drawing([host], true);
const openLamp = await member.evaluate(() => window.__vmQa.lightLog());
check("with the circuit open, the receiver's lamp never lit although the code ran", openLamp.length > 0 && openLamp.every((frame) => !frame.lights.includes("sno-l1")), `${openLamp.length} frames`);
await readAs(member, ["SAFE"]);
const noLight = await until(() => panelText(host), (text) => /No light reached the receiver/.test(text));
check("an open circuit cannot deliver a message", /No light reached the receiver/.test(noLight) && /no end reaching GND/.test(noLight));
await notDelivered(member, "open-circuit round 3");
await shot(member, "06-open-circuit-no-light");
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 3);

// ── Round 4: recovery, with a retransmission that replaces the watched signal ────────────────
await tap(host, "#load-field-test");
await until(() => member.evaluate(() => window.__vmQa.bench().parts["sno-w2a"]?.sockets), Boolean);
await tap(host, '[data-episode="write-blocks"]');
await tap(host, '[data-episode="transmit"]');
await until(() => episode(member), (state) => state.state?.round?.n === 4);
await waitEnded(member);
await until(() => panelText(member), (text) => /Record reading/.test(text));
await tap(member, '[data-episode="reading-add"][data-word="SAFE"]');
const drafted = await until(() => member.evaluate(() => [...document.querySelectorAll('[aria-label="Your reading"] .episode-chip')].map((chip) => chip.textContent.trim())), (chips) => chips.length === 1, 60_000);
const oldTx = (await episode(member)).state.round.tx;
check("(the receiver has drafted a reading of the first transmission)", drafted.length === 1 && /SAFE/.test(drafted[0]), JSON.stringify(drafted));
await tap(host, '[data-episode="transmit"]'); // "Transmit again" (same round, new transmission)
const retransmitted = await until(() => episode(member), (state) => state.state?.round?.tx !== oldTx);
check("a retransmission keeps round 4 but is a new transmission (new tx) on the receiver too", retransmitted.state.round.n === 4 && retransmitted.state.round.tx > oldTx && retransmitted.state.round.transmissions === 2);
const draftAfter = await until(() => member.evaluate(() => document.querySelectorAll('[aria-label="Your reading"] .episode-chip').length), (count) => count === 0, 60_000);
check("the receiver's draft of the replaced transmission is discarded", draftAfter === 0);
await waitEnded(member);
const stale = await member.evaluate((tx) => window.__vmQa.episodeAction({ type: "read", tx, words: ["SAFE"], confidence: "sure" }), oldTx);
check("a delayed reading of the replaced transmission is refused by the room", stale?.ok === false && stale.reason === "stale-round" && (await episode(host)).state.round.reading === null, JSON.stringify(stale));
await readAs(member, ["SAFE"]);
const recovered = await until(() => panelText(host), (text) => /Round 4 · Message delivered/.test(text));
check("after rebuilding, the same message is delivered (recovery)", /Round 4 · Message delivered/.test(recovered));
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 4);

// ── Round 5: a recurring light. Per-client lit/dark frames, then the sender's Stop ────
await host.evaluate((program) => window.__vmQa.editDraft(program), IRREGULAR);
await host.evaluate(() => window.__vmQa.lightLog());
await member.evaluate(() => window.__vmQa.lightLog());
await tap(host, '[data-episode="transmit"]');
const beacon = await until(() => episode(member), (state) => state.state?.round?.n === 5);
check("(round 5 is a 107.5 s recurring light with irregular phases)", beacon.state.round.durationMs === IRREGULAR_MS, `${beacon.state.round.durationMs} ms`);
const deadline5 = Date.now() + 75_000; // leaves time to press Stop while it still runs
const receiverFrames = await observeLitAndDark(member, "receiver, round 5", 45_000);
const senderFrames = await observeLitAndDark(host, "sender, round 5", Math.max(5_000, deadline5 - Date.now()));
check("the receiver's own render-driven frames include lit AND dark, all agreeing with the timeline", receiverFrames.lit > 0 && receiverFrames.dark > 0 && receiverFrames.wrong === 0, JSON.stringify(receiverFrames));
check("the sender's too", senderFrames.lit > 0 && senderFrames.dark > 0 && senderFrames.wrong === 0, JSON.stringify(senderFrames));
await notDelivered(member, "running round 5");
// The sender's Stop ends it for everyone; the receiver's lamp goes dark.
await tap(host, '[data-episode="stop"]');
const halted = await until(() => episode(member), (state) => state.state?.round?.stopReason);
check("the sender's Stop ends the transmission on both screens", halted.state.round.stopReason === "stopped" && (await episode(host)).state.round.stopReason === "stopped", halted.state.round.stopReason);
const dark = await until(() => member.evaluate(() => window.__vmQa.lights()), (lights) => !lights.includes("sno-l1"), 60_000);
check("after Stop the receiver's bench lamp is dark", !dark.includes("sno-l1"));
await notDelivered(member, "stopped, unread round 5");
await tap(host, '[data-episode="close-round"]'); // abandon the unread beacon round
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 5);

// ── Round 6: a recurring light (irregular phases); a network drop and reconnect while it runs ──
await host.evaluate((program) => window.__vmQa.editDraft(program), IRREGULAR);
await tap(host, '[data-episode="transmit"]');
const beacon6 = await until(() => episode(member), (state) => state.state?.round?.n === 6);
check("(round 6 runs a recurring light with irregular phases)", beacon6.state.round.durationMs === IRREGULAR_MS && !beacon6.state.round.stopReason, `${beacon6.state.round.durationMs} ms`);
// Network drop mid-transmission: the room frees the role; the client reconnects on its own.
await drawing([host], false); // only the receiver's frames are checked until its fresh frames are in
check("(the receiver's socket is dropped mid-transmission)", await member.evaluate(() => window.__vmQa.dropConnection()));
const released = await until(() => episode(host), (state) => state.state?.roles.receiver === null, 60_000);
check("the room released the dropped receiver's role", released.state?.roles.receiver === null);
const back = await until(() => episode(member), (state) => state.online && state.state?.roles.receiver === null && state.state?.round?.n === 6, 120_000);
check("the dropped client reconnected by itself and holds the room's state (no role)", back.online && back.role === null && back.state?.round?.n === 6);
check("after reconnecting, the receiver is back in the running transmission", back.state?.round?.n === 6 && !back.state.round.stopReason && back.elapsed < back.state.round.durationMs, `${Math.round(back.elapsed)} of ${back.state?.round?.durationMs} ms`);
// Fresh frames only, at once (the light is what runs out): drain the log now, and count only frames
// of round 6's transmission rendered after this moment (the page's own clock), i.e. after the
// confirmed reconnect. The role is retaken and the clock compared afterwards.
await member.evaluate(() => window.__vmQa.lightLog());
const reconnectBoundary = await member.evaluate(() => Date.now());
const backNow = await episode(member);
const afterReconnect = await observeLitAndDark(member, "receiver after reconnect", Math.max(5_000, (backNow.state.round.durationMs - backNow.elapsed) - 4_000), reconnectBoundary);
check("after reconnecting, the receiver's FRESH driven frames (round 6's tx, rendered after the reconnect) include lit AND dark, all agreeing", afterReconnect.tx === back.state.round.tx && afterReconnect.lit > 0 && afterReconnect.dark > 0 && afterReconnect.wrong === 0, JSON.stringify(afterReconnect));
await drawing([host], true);
await tap(member, '[data-episode="claim-role"][data-role="receiver"]');
await until(() => episode(member), (state) => state.role === "receiver");
// Clock samples are taken with both pages not drawing: on this machine a frame blocks a page's main
// thread for seconds, so every pong waits behind one (attempt 8: best round trip 7446 ms in 120 s).
// A real device draws in milliseconds; the client keeps sampling until a round trip is short.
await drawing([host, member], false);
// The 250 ms bound is only meaningful for estimates whose own error (rtt / 2) is below it: wait for
// samples with round trips of at most 400 ms (attempt 9 compared a 756 ms sample: 377 ms apart).
const rejoined = await until(() => episode(member), (state) => state.clockRtt !== null && state.clockRtt <= 400, 180_000);
const hostClock = await episode(host);
const skew = Math.abs(rejoined.clockOffset - hostClock.clockOffset);
check("its room-clock estimate agrees with the sender's within 250 ms (same machine clock)", skew <= 250, `Δ ${Math.round(skew)} ms; round trips ${rejoined.clockRtt} / ${hostClock.clockRtt} ms`);
await drawing([host, member], true);
await stopIfStillRunning(host);
await waitEnded(member);
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 6);

// ── Round 7: pixels. The receiver's lamp crop while the steady light is on vs off ────────────
await host.evaluate((program) => window.__vmQa.editDraft(program), STEADY);
await tap(host, '[data-episode="transmit"]');
await until(() => episode(member), (state) => state.state?.round?.n === 7);
const deadline7 = Date.now() + 118_000;
await drawing([host], false); // only the receiver's lamp is sampled
const litPixels = await lampSample(member, true, deadline7);
const darkPixels = await lampSample(member, false, deadline7);
await drawing([host], true);
check("pixels: the receiver's lamp crop is brighter while the probe says lit than while it says dark (screenshots, same camera)", litPixels.brightness !== undefined && darkPixels.brightness !== undefined && litPixels.brightness - darkPixels.brightness > 8, JSON.stringify({ lit: litPixels.brightness?.toFixed(1) ?? litPixels, dark: darkPixels.brightness?.toFixed(1) ?? darkPixels, litAt: litPixels.elapsed, darkAt: darkPixels.elapsed, clip: litPixels.clip }));
await stopIfStillRunning(host);
await waitEnded(member);
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 7);

// ── Round 8: a teammate's bench change during a transmission ends it for both ────────────────
await host.evaluate((program) => window.__vmQa.editDraft(program), LONG_SAFE);
await host.evaluate(() => window.__vmQa.lightLog());
await member.evaluate(() => window.__vmQa.lightLog());
await tap(host, '[data-episode="transmit"]');
const round8 = (await until(() => episode(member), (state) => state.state?.round?.n === 8)).state.round;
// Both pages draw this transmission before the teammate's edit (bounded wait; the light runs 62 s):
// an edit made at once could leave a page that takes seconds per frame with nothing to check.
const logs8 = new Map([[member, []], [host, []]]);
await until(async () => {
  for (const [page, log] of logs8) await drain(page, log);
  return [...logs8.values()].map((log) => log.filter((frame) => frame.tx === round8.tx).length);
}, (counts) => counts.every((count) => count > 0), 45_000);
// No frame after the cut is checked: both pages stand aside from drawing while the member imports,
// so the edit lands while the light still runs (attempts 7 and 8: a drawing page needed more than
// the light's remaining time for the four import steps).
await drawing([host, member], false);
const memberBench = await member.evaluate(() => window.__vmQa.bench());
const moved = Object.entries(memberBench.parts).map(([id, part]) => ({ id, sockets: id === "sno-w3" ? [30, 31] : part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
await importProject(member, { format: "virtual-makerspace.project", version: 1, solver: "x", studio: "snapino", savedAt: new Date().toISOString(), parts: moved });
const cut = await until(() => episode(host), (state) => state.state?.round?.stopReason);
await drawing([host, member], true);
const cutMember = await until(() => episode(member), (state) => Boolean(state.state?.round?.stopReason), 60_000); // the member's own view (bounded)
check("a teammate's bench edit ends the running transmission for everyone", cut.state.round.stopReason === "bench-changed" && cutMember.state.round.stopReason === "bench-changed", JSON.stringify({ host: cut.state.round.stopReason, member: cutMember.state?.round?.stopReason ?? null }));
for (const [page, label] of [[member, "receiver"], [host, "sender"]]) {
  const frames = summarize(await drain(page, logs8.get(page)), cut.state.round);
  if (frames.frames === 0) await dumpDiagnostics(page, artifacts, `round-8-${label}-no-frames`);
  check(`round 8: the ${label}'s driven frames before the cut-off agree with the timeline (and there were some)`, frames.frames >= 1 && frames.wrong === 0, JSON.stringify(frames));
}
await notDelivered(host, "cut-off round 8");
await shot(host, "07-cut-off-by-bench-change");
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null);
await tap(host, "#load-field-test");
await until(() => member.evaluate(() => window.__vmQa.bench().parts["sno-w3"]?.sockets?.[1]), (socket) => socket === 33);

// ── Round 9: importing the identical program (same parts) while it transmits stops it ─────────
await host.evaluate((program) => window.__vmQa.editDraft(program), LONG_SAFE);
await drawing([host, member], false); // no frames are checked in this round; the import must land in time
await tap(host, '[data-episode="transmit"]');
await until(() => episode(member), (state) => state.state?.round?.n === 9);
const same = await host.evaluate(() => ({ bench: window.__vmQa.bench(), program: window.__vmQa.bench().program }));
const sameParts = Object.entries(same.bench.parts).map(([id, part]) => ({ id, sockets: part.sockets, ...(part.on !== undefined ? { on: part.on } : {}) }));
await importProject(host, { format: "virtual-makerspace.project", version: 1, solver: "x", studio: "snapino", savedAt: new Date().toISOString(), parts: sameParts, program: same.program });
const stopped = await until(() => episode(member), (state) => state.state?.round?.stopReason);
check("importing the identical program while transmitting stops it (program-changed)", stopped.state.round.stopReason === "program-changed", `stopReason ${stopped.state?.round?.stopReason} at ${Math.round(stopped.elapsed)} of ${stopped.state?.round?.durationMs} ms`);
await drawing([host, member], true);
await tap(host, '[data-episode="close-round"]');
await until(() => episode(member), (state) => state.state?.round === null && state.state.history.length === 9);

// ── A full reload: re-entering restores the room's episode, without a role ───────────────────
await member.reload();
await member.waitForSelector("#enter-room", { state: "attached" });
await enter(member);
const reloaded = await until(() => episode(member), (state) => Boolean(state.state));
check("after a reload the receiver gets the room's rounds, and no role", reloaded.state?.history.length === 9 && reloaded.role === null);
await tap(member, '[data-episode="claim-role"][data-role="receiver"]');
await until(() => episode(member), (state) => state.role === "receiver");

// ── Swap roles; export by the new sender (allowed keys only) ────────────────────────────────
await tap(member, '[data-episode="swap-roles"]');
const swapped = await until(() => episode(host), (state) => state.role === "receiver");
const swappedMember = await until(() => episode(member), (state) => state.role === "sender", 60_000); // each client's own view (bounded)
check("roles swap between rounds, on both screens", swapped.role === "receiver" && swappedMember.role === "sender", JSON.stringify({ host: swapped.role, member: swappedMember.role }));
await tap(member, "#project-menu-button");
const [download] = await Promise.all([member.waitForEvent("download"), tap(member, "#export-project")]);
const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
const topKeys = Object.keys(exported).sort();
const allowedTop = ["draftProgram", "episode", "format", "parts", "program", "savedAt", "solver", "studio", "version"];
const partKeys = [...new Set(exported.parts.flatMap((part) => Object.keys(part)))];
check("export schema: only project keys, the design is exactly {id, v, mission, intent}, parts carry only id/sockets/props/on",
  topKeys.every((key) => allowedTop.includes(key)) && JSON.stringify(Object.keys(exported.episode ?? {}).sort()) === '["id","intent","mission","v"]'
  && exported.episode.id === "rescue-signal" && partKeys.every((key) => ["id", "sockets", "props", "on"].includes(key)),
  JSON.stringify({ topKeys, episode: exported.episode, partKeys }));
check("export contains no session activity (no reading, explanation, round or role)", !/Two long flashes|reading|explanation|"round"|"roles"|"history"|"tx"/.test(JSON.stringify(exported)));

// ── Reset: every connected client applies it at once; the next transmission reaches both ─────
const beforeReset = await episode(host);
await tap(member, '[data-episode="reset"]');
await member.waitForFunction(() => document.querySelector("#confirm-dialog")?.open, null, { timeout: 60_000, polling: 250 });
await tap(member, "#confirm-ok");
const resetMember = await until(() => episode(member), (state) => state.state?.history.length === 0, 60_000);
const resetHost = await until(() => episode(host), (state) => state.state?.history.length === 0, 60_000);
check("reset reaches both connected clients immediately, with a higher revision", resetMember.state.history.length === 0 && resetHost.state.history.length === 0 && resetHost.state.rev === resetMember.state.rev && resetHost.state.rev > beforeReset.state.rev, JSON.stringify({ before: beforeReset.state.rev, host: resetHost.state.rev, member: resetMember.state.rev }));
await tap(member, '[data-episode="intent-add"][data-word="SAFE"]');
await until(() => episode(host), (state) => state.state?.intent.join() === "SAFE");
await member.evaluate((program) => window.__vmQa.editDraft(program), IRREGULAR);

// The late joiner's page is loaded and waiting in the lobby BEFORE the recurring light starts, so
// its join happens early in the 107.5 s light.
const phoneContext = await maker("phone@example.test", { width: 390, height: 844 });
const phoneLobby = await lobby(phoneContext, "phone");
await host.evaluate(() => window.__vmQa.lightLog());
await tap(member, '[data-episode="transmit"]');
const afterReset = await until(() => episode(host), (state) => state.state?.round?.n === 1);
check("after the reset, the next transmission reaches the other client (round 1 again, a new tx)", afterReset.state.round.tx > beforeReset.state.rev, `tx ${afterReset.state.round.tx}`);

// ── Late join during the running recurring light (phone-width page) ──────────────────────────
await drawing([host, member], false); // only the joiner's frames are checked until its checks are done
await tap(phoneLobby, "#enter-room");
const joined = await until(() => episode(phoneLobby), (state) => Boolean(state.state?.round), 240_000);
const joinedRound = joined.state?.round ?? null;
check("the late joiner joined while the transmission was running (state at join)", joinedRound?.n === 1 && !joinedRound.stopReason && joined.elapsed < joinedRound.durationMs && joinedRound.tx === afterReset.state.round.tx,
  joinedRound ? `${Math.round(joined.elapsed)} of ${joinedRound.durationMs} ms, tx ${joinedRound.tx}` : "no room state on the joiner within 240 s");
const phone = phoneLobby;
await phone.waitForFunction(() => { const panel = document.querySelector("#episode-panel"); return Boolean(panel) && !panel.hidden; }, null, { timeout: 240_000, polling: 500 });
await ready(phone, "late joiner entered");
const lateFrames = await observeLitAndDark(phone, "late joiner", Math.max(5_000, (joinedRound?.durationMs ?? 0) - (await episode(phone)).elapsed - 2_000));
check("the late joiner's own driven frames (this tx) include lit AND dark, all agreeing with the timeline", joinedRound !== null && lateFrames.tx === joinedRound.tx && lateFrames.lit > 0 && lateFrames.dark > 0 && lateFrames.wrong === 0, JSON.stringify(lateFrames));
// The clock is sampled with the joiner not drawing either (as after the reconnect); the client keeps
// sampling until a round trip is short, and the bound applies to that estimate (error <= rtt / 2).
await drawing([phone], false);
const joinClock = await until(() => episode(phone), (state) => state.clockRtt !== null && state.clockRtt <= 400, 180_000);
const senderClock = await until(() => episode(member), (state) => state.clockRtt !== null && state.clockRtt <= 400, 180_000);
const joinSkew = Math.abs(joinClock.clockOffset - senderClock.clockOffset);
check("its room-clock estimate agrees with the sender's within 250 ms (same machine clock)", joinSkew <= 250, `Δ ${Math.round(joinSkew)} ms; round trips ${joinClock.clockRtt} / ${senderClock.clockRtt} ms`);
await drawing([phone], true);
await shot(phone, "09-phone-late-joiner");
const layout = await phone.evaluate(() => { const panel = document.querySelector("#episode-panel").getBoundingClientRect(); return { left: panel.left, right: panel.right, width: window.innerWidth, overflow: document.documentElement.scrollWidth - window.innerWidth }; });
check("phone-width LAYOUT only: the panel fits between the viewport edges and the page has no horizontal overflow (no touch interaction tested)", layout.left >= 0 && layout.right <= layout.width && layout.overflow <= 0, JSON.stringify(layout));
// The joiner's checks are done: close its page and let the others draw again.
await phoneContext.close();
await drawing([host, member], true);

// ── Leaving mid-transmission ─────────────────────────────────────────────────────────────────
// Always on a fresh transmission: the late-join light may have ended by now. The sender abandons
// the round once it has ended and transmits again; the host leaves while that one runs.
await waitEnded(member);
await tap(member, '[data-episode="close-round"]');
await until(() => episode(host), (state) => state.state?.round === null);
await tap(member, '[data-episode="transmit"]');
await until(() => episode(host), (state) => state.state?.round?.n === 2 && !state.state.round.stopReason);
const beforeLeave = await episode(host);
check("(the transmission is still running when the host leaves)", Boolean(beforeLeave.state.round) && !beforeLeave.state.round.stopReason && beforeLeave.elapsed < beforeLeave.state.round.durationMs, `${Math.round(beforeLeave.elapsed)} of ${beforeLeave.state.round?.durationMs} ms`);
const exitButton = await host.evaluate(() => { const button = [...document.querySelectorAll("button")].find((b) => /leave|exit/i.test(b.getAttribute("aria-label") ?? "")); button?.click(); return button?.getAttribute("aria-label") ?? null; });
await host.waitForSelector("#enter-room", { state: "attached", timeout: 120_000 });
check("leaving during a transmission returns to the lobby without page errors", exitButton && host.errors.length === 0 && !(await host.evaluate(() => document.querySelector("#episode-panel"))), `${exitButton} · ${host.errors.join(" | ")}`);
const afterLeave = await until(() => episode(member), (state) => state.state?.roles.receiver === null, 60_000);
check("the leaver's receiver role is freed; the sender keeps theirs", afterLeave.state.roles.receiver === null && afterLeave.role === "sender");
await hostContext.close();

check("no page errors on the pages that stayed", member.errors.length === 0 && phone.errors.length === 0, [...member.errors, ...phone.errors].join(" | "));

// Every check above is unconditional: a run that skipped one is a failure, not a smaller pass.
const EXPECTED_CHECKS = 59;
check(`the run executed all ${EXPECTED_CHECKS} checks`, results.length === EXPECTED_CHECKS, `${results.length} executed`);
await Promise.all(browsers.map((own) => own.close()));
writeFileSync(`${artifacts}/results.json`, JSON.stringify({ room, results }, null, 1));
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · room ${room} · artifacts ${artifacts}`);
assert.equal(failed.length, 0);
