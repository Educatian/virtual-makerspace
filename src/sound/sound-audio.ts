/**
 * Sound Flow Studio (Episode 2): the Web Audio graph, built from the patch model's chain, for
 * live listening (SoundEngine) and for offline rendering (renderOffline). One builder serves
 * both, so what the display shows and what a listener hears come from the same graph.
 *
 * Safety (docs/episodes.md, "Audio safety"):
 * - A live AudioContext is created and resumed only inside `SoundEngine.start()`, which the UI
 *   calls only from a click or key press, and which refuses when the browser reports no active
 *   user activation. Nothing else (a teammate's edit, an import, a reconnect) can start, resume
 *   or make louder this listener's audio: `apply()` only rebuilds the graph of a running engine.
 * - Mute and volume are local. Volume is capped at 100 % of a fixed −12.04 dBFS ceiling that
 *   follows a hard clip, so the digital output never exceeds 0.25 FS.
 * - `stop()` stops oscillators, disconnects every node, removes listeners and closes the context.
 * - Feedback loops are never connected (the model silences them before this builder sees them).
 */
import {
  BUTTERWORTH_Q_DB,
  CLIP_LEVEL,
  derivePatchGraph,
  SOURCE_PEAK,
  SPEAKER_CEILING,
  type SoundModuleId,
  type SoundPatchState,
} from "./sound-model.ts";

/** Local volume default and range (a fraction of the fixed ceiling). */
export const DEFAULT_VOLUME = 0.5;
export const MAX_VOLUME = 1;
export const MUTE_RAMP_S = 0.01;

const clipCurve = (): Float32Array<ArrayBuffer> => {
  // Identity between −1 and +1; Web Audio holds the ends for inputs beyond them: a hard clip.
  const curve = new Float32Array(new ArrayBuffer(2 * 4));
  curve[0] = -CLIP_LEVEL;
  curve[1] = CLIP_LEVEL;
  return curve;
};

export interface BuiltGraph {
  /** Topology key: rebuilt when it changes, parameters glide otherwise. */
  key: string;
  /** What the Speaker receives (before its switch). */
  speakerIn: GainNode;
  /** The Speaker's output (after switch, clip and ceiling). */
  speakerOut: GainNode;
  oscillator: OscillatorNode | null;
  filter: BiquadFilterNode | null;
  drive: GainNode | null;
  speakerSwitch: GainNode;
  nodes: AudioNode[];
}

export function topologyKey(state: SoundPatchState): string {
  const graph = derivePatchGraph(state);
  return `${graph.reachesSpeaker ? graph.chain.join(">") : "open"}|${state.source.wave}`;
}

/**
 * The graph for `state`: only the modules on the live chain from the Source are created and
 * connected, in the order the cables put them. A chain that does not reach the Speaker leaves
 * its input unconnected (silence). Nothing in a loop is ever connected.
 */
export function buildSoundGraph(context: BaseAudioContext, state: SoundPatchState, startAt = 0): BuiltGraph {
  const graph = derivePatchGraph(state);
  const nodes: AudioNode[] = [];
  const speakerIn = new GainNode(context, { gain: 1 });
  const speakerSwitch = new GainNode(context, { gain: state.speakerOn ? 1 : 0 });
  const speakerClip = new WaveShaperNode(context, { curve: clipCurve(), oversample: "none" });
  const speakerOut = new GainNode(context, { gain: SPEAKER_CEILING });
  speakerIn.connect(speakerSwitch).connect(speakerClip).connect(speakerOut);
  nodes.push(speakerIn, speakerSwitch, speakerClip, speakerOut);
  let oscillator: OscillatorNode | null = null;
  let filter: BiquadFilterNode | null = null;
  let drive: GainNode | null = null;
  if (graph.reachesSpeaker) {
    let last: AudioNode | null = null;
    for (const module of graph.chain as SoundModuleId[]) {
      if (module === "snd-source") {
        oscillator = new OscillatorNode(context, { type: state.source.wave, frequency: state.source.hz });
        const level = new GainNode(context, { gain: SOURCE_PEAK });
        oscillator.connect(level);
        nodes.push(oscillator, level);
        last = level;
      } else if (module === "snd-filter") {
        filter = new BiquadFilterNode(context, { type: "lowpass", frequency: state.filter.cutoff, Q: BUTTERWORTH_Q_DB });
        last!.connect(filter);
        nodes.push(filter);
        last = filter;
      } else if (module === "snd-drive") {
        drive = new GainNode(context, { gain: state.drive.gain });
        const clip = new WaveShaperNode(context, { curve: clipCurve(), oversample: "none" });
        last!.connect(drive).connect(clip);
        nodes.push(drive, clip);
        last = clip;
      } else if (module === "snd-speaker") {
        last!.connect(speakerIn);
      }
    }
    oscillator?.start(startAt);
  }
  return { key: topologyKey(state), speakerIn, speakerOut, oscillator, filter, drive, speakerSwitch, nodes };
}

/** Parameter changes on an unchanged topology: short glides (no zipper noise). */
export function updateParameters(graph: BuiltGraph, state: SoundPatchState, now: number): void {
  const glide = (param: AudioParam, value: number): void => {
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, 0.012);
  };
  if (graph.oscillator) glide(graph.oscillator.frequency, state.source.hz);
  if (graph.filter) glide(graph.filter.frequency, state.filter.cutoff);
  if (graph.drive) glide(graph.drive.gain, state.drive.gain);
  glide(graph.speakerSwitch.gain, state.speakerOn ? 1 : 0);
}

export function disposeGraph(graph: BuiltGraph): void {
  try {
    graph.oscillator?.stop();
  } catch {
    // Never started or already stopped.
  }
  for (const node of graph.nodes) node.disconnect();
}

// ── Offline rendering (the signal display and the DSP tests) ──────────────────────

export interface OfflineRender {
  sampleRate: number;
  /** Channel 0: what the Speaker receives. */
  speakerIn: Float32Array;
  /** Channel 1: what the Speaker sends on (before any listener's volume or mute). */
  speakerOut: Float32Array;
}

/**
 * Renders `seconds` of the patch with an OfflineAudioContext (no sound output, no user gesture).
 * Numbers from it describe the digital signal only, never a physical speaker.
 */
export async function renderOffline(state: SoundPatchState, seconds = 0.25, sampleRate = 48_000): Promise<OfflineRender> {
  const length = Math.round(seconds * sampleRate);
  const context = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const graph = buildSoundGraph(context, state, 0);
  const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
  graph.speakerIn.connect(merger, 0, 0);
  graph.speakerOut.connect(merger, 0, 1);
  merger.connect(context.destination);
  const buffer = await context.startRendering();
  disposeGraph(graph);
  return { sampleRate, speakerIn: buffer.getChannelData(0).slice(), speakerOut: buffer.getChannelData(1).slice() };
}

export interface Measurement {
  peak: number;
  rms: number;
  /** Amplitudes of harmonics 1..count of `f0` (Hann-windowed Goertzel over whole cycles). */
  harmonics: number[];
}

/** Measures a rendered signal after `skipSeconds` (oscillator start and filter settling). */
export function measure(samples: Float32Array, sampleRate: number, f0: number, count = 8, skipSeconds = 0.05): Measurement {
  const start = Math.min(samples.length - 1, Math.round(skipSeconds * sampleRate));
  const cycles = Math.max(1, Math.floor(((samples.length - start) * f0) / sampleRate));
  const length = Math.min(samples.length - start, Math.round((cycles * sampleRate) / f0));
  let peak = 0;
  let squares = 0;
  for (let i = start; i < start + length; i += 1) {
    peak = Math.max(peak, Math.abs(samples[i]));
    squares += samples[i] * samples[i];
  }
  const harmonics: number[] = [];
  let windowSum = 0;
  for (let i = 0; i < length; i += 1) windowSum += 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
  for (let n = 1; n <= count; n += 1) {
    const w = (2 * Math.PI * n * f0) / sampleRate;
    if (n * f0 >= sampleRate / 2) {
      harmonics.push(0);
      continue;
    }
    let re = 0;
    let im = 0;
    for (let i = 0; i < length; i += 1) {
      const windowed = samples[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1)));
      re += windowed * Math.cos(w * i);
      im -= windowed * Math.sin(w * i);
    }
    harmonics.push((2 * Math.hypot(re, im)) / windowSum);
  }
  return { peak, rms: Math.sqrt(squares / Math.max(1, length)), harmonics };
}

// ── Live listening ────────────────────────────────────────────────────────────────

export type AudioStatus = "off" | "running" | "suspended" | "needs-gesture" | "unsupported" | "error";

/**
 * Leaving the studio or the room, or losing the connection: stop unconditionally. A click may
 * have created the AudioContext while its resume has not settled (status still "off"); that
 * context is closed too, so a late resume can never start audio afterwards. The reason is only
 * reported when there was something to stop. Returns whether there was.
 */
export function stopEngineForExit(engine: SoundEngine, reason: string): boolean {
  const active = engine.active;
  engine.stop(active ? reason : "");
  return active;
}

/**
 * One listener's audio. Created stopped; `start()` from a click/key handler creates the
 * AudioContext. `apply()` follows the room's patch while running and never starts anything.
 */
export class SoundEngine {
  private context: AudioContext | null = null;
  private graph: BuiltGraph | null = null;
  private fade: GainNode | null = null;
  private volumeNode: GainNode | null = null;
  private muteNode: GainNode | null = null;
  private speakerTap: AnalyserNode | null = null;
  private outputTap: AnalyserNode | null = null;
  private tapBuffer = new Float32Array(new ArrayBuffer(2048 * 4));
  private state: SoundPatchState | null = null;
  private muted = false;
  private volume = DEFAULT_VOLUME;
  private retired: Array<{ graph: BuiltGraph; fade: GainNode; timer: number }> = [];
  status: AudioStatus = "off";
  /** How many AudioContexts this engine has created (tests: none before a gesture). */
  contextsCreated = 0;

  constructor(private readonly onStatus: (status: AudioStatus, detail?: string) => void = () => undefined) {}

  get running(): boolean {
    return this.status === "running";
  }

  /**
   * Whether anything exists that `stop()` must release: an AudioContext (running, suspended, or
   * created by a click whose resume has not settled yet, while the status still says "off").
   */
  get active(): boolean {
    return this.context !== null || this.status !== "off";
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get volumeLevel(): number {
    return this.volume;
  }

  /**
   * Starts (or resumes) audio. Call only from a click or key handler: it creates and resumes the
   * AudioContext synchronously, inside the gesture, and refuses when the browser says there is
   * no active user activation.
   */
  start(): Promise<boolean> {
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (activation && !activation.isActive) {
      this.setStatus("needs-gesture", "Audio starts only from your own click or key press.");
      return Promise.resolve(false);
    }
    const Constructor = window.AudioContext;
    if (!Constructor) {
      this.setStatus("unsupported", "This browser has no Web Audio.");
      return Promise.resolve(false);
    }
    try {
      if (!this.context) {
        this.context = new Constructor({ latencyHint: "interactive" });
        this.contextsCreated += 1;
        this.context.addEventListener("statechange", this.onContextState);
        this.volumeNode = new GainNode(this.context, { gain: this.volume });
        this.muteNode = new GainNode(this.context, { gain: this.muted ? 0 : 1 });
        this.outputTap = new AnalyserNode(this.context, { fftSize: 2048 });
        this.speakerTap = new AnalyserNode(this.context, { fftSize: 2048 });
        this.volumeNode.connect(this.muteNode).connect(this.outputTap).connect(this.context.destination);
        if (this.state) this.rebuild(this.state);
      }
      const context = this.context;
      // The resume can settle after a stop (or a later start): only the context it was called
      // on may report, success or failure, so an old start never touches a newer one.
      return context.resume().then(() => {
        if (this.context !== context) return false;
        this.setStatus(context.state === "running" ? "running" : "suspended");
        return context.state === "running";
      }, (error: unknown) => {
        if (this.context !== context) return false;
        this.setStatus("error", String((error as Error)?.message ?? error));
        return false;
      });
    } catch (error) {
      this.setStatus("error", String((error as Error)?.message ?? error));
      return Promise.resolve(false);
    }
  }

  /** Stops audio and releases everything (leave, studio switch, disconnect, or the Stop button). */
  stop(reason = ""): void {
    for (const entry of this.retired) {
      window.clearTimeout(entry.timer);
      disposeGraph(entry.graph);
      entry.fade.disconnect();
    }
    this.retired = [];
    if (this.graph) disposeGraph(this.graph);
    this.graph = null;
    for (const node of [this.fade, this.volumeNode, this.muteNode, this.speakerTap, this.outputTap]) node?.disconnect();
    this.fade = null;
    this.volumeNode = null;
    this.muteNode = null;
    this.speakerTap = null;
    this.outputTap = null;
    const context = this.context;
    this.context = null;
    if (context) {
      context.removeEventListener("statechange", this.onContextState);
      void context.close().catch(() => undefined);
    }
    this.setStatus("off", reason);
  }

  /** The room's patch changed (here or remotely): follow it if audio is running. Never starts audio. */
  apply(state: SoundPatchState): void {
    this.state = state;
    if (!this.context) return;
    if (this.graph && this.graph.key === topologyKey(state)) updateParameters(this.graph, state, this.context.currentTime);
    else this.rebuild(state);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.context && this.muteNode) ramp(this.muteNode.gain, muted ? 0 : 1, this.context.currentTime, MUTE_RAMP_S);
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(MAX_VOLUME, Number.isFinite(volume) ? volume : DEFAULT_VOLUME));
    if (this.context && this.volumeNode) ramp(this.volumeNode.gain, this.volume, this.context.currentTime, 0.03);
  }

  /** Live peaks: what the Speaker receives here, and what this client is sending to its output. */
  levels(): { speakerIn: number; output: number } | null {
    if (!this.speakerTap || !this.outputTap || this.status !== "running") return null;
    const peakOf = (analyser: AnalyserNode): number => {
      analyser.getFloatTimeDomainData(this.tapBuffer);
      let peak = 0;
      for (const value of this.tapBuffer) peak = Math.max(peak, Math.abs(value));
      return peak;
    };
    return { speakerIn: peakOf(this.speakerTap), output: peakOf(this.outputTap) };
  }

  /** Test hook: the live context's state, or null. */
  contextState(): AudioContextState | null {
    return this.context?.state ?? null;
  }

  private rebuild(state: SoundPatchState): void {
    const context = this.context;
    if (!context || !this.volumeNode || !this.speakerTap) return;
    const now = context.currentTime;
    if (this.graph && this.fade) {
      // Fade the old graph out (10 ms), then release it.
      const old = { graph: this.graph, fade: this.fade, timer: 0 };
      ramp(old.fade.gain, 0, now, MUTE_RAMP_S);
      old.timer = window.setTimeout(() => {
        disposeGraph(old.graph);
        old.fade.disconnect();
        this.retired = this.retired.filter((entry) => entry !== old);
      }, 60);
      this.retired.push(old);
    }
    const graph = buildSoundGraph(context, state, now);
    const fade = new GainNode(context, { gain: 0 });
    ramp(fade.gain, 1, now, MUTE_RAMP_S);
    graph.speakerOut.connect(fade).connect(this.volumeNode);
    graph.speakerIn.connect(this.speakerTap);
    this.graph = graph;
    this.fade = fade;
  }

  private readonly onContextState = (): void => {
    const context = this.context;
    if (!context) return;
    // Resuming is left to the learner's next click (Start audio): never resumed automatically.
    if (context.state === "running") this.setStatus("running");
    else if (context.state === "suspended" || (context.state as string) === "interrupted") this.setStatus("suspended", "The browser paused audio. Click Start audio to resume.");
  };

  private setStatus(status: AudioStatus, detail?: string): void {
    this.status = status;
    this.onStatus(status, detail);
  }
}

function ramp(param: AudioParam, value: number, now: number, seconds: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + seconds);
}
