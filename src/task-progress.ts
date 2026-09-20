import type { Entity } from "@iwsdk/core";

import { Snappable } from "./components/snap.js";
import { telemetry } from "./telemetry.js";

let taskStarted = false;
let taskCompleted = false;

export function markTaskStart(): void {
  if (taskStarted) return;
  taskStarted = true;
  telemetry.log("task_start", {});
  window.dispatchEvent(new CustomEvent("vm:task_start"));
}

export function markTaskComplete(): void {
  if (taskCompleted) return;
  taskCompleted = true;
  telemetry.log("task_complete", {});
  window.dispatchEvent(new CustomEvent("vm:task_complete"));
}

export function emitCircuitTopology(snappables: Iterable<Entity>): void {
  const placements: Array<{
    id: number;
    a: number;
    b: number;
  }> = [];
  for (const e of snappables) {
    const a = e.getValue(Snappable, "leadASocket")!;
    const b = e.getValue(Snappable, "leadBSocket")!;
    if (a >= 0 || b >= 0) placements.push({ id: e.index, a, b });
  }
  telemetry.log("circuit_topology", { placements });
}
