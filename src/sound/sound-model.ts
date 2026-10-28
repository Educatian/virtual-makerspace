/**
 * Sound Flow Studio (Episode 2): the pure domain model. From the room's canonical part state it
 * derives the patch graph (exactly as patched, wrong cables included), the signal along it and
 * the brief's five criteria. The Web Audio graph (sound-audio.ts), the 3D desk, the diagram, the
 * inspector, the Test outcome and project files all read this one state.
 *
 * An educational signal abstraction: band-limited periodic waveforms through an analog-prototype
 * Butterworth low-pass and an ideal hard clipper. Not SPICE, not an acoustic room model, and no
 * loudness (SPL/dBA). See docs/episodes.md, "Episode 2 · Sound Flow Studio".
 */
import {
  SOUND_CABLE_IDS,
  SOUND_DEFAULT_PROPS,
  SOUND_JACKS,
  SOUND_MODULE_IDS,
  SOUND_SPEAKER_DEFAULT_ON,
  sanitizeSoundProps,
  type SoundCableId,
  type SoundModuleId,
  type SoundWave,
} from "../../cloudflare/sound-rules.js";

export type { SoundCableId, SoundModuleId, SoundWave };
export { SOUND_CABLE_IDS, SOUND_JACKS, SOUND_MODULE_IDS };

export type JackEnds = [number | null, number | null];

export interface SoundPatchState {
  cables: Record<SoundCableId, JackEnds>;
  source: { hz: number; wave: SoundWave };
  filter: { cutoff: number };
  drive: { gain: number };
  speakerOn: boolean;
}

/** The Source's output level (FS peak) and the Drive's clip rails. */
export const SOURCE_PEAK = 0.5;
export const CLIP_LEVEL = 1;
/** The Speaker's fixed safety ceiling after its own hard clip (×0.25 = −12.04 dBFS). */
export const SPEAKER_CEILING = 0.25;
/** Web Audio's low-pass Q is in dB: −3.0103 dB is Q = 1/√2 (Butterworth). */
export const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);
/** Sample rate the model band-limits to (Web Audio contexts usually run at 44.1 or 48 kHz). */
export const MODEL_SAMPLE_RATE = 48_000;

export const MODULE_NAMES: Record<SoundModuleId, string> = {
  "snd-source": "Source",
  "snd-filter": "Filter",
  "snd-drive": "Drive",
  "snd-speaker": "Speaker",
};
export const CABLE_NAMES: Record<SoundCableId, string> = {
  "snd-cable-a": "Red cable",
  "snd-cable-b": "Yellow cable",
  "snd-cable-c": "Blue cable",
};

export function jackLabel(index: number): string {
  const jack = SOUND_JACKS[index];
  return jack ? `${MODULE_NAMES[jack.module]} ${jack.port.toUpperCase()}` : `jack ${index}`;
}

export function defaultSoundState(): SoundPatchState {
  return {
    cables: { "snd-cable-a": [null, null], "snd-cable-b": [null, null], "snd-cable-c": [null, null] },
    source: { ...SOUND_DEFAULT_PROPS["snd-source"] },
    filter: { ...SOUND_DEFAULT_PROPS["snd-filter"] },
    drive: { ...SOUND_DEFAULT_PROPS["snd-drive"] },
    speakerOn: SOUND_SPEAKER_DEFAULT_ON,
  };
}

interface PartLike {
  sockets?: [number | null, number | null] | null;
  props?: unknown;
  on?: boolean;
}

const jackOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < SOUND_JACKS.length ? value : null;

/** The patch state from the room's part transforms (values the room never set keep their defaults). */
export function soundStateFrom(parts: Record<string, PartLike | undefined>): SoundPatchState {
  const state = defaultSoundState();
  for (const id of SOUND_CABLE_IDS) {
    const sockets = parts[id]?.sockets;
    state.cables[id] = Array.isArray(sockets) ? [jackOrNull(sockets[0]), jackOrNull(sockets[1])] : [null, null];
  }
  const source = sanitizeSoundProps("source", parts["snd-source"]?.props);
  if (source?.hz !== undefined && source.wave) state.source = { hz: source.hz, wave: source.wave };
  const filter = sanitizeSoundProps("filter", parts["snd-filter"]?.props);
  if (filter?.cutoff !== undefined) state.filter = { cutoff: filter.cutoff };
  const drive = sanitizeSoundProps("drive", parts["snd-drive"]?.props);
  if (drive?.gain !== undefined) state.drive = { gain: drive.gain };
  const on = parts["snd-speaker"]?.on;
  if (typeof on === "boolean") state.speakerOn = on;
  return state;
}

// ── Patch graph ────────────────────────────────────────────────────────────────

export type EdgeStatus =
  /** OUT → IN carrying the Source's signal. */
  | "signal"
  /** OUT → IN, but nothing reaches the OUT side (its module has no input, or is silent). */
  | "idle"
  | "out-out"
  | "in-in"
  /** OUT → IN inside a feedback loop: unsupported, silenced. */
  | "loop"
  /** One of its plugs shares a jack with another plug: ignored. */
  | "shared-jack";

export interface PatchEdge {
  cable: SoundCableId;
  /** The cable's ends as plugged (end A, end B). */
  jacks: [number, number];
  status: EdgeStatus;
  /** For OUT → IN cables: the OUT jack and the IN jack. */
  from?: number;
  to?: number;
}

export type FaultCode =
  | "loose-end"
  | "out-out"
  | "in-in"
  | "loop"
  | "shared-jack"
  | "unpatched-input"
  | "open-output"
  | "no-signal-in"
  | "speaker-off";

export interface Fault {
  code: FaultCode;
  cable?: SoundCableId;
  module?: SoundModuleId;
  jack?: number;
  modules?: SoundModuleId[];
  cables?: SoundCableId[];
}

export interface SoundGraph {
  edges: PatchEdge[];
  /** Cables with exactly one end in a jack. */
  loose: Array<{ cable: SoundCableId; jack: number }>;
  /** Cables with no end in a jack. */
  free: SoundCableId[];
  sharedJacks: number[];
  /** Each feedback loop's modules (strongly connected, or a module patched to itself). */
  loops: SoundModuleId[][];
  /** Whether each module's OUT carries the Source's signal (the Speaker: whether it receives it). */
  live: Record<SoundModuleId, boolean>;
  /** The module feeding each module's IN through a valid cable, if any. */
  upstream: Record<SoundModuleId, SoundModuleId | null>;
  /** Source → … along valid cables, ending at the Speaker, an open output or a loop. */
  chain: SoundModuleId[];
  reachesSpeaker: boolean;
  faults: Fault[];
}

const moduleOf = (jack: number): SoundModuleId => SOUND_JACKS[jack].module;
const portOf = (jack: number): "in" | "out" => SOUND_JACKS[jack].port;

/** The patch graph exactly as patched. Never repairs or reorders a cable. */
export function derivePatchGraph(state: SoundPatchState): SoundGraph {
  const plugs = new Map<number, SoundCableId[]>();
  for (const cable of SOUND_CABLE_IDS) {
    for (const jack of state.cables[cable]) {
      if (jack === null) continue;
      plugs.set(jack, [...(plugs.get(jack) ?? []), cable]);
    }
  }
  const sharedJacks = [...plugs.entries()].filter(([, cables]) => cables.length > 1).map(([jack]) => jack).sort((a, b) => a - b);
  const shared = new Set(sharedJacks);

  const edges: PatchEdge[] = [];
  const loose: SoundGraph["loose"] = [];
  const free: SoundCableId[] = [];
  for (const cable of SOUND_CABLE_IDS) {
    const [a, b] = state.cables[cable];
    if (a === null && b === null) {
      free.push(cable);
      continue;
    }
    if (a === null || b === null) {
      loose.push({ cable, jack: (a ?? b) as number });
      continue;
    }
    const edge: PatchEdge = { cable, jacks: [a, b], status: "idle" };
    if (shared.has(a) || shared.has(b)) edge.status = "shared-jack";
    else if (portOf(a) === "out" && portOf(b) === "out") edge.status = "out-out";
    else if (portOf(a) === "in" && portOf(b) === "in") edge.status = "in-in";
    else {
      edge.from = portOf(a) === "out" ? a : b;
      edge.to = portOf(a) === "out" ? b : a;
    }
    edges.push(edge);
  }

  // Directed module graph from the valid OUT → IN cables.
  const directed = edges.filter((edge) => edge.from !== undefined && edge.to !== undefined);
  const next = new Map<SoundModuleId, SoundModuleId[]>();
  for (const edge of directed) {
    const from = moduleOf(edge.from!);
    next.set(from, [...(next.get(from) ?? []), moduleOf(edge.to!)]);
  }
  const loops = stronglyConnectedLoops(next);
  const inLoop = new Set(loops.flat());
  for (const edge of directed) {
    if (inLoop.has(moduleOf(edge.from!)) && inLoop.has(moduleOf(edge.to!)) && sameLoop(loops, moduleOf(edge.from!), moduleOf(edge.to!))) edge.status = "loop";
  }

  const upstream = Object.fromEntries(SOUND_MODULE_IDS.map((id) => [id, null])) as Record<SoundModuleId, SoundModuleId | null>;
  for (const edge of directed) {
    if (edge.status === "loop") continue;
    upstream[moduleOf(edge.to!)] = moduleOf(edge.from!);
  }

  // Signal: from the Source along valid cables; a module in a loop is silenced.
  const live = Object.fromEntries(SOUND_MODULE_IDS.map((id) => [id, false])) as Record<SoundModuleId, boolean>;
  live["snd-source"] = !inLoop.has("snd-source");
  for (let pass = 0; pass < SOUND_MODULE_IDS.length; pass += 1) {
    for (const id of SOUND_MODULE_IDS) {
      const from = upstream[id];
      if (id !== "snd-source" && from && live[from] && !inLoop.has(id)) live[id] = true;
    }
  }
  for (const edge of directed) {
    if (edge.status === "loop") continue;
    edge.status = live[moduleOf(edge.from!)] ? "signal" : "idle";
  }

  const chain: SoundModuleId[] = [];
  if (live["snd-source"]) {
    let current: SoundModuleId | null = "snd-source";
    while (current && !chain.includes(current)) {
      chain.push(current);
      const out = SOUND_JACKS.find((jack) => jack.module === current && jack.port === "out");
      const edge = out ? directed.find((candidate) => candidate.from === out.index && candidate.status === "signal") : undefined;
      current = edge ? moduleOf(edge.to!) : null;
    }
  }
  const reachesSpeaker = chain[chain.length - 1] === "snd-speaker";

  const faults: Fault[] = [];
  for (const { cable, jack } of loose) faults.push({ code: "loose-end", cable, jack });
  for (const edge of edges) {
    if (edge.status === "out-out" || edge.status === "in-in") faults.push({ code: edge.status, cable: edge.cable });
  }
  for (const loop of loops) faults.push({ code: "loop", modules: loop, cables: directed.filter((edge) => edge.status === "loop" && loop.includes(moduleOf(edge.from!))).map((edge) => edge.cable) });
  for (const jack of sharedJacks) faults.push({ code: "shared-jack", jack, cables: plugs.get(jack) });
  for (const jack of SOUND_JACKS) {
    if (jack.port !== "in") continue;
    if (!plugs.has(jack.index)) faults.push({ code: "unpatched-input", module: jack.module, jack: jack.index });
    else if (upstream[jack.module] && !live[jack.module] && !inLoop.has(jack.module)) faults.push({ code: "no-signal-in", module: jack.module, jack: jack.index });
  }
  // A live OUT with nothing plugged in: the signal stops there. (A plug of a loose, OUT→OUT or
  // shared-jack cable is reported as that fault instead.)
  for (const jack of SOUND_JACKS) {
    if (jack.port === "out" && live[jack.module] && !plugs.has(jack.index)) faults.push({ code: "open-output", module: jack.module, jack: jack.index });
  }
  if (!state.speakerOn) faults.push({ code: "speaker-off", module: "snd-speaker" });
  return { edges, loose, free, sharedJacks, loops, live, upstream, chain, reachesSpeaker, faults };
}

function sameLoop(loops: SoundModuleId[][], a: SoundModuleId, b: SoundModuleId): boolean {
  return loops.some((loop) => loop.includes(a) && loop.includes(b));
}

/** Tarjan's strongly connected components; returns those that contain a cycle. */
function stronglyConnectedLoops(next: Map<SoundModuleId, SoundModuleId[]>): SoundModuleId[][] {
  let counter = 0;
  const index = new Map<SoundModuleId, number>();
  const low = new Map<SoundModuleId, number>();
  const stack: SoundModuleId[] = [];
  const onStack = new Set<SoundModuleId>();
  const loops: SoundModuleId[][] = [];
  const visit = (node: SoundModuleId): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of next.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (onStack.has(target)) low.set(node, Math.min(low.get(node)!, index.get(target)!));
    }
    if (low.get(node) === index.get(node)) {
      const component: SoundModuleId[] = [];
      let member: SoundModuleId;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      const selfLoop = component.length === 1 && (next.get(node) ?? []).includes(node);
      if (component.length > 1 || selfLoop) loops.push(component.sort((a, b) => SOUND_MODULE_IDS.indexOf(a) - SOUND_MODULE_IDS.indexOf(b)));
    }
  };
  for (const node of SOUND_MODULE_IDS) if (!index.has(node)) visit(node);
  return loops;
}

// ── Signal along the chain ────────────────────────────────────────────────────

/** Samples per period of the model's periodic signal (harmonics up to M/2 − 1). */
export const PERIOD_SAMPLES = 1024;
export const HARMONICS_REPORTED = 8;

export interface StageReading {
  module: SoundModuleId;
  /** Output peak, |x| max, in FS (1.0 = 0 dBFS). */
  peak: number;
  rms: number;
  /** Amplitudes (FS) of harmonics 1..HARMONICS_REPORTED at this module's output. */
  harmonics: number[];
  /** Drive only: fraction of the period where input × gain exceeded ±1.0 FS and was clipped. */
  clipped: number;
}

export interface SignalAnalysis {
  /** Readings at each live module's output, in chain order (the Speaker: what it receives). */
  stages: StageReading[];
  /** What the Speaker receives (before its switch), or null when no signal reaches it. */
  speakerIn: StageReading | null;
  /** Peak the Speaker sends to this client's volume control (after its switch, clip and ceiling). */
  speakerOutPeak: number;
  /** One period at the Speaker input (or at the last live stage when it does not reach it). */
  period: Float64Array;
  fundamentalHz: number;
  clipping: boolean;
}

/** Fourier sine coefficients of a band-limited waveform (before peak normalization). */
export function waveCoefficients(wave: SoundWave, hz: number, sampleRate = MODEL_SAMPLE_RATE, maxHarmonic = PERIOD_SAMPLES / 2 - 1): number[] {
  const top = Math.max(1, Math.min(maxHarmonic, Math.floor((sampleRate / 2 - 1e-9) / hz)));
  const b: number[] = new Array(top + 1).fill(0);
  if (wave === "sine") b[1] = 1;
  for (let n = 1; n <= top && wave !== "sine"; n += 1) {
    if (wave === "square") b[n] = n % 2 === 1 ? 4 / (Math.PI * n) : 0;
    else b[n] = (2 / (Math.PI * n)) * (n % 2 === 1 ? 1 : -1);
  }
  return b;
}

/**
 * Web Audio scales its built-in square and sawtooth so that the full-band waveform peaks at 1.0:
 * the coefficients are divided by the Gibbs overshoot (2/π)·Si(π) ≈ 1.17898. A band-limited
 * waveform at a higher pitch has fewer harmonics and so peaks a little below 1.0 (measured in
 * Chromium by scripts/sound-dsp-check.mjs; the fundamental's amplitude does not change with pitch).
 */
export const GIBBS_PEAK = 1.1789797444721672;

/** One period of the Source's output: band-limited, scaled as Web Audio scales it, ×SOURCE_PEAK. */
export function sourcePeriod(wave: SoundWave, hz: number, sampleRate = MODEL_SAMPLE_RATE): Float64Array {
  const b = waveCoefficients(wave, hz, sampleRate);
  const x = new Float64Array(PERIOD_SAMPLES);
  const scale = (wave === "sine" ? 1 : 1 / GIBBS_PEAK) * SOURCE_PEAK;
  for (let i = 0; i < PERIOD_SAMPLES; i += 1) {
    const phase = (2 * Math.PI * i) / PERIOD_SAMPLES;
    let sum = 0;
    for (let n = 1; n < b.length; n += 1) if (b[n] !== 0) sum += b[n] * Math.sin(n * phase);
    x[i] = sum * scale;
  }
  return x;
}


/** Analog 2nd-order Butterworth low-pass response at `hz` (complex), cutoff `fc`. */
export function butterworth(hz: number, fc: number): { re: number; im: number } {
  const w = hz / fc;
  const re = 1 - w * w;
  const im = Math.SQRT2 * w;
  const denominator = re * re + im * im;
  return { re: re / denominator, im: -im / denominator };
}

export function butterworthDb(hz: number, fc: number): number {
  return -10 * Math.log10(1 + (hz / fc) ** 4);
}

function filterPeriod(x: Float64Array, hz: number, cutoff: number, sampleRate: number): Float64Array {
  const re = Float64Array.from(x);
  const im = new Float64Array(x.length);
  fft(re, im, false);
  const half = x.length / 2;
  re[0] = 0;
  im[0] = 0;
  for (let k = 1; k < x.length; k += 1) {
    const n = k <= half ? k : x.length - k;
    if (n >= half || n * hz >= sampleRate / 2) {
      re[k] = 0;
      im[k] = 0;
      continue;
    }
    const h = butterworth(n * hz, cutoff);
    // Negative-frequency bins take the conjugate response, so the result stays real.
    const hIm = k <= half ? h.im : -h.im;
    const r = re[k] * h.re - im[k] * hIm;
    const i = re[k] * hIm + im[k] * h.re;
    re[k] = r;
    im[k] = i;
  }
  fft(re, im, true);
  return re;
}

function bandLimit(x: Float64Array, hz: number, sampleRate: number): Float64Array {
  const re = Float64Array.from(x);
  const im = new Float64Array(x.length);
  fft(re, im, false);
  const half = x.length / 2;
  for (let k = 1; k < x.length; k += 1) {
    const n = k <= half ? k : x.length - k;
    if (n >= half || n * hz >= sampleRate / 2) {
      re[k] = 0;
      im[k] = 0;
    }
  }
  fft(re, im, true);
  return re;
}

export function harmonicAmplitudes(x: Float64Array, count = HARMONICS_REPORTED): number[] {
  const re = Float64Array.from(x);
  const im = new Float64Array(x.length);
  fft(re, im, false);
  const out: number[] = [];
  for (let n = 1; n <= count; n += 1) out.push((2 * Math.hypot(re[n], im[n])) / x.length);
  return out;
}

/**
 * The peak of a band-limited periodic signal between its samples too: the period's spectrum
 * zero-padded ×8 and transformed back (band-limited edges peak between grid points).
 */
export function truePeak(x: Float64Array, factor = 8): number {
  const re = Float64Array.from(x);
  const im = new Float64Array(x.length);
  fft(re, im, false);
  const size = x.length * factor;
  const upRe = new Float64Array(size);
  const upIm = new Float64Array(size);
  const half = x.length / 2;
  for (let k = 0; k < half; k += 1) {
    upRe[k] = re[k] * factor;
    upIm[k] = im[k] * factor;
    if (k > 0) {
      upRe[size - k] = re[x.length - k] * factor;
      upIm[size - k] = im[x.length - k] * factor;
    }
  }
  fft(upRe, upIm, true);
  return Math.max(maxAbs(upRe), maxAbs(x));
}

function reading(module: SoundModuleId, x: Float64Array, clipped = 0): StageReading {
  let squares = 0;
  for (const value of x) squares += value * value;
  return { module, peak: truePeak(x), rms: Math.sqrt(squares / x.length), harmonics: harmonicAmplitudes(x), clipped };
}

/**
 * The signal along the live chain. Each stage processes one period: the Filter in the frequency
 * domain (analog Butterworth, magnitude and phase), the Drive in the time domain (gain, then a
 * hard clip at ±1.0 FS, band-limited again as an ideal anti-aliased clipper would be). The
 * Speaker's own switch, clip and ceiling only shape what it sends on (`speakerOutPeak`).
 */
export function analyzeSignal(state: SoundPatchState, graph = derivePatchGraph(state), sampleRate = MODEL_SAMPLE_RATE): SignalAnalysis {
  const hz = state.source.hz;
  const stages: StageReading[] = [];
  let x: Float64Array = new Float64Array(PERIOD_SAMPLES);
  let clipping = false;
  for (const module of graph.chain) {
    if (module === "snd-source") {
      x = sourcePeriod(state.source.wave, hz, sampleRate);
      stages.push(reading(module, x));
    } else if (module === "snd-filter") {
      x = filterPeriod(x, hz, state.filter.cutoff, sampleRate);
      stages.push(reading(module, x));
    } else if (module === "snd-drive") {
      const gain = state.drive.gain;
      let over = 0;
      const y = new Float64Array(x.length);
      for (let i = 0; i < x.length; i += 1) {
        const v = x[i] * gain;
        if (Math.abs(v) > CLIP_LEVEL + 1e-9) over += 1;
        y[i] = Math.max(-CLIP_LEVEL, Math.min(CLIP_LEVEL, v));
      }
      if (over > 0) clipping = true;
      x = over > 0 ? bandLimit(y, hz, sampleRate) : y;
      stages.push(reading(module, x, over / x.length));
    } else if (module === "snd-speaker") {
      stages.push(reading(module, x));
    }
  }
  const speakerIn = graph.reachesSpeaker ? stages[stages.length - 1] : null;
  const speakerOutPeak = speakerIn && state.speakerOn ? Math.min(CLIP_LEVEL, speakerIn.peak) * SPEAKER_CEILING : 0;
  return { stages, speakerIn, speakerOutPeak, period: x, fundamentalHz: hz, clipping };
}

// ── The brief ─────────────────────────────────────────────────────────────────

export const BRIEF = {
  id: "dark-alarm",
  title: "Dark alarm tone",
  wave: "sawtooth" as SoundWave,
  hz: 220,
  /** C3: the 3rd harmonic at least this far below the fundamental at the Speaker input. */
  darkDb: 18,
  /** C5: Speaker-input peak range, dBFS. */
  levelDb: { min: -12, max: -3 },
};

export type CriterionId = "C1" | "C2" | "C3" | "C4" | "C5";

export interface CriterionResult {
  id: CriterionId;
  label: string;
  pass: boolean;
  /** The measured value, in words (shown after a Test). */
  measured: string;
}

export interface BriefOutcome {
  met: boolean;
  criteria: CriterionResult[];
}

export const CRITERION_LABELS: Record<CriterionId, string> = {
  C1: "Path: Source → Filter and Drive (either order) → Speaker, OUT to IN, nothing loose, no loop, Speaker on",
  C2: `Tone: the Source plays a sawtooth at ${BRIEF.hz} Hz`,
  C3: `Dark: at the Speaker input, ${BRIEF.hz * 3} Hz is at least ${BRIEF.darkDb} dB below ${BRIEF.hz} Hz`,
  C4: "Clean: nothing clips (Drive input × gain stays within ±1.0 FS)",
  C5: `Level: the Speaker input peaks between ${BRIEF.levelDb.min} and ${BRIEF.levelDb.max} dBFS`,
};

const BLOCKING_FAULTS: FaultCode[] = ["loose-end", "out-out", "in-in", "loop", "shared-jack"];

export function evaluateBrief(state: SoundPatchState, graph = derivePatchGraph(state), signal = analyzeSignal(state, graph)): BriefOutcome {
  const chain = graph.chain.join(">");
  const orderOk = chain === "snd-source>snd-filter>snd-drive>snd-speaker" || chain === "snd-source>snd-drive>snd-filter>snd-speaker";
  const blocking = graph.faults.filter((fault) => BLOCKING_FAULTS.includes(fault.code));
  const pathWords = !graph.reachesSpeaker
    ? `no signal reaches the Speaker (the path is ${graph.chain.map((id) => MODULE_NAMES[id]).join(" → ") || "empty"})`
    : `${graph.chain.map((id) => MODULE_NAMES[id]).join(" → ")}`;
  const c1Problems = [
    ...(orderOk ? [] : [graph.reachesSpeaker ? "it skips a module" : ""]).filter(Boolean),
    ...blocking.map((fault) => FAULT_SHORT[fault.code]),
    ...(state.speakerOn ? [] : ["the Speaker is switched off"]),
  ];
  const c1: CriterionResult = { id: "C1", label: CRITERION_LABELS.C1, pass: orderOk && !blocking.length && state.speakerOn, measured: `${pathWords}${c1Problems.length ? ` · ${[...new Set(c1Problems)].join(", ")}` : ""}` };
  const c2: CriterionResult = { id: "C2", label: CRITERION_LABELS.C2, pass: state.source.wave === BRIEF.wave && state.source.hz === BRIEF.hz, measured: `${state.source.wave} at ${state.source.hz} Hz` };
  const at = signal.speakerIn;
  let c3: CriterionResult;
  let c5: CriterionResult;
  if (!at || at.peak < 1e-6) {
    c3 = { id: "C3", label: CRITERION_LABELS.C3, pass: false, measured: "no signal at the Speaker input" };
    c5 = { id: "C5", label: CRITERION_LABELS.C5, pass: false, measured: "no signal at the Speaker input" };
  } else {
    const [h1, , h3] = at.harmonics;
    const below = h3 < 1e-9 ? Infinity : 20 * Math.log10(h1 / h3);
    c3 = { id: "C3", label: CRITERION_LABELS.C3, pass: h1 > 1e-6 && below >= BRIEF.darkDb, measured: Number.isFinite(below) ? `${(state.source.hz * 3).toFixed(0)} Hz is ${below.toFixed(1)} dB below ${state.source.hz} Hz` : `no ${state.source.hz * 3} Hz component` };
    const db = toDb(at.peak);
    c5 = { id: "C5", label: CRITERION_LABELS.C5, pass: db >= BRIEF.levelDb.min && db <= BRIEF.levelDb.max, measured: `peak ${formatDb(db)}` };
  }
  const drive = signal.stages.find((stage) => stage.module === "snd-drive");
  const c4: CriterionResult = { id: "C4", label: CRITERION_LABELS.C4, pass: !signal.clipping, measured: !drive ? "the Drive is not in the path" : drive.clipped > 0 ? `the Drive clips ${(drive.clipped * 100).toFixed(1)} % of each cycle` : "no clipping" };
  const criteria = [c1, c2, c3, c4, c5];
  // C4 also requires the Drive in the path (C1), so a path without it cannot pass as "clean".
  if (!drive) c4.pass = false;
  return { met: criteria.every((criterion) => criterion.pass), criteria };
}

/** DI only: a worked example computed by this same model (not hand-typed numbers). */
export function workedExample(): { cutoff: number; gain: number; h1Db: number; h3Db: number; belowDb: number; peakAtUnityDb: number; peakDb: number } {
  const cutoff = 300;
  const base = defaultSoundState();
  base.source = { hz: BRIEF.hz, wave: BRIEF.wave };
  base.filter = { cutoff };
  base.cables = { "snd-cable-a": [0, 1], "snd-cable-b": [2, 3], "snd-cable-c": [4, 5] };
  base.drive = { gain: 1 };
  const unity = analyzeSignal(base).speakerIn!;
  const gain = Math.round((10 ** (-6 / 20) / unity.peak) * 100) / 100;
  base.drive = { gain };
  const tuned = analyzeSignal(base).speakerIn!;
  return {
    cutoff,
    gain,
    h1Db: butterworthDb(BRIEF.hz, cutoff),
    h3Db: butterworthDb(BRIEF.hz * 3, cutoff),
    belowDb: 20 * Math.log10(tuned.harmonics[0] / tuned.harmonics[2]),
    peakAtUnityDb: toDb(unity.peak),
    peakDb: toDb(tuned.peak),
  };
}

// ── Words ─────────────────────────────────────────────────────────────────────

const FAULT_SHORT: Record<FaultCode, string> = {
  "loose-end": "a cable end is loose",
  "out-out": "a cable joins two outputs",
  "in-in": "a cable joins two inputs",
  loop: "a feedback loop",
  "shared-jack": "two plugs share a jack",
  "unpatched-input": "an input is unpatched",
  "open-output": "a signal stops at an open output",
  "no-signal-in": "an input receives no signal",
  "speaker-off": "the Speaker is switched off",
};

/** A factual sentence for a fault (shown per the PF/DI rule; safety facts always). */
export function describeFault(fault: Fault): string {
  const cable = fault.cable ? CABLE_NAMES[fault.cable] : "";
  switch (fault.code) {
    case "loose-end":
      return `${cable} is plugged into ${jackLabel(fault.jack!)} only; its other end is free, so it carries nothing.`;
    case "out-out":
      return `${cable} joins two outputs. An output only sends; nothing receives this signal.`;
    case "in-in":
      return `${cable} joins two inputs. Nothing sends into either of them.`;
    case "loop":
      return `Feedback loop: ${fault.modules!.map((id) => MODULE_NAMES[id]).join(" → ")} → ${MODULE_NAMES[fault.modules![0]]}. Feedback is not supported here, so the loop is silenced.`;
    case "shared-jack":
      return `Two plugs in ${jackLabel(fault.jack!)}: not supported, both are ignored.`;
    case "unpatched-input":
      return `${jackLabel(fault.jack!)} is unpatched, so the ${MODULE_NAMES[fault.module!]} is silent.`;
    case "open-output":
      return `The ${MODULE_NAMES[fault.module!]} has signal at its OUT, but nothing is patched there: the signal stops.`;
    case "no-signal-in":
      return `${jackLabel(fault.jack!)} is patched, but no signal from the Source reaches it.`;
    case "speaker-off":
      return "The Speaker is switched off (shared). The patch itself is not broken.";
  }
}

/** Safety facts: always shown, in both conditions. */
export function isSafetyFault(fault: Fault): boolean {
  return fault.code === "loop" || fault.code === "shared-jack" || fault.code === "speaker-off";
}

export function toDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return "silent (−∞ dBFS)";
  return `${db >= 0 ? "+" : "−"}${Math.abs(db).toFixed(1)} dBFS`;
}

export function formatGain(gain: number): string {
  const db = toDb(gain);
  return `×${gain.toFixed(2)} (${Number.isFinite(db) ? `${db >= 0 ? "+" : "−"}${Math.abs(db).toFixed(1)} dB` : "−∞ dB"})`;
}

export function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 2)} kHz` : `${Math.round(hz)} Hz`;
}

function maxAbs(x: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < x.length; i += 1) peak = Math.max(peak, Math.abs(x[i]));
  return peak;
}

/** In-place iterative radix-2 FFT (inverse scales by 1/N). */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let uRe = 1;
      let uIm = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tRe = re[b] * uRe - im[b] * uIm;
        const tIm = re[b] * uIm + im[b] * uRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const next = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = next;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i += 1) {
    re[i] /= n;
    im[i] /= n;
  }
}
