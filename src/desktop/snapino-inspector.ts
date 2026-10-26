/**
 * The Snapino bench's one contextual inspector (a tab of the right-hand dock): the live circuit
 * diagram and the selected part's reference, all derived from the bench's canonical state.
 *
 * Cross-links: selecting a part anywhere (3D, the parts rail, the diagram) selects it in the 3D
 * bench, highlights its terminals and both nets there, highlights its rung and rows here, and
 * shows its reference. Choosing a row (net) highlights that net's studs in 3D.
 *
 * Edits: the only edit made here is S1's switch, submitted as one room edit through the same
 * path as a double-click on the part (`WorkbenchTools.applyBulk`). Nothing changes locally until
 * the room accepts it; a refused or stale edit leaves everything as it was. The code editor's
 * draft is never touched.
 */
import { buildSnapinoDiagram, padAt, renderSnapinoDiagramSvg, SNAPINO_SHORT_NAMES, studLabel, type SnapinoDiagram } from "../circuit/snapino-diagram.ts";
import { SNAPINO_CONDUCTORS, SNAPINO_SWITCH } from "../circuit/snapino-circuit.ts";
import type { DesktopWorkbenchScene, StudHighlight } from "./scene.js";
import type { PinStates } from "./snapino.ts";
import { SNAP_WIRE_REFERENCE, SNAPINO_PAD_REFERENCE, SNAPINO_PART_REFERENCE } from "./snapino-parts.ts";

export interface InspectorHost {
  workbench(): DesktopWorkbenchScene | null;
  /** The selected part's id, or null. */
  selectedId(): string | null;
  /** Select a part as a user would (3D selection, inspector focus). */
  select(id: string): void;
  pins(): PinStates;
  /** Fault notes allowed (DI, no workshop, or PF after the team's first compared round). */
  showFaults(): boolean;
  /** Why fault notes are withheld right now (shown instead of them), or null. */
  faultsWithheldNote(): string | null;
  /** Submits S1's flip as one room edit; resolves with whether the room accepted it. */
  flipSwitch(on: boolean): Promise<boolean>;
  holderOf(id: string): string | null;
  focusPart(): void;
}

type InspectTab = "overview" | "pinout" | "behavior";

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const LEVEL_WORDS: Record<string, string> = { short: "short (5V = GND)", supply: "5 V", ground: "0 V (GND)", high: "HIGH · 5 V", low: "LOW", free: "floating" };

export class SnapinoInspector {
  private diagram: SnapinoDiagram | null = null;
  private focusRow: string | null = null;
  private tab: InspectTab = "overview";
  private frame = 0;
  private lastDiagramKey = "";
  private lastPartKey = "";
  private lastHighlightKey = "";
  private editNote: { part: string; text: string; tone: "valid" | "warning" } | null = null;
  private pending = false;
  private disposed = false;

  constructor(private readonly host: InspectorHost) {}

  static markup(): string {
    return `<section class="snapino-inspector" id="snapino-inspector" aria-labelledby="inspector-heading">
      <header class="si-head">
        <h2 class="section-label" id="inspector-heading">Bench inspector</h2>
        <span class="si-summary" id="si-summary" role="status" aria-live="polite"></span>
      </header>
      <section class="si-card" aria-labelledby="si-diagram-title">
        <div class="si-card-head">
          <h3 id="si-diagram-title">Live circuit diagram</h3>
          <small>Drawn from the parts as seated</small>
        </div>
        <div class="si-diagram" id="si-diagram"></div>
        <ul class="si-connections sr-only" id="si-connections" aria-label="Connections, as text"></ul>
        <div class="si-faults" id="si-faults"></div>
        <p class="si-tray" id="si-tray"></p>
      </section>
      <section class="si-card si-part" id="si-part" aria-live="polite"></section>
    </section>`;
  }

  bind(): void {
    const root = document.querySelector<HTMLElement>("#snapino-inspector");
    if (!root) return;
    root.addEventListener("click", (event) => this.onActivate(event.target as Element));
    root.addEventListener("keydown", (event) => {
      const target = event.target as Element;
      if ((event.key === "Enter" || event.key === " ") && target.closest("[data-row], [data-part]") && !target.closest("button")) {
        event.preventDefault();
        this.onActivate(target);
      }
      if (target.matches('[role="tab"]') && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        event.preventDefault();
        const tabs: InspectTab[] = ["overview", "pinout", "behavior"];
        const next = tabs[(tabs.indexOf(this.tab) + (event.key === "ArrowRight" ? 1 : 2)) % 3];
        this.setTab(next, true);
      }
    });
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.host.workbench()?.setStudHighlights([]);
  }

  /** Bench, pins, selection or condition changed: re-derive on the next frame. */
  refresh(): void {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Synchronous render (tests and first paint). */
  render(): void {
    const workbench = this.host.workbench();
    const root = document.querySelector<HTMLElement>("#snapino-inspector");
    if (!workbench || !root) return;
    const pins = this.host.pins();
    const diagram = buildSnapinoDiagram(workbench.snapinoBench(), pins);
    this.diagram = diagram;
    const selected = this.host.selectedId();
    if (selected && !SNAPINO_SHORT_NAMES[selected]) this.focusRow = null;
    if (this.focusRow && !diagram.rows.some((row) => row.key === this.focusRow)) this.focusRow = null;
    const showFaults = this.host.showFaults();
    const diagramKey = JSON.stringify([diagram, selected, this.focusRow, showFaults]);
    if (diagramKey !== this.lastDiagramKey) {
      this.lastDiagramKey = diagramKey;
      this.renderDiagram(diagram, selected, showFaults);
    }
    this.renderPart(diagram, selected);
    this.updateHighlights(diagram, selected);
  }

  private renderDiagram(diagram: SnapinoDiagram, selected: string | null, showFaults: boolean): void {
    const host = document.querySelector<HTMLElement>("#si-diagram");
    const list = document.querySelector<HTMLElement>("#si-connections");
    const faults = document.querySelector<HTMLElement>("#si-faults");
    const tray = document.querySelector<HTMLElement>("#si-tray");
    const summary = document.querySelector<HTMLElement>("#si-summary");
    if (!host || !list || !faults || !tray || !summary) return;
    // Keep keyboard focus on the same row/rung across a re-render.
    const active = document.activeElement as Element | null;
    const focusKey = active && host.contains(active) ? (active.getAttribute("data-part") ? `[data-part="${active.getAttribute("data-part")}"]` : active.getAttribute("data-row") ? `[data-row="${active.getAttribute("data-row")}"]` : null) : null;
    host.innerHTML = renderSnapinoDiagramSvg(diagram, { selected, showFaults, focusRow: this.focusRow });
    if (focusKey) host.querySelector<HTMLElement>(focusKey)?.focus();
    const rowName = (key: string): string => diagram.rows.find((row) => row.key === key)?.label ?? key;
    list.innerHTML = diagram.rungs.map((rung) =>
      `<li>${escape(`${rung.name}: ${rowName(rung.ends[0])} (${padAt(rung.studs[0]) ?? studLabel(rung.studs[0])}) to ${rowName(rung.ends[1])} (${padAt(rung.studs[1]) ?? studLabel(rung.studs[1])})${rung.kind === "switch" ? (rung.active ? ", closed" : ", open") : rung.active ? ", running" : ", off"}`)}</li>`,
    ).join("") || "<li>No parts are seated.</li>";
    const withheld = this.host.faultsWithheldNote();
    if (showFaults) {
      faults.innerHTML = diagram.faults.length
        ? `<ul>${diagram.faults.map((fault) => `<li data-fault="${fault.kind}"${fault.part ? ` data-part="${fault.part}"` : ""}><i class="ph ph-warning" aria-hidden="true"></i><span>${escape(fault.text)}</span></li>`).join("")}</ul>`
        : `<p class="si-ok"><i class="ph ph-check-circle" aria-hidden="true"></i> No wiring faults. What runs still depends on the program.</p>`;
    } else {
      faults.innerHTML = withheld ? `<p class="si-withheld"><i class="ph ph-eye-slash" aria-hidden="true"></i> ${escape(withheld)}</p>` : "";
    }
    tray.textContent = diagram.tray.length ? `In the tray: ${diagram.tray.map((id) => SNAPINO_SHORT_NAMES[id]).join(", ")}` : "";
    const running = diagram.rungs.filter((rung) => rung.kind !== "switch" && rung.active).map((rung) => rung.short);
    summary.textContent = diagram.short ? "Short circuit" : running.length ? `${running.join(" · ")} running` : `${diagram.rungs.length} part${diagram.rungs.length === 1 ? "" : "s"} seated`;
    summary.dataset.tone = diagram.short ? "warning" : running.length ? "valid" : "neutral";
  }

  private renderPart(diagram: SnapinoDiagram, selected: string | null): void {
    const container = document.querySelector<HTMLElement>("#si-part");
    const workbench = this.host.workbench();
    if (!container || !workbench) return;
    const reference = selected ? SNAPINO_PART_REFERENCE[selected] : null;
    const wire = selected && (SNAPINO_CONDUCTORS as readonly string[]).includes(selected);
    const holder = selected ? this.host.holderOf(selected) : null;
    const rung = diagram.rungs.find((entry) => entry.id === selected) ?? null;
    const bench = workbench.snapinoBench();
    const sockets = selected ? bench[selected]?.sockets ?? null : null;
    const on = selected === SNAPINO_SWITCH ? bench[SNAPINO_SWITCH]?.on === true : false;
    const note = this.editNote && this.editNote.part === selected ? this.editNote : null;
    const key = JSON.stringify([selected, this.tab, holder, sockets, on, rung?.active, rung?.ends, diagram.rows.map((row) => [row.key, row.level]), diagram.drivers[selected ?? ""], note, this.pending]);
    if (key === this.lastPartKey) return;
    // Never re-render under the learner's cursor inside a focused tab control.
    this.lastPartKey = key;
    const hadFocus = container.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;

    if (!selected || (!reference && !wire)) {
      container.innerHTML = `<p class="si-hint"><i class="ph ph-cursor-click" aria-hidden="true"></i> Select a part in the 3D bench or on the diagram to see its ends, behaviour and limits. Choose a row to light up that net's studs.</p>
        ${this.focusRow ? this.netDetail(diagram, this.focusRow) : ""}`;
      return;
    }
    const short = SNAPINO_SHORT_NAMES[selected];
    const name = reference?.name ?? `Snap wire ${short}`;
    const role = reference?.role ?? SNAP_WIRE_REFERENCE.role;
    const rowOf = (socket: number | null | undefined): string => {
      if (socket === null || socket === undefined) return "in the tray";
      const row = diagram.rows.find((entry) => entry.studs.includes(socket));
      const pad = padAt(socket);
      return `stud ${studLabel(socket)}${pad ? ` (${pad} pad)` : ""} · net ${row?.label ?? "?"} · ${LEVEL_WORDS[row?.level ?? "free"]}`;
    };
    const state = !sockets
      ? { text: "In the tray", tone: "neutral" }
      : selected === SNAPINO_SWITCH
        ? { text: on ? "On · closed" : "Off · open", tone: on ? "valid" : "neutral" }
        : wire
          ? { text: "Conducting", tone: "neutral" }
          : rung?.active
            ? { text: "Running", tone: "valid" }
            : { text: "Off", tone: "neutral" };
    const drivers = diagram.drivers[selected];
    const driverLine = !wire && selected !== SNAPINO_SWITCH && sockets
      ? drivers?.length
        ? drivers.includes("5V") ? "Driven straight from 5V: on whenever the board is powered." : `Can be switched by ${drivers.join(" or ")}: it runs while ${drivers.length > 1 ? "one of them" : drivers[0]} is HIGH.`
        : "No pin can drive it as wired."
      : "";
    const ends = reference?.ends ?? ["End A", "End B"];
    const tabs: Array<[InspectTab, string]> = [["overview", "Overview"], ["pinout", "Pinout"], ["behavior", "Behaviour & limits"]];
    const panel = this.tab === "overview"
      ? `<p>${escape(reference?.overview ?? SNAP_WIRE_REFERENCE.overview)}</p>${driverLine ? `<p class="si-driver">${escape(driverLine)}</p>` : ""}`
      : this.tab === "pinout"
        ? `<dl class="si-pinout">${[0, 1].map((index) => `<div><dt>${escape(ends[index])}</dt><dd>${escape(rowOf(sockets?.[index]))}</dd></div>`).join("")}</dl>
           ${sockets ? sockets.map((socket) => (padAt(socket as number) ? `<p class="si-pad"><strong>${padAt(socket as number)}</strong> ${escape(SNAPINO_PAD_REFERENCE[padAt(socket as number)!])}</p>` : "")).join("") : ""}`
        : `<h4>On this bench</h4><ul>${(reference?.behavior ?? SNAP_WIRE_REFERENCE.behavior).map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
           <h4>Real hardware</h4><ul>${(reference?.limits ?? SNAP_WIRE_REFERENCE.limits).map((line) => `<li>${escape(line)}</li>`).join("")}</ul>`;
    const switchButton = selected === SNAPINO_SWITCH
      ? `<button class="secondary-button compact" type="button" data-act="switch" data-focus-key="switch" aria-pressed="${on}" ${holder || this.pending ? "disabled" : ""}><i class="ph ${on ? "ph-toggle-right" : "ph-toggle-left"}" aria-hidden="true"></i> ${on ? "Switch S1 off" : "Switch S1 on"}</button>`
      : "";
    container.innerHTML = `
      <header class="si-part-head">
        <span class="si-chip" aria-hidden="true">${escape(short)}</span>
        <div><h3 id="si-part-title">${escape(name)}</h3><small>${escape(role)}</small></div>
        <span class="si-state" data-tone="${state.tone}">${escape(state.text)}</span>
      </header>
      ${holder ? `<p class="si-held"><i class="ph ph-hand" aria-hidden="true"></i> ${escape(holder)} is holding this part</p>` : ""}
      <div class="si-actions">
        <button class="secondary-button compact" type="button" data-act="fit" data-focus-key="fit"><i class="ph ph-crosshair-simple" aria-hidden="true"></i> Zoom to it</button>
        ${switchButton}
      </div>
      ${note ? `<p class="si-edit" data-tone="${note.tone}" role="status">${escape(note.text)}</p>` : ""}
      <div class="si-tabs" role="tablist" aria-label="${escape(name)} reference">
        ${tabs.map(([id, label]) => `<button type="button" role="tab" id="si-tab-${id}" data-tab="${id}" data-focus-key="tab-${id}" aria-selected="${this.tab === id}" aria-controls="si-tabpanel" tabindex="${this.tab === id ? 0 : -1}">${label}</button>`).join("")}
      </div>
      <div class="si-tabpanel" id="si-tabpanel" role="tabpanel" aria-labelledby="si-tab-${this.tab}" tabindex="0">${panel}</div>`;
    if (hadFocus) container.querySelector<HTMLElement>(`[data-focus-key="${hadFocus}"]`)?.focus();
  }

  private netDetail(diagram: SnapinoDiagram, key: string): string {
    const row = diagram.rows.find((entry) => entry.key === key);
    if (!row) return "";
    const pads = row.pads.map((pad) => `<li><strong>${pad}</strong> ${escape(SNAPINO_PAD_REFERENCE[pad])}</li>`).join("");
    return `<div class="si-net"><h3>Net ${escape(row.label)} <span>${escape(LEVEL_WORDS[row.level])}</span></h3>
      <p>Studs: ${escape(row.studs.map((stud) => studLabel(stud)).join(", "))}${row.via.length ? ` · joined by ${escape(row.via.join(", "))}` : ""}</p>
      ${pads ? `<ul>${pads}</ul>` : ""}</div>`;
  }

  private setTab(tab: InspectTab, focus = false): void {
    this.tab = tab;
    this.lastPartKey = "";
    if (this.diagram) this.renderPart(this.diagram, this.host.selectedId());
    if (focus) document.querySelector<HTMLElement>(`#si-tab-${tab}`)?.focus();
  }

  private onActivate(target: Element): void {
    const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "fit") {
      this.host.focusPart();
      return;
    }
    if (act === "switch") {
      void this.flip();
      return;
    }
    const tab = target.closest<HTMLElement>('[role="tab"]')?.dataset.tab as InspectTab | undefined;
    if (tab) {
      this.setTab(tab, true);
      return;
    }
    const part = target.closest<HTMLElement>("[data-part]")?.dataset.part;
    if (part && target.closest("#si-diagram")) {
      this.focusRow = null;
      this.host.select(part);
      this.refresh();
      return;
    }
    const row = target.closest<HTMLElement>("[data-row]")?.dataset.row;
    if (row) {
      this.focusRow = this.focusRow === row ? null : row;
      this.refresh();
    }
  }

  private async flip(): Promise<void> {
    if (this.pending) return;
    const on = this.host.workbench()?.snapinoBench()[SNAPINO_SWITCH]?.on === true;
    this.pending = true;
    this.editNote = null;
    this.render();
    let accepted = false;
    try {
      accepted = await this.host.flipSwitch(!on);
    } finally {
      this.pending = false;
    }
    const now = this.host.workbench()?.snapinoBench()[SNAPINO_SWITCH]?.on === true;
    this.editNote = accepted
      ? { part: SNAPINO_SWITCH, text: `The room accepted it: S1 is ${now ? "on" : "off"} for everyone.`, tone: "valid" }
      : { part: SNAPINO_SWITCH, text: `Not changed: the room did not accept the flip, so S1 is still ${now ? "on" : "off"} here and for everyone.`, tone: "warning" };
    this.lastPartKey = "";
    this.render();
  }

  /** Terminal and net studs of the selection (or of the chosen row) in the 3D bench. */
  private updateHighlights(diagram: SnapinoDiagram, selected: string | null): void {
    const workbench = this.host.workbench();
    if (!workbench) return;
    const highlights: StudHighlight[] = [];
    const bench = workbench.snapinoBench();
    const sockets = selected ? bench[selected]?.sockets : null;
    if (selected && sockets && sockets[0] !== null && sockets[1] !== null && sockets[0] !== undefined && sockets[1] !== undefined) {
      const rowA = diagram.rows.find((row) => row.studs.includes(sockets[0] as number));
      const rowB = diagram.rows.find((row) => row.studs.includes(sockets[1] as number));
      const same = rowA && rowA === rowB;
      for (const [row, tone] of [[rowA, "a"], [rowB, "b"]] as const) {
        for (const stud of row?.studs ?? []) {
          if (highlights.some((entry) => entry.socket === stud)) continue;
          highlights.push({ socket: stud, tone: same ? "fault" : tone, terminal: stud === sockets[0] || stud === sockets[1] });
        }
      }
    } else if (this.focusRow) {
      const row = diagram.rows.find((entry) => entry.key === this.focusRow);
      for (const stud of row?.studs ?? []) highlights.push({ socket: stud, tone: "a", terminal: false });
    }
    const key = JSON.stringify(highlights);
    if (key === this.lastHighlightKey) return;
    this.lastHighlightKey = key;
    workbench.setStudHighlights(highlights);
  }
}
