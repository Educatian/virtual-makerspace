import {
  CanvasTexture,
  createSystem,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Transform,
  type Entity,
} from "@iwsdk/core";

import {
  CircuitNode,
  LedState,
  PowerSource,
  WireEnds,
} from "../components/circuit.js";
import { GazeTarget } from "../components/gaze-target.js";
import { Snappable, SnapTarget } from "../components/snap.js";
import { SocketGrid } from "../components/socket-grid.js";
import { telemetry } from "../telemetry.js";

const HISTORY_LENGTH = 4;
const STABILITY_DEBOUNCE_MS = 1500;

const PANEL_POSITION: [number, number, number] = [-0.2, 1.04, -1.2];
const PANEL_TILT_RAD = (-15 * Math.PI) / 180;

const SLOT_W = 0.08;
const SLOT_H = 0.05;
const SLOT_GAP = 0.014;
const PANEL_WIDTH = HISTORY_LENGTH * SLOT_W + (HISTORY_LENGTH - 1) * SLOT_GAP;
const PANEL_HEIGHT = SLOT_H;

const SLOT_PX_W = 96;
const SLOT_PX_H = 60;
const CANVAS_W = SLOT_PX_W * HISTORY_LENGTH;
const CANVAS_H = SLOT_PX_H;

const COLOR_BG_PANEL = "#141a26";
const COLOR_BORDER_SUBTLE = "#2a3245";
const COLOR_TEXT_MUTED = "#9aa6bd";
const PANEL_BG_ALPHA = 0.92;

type ComponentKind = "battery" | "led" | "wire" | "resistor" | "unknown";
type TriggerReason = "stable_dwell" | "task_complete";

interface Placement {
  id: number;
  kind: ComponentKind;
  socketA: number;
  socketB: number;
}

interface AttemptSnapshot {
  index: number;
  placements: Placement[];
  canonical: string;
}

const history: AttemptSnapshot[] = [];
let snapshotCounter = 0;

function canonicalize(placements: Placement[]): string {
  return placements
    .map((p) => {
      const a = Math.min(p.socketA, p.socketB);
      const b = Math.max(p.socketA, p.socketB);
      return `${p.id}:${p.kind}:${a}-${b}`;
    })
    .sort()
    .join("|");
}

export class AttemptHistorySystem extends createSystem({
  snappables: { required: [Snappable] },
  batteries: { required: [Snappable, CircuitNode, PowerSource] },
  leds: { required: [Snappable, CircuitNode, LedState] },
  resistors: {
    required: [Snappable, CircuitNode],
    excluded: [LedState, PowerSource],
  },
  wires: { required: [Snappable, WireEnds] },
  board: { required: [SnapTarget, SocketGrid, Transform] },
}) {
  private panelMesh!: Mesh;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private texture!: CanvasTexture;
  private debounceDeadline: number | null = null;
  private connectHandler = () => this.scheduleCapture();
  private disconnectHandler = () => this.scheduleCapture();
  private grabStartHandler = () => this.scheduleCapture();
  private taskCompleteHandler = () => this.forceCapture();

  init() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    this.ctx = ctx;

    this.texture = new CanvasTexture(this.canvas);
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;

    this.panelMesh = new Mesh(
      new PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
      new MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthWrite: true,
      }),
    );
    this.panelMesh.position.set(...PANEL_POSITION);
    this.panelMesh.rotation.x = PANEL_TILT_RAD;
    this.panelMesh.visible = false;
    this.world
      .createTransformEntity(this.panelMesh, {
        parent: this.world.sceneEntity,
        persistent: true,
      })
      .addComponent(GazeTarget, { name: "attempt_history" });

    window.addEventListener("vm:socket_connect", this.connectHandler);
    window.addEventListener("vm:socket_disconnect", this.disconnectHandler);
    window.addEventListener("vm:grab_start", this.grabStartHandler);
    window.addEventListener("vm:task_complete", this.taskCompleteHandler);
    this.cleanupFuncs.push(() => {
      window.removeEventListener("vm:socket_connect", this.connectHandler);
      window.removeEventListener("vm:socket_disconnect", this.disconnectHandler);
      window.removeEventListener("vm:grab_start", this.grabStartHandler);
      window.removeEventListener("vm:task_complete", this.taskCompleteHandler);
    });
  }

  update(): void {
    if (this.debounceDeadline === null) return;
    if (performance.now() < this.debounceDeadline) return;
    this.debounceDeadline = null;
    this.captureSnapshot("stable_dwell");
  }

  private scheduleCapture(): void {
    this.debounceDeadline = performance.now() + STABILITY_DEBOUNCE_MS;
  }

  private forceCapture(): void {
    this.debounceDeadline = null;
    this.captureSnapshot("task_complete");
  }

  private classify(entity: Entity): ComponentKind {
    if (this.queries.batteries.entities.has(entity)) return "battery";
    if (this.queries.leds.entities.has(entity)) return "led";
    if (this.queries.resistors.entities.has(entity)) return "resistor";
    if (this.queries.wires.entities.has(entity)) return "wire";
    return "unknown";
  }

  private captureSnapshot(triggerReason: TriggerReason): void {
    const placements: Placement[] = [];
    for (const entity of this.queries.snappables.entities) {
      const a = entity.getValue(Snappable, "leadASocket")!;
      const b = entity.getValue(Snappable, "leadBSocket")!;
      if (a < 0 && b < 0) continue;
      placements.push({
        id: entity.index,
        kind: this.classify(entity),
        socketA: a,
        socketB: b,
      });
    }
    if (placements.length === 0) return;

    const canonical = canonicalize(placements);
    const last = history[history.length - 1];
    if (last && last.canonical === canonical) return;

    snapshotCounter += 1;
    const snapshot: AttemptSnapshot = {
      index: snapshotCounter,
      placements,
      canonical,
    };
    history.push(snapshot);
    while (history.length > HISTORY_LENGTH) history.shift();

    this.redraw();
    if (!this.panelMesh.visible) this.panelMesh.visible = true;

    telemetry.log("attempt_snapshot_captured", {
      snapshot_index: snapshotCounter - 1,
      slot_count_after: history.length,
      trigger_reason: triggerReason,
      placement_count: placements.length,
      placements: placements.map((p) => ({
        id: p.id,
        kind: p.kind,
        a: p.socketA,
        b: p.socketB,
      })),
    });
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = `rgba(20, 26, 38, ${PANEL_BG_ALPHA})`;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLOR_BORDER_SUBTLE;
    ctx.strokeRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1);

    const boardIter = this.queries.board.entities.values().next();
    if (boardIter.done) {
      this.texture.needsUpdate = true;
      return;
    }
    const board = boardIter.value;
    const cols = board.getValue(SocketGrid, "cols")!;
    const rowsPerHalf = board.getValue(SocketGrid, "rowsPerHalf")!;
    const totalRows = 2 + 2 * rowsPerHalf;

    const slotPadX = (SLOT_PX_W * 0.06) | 0;
    const slotPadY = (SLOT_PX_H * 0.1) | 0;

    for (let i = 0; i < HISTORY_LENGTH; i++) {
      const ox = i * SLOT_PX_W + slotPadX;
      const slotInnerW = SLOT_PX_W - slotPadX * 2;
      const slotInnerH = SLOT_PX_H - slotPadY * 2;

      ctx.strokeStyle = COLOR_BORDER_SUBTLE;
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + 0.5, slotPadY + 0.5, slotInnerW - 1, slotInnerH - 1);
      ctx.beginPath();
      ctx.moveTo(ox, slotPadY + slotInnerH / 2);
      ctx.lineTo(ox + slotInnerW, slotPadY + slotInnerH / 2);
      ctx.stroke();

      const snap = history[i];
      if (!snap) continue;
      const cellW = slotInnerW / cols;
      const cellH = slotInnerH / totalRows;

      ctx.fillStyle = COLOR_TEXT_MUTED;
      ctx.strokeStyle = COLOR_TEXT_MUTED;
      for (const p of snap.placements) {
        this.drawPlacement(p, ox, slotPadY, cellW, cellH, cols);
      }
    }

    this.texture.needsUpdate = true;
  }

  private drawPlacement(
    p: Placement,
    ox: number,
    oy: number,
    cellW: number,
    cellH: number,
    cols: number,
  ): void {
    const ctx = this.ctx;
    const ax = ox + (p.socketA % cols) * cellW + cellW / 2;
    const ay = oy + Math.floor(p.socketA / cols) * cellH + cellH / 2;
    const bx = ox + (p.socketB % cols) * cellW + cellW / 2;
    const by = oy + Math.floor(p.socketB / cols) * cellH + cellH / 2;
    const r = Math.max(1, Math.min(cellW, cellH) * 0.42);

    if (p.kind === "wire") {
      ctx.lineWidth = Math.max(1, cellH * 0.18);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      return;
    }

    this.drawShapeAt(p.kind, ax, ay, r);
    this.drawShapeAt(p.kind, bx, by, r);
  }

  private drawShapeAt(
    kind: ComponentKind,
    x: number,
    y: number,
    r: number,
  ): void {
    const ctx = this.ctx;
    if (kind === "battery") {
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    } else if (kind === "led") {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "resistor") {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, r * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
