/**
 * Resource-Limited Greenhouse (Episode 3): the one contextual dock tab.
 *
 * Sections (one scrolling column with a jump bar): the brief and its five criteria (task rules,
 * both conditions); the day (run controls, model clock, live resource graph with a data table);
 * the resource-flow diagram with its text connection list and fault notes; the selected part's
 * Overview / Ports / Behaviour & limits with bounded room edits; and the learning loop (predict →
 * build → run → explain → revise) with this learner's attempt history.
 *
 * One state. The room's parts give the rig (DesktopWorkbenchScene → deriveRig); the room's run
 * state gives model time and resources. The model state shown at server time t is
 * simulate(anchor, rig, ticks since the anchor): deterministic, so every client shows the same
 * values whatever its frame rate, and collapsing the dock never halts the day. The panel never
 * invents a measurement: every number comes from the snapshot or the step record.
 *
 * Privacy: predictions, explanations and attempts are this learner's own, kept in this browser
 * tab's session storage only (never shared, never exported, cleared when the tab closes); only a
 * "test" trace with criterion codes and a "reflect" trace without words go to the room's record.
 *
 * PF / DI: brief, ratings, limits, graph, sensors and post-run measurements in both; the worked
 * example and per-criterion reasons in DI only; explanatory diagram notes in PF only after this
 * learner's own first finished day in this session (safety notes always). Bolt is not involved.
 */
import { GH_BOUNDS, GH_PORTS, GH_PROBE_SLOTS, type GhProps } from "../../cloudflare/greenhouse-rules.js";
import {
  clockAt,
  deriveRig,
  evaluateBrief,
  GH_MODEL,
  GH_WORKED_EXAMPLE,
  simulate,
  initialSnapshot,
  type GhCriterion,
  type GhRig,
  type GhSnapshot,
} from "../../cloudflare/greenhouse-model.js";
import { compactRecord, currentTick, STEP_MS, type CompactRecord, type GhAction, type GhRun } from "../../cloudflare/greenhouse-run.js";
import type { SharedTransform } from "../desktop/collaboration.js";
import type { DesktopWorkbenchScene } from "../desktop/scene.js";
import { clearSubmittedDrafts, notAppliedCopy } from "../sound/sound-panel.ts";
import { faultNotes, FIXTURE_NAMES, isWrongLine, LINE_NAMES, LINE_STATUS_WORDS, lineFlows, partName, PLANT_WORDS, portLabel, renderGhConnectionList, renderGhDiagramSvg } from "./gh-diagram.ts";
import type { GhView } from "./gh-rig.ts";

export interface GhPanelHost {
  workbench(): DesktopWorkbenchScene | null;
  condition(): "PF" | "DI";
  roomCode(): string;
  /** The room's clock (ms). */
  serverTime(): number;
  /** One run action through the room: accepted, or why not. */
  action(action: GhAction): Promise<{ ok: boolean; reason: string | null }>;
  selectedId(): string | null;
  select(id: string): void;
  holderOf(id: string): string | null;
  submit(changes: Array<{ id: string; transform: SharedTransform }>, label: string, traceId: string): Promise<{ ok: boolean; reason: string | null }>;
  /** Unplugs a line or lifts the probe back to its holder (one room edit). */
  returnHome(id: string): Promise<boolean>;
  trace(action: "test" | "reflect", detail: string): void;
  status(message: string, tone: "neutral" | "valid" | "warning"): void;
  confirm(title: string, body: string, action: string): Promise<boolean>;
  showTab(): void;
  /** Whether the greenhouse is the active studio (the 3D rig is shown). */
  active(): boolean;
}

type Prediction = "meets" | "dry" | "wet" | "heat" | "tank";
const PREDICTIONS: Array<[Prediction, string]> = [
  ["meets", "Meets the brief: both beds in range, air under control, reserve kept"],
  ["dry", "A bed dries out (too long below 30 %)"],
  ["wet", "A bed gets waterlogged (too long above 90 %)"],
  ["heat", "The air overheats (too long above 35 °C)"],
  ["tank", "The tank runs low (under 8 L left)"],
];

const CRITERION_LABELS: Record<GhCriterion["id"], string> = {
  G1: "Plumbed and wired: tank → pump → bed A and bed B; pump and fan on controller channels; solar into the controller; the probe in a bed.",
  G2: "Bed A dry (< 30 %) or waterlogged (> 90 %) for at most 2 h of the day.",
  G3: "Bed B the same.",
  G4: "Greenhouse air above 35 °C for at most 1 h.",
  G5: "At least 8 L left in the tank at the end of the day.",
};

/** DI only: why a criterion failed, in teaching terms (shown after a finished day). */
const DI_EXPLANATIONS: Record<GhCriterion["id"], string> = {
  G1: "Follow the water: a hose from TANK OUT to PUMP IN, one from PUMP OUT to MANIFOLD IN, and one from each valve outlet to a bed's inlet. Follow the power: SOLAR OUT to the controller's SOLAR IN, a channel to the pump's 12 V IN and the other to the fan's. Then push the probe into a bed's slot.",
  G2: "Bed A dried out or drowned. Its water depends on how often the pump runs (the 'pump below' rule reads only the probed bed) and on valve A's share of each 6 L. Too little share and it dries; too much and it stays wet and drains away.",
  G3: "Bed B uses half as much water again as bed A. If the probe is in bed A, bed B is watered blind: give valve B a larger share than valve A, or probe bed B and watch bed A instead.",
  G4: "Only the fan cools the air (−7 °C). It runs when the last air reading is above 'fan above', and only if its channel gets power. At midday the pump and fan want 20 W, more than the 18 W panel gives: the channel served first wins, so a lower fan threshold or a better order keeps the fan running.",
  G5: "Every litre the pump moves comes from the 40 L tank and nothing refills it today. Over-watering is lost to drainage above 80 % soil: a lower 'pump below' or smaller valve openings save water.",
};

const REFERENCE: Record<string, { role: string; behaviour: string[]; limits: string[] }> = {
  "water-pump": {
    role: "Lifts water from the tank (below the beds) to the manifold or a bed.",
    behaviour: ["12 W while it runs, 6 L per 15-minute step (0.4 L/min) when the valves allow it.", "Total flow = 6 L × min(1, valve A + valve B). Less if the tank holds less.", "Without a supply hose, an outlet, or water in the tank it runs dry: it uses its power and delivers 0 L."],
    limits: ["Fixed-flow pump: no pressure curve, no priming, no wear.", "Runs a whole step or not at all."],
  },
  "valve-manifold": {
    role: "Splits the pump's water between outlet A and outlet B.",
    behaviour: ["Each valve 0–100 % in 5 % steps. Outlet flow q = Q·v / max(1, vA + vB).", "An outlet with no hose is closed. Both closed: the pump is dead-headed and delivers 0 L."],
    limits: ["Linear split, lossless; real valves are not linear and leak a little.", "Hoses hold no water."],
  },
  "farm-controller": {
    role: "Reads the probe and the climate sensor at the start of each step, then decides that step's loads.",
    behaviour: ["Pump rule: run when the probed bed's soil is below 'pump below' (10–90 %, 5 % steps).", "Fan rule: run when the last air reading is above 'fan above' (20–40 °C, 1 °C steps).", "12 Wh battery (starts at 6 Wh). Channel 1 is served before channel 2; a load runs only if solar + battery cover the whole step, otherwise it is starved. Surplus solar charges the battery; the rest is curtailed."],
    limits: ["No proportional control, no timers, no hysteresis.", "Power is accounted per 15-minute step."],
  },
  "vent-fan": {
    role: "The only cooling: lowers the greenhouse air by 7 °C for a step it runs.",
    behaviour: ["8 W while it runs.", "Air = outside + 4 °C × sun − 7 °C when the fan ran (no thermal mass)."],
    limits: ["Steady state per step: no warm-up, no humidity model."],
  },
  "solar-panel": {
    role: "The only energy source: 18 W × sun into the controller's SOLAR IN.",
    behaviour: ["Sun follows the seeded day (06:00–20:00), with one or two cloud spells (× 0.35).", "Wired straight to a load it is unregulated: not supported, carries nothing."],
    limits: ["No panel temperature, angle or shading model."],
  },
  "temp-sensor": {
    role: "Shows the greenhouse air the controller's fan rule reads.",
    behaviour: ["Reads the air at the start of each step (the last step's air)."],
    limits: ["An ideal sensor: no lag, no error."],
  },
  "light-sensor": {
    role: "Shows the sun level the solar panel sees.",
    behaviour: ["Sun 0–100 % for the current step."],
    limits: ["Display only: no rule reads it."],
  },
  "soil-sensor": {
    role: "Measures one bed's soil water (θ) for the pump rule.",
    behaviour: ["Push both pins into a bed's probe slot. The reading is that bed's θ = water / 20 L at the start of each step.", "Not in a bed: no reading, so the pump rule never switches the pump on."],
    limits: ["One probe: the other bed is watered blind.", "An ideal sensor: no salinity, depth or calibration effects."],
  },
};

interface Attempt {
  n: number;
  prediction: Prediction | null;
  why: string;
  /** Finished days with a run id above this one count for this attempt (null: any). */
  afterRun: number | null;
  result: { at: number; runId: number; seed: number; met: boolean; criteria: GhCriterion[]; summary: string } | null;
  explanation: string;
  explained: boolean;
}
interface Session {
  attempts: Attempt[];
  /** Explanatory notes unlocked (PF): this learner's own first finished day in this browser session. */
  firstFinishedAt: number | null;
}

type InspectTab = "overview" | "ports" | "behavior";
type Param = "valveA" | "valveB" | "pumpBelow" | "fanAbove";

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const RUN_REFUSALS: Record<string, string> = {
  running: "the day is already running",
  paused: "the day is paused (resume it, or reset to start again)",
  idle: "the day has not started",
  ended: "the day is over; reset it to run again",
  invalid: "the room's validation refused it",
  stale: "a teammate changed the day first (it was reset); look at the new day before acting",
};

interface Projection { runId: number; anchorTick: number; anchorAt: number; status: string; rigKey: string; snapshot: GhSnapshot; records: CompactRecord[] }

/** The DI worked example's rig: the brief's build with the worked values. */
function workedRig(): GhRig {
  const sockets: Record<string, [number, number]> = {
    "irrigation-hose": [0, 1],
    "irrigation-hose-2": [2, 3],
    "irrigation-hose-3": [4, 6],
    "irrigation-hose-4": [5, 7],
    "power-cable-1": [8, 9],
    "power-cable-2": [GH_WORKED_EXAMPLE.pumpChannel === 1 ? 10 : 11, 12],
    "power-cable-3": [GH_WORKED_EXAMPLE.pumpChannel === 1 ? 11 : 10, 13],
    "soil-sensor": GH_PROBE_SLOTS[GH_WORKED_EXAMPLE.probe],
  };
  return deriveRig((id) => {
    if (id === "valve-manifold") return { props: { valveA: GH_WORKED_EXAMPLE.valveA, valveB: GH_WORKED_EXAMPLE.valveB } };
    if (id === "farm-controller") return { props: { pumpBelow: GH_WORKED_EXAMPLE.pumpBelow, fanAbove: GH_WORKED_EXAMPLE.fanAbove } };
    return sockets[id] ? { sockets: sockets[id] } : null;
  });
}

export class GreenhousePanel {
  private run: GhRun | null = null;
  private rig: GhRig | null = null;
  private rigKey = "";
  private projection: Projection | null = null;
  private shownTick = -1;
  private session: Session;
  private tab: InspectTab = "overview";
  private readonly drafts = new Map<string, string>();
  private editNote: { part: string; text: string; tone: "valid" | "warning" | "neutral" } | null = null;
  private runNote: { text: string; tone: "valid" | "warning" | "neutral" } | null = null;
  private readonly pending = new Set<string>();
  /** An edit of this learner's was just answered: the Selected card may be rebuilt under focus. */
  private answered = false;
  private actionPending = false;
  /** An action whose answer did not arrive (timeout, closed connection): did the room apply it? */
  private unconfirmed: { action: GhAction; before: GhRun; label: string } | null = null;
  private renderQueued = false;
  private timer = 0;
  private disposed = false;
  private readonly written = new Map<string, string>();
  private worked: { stressA: number; stressB: number; heat: number; tank: number } | null = null;
  // A plain field (no TypeScript parameter property), so Node's --experimental-strip-types can run it.
  private readonly host: GhPanelHost;

  constructor(host: GhPanelHost) {
    this.host = host;
    this.session = this.loadSession();
  }

  // ── Markup ────────────────────────────────────────────────────────────────────────

  static markup(): string {
    return `<section class="gh-panel" id="gh-panel" aria-labelledby="gh-title">
      <header class="ss-head">
        <div><span class="section-label">Episode 3 · Resource-Limited Greenhouse</span><h2 id="gh-title">Brief · Dry-spell day</h2></div>
        <span class="ss-pill" id="gh-pill" data-tone="neutral" role="status" aria-live="polite">Attempt 1 · not run</span>
      </header>
      <nav class="gh-jump" aria-label="Greenhouse sections">
        <a href="#gh-day-title">Day</a><a href="#gh-flow-title">Flow</a><a href="#gh-part-title">Selected</a><a href="#gh-loop-title">Attempt</a>
      </nav>
      <p class="ss-story">Get the school greenhouse through one hot, dry day (seed 11, 06:00 to 06:00) on the water already in its 40 L tank. These five criteria are the task's rules:</p>
      <ol class="ss-criteria" id="gh-criteria">
        ${(Object.keys(CRITERION_LABELS) as GhCriterion["id"][]).map((id) => `<li data-criterion="${id}"><strong>${id}</strong> ${escape(CRITERION_LABELS[id])}</li>`).join("")}
      </ol>
      <p class="ss-note"><i class="ph ph-info" aria-hidden="true"></i> Teaching numbers: water uptake, weather and plant response are a simple water-balance model, not a validated crop or weather prediction. The verdict and measured values appear when the day ends, in both conditions.</p>
      <section class="ss-card" id="gh-worked" hidden aria-labelledby="gh-worked-title"></section>

      <section class="ss-card gh-day" id="gh-day-card" aria-labelledby="gh-day-title">
        <div class="ss-card-head"><h3 id="gh-day-title"><i class="ph ph-sun-horizon" aria-hidden="true"></i> The day</h3><small id="gh-day-state">Not started</small></div>
        <div class="gh-clock" id="gh-clock" aria-live="off"></div>
        <div class="gh-controls" role="group" aria-label="Run controls (shared with the room)">
          <button class="primary-button" id="gh-run-toggle" type="button"><i class="ph ph-play" aria-hidden="true"></i> <span>Start the day</span></button>
          <button class="secondary-button" id="gh-step" type="button"><i class="ph ph-skip-forward" aria-hidden="true"></i> Step 1 h</button>
          <div class="gh-speed" role="group" aria-label="Speed">
            <button class="secondary-button" type="button" data-speed="1" aria-pressed="true">×1</button>
            <button class="secondary-button" type="button" data-speed="4" aria-pressed="false">×4</button>
          </div>
          <button class="secondary-button" id="gh-reset" type="button"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i> Reset day…</button>
        </div>
        <p class="si-edit-note" id="gh-run-note" hidden role="status" aria-live="polite"></p>
        <p class="ss-fine">Run controls are shared: everyone sees the same model time. ×1 is 2.5 s per 15-minute step (a day in 4 minutes). While the day runs, the rig is locked; pause to change it. Only Reset refills the tank.</p>
        <div class="gh-graph" id="gh-graph" role="img" aria-label="Resource graph"></div>
        <ul class="gh-legend" id="gh-legend" aria-label="Graph legend"></ul>
        <p class="ss-fine" id="gh-graph-summary" aria-live="off"></p>
        <details class="gh-table"><summary>Hourly values (table)</summary><div id="gh-table"></div></details>
        <div class="ss-result" id="gh-verdict" role="status" aria-live="polite"></div>
      </section>

      <section class="ss-card" id="gh-flow-card" aria-labelledby="gh-flow-title">
        <div class="ss-card-head"><h3 id="gh-flow-title"><i class="ph ph-flow-arrow" aria-hidden="true"></i> Live resource flow</h3><small id="gh-flow-summary"></small></div>
        <div class="gd-diagram" id="gh-diagram"></div>
        <ul class="sd-legend" aria-label="Diagram legend">
          <li><span class="sd-key gd-key-water" aria-hidden="true"></span> solid + arrow: water this step (L)</li>
          <li><span class="sd-key gd-key-power" aria-hidden="true"></span> solid + arrow: power this step (W)</li>
          <li><span class="sd-key is-dashed" aria-hidden="true"></span> long dashes: connected, idle</li>
          <li><span class="sd-key is-dotted" aria-hidden="true"></span> dots + ✕: wrong or loose, carries nothing</li>
        </ul>
        <div class="sd-notes" id="gh-notes" role="status" aria-live="polite"></div>
        <h4 class="sd-list-title">Connections (text)</h4>
        <div id="gh-list"></div>
      </section>

      <section class="ss-card gh-part" id="gh-part-card" aria-labelledby="gh-part-title">
        <div class="ss-card-head"><h3 id="gh-part-title">Selected</h3><small id="gh-part-hint">Select equipment, a hose, a cable or the probe in 3D, on the diagram or in the list</small></div>
        <div class="si-tabs" role="tablist" aria-label="Part details" id="gh-tabs">
          <button role="tab" type="button" id="gh-tab-overview" data-gh-tab="overview" aria-controls="gh-part-panel" aria-selected="true">Overview</button>
          <button role="tab" type="button" id="gh-tab-ports" data-gh-tab="ports" aria-controls="gh-part-panel" aria-selected="false" tabindex="-1">Ports</button>
          <button role="tab" type="button" id="gh-tab-behavior" data-gh-tab="behavior" aria-controls="gh-part-panel" aria-selected="false" tabindex="-1">Behaviour &amp; limits</button>
        </div>
        <div class="si-panel gh-part-panel" id="gh-part-panel" role="tabpanel" aria-labelledby="gh-tab-overview"></div>
      </section>

      <section class="ss-card ss-loop" aria-labelledby="gh-loop-title">
        <div class="ss-card-head"><h3 id="gh-loop-title"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i> Your attempt</h3><small id="gh-attempt-label"></small></div>
        <ol class="ss-steps" id="gh-steps" aria-label="Learning loop"></ol>
        <fieldset class="ss-step" id="gh-predict">
          <legend>1 · Predict: what will the day do to this rig?</legend>
          <div class="ss-choices" id="gh-predictions">
            ${PREDICTIONS.map(([value, label]) => `<label class="ss-choice"><input type="radio" name="gh-prediction" value="${value}"><span>${escape(label)}</span></label>`).join("")}
          </div>
          <label class="ss-why" for="gh-why">Why? <small>(your own notes)</small></label>
          <textarea id="gh-why" rows="2" maxlength="400" placeholder="Because bed B drinks more and…"></textarea>
        </fieldset>
        <div class="ss-step"><p class="ss-step-title">2 · Build and allocate: hoses, power cables, the probe, valves and rules (in 3D or under Selected). <span id="gh-build-summary"></span></p></div>
        <div class="ss-step"><p class="ss-step-title">3 · Run the day and inspect it (above). The verdict appears when the day ends.</p><p class="ss-fine" id="gh-run-summary"></p></div>
        <div class="ss-step">
          <label class="ss-step-title" for="gh-explain">4 · Explain what happened, and why.</label>
          <textarea id="gh-explain" rows="3" maxlength="800" placeholder="Bed B dried out at 14:00 because…"></textarea>
          <button class="secondary-button compact" id="gh-explain-save" type="button" disabled>Save explanation</button>
        </div>
        <div class="ss-step">
          <p class="ss-step-title">5 · Revise: change the rig, then start a new attempt (it resets the day for everyone).</p>
          <button class="secondary-button compact" id="gh-new-attempt" type="button"><i class="ph ph-plus" aria-hidden="true"></i> New attempt</button>
        </div>
        <details class="ss-history"><summary>Earlier attempts</summary><ol id="gh-history"></ol></details>
        <p class="ss-fine">Your predictions, notes, explanations and attempt history stay in this browser tab only (session storage): never shared with the room, never in project files, and cleared when you close the tab. The room's activity record gets only "ran the day: G1 ✓ …" codes and "explained", never your words.</p>
      </section>
    </section>`;
  }

  /** The 3D HUD's markup (live conditions over the viewport). */
  static hudMarkup(): string {
    return `<div class="environment-heading"><span data-tooltip="Model time and resources (from the room's day)"><i class="ph ph-clock"></i><strong id="metric-clock">06:00</strong></span><small id="greenhouse-status" data-tooltip="The day has not started">Not started</small></div>
      <div class="environment-metrics">
        <article data-tooltip="Water in the tank"><i class="ph ph-drop-half"></i><span><small class="sr-only">Tank</small><strong id="metric-tank">40.0 L</strong></span></article>
        <article data-tooltip="Probed bed's soil water"><i class="ph ph-plant"></i><span><small class="sr-only">Soil (probed bed)</small><strong id="metric-moisture">--</strong></span></article>
        <article data-tooltip="Greenhouse air"><i class="ph ph-thermometer"></i><span><small class="sr-only">Air</small><strong id="metric-temperature">--</strong></span></article>
        <article data-tooltip="Controller battery"><i class="ph ph-battery-medium"></i><span><small class="sr-only">Battery</small><strong id="metric-battery">6.0 Wh</strong></span></article>
      </div>`;
  }

  // ── Binding ───────────────────────────────────────────────────────────────────────

  bind(): void {
    const on = <K extends keyof HTMLElementEventMap>(selector: string, type: K, handler: (event: HTMLElementEventMap[K]) => void): void => {
      document.querySelector<HTMLElement>(selector)?.addEventListener(type, handler);
    };
    on("#gh-run-toggle", "click", () => void this.toggleRun());
    on("#gh-step", "click", () => void this.send({ type: "step" }, "Stepped one hour"));
    document.querySelectorAll<HTMLButtonElement>("#gh-panel [data-speed]").forEach((button) => {
      button.addEventListener("click", () => void this.send({ type: "speed", speed: Number(button.dataset.speed) === 4 ? 4 : 1 }, `Speed ×${button.dataset.speed}`));
    });
    on("#gh-reset", "click", () => void this.resetDay());
    on("#gh-predictions", "change", (event) => {
      this.current().prediction = (event.target as HTMLInputElement).value as Prediction;
      this.saveSession();
      this.renderLoop();
    });
    on("#gh-why", "input", (event) => {
      this.current().why = (event.target as HTMLTextAreaElement).value.slice(0, 400);
      this.saveSession();
    });
    on("#gh-explain", "input", (event) => {
      this.current().explanation = (event.target as HTMLTextAreaElement).value.slice(0, 800);
      this.saveSession();
      this.renderLoop();
    });
    on("#gh-explain-save", "click", () => this.saveExplanation());
    on("#gh-new-attempt", "click", () => void this.newAttempt());
    const diagram = document.querySelector<HTMLElement>("#gh-diagram");
    const activate = (target: Element | null): void => {
      const node = target?.closest<SVGElement>("[data-select], [data-line]");
      const id = node?.getAttribute("data-select") ?? node?.getAttribute("data-line");
      if (id) this.host.select(id);
    };
    diagram?.addEventListener("click", (event) => activate(event.target as Element));
    diagram?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate(event.target as Element);
    });
    on("#gh-list", "click", (event) => {
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-select]")?.dataset.select;
      if (id) this.host.select(id);
    });
    const tabs = document.querySelector<HTMLElement>("#gh-tabs");
    tabs?.addEventListener("click", (event) => {
      const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-gh-tab]")?.dataset.ghTab as InspectTab | undefined;
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
    const panel = document.querySelector<HTMLElement>("#gh-part-panel");
    panel?.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (!target.dataset.draft) return;
      this.drafts.set(target.dataset.draft, target.value);
      // The card is not rebuilt while the learner types; the draft can be discarded at once.
      const part = target.dataset.draft.split(":")[0];
      const discard = panel.querySelector<HTMLButtonElement>(`[data-revert="${part}"]`);
      if (discard) discard.disabled = false;
    });
    panel?.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!button) return;
      if (button.dataset.step) this.stepDraft(button.dataset.step, Number(button.dataset.delta));
      if (button.dataset.revert) this.revertDrafts(button.dataset.revert);
      if (button.dataset.home) void this.returnHome(button.dataset.home);
      if (button.dataset.probe) void this.placeProbe(button.dataset.probe as "A" | "B");
      if (button.dataset.select) this.host.select(button.dataset.select);
    });
    panel?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = (event.target as HTMLElement).closest<HTMLFormElement>("form[data-part]");
      if (form) void this.applyValues(form.dataset.part!);
      const ports = (event.target as HTMLElement).closest<HTMLFormElement>("form[data-ports]");
      if (ports) void this.connectLine(ports);
    });
    // The jump bar scrolls within the dock (no page navigation).
    on("#gh-panel .gh-jump", "click", (event) => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#']");
      if (!link) return;
      event.preventDefault();
      const target = document.querySelector<HTMLElement>(link.getAttribute("href")!);
      target?.closest<HTMLElement>("section")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      target?.setAttribute("tabindex", "-1");
      target?.focus({ preventScroll: true });
    });
    this.renderWorked();
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    window.clearInterval(this.timer);
  }

  // ── State in ─────────────────────────────────────────────────────────────────────

  /** The room's run state arrived (accepted action, join, reconnect). */
  setRun(run: GhRun): void {
    const unconfirmed = this.unconfirmed;
    if (unconfirmed && appliedBy(unconfirmed.action, unconfirmed.before, run)) {
      this.unconfirmed = null;
      this.runNote = { text: `${unconfirmed.label} · for everyone in the room (the room's answer arrived after the wait)`, tone: "valid" };
    }
    this.run = run;
    this.projection = null;
    this.ensureTimer();
    this.tick(true);
  }

  /** The rig as built changed (here or remotely). */
  setRig(rig: GhRig): void {
    this.rig = rig;
    const key = JSON.stringify([rig.lines.map((line) => [line.id, line.ends, line.status]), rig.manifold, rig.controller, rig.probe]);
    if (key !== this.rigKey) {
      this.rigKey = key;
      this.projection = null;
    }
    this.tick(true);
  }

  /** The studio became active or inactive (the timer keeps model time either way). */
  refresh(): void {
    this.tick(true);
  }

  /** A valve handle or dial was clicked in 3D: show its control and focus it. */
  focusControl(partId: string, param: string): void {
    this.host.select(partId);
    this.setTab("overview", false);
    this.host.showTab();
    requestAnimationFrame(() => {
      this.render();
      const target = document.querySelector<HTMLElement>(`#gh-part-panel [data-draft="${partId}:${param}"]`);
      target?.scrollIntoView({ block: "nearest" });
      target?.focus();
    });
  }

  private ensureTimer(): void {
    window.clearInterval(this.timer);
    if (this.run?.status !== "running" || this.disposed) return;
    // Model time comes from the room's clock; this only polls it (4× per step at ×4).
    this.timer = window.setInterval(() => this.tick(false), Math.max(120, STEP_MS / 4 / 4));
  }

  /** Brings the projection to the room's current tick and re-renders when it moved. */
  private tick(force: boolean): void {
    if (this.disposed) return;
    const run = this.run;
    const rig = this.rig;
    if (!run || !rig) {
      if (force) this.queueRender();
      return;
    }
    const target = currentTick(run, this.host.serverTime());
    let projection = this.projection;
    if (!projection || projection.runId !== run.runId || projection.anchorTick !== run.tick || projection.anchorAt !== run.anchorAt || projection.status !== run.status || projection.rigKey !== this.rigKey) {
      projection = { runId: run.runId, anchorTick: run.tick, anchorAt: run.anchorAt, status: run.status, rigKey: this.rigKey, snapshot: run.snapshot, records: run.records.slice() };
      this.projection = projection;
      force = true;
    }
    if (target > projection.snapshot.tick) {
      // While the day runs the rig is locked in the room, so this is the room's rig too.
      const advanced = simulate(projection.snapshot, rig, run.seed, target);
      projection.snapshot = advanced.snapshot;
      for (const record of advanced.records) projection.records.push(compactRecord(record));
      force = true;
    }
    if (target >= GH_MODEL.steps) window.clearInterval(this.timer);
    if (!force && projection.snapshot.tick === this.shownTick) return;
    this.shownTick = projection.snapshot.tick;
    this.pushView();
    this.noteFinished();
    this.queueRender();
  }

  /** Shows the current model state on the 3D rig and the HUD. */
  private pushView(): void {
    const view = this.view();
    if (!view) return;
    this.host.workbench()?.setGreenhouseView(view);
    this.renderHud();
  }

  private lastRecord(): CompactRecord | null {
    const records = this.projection?.records;
    return records && records.length ? records[records.length - 1] : null;
  }

  /** The model state as the 3D rig shows it. */
  view(): GhView | null {
    const projection = this.projection;
    const rig = this.rig;
    if (!projection || !rig) return null;
    const snapshot = projection.snapshot;
    const record = this.lastRecord();
    const flows = lineFlows(rig, record);
    const flowing = new Set<string>();
    for (const [id, flow] of flows) if (flow.state === "flow" && LINE_NAMES[id]?.hose) flowing.add(id);
    const faultPorts = new Set<number>();
    for (const line of rig.lines) if (isWrongLine(line)) for (const end of line.ends) if (end !== null) faultPorts.add(end);
    const theta = (bed: "A" | "B") => snapshot.beds[bed] / GH_MODEL.bedCapacity;
    const stateOf = (bed: "A" | "B") => record?.beds[bed].state ?? (theta(bed) < GH_MODEL.severeBelow ? "severe-wilt" : theta(bed) < GH_MODEL.dryBelow ? "wilting" : theta(bed) > GH_MODEL.wetAbove ? "waterlogged" : "healthy");
    const reading = rig.probe ? theta(rig.probe) : null;
    return {
      tank: snapshot.tank,
      tankCapacity: GH_MODEL.tankLitres,
      beds: { A: { theta: theta("A"), state: stateOf("A") }, B: { theta: theta("B"), state: stateOf("B") } },
      air: snapshot.air,
      sun: record?.sun ?? 0,
      reading,
      battery: snapshot.battery,
      pump: record?.pump ?? "off",
      fan: record?.fan ?? "off",
      channels: { ch1: rig.pumpChannel === 1 ? "pump" : rig.fanChannel === 1 ? "fan" : null, ch2: rig.pumpChannel === 2 ? "pump" : rig.fanChannel === 2 ? "fan" : null },
      solarCharging: rig.solar && (record?.solarW ?? 0) > 0,
      flowing,
      lineStatus: new Map(rig.lines.map((line) => [line.id, line.status])),
      faultPorts,
      modelTime: clockAt(snapshot.tick),
    };
  }

  private status(): { tick: number; label: string; tone: "neutral" | "valid" | "warning"; running: boolean; finished: boolean } {
    const run = this.run;
    const tick = this.projection?.snapshot.tick ?? run?.tick ?? 0;
    const finished = tick >= GH_MODEL.steps;
    if (!run) return { tick, label: "Waiting for the room", tone: "neutral", running: false, finished: false };
    if (finished) return { tick, label: "Day over", tone: "valid", running: false, finished: true };
    if (run.status === "running") return { tick, label: `Running ×${run.speed}`, tone: "valid", running: true, finished: false };
    if (run.status === "paused") return { tick, label: "Paused", tone: "warning", running: false, finished: false };
    return { tick, label: "Not started", tone: "neutral", running: false, finished: false };
  }

  // ── Run actions ──────────────────────────────────────────────────────────────────

  private async toggleRun(): Promise<void> {
    const run = this.run;
    if (!run) return;
    const { running, finished } = this.status();
    if (finished) {
      await this.resetDay();
      return;
    }
    if (running) await this.send({ type: "pause" }, "Paused the day");
    else if (run.status === "paused") await this.send({ type: "resume" }, "Resumed the day");
    else await this.send({ type: "start" }, "Started the day");
  }

  private async send(action: GhAction, label: string): Promise<boolean> {
    if (this.actionPending) {
      this.runNote = { text: "Still waiting for the room to answer the last run control", tone: "neutral" };
      this.renderDay();
      return false;
    }
    this.actionPending = true;
    this.unconfirmed = null;
    const before = this.run;
    this.runNote = { text: "Sending to the room…", tone: "neutral" };
    this.renderDay();
    // The run this decision was made on: the room refuses it (stale) if a teammate reset meanwhile.
    const result = await this.host.action(this.run ? { ...action, runId: this.run.runId } : action);
    this.actionPending = false;
    if (result.ok) this.runNote = { text: `${label} · for everyone in the room`, tone: "valid" };
    else {
      const reason = result.reason ?? "";
      this.runNote = { text: RUN_REFUSALS[reason] ? `Not applied · ${RUN_REFUSALS[reason]}; nothing changed.` : notAppliedCopy(reason, "Not applied", ""), tone: "warning" };
      // Uncertain: if the room's next day state shows it applied, say so then.
      if (!RUN_REFUSALS[reason] && reason !== "offline" && before) this.unconfirmed = { action, before, label };
    }
    this.renderDay();
    return result.ok;
  }

  private async resetDay(): Promise<boolean> {
    const seedInput = await this.chooseSeed();
    if (seedInput === null) return false;
    return this.send({ type: "reset", seed: seedInput }, seedInput === GH_MODEL.briefSeed ? "Reset to the brief's day (seed 11): tank refilled to 40 L" : `Reset to practice day ${seedInput}: tank refilled to 40 L`);
  }

  /** Asks which day to reset to (the brief's, or a practice seed). Null: cancelled. */
  private async chooseSeed(): Promise<number | null> {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog gh-reset-dialog";
    dialog.setAttribute("aria-labelledby", "gh-reset-title");
    const current = this.run?.seed ?? GH_MODEL.briefSeed;
    dialog.innerHTML = `<form method="dialog" class="gh-reset-form">
      <h2 id="gh-reset-title">Reset the day for everyone?</h2>
      <p>Model time goes back to 06:00, the tank refills to 40 L, the beds and battery start again. The rig stays as built. Earlier attempts stay in your history.</p>
      <fieldset><legend>Which day</legend>
        <label class="ss-choice"><input type="radio" name="gh-seed-kind" value="brief" ${current === GH_MODEL.briefSeed ? "checked" : ""}> <span>The brief's day (seed 11): the one that counts</span></label>
        <label class="ss-choice"><input type="radio" name="gh-seed-kind" value="practice" ${current !== GH_MODEL.briefSeed ? "checked" : ""}> <span>A practice day, seed <input type="number" name="gh-seed" min="1" max="99999" step="1" value="${current !== GH_MODEL.briefSeed ? current : 7}" aria-label="Practice seed (1 to 99999)"></span></label>
      </fieldset>
      <p class="gh-reset-error" role="alert" hidden></p>
      <div class="dialog-actions"><button type="button" class="secondary-button" value="cancel">Cancel</button><button type="submit" class="primary-button" value="reset">Reset day</button></div>
    </form>`;
    document.body.append(dialog);
    return new Promise((resolve) => {
      const form = dialog.querySelector<HTMLFormElement>("form")!;
      const error = dialog.querySelector<HTMLElement>(".gh-reset-error")!;
      let answered = false;
      const finish = (value: number | null): void => {
        if (answered) return;
        answered = true;
        dialog.close();
        dialog.remove();
        resolve(value);
      };
      dialog.querySelector<HTMLButtonElement>('button[value="cancel"]')!.addEventListener("click", () => finish(null));
      dialog.addEventListener("cancel", () => finish(null));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const kind = (form.elements.namedItem("gh-seed-kind") as RadioNodeList).value;
        if (kind !== "practice") return finish(GH_MODEL.briefSeed);
        const raw = (form.elements.namedItem("gh-seed") as HTMLInputElement).value.trim();
        const seed = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(seed) || seed < 1 || seed > 99999) {
          error.hidden = false;
          error.textContent = "Enter a whole-number seed from 1 to 99999.";
          return;
        }
        finish(seed);
      });
      dialog.showModal();
      dialog.querySelector<HTMLInputElement>("input:checked")?.focus();
    });
  }

  // ── Loop ─────────────────────────────────────────────────────────────────────────

  private current(): Attempt {
    return this.session.attempts[this.session.attempts.length - 1];
  }

  /** A finished day becomes the current attempt's result (once), with criterion codes traced. */
  private noteFinished(): void {
    const run = this.run;
    const projection = this.projection;
    const rig = this.rig;
    if (!run || !projection || !rig || projection.snapshot.tick < GH_MODEL.steps) return;
    const attempt = this.current();
    if (attempt.result || (attempt.afterRun !== null && run.runId <= attempt.afterRun)) return;
    const brief = evaluateBrief(projection.snapshot, rig);
    const briefDay = run.seed === GH_MODEL.briefSeed;
    attempt.result = { at: Date.now(), runId: run.runId, seed: run.seed, met: brief.met && briefDay, criteria: brief.criteria, summary: this.rigSummary() };
    attempt.explained = false;
    if (this.session.firstFinishedAt === null) this.session.firstFinishedAt = Date.now();
    this.saveSession();
    const passed = brief.criteria.filter((criterion) => criterion.pass).map((criterion) => criterion.id);
    this.host.trace("test", `Greenhouse day · attempt ${attempt.n} · seed ${run.seed}${briefDay ? "" : " (practice)"} · ${brief.met ? "all five met" : `${passed.length}/5 (failed ${brief.criteria.filter((criterion) => !criterion.pass).map((criterion) => criterion.id).join(", ")})`}`);
    this.host.status(brief.met ? (briefDay ? "Day over · all five criteria met · now explain why it worked" : "Practice day over · all five met (the brief is judged on seed 11)") : `Day over · ${passed.length} of 5 criteria met`, brief.met ? "valid" : "neutral");
    this.renderWorked();
  }

  private saveExplanation(): void {
    const attempt = this.current();
    if (!attempt.result || attempt.explanation.trim().length < 8) return;
    attempt.explained = true;
    this.saveSession();
    this.host.trace("reflect", `Greenhouse explanation saved · attempt ${attempt.n}${attempt.result.met ? " · brief met" : ""}`);
    this.host.status(attempt.result.met ? "Explanation saved · brief met and explained" : "Explanation saved · revise the rig and run again", "valid");
    this.queueRender();
  }

  /** A new attempt resets the day for everyone (confirmed); the attempt counts days after that. */
  private async newAttempt(): Promise<void> {
    const run = this.run;
    const fresh = run && run.status === "idle" && run.tick === 0;
    if (!fresh) {
      const reset = await this.resetDay();
      if (!reset) return;
    }
    // The room's new run arrived before the reset resolved: days from this run on count.
    const after = this.run ? this.run.runId - 1 : null;
    this.session.attempts.push({ n: this.session.attempts.length + 1, prediction: null, why: "", afterRun: after, result: null, explanation: "", explained: false });
    this.session.attempts = this.session.attempts.slice(-20);
    this.saveSession();
    this.queueRender();
    document.querySelector<HTMLInputElement>("#gh-predictions input")?.focus();
  }

  private rigSummary(): string {
    const rig = this.rig;
    if (!rig) return "";
    const water = rig.supply ? (rig.viaManifold ? `tank → pump → manifold (A ${rig.manifold.valveA} %, B ${rig.manifold.valveB} %)` : rig.delivery ? "tank → pump → one bed" : "tank → pump, no outlet") : "no supply hose";
    const power = `${rig.solar ? "solar in" : "no solar"} · CH1 ${rig.pumpChannel === 1 ? "pump" : rig.fanChannel === 1 ? "fan" : "—"} · CH2 ${rig.pumpChannel === 2 ? "pump" : rig.fanChannel === 2 ? "fan" : "—"}`;
    return `${water} · ${power} · pump below ${rig.controller.pumpBelow} %, fan above ${rig.controller.fanAbove} °C · probe ${rig.probe ? `in bed ${rig.probe}` : "not in a bed"}`;
  }

  // ── Edits ────────────────────────────────────────────────────────────────────────

  /** Whether the room refuses rig changes now (the day is running). */
  rigLocked(): boolean {
    return this.locked();
  }

  /** Brings the Selected card into view (a part was selected in 3D). */
  revealSelected(): void {
    document.querySelector<HTMLElement>("#gh-part-title")?.closest<HTMLElement>("section")?.scrollIntoView({ block: "nearest" });
  }

  private locked(): boolean {
    const run = this.run;
    return Boolean(run && run.status === "running" && (this.projection?.snapshot.tick ?? run.tick) < GH_MODEL.steps);
  }

  private draftValue(part: string, param: Param): string {
    const key = `${part}:${param}`;
    if (this.drafts.has(key)) return this.drafts.get(key)!;
    const rig = this.rig;
    if (!rig) return "";
    return String(param === "valveA" || param === "valveB" ? rig.manifold[param] : rig.controller[param]);
  }

  private stepDraft(key: string, delta: number): void {
    const [part, param] = key.split(":") as [string, Param];
    const bounds = GH_BOUNDS[param];
    const current = Number(this.draftValue(part, param));
    if (!bounds || !Number.isFinite(current)) return;
    const next = Math.min(bounds.max, Math.max(bounds.min, Math.round((current + delta * bounds.step - bounds.min) / bounds.step) * bounds.step + bounds.min));
    this.drafts.set(key, String(next));
    this.render();
    document.querySelector<HTMLElement>(`#gh-part-panel [data-draft="${key}"]`)?.focus();
  }

  private revertDrafts(part: string): void {
    for (const key of [...this.drafts.keys()]) if (key.startsWith(`${part}:`)) this.drafts.delete(key);
    this.editNote = { part, text: "Draft discarded · showing the room's values", tone: "neutral" };
    this.answered = true;
    this.render();
  }

  private validate(param: Param, raw: string): string | null {
    const bounds = GH_BOUNDS[param];
    const value = /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
    const unit = param === "fanAbove" ? " °C" : " %";
    const name = param === "valveA" ? "Valve A" : param === "valveB" ? "Valve B" : param === "pumpBelow" ? "Pump below" : "Fan above";
    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) return `${name}: enter ${bounds.min}–${bounds.max}${unit}.`;
    if (Math.abs((value - bounds.min) / bounds.step - Math.round((value - bounds.min) / bounds.step)) > 1e-9) return `${name}: use ${bounds.step}${unit.trim() === "%" ? " %" : unit} steps (the room refuses values between steps).`;
    return null;
  }

  /** One room edit with the part's drafted values. Nothing changes until the room accepts it. */
  private async applyValues(part: string): Promise<void> {
    const workbench = this.host.workbench();
    if (!workbench) return;
    if (this.pending.has(part)) {
      this.editNote = { part, text: "Still waiting for the room to confirm the previous values · your new draft is kept; apply it again once that is answered", tone: "neutral" };
      this.answered = true;
      this.render();
      return;
    }
    const params: Param[] = part === "valve-manifold" ? ["valveA", "valveB"] : ["pumpBelow", "fanAbove"];
    for (const param of params) {
      const problem = this.validate(param, this.draftValue(part, param));
      if (problem) {
        this.editNote = { part, text: problem, tone: "warning" };
        this.answered = true;
        this.render();
        return;
      }
    }
    const before = workbench.getSharedTransforms()[part] ?? workbench.defaultTransform(part);
    if (!before) return;
    const props: GhProps = Object.fromEntries(params.map((param) => [param, Number(this.draftValue(part, param))]));
    const label = part === "valve-manifold" ? `Set valves to A ${props.valveA} %, B ${props.valveB} %` : `Set rules to pump below ${props.pumpBelow} %, fan above ${props.fanAbove} °C`;
    const submitted = new Map([...this.drafts].filter(([key]) => key.startsWith(`${part}:`)));
    this.pending.add(part);
    this.editNote = { part, text: "Sending to the room…", tone: "neutral" };
    this.answered = true;
    this.render();
    const result = await this.host.submit([{ id: part, transform: { ...before, props } }], label, part);
    this.pending.delete(part);
    if (result.ok) {
      const newer = clearSubmittedDrafts(this.drafts, part, submitted);
      this.editNote = { part, text: `${label} · shared with the room${newer ? " · the newer value you typed meanwhile is kept as a draft below" : ""}`, tone: "valid" };
    } else if (result.reason === "running") {
      this.editNote = { part, text: "Not applied · the day is running; pause it to change the rig. Nothing changed. Your draft is kept below.", tone: "warning" };
    } else {
      this.editNote = { part, text: notAppliedCopy(result.reason, "Not applied", "Your draft is kept below"), tone: "warning" };
    }
    this.answered = true;
    this.render();
  }

  /** Keyboard plumbing: the chosen ports for a line's two ends, as one room edit. */
  private async connectLine(form: HTMLFormElement): Promise<void> {
    const id = form.dataset.ports!;
    const workbench = this.host.workbench();
    if (!workbench || this.pending.has(id)) return;
    const value = (end: 0 | 1): number | null => {
      const raw = form.querySelector<HTMLSelectElement>(`select[data-end="${end}"]`)?.value ?? "";
      return raw === "" ? null : Number(raw);
    };
    const ends: [number | null, number | null] = [value(0), value(1)];
    if (ends[0] !== null && ends[0] === ends[1]) {
      this.editNote = { part: id, text: "Both ends cannot go into one port.", tone: "warning" };
      this.answered = true;
      this.render();
      return;
    }
    const transform = ends[0] === null && ends[1] === null
      ? workbench.homeTransform(id)
      : ends[0] !== null && ends[1] !== null
        ? workbench.placementTransform(id, [ends[0], ends[1]])
        : workbench.partialLineTransform(id, ends);
    if (!transform) return;
    const label = `${LINE_NAMES[id].name}: ${ends.map((end) => (end === null ? "free" : portLabel(end))).join(" ↔ ")}`;
    this.pending.add(id);
    this.editNote = { part: id, text: "Sending to the room…", tone: "neutral" };
    this.answered = true;
    this.render();
    const result = await this.host.submit([{ id, transform }], label, id);
    this.pending.delete(id);
    this.editNote = result.ok
      ? { part: id, text: `${label} · shared with the room`, tone: "valid" }
      : result.reason === "running"
        ? { part: id, text: "Not applied · the day is running; pause it to change the rig. Nothing changed.", tone: "warning" }
        : { part: id, text: notAppliedCopy(result.reason, "Not applied", ""), tone: "warning" };
    this.answered = true;
    this.render();
  }

  private async placeProbe(bed: "A" | "B"): Promise<void> {
    const workbench = this.host.workbench();
    const id = "soil-sensor";
    if (!workbench || this.pending.has(id)) return;
    const transform = workbench.placementTransform(id, GH_PROBE_SLOTS[bed]);
    if (!transform) return;
    this.pending.add(id);
    this.editNote = { part: id, text: "Sending to the room…", tone: "neutral" };
    this.answered = true;
    this.render();
    const result = await this.host.submit([{ id, transform }], `Soil probe into bed ${bed}`, id);
    this.pending.delete(id);
    this.editNote = result.ok ? { part: id, text: `Soil probe into bed ${bed} · shared with the room`, tone: "valid" } : { part: id, text: result.reason === "running" ? "Not applied · the day is running; pause it to change the rig. Nothing changed." : notAppliedCopy(result.reason, "Not applied", ""), tone: "warning" };
    this.answered = true;
    this.render();
  }

  private async returnHome(id: string): Promise<void> {
    if (this.pending.has(id)) return;
    this.pending.add(id);
    this.editNote = { part: id, text: "Sending to the room…", tone: "neutral" };
    this.answered = true;
    this.render();
    const ok = await this.host.returnHome(id);
    this.pending.delete(id);
    this.editNote = ok ? { part: id, text: id === "soil-sensor" ? "Probe back in its holder for everyone" : `${partName(id)} unplugged and coiled in the aisle for everyone`, tone: "valid" } : { part: id, text: this.locked() ? "Not applied · the day is running; pause it to change the rig. Nothing changed." : "Not applied · see the status above. Nothing changed.", tone: "warning" };
    this.answered = true;
    this.render();
  }

  // ── Rendering ────────────────────────────────────────────────────────────────────

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
    this.renderDay();
    this.renderFlow();
    this.renderPart();
    this.renderLoop();
  }

  private write(element: HTMLElement, key: string, html: string): boolean {
    if (this.written.get(key) === html && element.innerHTML !== "") return false;
    this.written.set(key, html);
    element.innerHTML = html;
    return true;
  }

  private renderHud(): void {
    const projection = this.projection;
    const rig = this.rig;
    if (!projection || !rig) return;
    const snapshot = projection.snapshot;
    const set = (id: string, text: string): void => {
      const element = document.getElementById(id);
      if (element && element.textContent !== text) element.textContent = text;
    };
    const status = this.status();
    set("metric-clock", clockAt(snapshot.tick));
    set("metric-tank", `${snapshot.tank.toFixed(1)} L`);
    set("metric-moisture", rig.probe ? `${Math.round((snapshot.beds[rig.probe] / GH_MODEL.bedCapacity) * 100)} % ${rig.probe}` : "no probe");
    set("metric-temperature", `${snapshot.air.toFixed(1)} °C`);
    set("metric-battery", `${snapshot.battery.toFixed(1)} Wh`);
    const chip = document.getElementById("greenhouse-status");
    if (chip) {
      chip.textContent = status.label;
      chip.dataset.tooltip = status.finished ? "The day is over" : status.running ? "The day is running (rig locked)" : "Model time stopped";
      chip.classList.toggle("is-ready", status.running);
    }
  }

  private renderWorked(): void {
    const card = document.querySelector<HTMLElement>("#gh-worked");
    if (!card) return;
    if (this.host.condition() !== "DI") {
      card.hidden = true;
      card.innerHTML = "";
      return;
    }
    if (!this.worked) {
      const day = simulate(initialSnapshot(GH_MODEL.briefSeed), workedRig(), GH_MODEL.briefSeed, GH_MODEL.steps).snapshot;
      this.worked = { stressA: day.stress.A * GH_MODEL.dtHours, stressB: day.stress.B * GH_MODEL.dtHours, heat: day.stress.heat * GH_MODEL.dtHours, tank: day.tank };
    }
    const w = this.worked;
    const example = GH_WORKED_EXAMPLE;
    card.hidden = false;
    card.innerHTML = `<div class="ss-card-head"><h3 id="gh-worked-title"><i class="ph ph-lightbulb" aria-hidden="true"></i> Worked example</h3><small>numbers from the same model</small></div>
      <p>One allocation that meets the brief: build the full rig, then valve A <strong>${example.valveA} %</strong> and valve B <strong>${example.valveB} %</strong> (bed B drinks more), pump below <strong>${example.pumpBelow} %</strong> with the probe in bed <strong>${example.probe}</strong>, fan above <strong>${example.fanAbove} °C</strong>, pump on CH${example.pumpChannel} and fan on CH${example.pumpChannel === 1 ? 2 : 1}.</p>
      <p>On the brief's day that gives bed A ${w.stressA} h and bed B ${w.stressB} h out of range, air above 35 °C for ${w.heat} h, and ${w.tank.toFixed(1)} L left. Why it works: B's larger share matches its larger uptake, and the early fan threshold keeps the midday peak down while the battery covers the gap.</p>`;
  }

  private renderDay(): void {
    const run = this.run;
    const projection = this.projection;
    const status = this.status();
    const state = document.querySelector<HTMLElement>("#gh-day-state");
    const clock = document.querySelector<HTMLElement>("#gh-clock");
    const toggle = document.querySelector<HTMLButtonElement>("#gh-run-toggle");
    const step = document.querySelector<HTMLButtonElement>("#gh-step");
    const note = document.querySelector<HTMLElement>("#gh-run-note");
    if (state) state.textContent = run ? `${status.label} · ${run.seed === GH_MODEL.briefSeed ? "brief's day (seed 11)" : `practice day (seed ${run.seed})`}` : status.label;
    if (clock) {
      const tick = status.tick;
      const percent = (tick / GH_MODEL.steps) * 100;
      this.write(clock, "clock", `<span class="gh-time"><strong>${clockAt(tick)}</strong> <small>${tick >= GH_MODEL.steps ? "next day · day over" : `model time · step ${tick} of ${GH_MODEL.steps}`}</small></span>
        <span class="gh-dayline" aria-hidden="true"><span style="width:${percent.toFixed(2)}%"></span></span>`);
    }
    if (toggle) {
      const label = status.finished ? "Reset for another run…" : status.running ? "Pause" : run?.status === "paused" ? "Resume" : "Start the day";
      const icon = status.finished ? "ph-arrow-counter-clockwise" : status.running ? "ph-pause" : "ph-play";
      const html = `<i class="ph ${icon}" aria-hidden="true"></i> <span>${label}</span>`;
      if (toggle.innerHTML !== html) toggle.innerHTML = html;
      toggle.disabled = !run || this.actionPending;
    }
    if (step) step.disabled = !run || status.running || status.finished || this.actionPending;
    document.querySelectorAll<HTMLButtonElement>("#gh-panel [data-speed]").forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.speed) === (run?.speed ?? 1)));
      button.disabled = !run || this.actionPending;
    });
    const reset = document.querySelector<HTMLButtonElement>("#gh-reset");
    if (reset) reset.disabled = !run || this.actionPending;
    if (note) {
      note.hidden = !this.runNote;
      if (this.runNote) {
        note.textContent = this.runNote.text;
        note.dataset.tone = this.runNote.tone;
      }
    }
    if (!projection) return;
    this.renderGraph();
    this.renderVerdict();
  }

  private series(): Array<{ k: number; tank: number; a: number; b: number; air: number; outside: number | null; battery: number; pump: string; fan: string }> {
    const projection = this.projection!;
    const start = this.run?.snapshot.start ?? projection.snapshot.start;
    const first = { k: 0, tank: start.tank, a: start.beds.A / GH_MODEL.bedCapacity, b: start.beds.B / GH_MODEL.bedCapacity, air: initialAir(this.run?.seed ?? GH_MODEL.briefSeed), outside: null, battery: start.battery, pump: "off", fan: "off" };
    return [first, ...projection.records.map((record) => ({ k: record.k + 1, tank: record.tank, a: record.beds.A.theta, b: record.beds.B.theta, air: record.air, outside: record.outside, battery: record.battery, pump: record.pump, fan: record.fan }))];
  }

  private renderGraph(): void {
    const graph = document.querySelector<HTMLElement>("#gh-graph");
    const legend = document.querySelector<HTMLElement>("#gh-legend");
    const summary = document.querySelector<HTMLElement>("#gh-graph-summary");
    const table = document.querySelector<HTMLElement>("#gh-table");
    if (!graph || !this.projection) return;
    const points = this.series();
    const W = 560;
    const left = 46;
    const right = 10;
    const lane = 64;
    const gap = 16;
    const top = 8;
    const plotW = W - left - right;
    const x = (k: number): number => left + (k / GH_MODEL.steps) * plotW;
    const lanes = [
      { key: "water", title: "Tank (L)", min: 0, max: 40, ticks: [0, 8, 20, 40] },
      { key: "soil", title: "Soil θ (%)", min: 0, max: 100, ticks: [0, 30, 90, 100] },
      { key: "air", title: "Air (°C)", min: 10, max: 45, ticks: [10, 25, 35, 45] },
      { key: "power", title: "Battery (Wh)", min: 0, max: 12, ticks: [0, 6, 12] },
    ];
    const H = top + lanes.length * (lane + gap) + 22;
    const parts: string[] = [];
    lanes.forEach((entry, index) => {
      const y0 = top + index * (lane + gap);
      const y = (value: number): number => y0 + lane - ((value - entry.min) / (entry.max - entry.min)) * lane;
      parts.push(`<g class="gg-lane" data-lane="${entry.key}"><rect class="gg-plot" x="${left}" y="${y0}" width="${plotW}" height="${lane}"/>`);
      if (entry.key === "soil") parts.push(`<rect class="gg-band" x="${left}" y="${y(90)}" width="${plotW}" height="${y(30) - y(90)}"/>`);
      for (const tick of entry.ticks) parts.push(`<line class="gg-grid" x1="${left}" x2="${left + plotW}" y1="${y(tick)}" y2="${y(tick)}"/><text class="gg-tick" x="${left - 5}" y="${y(tick) + 3}" text-anchor="end">${tick}</text>`);
      parts.push(`<text class="gg-title" x="${left + 4}" y="${y0 + 11}">${entry.title}</text>`);
      if (entry.key === "water") parts.push(`<line class="gg-limit" x1="${left}" x2="${left + plotW}" y1="${y(GH_MODEL.reserve)}" y2="${y(GH_MODEL.reserve)}"/><text class="gg-limit-label" x="${left + plotW - 3}" y="${y(GH_MODEL.reserve) - 3}" text-anchor="end">reserve 8 L</text>`);
      if (entry.key === "air") parts.push(`<line class="gg-limit" x1="${left}" x2="${left + plotW}" y1="${y(GH_MODEL.heatAbove)}" y2="${y(GH_MODEL.heatAbove)}"/><text class="gg-limit-label" x="${left + plotW - 3}" y="${y(GH_MODEL.heatAbove) - 3}" text-anchor="end">35 °C</text>`);
      const path = (pick: (point: (typeof points)[number]) => number | null): string => {
        let d = "";
        for (const point of points) {
          const value = pick(point);
          if (value === null) continue;
          d += `${d ? "L" : "M"}${x(point.k).toFixed(1)},${y(Math.max(entry.min, Math.min(entry.max, value))).toFixed(1)}`;
        }
        return d;
      };
      if (points.length > 1 || entry.key !== "air") {
        if (entry.key === "water") parts.push(`<path class="gg-line is-tank" d="${path((p) => p.tank)}"/>`);
        if (entry.key === "soil") parts.push(`<path class="gg-line is-bed-a" d="${path((p) => p.a * 100)}"/><path class="gg-line is-bed-b" d="${path((p) => p.b * 100)}"/>`);
        if (entry.key === "air") parts.push(`<path class="gg-line is-outside" d="${path((p) => p.outside)}"/><path class="gg-line is-air" d="${path((p) => (p.k === 0 ? null : p.air))}"/>`);
        if (entry.key === "power") {
          parts.push(`<path class="gg-line is-battery" d="${path((p) => p.battery)}"/>`);
          // Load strip under the lane: pump and fan per step (✕ marks starved).
          for (const point of points.slice(1)) {
            const x0 = x(point.k - 1);
            const w = Math.max(1, x(point.k) - x0 - 0.3);
            if (point.pump !== "off") parts.push(`<rect class="gg-load ${point.pump === "starved" ? "is-starved" : "is-pump"}" x="${x0.toFixed(1)}" y="${y0 + lane + 2}" width="${w.toFixed(1)}" height="4"/>`);
            if (point.fan !== "off") parts.push(`<rect class="gg-load ${point.fan === "starved" ? "is-starved" : "is-fan"}" x="${x0.toFixed(1)}" y="${y0 + lane + 7}" width="${w.toFixed(1)}" height="4"/>`);
          }
        }
      }
      parts.push(`</g>`);
    });
    const axisY = top + lanes.length * (lane + gap) + 4;
    for (const k of [0, 24, 48, 72, 96]) parts.push(`<text class="gg-tick" x="${x(k)}" y="${axisY + 8}" text-anchor="middle">${clockAt(k)}</text>`);
    const tick = this.projection.snapshot.tick;
    parts.push(`<line class="gg-now" x1="${x(tick)}" x2="${x(tick)}" y1="${top}" y2="${axisY - 6}"/>`);
    this.write(graph, "graph", `<svg class="gg-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${parts.join("")}</svg>`);
    if (legend) this.write(legend, "legend", `<li><span class="gg-key is-tank"></span>tank</li><li><span class="gg-key is-bed-a"></span>bed A (solid)</li><li><span class="gg-key is-bed-b"></span>bed B (dashed)</li><li><span class="gg-key is-air"></span>air</li><li><span class="gg-key is-outside"></span>outside (dotted)</li><li><span class="gg-key is-battery"></span>battery</li><li><span class="gg-key is-pump-strip"></span>pump ran</li><li><span class="gg-key is-fan-strip"></span>fan ran</li><li><span class="gg-key is-starved-strip"></span>starved</li><li><span class="gg-key is-band"></span>soil 30–90 %</li>`);
    const last = points[points.length - 1];
    const snapshot = this.projection.snapshot;
    const text = `At ${clockAt(tick)}: tank ${last.tank.toFixed(1)} L, bed A ${Math.round(last.a * 100)} %, bed B ${Math.round(last.b * 100)} %, air ${snapshot.air.toFixed(1)} °C, battery ${last.battery.toFixed(1)} Wh. So far: bed A out of range ${snapshot.stress.A * GH_MODEL.dtHours} h, bed B ${snapshot.stress.B * GH_MODEL.dtHours} h, air above 35 °C ${snapshot.stress.heat * GH_MODEL.dtHours} h; pumped ${snapshot.totals.pumped.toFixed(1)} L, drained ${(snapshot.totals.drainage + snapshot.totals.overflow).toFixed(1)} L, taken up ${snapshot.totals.et.toFixed(1)} L.`;
    if (summary && summary.textContent !== text) summary.textContent = text;
    graph.setAttribute("aria-label", `Resource graph. ${text}`);
    if (table) {
      const rows = points.filter((point) => point.k % 4 === 0).map((point) => `<tr><th scope="row">${clockAt(point.k)}</th><td>${point.tank.toFixed(1)}</td><td>${Math.round(point.a * 100)}</td><td>${Math.round(point.b * 100)}</td><td>${point.k === 0 ? "—" : point.air.toFixed(1)}</td><td>${point.battery.toFixed(1)}</td></tr>`).join("");
      this.write(table, "table", `<table class="gh-data"><thead><tr><th scope="col">Time</th><th scope="col">Tank L</th><th scope="col">Bed A %</th><th scope="col">Bed B %</th><th scope="col">Air °C</th><th scope="col">Battery Wh</th></tr></thead><tbody>${rows}</tbody></table>`);
    }
  }

  private renderVerdict(): void {
    const verdict = document.querySelector<HTMLElement>("#gh-verdict");
    const projection = this.projection;
    const rig = this.rig;
    if (!verdict || !projection || !rig) return;
    if (projection.snapshot.tick < GH_MODEL.steps) {
      this.write(verdict, "verdict", `<p class="ss-fine">The verdict appears when the day ends (06:00 the next morning). Until then, the graph and diagram show what is happening.</p>`);
      return;
    }
    const brief = evaluateBrief(projection.snapshot, rig);
    const briefDay = this.run?.seed === GH_MODEL.briefSeed;
    const di = this.host.condition() === "DI";
    const passed = brief.criteria.filter((criterion) => criterion.pass).length;
    this.write(verdict, "verdict", `<p class="ss-result-head"><strong>${brief.met ? (briefDay ? "All five criteria met." : "All five met on this practice day.") : `${passed} of 5 criteria met.`}</strong>${briefDay ? "" : " The brief is judged on the brief's day (seed 11)."}</p>
      <ul class="ss-checks">${brief.criteria.map((criterion) => `<li data-criterion="${criterion.id}" data-pass="${criterion.pass}"><span class="ss-mark" aria-hidden="true">${criterion.pass ? "✓" : "✕"}</span><span><strong>${criterion.id} ${criterion.pass ? "met" : "not met"}</strong> · measured: ${escape(criterion.measured)}${!criterion.pass && di ? `<br><span class="ss-why-note">${escape(DI_EXPLANATIONS[criterion.id])}</span>` : ""}</span></li>`).join("")}</ul>
      <p class="ss-fine">G1 is judged on the build as it is now; G2–G5 on the day's record.</p>`);
  }

  private renderFlow(): void {
    const projection = this.projection;
    const rig = this.rig;
    const diagram = document.querySelector<HTMLElement>("#gh-diagram");
    const list = document.querySelector<HTMLElement>("#gh-list");
    const notes = document.querySelector<HTMLElement>("#gh-notes");
    const summary = document.querySelector<HTMLElement>("#gh-flow-summary");
    if (!projection || !rig || !diagram || !list || !notes) return;
    const record = this.lastRecord();
    const selected = this.host.selectedId();
    const focused = document.activeElement?.closest?.("#gh-diagram [data-select], #gh-diagram [data-line]");
    const focusKey = focused ? focused.getAttribute("data-select") ?? focused.getAttribute("data-line") : null;
    if (this.write(diagram, "diagram", renderGhDiagramSvg({ rig, snapshot: projection.snapshot, record, selected })) && focusKey) {
      diagram.querySelector<SVGElement>(`[data-select="${focusKey}"], [data-line="${focusKey}"]`)?.focus();
    }
    this.write(list, "list", renderGhConnectionList(rig, record));
    const showNotes = this.host.condition() === "DI" || this.session.firstFinishedAt !== null;
    const { shown, withheld } = faultNotes(rig, showNotes);
    this.write(notes, "notes", `${shown.map((note) => `<p><i class="ph ph-warning-circle" aria-hidden="true"></i> ${escape(note)}</p>`).join("")}${withheld ? `<p class="sd-withheld">${withheld} explanatory note${withheld === 1 ? "" : "s"} appear${withheld === 1 ? "s" : ""} after your own first finished day in this session (the diagram already shows the rig as built).</p>` : ""}${!shown.length && !withheld ? `<p class="sd-ok"><i class="ph ph-check-circle" aria-hidden="true"></i> Built as the brief needs (G1). Whether the day goes well depends on the allocation.</p>` : ""}`);
    if (summary) summary.textContent = rig.complete ? "Rig complete" : `${rig.faults.length} open issue${rig.faults.length === 1 ? "" : "s"}`;
  }

  private setTab(tab: InspectTab, focus: boolean): void {
    this.tab = tab;
    document.querySelectorAll<HTMLButtonElement>("#gh-tabs [data-gh-tab]").forEach((button) => {
      const active = button.dataset.ghTab === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });
    document.querySelector("#gh-part-panel")?.setAttribute("aria-labelledby", `gh-tab-${tab}`);
    this.renderPart();
  }

  private renderPart(): void {
    const panel = document.querySelector<HTMLElement>("#gh-part-panel");
    const title = document.querySelector<HTMLElement>("#gh-part-title");
    const hint = document.querySelector<HTMLElement>("#gh-part-hint");
    const rig = this.rig;
    if (!panel || !rig || !this.projection) return;
    const active = document.activeElement as HTMLElement | null;
    // While the learner is in a field of this card it is not rebuilt (typing and focus stay),
    // except right after an edit of theirs was answered (the field then shows the room's value).
    const answered = this.answered;
    this.answered = false;
    if (!answered && active && panel.contains(active) && active.matches("input, textarea, select")) return;
    const activeKey = active && panel.contains(active) ? active.dataset.draft ?? active.dataset.focusKey ?? null : null;
    const caret = active instanceof HTMLInputElement ? active.selectionStart : null;
    const selected = this.host.selectedId();
    if (!selected || !(selected in FIXTURE_NAMES || selected in LINE_NAMES)) {
      if (title) title.textContent = "Selected";
      if (hint) hint.hidden = false;
      this.write(panel, "part", `<p class="si-empty">Select equipment, a hose, a cable or the probe in 3D, on the diagram or in the connection list.</p>`);
      return;
    }
    if (hint) hint.hidden = true;
    if (title) this.write(title, "title", LINE_NAMES[selected] ? `<span class="sd-swatch" style="background:${LINE_NAMES[selected].css}" aria-hidden="true"></span> ${escape(LINE_NAMES[selected].name)} <small>${escape(LINE_NAMES[selected].length)} ${LINE_NAMES[selected].hose ? "hose" : "power cable"}</small>` : escape(partName(selected)));
    const html = LINE_NAMES[selected] ? this.lineCard(selected) : this.fixtureCard(selected);
    if (!this.write(panel, "part", html)) return;
    if (activeKey) {
      const target = panel.querySelector<HTMLElement>(`[data-draft="${activeKey}"], [data-focus-key="${activeKey}"]`);
      target?.focus();
      if (target instanceof HTMLInputElement && caret !== null && target.type === "text") target.setSelectionRange(Math.min(caret, target.value.length), Math.min(caret, target.value.length));
    }
  }

  private holderNote(id: string): string {
    const holder = this.host.holderOf(id);
    return holder ? `<p class="si-edit-note" data-tone="warning">${escape(holder)} is holding this; edits wait until they let go.</p>` : "";
  }

  private lockNote(): string {
    return this.locked() ? `<p class="si-edit-note" data-tone="warning"><i class="ph ph-lock-simple" aria-hidden="true"></i> The day is running: the rig is locked for everyone. Pause the day to change it.</p>` : "";
  }

  private lineCard(id: string): string {
    const rig = this.rig!;
    const line = rig.lines.find((entry) => entry.id === id)!;
    const flow = lineFlows(rig, this.lastRecord()).get(id)!;
    const note = this.editNote?.part === id ? `<p class="si-edit-note" data-tone="${this.editNote.tone}" role="status">${escape(this.editNote.text)}</p>` : "";
    const names = LINE_NAMES[id];
    const endWords = (index: 0 | 1): string => (line.ends[index] === null ? "free" : portLabel(line.ends[index]!));
    if (this.tab === "ports") {
      const fits = names.hose ? "water couplers only (TANK OUT, PUMP IN/OUT, MANIFOLD IN, VALVE A/B OUT, BED A/B INLET)" : "power sockets only (SOLAR OUT, CONTROLLER SOLAR IN, CH1, CH2, PUMP 12 V IN, FAN 12 V IN)";
      return `<ul class="si-ports"><li><strong>End A</strong> · ${escape(endWords(0))}</li><li><strong>End B</strong> · ${escape(endWords(1))}</li></ul><p class="si-fine">Fits ${escape(fits)}. One line per port; the room refuses a second plug or the wrong connector type.</p>`;
    }
    if (this.tab === "behavior") {
      return names.hose
        ? `<ul><li>Lossless and holds no water: what leaves one end arrives at the other in the same step.</li><li>Water flows only from an OUT port to an IN port, and only when the pump runs.</li><li>An open end, OUT→OUT, IN→IN or the tank straight to a bed carries nothing.</li></ul><p class="si-fine">No pressure drop, no leaks, no air locks: teaching assumptions.</p>`
        : `<ul><li>Carries the controller's channel power to a load, or the solar panel's power into SOLAR IN.</li><li>Solar straight to a load is unregulated: not supported, carries nothing.</li><li>No voltage drop or cable losses are modelled.</li></ul>`;
    }
    const now = flow.state === "flow" ? (names.hose ? `${flow.litres.toFixed(1)} L this step` : `${flow.watts.toFixed(1)} W this step`) : flow.state === "starved" ? "starved this step" : flow.state === "idle" ? "idle this step" : "carries nothing";
    const seated = line.ends.some((end) => end !== null);
    const dis = this.pending.has(id) || this.locked() || this.host.holderOf(id) ? "disabled" : "";
    // Keyboard alternative to dragging: choose each end's port (compatible ports only; a port
    // another line holds is listed but not offered).
    const type = names.hose ? "water" : "power";
    const select = (end: 0 | 1): string => {
      const options = GH_PORTS.filter((port) => port.type === type).map((port) => {
        const holder = rig.lines.find((other) => other.id !== id && other.ends.includes(port.index));
        return `<option value="${port.index}" ${line.ends[end] === port.index ? "selected" : ""} ${holder ? "disabled" : ""}>${escape(port.label)}${holder ? ` (holds ${escape(LINE_NAMES[holder.id].name)})` : ""}</option>`;
      }).join("");
      return `<div class="si-field"><label for="gh-end-${end}">End ${end === 0 ? "A" : "B"}</label><select id="gh-end-${end}" data-end="${end}" data-focus-key="end-${end}" ${dis}><option value="" ${line.ends[end] === null ? "selected" : ""}>free (not plugged in)</option>${options}</select></div>`;
    };
    return `<p>${escape(`${endWords(0)} ↔ ${endWords(1)}`)}</p><p class="si-level">${escape(LINE_STATUS_WORDS[line.status])} · ${escape(now)}.</p>${this.holderNote(id)}${this.lockNote()}
      <p class="si-fine">Drag either end in 3D into a port, or choose the ports here. Plugging is shared with everyone.</p>
      <form class="si-form gh-ports-form" data-ports="${id}">${select(0)}${select(1)}
        <div class="si-actions"><button type="submit" class="primary-button compact" data-focus-key="connect" ${dis}>${this.pending.has(id) ? "Sending…" : "Connect in the room"}</button>
        <button type="button" class="secondary-button compact" data-home="${id}" data-focus-key="home" ${!seated || dis ? "disabled" : ""}>Unplug and coil in the aisle</button></div></form>${note}`;
  }

  private fixtureCard(id: string): string {
    const rig = this.rig!;
    const snapshot = this.projection!.snapshot;
    const record = this.lastRecord();
    const reference = REFERENCE[id];
    const note = this.editNote?.part === id ? `<p class="si-edit-note" data-tone="${this.editNote.tone}" role="status">${escape(this.editNote.text)}</p>` : "";
    if (this.tab === "behavior") {
      return `<h4>Behaviour</h4><ul>${reference.behaviour.map((line) => `<li>${escape(line)}</li>`).join("")}</ul><h4>Limits</h4><ul>${reference.limits.map((line) => `<li>${escape(line)}</li>`).join("")}</ul><p class="si-fine">A teaching water and energy balance: not a validated crop, weather or engineering model.</p>`;
    }
    if (this.tab === "ports") {
      const ports = GH_PORTS.filter((port) => port.module === id || (id === "soil-sensor" && port.type === "probe"));
      if (!ports.length) return `<p class="si-fine">${escape(partName(id))} has no ports: it is a display.</p>`;
      const rows = ports.filter((port, index, all) => port.type !== "probe" || all.findIndex((other) => other.label === port.label) === index).map((port) => {
        if (port.type === "probe") {
          const bed = port.key.startsWith("bed-a") ? "A" : "B";
          return `<li><strong>${escape(port.label)}</strong> · ${rig.probe === bed ? "the probe is here" : "empty"}</li>`;
        }
        const line = rig.lines.find((entry) => entry.ends.includes(port.index));
        const other = line ? line.ends.find((end) => end !== port.index) ?? null : null;
        return `<li><strong>${escape(port.label)}</strong> <small>(${port.role === "out" ? "OUT" : "IN"}, ${port.type})</small> · ${line ? `${escape(LINE_NAMES[line.id].name)} to ${other === null ? "a free end" : escape(portLabel(other))} · ${escape(LINE_STATUS_WORDS[line.status])}` : "nothing plugged in"}</li>`;
      }).join("");
      return `<ul class="si-ports">${rows}</ul><p class="si-fine">Water flows from OUT to IN; power from SOLAR OUT into the controller, then from a channel to a load. One line per port.</p>`;
    }
    let live = "";
    if (id === "water-pump") live = `Now: ${record ? record.pump.replace(/-/g, " ") : "off"} · on ${rig.pumpChannel ? `CH${rig.pumpChannel}` : "no channel"} · pumped ${snapshot.totals.pumped.toFixed(1)} L today.`;
    if (id === "vent-fan") live = `Now: ${record?.fan ?? "off"} · on ${rig.fanChannel ? `CH${rig.fanChannel}` : "no channel"} · air ${snapshot.air.toFixed(1)} °C.`;
    if (id === "solar-panel") live = `Now: ${rig.solar ? `${(record?.solarW ?? 0).toFixed(1)} W into the controller` : "not wired to SOLAR IN"} · today ${snapshot.totals.solarIn.toFixed(1)} Wh in, ${snapshot.totals.curtailed.toFixed(1)} Wh curtailed.`;
    if (id === "temp-sensor") live = `Reads ${snapshot.air.toFixed(1)} °C (outside ${record ? record.outside.toFixed(1) : "—"} °C).`;
    if (id === "light-sensor") live = `Sun ${Math.round((record?.sun ?? 0) * 100)} %.`;
    if (id === "farm-controller") live = `Battery ${snapshot.battery.toFixed(1)} of 12 Wh · served first: ${rig.order.length ? rig.order.join(", then ") : "nothing"} · used today ${snapshot.totals.used.toFixed(1)} Wh.`;
    if (id === "valve-manifold") live = rig.viaManifold ? `Fed by the pump · outlet A → ${rig.outlets.find((o) => o.from === 4)?.bed ? `bed ${rig.outlets.find((o) => o.from === 4)?.bed}` : "nothing"}, outlet B → ${rig.outlets.find((o) => o.from === 5)?.bed ? `bed ${rig.outlets.find((o) => o.from === 5)?.bed}` : "nothing"}.` : "Not fed by the pump.";
    if (id === "soil-sensor") live = rig.probe ? `In bed ${rig.probe} · reads ${Math.round((snapshot.beds[rig.probe] / GH_MODEL.bedCapacity) * 100)} % (${PLANT_WORDS[record?.beds[rig.probe].state ?? "healthy"]}).` : "In its holder: no reading, so the pump rule never runs the pump.";
    let form = "";
    const editable = id === "valve-manifold" || id === "farm-controller";
    if (editable) {
      const busy = this.pending.has(id);
      const dis = busy || this.locked() || this.host.holderOf(id) ? "disabled" : "";
      const params: Param[] = id === "valve-manifold" ? ["valveA", "valveB"] : ["pumpBelow", "fanAbove"];
      const field = (param: Param): string => {
        const key = `${id}:${param}`;
        const bounds = GH_BOUNDS[param];
        const unit = param === "fanAbove" ? "°C" : "%";
        const label = param === "valveA" ? "Valve A opening" : param === "valveB" ? "Valve B opening" : param === "pumpBelow" ? "Pump runs when soil is below" : "Fan runs when air is above";
        const room = param === "valveA" || param === "valveB" ? rig.manifold[param] : rig.controller[param];
        return `<div class="si-field"><label for="gh-${param}">${label}</label>
          <div class="si-stepper">
            <button type="button" class="tool-button" data-step="${key}" data-delta="-1" data-focus-key="down-${key}" aria-label="Lower ${label}" ${dis}><i class="ph ph-minus" aria-hidden="true"></i></button>
            <input id="gh-${param}" type="text" inputmode="numeric" data-draft="${key}" value="${escape(this.draftValue(id, param))}" aria-describedby="gh-${param}-range" ${dis}>
            <span class="si-unit">${unit}</span>
            <button type="button" class="tool-button" data-step="${key}" data-delta="1" data-focus-key="up-${key}" aria-label="Raise ${label}" ${dis}><i class="ph ph-plus" aria-hidden="true"></i></button>
          </div>
          <small id="gh-${param}-range">${bounds.min}–${bounds.max} ${unit} in ${bounds.step} ${unit} steps · room: ${room} ${unit}${this.drafts.has(key) ? " · <strong>draft, not applied</strong>" : ""}</small></div>`;
      };
      form = `<form class="si-form" data-part="${id}">${params.map(field).join("")}
        <div class="si-actions"><button type="submit" class="primary-button compact" data-focus-key="apply-${id}" ${dis}>${busy ? "Sending…" : "Apply to the room"}</button><button type="button" class="bare-button" data-revert="${id}" data-focus-key="revert-${id}" ${[...this.drafts.keys()].some((key) => key.startsWith(`${id}:`)) ? "" : "disabled"}>Discard draft</button></div></form>`;
    }
    const probeDis = this.pending.has(id) || this.locked() || this.host.holderOf(id) ? "disabled" : "";
    const probeButton = id === "soil-sensor" ? `<p class="si-fine">Drag the probe in 3D into a bed's slot, or choose the bed here.</p>
      <div class="si-actions gh-probe-actions">${(["A", "B"] as const).map((bed) => `<button type="button" class="secondary-button compact" data-probe="${bed}" data-focus-key="probe-${bed}" ${rig.probe === bed || probeDis ? "disabled" : ""}>Into bed ${bed}</button>`).join("")}
      <button type="button" class="secondary-button compact" data-home="soil-sensor" data-focus-key="home" ${!rig.probe || probeDis ? "disabled" : ""}>Back to its holder</button></div>` : "";
    return `<p>${escape(reference.role)}</p><p class="si-level">${escape(live)}</p>${this.holderNote(id)}${editable || id === "soil-sensor" ? this.lockNote() : ""}${form}${probeButton}${note}`;
  }

  private renderLoop(): void {
    const attempt = this.current();
    const pill = document.querySelector<HTMLElement>("#gh-pill");
    const label = document.querySelector<HTMLElement>("#gh-attempt-label");
    const steps = document.querySelector<HTMLElement>("#gh-steps");
    const why = document.querySelector<HTMLTextAreaElement>("#gh-why");
    const explain = document.querySelector<HTMLTextAreaElement>("#gh-explain");
    const save = document.querySelector<HTMLButtonElement>("#gh-explain-save");
    const build = document.querySelector<HTMLElement>("#gh-build-summary");
    const runSummary = document.querySelector<HTMLElement>("#gh-run-summary");
    const history = document.querySelector<HTMLElement>("#gh-history");
    if (!pill || !steps) return;
    const result = attempt.result;
    const state = !result ? "not run" : result.met ? (attempt.explained ? "brief met · explained" : "brief met · explain it") : `${result.criteria.filter((criterion) => criterion.pass).length}/5 criteria${result.seed === GH_MODEL.briefSeed ? "" : " (practice)"}`;
    pill.textContent = `Attempt ${attempt.n} · ${state}`;
    pill.dataset.tone = result?.met ? "valid" : result ? "warning" : "neutral";
    if (label) label.textContent = `Attempt ${attempt.n}`;
    const reached = [Boolean(attempt.prediction), true, Boolean(result), attempt.explained, false];
    this.write(steps, "steps", ["Predict", "Build", "Run", "Explain", "Revise"].map((name, index) => `<li data-done="${reached[index]}"><span aria-hidden="true">${index + 1}</span>${name}${reached[index] && index !== 1 ? '<span class="sr-only"> (done)</span>' : ""}</li>`).join(""));
    document.querySelectorAll<HTMLInputElement>("#gh-predictions input").forEach((input) => {
      input.checked = input.value === attempt.prediction;
    });
    if (why && document.activeElement !== why && why.value !== attempt.why) why.value = attempt.why;
    if (explain && document.activeElement !== explain && explain.value !== attempt.explanation) explain.value = attempt.explanation;
    if (save) save.disabled = !result || attempt.explanation.trim().length < 8 || attempt.explained;
    if (build) build.textContent = this.rig ? `Now: ${this.rigSummary()}.` : "";
    if (runSummary) {
      const predicted = PREDICTIONS.find(([value]) => value === attempt.prediction)?.[1] ?? "no prediction recorded";
      runSummary.textContent = result
        ? `Day ${result.seed === GH_MODEL.briefSeed ? "(brief's day)" : `(practice seed ${result.seed})`} finished: ${result.criteria.map((criterion) => `${criterion.id} ${criterion.pass ? "✓" : "✕"}`).join(" ")}. You predicted: ${predicted}. Built: ${result.summary}.`
        : "No finished day for this attempt yet.";
    }
    if (history) {
      const earlier = this.session.attempts.slice(0, -1);
      const rows = earlier.length
        ? earlier.map((entry) => `<li>Attempt ${entry.n}: ${entry.result ? (entry.result.met ? `brief met${entry.explained ? " and explained" : ""}` : `${entry.result.criteria.filter((criterion) => criterion.pass).length}/5 criteria${entry.result.seed === GH_MODEL.briefSeed ? "" : " (practice)"}`) : "no finished day"}${entry.result ? ` · ${escape(entry.result.criteria.filter((criterion) => !criterion.pass).map((criterion) => `${criterion.id}: ${criterion.measured}`).join("; ") || "all met")}` : ""}</li>`).join("")
        : "<li>None yet</li>";
      const milestone = this.session.attempts.find((entry) => entry.result?.met && entry.explained);
      this.write(history, "history", `${milestone && milestone !== attempt ? `<li class="ss-milestone">Brief met and explained in attempt ${milestone.n}</li>` : ""}${rows}`);
    }
  }

  // ── Session (this learner's own, never shared or exported) ──────────────────────────

  private storageKey(): string {
    return `vm-greenhouse:${this.host.roomCode()}`;
  }

  private loadSession(): Session {
    try {
      const raw = sessionStorage.getItem(this.storageKey());
      if (raw) {
        const parsed = JSON.parse(raw) as Session;
        if (Array.isArray(parsed.attempts) && parsed.attempts.length) return { attempts: parsed.attempts.slice(-20), firstFinishedAt: typeof parsed.firstFinishedAt === "number" ? parsed.firstFinishedAt : null };
      }
    } catch {
      // A per-learner convenience; a fresh session works without it.
    }
    return { attempts: [{ n: 1, prediction: null, why: "", afterRun: null, result: null, explanation: "", explained: false }], firstFinishedAt: null };
  }

  private saveSession(): void {
    try {
      sessionStorage.setItem(this.storageKey(), JSON.stringify(this.session));
    } catch {
      // Not critical.
    }
  }

  /** QA: what the panel shows (no private text). */
  qaState(): {
    run: { runId: number; seed: number; status: string; speed: number; tick: number } | null;
    shown: { tick: number; clock: string; tank: number; beds: { A: number; B: number }; air: number; battery: number; pump: string; fan: string; stress: { A: number; B: number; heat: number }; balance: { water: number; energy: number } } | null;
    rig: { complete: boolean; faults: string[]; lines: Record<string, string>; probe: string | null } | null;
    verdict: { met: boolean; criteria: Array<{ id: string; pass: boolean; measured: string }> } | null;
    attempt: number; resultRun: number | null; explained: boolean; notesUnlocked: boolean; locked: boolean; drafts: Record<string, string>; runNote: string | null; editNote: string | null;
  } {
    const projection = this.projection;
    const rig = this.rig;
    const snapshot = projection?.snapshot;
    const record = this.lastRecord();
    const attempt = this.current();
    const finished = snapshot && rig && snapshot.tick >= GH_MODEL.steps ? evaluateBrief(snapshot, rig) : null;
    return {
      run: this.run ? { runId: this.run.runId, seed: this.run.seed, status: this.run.status, speed: this.run.speed, tick: this.run.tick } : null,
      shown: snapshot ? {
        tick: snapshot.tick,
        clock: clockAt(snapshot.tick),
        tank: snapshot.tank,
        beds: { ...snapshot.beds },
        air: snapshot.air,
        battery: snapshot.battery,
        pump: record?.pump ?? "off",
        fan: record?.fan ?? "off",
        stress: { ...snapshot.stress },
        balance: {
          water: snapshot.start.tank + snapshot.start.beds.A + snapshot.start.beds.B - (snapshot.tank + snapshot.beds.A + snapshot.beds.B + snapshot.totals.et + snapshot.totals.drainage + snapshot.totals.overflow),
          energy: snapshot.totals.solarIn + snapshot.start.battery - (snapshot.totals.used + snapshot.battery + snapshot.totals.curtailed),
        },
      } : null,
      rig: rig ? { complete: rig.complete, faults: rig.faults.map((fault) => fault.kind + (fault.line ? `:${fault.line}` : "") + (fault.bed ? `:${fault.bed}` : "")), lines: Object.fromEntries(rig.lines.map((line) => [line.id, line.status])), probe: rig.probe } : null,
      verdict: finished ? { met: finished.met, criteria: finished.criteria.map((criterion) => ({ ...criterion })) } : null,
      attempt: attempt.n,
      resultRun: attempt.result?.runId ?? null,
      explained: attempt.explained,
      notesUnlocked: this.host.condition() === "DI" || this.session.firstFinishedAt !== null,
      locked: this.locked(),
      drafts: Object.fromEntries(this.drafts),
      runNote: this.runNote?.text ?? null,
      editNote: this.editNote?.text ?? null,
    };
  }
}

/** Whether `after` (a later run state) shows `action`, taken on `before`, as applied by the room. */
function appliedBy(action: GhAction, before: GhRun, after: GhRun): boolean {
  if (action.type === "reset") return after.runId > before.runId;
  if (after.runId !== before.runId) return false;
  if (action.type === "start" || action.type === "resume") return before.status !== "running" && after.status !== before.status && after.status !== "idle";
  if (action.type === "pause") return before.status === "running" && after.status === "paused";
  if (action.type === "step") return after.tick > before.tick;
  if (action.type === "speed") return after.speed === action.speed && before.speed !== action.speed;
  return false;
}

function initialAir(seed: number): number {
  return initialSnapshot(seed).air;
}
