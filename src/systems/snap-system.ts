import {
  createSystem,
  Transform,
  Vector3,
  type Entity,
} from "@iwsdk/core";

import { SocketGrid } from "../components/socket-grid.js";
import { Snappable, SnapTarget } from "../components/snap.js";
import { telemetry } from "../telemetry.js";
import {
  dispatchGrab,
  dispatchRelease,
  dispatchSnap,
} from "./network-sync-system.js";
import { findBestSnap } from "./snap-helpers.js";

export class SnapSystem extends createSystem({
  snappables: { required: [Snappable] },
  snapTargets: { required: [SnapTarget, SocketGrid, Transform] },
}) {
  private leadAOffsetVec!: Vector3;
  private dirVec!: Vector3;
  private grabStartTimes = new Map<number, number>();

  init() {
    this.leadAOffsetVec = new Vector3();
    this.dirVec = new Vector3();

    this.queries.snappables.subscribe("qualify", (entity) => {
      const obj = entity.object3D;
      if (!obj) return;

      const partId = obj.userData?.partId as string | undefined;
      const onPointerDown = () => {
        const wasA = entity.getValue(Snappable, "leadASocket")!;
        const wasB = entity.getValue(Snappable, "leadBSocket")!;
        if (wasA >= 0 || wasB >= 0) {
          telemetry.log("socket_disconnect", {
            entity_id: entity.index,
            part_id: partId,
            socket_a: wasA,
            socket_b: wasB,
          });
        }
        entity.setValue(Snappable, "leadASocket", -1);
        entity.setValue(Snappable, "leadBSocket", -1);
        this.grabStartTimes.set(entity.index, performance.now());
        telemetry.log("grab_start", {
          entity_id: entity.index,
          part_id: partId,
        });
        if (partId) dispatchGrab(partId);
      };
      const onPointerUp = () => {
        const startedAt = this.grabStartTimes.get(entity.index);
        const heldMs =
          startedAt !== undefined ? performance.now() - startedAt : 0;
        this.grabStartTimes.delete(entity.index);
        const snapped = this.tryToSnap(entity);
        telemetry.log("grab_end", {
          entity_id: entity.index,
          part_id: partId,
          held_duration_ms: heldMs,
          snapped,
        });
        if (!snapped && partId) dispatchRelease(partId);
      };

      obj.addEventListener("pointerdown", onPointerDown);
      obj.addEventListener("pointerup", onPointerUp);
    });
  }

  update(): void {}

  private tryToSnap(entity: Entity): boolean {
    const obj = entity.object3D;
    const partId = obj?.userData?.partId as string | undefined;
    const result = findBestSnap(entity, this.queries.snapTargets.entities);
    if (result) {
      this.snapTo(entity, result.socketAWorld, result.socketBWorld);
      entity.setValue(Snappable, "leadASocket", result.socketA);
      entity.setValue(Snappable, "leadBSocket", result.socketB);
      telemetry.log("socket_connect", {
        entity_id: entity.index,
        part_id: partId,
        socket_a: result.socketA,
        socket_b: result.socketB,
      });
      if (partId && obj) {
        dispatchSnap(
          partId,
          result.socketA,
          result.socketB,
          [obj.position.x, obj.position.y, obj.position.z],
          [
            obj.quaternion.x,
            obj.quaternion.y,
            obj.quaternion.z,
            obj.quaternion.w,
          ],
        );
      }
      return true;
    }
    this.returnToSpawn(entity);
    return false;
  }

  private snapTo(
    entity: Entity,
    socketAWorld: Vector3,
    socketBWorld: Vector3,
  ): void {
    const obj = entity.object3D!;
    this.dirVec.copy(socketBWorld).sub(socketAWorld).normalize();
    const angleY = Math.atan2(this.dirVec.z, this.dirVec.x);

    obj.rotation.set(0, angleY, 0);
    obj.updateMatrixWorld(true);

    const leadAOff = entity.getVectorView(Snappable, "leadAOffset");
    this.leadAOffsetVec
      .set(leadAOff[0], leadAOff[1], leadAOff[2])
      .applyEuler(obj.rotation);

    obj.position.copy(socketAWorld).sub(this.leadAOffsetVec);
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
