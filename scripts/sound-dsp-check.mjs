// Sound Flow Studio (Episode 2): the actual Web Audio graph (src/sound/sound-audio.ts), rendered
// in Chromium with an OfflineAudioContext and measured against INDEPENDENT analytic references:
//  - source frequency and the Source's 0.5 FS peak (sine, square, sawtooth);
//  - gain transfer; the low-pass transfer against the RBJ biquad formula written here (Web Audio's
//    lowpass Q in dB) and against the analog Butterworth the brief uses;
//  - silence for an open patch, a loop and a switched-off Speaker (whose input still carries signal);
//  - real clipping: a sine driven to 2 FS clips 2/3 of each cycle, peak 1.0, Speaker out 0.25 FS;
//  - the model's numbers (sound-model.ts) against the rendered buffers;
//  - the live engine in the page: no AudioContext before a trusted click, refusal without one,
//    a real click starts it, mute silences the output within 50 ms, stop() closes the context and
//    stops every oscillator it started; a disconnect or studio exit while the click's resume is
//    still pending closes that context (the late resume never plays), and a stale start's late
//    failure never touches a newer running start.
// What this proves: the digital signal Web Audio computes. Nothing here was heard through a
// physical speaker, and no loudness (SPL) is measured.
//   node scripts/sound-dsp-check.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const dir = mkdtempSync(join(tmpdir(), "sound-dsp-"));
const bundle = join(dir, "sound.js");
const entry = join(dir, "entry.ts");
const root = new URL("..", import.meta.url).pathname;
writeFileSync(entry, `
import * as audio from "${root}src/sound/sound-audio.ts";
import * as model from "${root}src/sound/sound-model.ts";
(window as any).__sound = { audio, model };
`);
execFileSync(join(root, "node_modules/.bin/esbuild"), [entry, "--bundle", "--format=iife", `--outfile=${bundle}`, "--log-level=warning"], { stdio: "inherit" });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-proxy-server"] });
const page = await browser.newPage();
const issues = [];
page.on("pageerror", (error) => issues.push(error.message));
await page.setContent(`<!doctype html><meta charset="utf-8"><button id="start" style="width:200px;height:60px">Start audio</button>`);
// Count AudioContexts and oscillator starts/stops before the bundle runs.
await page.evaluate(() => {
  const Original = window.AudioContext;
  window.__contexts = [];
  window.AudioContext = class extends Original {
    constructor(...args) {
      super(...args);
      window.__contexts.push(this);
    }
  };
  window.__osc = { started: 0, stopped: 0 };
  const start = OscillatorNode.prototype.start;
  const stop = OscillatorNode.prototype.stop;
  OscillatorNode.prototype.start = function (...args) { if (this.context instanceof window.AudioContext) window.__osc.started += 1; return start.apply(this, args); };
  OscillatorNode.prototype.stop = function (...args) { if (this.context instanceof window.AudioContext) window.__osc.stopped += 1; return stop.apply(this, args); };
});
await page.addScriptTag({ content: readFileSync(bundle, "utf8") });

let checks = 0;
const ok = (value, label, detail = "") => {
  checks += 1;
  if (!value) issues.push(`${label}${detail ? ` — ${detail}` : ""}`);
  assert.ok(value, `${label}${detail ? ` — ${detail}` : ""}`);
};

const SR = 48_000;
const cables = (map) => ({ "snd-cable-a": [null, null], "snd-cable-b": [null, null], "snd-cable-c": [null, null], ...map });
const state = (map, source, cutoff = 2000, gain = 1, speakerOn = true) => ({ cables: cables(map), source, filter: { cutoff }, drive: { gain }, speakerOn });
const DIRECT = { "snd-cable-a": [0, 5] };
const FILTER = { "snd-cable-a": [0, 1], "snd-cable-c": [2, 5] };
const DRIVE = { "snd-cable-a": [0, 3], "snd-cable-c": [4, 5] };
const FULL = { "snd-cable-a": [0, 1], "snd-cable-b": [2, 3], "snd-cable-c": [4, 5] };

/** Renders in the page and measures there (buffers stay in the page). */
const render = (s, f0, seconds = 0.3) => page.evaluate(async ({ s, f0, seconds, SR }) => {
  const { audio } = window.__sound;
  const rendered = await audio.renderOffline(s, seconds, SR);
  const a = audio.measure(rendered.speakerIn, SR, f0);
  const b = audio.measure(rendered.speakerOut, SR, f0);
  const start = Math.round(0.05 * SR);
  let crossings = 0;
  let first = -1;
  let last = -1;
  let clippedSamples = 0;
  let maxAbsIn = 0;
  let maxAbsOut = 0;
  for (let i = start + 1; i < rendered.speakerIn.length; i += 1) {
    const x0 = rendered.speakerIn[i - 1];
    const x1 = rendered.speakerIn[i];
    if (x0 < 0 && x1 >= 0) {
      const t = (i - 1 + -x0 / (x1 - x0)) / SR;
      if (first < 0) first = t;
      last = t;
      crossings += 1;
    }
    if (Math.abs(x1) >= 0.9999) clippedSamples += 1;
    maxAbsIn = Math.max(maxAbsIn, Math.abs(x1));
    maxAbsOut = Math.max(maxAbsOut, Math.abs(rendered.speakerOut[i]));
  }
  return { in: a, out: b, frequency: crossings > 1 ? (crossings - 1) / (last - first) : 0, clippedFraction: clippedSamples / (rendered.speakerIn.length - start - 1), maxAbsIn, maxAbsOut };
}, { s, f0, seconds, SR });

const db = (x) => 20 * Math.log10(x);
// RBJ cookbook low-pass, Q in dB as Web Audio specifies for "lowpass".
function rbjLowpassMagnitude(f, fc, qDb, fs = SR) {
  const w0 = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
  const cos = Math.cos(w0);
  const b0 = (1 - cos) / 2, b1 = 1 - cos, b2 = (1 - cos) / 2;
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  const w = (2 * Math.PI * f) / fs;
  const num = [b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), -(b1 * Math.sin(w) + b2 * Math.sin(2 * w))];
  const den = [a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), -(a1 * Math.sin(w) + a2 * Math.sin(2 * w))];
  return Math.hypot(...num) / Math.hypot(...den);
}
const analog = (f, fc) => 1 / Math.sqrt(1 + (f / fc) ** 4);
const record = { source: {}, filter: [], analogMaxDeltaDb: { upTo1kHz: 0, all: 0 }, model: [] };

// Source: frequency; fundamental 0.5·b1/G with G = (2/π)·Si(π) for square and sawtooth (Web Audio
// scales the full-band wave to peak 1.0; computed here independently) and G = 1 for sine; and the
// model's band-limited peak.
let si = 0;
for (let i = 0, N = 1_000_000; i < N; i += 1) {
  const t = (Math.PI * (i + 0.5)) / N;
  si += (Math.sin(t) / t) * (Math.PI / N);
}
const GIBBS = (2 / Math.PI) * si;
for (const wave of ["sine", "square", "sawtooth"]) {
  for (const hz of [55, 220, 440, 1760]) {
    const r = await render(state(DIRECT, { hz, wave }), hz);
    const b1 = wave === "sine" ? 1 : wave === "square" ? 4 / Math.PI : 2 / Math.PI;
    const expectedH1 = (0.5 * b1) / (wave === "sine" ? 1 : GIBBS);
    const modelPeak = await page.evaluate(({ wave, hz }) => window.__sound.model.truePeak(window.__sound.model.sourcePeriod(wave, hz, 48000)), { wave, hz });
    record.source[`${wave}@${hz}`] = { peak: r.in.peak, modelPeak, h1: r.in.harmonics[0], expectedH1, frequency: r.frequency };
    ok(Math.abs(r.frequency - hz) < 0.05 || wave !== "sine", `sine ${hz} Hz: zero-crossing frequency`, String(r.frequency));
    ok(Math.abs(r.in.harmonics[0] - expectedH1) < expectedH1 * 0.002, `${wave} ${hz} Hz: fundamental 0.5·b1/G`, `${r.in.harmonics[0]} vs ${expectedH1}`);
    ok(Math.abs(r.in.peak - modelPeak) < 0.5 * 0.02, `${wave} ${hz} Hz: peak as the model predicts (within 2 % of 0.5 FS)`, `${r.in.peak} vs ${modelPeak}`);
  }
}
// Gain transfer (sine, below clipping).
for (const gain of [0, 0.25, 1, 1.5, 2]) {
  const r = await render(state(DRIVE, { hz: 440, wave: "sine" }, 2000, gain), 440);
  const expected = 0.5 * gain / Math.SQRT2;
  ok(Math.abs(r.in.rms - expected) <= 1e-4 + expected * 2e-3, `drive ×${gain}: RMS ${expected.toFixed(4)}`, String(r.in.rms));
}
// Filter transfer: the digital biquad (independent formula) and the analog prototype.
for (const fc of [80, 300, 1000, 4000, 8000]) {
  for (const f of [55, 220, 660, 1760].concat(fc <= 1760 ? [fc] : [])) {
    const r = await render(state(FILTER, { hz: f, wave: "sine" }, fc), f, 0.4);
    const measured = r.in.harmonics[0] / 0.5;
    const digital = rbjLowpassMagnitude(f, fc, 20 * Math.log10(Math.SQRT1_2));
    record.filter.push({ fc, f, measuredDb: db(measured), digitalDb: db(digital), analogDb: db(analog(f, fc)) });
    ok(Math.abs(db(measured) - db(digital)) < 0.05, `filter ${fc} Hz at ${f} Hz: matches the RBJ biquad (Q in dB)`, `${db(measured).toFixed(3)} vs ${db(digital).toFixed(3)} dB`);
    const delta = Math.abs(db(measured) - db(analog(f, fc)));
    record.analogMaxDeltaDb.all = Math.max(record.analogMaxDeltaDb.all, delta);
    if (f <= 1000 && fc <= 1000) record.analogMaxDeltaDb.upTo1kHz = Math.max(record.analogMaxDeltaDb.upTo1kHz, delta);
  }
}
ok(record.analogMaxDeltaDb.upTo1kHz < 0.1, "brief range (≤ 1 kHz): the digital filter is within 0.1 dB of the analog prototype", String(record.analogMaxDeltaDb.upTo1kHz));
// Silence where nothing is connected; the Speaker switch.
for (const [label, s] of [
  ["open patch", state({ "snd-cable-a": [0, 1] }, { hz: 440, wave: "sine" })],
  ["filter↔drive loop", state({ "snd-cable-a": [2, 3], "snd-cable-b": [4, 1] }, { hz: 440, wave: "sine" }, 2000, 4)],
  ["OUT→OUT", state({ "snd-cable-a": [0, 2], "snd-cable-c": [4, 5] }, { hz: 440, wave: "sine" })],
]) {
  const r = await render(s, 440);
  ok(r.maxAbsIn === 0 && r.maxAbsOut === 0, `${label}: exact silence at the Speaker`, `${r.maxAbsIn} ${r.maxAbsOut}`);
}
{
  const r = await render(state(DIRECT, { hz: 440, wave: "sine" }, 2000, 1, false), 440);
  ok(Math.abs(r.in.peak - 0.5) < 0.002 && r.maxAbsOut === 0, "Speaker off: input carries the tone, output is silent");
  const on = await render(state(DIRECT, { hz: 440, wave: "sine" }), 440);
  ok(Math.abs(on.out.peak - 0.125) < 0.001, "Speaker on: output = input × 0.25", String(on.out.peak));
}
// Real clipping.
{
  const r = await render(state(DRIVE, { hz: 440, wave: "sine" }, 2000, 4), 440, 0.5);
  const expected = 1 - (2 / Math.PI) * Math.asin(1 / 2);
  record.clipping = { fraction: r.clippedFraction, expected, peak: r.in.peak, out: r.out.peak };
  ok(Math.abs(r.clippedFraction - expected) < 0.01, "sine at 2 FS: 2/3 of each cycle sits on the rail", `${r.clippedFraction} vs ${expected}`);
  ok(Math.abs(r.in.peak - 1) < 1e-6, "clipped peak 1.0 FS", String(r.in.peak));
  ok(r.maxAbsOut <= 0.25 + 1e-6, "Speaker output ≤ 0.25 FS", String(r.maxAbsOut));
}
// The model's numbers against the rendered graph (unclipped builds: within 0.3 dB).
for (const [label, s] of [
  ["worked example", state(FULL, { hz: 220, wave: "sawtooth" }, 300, 1.7)],
  ["no filtering", state(FULL, { hz: 220, wave: "sawtooth" }, 2000, 1)],
  ["drive first ×1.2", state({ "snd-cable-a": [0, 3], "snd-cable-b": [4, 1], "snd-cable-c": [2, 5] }, { hz: 220, wave: "sawtooth" }, 300, 1.2)],
  ["square 330 Hz at 800 Hz", state(FULL, { hz: 330, wave: "square" }, 800, 1)],
  ["sine 1 kHz at 250 Hz", state(FULL, { hz: 1000, wave: "sine" }, 250, 3)],
]) {
  const f0 = s.source.hz;
  const r = await render(s, f0, 0.4);
  const m = await page.evaluate((s) => {
    const signal = window.__sound.model.analyzeSignal(s);
    return { peak: signal.speakerIn.peak, harmonics: signal.speakerIn.harmonics };
  }, s);
  const entry = { label, renderedPeakDb: db(r.in.peak), modelPeakDb: db(m.peak), renderedH1Db: db(r.in.harmonics[0]), modelH1Db: db(m.harmonics[0]), renderedH3Db: db(r.in.harmonics[2]), modelH3Db: db(m.harmonics[2]) };
  record.model.push(entry);
  ok(Math.abs(entry.renderedH1Db - entry.modelH1Db) < 0.3, `${label}: fundamental, model vs rendered`, `${entry.modelH1Db.toFixed(2)} vs ${entry.renderedH1Db.toFixed(2)} dB`);
  if (m.harmonics[2] > 1e-3) ok(Math.abs(entry.renderedH3Db - entry.modelH3Db) < 0.5, `${label}: 3rd harmonic, model vs rendered`, `${entry.modelH3Db.toFixed(2)} vs ${entry.renderedH3Db.toFixed(2)} dB`);
  ok(Math.abs(entry.renderedPeakDb - entry.modelPeakDb) < 0.3, `${label}: peak, model vs rendered`, `${entry.modelPeakDb.toFixed(2)} vs ${entry.renderedPeakDb.toFixed(2)} dB`);
}
// Ceiling on random builds (including clipped ones).
{
  const worst = await page.evaluate(async () => {
    const { audio } = window.__sound;
    let worst = 0;
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const jacks = () => { const a = Math.floor(random() * 6); let b = Math.floor(random() * 6); if (b === a) b = (b + 1) % 6; return [a, b]; };
    for (let i = 0; i < 24; i += 1) {
      const s = { cables: { "snd-cable-a": jacks(), "snd-cable-b": jacks(), "snd-cable-c": jacks() }, source: { hz: 55 + Math.floor(random() * 1700), wave: ["sine", "square", "sawtooth"][i % 3] }, filter: { cutoff: 80 + Math.floor(random() * 7900) }, drive: { gain: Math.round(random() * 400) / 100 }, speakerOn: true };
      const r = await audio.renderOffline(s, 0.1, 48000);
      for (const value of r.speakerOut) worst = Math.max(worst, Math.abs(value));
    }
    return worst;
  });
  ok(worst <= 0.25 + 1e-6, "random builds: Speaker output never above 0.25 FS", String(worst));
  record.randomCeilingWorst = worst;
}

// ── The live engine: gesture, mute, stop ───────────────────────────────────────────
await page.evaluate(() => {
  const { audio } = window.__sound;
  window.__statuses = [];
  window.__engine = new audio.SoundEngine((status) => window.__statuses.push(status));
  window.__engine.apply({ cables: { "snd-cable-a": [0, 5], "snd-cable-b": [null, null], "snd-cable-c": [null, null] }, source: { hz: 440, wave: "sine" }, filter: { cutoff: 2000 }, drive: { gain: 1 }, speakerOn: true });
  document.querySelector("#start").addEventListener("click", () => void window.__engine.start());
});
ok(await page.evaluate(() => window.__contexts.length === 0), "no AudioContext before any gesture (apply() never creates one)");
// Playwright's evaluate() runs with a user gesture, so the refusal is exercised from a timer that
// fires after the transient activation has expired (a teammate's edit or a reconnect runs like
// this: no gesture). Nothing calls into the page while it waits.
await page.evaluate(() => {
  window.__refusal = null;
  setTimeout(async () => {
    const hasApi = Boolean(navigator.userActivation);
    const active = navigator.userActivation?.isActive ?? null;
    const started = await window.__engine.start();
    window.__refusal = { hasApi, active, started, contexts: window.__contexts.length, status: window.__engine.status };
  }, 7000);
});
await page.waitForTimeout(8000);
const refused = await page.evaluate(() => window.__refusal);
record.refusal = refused;
ok(refused.hasApi && refused.active === false && refused.started === false && refused.contexts === 0 && refused.status === "needs-gesture", "start() without user activation is refused and creates nothing", JSON.stringify(refused));
await page.click("#start");
await page.waitForFunction(() => window.__engine.status === "running", null, { timeout: 10_000 });
ok(await page.evaluate(() => window.__contexts.length === 1 && window.__contexts[0].state === "running"), "a trusted click creates and runs one AudioContext");
await page.waitForTimeout(300);
const live = await page.evaluate(() => window.__engine.levels());
record.live = { before: live };
ok(live && Math.abs(live.speakerIn - 0.5) < 0.02 && live.output > 0.05 && live.output <= 0.125 * 0.5 + 0.002, "live analysers: Speaker input 0.5 FS, output ≤ 0.25 × 50 % volume", JSON.stringify(live));
await page.evaluate(() => window.__engine.setVolume(7));
ok(await page.evaluate(() => window.__engine.volumeLevel === 1), "volume is capped at 100 %");
await page.evaluate(() => window.__engine.setMuted(true));
await page.waitForTimeout(80);
const muted = await page.evaluate(() => window.__engine.levels());
record.live.muted = muted;
ok(muted && muted.output === 0 && muted.speakerIn > 0.4, "mute: output exactly 0 within 80 ms while the Speaker still receives the tone (not mistaken for a broken patch)", JSON.stringify(muted));
// A teammate's change arrives while muted: the graph follows, mute and volume stay.
await page.evaluate(() => window.__engine.apply({ cables: { "snd-cable-a": [0, 3], "snd-cable-b": [null, null], "snd-cable-c": [4, 5] }, source: { hz: 220, wave: "sawtooth" }, filter: { cutoff: 2000 }, drive: { gain: 4 }, speakerOn: true }));
await page.waitForTimeout(150);
const after = await page.evaluate(() => ({ levels: window.__engine.levels(), muted: window.__engine.isMuted, volume: window.__engine.volumeLevel, contexts: window.__contexts.length }));
record.live.remote = after;
ok(after.muted && after.levels.output === 0 && after.levels.speakerIn > 0.99 && after.contexts === 1, "a remote patch change while muted: still muted, no new context, the new (clipped) signal reaches the Speaker", JSON.stringify(after));
await page.evaluate(() => window.__engine.stop("test"));
await page.waitForTimeout(200);
const stopped = await page.evaluate(() => ({ state: window.__contexts[0].state, status: window.__engine.status, osc: window.__osc, levels: window.__engine.levels() }));
record.live.stopped = stopped;
ok(stopped.state === "closed" && stopped.status === "off" && stopped.osc.started > 0 && stopped.osc.started === stopped.osc.stopped && stopped.levels === null, "stop(): the context is closed and every oscillator it started was stopped", JSON.stringify(stopped));
await page.evaluate(() => window.__engine.apply({ cables: { "snd-cable-a": [0, 5], "snd-cable-b": [null, null], "snd-cable-c": [null, null] }, source: { hz: 440, wave: "sine" }, filter: { cutoff: 2000 }, drive: { gain: 1 }, speakerOn: true }));
ok(await page.evaluate(() => window.__contexts.length === 1 && window.__engine.status === "off"), "after stop, a remote change does not restart audio");

// Review finding B2 (PR #5): a click creates the context, but its resume() settles later. Leaving
// the room (disconnect) or the studio in between must still stop it, so the late resume never
// plays; and a stale start's failure must not touch a newer running start. resume() is held here
// until the test settles it; everything else is the real engine and the real exit helper.
await page.evaluate(() => {
  const PATCH = { cables: { "snd-cable-a": [0, 5], "snd-cable-b": [null, null], "snd-cable-c": [null, null] }, source: { hz: 440, wave: "sine" }, filter: { cutoff: 2000 }, drive: { gain: 1 }, speakerOn: true };
  const original = AudioContext.prototype.resume;
  window.__pending = [];
  AudioContext.prototype.resume = function () {
    return new Promise((resolve, reject) => window.__pending.push({ context: this, release: () => original.call(this).then(resolve, reject), fail: (error) => reject(error) }));
  };
  window.__engines = {};
  window.__exitStatuses = {};
  for (const name of ["disconnect", "studio", "race"]) {
    window.__exitStatuses[name] = [];
    const engine = new window.__sound.audio.SoundEngine((status) => window.__exitStatuses[name].push(status));
    engine.apply(PATCH);
    window.__engines[name] = engine;
    const button = document.createElement("button");
    button.id = `start-${name}`;
    button.textContent = `Start ${name}`;
    button.style.cssText = "display:block;width:200px;height:60px";
    button.addEventListener("click", () => void engine.start());
    document.body.append(button);
  }
});
const pendingCount = () => page.evaluate(() => window.__pending.length);
const osc = () => page.evaluate(() => ({ ...window.__osc }));
record.live.delayedResume = {};
for (const [name, reason] of [["disconnect", "Connection to the room lost · audio stopped"], ["studio", "Left Sound Flow Studio · audio stopped"]]) {
  const n = await pendingCount();
  const oscBefore = await osc();
  await page.click(`#start-${name}`);
  await page.waitForFunction((count) => window.__pending.length === count + 1, n);
  const pendingState = await page.evaluate((engineName) => ({ status: window.__engines[engineName].status, active: window.__engines[engineName].active, contexts: window.__contexts.length }), name);
  const stoppedSomething = await page.evaluate(({ engineName, why }) => window.__sound.audio.stopEngineForExit(window.__engines[engineName], why), { engineName: name, why: reason });
  await page.evaluate((index) => window.__pending[index].release(), n);
  await page.waitForTimeout(300);
  const result = await page.evaluate(({ engineName, index }) => ({
    status: window.__engines[engineName].status,
    statuses: window.__exitStatuses[engineName],
    state: window.__pending[index].context.state,
    levels: window.__engines[engineName].levels(),
    active: window.__engines[engineName].active,
  }), { engineName: name, index: n });
  const oscAfter = await osc();
  const started = oscAfter.started - oscBefore.started;
  const stopped = oscAfter.stopped - oscBefore.stopped;
  record.live.delayedResume[name] = { pendingState, stoppedSomething, result, started, stopped };
  // In Chromium a context created inside a click usually starts running on its own, so the status
  // may already say "running" here; the "off while pending" case is covered with a context that
  // starts suspended in scripts/sound-engine-check.mjs.
  ok(stoppedSomething === true && pendingState.active === true && result.state === "closed" && result.status === "off" && result.levels === null && result.active === false && started === stopped && result.statuses[result.statuses.length - 1] === "off",
    `${name} while the click's resume is pending (real Chromium): the exit helper closes that context and the late resume does not bring audio back (oscillators started ${started} = stopped ${stopped})`, JSON.stringify({ pendingState, result }));
}
// Finding (a): start A → stop → start B (runs) → A's resume fails late: B keeps running, no error status.
{
  const n = await pendingCount();
  await page.click("#start-race");
  await page.waitForFunction((count) => window.__pending.length === count + 1, n);
  await page.evaluate(() => window.__engines.race.stop("restart"));
  await page.click("#start-race");
  await page.waitForFunction((count) => window.__pending.length === count + 2, n);
  await page.evaluate((index) => window.__pending[index].release(), n + 1);
  await page.waitForFunction(() => window.__engines.race.status === "running", null, { timeout: 10_000 });
  await page.evaluate((index) => window.__pending[index].fail(new Error("late failure of the first start")), n);
  await page.waitForTimeout(300);
  const race = await page.evaluate(() => ({ status: window.__engines.race.status, statuses: window.__exitStatuses.race, state: window.__engines.race.contextState() }));
  record.live.delayedResume.race = race;
  ok(race.status === "running" && race.state === "running" && !race.statuses.includes("error"), "a stale start's late failure does not touch the newer running start (no error status)", JSON.stringify(race));
  await page.evaluate(() => window.__engines.race.stop("done"));
}

ok(issues.length === 0, "no page errors", issues.join("; "));
record.checks = checks;
if (process.env.SOUND_DSP_RECORD) writeFileSync(process.env.SOUND_DSP_RECORD, `${JSON.stringify(record, null, 1)}\n`);
else console.log(JSON.stringify(record, null, 1));
console.log(`sound dsp: ${checks} checks passed (offline buffers and live analysers in headless Chromium; no physical speaker was heard)`);
await browser.close();
