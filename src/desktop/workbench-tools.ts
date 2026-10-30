/**
 * Workbench tools around the shared scene: the circuit inspector/meter, conflict-safe
 * undo/redo, project export/import, local recovery, reset and "return to tray".
 *
 * Every change these tools make is ONE atomic room edit (`DesktopRoom.submitEdit`): in server
 * mode nothing changes locally until the room accepts the whole batch, refusals (a part held
 * by someone — human or Bolt — or changed since this client last saw it) change nothing, and
 * every client applies accepted edits in the room's order, so all converge. History entries
 * and "edit" traces are written only after acceptance. Edits are traced as "edit", never as
 * "claim"/"move", so existing research metrics that count claims and moves are unchanged.
 */
import { formatAmps, formatOhms, formatVolts, SOLVER_VERSION, type ElementReading } from "../circuit/dc-engine.ts";
import { socketNet } from "../circuit/breadboard.ts";
import {
  parseOhms,
  RESISTANCE_RANGE,
  RESISTOR_PRESETS,
  roundVolts,
  sanitizeProps,
  VOLTAGE_PRESETS,
  VOLTAGE_RANGE,
  type PartProps,
} from "../circuit/part-props.ts";
import type { CircuitAnalysis } from "./circuit-topology.js";
import type { CollaborationPhase, DesktopRoom, EditResult, SharedTransform } from "./collaboration.js";
import { EditHistory, planProgramLoad, sameProgram, sameTransform, type HistoryChange, type HistoryVerdict } from "./edit-history.ts";
import { buildProject, isDefaultProject, parseProject, projectFileName, type ProjectFile } from "./project-file.ts";
import type { ComponentSpec, DesktopWorkbenchScene, StudioKind } from "./scene.js";
import type { SnapinoStatement } from "./snapino.ts";
import type { Word } from "../episodes/rescue-signal.ts";

export interface ToolsHost {
  workbench(): DesktopWorkbenchScene | null;
  room(): DesktopRoom | null;
  studio(): StudioKind;
  phase(): CollaborationPhase;
  roomCode(): string;
  /** Name of whoever else (human or Bolt) holds the part or one of its cable ends, or null. */
  holderOf(componentId: string): string | null;
  /** Bolt is mid-build: bulk changes would race its moves. */
  boltBuilding(): boolean;
  /** The Snapino program the room runs (shared state). */
  roomProgram(): { program: SnapinoStatement[]; running: boolean };
  /** The local code editor's unsaved draft, or null when it matches the room's program. */
  draftProgram(): SnapinoStatement[] | null;
  /** Loads a program into this participant's editor only (not shared until they press Run). */
  loadDraft(program: SnapinoStatement[]): void;
  /** Rescue Signal design to export (Snapino, workshop open), or null. */
  episodeDesign?(): { mission: string; intent: Word[] } | null;
  /** Applies an imported Rescue Signal design through the room; false if refused. */
  applyEpisodeDesign?(design: { mission: string; intent: Word[] }): Promise<boolean>;
  status(message: string, tone: "neutral" | "valid" | "warning"): void;
  selected(): ComponentSpec | null;
  /** The meter opened or closed: re-frame the camera around it. */
  layoutChanged?(): void;
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const PART_NAMES: Record<string, string> = {
  "battery-9v": "Battery",
  "led-red": "Red LED",
  "led-green": "Green LED",
  "resistor-220": "Resistor A",
  "resistor-1k": "Resistor B",
  "wire-red": "Red jumper",
  "wire-blue": "Blue jumper",
  "wire-yellow": "Yellow jumper",
  "snd-source": "Source",
  "snd-filter": "Filter",
  "snd-drive": "Drive",
  "snd-speaker": "Speaker",
  "snd-cable-a": "Red cable",
  "snd-cable-b": "Yellow cable",
  "snd-cable-c": "Blue cable",
};

const LED_STATE_COPY: Record<string, string> = {
  lit: "lit",
  dim: "barely glowing",
  off: "off",
  overcurrent: "overdriven",
  burnout: "burnt out",
  reverse: "reversed",
  floating: "not connected",
};

export class WorkbenchTools {
  readonly history = new EditHistory();
  /** Why the last submitted edit was not accepted ("timeout": not confirmed in time — it may still land), or null. */
  lastRefusal: string | null = null;
  private readonly host: ToolsHost;
  private readonly pending = new Map<string, SharedTransform>();
  private analysis: CircuitAnalysis | null = null;
  private renderQueued = false;
  private lastReadingsHtml = "";
  private lastEditorKey = "";
  private collapsed: boolean;
  private tagsFrame = 0;
  private autosaveTimer = 0;
  private recoveryChecked = false;
  private stepping = false;
  private disposed = false;

  constructor(host: ToolsHost) {
    this.host = host;
    // The meter sits in the dock tab now: open unless this viewer folded it.
    this.collapsed = readPreference("vm-inspector-collapsed", false);
  }

  // ── Inspector ───────────────────────────────────────────────────────────────

  /**
   * The circuit meter: the Circuit Bench's contextual inspector. It lives in the dock's
   * Inspector tab (one side column), next to the Snapino bench inspector.
   */
  static meterMarkup(): string {
    return `
      <section class="inspector" id="inspector" aria-labelledby="inspector-title" hidden>
        <button class="inspector-toggle" id="inspector-toggle" type="button" aria-expanded="true" aria-controls="inspector-body">
          <i class="ph ph-gauge" aria-hidden="true"></i>
          <span class="inspector-title" id="inspector-title">Circuit meter</span>
          <span class="inspector-pill" id="inspector-pill" data-tone="neutral">Idle</span>
          <i class="ph ph-caret-down inspector-chevron" aria-hidden="true"></i>
        </button>
        <div class="inspector-body" id="inspector-body">
          <p class="inspector-diagnosis" id="inspector-diagnosis" role="status" aria-live="polite"></p>
          <div class="inspector-readings" id="inspector-readings"></div>
          <div class="inspector-part" id="inspector-part"></div>
          <label class="inspector-tags"><input type="checkbox" id="inspector-tags" checked /> Show readings on parts</label>
          <label class="inspector-tags"><input type="checkbox" id="inspector-flow" /> Show current flow on the jumper wires</label>
          <p class="inspector-flow-note" id="inspector-flow-note" role="status" aria-live="polite"></p>
          <p class="inspector-foot">Educational DC model · <span title="Modified nodal analysis with piecewise-linear LEDs and a 1 Ω battery; not SPICE and not datasheet-exact">${SOLVER_VERSION}</span></p>
        </div>
      </section>`;
  }

  /** Scene overlays and dialogs the tools use (measure tags, recovery banner, confirm dialog). */
  static markup(): string {
    return `
      <div class="measure-tags" id="measure-tags" aria-hidden="true"></div>
      <div class="recovery-banner" id="recovery-banner" role="region" aria-label="Recover saved bench" hidden></div>
      <dialog class="confirm-dialog" id="confirm-dialog" aria-labelledby="confirm-title">
        <form method="dialog">
          <h2 id="confirm-title"></h2>
          <p id="confirm-body"></p>
          <div class="dialog-actions"><button class="secondary-button" value="cancel" type="submit">Cancel</button><button class="primary-button" id="confirm-ok" value="ok" type="submit"></button></div>
        </form>
      </dialog>
      <input type="file" id="project-file-input" accept="application/json,.json" hidden />
    `;
  }

  bind(): void {
    document.querySelector("#inspector-toggle")?.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    document.querySelector("#inspector-tags")?.addEventListener("change", () => this.updateTagLoop());
    document.querySelector<HTMLInputElement>("#inspector-flow")?.addEventListener("change", (event) => {
      this.host.workbench()?.setCurrentFlow((event.target as HTMLInputElement).checked);
      this.renderFlowNote();
    });
    document.querySelector("#inspector-part")?.addEventListener("click", (event) => this.onPartClick(event as MouseEvent));
    document.querySelector("#inspector-part")?.addEventListener("submit", (event) => this.onPartSubmit(event as SubmitEvent));
    document.querySelector<HTMLInputElement>("#project-file-input")?.addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (file) void this.importFile(file);
    });
    this.setCollapsed(this.collapsed, false);
    this.updateStudio();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.tagsFrame);
    window.clearTimeout(this.autosaveTimer);
  }

  /** Studio changed: the meter is a Circuit Bench tool; history never crosses studios. */
  updateStudio(): void {
    const inspector = document.querySelector<HTMLElement>("#inspector");
    if (inspector) inspector.hidden = this.host.studio() !== "circuit";
    this.host.layoutChanged?.();
    this.history.clear();
    this.pending.clear();
    this.lastEditorKey = "";
    this.updateHistoryButtons();
    this.updateTagLoop();
    this.queueRender();
  }

  setAnalysis(analysis: CircuitAnalysis): void {
    this.analysis = analysis;
    this.queueRender();
    this.scheduleAutosave();
  }

  /** Selection or ownership changed: refresh the part editor. */
  refreshPart(): void {
    this.queueRender();
  }

  private setCollapsed(collapsed: boolean, remember = true): void {
    this.collapsed = collapsed;
    const inspector = document.querySelector<HTMLElement>("#inspector");
    inspector?.classList.toggle("is-collapsed", collapsed);
    document.querySelector("#inspector-toggle")?.setAttribute("aria-expanded", String(!collapsed));
    const body = document.querySelector<HTMLElement>("#inspector-body");
    if (body) body.hidden = collapsed;
    if (remember) writePreference("vm-inspector-collapsed", collapsed);
    this.host.layoutChanged?.();
  }

  private queueRender(): void {
    if (this.renderQueued || this.disposed) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    if (this.host.studio() !== "circuit") return;
    const analysis = this.analysis;
    const pill = document.querySelector<HTMLElement>("#inspector-pill");
    const diagnosis = document.querySelector<HTMLElement>("#inspector-diagnosis");
    const readings = document.querySelector<HTMLElement>("#inspector-readings");
    if (!analysis || !pill || !diagnosis || !readings) return;
    const verdict = summarize(analysis);
    pill.textContent = verdict.pill;
    pill.dataset.tone = verdict.tone;
    if (diagnosis.textContent !== verdict.explanation) diagnosis.textContent = verdict.explanation;
    this.renderFlowNote();
    const html = this.readingsHtml(analysis);
    if (html !== this.lastReadingsHtml) {
      readings.innerHTML = html;
      this.lastReadingsHtml = html;
    }
    this.renderPartEditor();
  }

  private readingsHtml(analysis: CircuitAnalysis): string {
    const result = analysis.board.result;
    const rows: string[] = [];
    const row = (label: string, value: string, note = "", tone = ""): string =>
      `<div class="reading${tone ? ` is-${tone}` : ""}"><dt>${escape(label)}</dt><dd><strong>${escape(value)}</strong>${note ? `<small>${escape(note)}</small>` : ""}</dd></div>`;
    const battery = result.elements["battery-9v"];
    const volts = this.host.workbench()?.getPartProps("battery-9v")?.volts ?? 9;
    if (battery?.connected) {
      rows.push(row("Battery", `${formatVolts(battery.volts)} · ${formatAmps(battery.amps)}`, `${trimNumber(volts)} V nominal, 1 Ω internal`));
    } else {
      rows.push(row("Battery", analysis.batteryPlaced ? "connected to nothing" : "in the tray", `${trimNumber(volts)} V nominal`));
    }
    for (const id of ["led-red", "led-green"]) {
      const reading = result.elements[id];
      if (!reading) continue;
      const state = reading.led?.state ?? "off";
      const tone = state === "lit" ? "valid" : state === "overcurrent" || state === "burnout" || state === "reverse" ? "warning" : "";
      rows.push(row(PART_NAMES[id], `${formatAmps(Math.max(0, reading.amps))} · ${formatVolts(reading.volts)}`, LED_STATE_COPY[state] ?? state, tone));
    }
    for (const id of ["resistor-220", "resistor-1k"]) {
      const reading = result.elements[id];
      const ohms = this.host.workbench()?.getPartProps(id)?.ohms;
      if (!reading || !ohms) continue;
      rows.push(row(`${formatOhms(ohms)} resistor`, `${formatVolts(Math.abs(reading.volts))} · ${formatAmps(Math.abs(reading.amps))}`, `${formatPower(reading)}`));
    }
    for (const id of ["wire-red", "wire-blue", "wire-yellow"]) {
      const reading = result.elements[id];
      if (!reading || Math.abs(reading.amps) < 1e-5) continue;
      rows.push(row(PART_NAMES[id], formatAmps(Math.abs(reading.amps))));
    }
    if (!rows.length) return "";
    return `<dl>${rows.join("")}</dl>`;
  }

  private renderPartEditor(): void {
    const container = document.querySelector<HTMLElement>("#inspector-part");
    const workbench = this.host.workbench();
    if (!container || !workbench) return;
    const spec = this.host.selected();
    const analysis = this.analysis;
    if (!spec || spec.studio !== "circuit" || !analysis) {
      if (this.lastEditorKey !== "none") {
        container.innerHTML = `<p class="inspector-hint"><i class="ph ph-cursor-click" aria-hidden="true"></i> Select a part to see its leads, polarity and value.</p>`;
        this.lastEditorKey = "none";
      }
      return;
    }
    // Never re-render under the learner's cursor: keep typed input while they edit.
    const active = document.activeElement;
    if (active && container.contains(active) && active.matches("input")) return;
    const props = workbench.getPartProps(spec.id);
    const holder = this.host.holderOf(spec.id);
    const sockets = workbench.getSharedTransforms()[spec.id]?.sockets ?? null;
    const reading = analysis.board.result.elements[spec.id];
    const node = (socket: number | null | undefined): string => {
      if (socket === null || socket === undefined) return "not in a hole";
      const net = socketNet(socket);
      const volts = net === null ? null : analysis.board.netVolts.get(net);
      return `${socketLabel(socket)} · ${volts === null || volts === undefined ? "floating" : formatVolts(volts)}`;
    };
    const key = JSON.stringify([spec.id, props, holder, sockets, reading?.volts?.toFixed(3), reading?.amps?.toFixed(5), reading?.led?.state]);
    if (key === this.lastEditorKey) return;
    this.lastEditorKey = key;

    const polarity = spec.kind === "led"
      ? ["Lead A · anode (+, long lead)", "Lead B · cathode (−, flat side)"]
      : spec.kind === "battery"
        ? ["Lead A · + terminal", "Lead B · − terminal"]
        : ["Lead A", "Lead B"];
    const leads = `<dl class="lead-list">
      <div><dt>${escape(polarity[0])}</dt><dd>${escape(node(sockets?.[0]))}</dd></div>
      <div><dt>${escape(polarity[1])}</dt><dd>${escape(node(sockets?.[1]))}</dd></div>
    </dl>`;
    let editor = "";
    if (spec.kind === "resistor" && props?.ohms) {
      editor = `
        <form class="value-editor" data-kind="resistor" data-part="${escape(spec.id)}" novalidate>
          <label for="value-input">Resistance <small>${formatOhms(RESISTANCE_RANGE.min)} – ${formatOhms(RESISTANCE_RANGE.max)}</small></label>
          <div class="value-row"><input id="value-input" name="value" inputmode="decimal" autocomplete="off" spellcheck="false" value="${escape(formatOhms(props.ohms).replace(" ", ""))}" aria-describedby="value-error" ${holder ? "disabled" : ""} /><button class="secondary-button compact" type="submit" ${holder ? "disabled" : ""}>Set</button></div>
          <div class="value-presets" role="group" aria-label="Standard values">${RESISTOR_PRESETS.map((value) => `<button type="button" class="preset${value === props.ohms ? " is-active" : ""}" data-value="${value}" ${holder ? "disabled" : ""}>${formatOhms(value).replace(" ", "")}</button>`).join("")}</div>
          <p class="value-error" id="value-error" role="alert"></p>
        </form>`;
    } else if (spec.kind === "battery" && props?.volts) {
      editor = `
        <form class="value-editor" data-kind="battery" data-part="${escape(spec.id)}" novalidate>
          <label for="value-input">Supply voltage <small>${VOLTAGE_RANGE.min}–${VOLTAGE_RANGE.max} V</small></label>
          <div class="value-row"><input id="value-input" name="value" inputmode="decimal" autocomplete="off" spellcheck="false" value="${trimNumber(props.volts)}" aria-describedby="value-error" ${holder ? "disabled" : ""} /><span class="unit">V</span><button class="secondary-button compact" type="submit" ${holder ? "disabled" : ""}>Set</button></div>
          <div class="value-presets" role="group" aria-label="Common supplies">${VOLTAGE_PRESETS.map((value) => `<button type="button" class="preset${value === props.volts ? " is-active" : ""}" data-value="${value}" ${holder ? "disabled" : ""}>${trimNumber(value)} V</button>`).join("")}</div>
          <p class="value-error" id="value-error" role="alert"></p>
        </form>`;
    }
    const live = reading && reading.connected
      ? `<p class="part-live">${escape(`${formatVolts(Math.abs(reading.volts))} across · ${formatAmps(Math.abs(reading.amps))} through · ${formatPower(reading)}`)}</p>`
      : "";
    container.innerHTML = `
      <h3 class="part-title">${escape(spec.name)}${props?.ohms ? ` <span>${escape(formatOhms(props.ohms))}</span>` : ""}${props?.volts ? ` <span>${escape(`${trimNumber(props.volts)} V`)}</span>` : ""}</h3>
      ${holder ? `<p class="part-held"><i class="ph ph-hand" aria-hidden="true"></i> ${escape(holder)} is holding this part · values unlock when they let go</p>` : ""}
      ${live}
      ${leads}
      ${editor}
      <button class="secondary-button compact part-remove" type="button" data-action="remove" ${holder || !sockets ? "disabled" : ""}><i class="ph ph-tray-arrow-down" aria-hidden="true"></i> Return to tray</button>`;
  }

  private onPartClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!target) return;
    if (target.dataset.action === "remove") {
      const spec = this.host.selected();
      if (spec) this.returnToTray(spec.id);
      return;
    }
    if (target.classList.contains("preset")) {
      const form = target.closest<HTMLFormElement>(".value-editor");
      if (!form) return;
      this.applyValue(form.dataset.part ?? "", form.dataset.kind ?? "", Number(target.dataset.value));
    }
  }

  private onPartSubmit(event: SubmitEvent): void {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>(".value-editor");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector<HTMLInputElement>("input[name=value]");
    const text = input?.value ?? "";
    const value = form.dataset.kind === "resistor" ? parseOhms(text) : Number(text.replace(/\s*v$/i, ""));
    const error = form.querySelector<HTMLElement>(".value-error");
    const ok = this.applyValue(form.dataset.part ?? "", form.dataset.kind ?? "", value);
    if (!ok && error) {
      error.textContent = form.dataset.kind === "resistor"
        ? `Enter a resistance from ${formatOhms(RESISTANCE_RANGE.min)} to ${formatOhms(RESISTANCE_RANGE.max)}, like 470 or 4.7k.`
        : `Enter a voltage from ${VOLTAGE_RANGE.min} to ${VOLTAGE_RANGE.max} V.`;
      input?.focus();
    }
    if (ok) input?.blur();
  }

  /** Validated property edit as one shared edit (and one undo step once the room accepts). */
  private applyValue(componentId: string, kind: string, value: number): boolean {
    const workbench = this.host.workbench();
    if (!workbench || (kind !== "resistor" && kind !== "battery")) return false;
    const props = sanitizeProps(kind, kind === "resistor" ? { ohms: value } : { volts: value });
    if (!props) return false;
    const holder = this.host.holderOf(componentId);
    if (holder) {
      this.host.status(`${holder} is holding this part; try again when they let go`, "warning");
      return false;
    }
    const before = workbench.getSharedTransforms()[componentId];
    if (!before) return false;
    if (sameProps(before.props, props)) return true;
    const label = kind === "resistor" ? `Set resistor to ${formatOhms(props.ohms!)}` : `Set battery to ${trimNumber(props.volts!)} V`;
    void this.submit([{ id: componentId, transform: { ...before, props } }], label, { traceId: componentId });
    return true;
  }

  // ── Measurement tags on the 3D parts ───────────────────────────────────────────

  private updateTagLoop(): void {
    cancelAnimationFrame(this.tagsFrame);
    const layer = document.querySelector<HTMLElement>("#measure-tags");
    const enabled = Boolean(document.querySelector<HTMLInputElement>("#inspector-tags")?.checked) && this.host.studio() === "circuit";
    if (!layer) return;
    layer.hidden = !enabled;
    if (!enabled) {
      layer.innerHTML = "";
      return;
    }
    const tick = (): void => {
      if (this.disposed) return;
      this.positionTags(layer);
      this.tagsFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  private positionTags(layer: HTMLElement): void {
    const workbench = this.host.workbench();
    const analysis = this.analysis;
    if (!workbench || !analysis) return;
    const frame = layer.getBoundingClientRect();
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const id of ["led-red", "led-green", "resistor-220", "resistor-1k"]) {
      let tag = layer.querySelector<HTMLElement>(`[data-tag="${id}"]`);
      const reading = analysis.board.result.elements[id];
      const point = reading?.connected ? workbench.projectComponent(id) : null;
      if (!reading || !point) {
        if (tag) tag.hidden = true;
        continue;
      }
      if (!tag) {
        tag = document.createElement("span");
        tag.className = "measure-tag";
        tag.dataset.tag = id;
        layer.append(tag);
      }
      const state = reading.led?.state;
      const text = reading.kind === "led"
        ? `${formatAmps(Math.max(0, reading.amps))}${state && state !== "lit" ? ` · ${LED_STATE_COPY[state]}` : ""}`
        : `${formatVolts(Math.abs(reading.volts))}`;
      if (tag.textContent !== text) tag.textContent = text;
      tag.dataset.tone = state === "lit" ? "valid" : state === "overcurrent" || state === "burnout" || state === "reverse" ? "warning" : "neutral";
      tag.hidden = false;
      // Keep tags readable: nudge a tag upward until it no longer overlaps one already placed.
      const w = tag.offsetWidth || 60;
      const h = tag.offsetHeight || 18;
      const x = point.x - frame.left - w / 2;
      let y = point.y - frame.top - h;
      for (let guard = 0; guard < 6; guard += 1) {
        const hit = placed.find((box) => x < box.x + box.w + 4 && x + w + 4 > box.x && y < box.y + box.h + 3 && y + h + 3 > box.y);
        if (!hit) break;
        y = hit.y - h - 4;
      }
      placed.push({ x, y, w, h });
      tag.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }

  /** Right edge of the expanded meter (client px), for framing the bench beside it; 0 when hidden. */
  /** The meter no longer floats over the scene (it is a dock tab), so it never narrows the view. */
  inspectorRight(): number {
    return 0;
  }

  /** What the flow view shows, in words: solved currents, or why nothing is drawn. */
  private renderFlowNote(): void {
    const note = document.querySelector<HTMLElement>("#inspector-flow-note");
    const flow = this.host.workbench()?.currentFlowState();
    if (!note || !flow) return;
    const listed = (wires: Array<{ id: string; amps: number }>): string => wires.map((wire) => `${PART_NAMES[wire.id] ?? wire.id} ${formatAmps(Math.abs(wire.amps))}`).join(", ");
    const small = flow.small.length ? ` Too small to draw (not zero): ${listed(flow.small)}.` : "";
    const text = !flow.enabled
      ? "Arrows show the solved conventional current on each jumper wire (the DC model above). Their speed is not to scale."
      : flow.wires.length
        ? `Solved current: ${listed(flow.wires)}. Arrows point along conventional current; speed is not to scale. Parts' own currents are in the readings above.${small}${flow.moving ? "" : " (Still arrows: reduced motion.)"}`
        : `No flow drawn: ${flow.reason}.${small}`;
    if (note.textContent !== text) note.textContent = text;
  }

  // ── Shared edits ──────────────────────────────────────────────────────────────

  /**
   * Submits `changes` (and optionally a program to load, which is always loaded stopped) as one
   * atomic room edit. A program load stops a running room program even when its statements are
   * the same; only a statement change becomes part of the undo step. Only on acceptance: history
   * entry, "edit" trace, status. Returns whether the room accepted it (true also when nothing
   * needed to change).
   */
  async submit(
    changes: Array<{ id: string; transform: SharedTransform }>,
    label: string,
    options: { program?: SnapinoStatement[]; traceId?: string; record?: boolean; tone?: "neutral" | "valid"; afterAccept?: () => void | Promise<void> } = {},
  ): Promise<boolean> {
    const workbench = this.host.workbench();
    const room = this.host.room();
    if (!workbench || !room) return false;
    const before = workbench.getSharedTransforms();
    const real = changes.filter((change) => !sameTransform(before[change.id], change.transform));
    const { program: programBefore, running: roomRunning } = this.host.roomProgram();
    const load = planProgramLoad(programBefore, roomRunning, options.program);
    const program = load.send?.program;
    if (!real.length && !load.send) {
      this.host.status(`${label} · nothing to change`, "neutral");
      await options.afterAccept?.();
      return true;
    }
    const held = real.map((change) => ({ id: change.id, holder: this.host.holderOf(change.id) })).find((entry) => entry.holder);
    if (held) {
      this.host.status(`${label} refused · ${held.holder} is holding ${PART_NAMES[held.id] ?? "a part"}; try again when they let go`, "warning");
      return false;
    }
    const result = await room.submitEdit(real, load.send);
    this.lastRefusal = result.ok ? null : result.reason;
    if (!result.ok) {
      this.host.status(refusalCopy(label, result), "warning");
      this.lastEditorKey = "";
      this.queueRender();
      // Not confirmed in time is not refused: the edit is still with the room. Its late answer
      // finishes this edit exactly once — recorded, traced and reported as an accepted one, or
      // reported as refused (nothing changed).
      if (result.reason === "timeout" && result.later) {
        void result.later.then(async (late) => {
          if (this.disposed) return;
          if (late.ok) {
            await this.accepted(before, real, programBefore, program, load, label, options);
            return;
          }
          this.host.status(refusalCopy(label, late), "warning");
          this.lastEditorKey = "";
          this.queueRender();
        });
      }
      return false;
    }
    await this.accepted(before, real, programBefore, program, load, label, options);
    return true;
  }

  /** An edit from `submit` the room accepted (now, or late after a timeout): history, trace, status. */
  private async accepted(
    before: Record<string, SharedTransform>,
    real: Array<{ id: string; transform: SharedTransform }>,
    programBefore: SnapinoStatement[],
    program: SnapinoStatement[] | undefined,
    load: ReturnType<typeof planProgramLoad>,
    label: string,
    options: { traceId?: string; record?: boolean; tone?: "neutral" | "valid"; afterAccept?: () => void | Promise<void> },
  ): Promise<void> {
    const workbench = this.host.workbench();
    if (!workbench) return;
    // The accepted state was applied (through the room) before this ran.
    if (options.record !== false) {
      const after = workbench.getSharedTransforms();
      const recorded: HistoryChange[] = real.map((change) => ({ id: change.id, before: before[change.id], after: after[change.id] }));
      // A stop alone is not an undo step (Run/Stop is not edit history); new statements are.
      this.history.record(label, recorded, program && load.statementsChanged ? { before: programBefore, after: program } : undefined);
    }
    const programNote = !program ? "" : load.statementsChanged ? (load.stops ? "program, stopped" : "program") : "program stopped";
    const count = real.length + (program ? 1 : 0);
    this.trace(options.traceId ?? (real.length === 1 && !program ? real[0].id : undefined), count > 1 || program ? `${label} (${describeCount(real.length, programNote)})` : label);
    this.host.status(
      !real.length && program && !load.statementsChanged
        ? `${label} · same program, now stopped for everyone`
        : `${label} · shared with the room${load.stops ? " (program stopped)" : ""}`,
      options.tone ?? "neutral",
    );
    this.updateHistoryButtons();
    this.lastEditorKey = "";
    this.queueRender();
    this.noteChange();
    await options.afterAccept?.();
  }

  private trace(componentId: string | undefined, detail: string): void {
    const room = this.host.room();
    room?.recordTrace("edit", this.host.phase(), this.host.studio(), {
      objectId: componentId,
      objectName: componentId ? PART_NAMES[componentId] ?? componentId : undefined,
      detail,
    });
  }

  // ── History ─────────────────────────────────────────────────────────────────

  /** Called when this participant grabs a part: remember where it was. */
  beginLocalEdit(resourceId: string): void {
    const id = resourceId.split("::")[0];
    if (this.pending.has(id)) return;
    const before = this.host.workbench()?.getSharedTransforms()[id];
    if (before) this.pending.set(id, before);
  }

  /** The room ended the drag before any move counted: forget it. */
  cancelLocalEdit(resourceId: string): void {
    const id = resourceId.split("::")[0];
    if ([`${id}::endpoint-0`, `${id}::endpoint-1`].some((resource) => resource !== resourceId && this.pending.has(resource))) return;
    this.pending.delete(id);
  }

  /**
   * Called when this participant lets go. Captures the move now; the returned function records
   * it as one undo step only if the room accepted every move of the drag.
   */
  endLocalEdit(resourceId: string): (accepted: boolean) => void {
    const id = resourceId.split("::")[0];
    const before = this.pending.get(id);
    const workbench = this.host.workbench();
    this.pending.delete(id);
    if (!before || !workbench) return () => undefined;
    const after = workbench.getSharedTransforms()[id];
    return (accepted) => {
      if (!accepted || !after) return;
      if (this.history.record(`Moved ${PART_NAMES[id] ?? id}`, [{ id, before, after }])) this.updateHistoryButtons();
      this.noteChange();
    };
  }

  undo(): void {
    void this.step("undo");
  }

  redo(): void {
    void this.step("redo");
  }

  private async step(direction: "undo" | "redo"): Promise<void> {
    const workbench = this.host.workbench();
    const room = this.host.room();
    if (!workbench || !room) return;
    // One undo/redo at a time: a second press while the room is answering the first would
    // re-submit the same step.
    if (this.stepping) {
      this.host.status("Still waiting for the room to confirm the last undo/redo", "neutral");
      return;
    }
    const transforms = workbench.getSharedTransforms();
    const verdict = this.history.peek(
      direction,
      (id) => transforms[id] ?? null,
      (id) => Boolean(this.host.holderOf(id)),
      () => this.host.roomProgram().program,
    );
    if (!verdict.ok) {
      const copy = verdict.reason === "empty"
        ? `Nothing to ${direction}`
        : verdict.reason === "held"
          ? `Can't ${direction} "${verdict.label}" — ${this.host.holderOf(verdict.partId ?? "") ?? "a teammate"} is holding ${PART_NAMES[verdict.partId ?? ""] ?? "that part"}`
          : `Can't ${direction} "${verdict.label}" — a teammate changed ${verdict.partId === "program" ? "the program" : PART_NAMES[verdict.partId ?? ""] ?? "that part"} since, so their work is kept`;
      this.host.status(copy, verdict.reason === "empty" ? "neutral" : "warning");
      this.updateHistoryButtons();
      return;
    }
    this.stepping = true;
    let result: EditResult;
    try {
      result = await room.submitEdit(verdict.apply, verdict.program ? { program: verdict.program, running: false } : undefined);
    } catch (error) {
      this.stepping = false;
      throw error;
    }
    if (!result.ok && result.reason === "timeout" && result.later) {
      // Still with the room: say so, and settle this step on its late answer, exactly once.
      // Until then no other undo/redo is sent (it would re-submit or overtake this one).
      this.host.status(refusalCopy(`${direction === "undo" ? "Undo" : "Redo"} "${verdict.label}"`, result), "warning");
      this.updateHistoryButtons();
      void result.later.then((late) => {
        this.stepping = false;
        if (!this.disposed) this.settleStep(direction, verdict, late);
      });
      return;
    }
    this.stepping = false;
    this.settleStep(direction, verdict, result);
  }

  /** The room's answer to an undo/redo (on time or late): move or drop its entry, trace, report. */
  private settleStep(direction: "undo" | "redo", verdict: Extract<HistoryVerdict, { ok: true }>, result: EditResult): void {
    const did = direction === "undo" ? "Undid" : "Redid";
    if (!result.ok) {
      // The room is the judge: a stale step can never apply again; held/offline may later.
      if (result.reason === "stale") this.history.drop(direction, verdict.entry);
      this.host.status(refusalCopy(`${direction === "undo" ? "Undo" : "Redo"} "${verdict.label}"`, result), "warning");
      this.updateHistoryButtons();
      return;
    }
    this.history.commit(direction, verdict.entry);
    this.trace(verdict.apply.length === 1 && !verdict.program ? verdict.apply[0].id : undefined, `${did}: ${verdict.label}`);
    this.host.status(`${did} · ${verdict.label}${verdict.program ? " · program restored, stopped" : ""}`, "neutral");
    this.updateHistoryButtons();
    this.lastEditorKey = "";
    this.queueRender();
    this.noteChange();
  }

  updateHistoryButtons(): void {
    const undo = document.querySelector<HTMLButtonElement>("#undo-edit");
    const redo = document.querySelector<HTMLButtonElement>("#redo-edit");
    if (undo) {
      undo.disabled = !this.history.canUndo;
      const label = this.history.undoLabel ? `Undo: ${this.history.undoLabel}` : "Undo";
      undo.setAttribute("aria-label", label);
      undo.dataset.tooltip = label;
      undo.title = label;
    }
    if (redo) {
      redo.disabled = !this.history.canRedo;
      const label = this.history.redoLabel ? `Redo: ${this.history.redoLabel}` : "Redo";
      redo.setAttribute("aria-label", label);
      redo.dataset.tooltip = label;
      redo.title = label;
    }
  }

  // ── Return to tray, reset ───────────────────────────────────────────────────

  returnToTray(componentId: string): void {
    const workbench = this.host.workbench();
    const home = workbench?.homeTransform(componentId);
    if (!workbench || !home) return;
    void this.submit([{ id: componentId, transform: home }], `Returned ${PART_NAMES[componentId] ?? componentId} to the tray`, { traceId: componentId });
  }

  async confirmReset(): Promise<void> {
    const workbench = this.host.workbench();
    if (!workbench) return;
    const confirmed = await confirmDialog(
      "Reset the bench?",
      "Every part goes back to the tray and edited values return to their defaults. Everyone in the room sees this. You can undo it.",
      "Reset bench",
    );
    if (!confirmed) return;
    if (this.host.boltBuilding()) {
      this.host.status("Bolt is building right now; reset when it has finished", "warning");
      return;
    }
    const catalog = workbench.studioCatalog(this.host.studio());
    const changes: Array<{ id: string; transform: SharedTransform }> = [];
    for (const id of Object.keys(catalog.parts)) {
      const transform = workbench.defaultTransform(id);
      if (transform) changes.push({ id, transform });
    }
    await this.applyBulk(changes, "Reset the bench");
  }

  /** A multi-part change as one atomic room edit and one undo step (demos, restores, reset). */
  applyBulk(changes: Array<{ id: string; transform: SharedTransform }>, label: string): Promise<boolean> {
    return this.submit(changes, label, { tone: "valid" });
  }

  // ── Export / import / recovery ────────────────────────────────────────────────

  private isEmpty(project: ProjectFile): boolean {
    const workbench = this.host.workbench();
    return isDefaultProject(project, (id) => workbench?.defaultPartProps(id) ?? null, (id) => workbench?.defaultTransform(id)?.on === true);
  }

  private currentProject(): ProjectFile | null {
    const workbench = this.host.workbench();
    if (!workbench) return null;
    const studio = this.host.studio();
    const snapino = studio === "snapino";
    return buildProject(
      workbench.studioCatalog(studio),
      workbench.getSharedTransforms(),
      snapino ? this.host.roomProgram().program : null,
      new Date(),
      snapino ? this.host.draftProgram() : null,
      snapino ? this.host.episodeDesign?.() ?? null : null,
    );
  }

  exportProject(): void {
    const project = this.currentProject();
    if (!project) return;
    const blob = new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = projectFileName(project);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.trace(undefined, project.draftProgram ? "Exported the project file (with an unsaved code draft)" : "Exported the project file");
    this.host.status(
      project.draftProgram
        ? "Project exported · parts, values, the room's program and your unsaved code draft (kept apart)"
        : "Project exported · parts, values and program only (no names, chat or activity)",
      "valid",
    );
  }

  chooseImport(): void {
    document.querySelector<HTMLInputElement>("#project-file-input")?.click();
  }

  private async importFile(file: File): Promise<void> {
    if (file.size > 64 * 1024) {
      this.host.status("That file is larger than 64 KB, so it is not a workbench project", "warning");
      return;
    }
    const text = await file.text();
    await this.importText(text, true);
  }

  /**
   * Validates, confirms and applies a project as ONE room edit (parts and, for Snapino, the
   * room program — loaded stopped). An unsaved draft in the file goes to this editor only.
   */
  async importText(text: string, confirm: boolean, label = "Loaded a project"): Promise<boolean> {
    const workbench = this.host.workbench();
    if (!workbench) return false;
    const parsed = parseProject(text, (studio) => workbench.studioCatalog(studio));
    if (!parsed.ok) {
      this.host.status(`Import refused · ${parsed.error}`, "warning");
      return false;
    }
    if (parsed.notice && confirm && !(await confirmDialog("Older greenhouse file", parsed.notice, "Load default rig"))) return false;
    const project = parsed.project;
    if (project.studio !== this.host.studio()) {
      this.host.status(`Import refused · this project is for the ${project.studio} studio; switch studios first`, "warning");
      return false;
    }
    if (this.host.boltBuilding()) {
      this.host.status("Bolt is building right now; import when it has finished", "warning");
      return false;
    }
    if (confirm && !(await confirmDialog(
      "Load this project?",
      `It places ${project.parts.filter((part) => part.sockets).length} part(s)${project.program ? " and loads its program (stopped)" : ""}, replacing the current bench for everyone in the room. You can undo it.`,
      "Load project",
    ))) return false;
    const changes: Array<{ id: string; transform: SharedTransform }> = [];
    for (const part of project.parts) {
      const sockets = part.sockets;
      const transform = !sockets
        ? workbench.homeTransform(part.id)
        : sockets[0] === null || sockets[1] === null
          ? workbench.partialLineTransform(part.id, sockets)
          : workbench.placementTransform(part.id, [sockets[0], sockets[1]]);
      if (!transform) {
        this.host.status(`Import refused · ${part.id} cannot be placed there`, "warning");
        return false;
      }
      if (part.props) transform.props = part.props;
      if (part.on !== undefined) transform.on = part.on;
      changes.push({ id: part.id, transform });
    }
    // After the room accepts the parts and program (now, or late after a timeout).
    const afterAccept = async (): Promise<void> => {
      if (project.episode && this.host.applyEpisodeDesign) {
        // The workshop design is room state with its own rules (the sender's, not during a
        // round): applied after the parts and program, and reported if the room refuses it.
        const designed = await this.host.applyEpisodeDesign({ mission: project.episode.mission, intent: project.episode.intent });
        if (!designed) this.host.status(`${label} · the Rescue Signal design was not applied (only the sender can change it, in an open workshop, and not during a round)`, "warning");
      }
      if (project.draftProgram) {
        this.host.loadDraft(project.draftProgram);
        this.host.status(`${label} · its unsaved code draft is in your editor (press Run to share it)`, "valid");
      }
    };
    return this.submit(changes, label, { program: project.program, tone: "valid", afterAccept });
  }

  /** Something on the bench or the room program changed (here or remotely): autosave soon. */
  noteChange(): void {
    this.scheduleAutosave();
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => this.autosave(), 900);
  }

  private storageKey(): string {
    return `vm-project:${this.host.roomCode()}:${this.host.studio()}`;
  }

  /**
   * Saves the latest bench (parts, values — also of parts left in the tray —, switch states,
   * room program, draft); only a bench entirely at its defaults clears it.
   */
  private autosave(): void {
    const project = this.currentProject();
    if (!project || !this.recoveryChecked) return;
    if (this.isEmpty(project)) {
      removeKey(this.storageKey());
      return;
    }
    writePreference(this.storageKey(), JSON.stringify(project));
  }

  /**
   * After joining (and after the room's state has arrived), offer to restore the last bench
   * this browser saved for this room, if it differs from the room's (parts, values or
   * program). Never automatic.
   */
  offerRecovery(): void {
    const workbench = this.host.workbench();
    this.recoveryChecked = true;
    if (!workbench) return;
    const saved = readText(this.storageKey());
    if (!saved) return;
    const parsed = parseProject(saved, (studio) => workbench.studioCatalog(studio));
    const current = this.currentProject();
    if (!parsed.ok || !current || parsed.project.studio !== this.host.studio()) return;
    if (this.isEmpty(parsed.project) || sameContent(parsed.project, current)) return;
    const host = document.querySelector<HTMLElement>("#recovery-banner");
    if (!host) return;
    const when = new Date(parsed.project.savedAt);
    host.hidden = false;
    host.innerHTML = `<i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i><span>Restore the bench this browser saved at ${escape(when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}?</span><button class="secondary-button compact" type="button" data-recovery="restore">Restore</button><button class="bare-button" type="button" data-recovery="dismiss" aria-label="Dismiss"><i class="ph ph-x" aria-hidden="true"></i></button>`;
    host.onclick = async (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-recovery]")?.dataset.recovery;
      if (!action) return;
      host.hidden = true;
      if (action === "restore") await this.importText(saved, false, "Restored the saved bench");
    };
  }
}


/** Same parts, values, switch states, room program and draft (ignores savedAt). */
function sameContent(a: ProjectFile, b: ProjectFile): boolean {
  return JSON.stringify(a.parts) === JSON.stringify(b.parts) &&
    JSON.stringify(a.episode ?? null) === JSON.stringify(b.episode ?? null) &&
    sameProgram(a.program, b.program) &&
    sameProgram(a.draftProgram ?? null, b.draftProgram ?? null);
}

function describeCount(parts: number, program: string): string {
  const items = [];
  if (parts) items.push(`${parts} part${parts === 1 ? "" : "s"}`);
  if (program) items.push(program);
  return items.join(" + ");
}

/** What a refused or unconfirmed edit tells the learner. Nothing changed in every case. */
function refusalCopy(label: string, result: Exclude<EditResult, { ok: true }>): string {
  const part = result.componentId === "program" ? "the program" : PART_NAMES[result.componentId ?? ""] ?? "a part";
  switch (result.reason) {
    case "held":
      return `${label} refused · ${result.holderName || "a teammate"} is holding ${part}; nothing changed`;
    case "stale":
      return `${label} refused · a teammate changed ${part} first, so their version is kept`;
    case "invalid":
      return `${label} refused by the room's validation (a value or jack outside the rules) · nothing changed`;
    case "occupied":
      return `${label} refused · that jack already holds another cable's plug (one plug per jack) · nothing changed`;
    case "running":
      return `${label} refused · the greenhouse day is running; pause it to change the rig · nothing changed`;
    case "offline":
      return `${label} not sent · reconnecting to the room, nothing changed`;
    case "timeout":
      return `${label} not confirmed yet · still waiting for the room; if it accepts, the change appears for everyone and your undo history follows`;
    case "disconnected":
      // The connection closed while the edit was out: the room may have accepted it before.
      return `${label} not confirmed · the connection closed before the room answered; if the room accepted it, it will appear for everyone after reconnecting (not added to undo)`;
    default:
      return `${label} not confirmed by the room · if it accepted it, it will appear for everyone (not added to undo)`;
  }
}

function summarize(analysis: CircuitAnalysis): { pill: string; tone: "neutral" | "valid" | "warning"; explanation: string } {
  const board = analysis.board;
  const status = board.result.status;
  const firstError = board.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  const firstWarning = board.diagnostics.find((diagnostic) => diagnostic.severity === "warning");
  if (status === "invalid" || status === "singular" || status === "non-convergence") {
    return { pill: "Not solved", tone: "warning", explanation: firstError?.message ?? "The circuit could not be solved, so nothing is shown as working." };
  }
  if (analysis.short) return { pill: "Short circuit", tone: "warning", explanation: firstError?.message ?? "The battery is shorted." };
  if (analysis.unprotectedLeds.length) return { pill: "LED burns out", tone: "warning", explanation: board.diagnostics.find((d) => d.code === "led-burnout")?.message ?? "" };
  if (analysis.overdrivenLeds.length) return { pill: "Overdriven", tone: "warning", explanation: board.diagnostics.find((d) => d.code === "led-overcurrent")?.message ?? "" };
  if (analysis.reverseStressedLeds.length) return { pill: "Reverse > 5 V", tone: "warning", explanation: board.diagnostics.find((d) => d.code === "led-reverse-overvoltage")?.message ?? "" };
  if (analysis.powered) {
    const id = board.safeLitLeds[0];
    const amps = board.result.elements[id]?.amps ?? 0;
    return {
      pill: `Safe · ${formatAmps(amps)}`,
      tone: "valid",
      explanation: `The LED carries ${formatAmps(amps)}, within its 20 mA rating: the resistor takes the rest of the battery's voltage.${firstWarning ? ` Note: ${firstWarning.message}` : ""}`,
    };
  }
  if (analysis.reversedLeds.length) return { pill: "LED reversed", tone: "warning", explanation: board.diagnostics.find((d) => d.code === "reverse-led")?.message ?? "" };
  if (!analysis.batteryPlaced) return { pill: "No power", tone: "neutral", explanation: "Place the battery in the board: current needs a source." };
  if (status === "open-circuit") return { pill: "Open circuit", tone: "neutral", explanation: "The path does not return to the battery's other terminal, so no current flows." };
  if (board.glowingLeds.length) return { pill: "Dim", tone: "neutral", explanation: "Current flows, but too little to light the LED clearly. Try a smaller resistance." };
  return { pill: "No LED lit", tone: "neutral", explanation: "Current flows somewhere, but not through an LED." };
}

function formatPower(reading: ElementReading): string {
  const watts = Math.abs(reading.watts);
  if (watts >= 1) return `${watts.toFixed(2)} W`;
  return `${(watts * 1000).toFixed(watts >= 0.01 ? 0 : 1)} mW`;
}

function trimNumber(value: number): string {
  return String(roundVolts(value));
}

function sameProps(a: PartProps | undefined, b: PartProps): boolean {
  return (a?.ohms ?? null) === (b.ohms ?? null) && (a?.volts ?? null) === (b.volts ?? null);
}

/** "Row c, column 5" style label for a socket (rows a–j between the + and − rails). */
export function socketLabel(socket: number): string {
  const row = Math.floor(socket / 16);
  const col = (socket % 16) + 1;
  if (row === 0) return `+ rail, column ${col}`;
  if (row === 11) return `− rail, column ${col}`;
  return `${"abcdefghij"[row - 1]}${col}`;
}

export function confirmDialog(title: string, body: string, ok: string): Promise<boolean> {
  const dialog = document.querySelector<HTMLDialogElement>("#confirm-dialog");
  if (!dialog) return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  dialog.querySelector("#confirm-title")!.textContent = title;
  dialog.querySelector("#confirm-body")!.textContent = body;
  dialog.querySelector("#confirm-ok")!.textContent = ok;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

function readPreference(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: boolean | string): void {
  try {
    localStorage.setItem(key, typeof value === "boolean" ? (value ? "1" : "0") : value);
  } catch {
    // Storage is a convenience; everything still works without it.
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage is a convenience.
  }
}

function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
