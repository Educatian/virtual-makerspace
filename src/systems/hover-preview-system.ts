import {
  createSystem,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Transform,
  type Object3D,
} from "@iwsdk/core";

import { SocketGrid } from "../components/socket-grid.js";
import { Snappable, SnapTarget } from "../components/snap.js";
import { telemetry } from "../telemetry.js";
import { findBestSnap } from "./snap-helpers.js";

interface PointerHandlers {
  obj: Object3D;
  down: () => void;
  up: () => void;
}

const NO_INTENT = 0;

function intentKey(socketA: number, socketB: number): number {
  return (socketA + 1) * 100000 + (socketB + 1);
}

export class HoverPreviewSystem extends createSystem({
  snappables: { required: [Snappable] },
  snapTargets: { required: [SnapTarget, SocketGrid, Transform] },
}) {
  private heldEntities = new Set<number>();
  private highlightA!: Mesh;
  private highlightB!: Mesh;
  private currentIntent = new Map<number, number>();
  private handlers = new Map<number, PointerHandlers>();

  init() {
    const geo = new SphereGeometry(0.012, 14, 10);
    const mat = new MeshBasicMaterial({
      color: 0x00ff66,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    this.highlightA = new Mesh(geo, mat);
    this.highlightB = new Mesh(geo, mat);
    this.highlightA.visible = false;
    this.highlightB.visible = false;
    this.world.createTransformEntity(this.highlightA, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    this.world.createTransformEntity(this.highlightB, {
      parent: this.world.sceneEntity,
      persistent: true,
    });

    this.queries.snappables.subscribe("qualify", (entity) => {
      const obj = entity.object3D;
      if (!obj) return;
      const onDown = () => {
        this.heldEntities.add(entity.index);
      };
      const onUp = () => {
        this.heldEntities.delete(entity.index);
        if (this.currentIntent.has(entity.index)) {
          telemetry.log("hover_target_clear", { entity_id: entity.index });
          this.currentIntent.delete(entity.index);
        }
      };
      obj.addEventListener("pointerdown", onDown);
      obj.addEventListener("pointerup", onUp);
      this.handlers.set(entity.index, { obj, down: onDown, up: onUp });
    });
    this.queries.snappables.subscribe("disqualify", (entity) => {
      const h = this.handlers.get(entity.index);
      if (h) {
        h.obj.removeEventListener("pointerdown", h.down);
        h.obj.removeEventListener("pointerup", h.up);
        this.handlers.delete(entity.index);
      }
      this.heldEntities.delete(entity.index);
      this.currentIntent.delete(entity.index);
    });
  }

  update(): void {
    let shown = false;
    for (const entity of this.queries.snappables.entities) {
      if (!this.heldEntities.has(entity.index)) continue;
      const result = findBestSnap(entity, this.queries.snapTargets.entities);
      const key = result ? intentKey(result.socketA, result.socketB) : NO_INTENT;
      const prev = this.currentIntent.get(entity.index) ?? NO_INTENT;
      if (key !== prev) {
        if (key !== NO_INTENT) {
          telemetry.log("hover_target", {
            entity_id: entity.index,
            socket_a: result!.socketA,
            socket_b: result!.socketB,
          });
          this.currentIntent.set(entity.index, key);
        } else {
          telemetry.log("hover_target_clear", { entity_id: entity.index });
          this.currentIntent.delete(entity.index);
        }
      }
      if (result) {
        this.highlightA.position.copy(result.socketAWorld);
        this.highlightB.position.copy(result.socketBWorld);
        this.highlightA.visible = true;
        this.highlightB.visible = true;
        shown = true;
        break;
      }
    }
    if (!shown) {
      this.highlightA.visible = false;
      this.highlightB.visible = false;
    }
  }
}
