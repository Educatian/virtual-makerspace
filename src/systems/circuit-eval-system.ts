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
import { telemetry } from "../telemetry.js";

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
  private prevClosed = false;
  private prevLoopKey = "";
  private firstCloseLogged = false;
  private componentsInLoop: number[] = [];

  init() {
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

  update(): void {
    const targetIter = this.queries.targets.entities.values().next();
    if (targetIter.done) return;
    const board = targetIter.value as Entity;
    const cols = board.getValue(SocketGrid, "cols")!;
    const rowsPerHalf = board.getValue(SocketGrid, "rowsPerHalf")!;
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

    let anyLit = false;
    let firstLitLed = -1;
    this.componentsInLoop.length = 0;
    const componentsInLoop = this.componentsInLoop;
    for (const led of this.queries.leds.entities) {
      const ledNets = getLeadNets(led, cols, rowsPerHalf);
      let lit = false;
      let closingBatteryNet = -1;
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
            closingBatteryNet = posNet;
            break;
          }
        }
      }
      const wasLit = led.getValue(LedState, "lit")!;
      if (lit !== wasLit) {
        led.setValue(LedState, "lit", lit);
        telemetry.log("led_state_change", {
          entity_id: led.index,
          lit,
        });
      }
      const mat = this.ledMaterials.get(led.index);
      if (mat) mat.emissiveIntensity = lit ? 1.8 : 0;
      if (lit && firstLitLed < 0) {
        firstLitLed = led.index;
        componentsInLoop.push(led.index);
        const loopNet = closingBatteryNet;
        for (const w of this.queries.wires.entities) {
          const nets = getLeadNets(w, cols, rowsPerHalf);
          if (nets && (find(nets[0]) === loopNet || find(nets[1]) === loopNet)) {
            componentsInLoop.push(w.index);
          }
        }
        for (const r of this.queries.resistors.entities) {
          const nets = getLeadNets(r, cols, rowsPerHalf);
          if (nets && (find(nets[0]) === loopNet || find(nets[1]) === loopNet)) {
            componentsInLoop.push(r.index);
          }
        }
        for (const b of this.queries.batteries.entities) {
          const nets = getLeadNets(b, cols, rowsPerHalf);
          if (nets && (find(nets[0]) === loopNet || find(nets[1]) === loopNet)) {
            componentsInLoop.push(b.index);
          }
        }
      }
      if (lit) anyLit = true;
    }

    const loopKey = anyLit ? componentsInLoop.slice().sort().join(",") : "";
    if (anyLit !== this.prevClosed || loopKey !== this.prevLoopKey) {
      telemetry.log("circuit_state_change", {
        closed: anyLit,
        components_in_loop: anyLit ? componentsInLoop : [],
      });
      this.prevClosed = anyLit;
      this.prevLoopKey = loopKey;
    }
    if (anyLit && !this.firstCloseLogged) {
      this.firstCloseLogged = true;
      telemetry.log("circuit_closed_success", {
        led_entity_id: firstLitLed,
        time_to_close_ms: performance.now() - telemetry.sessionStartMs,
        components_in_loop: componentsInLoop,
      });
    }
  }
}
