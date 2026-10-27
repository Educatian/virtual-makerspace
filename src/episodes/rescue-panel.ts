/**
 * Rescue Signal Workshop — the episode panel and its timing driver (desktop).
 *
 * Everything shown here is derived from the room's episode state (rescue-state.ts) with the
 * pure signal functions (rescue-signal.ts). The panel never decides an outcome by itself.
 *
 * The lamp on the 3D bench: while a transmission runs, this driver sets the Snapino pins from
 * the round's program at the room's elapsed time (`room.serverTime() - startedAt`), and the
 * scene evaluates the lamp with the same circuit model the round is scored with. Nothing is
 * sent over the network per frame; each client computes the same pins from the same state.
 * A hidden tab simply jumps to the right point when it is shown again (and the receiver is
 * told part of the signal was not watched). Replay is local and drawn in the panel, never on
 * the bench, so it can't be mistaken for a new transmission.
 *
 * Condition boundaries: the protocol — the vocabulary (which flashes make which word) AND its
 * timing bands — is a task rule, shown to both roles in both conditions: the decoder judges every
 * team against these bands, so a PF team must be able to see them. The worked example (one set
 * of timings that works) and the "write blocks for this message" helper are solution guidance and
 * are shown only in DI. Diagnoses are factual measurements, shown in the comparison after the
 * receiver has committed a first reading (and to a lone sender in the solo check).
 */
import type { DesktopRoom } from "../desktop/collaboration.js";
import type { DesktopWorkbenchScene } from "../desktop/scene.js";
import { LOW_PINS, MAX_STATEMENTS, type PinStates, type SnapinoStatement } from "../desktop/snapino.ts";
import { analyzeSnapino, lightDrivers } from "../circuit/snapino-circuit.ts";
import {
  compare,
  compileMessage,
  decode,
  diagnose,
  lightPulses,
  MAX_WORDS,
  MISSIONS,
  pinsAt,
  programDurationMs,
  RECOMMENDED,
  TIMING,
  transmissionEnd,
  wiredPin,
  WORD_LIST,
  WORDS,
  type Comparison,
  type Decoded,
  type LightPulse,
  type Reading,
  type Transmission,
  type Word,
} from "./rescue-signal.ts";
import { roleOf, transmitting, type RescueRound, type RescueState, type Role } from "./rescue-state.ts";

export interface EpisodeHost {
  room(): DesktopRoom | null;
  workbench(): DesktopWorkbenchScene | null;
  /** The panel only lives in the Snapino studio. */
  inSnapino(): boolean;
  condition(): "PF" | "DI";
  /** The code editor's program (its draft if edited, else the room's). */
  editorProgram(): SnapinoStatement[];
  /** Puts blocks into this participant's code editor (not shared until transmitted or run). */
  loadEditor(program: SnapinoStatement[]): void;
  openCodeEditor(): void;
  /** True while a transmission (not Run's endless loop) drives the pins. */
  setTransmitting(active: boolean): void;
  setPins(pins: PinStates): void;
  /** Human participants currently in the room (including this one). */
  humans(): number;
  status(message: string, tone: "neutral" | "valid" | "warning"): void;
  trace(action: "role" | "test" | "reflect", detail: string): void;
  confirm(title: string, body: string, ok: string): Promise<boolean>;
  layoutChanged(): void;
  /** The panel appeared (workshop opened in the Snapino studio) or went away. */
  shown?(visible: boolean): void;
  /** QA only: called every driven frame with the elapsed transmission time. */
  probe?(elapsedMs: number): void;
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const flashGlyph = (flash: string): string => (flash === "S" ? "●" : flash === "L" ? "▬" : "?");
const pattern = (word: Word): string => WORDS[word].map(flashGlyph).join(" ");

const REFUSALS: Record<string, string> = {
  "not-sender": "Only the sender can do that.",
  "not-receiver": "Only the receiver can record the reading.",
  "not-in-role": "Take a role first.",
  "role-taken": "Someone else already has that role.",
  "one-role": "You already have the other role — swap roles instead.",
  transmitting: "Wait until the transmission has ended (or stop it).",
  "round-open": "Close the current round first.",
  "no-intent": "Choose the intended message first.",
  "bad-program": "The blocks must take between 0 and 120 seconds.",
  "no-round": "Nothing has been transmitted yet.",
  "stale-round": "That round has already changed — refreshing.",
  "not-ended": "Wait until the transmission has ended.",
  "already-read": "The first reading is already recorded.",
  "no-reading": "The receiver hasn't recorded a reading yet.",
  "sent-this-round": "You transmitted this round, so you know its message — someone else reads it.",
  inactive: "The workshop isn't open in this room.",
  offline: "Reconnecting to the room — nothing changed.",
  timeout: "The room didn't answer in time — nothing changed here.",
  disconnected: "Not connected to the room.",
};

const OUTCOME_COPY: Record<Comparison["outcome"], { title: string; tone: "valid" | "warning" | "neutral" }> = {
  delivered: { title: "Message delivered", tone: "valid" },
  "no-signal": { title: "No light reached the receiver", tone: "warning" },
  "ambiguous-signal": { title: "The signal was ambiguous under the protocol", tone: "warning" },
  "signal-differs": { title: "The signal said something other than intended", tone: "warning" },
  "read-differently": { title: "The signal was read differently", tone: "warning" },
};

export interface RoundView {
  transmission: Transmission;
  pulses: LightPulse[];
  decoded: Decoded;
}

/** Everything derived from one round (pure). */
export function roundView(round: RescueRound): RoundView {
  const transmission: Transmission = { program: round.program, bench: round.bench, durationMs: round.durationMs, stoppedAtMs: round.stoppedAtMs, stopReason: round.stopReason };
  const pulses = lightPulses(transmission);
  return { transmission, pulses, decoded: decode(pulses) };
}

export interface Phase {
  /** Index into the stepper (Roles, Design & build, Transmit, Read, Compare & explain). */
  step: number;
  label: string;
  tone: "neutral" | "valid" | "warning";
}

/**
 * The header pill and the stepper describe the CURRENT round only. An earlier delivered round
 * is a milestone shown in the round history ("Workshop goal met in round n"), never as the
 * state of a later round that is running, unread, ambiguous, cut off or without light.
 */
export function currentPhase(state: RescueState, running: boolean): Phase {
  const round = state.round;
  if (round) {
    if (running) return { step: 2, label: "Transmitting", tone: "warning" };
    if (!round.reading) return { step: 3, label: "Reading", tone: "neutral" };
    const result = compare(round.intent, roundView(round).decoded, round.reading.words);
    return result.delivered ? { step: 4, label: "Delivered", tone: "valid" } : { step: 4, label: "Not delivered", tone: "warning" };
  }
  if (!state.roles.sender) return { step: 0, label: "Choose roles", tone: "neutral" };
  return { step: 1, label: state.history.length ? `Round ${state.history.length + 1} · design` : "Design", tone: "neutral" };
}

/** Completed = a round whose message was delivered and that the team explained. */
export function deliveredRound(state: RescueState): RescueRound | null {
  return [...state.history, ...(state.round ? [state.round] : [])].find((round) =>
    round.reading && round.explanation.trim().length > 0 && compare(round.intent, roundView(round).decoded, round.reading.words).delivered) ?? null;
}

export class RescueEpisode {
  private readonly host: EpisodeHost;
  private state: RescueState | null = null;
  private frame = 0;
  private lastPinsKey = "";
  private collapsed = false;
  private draftReading: Reading = [];
  private confidence: "sure" | "unsure" = "sure";
  /** Local replay of one transmission's recorded light (keyed by its tx). */
  private replay: { tx: number; startedAt: number } | null = null;
  /** Transmissions (by tx) during which this tab was hidden at some point. */
  private hiddenDuring = new Set<number>();
  private busy = false;
  private lastRenderKey = "";
  private disposed = false;
  private readonly onVisibility = (): void => {
    const round = this.state?.round;
    if (document.hidden && round && this.state && transmitting(this.state, this.serverNow())) this.hiddenDuring.add(round.tx);
    this.schedule();
  };

  constructor(host: EpisodeHost) {
    this.host = host;
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  static markup(): string {
    return `<section class="episode-panel" id="episode-panel" hidden aria-labelledby="episode-title">
      <button class="episode-toggle" id="episode-toggle" type="button" aria-expanded="true" aria-controls="episode-body">
        <i class="ph ph-broadcast" aria-hidden="true"></i>
        <span class="episode-title" id="episode-title">Rescue Signal Workshop</span>
        <span class="episode-pill" id="episode-pill" data-tone="neutral">Episode 1</span>
        <i class="ph ph-caret-down episode-chevron" aria-hidden="true"></i>
      </button>
      <div class="episode-body" id="episode-body"></div>
    </section>`;
  }

  bind(): void {
    document.querySelector("#episode-toggle")?.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      this.lastRenderKey = "";
      this.render();
      this.host.layoutChanged();
    });
    document.querySelector("#episode-body")?.addEventListener("click", (event) => void this.onClick(event as MouseEvent));
    document.querySelector("#episode-body")?.addEventListener("change", (event) => this.onChange(event));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.host.setTransmitting(false);
  }

  /** The room's episode state changed. */
  setState(state: RescueState): void {
    const previous = this.state;
    this.state = state;
    // A draft reading belongs to the transmission it was made for: a retransmission (new tx),
    // another round, a reset or a recorded reading discards it.
    if (previous?.round?.tx !== state.round?.tx || (previous?.round?.reading === null) !== (state.round?.reading === null)) {
      this.draftReading = [];
      this.confidence = "sure";
    }
    if (this.replay && this.replay.tx !== state.round?.tx) this.replay = null;
    // A transmission that starts (or is joined) while this tab is hidden was missed in part too:
    // animation frames do not run in a hidden tab, so this cannot wait for the next tick.
    if (document.hidden && state.round && transmitting(state, this.serverNow())) this.hiddenDuring.add(state.round.tx);
    if (!state.round && !state.history.length) this.hiddenDuring.clear();
    this.lastRenderKey = "";
    this.schedule();
  }

  /** Studio or layout changed. */
  refresh(): void {
    this.lastRenderKey = "";
    this.schedule();
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.lastRenderKey = "";
    this.render();
    this.host.layoutChanged();
  }

  get active(): boolean {
    return Boolean(this.state?.active);
  }

  /**
   * Whether the live diagram may annotate wiring faults. DI: always. PF: the team explores first,
   * so notes wait until a round has been compared (a reading given, or a lone sender's solo check)
   * or closed. The diagram itself
   * always shows every connection as built, in both conditions.
   */
  diagramFaultsAllowed(): boolean {
    const state = this.state;
    if (!state?.active || this.host.condition() === "DI") return true;
    if (state.history.length > 0 || state.round?.reading) return true;
    // A lone sender gets the solo check once the transmission ends; the notes come with it.
    const me = this.host.room()?.participant.id ?? "";
    return Boolean(state.round && !transmitting(state, this.serverNow()) && roleOf(state, me) === "sender" && this.host.humans() < 2);
  }

  async open(): Promise<void> {
    const room = this.host.room();
    if (!room) return;
    if (this.state?.active) return;
    const result = await room.episodeAction({ type: "open" });
    if (!result.ok) this.host.status(REFUSALS[result.reason] ?? "The workshop could not be opened.", "warning");
  }

  // ── Timing driver ──────────────────────────────────────────────────────────────────────

  private serverNow(): number {
    return this.host.room()?.serverTime() ?? Date.now();
  }

  private schedule(): void {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.tick();
    });
  }

  /**
   * Called by the 3D bench immediately before it renders each frame, so the lamp in that frame
   * shows the shared timeline at that frame's time (not the previous frame's state).
   */
  driveFrame(): void {
    if (this.disposed) return;
    const state = this.state;
    const now = this.serverNow();
    const running = Boolean(state?.active && this.host.inSnapino() && transmitting(state!, now));
    const round = state?.round;
    if (running && round) {
      const elapsed = now - round.startedAt;
      const input = analyzeSnapino(round.bench, LOW_PINS).inputHigh;
      const pins = pinsAt(round.program, input, elapsed, transmissionEnd(round));
      this.drive(pins, true);
      this.host.probe?.(elapsed);
    } else {
      this.drive({ ...LOW_PINS }, false);
    }
  }

  private tick(): void {
    if (this.disposed) return;
    const state = this.state;
    const now = this.serverNow();
    const running = Boolean(state?.active && this.host.inSnapino() && transmitting(state!, now));
    this.render();
    // Keep ticking while something moves (a transmission, a replay); otherwise rest.
    if (running || this.replay) this.schedule();
  }

  private drive(pins: PinStates, transmittingNow: boolean): void {
    const key = `${transmittingNow}:${pins.D3}${pins.D5}${pins.D6}`;
    if (key === this.lastPinsKey) return;
    const wasTransmitting = this.lastPinsKey.startsWith("true");
    this.lastPinsKey = key;
    if (transmittingNow) this.host.setTransmitting(true);
    if (transmittingNow || wasTransmitting) this.host.setPins(pins);
    if (!transmittingNow) this.host.setTransmitting(false);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────────────────

  private render(): void {
    const panel = document.querySelector<HTMLElement>("#episode-panel");
    const body = document.querySelector<HTMLElement>("#episode-body");
    if (!panel || !body) return;
    const state = this.state;
    const visible = this.host.inSnapino() && Boolean(state?.active);
    if (panel.hidden === visible) {
      panel.hidden = !visible;
      this.host.shown?.(visible);
      this.host.layoutChanged();
    }
    if (!visible || !state) return;
    panel.classList.toggle("is-collapsed", this.collapsed);
    document.querySelector("#episode-toggle")?.setAttribute("aria-expanded", String(!this.collapsed));
    body.hidden = this.collapsed;
    const room = this.host.room();
    const me = room?.participant.id ?? "";
    const role = roleOf(state, me);
    const now = this.serverNow();
    const running = transmitting(state, now);
    const pill = document.querySelector<HTMLElement>("#episode-pill");
    const phase = this.phase(state, running);
    if (pill) {
      pill.textContent = phase.label;
      pill.dataset.tone = phase.tone;
    }
    // Re-render the body only when something visible changed — never every frame (buttons
    // would be replaced under the pointer) and never while the learner types an explanation.
    const workbench = this.host.workbench();
    const liveBench = workbench ? JSON.stringify(workbench.snapinoBench()) : "";
    const key = JSON.stringify([state.rev, role, running, this.host.humans(), this.replay?.tx ?? null, this.draftReading, this.confidence, this.busy, liveBench, JSON.stringify(this.host.editorProgram()), this.hiddenDuring.has(state.round?.tx ?? -1), this.collapsed]);
    const active = document.activeElement;
    const typing = Boolean(active && body.contains(active) && active.matches("textarea"));
    if (key !== this.lastRenderKey && !typing) {
      this.lastRenderKey = key;
      body.innerHTML = [
        this.stepsHtml(phase.step),
        this.rolesHtml(state, me, role, running),
        this.mainHtml(state, role, running, now),
        this.historyHtml(state, me),
      ].join("");
      // One room action at a time: while one is in flight every action button is visibly off,
      // so a quick second click is never silently dropped or built on a not-yet-updated state.
      body.setAttribute("aria-busy", String(this.busy));
      if (this.busy) for (const button of body.querySelectorAll<HTMLButtonElement>("button[data-episode]")) button.disabled = true;
    }
    this.updateLive(body, state, now);
  }

  /** The moving parts (progress, replay playhead and lamp), updated in place each frame. */
  private updateLive(body: HTMLElement, state: RescueState, now: number): void {
    const round = state.round;
    if (!round) return;
    const elapsed = Math.max(0, Math.min(round.durationMs, now - round.startedAt));
    const bar = body.querySelector<HTMLElement>("[data-progress]");
    if (bar) bar.style.width = `${(elapsed / round.durationMs) * 100}%`;
    const time = body.querySelector<HTMLElement>("[data-elapsed]");
    if (time) time.textContent = seconds(elapsed);
    if (this.replay?.tx === round.tx) {
      const view = roundView(round);
      const end = transmissionEnd(view.transmission);
      const at = performance.now() - this.replay.startedAt;
      if (at > end + 400) {
        this.replay = null;
        this.lastRenderKey = "";
        this.schedule();
        return;
      }
      const head = body.querySelector<HTMLElement>(".strip-head");
      if (head) head.style.left = `${Math.min(100, (at / Math.max(1, end)) * 100)}%`;
      const lamp = body.querySelector<HTMLElement>(".replay-lamp");
      lamp?.classList.toggle("is-lit", view.pulses.some((pulse) => at >= pulse.start && at < pulse.end));
    }
  }

  private phase(state: RescueState, running: boolean): Phase {
    return currentPhase(state, running);
  }

  private stepsHtml(step: number): string {
    const steps = ["Roles", "Design & build", "Transmit", "Read", "Compare & explain"];
    return `<ol class="episode-steps" aria-label="Workshop steps">${steps.map((label, index) => `<li class="${index < step ? "is-done" : index === step ? "is-current" : ""}"${index === step ? ' aria-current="step"' : ""}>${escape(label)}</li>`).join("")}</ol>`;
  }

  private rolesHtml(state: RescueState, me: string, role: Role | null, running: boolean): string {
    const slot = (name: Role, label: string, icon: string) => {
      const holder = state.roles[name];
      const mine = holder?.id === me;
      const action = mine
        ? `<button class="bare-button compact" type="button" data-episode="release-role" data-role="${name}">Leave role</button>`
        : !holder && !role
          ? `<button class="secondary-button compact" type="button" data-episode="claim-role" data-role="${name}">Take</button>`
          : "";
      return `<div class="episode-role${mine ? " is-mine" : ""}"><i class="ph ${icon}" aria-hidden="true"></i><span><small>${label}</small><strong>${holder ? escape(holder.name) + (mine ? " (you)" : "") : "open"}</strong></span>${action}</div>`;
    };
    const swap = role && state.roles.sender && state.roles.receiver && !running
      ? `<button class="bare-button compact" type="button" data-episode="swap-roles"><i class="ph ph-arrows-left-right" aria-hidden="true"></i> Swap roles</button>`
      : "";
    const solo = this.host.humans() < 2
      ? `<p class="episode-note"><i class="ph ph-user" aria-hidden="true"></i> No teammate here yet. As the sender you can transmit and check your signal yourself (solo check); a receiver's reading needs a second person.</p>`
      : "";
    return `<div class="episode-roles">${slot("sender", "Sender", "ph-flashlight")}${slot("receiver", "Receiver", "ph-eye")}</div>${swap ? `<div class="episode-row">${swap}</div>` : ""}${solo}`;
  }

  private mainHtml(state: RescueState, role: Role | null, running: boolean, now: number): string {
    const round = state.round;
    if (running && round) return this.transmittingHtml(round, role, now);
    if (!round) return role === "sender" ? this.designHtml(state) : this.waitingHtml(state, role);
    if (!round.reading) return this.afterTransmissionHtml(state, round, role);
    return this.compareHtml(state, round, role);
  }

  private protocolHtml(_state: RescueState, open: boolean): string {
    // The bands are task rules (both conditions). Choosing timings inside them is the team's job;
    // only DI also gets a worked example of timings that work.
    const worked = this.host.condition() === "DI"
      ? `<p class="episode-fine episode-worked">Worked example: short ${RECOMMENDED.short} ms, long ${RECOMMENDED.long} ms, gap ${RECOMMENDED.gap} ms, pause ${RECOMMENDED.pause} ms (the timings "Write blocks" uses).</p>`
      : "";
    const timing = `<dl class="episode-timing"><div><dt>● short</dt><dd>${TIMING.shortMin}–${TIMING.shortMax} ms of light</dd></div><div><dt>▬ long</dt><dd>${TIMING.longMin}–${TIMING.longMax} ms</dd></div><div><dt>gap in a word</dt><dd>${TIMING.gapMin}–${TIMING.gapMax} ms dark</dd></div><div><dt>pause between words</dt><dd>${TIMING.pauseMin} ms or more dark</dd></div></dl>
         <p class="episode-fine">Anything outside these bands is ambiguous. A flash is light from a lamp or LED the circuit actually powers.</p>${worked}`;
    return `<details class="episode-protocol"${open ? " open" : ""}><summary><i class="ph ph-book-open" aria-hidden="true"></i> Rescue Flash Code v1</summary>
      <ul class="episode-vocab">${WORD_LIST.map((word) => `<li><strong>${word}</strong><span aria-label="${WORDS[word].map((flash) => (flash === "S" ? "short" : "long")).join(" ")}">${pattern(word)}</span></li>`).join("")}</ul>
      ${timing}</details>`;
  }

  private designHtml(state: RescueState): string {
    const mission = MISSIONS.find((item) => item.id === state.mission) ?? MISSIONS[0];
    const workbench = this.host.workbench();
    const bench = workbench?.snapinoBench() ?? {};
    const drivers = lightDrivers(bench);
    const lights = drivers.lights.filter((light) => light.seated).map((light) => `${light.id === "sno-l1" ? "Lamp L1" : "LED D1"}: ${light.bypassed ? "both ends on one net (bridged)" : !light.grounded ? "no end on GND" : light.always ? "5V → GND (always on)" : light.pins.length ? `${light.pins.join("/")} → GND` : "GND, other end on no D pin"}`);
    const program = this.host.editorProgram();
    const duration = programDurationMs(program);
    const helper = this.host.condition() === "DI"
      ? `<button class="secondary-button compact" type="button" data-episode="write-blocks" ${state.intent.length ? "" : "disabled"}><i class="ph ph-magic-wand" aria-hidden="true"></i> Write blocks for this message</button>`
      : "";
    const ready = state.intent.length > 0 && duration > 0;
    return `<section class="episode-section" aria-label="Design the message">
      <h3>1 · Mission</h3>
      <div class="episode-missions" role="radiogroup" aria-label="Mission">${MISSIONS.map((item) => `<button type="button" role="radio" aria-checked="${item.id === mission.id}" class="episode-mission${item.id === mission.id ? " is-selected" : ""}" data-episode="mission" data-mission="${item.id}"><strong>${escape(item.title)}</strong></button>`).join("")}</div>
      <p class="episode-situation">${escape(mission.situation)}</p>
      <h3>2 · Intended message <small>(only you see this until the receiver has read)</small></h3>
      <div class="episode-words" aria-label="Intended words">${state.intent.length ? state.intent.map((word, index) => `<span class="episode-chip">${word}<small>${pattern(word)}</small><button type="button" aria-label="Remove ${word}" data-episode="intent-remove" data-index="${index}"><i class="ph ph-x"></i></button></span>`).join("") : '<span class="episode-empty">No words yet</span>'}</div>
      <div class="episode-palette" aria-label="Add a word">${WORD_LIST.map((word) => `<button type="button" class="preset" data-episode="intent-add" data-word="${word}" ${state.intent.length >= MAX_WORDS ? "disabled" : ""}>${word}</button>`).join("")}</div>
      ${this.protocolHtml(state, false)}
      <h3>3 · Transmitter</h3>
      <p class="episode-fine">${lights.length ? escape(lights.join(" · ")) : "No lamp or LED on the base yet. Snap Lamp L1 (or LED D1) from a D pin to GND."}${drivers.short ? " · 5V is shorted to GND" : ""}</p>
      <p class="episode-fine">Blocks in your editor: ${program.length} · ${seconds(duration)} when run once.</p>
      <div class="episode-row">${helper}<button class="bare-button compact" type="button" data-episode="open-code"><i class="ph ph-code-block" aria-hidden="true"></i> Edit blocks</button></div>
      <button class="primary-button episode-primary" type="button" data-episode="transmit" ${ready && !this.busy ? "" : "disabled"}><i class="ph ph-broadcast" aria-hidden="true"></i> Transmit once</button>
      <p class="episode-fine">Transmitting sends your blocks to the room and runs them once from the top on the shared bench. Changing a Snapino part or the program during a transmission ends it.</p>
    </section>`;
  }

  private waitingHtml(state: RescueState, role: Role | null): string {
    return `<section class="episode-section"><p class="episode-situation">${role === "receiver"
      ? "You are the receiver. When the sender transmits, watch the bench's lamp — the signal is the light itself."
      : state.roles.sender ? "Waiting for the sender to transmit." : "Take a role to start."}</p>
      ${role === "receiver" ? `<button class="secondary-button compact" type="button" data-episode="receiver-view"><i class="ph ph-binoculars" aria-hidden="true"></i> Receiver's view</button>` : ""}
      ${this.protocolHtml(state, role === "receiver")}</section>`;
  }

  private transmittingHtml(round: RescueRound, role: Role | null, now: number): string {
    const elapsed = Math.max(0, now - round.startedAt);
    return `<section class="episode-section" aria-live="polite">
      <p class="episode-live"><span class="episode-beacon" aria-hidden="true"></span> Round ${round.n} · transmitting <span data-elapsed>${seconds(Math.min(elapsed, round.durationMs))}</span> / ${seconds(round.durationMs)}</p>
      <div class="episode-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${round.durationMs}" aria-valuenow="${Math.round(elapsed)}"><span data-progress style="width:${Math.min(100, (elapsed / round.durationMs) * 100)}%"></span></div>
      <p class="episode-fine">${role === "receiver" ? "Watch Lamp L1 on the bench. Note what you see; you record your reading when it ends." : "Your transmitter is running on the shared bench."}</p>
      <div class="episode-row">${role === "receiver" ? `<button class="secondary-button compact" type="button" data-episode="receiver-view"><i class="ph ph-binoculars" aria-hidden="true"></i> Receiver's view</button>` : ""}<button class="bare-button compact is-danger" type="button" data-episode="stop"><i class="ph ph-stop" aria-hidden="true"></i> Stop</button></div>
    </section>`;
  }

  private stripHtml(view: RoundView, labelled: boolean, playhead: number | null): string {
    const end = Math.max(1, transmissionEnd(view.transmission));
    const bars = view.pulses.map((pulse, index) => {
      const flash = view.decoded.flashes[index];
      const label = labelled ? `<b>${flashGlyph(flash.kind)}</b>` : "";
      // A light still on when the recording ended has an open right edge (no falling edge).
      const title = pulse.continues
        ? `${pulse.end - pulse.start} ms recorded; still lit after the transmission ended`
        : pulse.unrecorded
          ? `${pulse.end - pulse.start} ms recorded; still lit when a bench change cut the recording off (not recorded after that)`
          : `${pulse.end - pulse.start} ms`;
      return `<span class="strip-flash${labelled && flash.kind === "?" ? " is-ambiguous" : ""}${pulse.continues || pulse.unrecorded ? " is-continuing" : ""}" style="left:${(pulse.start / end) * 100}%;width:${Math.max(0.6, ((pulse.end - pulse.start) / end) * 100)}%" title="${title}">${label}</span>`;
    }).join("");
    // At most about eight labels, whatever the length (1, 2, 5, 10, 20, 30 or 60 s apart).
    const step = [1, 2, 5, 10, 20, 30, 60].find((candidate) => end / (candidate * 1000) <= 8) ?? 60;
    const ticks = Array.from({ length: Math.floor(end / (step * 1000)) + 1 }, (_, index) => `<i style="left:${((index * step * 1000) / end) * 100}%">${index * step}s</i>`).join("");
    const head = playhead === null ? "" : `<span class="strip-head" style="left:${Math.min(100, (playhead / end) * 100)}%"></span>`;
    return `<div class="episode-strip" role="img" aria-label="Recorded light: ${view.pulses.length} flash${view.pulses.length === 1 ? "" : "es"} over ${seconds(end)}">${bars}${head}<div class="strip-ticks">${ticks}</div></div>`;
  }

  private replayHtml(round: RescueRound, view: RoundView): string {
    const playing = this.replay?.tx === round.tx;
    return `<div class="episode-replay"><span class="replay-lamp" aria-hidden="true"></span>
      <button class="secondary-button compact" type="button" data-episode="replay"><i class="ph ${playing ? "ph-stop" : "ph-play"}" aria-hidden="true"></i> ${playing ? "Stop replay" : "Replay the recorded light"}</button>
      <span class="episode-fine">Replay shows the recorded light here, not on the bench.</span></div>
      ${this.stripHtml(view, false, playing ? 0 : null)}`;
  }

  private afterTransmissionHtml(state: RescueState, round: RescueRound, role: Role | null): string {
    const view = roundView(round);
    const stopped = round.stoppedAtMs !== null && round.stoppedAtMs < round.durationMs;
    const reason = round.stopReason === "bench-changed" ? "a Snapino part was changed" : round.stopReason === "program-changed" ? "the program was changed" : round.stopReason === "room-empty" ? "everyone left" : "it was stopped";
    const head = `<p class="episode-live">Round ${round.n} · transmission ${stopped ? `cut off at ${seconds(transmissionEnd(view.transmission))} (${reason})` : "ended"}${round.transmissions > 1 ? ` · transmission ${round.transmissions}` : ""}</p>`;
    if (role === "receiver") {
      const missed = this.hiddenDuring.has(round.tx)
        ? `<p class="episode-note is-warning"><i class="ph ph-eye-slash" aria-hidden="true"></i> This tab was hidden during part of the transmission. Replay the recorded light before you read it.</p>`
        : "";
      const options = [...WORD_LIST, "?"] as (Word | "?")[];
      return `<section class="episode-section">${head}${missed}${this.replayHtml(round, view)}
        <h3>Your first reading <small>(it is final once recorded)</small></h3>
        <div class="episode-words" aria-label="Your reading">${this.draftReading.length ? this.draftReading.map((word, index) => `<span class="episode-chip">${word === "?" ? "unclear" : word}<button type="button" aria-label="Remove" data-episode="reading-remove" data-index="${index}"><i class="ph ph-x"></i></button></span>`).join("") : '<span class="episode-empty">Add the words you saw, in order</span>'}</div>
        <div class="episode-palette">${options.map((word) => `<button type="button" class="preset" data-episode="reading-add" data-word="${word}" ${this.draftReading.length >= MAX_WORDS ? "disabled" : ""}>${word === "?" ? "unclear word" : word}</button>`).join("")}</div>
        <fieldset class="episode-confidence"><legend>How sure are you?</legend>
          <label><input type="radio" name="episode-confidence" value="sure" ${this.confidence === "sure" ? "checked" : ""}> Sure</label>
          <label><input type="radio" name="episode-confidence" value="unsure" ${this.confidence === "unsure" ? "checked" : ""}> Not sure</label></fieldset>
        <button class="primary-button episode-primary" type="button" data-episode="read" ${this.draftReading.length && !this.busy ? "" : "disabled"}><i class="ph ph-check" aria-hidden="true"></i> Record reading</button>
        ${this.protocolHtml(state, false)}</section>`;
    }
    if (role === "sender" && this.host.humans() < 2) {
      // Solo check: what a receiver following the protocol would read (no pretend teammate).
      return `<section class="episode-section">${head}${this.replayHtml(round, view)}
        <h3>Solo check</h3>${this.decodedHtml(view.decoded)}
        <ul class="episode-findings">${this.soloFindings(state, round, view).map((message) => `<li>${escape(message)}</li>`).join("") || "<li>No problems found under the protocol.</li>"}</ul>
        <div class="episode-row"><button class="secondary-button compact" type="button" data-episode="transmit">Transmit again</button><button class="bare-button compact" type="button" data-episode="close-round">Close round</button></div></section>`;
    }
    return `<section class="episode-section">${head}${this.replayHtml(round, view)}
      <p class="episode-fine">Waiting for the receiver's first reading.</p>
      ${role === "sender" ? `<div class="episode-row"><button class="secondary-button compact" type="button" data-episode="transmit">Transmit again</button><button class="bare-button compact" type="button" data-episode="close-round">Abandon round</button></div>` : ""}</section>`;
  }

  /** Solo check findings: the same factual measurements against the published protocol. */
  private soloFindings(_state: RescueState, round: RescueRound, view: RoundView): string[] {
    return diagnose(view.transmission, round.intent, null).map((finding) => finding.message);
  }

  private decodedHtml(decoded: Decoded): string {
    if (decoded.empty) return `<p class="episode-situation">No light at all.</p>`;
    return `<div class="episode-groups">${decoded.groups.map((group) => `<span class="episode-chip${group.word ? "" : " is-ambiguous"}">${group.word ?? "unclear"}<small>${group.pattern.map(flashGlyph).join(" ")}</small></span>`).join("")}</div>`;
  }

  private compareHtml(state: RescueState, round: RescueRound, role: Role | null): string {
    const view = roundView(round);
    const reading = round.reading!;
    const result = compare(round.intent, view.decoded, reading.words);
    const copy = OUTCOME_COPY[result.outcome];
    const findings = diagnose(view.transmission, round.intent, reading.words);
    const row = (label: string, value: string) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    return `<section class="episode-section">
      <p class="episode-outcome" data-tone="${copy.tone}"><i class="ph ${result.delivered ? "ph-check-circle" : "ph-warning-circle"}" aria-hidden="true"></i> Round ${round.n} · ${copy.title}</p>
      <dl class="episode-compare">
        ${row("Sender intended", escape(round.intent.join(" · ")))}
        ${row("The light says (protocol v1)", view.decoded.empty ? "no light" : view.decoded.groups.map((group) => `${group.word ?? "unclear"} <small>${group.pattern.map(flashGlyph).join(" ")}</small>`).join(" · "))}
        ${row(`Receiver read (${reading.confidence === "sure" ? "sure" : "not sure"})`, escape(reading.words.map((word) => (word === "?" ? "unclear" : word)).join(" · ")))}
      </dl>
      ${this.stripHtml(view, true, null)}
      <ul class="episode-findings">${findings.map((finding) => `<li>${escape(finding.message)}</li>`).join("") || "<li>The light, the protocol and the reading agree.</li>"}</ul>
      <label class="episode-explain"><span>Team explanation: what made the message ${result.delivered ? "work" : "fail"}, and what would you change?</span>
        <textarea id="episode-explanation" rows="3" maxlength="600" ${role ? "" : "disabled"}>${escape(round.explanation)}</textarea></label>
      ${role ? `<div class="episode-row"><button class="secondary-button compact" type="button" data-episode="explain">Save explanation</button><button class="primary-button compact" type="button" data-episode="close-round"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i> Close round & revise</button></div>` : ""}
      ${this.protocolHtml(state, false)}</section>`;
  }

  private historyHtml(state: RescueState, me: string): string {
    if (!state.history.length) return "";
    const delivered = deliveredRound(state);
    return `<section class="episode-history" aria-label="Earlier rounds"><h3>Rounds</h3><ol>${state.history.map((round) => {
      const outcome = round.reading ? compare(round.intent, roundView(round).decoded, round.reading.words).outcome : null;
      // An unread round's intention stays with whoever transmitted it (it may be sent again).
      const intent = round.reading || round.sentBy.includes(me) ? escape(round.intent.join(" · ")) : '<span class="episode-fine">message not revealed</span>';
      return `<li><strong>${round.n}</strong> ${intent} <span class="episode-badge" data-tone="${outcome ? OUTCOME_COPY[outcome].tone : "neutral"}">${outcome ? OUTCOME_COPY[outcome].title : "not read"}</span></li>`;
    }).join("")}</ol>${delivered ? `<p class="episode-outcome" data-tone="valid"><i class="ph ph-seal-check" aria-hidden="true"></i> Workshop goal met in round ${delivered.n}: a clear signal, read as sent, and explained by the team.</p>` : ""}
      <button class="bare-button compact is-danger" type="button" data-episode="reset">Reset workshop…</button></section>`;
  }

  // ── Actions ────────────────────────────────────────────────────────────────────────────

  private async act(action: Parameters<DesktopRoom["episodeAction"]>[0], success?: string): Promise<boolean> {
    const room = this.host.room();
    if (!room || this.busy) return false;
    this.busy = true;
    this.lastRenderKey = "";
    this.render();
    const result = await room.episodeAction(action).finally(() => { this.busy = false; });
    this.lastRenderKey = "";
    this.schedule();
    if (!result.ok) {
      this.host.status(REFUSALS[result.reason] ?? "That didn't go through.", "warning");
      return false;
    }
    if (success) this.host.status(success, "neutral");
    return true;
  }

  private async onClick(event: MouseEvent): Promise<void> {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-episode]");
    const state = this.state;
    if (!button || !state) return;
    const kind = button.dataset.episode;
    const round = state.round;
    switch (kind) {
      case "claim-role":
      case "release-role": {
        const role = button.dataset.role as Role;
        if (await this.act({ type: kind, role })) this.host.trace("role", `Rescue signal · ${kind === "claim-role" ? "took" : "left"} the ${role} role`);
        break;
      }
      case "swap-roles":
        if (await this.act({ type: "swap-roles" })) this.host.trace("role", "Rescue signal · swapped sender and receiver");
        break;
      case "mission":
        await this.setDesign(button.dataset.mission ?? state.mission, state.intent);
        break;
      case "intent-add":
        await this.setDesign(state.mission, [...state.intent, button.dataset.word as Word].slice(0, MAX_WORDS));
        break;
      case "intent-remove":
        await this.setDesign(state.mission, state.intent.filter((_, index) => index !== Number(button.dataset.index)));
        break;
      case "write-blocks": {
        const pin = wiredPin(this.host.workbench()?.snapinoBench() ?? {}) ?? "D5";
        const program = compileMessage(state.intent, pin, MAX_STATEMENTS);
        if (!program) {
          this.host.status("That message needs more blocks than a program can hold.", "warning");
          break;
        }
        this.host.loadEditor(program);
        this.host.status(`Blocks for ${state.intent.join(" · ")} on ${pin} are in your editor (not sent yet)`, "neutral");
        this.refresh();
        break;
      }
      case "open-code":
        this.host.openCodeEditor();
        break;
      case "transmit": {
        const program = this.host.editorProgram();
        if (await this.act({ type: "transmit", program, tx: round?.tx ?? null })) {
          const n = this.state?.round?.n ?? 0;
          this.host.trace("test", `Rescue signal · round ${n} transmitted (${program.length} blocks, ${seconds(programDurationMs(program))})`);
        }
        break;
      }
      case "stop":
        if (round) await this.act({ type: "stop", tx: round.tx }, "Transmission stopped");
        break;
      case "receiver-view":
        this.host.workbench()?.viewForReceiver();
        break;
      case "replay":
        this.replay = !round || this.replay?.tx === round.tx ? null : { tx: round.tx, startedAt: performance.now() };
        this.refresh();
        break;
      case "reading-add":
        if (this.draftReading.length < MAX_WORDS) this.draftReading = [...this.draftReading, button.dataset.word as Word | "?"];
        this.refresh();
        break;
      case "reading-remove":
        this.draftReading = this.draftReading.filter((_, index) => index !== Number(button.dataset.index));
        this.refresh();
        break;
      case "read":
        if (round && this.draftReading.length && (await this.act({ type: "read", tx: round.tx, words: this.draftReading, confidence: this.confidence }, "Reading recorded"))) {
          this.host.trace("test", `Rescue signal · round ${round.n} reading recorded (${this.state?.round?.reading?.words.length ?? 0} words, ${this.confidence})`);
        }
        break;
      case "explain": {
        const text = document.querySelector<HTMLTextAreaElement>("#episode-explanation")?.value ?? "";
        if (round && (await this.act({ type: "explain", tx: round.tx, text }, "Explanation saved"))) this.host.trace("reflect", `Rescue signal · round ${round.n} explanation saved`);
        break;
      }
      case "close-round": {
        if (!round) break;
        const outcome = round.reading ? compare(round.intent, roundView(round).decoded, round.reading.words).outcome : "not read";
        if (await this.act({ type: "close-round", tx: round.tx })) this.host.trace("test", `Rescue signal · round ${round.n} closed (${outcome})`);
        break;
      }
      case "reset":
        if (await this.host.confirm("Reset the workshop?", "This clears every round, reading and explanation for everyone in the room. The bench and the program stay as they are.", "Reset workshop")) {
          if (await this.act({ type: "reset" }, "Workshop reset")) this.host.trace("test", "Rescue signal · workshop reset");
        }
        break;
    }
  }

  private async setDesign(mission: string, words: Word[]): Promise<void> {
    await this.act({ type: "set-design", mission, words });
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.name === "episode-confidence") {
      this.confidence = target.value === "unsure" ? "unsure" : "sure";
      this.refresh();
    }
  }
}

export type { Comparison };
