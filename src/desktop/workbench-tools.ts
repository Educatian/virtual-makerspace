/**
 * Workbench tools around the shared scene: the circuit inspector/meter, conflict-safe
 * undo/redo, project export/import, local recovery, reset and "return to tray".
 *
 * Every change these tools make is an ordinary shared edit: the part is claimed, its new
 * transform is applied locally and sent to the room, then released — so the Worker's claim
 * rules apply, peers (and Bolt) converge on the same state, and nothing bypasses the room.
 * Edits are traced as "edit", never as "claim"/"move", so existing research metrics that
 * count claims and moves are unchanged.
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
import type { CollaborationPhase, DesktopRoom, SharedTransform } from "./collaboration.js";
import { EditHistory, sameTransform, type HistoryChange } from "./edit-history.ts";
import { buildProject, parseProject, projectFileName, type ProjectFile } from "./project-file.ts";
import type { ComponentSpec, DesktopWorkbenchScene, StudioKind } from "./scene.js";
import type { SnapinoStatement } from "./snapino.ts";

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
  program(): SnapinoStatement[];
  loadProgram(program: SnapinoStatement[]): void;
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
  private disposed = false;

  constructor(host: ToolsHost) {
    this.host = host;
    this.collapsed = readPreference("vm-inspector-collapsed", window.matchMedia?.("(max-width: 900px)").matches ?? false);
  }

  // ── Inspector ───────────────────────────────────────────────────────────────

  /** Markup for the floating inspector; `bind()` wires it up after it is in the DOM. */
  static markup(): string {
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
          <p class="inspector-foot">Educational DC model · <span title="Modified nodal analysis with piecewise-linear LEDs and a 1 Ω battery; not SPICE and not datasheet-exact">${SOLVER_VERSION}</span></p>
        </div>
      </section>
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

  /** Validated property edit as one shared change and one undo step. */
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
    if (sameProps(before?.props, props)) return true;
    const room = this.host.room();
    room?.claim(componentId);
    const applied = workbench.setPartProps(componentId, props);
    room?.release(componentId);
    if (!applied) return false;
    const after = workbench.getSharedTransforms()[componentId];
    const label = kind === "resistor" ? `Set resistor to ${formatOhms(props.ohms!)}` : `Set battery to ${trimNumber(props.volts!)} V`;
    this.history.record(label, [{ id: componentId, before, after }]);
    this.trace(componentId, label);
    this.host.status(`${label} · shared with the room`, "neutral");
    this.updateHistoryButtons();
    this.lastEditorKey = "";
    this.queueRender();
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
  inspectorRight(): number {
    const inspector = document.querySelector<HTMLElement>("#inspector");
    if (!inspector || inspector.hidden || this.collapsed) return 0;
    return inspector.getBoundingClientRect().right;
  }

  // ── Shared multi-part changes ─────────────────────────────────────────────────

  /** Claim → apply → send → release for each part. Returns false (nothing changed) if any part is held. */
  private applyShared(changes: Array<{ id: string; transform: SharedTransform }>): boolean {
    const workbench = this.host.workbench();
    const room = this.host.room();
    if (!workbench) return false;
    const held = changes.map((change) => this.host.holderOf(change.id)).find(Boolean);
    if (held) {
      this.host.status(`${held} is holding a part; try again when they let go`, "warning");
      return false;
    }
    for (const { id, transform } of changes) {
      room?.claim(id);
      workbench.applyRemoteTransform(id, transform, true);
      room?.sendTransform(id, transform);
      room?.release(id);
    }
    return true;
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

  /** Called when this participant lets go: record the move as one undo step. */
  endLocalEdit(resourceId: string): void {
    const id = resourceId.split("::")[0];
    const before = this.pending.get(id);
    const workbench = this.host.workbench();
    this.pending.delete(id);
    if (!before || !workbench) return;
    // A cable end released while the other end is still held stays one step.
    if ([`${id}::endpoint-0`, `${id}::endpoint-1`].some((resource) => resource !== resourceId && this.pending.has(resource))) return;
    const after = workbench.getSharedTransforms()[id];
    if (this.history.record(`Moved ${PART_NAMES[id] ?? id}`, [{ id, before, after }])) this.updateHistoryButtons();
    this.scheduleAutosave();
  }

  undo(): void {
    this.step("undo");
  }

  redo(): void {
    this.step("redo");
  }

  private step(direction: "undo" | "redo"): void {
    const workbench = this.host.workbench();
    if (!workbench) return;
    const transforms = workbench.getSharedTransforms();
    const verdict = this.history[direction](
      (id) => transforms[id] ?? null,
      (id) => Boolean(this.host.holderOf(id)),
    );
    if (!verdict.ok) {
      const copy = verdict.reason === "empty"
        ? `Nothing to ${direction}`
        : verdict.reason === "held"
          ? `Can't ${direction} "${verdict.label}" — ${this.host.holderOf(verdict.partId ?? "") ?? "a teammate"} is holding ${PART_NAMES[verdict.partId ?? ""] ?? "that part"}`
          : `Can't ${direction} "${verdict.label}" — a teammate changed ${PART_NAMES[verdict.partId ?? ""] ?? "that part"} since, so their work is kept`;
      this.host.status(copy, verdict.reason === "empty" ? "neutral" : "warning");
      this.updateHistoryButtons();
      return;
    }
    if (!this.applyShared(verdict.apply)) {
      this.updateHistoryButtons();
      return;
    }
    this.trace(verdict.apply.length === 1 ? verdict.apply[0].id : undefined, `${direction === "undo" ? "Undid" : "Redid"}: ${verdict.label}`);
    this.host.status(`${direction === "undo" ? "Undid" : "Redid"} · ${verdict.label}`, "neutral");
    this.updateHistoryButtons();
    this.lastEditorKey = "";
    this.queueRender();
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
    const before = workbench.getSharedTransforms()[componentId];
    if (!this.applyShared([{ id: componentId, transform: home }])) return;
    const label = `Returned ${PART_NAMES[componentId] ?? componentId} to the tray`;
    this.history.record(label, [{ id: componentId, before, after: workbench.getSharedTransforms()[componentId] }]);
    this.trace(componentId, label);
    this.host.status(label, "neutral");
    this.updateHistoryButtons();
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
      const home = workbench.homeTransform(id);
      if (!home) continue;
      const defaults = workbench.defaultPartProps(id);
      if (defaults) home.props = defaults;
      if (catalog.switches.includes(id)) home.on = false;
      changes.push({ id, transform: home });
    }
    this.applyBulk(changes, "Reset the bench");
  }

  private applyBulk(changes: Array<{ id: string; transform: SharedTransform }>, label: string): boolean {
    const workbench = this.host.workbench();
    if (!workbench) return false;
    const before = workbench.getSharedTransforms();
    const real = changes.filter((change) => !sameTransform(before[change.id], change.transform));
    if (!real.length) {
      this.host.status(`${label} · nothing to change`, "neutral");
      return true;
    }
    if (!this.applyShared(real)) return false;
    const after = workbench.getSharedTransforms();
    const recorded: HistoryChange[] = real.map((change) => ({ id: change.id, before: before[change.id], after: after[change.id] }));
    this.history.record(label, recorded);
    this.trace(undefined, `${label} (${real.length} part${real.length === 1 ? "" : "s"})`);
    this.host.status(`${label} · shared with the room`, "valid");
    this.updateHistoryButtons();
    this.lastEditorKey = "";
    this.queueRender();
    return true;
  }

  // ── Export / import / recovery ────────────────────────────────────────────────

  private currentProject(): ProjectFile | null {
    const workbench = this.host.workbench();
    if (!workbench) return null;
    const studio = this.host.studio();
    return buildProject(workbench.studioCatalog(studio), workbench.getSharedTransforms(), studio === "snapino" ? this.host.program() : null);
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
    this.trace(undefined, "Exported the project file");
    this.host.status("Project exported · parts, values and program only (no names, chat or activity)", "valid");
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

  /** Validates, confirms and applies a project as shared edits (one undo step). */
  async importText(text: string, confirm: boolean): Promise<boolean> {
    const workbench = this.host.workbench();
    if (!workbench) return false;
    const parsed = parseProject(text, (studio) => workbench.studioCatalog(studio));
    if (!parsed.ok) {
      this.host.status(`Import refused · ${parsed.error}`, "warning");
      return false;
    }
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
      `It places ${project.parts.filter((part) => part.sockets).length} part(s) and replaces the current bench for everyone in the room. You can undo it.`,
      "Load project",
    ))) return false;
    const changes: Array<{ id: string; transform: SharedTransform }> = [];
    for (const part of project.parts) {
      const transform = part.sockets ? workbench.placementTransform(part.id, part.sockets) : workbench.homeTransform(part.id);
      if (!transform) {
        this.host.status(`Import refused · ${part.id} cannot be placed there`, "warning");
        return false;
      }
      if (part.props) transform.props = part.props;
      if (part.on !== undefined) transform.on = part.on;
      changes.push({ id: part.id, transform });
    }
    const applied = this.applyBulk(changes, "Loaded a project");
    if (applied && project.program) this.host.loadProgram(project.program);
    return applied;
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => this.autosave(), 900);
  }

  private storageKey(): string {
    return `vm-project:${this.host.roomCode()}:${this.host.studio()}`;
  }

  private autosave(): void {
    const project = this.currentProject();
    if (!project || !this.recoveryChecked) return;
    if (!project.parts.some((part) => part.sockets)) return;
    writePreference(this.storageKey(), JSON.stringify(project));
  }

  /**
   * After joining (and after any shared state has arrived), offer to restore the last bench
   * this browser saved for this room, if the room's bench is different. Never automatic.
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
    const same = JSON.stringify(parsed.project.parts) === JSON.stringify(current.parts);
    if (same) return;
    const host = document.querySelector<HTMLElement>("#recovery-banner");
    if (!host) return;
    const when = new Date(parsed.project.savedAt);
    host.hidden = false;
    host.innerHTML = `<i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i><span>Restore the bench this browser saved at ${escape(when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}?</span><button class="secondary-button compact" type="button" data-recovery="restore">Restore</button><button class="bare-button" type="button" data-recovery="dismiss" aria-label="Dismiss"><i class="ph ph-x" aria-hidden="true"></i></button>`;
    host.onclick = async (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-recovery]")?.dataset.recovery;
      if (!action) return;
      host.hidden = true;
      if (action === "restore") await this.importText(saved, false);
    };
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
  if (analysis.powered) {
    const id = board.safeLitLeds[0];
    const amps = board.result.elements[id]?.amps ?? 0;
    return {
      pill: `Safe · ${formatAmps(amps)}`,
      tone: "valid",
      explanation: `The LED carries ${formatAmps(amps)}, inside its 20 mA rating: the resistor takes the rest of the battery's voltage.${firstWarning ? ` Note: ${firstWarning.message}` : ""}`,
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

function confirmDialog(title: string, body: string, ok: string): Promise<boolean> {
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

function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
