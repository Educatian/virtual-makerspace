import {
  createSystem,
  Transform,
  Vector3,
  type Entity,
  type Object3D,
} from "@iwsdk/core";

import { SocketGrid } from "../components/socket-grid.js";
import { Snappable, SnapTarget } from "../components/snap.js";
import { emitCircuitTopology, markTaskStart } from "../task-progress.js";
import { telemetry } from "../telemetry.js";
import {
  findBestSnap,
  findNearestCandidate,
  type SnapResult,
} from "./snap-helpers.js";
import { showSnapFailMarkers } from "./snap-fail-feedback-system.js";

interface PointerHandlers {
  obj: Object3D;
  down: () => void;
  up: () => void;
}

export class SnapSystem extends createSystem({
  snappables: { required: [Snappable] },
  snapTargets: { required: [SnapTarget, SocketGrid, Transform] },
}) {
  private leadAOffsetVec!: Vector3;
  private dirVec!: Vector3;
  private grabStartTimes = new Map<number, number>();
  private handlers = new Map<number, PointerHandlers>();

  init() {
    this.leadAOffsetVec = new Vector3();
    this.dirVec = new Vector3();

    this.queries.snappables.subscribe("qualify", (entity) => {
      this.attachHandlers(entity);
    });
    this.queries.snappables.subscribe("disqualify", (entity) => {
      this.detachHandlers(entity.index);
    });
  }

  update(): void {}

  private attachHandlers(entity: Entity): void {
    const obj = entity.object3D;
    if (!obj) return;

    const onPointerDown = () => {
      markTaskStart();
      const wasA = entity.getValue(Snappable, "leadASocket")!;
      const wasB = entity.getValue(Snappable, "leadBSocket")!;
      const wasSnapped = wasA >= 0 || wasB >= 0;
      if (wasSnapped) {
        telemetry.log("socket_disconnect", {
          entity_id: entity.index,
          socket_a: wasA,
          socket_b: wasB,
        });
        window.dispatchEvent(
          new CustomEvent("vm:socket_disconnect", {
            detail: { entity_id: entity.index, socket_a: wasA, socket_b: wasB },
          }),
        );
        window.dispatchEvent(
          new CustomEvent("vm:regrab_detected", {
            detail: { entity_id: entity.index },
          }),
        );
      }
      entity.setValue(Snappable, "leadASocket", -1);
      entity.setValue(Snappable, "leadBSocket", -1);
      this.grabStartTimes.set(entity.index, performance.now());
      telemetry.log("grab_start", { entity_id: entity.index });
      window.dispatchEvent(
        new CustomEvent("vm:grab_start", {
          detail: { entity_id: entity.index },
        }),
      );
      if (wasSnapped) {
        emitCircuitTopology(this.queries.snappables.entities);
      }
    };

    const onPointerUp = () => {
      const startedAt = this.grabStartTimes.get(entity.index);
      const heldMs =
        startedAt !== undefined ? performance.now() - startedAt : 0;
      this.grabStartTimes.delete(entity.index);

      const result = findBestSnap(entity, this.queries.snapTargets.entities);
      const snapped = result !== null;
      let nearMissPayload: Record<string, number> | null = null;
      if (!snapped) {
        const nm = findNearestCandidate(
          entity,
          this.queries.snapTargets.entities,
        );
        if (nm) {
          nearMissPayload = {
            socket_a: nm.socketA,
            socket_b: nm.socketB,
            dist_a_m: Math.round(nm.distA * 10000) / 10000,
            dist_b_m: Math.round(nm.distB * 10000) / 10000,
            threshold_m: Math.round(nm.threshold * 10000) / 10000,
          };
          showSnapFailMarkers(nm.socketAWorld, nm.socketBWorld, {
            entityId: entity.index,
            socketA: nm.socketA,
            socketB: nm.socketB,
            distA: nm.distA,
            distB: nm.distB,
          });
        }
      }

      if (snapped) {
        this.applySnap(entity, result!);
      } else {
        this.returnToSpawn(entity);
      }

      telemetry.log("grab_end", {
        entity_id: entity.index,
        held_duration_ms: heldMs,
        snapped,
        near_miss: nearMissPayload,
      });
      if (snapped) {
        emitCircuitTopology(this.queries.snappables.entities);
      }
    };

    obj.addEventListener("pointerdown", onPointerDown);
    obj.addEventListener("pointerup", onPointerUp);
    this.handlers.set(entity.index, { obj, down: onPointerDown, up: onPointerUp });
  }

  private detachHandlers(entityIndex: number): void {
    const h = this.handlers.get(entityIndex);
    if (!h) return;
    h.obj.removeEventListener("pointerdown", h.down);
    h.obj.removeEventListener("pointerup", h.up);
    this.handlers.delete(entityIndex);
    this.grabStartTimes.delete(entityIndex);
  }

  private applySnap(entity: Entity, result: SnapResult): void {
    this.snapTo(entity, result.socketAWorld, result.socketBWorld);
    entity.setValue(Snappable, "leadASocket", result.socketA);
    entity.setValue(Snappable, "leadBSocket", result.socketB);
    telemetry.log("socket_connect", {
      entity_id: entity.index,
      socket_a: result.socketA,
      socket_b: result.socketB,
    });
    window.dispatchEvent(
      new CustomEvent("vm:socket_connect", {
        detail: {
          entity_id: entity.index,
          socket_a: result.socketA,
          socket_b: result.socketB,
        },
      }),
    );
  }

  private snapTo(
    entity: Entity,
    socketAWorld: Vector3,
    socketBWorld: Vector3,
  ): void {
    const obj = entity.object3D!;
    this.dirVec.copy(socketBWorld).sub(socketAWorld).normalize();
    const angleY = Math.atan2(-this.dirVec.z, this.dirVec.x);

    obj.rotation.set(0, angleY, 0);
    obj.updateMatrixWorld(true);

    const leadAOff = entity.getVectorView(Snappable, "leadAOffset");
    this.leadAOffsetVec
      .set(leadAOff[0], leadAOff[1], leadAOff[2])
      .applyEuler(obj.rotation);

    obj.position.copy(socketAWorld).sub(this.leadAOffsetVec);
    obj.updateMatrixWorld(true);
  }

  private returnToSpawn(entity: Entity): void {
    const obj = entity.object3D;
    if (!obj) return;
    const spawn = entity.getVectorView(Snappable, "spawnPos");
    obj.position.set(spawn[0], spawn[1], spawn[2]);
    obj.rotation.set(0, 0, 0);
    obj.updateMatrixWorld(true);
  }
}
