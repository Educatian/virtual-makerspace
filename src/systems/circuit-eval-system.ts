import {
  createSystem,
  Mesh,
  MeshStandardMaterial,
  Transform,
  type Entity,
} from "@iwsdk/core";

import {
  CircuitNode,
  LedState,
  PowerSource,
  WireEnds,
} from "../components/circuit.js";
import { Snappable, SnapTarget } from "../components/snap.js";
import { SocketGrid } from "../components/socket-grid.js";
import { markTaskComplete } from "../task-progress.js";
import { telemetry } from "../telemetry.js";
import { analyzeBoard, type BoardPart } from "../circuit/breadboard.ts";
import { SOLVER_VERSION } from "../circuit/dc-engine.ts";

/**
 * Which electrical model drives the XR LEDs.
 * - "legacy" (default): the original net-union rule, unchanged — `lit` is true when an LED's two
 *   nets match the battery's, in either polarity, with resistors treated as joins. Experimental
 *   scoring (`led_state_change`, `markTaskComplete`) keeps exactly these semantics.
 * - "dc" (opt in with `?circuitModel=dc`): LED glow and task completion follow the shared DC
 *   engine — polarity-aware, current-limited, overcurrent is not success.
 * In both modes the DC result is logged alongside as `circuit_dc_eval` with the solver version,
 * so analyses can compare the two without either silently replacing the other.
 */
export type CircuitModel = "legacy" | "dc";
export function circuitModelFromUrl(search = typeof location === "undefined" ? "" : location.search): CircuitModel {
  return new URLSearchParams(search).get("circuitModel") === "dc" ? "dc" : "legacy";
}

function socketToNet(
  socketIdx: number,
  cols: number,
  rowsPerHalf: number,
): number {
  const totalRows = 2 + 2 * rowsPerHalf;
  const row = Math.floor(socketIdx / cols);
  const col = socketIdx % cols;
  if (row === 0) return 0;
  if (row === totalRows - 1) return 1;
  if (row <= rowsPerHalf) return 2 + col;
  return 2 + cols + col;
}

function getLeadNets(
  entity: Entity,
  cols: number,
  rowsPerHalf: number,
): [number, number] | null {
  const sa = entity.getValue(Snappable, "leadASocket")!;
  const sb = entity.getValue(Snappable, "leadBSocket")!;
  if (sa < 0 || sb < 0) return null;
  return [
    socketToNet(sa, cols, rowsPerHalf),
    socketToNet(sb, cols, rowsPerHalf),
  ];
}

export class CircuitEvalSystem extends createSystem({
  resistors: {
    required: [Snappable, CircuitNode],
    excluded: [LedState, PowerSource],
  },
  wires: { required: [Snappable, WireEnds] },
  leds: { required: [Snappable, CircuitNode, LedState] },
  batteries: { required: [Snappable, CircuitNode, PowerSource] },
  targets: { required: [SnapTarget, SocketGrid, Transform] },
}) {
  private ledMaterials = new Map<number, MeshStandardMaterial>();
  private parent: Int32Array | null = null;
  private model: CircuitModel = "legacy";
  /** Hash of every lead's sockets; the DC engine reruns only when it changes. */
  private dcSignature = -1;
  private hash = 0;
  private dcStates = new Map<number, string>();
  private dcLit = new Map<number, boolean>();
  private dcBrightness = new Map<number, number>();

  init() {
    this.model = circuitModelFromUrl();
    this.queries.leds.subscribe("qualify", (entity) => {
      const obj = entity.object3D;
      if (!obj) return;
      const body = obj.getObjectByName("led-body");
      if (body && body instanceof Mesh) {
        const mat = body.material;
        if (mat instanceof MeshStandardMaterial) {
          this.ledMaterials.set(entity.index, mat);
        }
      }
    });
    this.queries.leds.subscribe("disqualify", (entity) => {
      this.ledMaterials.delete(entity.index);
    });
  }

  private mix(value: number): void {
    this.hash ^= value + 0x9e3779b9;
    this.hash = Math.imul(this.hash, 16777619);
  }

  private mixEntity(entity: Entity): void {
    this.mix(entity.index);
    this.mix(entity.getValue(Snappable, "leadASocket")!);
    this.mix(entity.getValue(Snappable, "leadBSocket")!);
  }

  /** Fingerprint of all lead sockets (no arrays or closures; only the query iterators the legacy loop already uses). */
  private signature(): number {
    this.hash = 2166136261;
    for (const entity of this.queries.wires.entities) this.mixEntity(entity);
    this.mix(-1);
    for (const entity of this.queries.resistors.entities) this.mixEntity(entity);
    this.mix(-2);
    for (const entity of this.queries.leds.entities) this.mixEntity(entity);
    this.mix(-3);
    for (const entity of this.queries.batteries.entities) this.mixEntity(entity);
    return this.hash >>> 0;
  }

  /** Runs the shared DC engine on the XR board; called only when the placement changes. */
  private evaluateDc(cols: number, rowsPerHalf: number): void {
    const parts: BoardPart[] = [];
    const sockets = (entity: Entity): [number | null, number | null] => {
      const a = entity.getValue(Snappable, "leadASocket")!;
      const b = entity.getValue(Snappable, "leadBSocket")!;
      return [a >= 0 ? a : null, b >= 0 ? b : null];
    };
    for (const wire of this.queries.wires.entities) parts.push({ id: `wire-${wire.index}`, kind: "wire", sockets: sockets(wire) });
    for (const r of this.queries.resistors.entities) {
      const ohms = r.getValue(CircuitNode, "ohms") || 220;
      parts.push({ id: `resistor-${r.index}`, kind: "resistor", ohms, sockets: sockets(r) });
    }
    for (const led of this.queries.leds.entities) {
      const vf = led.getValue(CircuitNode, "forwardVolts") || 1.9;
      parts.push({ id: `led-${led.index}`, kind: "led", color: vf > 2 ? "green" : "red", sockets: sockets(led) });
    }
    for (const battery of this.queries.batteries.entities) {
      parts.push({ id: `battery-${battery.index}`, kind: "battery", volts: battery.getValue(PowerSource, "voltage") || 9, sockets: sockets(battery) });
    }
    const analysis = analyzeBoard(parts, { cols, rowsPerHalf });
    for (const led of this.queries.leds.entities) {
      const reading = analysis.result.elements[`led-${led.index}`]?.led;
      const lit = reading?.state === "lit" && analysis.success;
      const previous = this.dcLit.get(led.index) ?? false;
      this.dcLit.set(led.index, lit);
      this.dcBrightness.set(led.index, reading?.on && reading.state !== "burnout" ? Math.max(0.12, reading.brightness) : 0);
      const amps = analysis.result.elements[`led-${led.index}`]?.amps ?? 0;
      const dcState = reading?.state ?? "unplaced";
      const previousState = this.dcStates.get(led.index);
      this.dcStates.set(led.index, dcState);
      // Log when this LED's DC state changes (not for every unrelated placement change).
      if (dcState !== previousState || (lit !== previous)) {
        telemetry.log("circuit_dc_eval", {
          solver_version: SOLVER_VERSION,
          circuit_model: this.model,
          entity_id: led.index,
          dc_state: dcState,
          dc_lit: lit,
          current_ma: Math.round(amps * 1e4) / 10,
          status: analysis.result.status,
        });
      }
      if (this.model === "dc" && lit && !previous) markTaskComplete();
    }
  }

  update(): void {
    const targetIter = this.queries.targets.entities.values().next();
    if (targetIter.done) return;
    const board = targetIter.value as Entity;
    const cols = board.getValue(SocketGrid, "cols")!;
    const rowsPerHalf = board.getValue(SocketGrid, "rowsPerHalf")!;
    const signature = this.signature();
    if (signature !== this.dcSignature) {
      this.dcSignature = signature;
      this.evaluateDc(cols, rowsPerHalf);
    }
    const totalNets = 2 + 2 * cols;

    if (!this.parent || this.parent.length !== totalNets) {
      this.parent = new Int32Array(totalNets);
    }
    const parent = this.parent;
    for (let i = 0; i < totalNets; i++) parent[i] = i;

    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    for (const wire of this.queries.wires.entities) {
      const nets = getLeadNets(wire, cols, rowsPerHalf);
      if (nets) union(nets[0], nets[1]);
    }
    for (const r of this.queries.resistors.entities) {
      const nets = getLeadNets(r, cols, rowsPerHalf);
      if (nets) union(nets[0], nets[1]);
    }

    for (const led of this.queries.leds.entities) {
      const ledNets = getLeadNets(led, cols, rowsPerHalf);
      let lit = false;
      if (ledNets) {
        const ledA = find(ledNets[0]);
        const ledB = find(ledNets[1]);
        for (const battery of this.queries.batteries.entities) {
          const battNets = getLeadNets(battery, cols, rowsPerHalf);
          if (!battNets) continue;
          const posNet = find(battNets[0]);
          const negNet = find(battNets[1]);
          if (
            (posNet === ledA && negNet === ledB) ||
            (posNet === ledB && negNet === ledA)
          ) {
            lit = true;
            break;
          }
        }
      }
      // Legacy fields and semantics are preserved as-is; the DC result rides along.
      const wasLit = led.getValue(LedState, "lit")!;
      if (lit !== wasLit) {
        led.setValue(LedState, "lit", lit);
        telemetry.log("led_state_change", {
          entity_id: led.index,
          lit,
          circuit_model: this.model,
          solver_version: SOLVER_VERSION,
          dc_lit: this.dcLit.get(led.index) ?? false,
        });
        if (lit && this.model === "legacy") markTaskComplete();
      }
      const mat = this.ledMaterials.get(led.index);
      if (mat) {
        mat.emissiveIntensity = this.model === "dc"
          ? (this.dcBrightness.get(led.index) ?? 0) * 1.8
          : lit ? 1.8 : 0;
      }
    }
  }
}
