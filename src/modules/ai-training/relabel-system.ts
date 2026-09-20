import {
  createSystem,
  Transform,
  Vector3,
  type Entity,
  type Object3D,
} from "@iwsdk/core";

import { telemetry } from "../../telemetry.js";
import { ClassBin, DataPoint } from "./components.js";
import { BIN_DETECT_RADIUS, classOuterMaterials } from "./spawn.js";

interface PointerHandlers {
  obj: Object3D;
  down: () => void;
  up: () => void;
}

export class RelabelSystem extends createSystem({
  points: { required: [DataPoint] },
  bins: { required: [ClassBin, Transform] },
}) {
  private handlers = new Map<number, PointerHandlers>();
  private grabStartTimes = new Map<number, number>();
  private tmpPointPos!: Vector3;
  private tmpBinPos!: Vector3;

  init() {
    this.tmpPointPos = new Vector3();
    this.tmpBinPos = new Vector3();

    this.queries.points.subscribe("qualify", (entity) => {
      this.attach(entity);
    });
    this.queries.points.subscribe("disqualify", (entity) => {
      this.detach(entity.index);
    });
  }

  update(): void {}

  private attach(entity: Entity): void {
    const obj = entity.object3D;
    if (!obj) return;

    const onDown = () => {
      this.grabStartTimes.set(entity.index, performance.now());
      telemetry.log("point_grab", {
        point_id: entity.getValue(DataPoint, "pointId")!,
        current_class: entity.getValue(DataPoint, "currentClass")!,
        true_class: entity.getValue(DataPoint, "trueClass")!,
      });
    };

    const onUp = () => {
      const startedAt = this.grabStartTimes.get(entity.index);
      const heldMs =
        startedAt !== undefined ? performance.now() - startedAt : 0;
      this.grabStartTimes.delete(entity.index);

      const releasePos = obj.getWorldPosition(this.tmpPointPos);
      const targetBin = this.findBinAt(releasePos);

      const oldClass = entity.getValue(DataPoint, "currentClass")!;
      const trueClass = entity.getValue(DataPoint, "trueClass")!;
      const pointId = entity.getValue(DataPoint, "pointId")!;

      if (targetBin !== null && targetBin !== oldClass) {
        entity.setValue(DataPoint, "currentClass", targetBin);
        this.refreshOuterColor(entity, targetBin);
        const wasCorrect = targetBin === trueClass;
        telemetry.log("point_label_change", {
          point_id: pointId,
          old_class: oldClass,
          new_class: targetBin,
          true_class: trueClass,
          was_correct: wasCorrect,
          held_ms: Math.round(heldMs),
        });
        window.dispatchEvent(
          new CustomEvent("vm:point_label_change", {
            detail: {
              point_id: pointId,
              old_class: oldClass,
              new_class: targetBin,
              true_class: trueClass,
              was_correct: wasCorrect,
            },
          }),
        );
      } else {
        telemetry.log("point_grab_release_unchanged", {
          point_id: pointId,
          held_ms: Math.round(heldMs),
        });
      }

      this.returnHome(entity);
    };

    obj.addEventListener("pointerdown", onDown);
    obj.addEventListener("pointerup", onUp);
    this.handlers.set(entity.index, { obj, down: onDown, up: onUp });
  }

  private detach(entityIndex: number): void {
    const h = this.handlers.get(entityIndex);
    if (!h) return;
    h.obj.removeEventListener("pointerdown", h.down);
    h.obj.removeEventListener("pointerup", h.up);
    this.handlers.delete(entityIndex);
    this.grabStartTimes.delete(entityIndex);
  }

  private findBinAt(worldPos: Vector3): number | null {
    let best: number | null = null;
    let bestDist = BIN_DETECT_RADIUS;
    for (const bin of this.queries.bins.entities) {
      const obj = bin.object3D;
      if (!obj) continue;
      obj.getWorldPosition(this.tmpBinPos);
      const d = worldPos.distanceTo(this.tmpBinPos);
      if (d < bestDist) {
        bestDist = d;
        best = bin.getValue(ClassBin, "classId")!;
      }
    }
    return best;
  }

  private refreshOuterColor(entity: Entity, classId: number): void {
    const obj = entity.object3D;
    if (!obj) return;
    obj.traverse((child) => {
      if ((child as { name?: string }).name === "data-point-outer") {
        (child as unknown as { material: unknown }).material =
          classOuterMaterials[classId];
      }
    });
  }

  private returnHome(entity: Entity): void {
    const obj = entity.object3D;
    if (!obj) return;
    const x = entity.getValue(DataPoint, "homeX")!;
    const y = entity.getValue(DataPoint, "homeY")!;
    const z = entity.getValue(DataPoint, "homeZ")!;
    obj.position.set(x, y, z);
    obj.rotation.set(0, 0, 0);
    obj.updateMatrixWorld(true);
  }
}
