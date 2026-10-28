/**
 * Sound Flow Studio (Episode 2): the dock UI. Two tabs of the one right-hand dock:
 * - "Studio": the brief and its five criteria (task rules, both conditions), the learning loop
 *   (predict → build → test → explain → revise), local audio controls and the signal display;
 * - "Inspector": the live signal-flow diagram and connection list, and the selected module or
 *   cable's Overview / Ports / Behaviour & limits cards with bounded room edits.
 *
 * One state: everything shown is derived from the room's patch (DesktopWorkbenchScene →
 * sound-model.ts). Knob edits are room edits through WorkbenchTools.submit; a refused, stale or
 * unconfirmed edit changes nothing here and keeps the typed draft. Predictions, explanations
 * and attempts are this learner's own (sessionStorage), never shared or exported; only a "test"
 * trace with criterion codes (no words) goes to the room's activity record.
 *
 * PF/DI: the brief, ratings, safety limits, the signal display and post-Test measurements in both;
 * the worked example and per-criterion explanations in DI only; explanatory diagram notes in PF
 * only after this learner's own first Test in this browser session (a personal gate; teammates'
 * Tests do not unlock it). Bolt is not involved.
 */
import { SOUND_BOUNDS, SOUND_WAVES, type SoundWave } from "../../cloudflare/sound-rules.js";
import type { SharedTransform } from "../desktop/collaboration.js";
import type { DesktopWorkbenchScene, StudHighlight } from "../desktop/scene.js";
import { NET_TONES } from "../desktop/selection-style.ts";
import { measure, renderOffline, SoundEngine, stopEngineForExit, type AudioStatus } from "./sound-audio.ts";
import { CABLE_COLORS, faultNotes, renderConnectionList, renderSoundDiagramSvg } from "./sound-diagram.ts";
import {
  BRIEF,
  CABLE_NAMES,
  CRITERION_LABELS,
  evaluateBrief,
  formatDb,
  formatGain,
  formatHz,
  jackLabel,
  MODULE_NAMES,
  SOUND_CABLE_IDS,
  SOUND_JACKS,
  toDb,
  workedExample,
  type BriefOutcome,
  type CriterionId,
  type SignalAnalysis,
  type SoundCableId,
  type SoundGraph,
  type SoundModuleId,
  type SoundPatchState,
} from "./sound-model.ts";

export interface SoundPanelHost {
  workbench(): DesktopWorkbenchScene | null;
  condition(): "PF" | "DI";
  roomCode(): string;
  selectedId(): string | null;
  select(id: string): void;
  holderOf(id: string): string | null;
  /** One room edit through WorkbenchTools.submit: accepted, or why not ("held", "stale", "invalid", "timeout", …). */
  submit(changes: Array<{ id: string; transform: SharedTransform }>, label: string, traceId: string): Promise<{ ok: boolean; reason: string | null }>;
  returnToMat(id: string): void;
  trace(action: "test" | "reflect", detail: string): void;
  status(message: string, tone: "neutral" | "valid" | "warning"): void;
  /** The dock tab to show (e.g. the Inspector after a 3D selection). */
  showTab(tab: "sound" | "inspect"): void;
}

type Prediction = "meets" | "bright" | "clipped" | "level" | "silent";
const PREDICTIONS: Array<[Prediction, string]> = [
  ["meets", "Meets the brief: dark, clean, in level"],
  ["bright", "Too bright (the 660 Hz harmonic too strong)"],
  ["clipped", "Clipped (distorted)"],
  ["level", "Too quiet or too loud"],
  ["silent", "Silent at the Speaker"],
];

interface Attempt {
  n: number;
  prediction: Prediction | null;
  why: string;
  tested: { at: number; outcome: BriefOutcome; summary: string } | null;
  explanation: string;
  explained: boolean;
}

interface Session {
  attempts: Attempt[];
  /** Explanatory notes unlocked (PF): this learner's first Test in this browser session (not the team's). */
  firstTestAt: number | null;
}

type InspectTab = "overview" | "ports" | "behavior";
type ModuleParam = "hz" | "wave" | "cutoff" | "gain";

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const REFUSALS: Record<string, string> = {
  held: "a teammate is holding it",
  stale: "a teammate changed it first, so their value is kept",
  invalid: "the room's validation refused the value",
  occupied: "that jack already holds a plug",
  offline: "reconnecting to the room",
  timeout: "not confirmed in time",
  disconnected: "the connection closed",
};

/**
 * After the room accepted an edit: clears the module's drafts that are exactly what was submitted,
 * and keeps any value typed (or changed) while the edit was on its way. Returns whether a newer
 * draft was kept.
 */
export function clearSubmittedDrafts(drafts: Map<string, string>, module: string, submitted: ReadonlyMap<string, string>): boolean {
  let newer = false;
  for (const key of [...drafts.keys()]) {
    if (!key.startsWith(`${module}:`)) continue;
    if (submitted.has(key) && submitted.get(key) === drafts.get(key)) drafts.delete(key);
    else newer = true;
  }
  return newer;
}

/** Refusals that are definite: the room answered no (held, stale, invalid, occupied), or the edit was never sent (offline). */
const DEFINITE_REFUSALS: ReadonlySet<string> = new Set(["held", "stale", "invalid", "occupied", "offline"]);

/**
 * Why an edit was not applied. Only a definite refusal says "nothing changed". A timeout, a
 * connection that closed while the edit was out, or any other unconfirmed result is uncertain:
 * the room may have accepted it (its answer was lost), so the copy says the value appears on its
 * own if it did.
 */
export function notAppliedCopy(reason: string | null | undefined, verb: string, draftNote: string): string {
  const note = draftNote ? ` ${draftNote}.` : "";
  if (reason && DEFINITE_REFUSALS.has(reason)) return `${verb} · ${REFUSALS[reason]}; nothing changed.${note}`;
  const why = reason === "timeout" ? "the room did not confirm it in time" : reason === "disconnected" ? "the connection closed before the room's answer arrived" : "the room did not confirm it";
  return `${verb} yet · ${why}. If the room accepted it, the new value will appear here on its own; otherwise nothing changed.${note}`;
}

/** DI only: why a criterion failed, in teaching terms (shown after a Test). */
const DI_EXPLANATIONS: Record<CriterionId, string> = {
  C1: "Signal only flows from an OUT jack into an IN jack. Follow the tone from the Source: each module's OUT must be patched to the next module's IN, ending at the Speaker's IN, with nothing loose and no loop. A switched-off Speaker passes nothing on even when the patch is right.",
  C2: "The brief's tone is a sawtooth at 220 Hz: set the Source's waveform switch to SAW and its frequency to 220.",
  C3: "A sawtooth is bright because of its harmonics (660 Hz is the 3rd). A 2nd-order low-pass takes 12 dB per octave off above its cutoff: put the cutoff between 220 Hz and 660 Hz so 220 Hz passes and 660 Hz is cut.",
  C4: "Clipping happens when the signal entering the Drive, times its gain, goes past ±1.0 FS. Lower the gain, or put the Filter before the Drive so the Drive sees a smaller signal.",
  C5: "The peak at the Speaker input depends on everything before it: the filter takes level away, the Drive's gain puts it back. Raise or lower the gain until the peak sits between −12 and −3 dBFS, without clipping.",
};

const MODULE_REFERENCE: Record<SoundModuleId, { role: string; behaviour: string[]; limits: string[] }> = {
  "snd-source": {
    role: "Makes the tone: a band-limited periodic wave.",
    behaviour: [
      "Web Audio OscillatorNode × 0.5. A sine peaks at 0.5 FS (−6.02 dBFS).",
      "Square and sawtooth are scaled as Web Audio scales them (full-band peak 1.0), so their band-limited versions peak a little below 0.5 FS.",
      "Harmonics above half the sample rate are left out (no aliasing).",
    ],
    limits: ["Frequency 55–1760 Hz in 1 Hz steps; waveforms sine, square, sawtooth.", "Not a hardware VCO: no drift, no voltage control (a Eurorack VCO would be 1 V/oct)."],
  },
  "snd-filter": {
    role: "Takes off high frequencies above its cutoff.",
    behaviour: [
      "2nd-order Butterworth low-pass: −3.01 dB at the cutoff, then −12 dB per octave. Q is fixed at 0.707 (no resonance knob).",
      "Web Audio BiquadFilterNode (its low-pass Q is in dB: −3.01 dB). The brief is judged with the analog prototype; the offline tests measured the digital filter within 0.011 dB of it up to 1 kHz.",
    ],
    limits: ["Cutoff 80–8000 Hz in 1 Hz steps.", "No resonance, no self-oscillation; real filters vary from part to part."],
  },
  "snd-drive": {
    role: "Amplifies, then clips anything beyond ±1.0 FS.",
    behaviour: [
      "Linear gain ×0–×4 (0.01 steps), then an ideal hard clip at ±1.0 FS (WaveShaperNode, identity curve). The distortion you see and hear is that clipping.",
      "The CLIP light shows the modelled clipping, not a timer.",
    ],
    limits: ["Real overdrive circuits clip more softly and add noise; this one is ideal.", "Levels are digital full scale (FS), not volts (Eurorack audio is about ±5 V)."],
  },
  "snd-speaker": {
    role: "The monitor everyone patches to; each listener hears it on their own device.",
    behaviour: [
      "Shared power switch, then a hard clip at ±1.0 FS and a fixed ×0.25 ceiling (−12.04 dBFS), then YOUR volume (0–100 %) and YOUR mute.",
      "The digital output never exceeds 0.25 FS. Starting audio, mute and volume are yours only; a teammate's edit never starts or raises your audio.",
    ],
    limits: ["Loudness (SPL, dBA) is not measured or modelled; it depends on your device.", "No room acoustics, no driver response: an educational signal abstraction, not an acoustic model."],
  },
};

export class SoundPanel {
  readonly engine: SoundEngine;
  private state: SoundPatchState | null = null;
  private graph: SoundGraph | null = null;
  private signal: SignalAnalysis | null = null;
  private session: Session;
  private tab: InspectTab = "overview";
  /** Typed but not yet applied knob values, per module and parameter (kept on refusal). */
  private readonly drafts = new Map<string, string>();
  private editNote: { module: string; text: string; tone: "valid" | "warning" | "neutral" } | null = null;
  private pending = new Set<string>();
  private renderQueued = false;
  private displaySeq = 0;
  private displayTimer = 0;
  private liveFrame = 0;
  private lastDisplay: { points: string; summary: string; harmonics: number[]; peak: number; rms: number; clipped: boolean; source: "rendered" | "model"; reaches: boolean } | null = null;
  private disposed = false;
  /** Last markup written per region: unchanged markup is never rewritten (focus and typing stay). */
  private readonly written = new Map<string, string>();

  // A plain field (no TypeScript parameter property), so Node's --experimental-strip-types can run it.
  private readonly host: SoundPanelHost;

  constructor(host: SoundPanelHost) {
    this.host = host;
    this.engine = new SoundEngine((status, detail) => this.onAudioStatus(status, detail));
    this.session = this.loadSession();
  }

  // ── Markup ────────────────────────────────────────────────────────────────────────

  static studioMarkup(): string {
    return `<section class="sound-studio" id="sound-studio" aria-labelledby="sound-studio-title">
      <header class="ss-head">
        <div><span class="section-label">Episode 2 · Sound Flow Studio</span><h2 id="sound-studio-title">Brief · ${escape(BRIEF.title)}</h2></div>
        <span class="ss-pill" id="ss-pill" data-tone="neutral" role="status" aria-live="polite">Attempt 1 · not tested</span>
      </header>
      <p class="ss-story">Patch a warning tone for the shared monitor: dark (not buzzy), clean (not distorted) and clearly audible. These five criteria are the task's rules:</p>
      <ol class="ss-criteria" id="ss-criteria">
        ${(Object.keys(CRITERION_LABELS) as CriterionId[]).map((id) => `<li data-criterion="${id}"><strong>${id}</strong> ${escape(CRITERION_LABELS[id])}</li>`).join("")}
      </ol>
      <p class="ss-note"><i class="ph ph-info" aria-hidden="true"></i> Measurements against the criteria appear after each <strong>Test</strong>, in both conditions. The signal display below always shows what reaches the Speaker.</p>
      <section class="ss-card" id="ss-worked" hidden aria-labelledby="ss-worked-title"></section>

      <section class="ss-card" aria-labelledby="ss-audio-title">
        <div class="ss-card-head"><h3 id="ss-audio-title"><i class="ph ph-speaker-high" aria-hidden="true"></i> Listen (this device only)</h3><small id="ss-audio-state">Audio off</small></div>
        <div class="ss-audio-row">
          <button class="primary-button" id="ss-audio-start" type="button"><i class="ph ph-play" aria-hidden="true"></i> Start audio</button>
          <button class="secondary-button" id="ss-audio-stop" type="button" disabled><i class="ph ph-stop" aria-hidden="true"></i> Stop</button>
          <button class="secondary-button" id="ss-audio-mute" type="button" aria-pressed="false"><i class="ph ph-speaker-simple-x" aria-hidden="true"></i> Mute</button>
        </div>
        <label class="ss-volume" for="ss-volume"><span>Your volume</span><input type="range" id="ss-volume" min="0" max="100" step="5" value="50" aria-describedby="ss-volume-note"><output id="ss-volume-out" for="ss-volume">50 %</output></label>
        <p class="ss-fine" id="ss-volume-note">Nothing plays until you press Start audio. The Speaker's digital output is capped at 0.25 FS (−12 dBFS) × your volume; how loud that is depends on your device. A teammate's edit never starts or raises your audio.</p>
      </section>

      <section class="ss-card" aria-labelledby="ss-signal-title">
        <div class="ss-card-head"><h3 id="ss-signal-title"><i class="ph ph-wave-sawtooth" aria-hidden="true"></i> Signal at the Speaker input</h3><small id="ss-signal-source">rendered from the patch</small></div>
        <div class="ss-scope" id="ss-scope" role="img" aria-label="Signal display"></div>
        <dl class="ss-meter" id="ss-meter"></dl>
        <div class="ss-harmonics" id="ss-harmonics" aria-label="Harmonic levels at the Speaker input"></div>
        <p class="ss-live" id="ss-live" aria-live="off"></p>
        <p class="ss-fine">Rendered by Web Audio in an OfflineAudioContext from the same graph you hear (digital full scale; not a microphone and not a measurement of any speaker).</p>
      </section>

      <section class="ss-card ss-loop" aria-labelledby="ss-loop-title">
        <div class="ss-card-head"><h3 id="ss-loop-title"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Your attempt</h3><small id="ss-attempt-label"></small></div>
        <ol class="ss-steps" id="ss-steps" aria-label="Learning loop"></ol>
        <fieldset class="ss-step" id="ss-predict">
          <legend>1 · Predict: what will the Speaker get?</legend>
          <div class="ss-choices" id="ss-predictions">
            ${PREDICTIONS.map(([value, label]) => `<label class="ss-choice"><input type="radio" name="ss-prediction" value="${value}"><span>${escape(label)}</span></label>`).join("")}
          </div>
          <label class="ss-why" for="ss-why">Why? <small>(your own notes; not shared)</small></label>
          <textarea id="ss-why" rows="2" maxlength="400" placeholder="Because the filter…"></textarea>
        </fieldset>
        <div class="ss-step">
          <p class="ss-step-title">2 · Build: patch cables and set knobs on the desk (or in the Inspector). <span id="ss-build-summary"></span></p>
        </div>
        <div class="ss-step">
          <p class="ss-step-title">3 · Test the room's patch as it is now.</p>
          <button class="primary-button" id="ss-test" type="button"><i class="ph ph-flask" aria-hidden="true"></i> Test patch</button>
          <div class="ss-result" id="ss-result" role="status" aria-live="polite"></div>
        </div>
        <div class="ss-step">
          <label class="ss-step-title" for="ss-explain">4 · Explain what you heard or saw, and why.</label>
          <textarea id="ss-explain" rows="3" maxlength="800" placeholder="The 660 Hz harmonic dropped because…"></textarea>
          <button class="secondary-button compact" id="ss-explain-save" type="button" disabled>Save explanation</button>
        </div>
        <div class="ss-step">
          <p class="ss-step-title">5 · Revise: change the patch, then start a new attempt.</p>
          <button class="secondary-button compact" id="ss-new-attempt" type="button"><i class="ph ph-plus" aria-hidden="true"></i> New attempt</button>
        </div>
        <details class="ss-history"><summary>Earlier attempts</summary><ol id="ss-history"></ol></details>
      </section>
    </section>`;
  }

  static inspectorMarkup(): string {
    return `<section class="sound-inspector" id="sound-inspector" aria-labelledby="sound-inspector-title" hidden>
      <header class="si-head"><h2 class="section-label" id="sound-inspector-title">Patch inspector</h2><span class="si-summary" id="sdi-summary" role="status" aria-live="polite"></span></header>
      <section class="si-card" aria-labelledby="sdi-diagram-title">
        <div class="si-card-head"><h3 id="sdi-diagram-title">Live signal flow</h3><small>Drawn from the patch as built</small></div>
        <div class="sd-diagram" id="sdi-diagram"></div>
        <ul class="sd-legend" aria-label="Diagram legend">
          <li><span class="sd-key is-solid" aria-hidden="true"></span> solid + arrow: carries the tone</li>
          <li><span class="sd-key is-dashed" aria-hidden="true"></span> long dashes: connected, no signal</li>
          <li><span class="sd-key is-dotted" aria-hidden="true"></span> dots + ✕: OUT→OUT, IN→IN or loose</li>
          <li><span class="sd-key is-loop" aria-hidden="true"></span> short dashes + ⟲: loop, silenced</li>
        </ul>
        <div class="sd-notes" id="sdi-notes" role="status" aria-live="polite"></div>
        <h4 class="sd-list-title">Connections (text)</h4>
        <div id="sdi-list"></div>
      </section>
      <section class="si-card" aria-labelledby="sdi-part-title">
        <div class="si-card-head"><h3 id="sdi-part-title">Selected</h3><small id="sdi-part-hint">Select a module or cable in 3D, in the parts rail or on the diagram</small></div>
        <div class="si-tabs" role="tablist" aria-label="Part details" id="sdi-tabs">
          <button role="tab" type="button" id="sdi-tab-overview" data-sdi-tab="overview" aria-controls="sdi-panel" aria-selected="true">Overview</button>
          <button role="tab" type="button" id="sdi-tab-ports" data-sdi-tab="ports" aria-controls="sdi-panel" aria-selected="false" tabindex="-1">Ports</button>
          <button role="tab" type="button" id="sdi-tab-behavior" data-sdi-tab="behavior" aria-controls="sdi-panel" aria-selected="false" tabindex="-1">Behaviour &amp; limits</button>
        </div>
        <div class="si-panel" id="sdi-panel" role="tabpanel" aria-labelledby="sdi-tab-overview"></div>
      </section>
    </section>`;
  }

  // ── Binding ───────────────────────────────────────────────────────────────────────

  bind(): void {
    const on = <K extends keyof HTMLElementEventMap>(selector: string, type: K, handler: (event: HTMLElementEventMap[K]) => void): void => {
      document.querySelector<HTMLElement>(selector)?.addEventListener(type, handler);
    };
    // Audio starts only from this click (or Enter/Space on the button, which is a click).
    on("#ss-audio-start", "click", () => void this.engine.start().then((started) => {
      if (started) this.host.status("Audio on for you only · Speaker capped at −12 dBFS × your volume", "valid");
      this.renderAudio();
    }));
    on("#ss-audio-stop", "click", () => {
      this.engine.stop("Stopped by you");
      this.renderAudio();
    });
    on("#ss-audio-mute", "click", () => {
      this.engine.setMuted(!this.engine.isMuted);
      this.renderAudio();
    });
    on("#ss-volume", "input", (event) => {
      const value = Number((event.target as HTMLInputElement).value) / 100;
      this.engine.setVolume(value);
      this.renderAudio();
    });
    on("#ss-predictions", "change", (event) => {
      const value = (event.target as HTMLInputElement).value as Prediction;
      this.current().prediction = value;
      this.saveSession();
      this.renderLoop();
    });
    on("#ss-why", "input", (event) => {
      this.current().why = (event.target as HTMLTextAreaElement).value.slice(0, 400);
      this.saveSession();
    });
    on("#ss-test", "click", () => this.runTest());
    on("#ss-explain", "input", (event) => {
      this.current().explanation = (event.target as HTMLTextAreaElement).value.slice(0, 800);
      this.saveSession();
      this.renderLoop();
    });
    on("#ss-explain-save", "click", () => this.saveExplanation());
    on("#ss-new-attempt", "click", () => this.newAttempt());
    // Inspector: diagram and list selection, tabs, edits.
    const diagram = document.querySelector<HTMLElement>("#sdi-diagram");
    const activate = (target: Element | null): void => {
      const node = target?.closest<SVGElement>("[data-module], [data-cable]");
      const id = node?.getAttribute("data-module") ?? node?.getAttribute("data-cable");
      if (id) this.host.select(id);
    };
    diagram?.addEventListener("click", (event) => activate(event.target as Element));
    diagram?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate(event.target as Element);
    });
    on("#sdi-list", "click", (event) => {
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-select]")?.dataset.select;
      if (id) this.host.select(id);
    });
    const tabs = document.querySelector<HTMLElement>("#sdi-tabs");
    tabs?.addEventListener("click", (event) => {
      const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-sdi-tab]")?.dataset.sdiTab as InspectTab | undefined;
      if (tab) this.setTab(tab, false);
    });
    tabs?.addEventListener("keydown", (event) => {
      const order: InspectTab[] = ["overview", "ports", "behavior"];
      const index = order.indexOf(this.tab);
      const next = event.key === "ArrowRight" ? order[(index + 1) % 3] : event.key === "ArrowLeft" ? order[(index + 2) % 3] : event.key === "Home" ? order[0] : event.key === "End" ? order[2] : null;
      if (!next) return;
      event.preventDefault();
      this.setTab(next, true);
    });
    const panel = document.querySelector<HTMLElement>("#sdi-panel");
    panel?.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      const key = target.dataset.draft;
      if (key) this.drafts.set(key, target.value);
    });
    panel?.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.name === "sdi-wave") this.drafts.set("snd-source:wave", target.value);
    });
    panel?.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!button) return;
      if (button.dataset.step) this.stepDraft(button.dataset.step, Number(button.dataset.delta));
      if (button.dataset.apply) void this.applyModule(button.dataset.apply as SoundModuleId);
      if (button.dataset.revert) this.revertDrafts(button.dataset.revert as SoundModuleId);
      if (button.dataset.speakerSwitch) void this.setSpeaker(button.dataset.speakerSwitch === "on");
      if (button.dataset.mat) this.host.returnToMat(button.dataset.mat);
      if (button.dataset.select) this.host.select(button.dataset.select);
    });
    panel?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = (event.target as HTMLElement).closest<HTMLFormElement>("form[data-module]");
      if (form) void this.applyModule(form.dataset.module as SoundModuleId);
    });
    this.renderWorked();
    this.renderAudio();
    this.renderLoop();
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.displayTimer);
    cancelAnimationFrame(this.liveFrame);
    this.engine.stop("Left the studio");
  }

  /** Studio left, room left or the connection lost: audio stops and needs a new click. */
  stopAudio(reason: string): void {
    stopEngineForExit(this.engine, reason);
    this.renderAudio();
  }

  // ── State in ─────────────────────────────────────────────────────────────────────

  /** The room's patch changed (here or remotely). Never starts or raises audio. */
  update(state: SoundPatchState, graph: SoundGraph, signal: SignalAnalysis): void {
    this.state = state;
    this.graph = graph;
    this.signal = signal;
    this.engine.apply(state);
    this.scheduleDisplay();
    this.queueRender();
  }

  refresh(): void {
    this.queueRender();
  }

  /** A knob or the switch was clicked in 3D: show the module's controls and focus that one. */
  focusControl(moduleId: string, param: string): void {
    this.setTab("overview", false);
    this.host.showTab("inspect");
    requestAnimationFrame(() => {
      this.render();
      const target = param === "on"
        ? document.querySelector<HTMLElement>(`#sdi-panel [data-speaker-switch]`)
        : document.querySelector<HTMLElement>(`#sdi-panel [data-draft="${moduleId}:${param}"], #sdi-panel input[name="sdi-wave"]:checked`);
      target?.focus();
    });
  }

  /** Jacks to ring in 3D for the selected module or cable (cross-link). */
  highlightsFor(selected: string | null): StudHighlight[] {
    const graph = this.graph;
    if (!graph || !selected) return [];
    const out: StudHighlight[] = [];
    if (SOUND_CABLE_IDS.includes(selected as SoundCableId)) {
      const edge = graph.edges.find((entry) => entry.cable === selected);
      const loose = graph.loose.find((entry) => entry.cable === selected);
      const invalid = edge && (edge.status === "out-out" || edge.status === "in-in" || edge.status === "loop" || edge.status === "shared-jack");
      if (edge) edge.jacks.forEach((jack, index) => out.push({ socket: jack, tone: invalid ? "fault" : index === 0 ? "a" : "b", terminal: true }));
      if (loose) out.push({ socket: loose.jack, tone: "fault", terminal: true });
      return out;
    }
    for (const jack of SOUND_JACKS) {
      if (jack.module !== selected) continue;
      out.push({ socket: jack.index, tone: "a", terminal: true });
      const edge = graph.edges.find((entry) => entry.jacks.includes(jack.index));
      if (!edge) continue;
      const far = edge.jacks[0] === jack.index ? edge.jacks[1] : edge.jacks[0];
      const invalid = edge.status === "out-out" || edge.status === "in-in" || edge.status === "loop" || edge.status === "shared-jack";
      out.push({ socket: far, tone: invalid ? "fault" : "b", terminal: false });
    }
    return out;
  }

  // ── Loop ─────────────────────────────────────────────────────────────────────────

  private current(): Attempt {
    return this.session.attempts[this.session.attempts.length - 1];
  }

  private runTest(): void {
    const state = this.state;
    if (!state) return;
    const outcome = evaluateBrief(state, this.graph ?? undefined, this.signal ?? undefined);
    const attempt = this.current();
    const passed = outcome.criteria.filter((criterion) => criterion.pass).map((criterion) => criterion.id);
    attempt.tested = { at: Date.now(), outcome, summary: this.patchSummary() };
    attempt.explained = false;
    if (this.session.firstTestAt === null) this.session.firstTestAt = Date.now();
    this.saveSession();
    // Instrumentation: criterion codes only (never the learner's words).
    this.host.trace("test", `Sound test · attempt ${attempt.n} · ${outcome.met ? "brief met" : `${passed.length}/5 (failed ${outcome.criteria.filter((criterion) => !criterion.pass).map((criterion) => criterion.id).join(", ")})`}`);
    this.host.status(outcome.met ? `Test: all five criteria met · now explain why it works` : `Test: ${passed.length} of 5 criteria met`, outcome.met ? "valid" : "neutral");
    this.queueRender();
  }

  private saveExplanation(): void {
    const attempt = this.current();
    if (!attempt.tested || attempt.explanation.trim().length < 8) return;
    attempt.explained = true;
    this.saveSession();
    this.host.trace("reflect", `Sound explanation saved · attempt ${attempt.n}${attempt.tested.outcome.met ? " · brief met" : ""}`);
    this.host.status(attempt.tested.outcome.met ? "Explanation saved · brief met and explained" : "Explanation saved · revise and test again", "valid");
    this.queueRender();
  }

  private newAttempt(): void {
    this.session.attempts.push({ n: this.session.attempts.length + 1, prediction: null, why: "", tested: null, explanation: "", explained: false });
    this.saveSession();
    this.queueRender();
    document.querySelector<HTMLInputElement>('#ss-predictions input')?.focus();
  }

  private patchSummary(): string {
    const graph = this.graph;
    const state = this.state;
    if (!graph || !state) return "";
    const chain = graph.chain.map((id) => MODULE_NAMES[id]).join(" → ");
    return `${chain}${graph.reachesSpeaker ? "" : " (does not reach the Speaker)"} · ${state.source.wave} ${state.source.hz} Hz · cutoff ${formatHz(state.filter.cutoff)} · Drive ${formatGain(state.drive.gain)} · Speaker ${state.speakerOn ? "on" : "off"}`;
  }

  // ── Edits ────────────────────────────────────────────────────────────────────────

  private draftValue(module: SoundModuleId, param: ModuleParam): string {
    const key = `${module}:${param}`;
    if (this.drafts.has(key)) return this.drafts.get(key)!;
    const state = this.state;
    if (!state) return "";
    if (param === "hz") return String(state.source.hz);
    if (param === "wave") return state.source.wave;
    if (param === "cutoff") return String(state.filter.cutoff);
    return state.drive.gain.toFixed(2);
  }

  private stepDraft(key: string, delta: number): void {
    const [module, param] = key.split(":") as [SoundModuleId, ModuleParam];
    const current = Number(this.draftValue(module, param));
    const bounds = SOUND_BOUNDS[param as "hz" | "cutoff" | "gain"];
    if (!bounds || !Number.isFinite(current)) return;
    const next = param === "gain" ? Math.round((current + delta) * 100) / 100 : Math.round(param === "cutoff" || param === "hz" ? current * (delta > 0 ? 2 ** (1 / 12) : 2 ** (-1 / 12)) : current + delta);
    const clamped = Math.min(bounds.max, Math.max(bounds.min, next));
    this.drafts.set(key, param === "gain" ? clamped.toFixed(2) : String(clamped));
    this.render();
    document.querySelector<HTMLElement>(`#sdi-panel [data-draft="${key}"]`)?.focus();
  }

  private revertDrafts(module: SoundModuleId): void {
    for (const key of [...this.drafts.keys()]) if (key.startsWith(`${module}:`)) this.drafts.delete(key);
    this.editNote = { module, text: "Draft discarded · showing the room's values", tone: "neutral" };
    this.render();
  }

  /** One room edit with the module's drafted values. Nothing changes until the room accepts it. */
  private async applyModule(module: SoundModuleId): Promise<void> {
    const workbench = this.host.workbench();
    if (!workbench || module === "snd-speaker") return;
    if (this.pending.has(module)) {
      // Enter pressed again while the previous value is still on its way: say so; the draft stays.
      this.editNote = { module, text: "Still waiting for the room to confirm the previous value · your new draft is kept; apply it again once that is answered", tone: "neutral" };
      this.render();
      return;
    }
    const before = workbench.getSharedTransforms()[module];
    if (!before) return;
    const props = module === "snd-source"
      ? { hz: Number(this.draftValue("snd-source", "hz")), wave: this.draftValue("snd-source", "wave") as SoundWave }
      : module === "snd-filter"
        ? { cutoff: Number(this.draftValue("snd-filter", "cutoff")) }
        : { gain: Number(this.draftValue("snd-drive", "gain")) };
    const problem = this.validate(module, props);
    if (problem) {
      this.editNote = { module, text: problem, tone: "warning" };
      this.render();
      return;
    }
    const label = module === "snd-source" ? `Set Source to ${props.wave} ${props.hz} Hz` : module === "snd-filter" ? `Set Filter cutoff to ${formatHz(props.cutoff!)}` : `Set Drive gain to ${formatGain(props.gain!)}`;
    // The drafts this edit carries, as typed: only these are cleared when the room accepts it.
    const submitted = new Map([...this.drafts].filter(([key]) => key.startsWith(`${module}:`)));
    this.pending.add(module);
    this.editNote = { module, text: "Sending to the room…", tone: "neutral" };
    this.render();
    const result = await this.host.submit([{ id: module, transform: { ...before, props } }], label, module);
    this.pending.delete(module);
    if (result.ok) {
      // A value typed while this edit was on its way is a newer draft: it stays.
      const newer = clearSubmittedDrafts(this.drafts, module, submitted);
      this.editNote = { module, text: `${label} · shared with the room${newer ? " · the newer value you typed meanwhile is kept as a draft below" : ""}`, tone: "valid" };
    } else {
      this.editNote = { module, text: notAppliedCopy(result.reason, "Not applied", "Your draft is kept below"), tone: "warning" };
    }
    this.render();
  }

  private validate(module: SoundModuleId, props: { hz?: number; wave?: string; cutoff?: number; gain?: number }): string | null {
    const check = (value: number | undefined, param: "hz" | "cutoff" | "gain", unit: string): string | null => {
      const bounds = SOUND_BOUNDS[param];
      return value === undefined || !Number.isFinite(value) || value < bounds.min || value > bounds.max ? `Enter ${param === "gain" ? "a gain" : "a frequency"} from ${bounds.min} to ${bounds.max}${unit}.` : null;
    };
    if (module === "snd-source") return check(props.hz, "hz", " Hz") ?? (SOUND_WAVES.includes(props.wave as SoundWave) ? null : "Choose a waveform.");
    if (module === "snd-filter") return check(props.cutoff, "cutoff", " Hz");
    return check(props.gain, "gain", "");
  }

  private async setSpeaker(on: boolean): Promise<void> {
    const workbench = this.host.workbench();
    if (!workbench || this.pending.has("snd-speaker")) return;
    const before = workbench.getSharedTransforms()["snd-speaker"];
    if (!before) return;
    this.pending.add("snd-speaker");
    this.editNote = { module: "snd-speaker", text: "Sending to the room…", tone: "neutral" };
    this.render();
    const result = await this.host.submit([{ id: "snd-speaker", transform: { ...before, on } }], `Speaker switched ${on ? "on" : "off"}`, "snd-speaker");
    this.pending.delete("snd-speaker");
    this.editNote = result.ok
      ? { module: "snd-speaker", text: `Speaker switched ${on ? "on" : "off"} for everyone`, tone: "valid" }
      : { module: "snd-speaker", text: notAppliedCopy(result.reason, "Not switched", ""), tone: "warning" };
    this.render();
  }

  // ── Audio ────────────────────────────────────────────────────────────────────────

  private onAudioStatus(status: AudioStatus, detail?: string): void {
    if (status === "needs-gesture" || status === "suspended" || status === "error" || status === "unsupported") this.host.status(detail ?? "Audio is not running", "warning");
    this.renderAudio();
  }

  private renderAudio(): void {
    if (this.disposed) return;
    const status = this.engine.status;
    const start = document.querySelector<HTMLButtonElement>("#ss-audio-start");
    const stop = document.querySelector<HTMLButtonElement>("#ss-audio-stop");
    const mute = document.querySelector<HTMLButtonElement>("#ss-audio-mute");
    const label = document.querySelector<HTMLElement>("#ss-audio-state");
    const volume = document.querySelector<HTMLInputElement>("#ss-volume");
    const output = document.querySelector<HTMLOutputElement>("#ss-volume-out");
    if (start) {
      start.hidden = status === "running";
      start.innerHTML = status === "suspended" ? '<i class="ph ph-play" aria-hidden="true"></i> Resume audio' : '<i class="ph ph-play" aria-hidden="true"></i> Start audio';
    }
    if (stop) stop.disabled = status === "off";
    if (mute) {
      mute.setAttribute("aria-pressed", String(this.engine.isMuted));
      mute.innerHTML = this.engine.isMuted ? '<i class="ph ph-speaker-simple-slash" aria-hidden="true"></i> Muted' : '<i class="ph ph-speaker-simple-x" aria-hidden="true"></i> Mute';
    }
    const percent = Math.round(this.engine.volumeLevel * 100);
    if (volume && Number(volume.value) !== percent) volume.value = String(percent);
    if (output) output.textContent = `${percent} %`;
    if (label) label.textContent = status === "running" ? (this.engine.isMuted ? "Running · muted (only you)" : `Playing here · volume ${percent} %`) : status === "suspended" ? "Paused by the browser" : status === "needs-gesture" ? "Waiting for your click" : status === "unsupported" ? "No Web Audio in this browser" : status === "error" ? "Audio error" : "Audio off";
    const toolbar = document.querySelector<HTMLButtonElement>("#sound-audio-toggle");
    if (toolbar) {
      const text = status !== "running" ? "Start audio (this device)" : this.engine.isMuted ? "Unmute (this device)" : "Mute (this device)";
      toolbar.setAttribute("aria-label", text);
      toolbar.dataset.tooltip = text;
      toolbar.title = text;
      toolbar.setAttribute("aria-pressed", String(status === "running" && !this.engine.isMuted));
      toolbar.innerHTML = `<i class="ph ${status !== "running" ? "ph-speaker-none" : this.engine.isMuted ? "ph-speaker-simple-slash" : "ph-speaker-high"}"></i>`;
    }
    cancelAnimationFrame(this.liveFrame);
    if (status === "running") this.liveFrame = requestAnimationFrame(this.tickLive);
    else {
      const live = document.querySelector<HTMLElement>("#ss-live");
      if (live) live.textContent = "";
    }
  }

  /** Toolbar button: Start (gesture) when off, otherwise mute/unmute. */
  toggleFromToolbar(): void {
    if (this.engine.status !== "running") void this.engine.start().then(() => this.renderAudio());
    else {
      this.engine.setMuted(!this.engine.isMuted);
      this.renderAudio();
    }
  }

  private lastLiveAt = 0;
  private readonly tickLive = (): void => {
    if (this.disposed || this.engine.status !== "running") return;
    const now = performance.now();
    if (now - this.lastLiveAt > 250) {
      this.lastLiveAt = now;
      const levels = this.engine.levels();
      const live = document.querySelector<HTMLElement>("#ss-live");
      if (live && levels) live.textContent = `Live on this device: Speaker input ${formatDb(toDb(levels.speakerIn))} peak · your output ${this.engine.isMuted ? "muted" : formatDb(toDb(levels.output))}`;
    }
    this.liveFrame = requestAnimationFrame(this.tickLive);
  };

  // ── Signal display (offline render of the same graph) ─────────────────────────────

  private scheduleDisplay(): void {
    window.clearTimeout(this.displayTimer);
    this.displayTimer = window.setTimeout(() => void this.renderDisplay(), 140);
  }

  private async renderDisplay(): Promise<void> {
    const state = this.state;
    const signal = this.signal;
    if (!state || !signal || this.disposed) return;
    const seq = ++this.displaySeq;
    const f0 = state.source.hz;
    let samples: Float32Array | null = null;
    let sampleRate = 48_000;
    if (signal.speakerIn && typeof OfflineAudioContext !== "undefined") {
      try {
        const rendered = await renderOffline(state, 0.12, sampleRate);
        samples = rendered.speakerIn;
        sampleRate = rendered.sampleRate;
      } catch {
        samples = null;
      }
    }
    if (seq !== this.displaySeq || this.disposed) return;
    const reaches = Boolean(signal.speakerIn);
    let points = "";
    let peak = 0;
    let rms = 0;
    let harmonics: number[] = [];
    let source: "rendered" | "model" = "rendered";
    if (reaches && samples) {
      const m = measure(samples, sampleRate, f0, 6);
      peak = m.peak;
      rms = m.rms;
      harmonics = m.harmonics;
      // Two cycles, starting at a rising zero crossing after 50 ms.
      let start = Math.round(0.05 * sampleRate);
      for (let i = start; i < samples.length - 1; i += 1) if (samples[i] <= 0 && samples[i + 1] > 0) {
        start = i;
        break;
      }
      const length = Math.min(samples.length - start, Math.round((2 * sampleRate) / f0));
      const step = Math.max(1, Math.floor(length / 240));
      const coords: string[] = [];
      for (let i = 0; i < length; i += step) coords.push(`${((i / length) * 300).toFixed(1)},${(60 - samples[start + i] * 50).toFixed(1)}`);
      points = coords.join(" ");
    } else if (reaches && signal.speakerIn) {
      source = "model";
      peak = signal.speakerIn.peak;
      rms = signal.speakerIn.rms;
      harmonics = signal.speakerIn.harmonics.slice(0, 6);
      const period = signal.period;
      const coords: string[] = [];
      for (let i = 0; i < 240; i += 1) coords.push(`${((i / 240) * 300).toFixed(1)},${(60 - period[Math.floor(((i * 2) % 240) / 240 * period.length)] * 50).toFixed(1)}`);
      points = coords.join(" ");
    }
    const drive = signal.stages.find((stage) => stage.module === "snd-drive");
    const clipped = Boolean(drive && drive.clipped > 0);
    const summary = !reaches
      ? `No signal reaches the Speaker input (${this.graph?.chain.map((id) => MODULE_NAMES[id]).join(" → ") || "nothing patched"}).`
      : `Speaker input: ${state.source.wave} at ${formatHz(f0)}, peak ${formatDb(toDb(peak))}, RMS ${formatDb(toDb(rms))}; ${f0 * 3} Hz is ${harmonics[2] > 1e-6 ? `${(20 * Math.log10(harmonics[0] / harmonics[2])).toFixed(1)} dB` : "far"} below ${f0} Hz; ${clipped ? `the Drive clips ${(drive!.clipped * 100).toFixed(1)} % of each cycle` : "no clipping"}${state.speakerOn ? "" : "; the Speaker is switched off"}.`;
    this.lastDisplay = { points, summary, harmonics, peak, rms, clipped, source, reaches };
    this.renderSignal();
  }

  private renderSignal(): void {
    const display = this.lastDisplay;
    const state = this.state;
    const scope = document.querySelector<HTMLElement>("#ss-scope");
    const meter = document.querySelector<HTMLElement>("#ss-meter");
    const bars = document.querySelector<HTMLElement>("#ss-harmonics");
    const source = document.querySelector<HTMLElement>("#ss-signal-source");
    if (!display || !state || !scope || !meter || !bars) return;
    scope.setAttribute("aria-label", display.summary);
    scope.dataset.reaches = String(display.reaches);
    scope.dataset.clipped = String(display.clipped);
    this.write(scope, "scope", `<svg viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="10" x2="300" y2="10" class="ss-rail"/><line x1="0" y1="110" x2="300" y2="110" class="ss-rail"/>
      <line x1="0" y1="60" x2="300" y2="60" class="ss-axis"/>
      <text x="4" y="8" class="ss-scale">+1.0 FS (clip)</text><text x="4" y="118" class="ss-scale">−1.0 FS</text>
      ${display.reaches ? `<polyline points="${display.points}" class="ss-trace${display.clipped ? " is-clipped" : ""}"/>` : '<text x="150" y="56" text-anchor="middle" class="ss-empty">no signal at the Speaker input</text>'}
    </svg>`);
    if (source) source.textContent = display.source === "rendered" ? "rendered from the patch (Web Audio, offline)" : "computed by the model (offline rendering unavailable)";
    this.write(meter, "meter", display.reaches
      ? `<div><dt>Peak</dt><dd data-meter="peak">${formatDb(toDb(display.peak))}</dd></div><div><dt>RMS</dt><dd>${formatDb(toDb(display.rms))}</dd></div><div><dt>Clipping</dt><dd data-meter="clip">${display.clipped ? "yes, at the Drive" : "none"}</dd></div><div><dt>Speaker</dt><dd>${state.speakerOn ? "on" : "switched off"}</dd></div>`
      : `<div><dt>Peak</dt><dd data-meter="peak">silent</dd></div><div><dt>Speaker</dt><dd>${state.speakerOn ? "on" : "switched off"}</dd></div>`);
    const top = Math.max(1e-6, ...display.harmonics);
    this.write(bars, "bars", display.reaches
      ? display.harmonics.map((amplitude, index) => {
        const db = amplitude > 1e-7 ? 20 * Math.log10(amplitude / top) : -60;
        const height = Math.max(2, Math.round(((Math.max(-48, db) + 48) / 48) * 56));
        return `<div class="ss-bar" title="${formatHz(state.source.hz * (index + 1))}: ${Number.isFinite(db) ? db.toFixed(1) : "−∞"} dB"><span style="height:${height}px"></span><small>${formatHz(state.source.hz * (index + 1)).replace(" Hz", "")}</small></div>`;
      }).join("") + '<p class="ss-bars-note">Harmonics, dB relative to the strongest (0 to −48 dB)</p>'
      : "");
  }

  // ── Rendering ───────────────────────────────────────────────────────────────────

  private queueRender(): void {
    if (this.renderQueued || this.disposed) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    if (this.disposed) return;
    this.renderLoop();
    this.renderInspector();
    this.renderSignal();
    this.host.workbench()?.setJackHighlights(this.highlightsFor(this.host.selectedId()));
  }

  private renderWorked(): void {
    const card = document.querySelector<HTMLElement>("#ss-worked");
    if (!card) return;
    if (this.host.condition() !== "DI") {
      card.hidden = true;
      card.innerHTML = "";
      return;
    }
    const example = workedExample();
    card.hidden = false;
    card.innerHTML = `<div class="ss-card-head"><h3 id="ss-worked-title"><i class="ph ph-lightbulb" aria-hidden="true"></i> Worked example</h3><small>numbers from the same model</small></div>
      <p>A 2nd-order low-pass at <strong>${example.cutoff} Hz</strong> passes 220 Hz at ${example.h1Db.toFixed(1)} dB and cuts 660 Hz by ${Math.abs(example.h3Db).toFixed(1)} dB, so 660 Hz ends ${example.belowDb.toFixed(1)} dB below 220 Hz (the brief needs 18).</p>
      <p>That filtered sawtooth peaks at ${formatDb(example.peakAtUnityDb)} with the Drive at ×1.00; Drive <strong>${formatGain(example.gain)}</strong> lifts it to ${formatDb(example.peakDb)} without clipping.</p>`;
  }

  private renderLoop(): void {
    const attempt = this.current();
    const pill = document.querySelector<HTMLElement>("#ss-pill");
    const label = document.querySelector<HTMLElement>("#ss-attempt-label");
    const result = document.querySelector<HTMLElement>("#ss-result");
    const steps = document.querySelector<HTMLElement>("#ss-steps");
    const why = document.querySelector<HTMLTextAreaElement>("#ss-why");
    const explain = document.querySelector<HTMLTextAreaElement>("#ss-explain");
    const save = document.querySelector<HTMLButtonElement>("#ss-explain-save");
    const summary = document.querySelector<HTMLElement>("#ss-build-summary");
    const history = document.querySelector<HTMLElement>("#ss-history");
    if (!pill || !result || !steps) return;
    // The pill describes the CURRENT attempt only; an earlier success is a milestone in the history.
    const tested = attempt.tested;
    const state = !tested ? "not tested" : tested.outcome.met ? (attempt.explained ? "brief met · explained" : "brief met · explain it") : `${tested.outcome.criteria.filter((criterion) => criterion.pass).length}/5 criteria`;
    pill.textContent = `Attempt ${attempt.n} · ${state}`;
    pill.dataset.tone = tested?.outcome.met ? "valid" : tested ? "warning" : "neutral";
    if (label) label.textContent = `Attempt ${attempt.n}`;
    const stepNames = ["Predict", "Build", "Test", "Explain", "Revise"];
    const reached = [Boolean(attempt.prediction), true, Boolean(tested), attempt.explained, false];
    this.write(steps, "steps", stepNames.map((name, index) => `<li data-done="${reached[index]}"><span aria-hidden="true">${index + 1}</span>${name}${reached[index] && index !== 1 ? '<span class="sr-only"> (done)</span>' : ""}</li>`).join(""));
    document.querySelectorAll<HTMLInputElement>('#ss-predictions input').forEach((input) => {
      input.checked = input.value === attempt.prediction;
    });
    if (why && document.activeElement !== why && why.value !== attempt.why) why.value = attempt.why;
    if (explain && document.activeElement !== explain && explain.value !== attempt.explanation) explain.value = attempt.explanation;
    if (save) save.disabled = !tested || attempt.explanation.trim().length < 8 || attempt.explained;
    if (summary) summary.textContent = this.patchSummary() ? `Now: ${this.patchSummary()}.` : "";
    if (!tested) {
      result.innerHTML = `<p class="ss-fine">Not tested yet. Test the patch when you are ready; the five criteria are measured on the room's patch at that moment.</p>`;
    } else {
      const di = this.host.condition() === "DI";
      const predicted = PREDICTIONS.find(([value]) => value === attempt.prediction)?.[1] ?? "no prediction recorded";
      result.innerHTML = `<p class="ss-result-head"><strong>${tested.outcome.met ? "All five criteria met." : `${tested.outcome.criteria.filter((criterion) => criterion.pass).length} of 5 criteria met.`}</strong> You predicted: ${escape(predicted)}.</p>
        <ul class="ss-checks">${tested.outcome.criteria.map((criterion) => `<li data-criterion="${criterion.id}" data-pass="${criterion.pass}"><span class="ss-mark" aria-hidden="true">${criterion.pass ? "✓" : "✕"}</span><span><strong>${criterion.id} ${criterion.pass ? "met" : "not met"}</strong> · measured: ${escape(criterion.measured)}${!criterion.pass && di ? `<br><span class="ss-why-note">${escape(DI_EXPLANATIONS[criterion.id])}</span>` : ""}</span></li>`).join("")}</ul>
        <p class="ss-fine">Tested: ${escape(tested.summary)}</p>`;
    }
    if (history) {
      const earlier = this.session.attempts.slice(0, -1);
      history.innerHTML = earlier.length
        ? earlier.map((entry) => `<li>Attempt ${entry.n}: ${entry.tested ? (entry.tested.outcome.met ? `brief met${entry.explained ? " and explained" : ""}` : `${entry.tested.outcome.criteria.filter((criterion) => criterion.pass).length}/5 criteria`) : "not tested"}</li>`).join("")
        : "<li>None yet</li>";
    }
    const metEarlier = this.session.attempts.find((entry) => entry.tested?.outcome.met && entry.explained);
    if (metEarlier && metEarlier !== attempt && history) history.insertAdjacentHTML("afterbegin", `<li class="ss-milestone">Brief met and explained in attempt ${metEarlier.n}</li>`);
  }

  private setTab(tab: InspectTab, focus: boolean): void {
    this.tab = tab;
    document.querySelectorAll<HTMLButtonElement>("#sdi-tabs [data-sdi-tab]").forEach((button) => {
      const active = button.dataset.sdiTab === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });
    document.querySelector("#sdi-panel")?.setAttribute("aria-labelledby", `sdi-tab-${tab}`);
    this.renderInspector();
  }

  /** Writes `html` into `element` only when it changed since the last write there. */
  private write(element: HTMLElement, key: string, html: string): boolean {
    if (this.written.get(key) === html && element.innerHTML !== "") return false;
    this.written.set(key, html);
    element.innerHTML = html;
    return true;
  }

  private renderInspector(): void {
    const graph = this.graph;
    const signal = this.signal;
    const state = this.state;
    const diagram = document.querySelector<HTMLElement>("#sdi-diagram");
    const list = document.querySelector<HTMLElement>("#sdi-list");
    const notes = document.querySelector<HTMLElement>("#sdi-notes");
    const summary = document.querySelector<HTMLElement>("#sdi-summary");
    if (!graph || !signal || !state || !diagram || !list || !notes) return;
    const selected = this.host.selectedId();
    const showNotes = this.host.condition() === "DI" || this.session.firstTestAt !== null;
    const focused = document.activeElement?.closest?.("#sdi-diagram [data-module], #sdi-diagram [data-cable]");
    const focusKey = focused ? focused.getAttribute("data-module") ?? focused.getAttribute("data-cable") : null;
    if (this.write(diagram, "diagram", renderSoundDiagramSvg(graph, signal, { selected, showNotes })) && focusKey) diagram.querySelector<SVGElement>(`[data-module="${focusKey}"], [data-cable="${focusKey}"]`)?.focus();
    this.write(list, "list", renderConnectionList(graph, signal));
    const { shown, withheld } = faultNotes(graph, showNotes);
    this.write(notes, "notes", `${shown.map((note) => `<p><i class="ph ph-warning-circle" aria-hidden="true"></i> ${escape(note)}</p>`).join("")}${withheld ? `<p class="sd-withheld">${withheld} explanatory note${withheld === 1 ? "" : "s"} appear${withheld === 1 ? "s" : ""} after your first Test in this session (the diagram above already shows the patch as built).</p>` : ""}`);
    if (summary) summary.textContent = graph.reachesSpeaker ? (state.speakerOn ? "Tone reaches the Speaker" : "Tone reaches the Speaker · switched off") : "No tone at the Speaker";
    this.renderPart(selected);
  }

  private renderPart(selected: string | null): void {
    const panel = document.querySelector<HTMLElement>("#sdi-panel");
    const title = document.querySelector<HTMLElement>("#sdi-part-title");
    const hint = document.querySelector<HTMLElement>("#sdi-part-hint");
    const graph = this.graph;
    const signal = this.signal;
    const state = this.state;
    if (!panel || !graph || !signal || !state) return;
    const active = document.activeElement as HTMLElement | null;
    // While the learner is in a field of this card, the card is not rebuilt (their typing and
    // focus stay put); it catches up on the next render after focus leaves the field.
    if (active && panel.contains(active) && active.matches("input, textarea")) {
      return;
    }
    const activeKey = active && panel.contains(active) ? active.dataset.draft ?? active.dataset.focusKey ?? null : null;
    const caret = active instanceof HTMLInputElement ? active.selectionStart : null;
    const isModule = Boolean(selected && (["snd-source", "snd-filter", "snd-drive", "snd-speaker"] as string[]).includes(selected));
    const isCable = Boolean(selected && SOUND_CABLE_IDS.includes(selected as SoundCableId));
    if (!isModule && !isCable) {
      if (title) title.textContent = "Selected";
      if (hint) hint.hidden = false;
      this.write(panel, "part", `<p class="si-empty">Select a module or a cable in 3D, in the parts rail or on the diagram.</p>`);
      return;
    }
    if (hint) hint.hidden = true;
    const holder = this.host.holderOf(selected!);
    if (isCable) {
      const cable = selected as SoundCableId;
      if (title) this.write(title, "title", `<span class="sd-swatch" style="background:${CABLE_COLORS[cable]}" aria-hidden="true"></span> ${escape(CABLE_NAMES[cable])}`);
      if (!this.write(panel, "part", this.cableCard(cable, holder))) return;
    } else {
      const module = selected as SoundModuleId;
      if (title) this.write(title, "title", escape(MODULE_NAMES[module]));
      if (!this.write(panel, "part", this.moduleCard(module, holder))) return;
    }
    if (activeKey) {
      const target = panel.querySelector<HTMLElement>(`[data-draft="${activeKey}"], [data-focus-key="${activeKey}"]`);
      target?.focus();
      if (target instanceof HTMLInputElement && caret !== null && target.type === "text") target.setSelectionRange(caret, caret);
    }
  }

  private moduleCard(module: SoundModuleId, holder: string | null): string {
    const state = this.state!;
    const graph = this.graph!;
    const signal = this.signal!;
    const reference = MODULE_REFERENCE[module];
    const stage = signal.stages.find((entry) => entry.module === module);
    const note = this.editNote?.module === module ? `<p class="si-edit-note" data-tone="${this.editNote.tone}" role="status">${escape(this.editNote.text)}</p>` : "";
    const busy = this.pending.has(module);
    if (this.tab === "ports") {
      const rows = SOUND_JACKS.filter((jack) => jack.module === module).map((jack) => {
        const edge = graph.edges.find((entry) => entry.jacks.includes(jack.index));
        const loose = graph.loose.find((entry) => entry.jack === jack.index);
        const far = edge ? (edge.jacks[0] === jack.index ? edge.jacks[1] : edge.jacks[0]) : null;
        const tone = edge && (edge.status === "out-out" || edge.status === "in-in" || edge.status === "loop") ? "fault" : "b";
        const what = edge
          ? `${escape(CABLE_NAMES[edge.cable])} to ${escape(jackLabel(far!))} <span class="si-tone" style="color:${NET_TONES[tone].css}">(${NET_TONES[tone].description.split(",")[0]} ring on its far jack)</span> · ${escape(edge.status === "signal" ? "carries the tone" : edge.status === "idle" ? "no signal" : edge.status === "loop" ? "in a loop: silenced" : edge.status === "shared-jack" ? "shared jack: ignored" : "invalid: carries nothing")}`
          : loose ? `${escape(CABLE_NAMES[loose.cable])}, other end loose` : "nothing patched";
        return `<li><strong>${jack.port.toUpperCase()}</strong> <span class="si-tone" style="color:${NET_TONES.a.css}">(amber solid ring)</span> · ${what}</li>`;
      }).join("");
      return `<ul class="si-ports">${rows}</ul><p class="si-fine">Signal flows from OUT to IN. One plug per jack.</p>`;
    }
    if (this.tab === "behavior") {
      return `<h4>Behaviour</h4><ul>${reference.behaviour.map((line) => `<li>${escape(line)}</li>`).join("")}</ul><h4>Limits</h4><ul>${reference.limits.map((line) => `<li>${escape(line)}</li>`).join("")}</ul><p class="si-fine">An educational signal abstraction: not SPICE, not an acoustic room model.</p>`;
    }
    const level = stage && stage.peak > 1e-6 ? `${formatDb(toDb(stage.peak))} peak at its ${module === "snd-speaker" ? "input" : "output"}` : graph.loops.flat().includes(module) ? "silenced (feedback loop)" : "no signal";
    const lock = holder ? `<p class="si-edit-note" data-tone="warning">${escape(holder)} is holding this module; edits wait until they let go.</p>` : "";
    let controls = "";
    const dis = holder || busy ? "disabled" : "";
    const numeric = (param: "hz" | "cutoff" | "gain", label: string, unit: string): string => {
      const key = `${module}:${param}`;
      const drafted = this.drafts.has(key);
      const bounds = SOUND_BOUNDS[param];
      return `<div class="si-field"><label for="sdi-${param}">${label}</label>
        <div class="si-stepper">
          <button type="button" class="tool-button" data-step="${key}" data-delta="${param === "gain" ? -0.05 : -1}" data-focus-key="down-${key}" aria-label="Lower ${label}" ${dis}><i class="ph ph-minus" aria-hidden="true"></i></button>
          <input id="sdi-${param}" type="text" inputmode="decimal" data-draft="${key}" value="${escape(this.draftValue(module, param))}" aria-describedby="sdi-${param}-range" ${dis}>
          <span class="si-unit">${unit}</span>
          <button type="button" class="tool-button" data-step="${key}" data-delta="${param === "gain" ? 0.05 : 1}" data-focus-key="up-${key}" aria-label="Raise ${label}" ${dis}><i class="ph ph-plus" aria-hidden="true"></i></button>
        </div>
        <small id="sdi-${param}-range">${bounds.min}–${bounds.max}${unit ? ` ${unit}` : ""}${param === "gain" ? ` · now ${formatGain(state.drive.gain)}` : ` · room: ${param === "hz" ? state.source.hz : state.filter.cutoff} Hz`}${drafted ? " · <strong>draft, not applied</strong>" : ""}</small></div>`;
    };
    if (module === "snd-source") {
      const wave = this.draftValue("snd-source", "wave");
      controls = `${numeric("hz", "Frequency", "Hz")}
        <fieldset class="si-field si-waves"><legend>Waveform${this.drafts.has("snd-source:wave") ? " · draft" : ""}</legend>${SOUND_WAVES.map((value) => `<label><input type="radio" name="sdi-wave" value="${value}" data-focus-key="wave-${value}" ${value === wave ? "checked" : ""} ${dis}> ${value}</label>`).join("")}</fieldset>`;
    } else if (module === "snd-filter") controls = numeric("cutoff", "Cutoff", "Hz");
    else if (module === "snd-drive") controls = numeric("gain", "Gain", "×");
    const form = module === "snd-speaker"
      ? `<div class="si-field"><span>Power (shared): <strong>${state.speakerOn ? "on" : "off"}</strong></span>
          <button type="button" class="secondary-button" data-speaker-switch="${state.speakerOn ? "off" : "on"}" data-focus-key="speaker" ${dis}>Switch ${state.speakerOn ? "off" : "on"} for everyone</button></div>`
      : `<form class="si-form" data-module="${module}">${controls}
          <div class="si-actions"><button type="submit" class="primary-button compact" data-apply="${module}" data-focus-key="apply-${module}" ${dis}>${busy ? "Sending…" : "Apply to the room"}</button><button type="button" class="bare-button" data-revert="${module}" data-focus-key="revert-${module}" ${[...this.drafts.keys()].some((key) => key.startsWith(`${module}:`)) ? "" : "disabled"}>Discard draft</button></div></form>`;
    return `<p>${escape(reference.role)}</p><p class="si-level">Now: ${escape(level)}.</p>${lock}${form}${note}`;
  }

  private cableCard(cable: SoundCableId, holder: string | null): string {
    const graph = this.graph!;
    const edge = graph.edges.find((entry) => entry.cable === cable);
    const loose = graph.loose.find((entry) => entry.cable === cable);
    const ends = this.host.workbench()?.getSharedTransforms()[cable]?.sockets ?? null;
    const endWords = (index: 0 | 1): string => {
      const jack = ends?.[index];
      return jack === null || jack === undefined ? "free (on the mat or loose)" : jackLabel(jack);
    };
    if (this.tab === "ports") {
      return `<ul class="si-ports"><li><strong>End A</strong> <span class="si-tone" style="color:${NET_TONES.a.css}">(amber solid ring)</span> · ${escape(endWords(0))}</li><li><strong>End B</strong> <span class="si-tone" style="color:${NET_TONES.b.css}">(cyan dashed ring)</span> · ${escape(endWords(1))}</li></ul><p class="si-fine">A wrong cable's jacks get a red double ring.</p>`;
    }
    if (this.tab === "behavior") {
      return `<ul><li>Ideal patch cable: no loss, no noise, no delay.</li><li>Signal flows from the OUT end to the IN end, whichever plug is which.</li><li>One plug per jack (the room refuses a second plug).</li><li>A real 3.5 mm patch cable has about 100 pF per metre: negligible at audio frequencies, so it is not modelled.</li></ul>`;
    }
    const status = edge
      ? edge.status === "signal" ? "carries the tone" : edge.status === "idle" ? "connected, but no signal reaches it" : edge.status === "loop" ? "part of a feedback loop: silenced" : edge.status === "shared-jack" ? "shares a jack: ignored" : edge.status === "out-out" ? "joins two outputs: carries nothing" : "joins two inputs: carries nothing"
      : loose ? "one end is loose: carries nothing" : "not plugged in";
    return `<p>${escape(`${endWords(0)} ↔ ${endWords(1)}`)}</p><p class="si-level">Now: ${escape(status)}.</p>${holder ? `<p class="si-edit-note" data-tone="warning">${escape(holder)} is holding this cable.</p>` : ""}
      <p class="si-fine">Drag either plug in 3D into a jack. Plugging is shared with everyone.</p>
      <button type="button" class="secondary-button compact" data-mat="${cable}" data-focus-key="mat" ${holder || (!edge && !loose) ? "disabled" : ""}>Unplug and return to the mat</button>`;
  }

  // ── Session (this learner's own, never exported) ────────────────────────────────────

  private storageKey(): string {
    return `vm-sound:${this.host.roomCode()}`;
  }

  private loadSession(): Session {
    try {
      const raw = sessionStorage.getItem(this.storageKey());
      if (raw) {
        const parsed = JSON.parse(raw) as Session;
        if (Array.isArray(parsed.attempts) && parsed.attempts.length) return { attempts: parsed.attempts.slice(-20), firstTestAt: typeof parsed.firstTestAt === "number" ? parsed.firstTestAt : null };
      }
    } catch {
      // A per-learner convenience; a fresh session works without it.
    }
    return { attempts: [{ n: 1, prediction: null, why: "", tested: null, explanation: "", explained: false }], firstTestAt: null };
  }

  private saveSession(): void {
    try {
      sessionStorage.setItem(this.storageKey(), JSON.stringify(this.session));
    } catch {
      // Not critical.
    }
  }

  /** QA: what the panel shows (no private text). */
  qaState(): { attempt: number; tested: boolean; met: boolean | null; criteria: Array<{ id: string; pass: boolean; measured: string }> | null; explained: boolean; notesUnlocked: boolean; display: { reaches: boolean; clipped: boolean; peak: number; source: string } | null; audio: AudioStatus; muted: boolean; volume: number; contexts: number; drafts: Record<string, string> } {
    const attempt = this.current();
    return {
      attempt: attempt.n,
      tested: Boolean(attempt.tested),
      met: attempt.tested ? attempt.tested.outcome.met : null,
      criteria: attempt.tested ? attempt.tested.outcome.criteria.map((criterion) => ({ id: criterion.id, pass: criterion.pass, measured: criterion.measured })) : null,
      explained: attempt.explained,
      notesUnlocked: this.host.condition() === "DI" || this.session.firstTestAt !== null,
      display: this.lastDisplay ? { reaches: this.lastDisplay.reaches, clipped: this.lastDisplay.clipped, peak: this.lastDisplay.peak, source: this.lastDisplay.source } : null,
      audio: this.engine.status,
      muted: this.engine.isMuted,
      volume: this.engine.volumeLevel,
      contexts: this.engine.contextsCreated,
      drafts: Object.fromEntries(this.drafts),
    };
  }
}
