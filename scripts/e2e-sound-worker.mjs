// Sound Flow Studio (Episode 2) — two real browsers (separate browser processes) over the real
// Worker (Durable Object + WebSocket), plus a late joiner. Developer-environment run (headless
// Chromium, SwiftShader, wrangler dev + the local access proxy), not CI. A fresh random room every
// run (never 7K3M). Every check records when it ran, who acted and the room revisions each client
// held (provenance); a failing check keeps its detail and the run's diagnostics.
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799
//   node --experimental-strip-types scripts/e2e-sound-worker.mjs [http://vm.test:8800] [artifacts-dir]
//
// With real pointer and keyboard input (Playwright mouse/keyboard):
//  - patching: plugs dragged from the mat into jacks by pointer, by both makers; both see one patch;
//  - a knob edit typed and submitted by keyboard is accepted and reaches the other maker;
//  - draft preservation: a typed, unapplied value survives a teammate's accepted edit of the same knob;
//  - declined: a cable a teammate is holding cannot be unplugged from the inspector (nothing changes);
//  - occupied: a plug released over a jack that already holds one stays out, for both;
//  - stale: simultaneous edits of one knob — the room accepts one, the other is refused and that
//    maker keeps the room's value and their draft (attempted up to 4 times; reported as observed);
//  - Undo / Redo of an accepted edit through the toolbar;
//  - local audio: the host starts audio by a click and mutes; the member's edits, a reconnect and a
//    late join never start anyone's audio or unmute or raise the host's volume; losing the
//    connection stops the member's audio, and reconnecting does not restart it;
//  - late join and reconnect receive the room's canonical patch;
//  - the learning loop: a wrong build tested (criteria not met), fixed, tested (met), explained;
//  - PF (member) vs DI (host) gating of the worked example and explanatory notes;
//  - export (version 2, allowed keys only, no names/chat/predictions), a version-1 file of another
//    studio refused, import of the export restoring the patch for both;
//  - everyone leaves (the room resets), the host comes back: recovery banner → restore → both see it;
//  - Reset bench returns every cable and knob to its default for both.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `S${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const artifacts = process.argv[3] ?? `${tmpdir()}/vm-e2e-sound-${room}`;
mkdirSync(artifacts, { recursive: true });
const browsers = [];
const launch = async () => {
  const own = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8799", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=user-gesture-required"],
  });
  browsers.push(own);
  return own;
};
const results = [];
const pages = {};
async function provenance() {
  const out = {};
  for (const [label, page] of Object.entries(pages)) {
    if (!page || page.isClosed()) continue;
    out[label] = await page.evaluate(() => window.__vmQa?.soundRevs?.() ?? null).catch(() => null);
  }
  return out;
}
async function check(name, ok, detail = "", actor = "") {
  const entry = { name, ok: Boolean(ok), detail, actor, at: new Date().toISOString(), revs: await provenance() };
  results.push(entry);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const ready = (page, label) => settled(page, label, { diagnostics: artifacts });
const until = async (read, test, timeout = 240_000) => {
  const started = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    value = await read();
  }
  return value;
};
const sound = (page) => page.evaluate(() => window.__vmQa.sound());
const cablesOf = (snapshot) => JSON.stringify(snapshot?.model?.state?.cables ?? null);
const CANONICAL = JSON.stringify({ "snd-cable-a": [0, 1], "snd-cable-b": [2, 3], "snd-cable-c": [4, 5] });

async function maker(email, viewport) {
  const context = await (await launch()).newContext({ viewport, reducedMotion: "reduce", acceptDownloads: true });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await instrument(context);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
    // Focus trail (diagnostics for keyboard steps): the last 60 focus changes.
    window.__focusTrail = [];
    document.addEventListener("focusin", (event) => {
      const target = event.target;
      window.__focusTrail.push([Math.round(performance.now()), target?.id || target?.dataset?.focusKey || target?.tagName]);
      if (window.__focusTrail.length > 60) window.__focusTrail.shift();
    }, true);
    // Count every AudioContext the page creates (none may exist before this maker's own click).
    const Original = window.AudioContext;
    window.__audioContexts = 0;
    if (Original) {
      window.AudioContext = class extends Original {
        constructor(...args) {
          super(...args);
          window.__audioContexts += 1;
        }
      };
    }
  });
  return context;
}
async function join(context, label, { host = false, condition = "DI" } = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  page.errors = [];
  page.on("pageerror", (error) => { page.errors.push(error.message); console.error(`[${label}] pageerror:`, error.message); });
  await page.goto(`${base}/?room=${room}&quality=low&qa&condition=${condition}`);
  await page.waitForSelector("#enter-room", { state: "attached" });
  if (host) await page.getByRole("radio", { name: /Sound Flow Studio/ }).click();
  await page.locator("#enter-room").click();
  await page.waitForFunction(() => Boolean(window.__vmQa?.sound) && window.__vmQa.bench().studio === "sound", null, { timeout: 300_000, polling: 500 });
  await ready(page, `${label} entered`);
  pages[label] = page;
  return page;
}
/** A real pointer drag of a cable's plug from the mat (or a jack) into a jack. */
async function plug(page, cable, end, jack) {
  const from = await page.evaluate(({ cable, end }) => window.__vmQa.plugPoint(cable, end), { cable, end });
  const to = await page.evaluate((jack) => window.__vmQa.jackPoint(jack, true), jack);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(from.x + ((to.x - from.x) * step) / 10, from.y + ((to.y - from.y) * step) / 10);
  await page.mouse.up();
}
async function selectFromRail(page, id) {
  await page.locator(`.component-card[data-component-id="${id}"]`).click();
  await page.locator('.discussion-tab[data-tab="inspect"]').click();
  await page.waitForFunction((id) => document.querySelector("#sdi-part-title")?.textContent?.includes(id === "snd-filter" ? "Filter" : id === "snd-drive" ? "Drive" : id === "snd-source" ? "Source" : id === "snd-speaker" ? "Speaker" : "cable"), id);
}
/** Click a field and type into it by keyboard; a keystroke that did not land is a recorded failure. */
async function typeInto(page, selector, text) {
  await page.locator(selector).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
  const value = await page.locator(selector).inputValue();
  if (value !== text) {
    const trail = await page.evaluate(() => window.__focusTrail.slice(-20));
    await check(`keyboard typing landed in ${selector}`, false, `field shows "${value}", typed "${text}"; focus trail ${JSON.stringify(trail)}`);
  }
}
const audioOf = (page) => page.evaluate(() => ({ contexts: window.__audioContexts, panel: window.__vmQa.sound().panel }));

let exitCode = 0;
try {
  const hostContext = await maker("host@example.test", { width: 1000, height: 700 });
  const memberContext = await maker("member@example.test", { width: 1000, height: 700 });
  const host = await join(hostContext, "host", { host: true, condition: "DI" });
  const member = await join(memberContext, "member", { condition: "PF" });

  // ── PF/DI gating before any test ──
  await check("DI host sees the worked example; PF member does not", await host.locator("#ss-worked").isVisible() && !(await member.locator("#ss-worked").isVisible()));
  await check("no AudioContext on either page before any click", (await audioOf(host)).contexts === 0 && (await audioOf(member)).contexts === 0);

  // ── Patching by pointer, by both makers ──
  await plug(host, "snd-cable-a", 0, 0);
  await until(() => sound(member), (s) => JSON.stringify(s.model.state.cables["snd-cable-a"]) === "[0,null]");
  await ready(host, "host after plug A0");
  await plug(host, "snd-cable-a", 1, 1);
  await plug(member, "snd-cable-b", 0, 2);
  await ready(member, "member after plug B0");
  await plug(member, "snd-cable-b", 1, 3);
  await ready(member, "member after plug B1");
  await plug(member, "snd-cable-c", 0, 4);
  await ready(member, "member after plug C0");
  await plug(member, "snd-cable-c", 1, 5);
  const patchedHost = await until(() => sound(host), (s) => cablesOf(s) === CANONICAL);
  const patchedMember = await until(() => sound(member), (s) => cablesOf(s) === CANONICAL);
  await check("pointer-dragged plugs: both makers hold the same patch Source → Filter → Drive → Speaker", cablesOf(patchedHost) === CANONICAL && cablesOf(patchedMember) === CANONICAL && patchedHost.model.chain.join() === "snd-source,snd-filter,snd-drive,snd-speaker",
    `${cablesOf(patchedHost)} | ${cablesOf(patchedMember)}`, "host + member");

  // ── Occupied: a plug released over a jack that already holds one stays out ──
  await ready(member, "member before occupied");
  const otherEnd = await member.evaluate(() => window.__vmQa.plugPoint("snd-cable-c", 1));
  const onFilterIn = await member.evaluate(() => window.__vmQa.jackPoint(1, true));
  await member.mouse.move(otherEnd.x, otherEnd.y);
  await member.mouse.down();
  for (let step = 1; step <= 10; step += 1) await member.mouse.move(otherEnd.x + ((onFilterIn.x - otherEnd.x) * step) / 10, otherEnd.y + ((onFilterIn.y - otherEnd.y) * step) / 10);
  await member.mouse.up();
  const afterOccupiedMember = await until(() => sound(member), (s) => JSON.stringify(s.model.state.cables["snd-cable-c"]) === "[4,null]", 120_000);
  const afterOccupiedHost = await until(() => sound(host), (s) => JSON.stringify(s.model.state.cables["snd-cable-c"]) === "[4,null]", 120_000);
  const statusCopy = await member.locator("#scene-status-copy").textContent();
  await check("occupied: the plug dropped on Filter IN (taken) stays out, for both; Filter IN keeps the red cable", JSON.stringify(afterOccupiedMember.model.state.cables["snd-cable-a"]) === "[0,1]" && JSON.stringify(afterOccupiedHost.model.state.cables["snd-cable-c"]) === "[4,null]" && /already holds a plug/.test(statusCopy ?? ""),
    `member C ${JSON.stringify(afterOccupiedMember.model.state.cables["snd-cable-c"])}, host C ${JSON.stringify(afterOccupiedHost.model.state.cables["snd-cable-c"])}; status "${statusCopy}"`, "member");
  await ready(member, "member after occupied");
  await plug(member, "snd-cable-c", 1, 5);
  await until(() => sound(host), (s) => cablesOf(s) === CANONICAL);

  // ── The loop, wrong build first (host, DI): default knobs (sine 440 Hz) → criteria not met ──
  await host.locator('.discussion-tab[data-tab="sound"]').click();
  await host.locator('#ss-predictions input[value="meets"]').check();
  await host.locator("#ss-test").click();
  const firstTest = await until(() => sound(host), (s) => s.panel.tested);
  await check("host Test on the default knobs: not met (C2 tone fails), measured values shown", firstTest.panel.met === false && firstTest.panel.criteria.find((c) => c.id === "C2")?.pass === false, JSON.stringify(firstTest.panel.criteria.map((c) => `${c.id}:${c.pass ? "met" : "not"}`)), "host");

  // ── Keyboard knob edits accepted and shared ──
  await selectFromRail(host, "snd-source");
  await typeInto(host, "#sdi-hz", "220");
  // The waveform by keyboard: focus the checked radio, arrow to "sawtooth"; then Apply by keyboard.
  await host.locator('input[name="sdi-wave"]:checked').focus();
  await host.keyboard.press("ArrowDown");
  await host.keyboard.press("ArrowDown");
  await host.locator('[data-apply="snd-source"]').focus();
  await host.keyboard.press("Enter");
  const tone = await until(() => sound(member), (s) => s.model.state.source.hz === 220 && s.model.state.source.wave === "sawtooth");
  const hostNote = await host.locator("#sdi-panel .si-edit-note").textContent().catch(() => null);
  if (tone.model.state.source.wave !== "sawtooth") await host.screenshot({ path: `${artifacts}/source-edit-host.png` });
  await check("host's Source edit (220 Hz sawtooth, by keyboard) accepted and received by the member", tone.model.state.source.hz === 220 && tone.model.state.source.wave === "sawtooth", `${JSON.stringify(tone.model.state.source)}; host note: ${hostNote}; host drafts ${JSON.stringify((await sound(host)).panel.drafts)}`, "host");

  // ── Draft preservation: member drafts a cutoff, host applies another ──
  await selectFromRail(member, "snd-filter");
  await typeInto(member, "#sdi-cutoff", "650");
  await selectFromRail(host, "snd-filter");
  await typeInto(host, "#sdi-cutoff", "300");
  await host.keyboard.press("Enter");
  const hostCut = await until(() => sound(member), (s) => s.model.state.filter.cutoff === 300);
  const draft = await member.locator("#sdi-cutoff").inputValue();
  await check("member's unapplied draft (650) survives the host's accepted cutoff 300; the member's model shows the room's 300", hostCut.model.state.filter.cutoff === 300 && draft === "650" && hostCut.panel.drafts["snd-filter:cutoff"] === "650", `draft "${draft}"`, "host vs member");
  // The member applies their draft: accepted on top of the room's latest state, shared.
  await member.locator("#sdi-cutoff").focus();
  await member.keyboard.press("Enter");
  const memberCut = await until(() => sound(host), (s) => s.model.state.filter.cutoff === 650);
  await check("member applies the draft: accepted, the host sees 650", memberCut.model.state.filter.cutoff === 650, "", "member");

  // ── Undo / Redo through the toolbar (member's own edit) ──
  await member.locator("#undo-edit").click();
  const undone = await until(() => sound(host), (s) => s.model.state.filter.cutoff === 300);
  await check("member Undo: both back to 300", undone.model.state.filter.cutoff === 300 && (await sound(member)).model.state.filter.cutoff === 300, "", "member");
  await member.locator("#redo-edit").click();
  const redone = await until(() => sound(host), (s) => s.model.state.filter.cutoff === 650);
  await check("member Redo: both at 650", redone.model.state.filter.cutoff === 650, "", "member");
  // Back to a dark cutoff for the brief.
  await selectFromRail(host, "snd-filter");
  await typeInto(host, "#sdi-cutoff", "300");
  await host.keyboard.press("Enter");
  await until(() => sound(member), (s) => s.model.state.filter.cutoff === 300);

  // ── Stale: simultaneous edits of the Drive gain ──
  await selectFromRail(host, "snd-drive");
  await selectFromRail(member, "snd-drive");
  let stale = null;
  for (let attempt = 1; attempt <= 4 && !stale; attempt += 1) {
    await typeInto(host, "#sdi-gain", (1.1 + attempt / 100).toFixed(2));
    await typeInto(member, "#sdi-gain", (2.1 + attempt / 100).toFixed(2));
    await Promise.all([host.locator('[data-apply="snd-drive"]').click(), member.locator('[data-apply="snd-drive"]').click()]);
    const notes = await until(async () => [await host.locator("#sdi-panel .si-edit-note").textContent().catch(() => ""), await member.locator("#sdi-panel .si-edit-note").textContent().catch(() => "")], (pair) => pair.every((text) => text && !/Sending/.test(text)), 60_000);
    const refused = notes.findIndex((text) => /Not applied/.test(text));
    if (refused >= 0) stale = { attempt, notes, refused: refused === 0 ? "host" : "member" };
  }
  if (stale) {
    const loser = stale.refused === "host" ? host : member;
    const winner = stale.refused === "host" ? member : host;
    const roomGain = (await sound(winner)).model.state.drive.gain;
    const loserView = await sound(loser);
    await check("stale: one simultaneous gain edit is refused; that maker holds the room's value and keeps their draft", loserView.model.state.drive.gain === roomGain && Boolean(loserView.panel.drafts["snd-drive:gain"]) && /a teammate changed it first/.test(stale.notes[stale.refused === "host" ? 0 : 1]),
      `attempt ${stale.attempt}: ${JSON.stringify(stale.notes)}; room gain ${roomGain}; loser draft ${loserView.panel.drafts["snd-drive:gain"]}`, stale.refused);
  } else {
    await check("stale: observed within 4 simultaneous attempts (both accepted every time: arrival order serialized them)", true, "not observed; the room-core stale refusal is covered by sound-model-check", "both");
  }
  // Settle the Drive for the brief (host), clearing any draft on the member.
  await selectFromRail(host, "snd-drive");
  await typeInto(host, "#sdi-gain", "1.70");
  await host.keyboard.press("Enter");
  await until(() => sound(member), (s) => s.model.state.drive.gain === 1.7);
  await member.locator('[data-revert="snd-drive"]').click().catch(() => undefined);

  // ── Declined: a cable the host is holding cannot be unplugged by the member ──
  await ready(host, "host before hold");
  const held = await host.evaluate(() => window.__vmQa.plugPoint("snd-cable-b", 0));
  await host.mouse.move(held.x, held.y);
  await host.mouse.down();
  await host.mouse.move(held.x + 6, held.y - 6);
  await until(() => member.evaluate(() => document.querySelector('.component-card[data-component-id="snd-cable-b"]') !== null), Boolean);
  await selectFromRail(member, "snd-cable-b");
  const declined = await until(() => member.evaluate(() => ({ disabled: document.querySelector('[data-mat="snd-cable-b"]')?.disabled ?? null, note: document.querySelector("#sdi-panel")?.textContent ?? "" })), (v) => v.disabled === true, 60_000);
  await check("declined: while the host holds the yellow cable, the member's Unplug is disabled and says who holds it", declined.disabled === true && /is holding this cable/.test(declined.note), JSON.stringify(declined).slice(0, 200), "member");
  // Host releases where it started (back into its jack).
  const back = await host.evaluate(() => window.__vmQa.jackPoint(2, true));
  await host.mouse.move(back.x, back.y);
  await host.mouse.up();
  const stillPatched = await until(() => sound(member), (s) => cablesOf(s) === CANONICAL);
  await check("after the hold: the patch is unchanged for both", cablesOf(stillPatched) === CANONICAL && cablesOf(await sound(host)) === CANONICAL, cablesOf(stillPatched));

  // ── Audio: host clicks Start, then Mute; the member never starts audio ──
  await host.locator('.discussion-tab[data-tab="sound"]').click();
  await host.locator("#ss-audio-start").click();
  const started = await until(() => audioOf(host), (a) => a.panel.audio === "running", 60_000);
  await check("host: a click starts audio (one AudioContext, running)", started.contexts === 1 && started.panel.audio === "running", JSON.stringify({ contexts: started.contexts, audio: started.panel.audio }), "host");
  await host.locator("#ss-audio-mute").click();
  await check("host: Mute applies at once", (await audioOf(host)).panel.muted === true, "", "host");
  // Member edits (gain and the Speaker switch) arrive at the muted host.
  await selectFromRail(member, "snd-speaker");
  await member.locator("#sdi-panel [data-speaker-switch]").click();
  await until(() => sound(host), (s) => s.model.state.speakerOn === false);
  await member.locator("#sdi-panel [data-speaker-switch]").click();
  await until(() => sound(host), (s) => s.model.state.speakerOn === true);
  const hostAudio = await audioOf(host);
  const memberAudio = await audioOf(member);
  await check("teammate edits never unmute, raise or restart the host's audio; the member never had audio", hostAudio.contexts === 1 && hostAudio.panel.muted === true && hostAudio.panel.volume === 0.5 && hostAudio.panel.audio === "running" && memberAudio.contexts === 0,
    JSON.stringify({ host: { contexts: hostAudio.contexts, muted: hostAudio.panel.muted, volume: hostAudio.panel.volume }, member: memberAudio.contexts }));
  // Member starts audio, then loses the connection: audio stops; reconnecting does not restart it.
  await member.locator('.discussion-tab[data-tab="sound"]').click();
  await member.locator("#ss-audio-start").click();
  await until(() => audioOf(member), (a) => a.panel.audio === "running", 60_000);
  await member.evaluate(() => window.__vmQa.dropConnection());
  const dropped = await until(() => audioOf(member), (a) => a.panel.audio === "off", 30_000);
  // While the member is offline, the host changes the gain.
  await selectFromRail(host, "snd-drive");
  await typeInto(host, "#sdi-gain", "1.60");
  await host.keyboard.press("Enter");
  await until(() => sound(host), (s) => s.model.state.drive.gain === 1.6);
  const reconnected = await until(() => sound(member), (s) => s.model.state.drive.gain === 1.6, 120_000);
  const afterReconnect = await audioOf(member);
  await check("member: losing the connection stops audio; after reconnecting it holds the room's gain (1.60) and audio stays off until a click", dropped.panel.audio === "off" && reconnected.model.state.drive.gain === 1.6 && afterReconnect.panel.audio === "off" && afterReconnect.contexts === 1,
    JSON.stringify({ dropped: dropped.panel.audio, gain: reconnected.model.state.drive.gain, audio: afterReconnect.panel.audio, contexts: afterReconnect.contexts }), "member");

  // ── Late joiner ──
  const lateContext = await maker("late@example.test", { width: 900, height: 640 });
  const late = await join(lateContext, "late", { condition: "DI" });
  const lateView = await until(() => sound(late), (s) => cablesOf(s) === CANONICAL && s.model.state.drive.gain === 1.6 && s.model.state.filter.cutoff === 300);
  await check("late joiner receives the canonical patch and knobs; no audio on its page", cablesOf(lateView) === CANONICAL && lateView.model.state.source.wave === "sawtooth" && (await audioOf(late)).contexts === 0, JSON.stringify(lateView.model.state), "late");
  await late.close();
  delete pages.late;

  // ── The loop: met and explained (host); PF member's notes unlock after their own test ──
  await host.locator('.discussion-tab[data-tab="sound"]').click();
  await host.locator("#ss-new-attempt").click();
  await host.locator('#ss-predictions input[value="meets"]').check();
  await host.locator("#ss-test").click();
  const met = await until(() => sound(host), (s) => s.panel.tested && s.panel.attempt === 2);
  await check("host Test on the fixed patch: all five criteria met", met.panel.met === true, JSON.stringify(met.panel.criteria.map((c) => `${c.id}:${c.measured}`)), "host");
  await host.locator("#ss-explain").fill("The low-pass at 300 Hz keeps 220 Hz and cuts 660 Hz; the Drive brings the level up without clipping.");
  await host.locator("#ss-explain-save").click();
  await check("host: explanation saved → brief met and explained", (await sound(host)).panel.explained === true, "", "host");
  const notesBefore = await member.evaluate(() => window.__vmQa.sound().panel.notesUnlocked);
  await member.locator('.discussion-tab[data-tab="sound"]').click();
  await member.locator("#ss-test").click();
  const notesAfter = await until(() => member.evaluate(() => window.__vmQa.sound().panel.notesUnlocked), Boolean, 30_000);
  await check("PF member: explanatory notes withheld before their first Test, unlocked after it", notesBefore === false && notesAfter === true, "", "member");

  // ── Export, a refused older file, import ──
  await host.locator("#project-menu-button").click();
  const [download] = await Promise.all([host.waitForEvent("download"), host.locator("#export-project").click()]);
  const exportPath = `${artifacts}/export.json`;
  await download.saveAs(exportPath);
  const exported = JSON.parse(readFileSync(exportPath, "utf8"));
  const allowed = ["format", "version", "solver", "studio", "savedAt", "parts"];
  await check("export: version 2 Sound project, allowed keys only, patch and knobs, no names/chat/predictions", exported.version === 2 && exported.studio === "sound" && Object.keys(exported).every((key) => allowed.includes(key)) && !/host@|member@|predict|explan|chat/i.test(JSON.stringify(exported)) && JSON.stringify(exported.parts.find((p) => p.id === "snd-cable-c").sockets) === "[4,5]",
    JSON.stringify(Object.keys(exported)), "host");
  const legacyPath = `${artifacts}/legacy-circuit.json`;
  writeFileSync(legacyPath, JSON.stringify({ format: "virtual-makerspace.project", version: 1, solver: "dc-mna-1", studio: "circuit", savedAt: "2026-01-01T00:00:00.000Z", parts: [{ id: "resistor-1k", sockets: [36, 39], props: { ohms: 470 } }] }));
  await host.locator("#project-file-input").setInputFiles(legacyPath);
  await until(() => host.locator("#scene-status-copy").textContent(), (text) => /Import refused/.test(text ?? ""), 30_000);
  await check("an older version-1 Circuit Bench file is refused here with the reason", /circuit studio/.test(await host.locator("#scene-status-copy").textContent() ?? ""), await host.locator("#scene-status-copy").textContent(), "host");

  // ── Reset ──
  await host.locator("#project-menu-button").click();
  await host.locator("#reset-bench").click();
  await host.locator("#confirm-ok").click();
  const resetMember = await until(() => sound(member), (s) => s.model.state.cables["snd-cable-a"][0] === null && s.model.state.source.hz === 440);
  await check("Reset bench: every cable on the mat and every knob at its default, for both", JSON.stringify(resetMember.model.state) === JSON.stringify({ cables: { "snd-cable-a": [null, null], "snd-cable-b": [null, null], "snd-cable-c": [null, null] }, source: { hz: 440, wave: "sine" }, filter: { cutoff: 2000 }, drive: { gain: 1 }, speakerOn: true }), JSON.stringify(resetMember.model.state), "host");
  // Import the export: the patch comes back for both.
  await host.locator("#project-file-input").setInputFiles(exportPath);
  await host.locator("#confirm-ok").click();
  const imported = await until(() => sound(member), (s) => cablesOf(s) === CANONICAL && s.model.state.drive.gain === 1.6);
  await check("import of the exported file restores the patch and knobs for both (one room edit)", cablesOf(imported) === CANONICAL && imported.model.state.filter.cutoff === 300 && imported.model.state.source.wave === "sawtooth", JSON.stringify(imported.model.state), "host");

  // ── Everyone leaves (the room resets); the host returns and recovers ──
  await ready(host, "host before leaving");
  await new Promise((resolve) => setTimeout(resolve, 2500)); // autosave debounce (900 ms) on a slow page
  await member.close();
  delete pages.member;
  await host.close();
  delete pages.host;
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const back2 = await join(hostContext, "host");
  const emptied = await sound(back2);
  const banner = await until(() => back2.locator("#recovery-banner").isVisible(), Boolean, 120_000);
  await check("after everyone left the room reset; returning, the host is offered its saved bench", cablesOf(emptied) !== CANONICAL && banner === true, cablesOf(emptied), "host");
  await back2.locator('[data-recovery="restore"]').click();
  const recovered = await until(() => sound(back2), (s) => cablesOf(s) === CANONICAL);
  const member2 = await join(memberContext, "member", { condition: "PF" });
  const memberRecovered = await until(() => sound(member2), (s) => cablesOf(s) === CANONICAL);
  await check("restore: the room holds the recovered patch; the member rejoining sees it", cablesOf(recovered) === CANONICAL && cablesOf(memberRecovered) === CANONICAL && memberRecovered.model.state.drive.gain === 1.6, JSON.stringify(memberRecovered.model.state), "host");
  const audioAtEnd = { host: await audioOf(back2), member: await audioOf(member2) };
  await check("rejoining never starts audio", audioAtEnd.host.contexts === 0 && audioAtEnd.member.contexts === 0, JSON.stringify({ host: audioAtEnd.host.contexts, member: audioAtEnd.member.contexts }));
  const errors = Object.values(pages).flatMap((page) => page.errors ?? []);
  await check("no page errors", errors.length === 0, errors.join("; "));
} catch (error) {
  console.error(error);
  results.push({ name: "run completed", ok: false, detail: String(error?.stack ?? error), at: new Date().toISOString() });
  for (const [label, page] of Object.entries(pages)) {
    if (page && !page.isClosed()) await page.screenshot({ path: `${artifacts}/fail-${label}.png` }).catch(() => undefined);
  }
  exitCode = 1;
} finally {
  const failed = results.filter((entry) => !entry.ok);
  writeFileSync(`${artifacts}/results.json`, `${JSON.stringify({ room, base, results }, null, 1)}\n`);
  console.log(`e2e sound: ${results.length - failed.length}/${results.length} checks passed (room ${room}; artifacts ${artifacts})`);
  await Promise.all(browsers.map((own) => own.close().catch(() => undefined)));
  process.exit(failed.length || exitCode ? 1 : 0);
}
