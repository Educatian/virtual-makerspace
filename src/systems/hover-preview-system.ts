import {
  createSystem,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Transform,
} from "@iwsdk/core";

import { SocketGrid } from "../components/socket-grid.js";
import { Snappable, SnapTarget } from "../components/snap.js";
import { findBestSnap } from "./snap-helpers.js";

const MAX_HELD = 2;

export class HoverPreviewSystem extends createSystem({
  snappables: { required: [Snappable] },
  snapTargets: { required: [SnapTarget, SocketGrid, Transform] },
}) {
  private heldEntities = new Set<number>();
  private markersA: Mesh[] = [];
  private markersB: Mesh[] = [];

  init() {
    const geo = new SphereGeometry(0.012, 14, 10);
    const mat = new MeshBasicMaterial({
      color: 0x00ff66,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    for (let i = 0; i < MAX_HELD; i++) {
      const a = new Mesh(geo, mat);
      const b = new Mesh(geo, mat);
      a.visible = false;
      b.visible = false;
      this.world.createTransformEntity(a);
      this.world.createTransformEntity(b);
      this.markersA.push(a);
      this.markersB.push(b);
    }

    this.queries.snappables.subscribe("qualify", (entity) => {
      const obj = entity.object3D;
      if (!obj) return;
      obj.addEventListener("pointerdown", () => {
        this.heldEntities.add(entity.index);
      });
      obj.addEventListener("pointerup", () => {
        this.heldEntities.delete(entity.index);
      });
    });
  }

  update(): void {
    let slot = 0;
    for (const entity of this.queries.snappables.entities) {
      if (slot >= MAX_HELD) break;
      if (!this.heldEntities.has(entity.index)) continue;
      const result = findBestSnap(entity, this.queries.snapTargets.entities);
      if (result) {
        // findBestSnap returns module-scoped vectors; copy out before next call.
        this.markersA[slot].position.copy(result.socketAWorld);
        this.markersB[slot].position.copy(result.socketBWorld);
        this.markersA[slot].visible = true;
        this.markersB[slot].visible = true;
        slot++;
      }
    }
    for (let i = slot; i < MAX_HELD; i++) {
      this.markersA[i].visible = false;
      this.markersB[i].visible = false;
    }
  }
}
