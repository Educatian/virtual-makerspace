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

export class HoverPreviewSystem extends createSystem({
  snappables: { required: [Snappable] },
  snapTargets: { required: [SnapTarget, SocketGrid, Transform] },
}) {
  private heldEntities = new Set<number>();
  private highlightA!: Mesh;
  private highlightB!: Mesh;

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
    this.scene.add(this.highlightA);
    this.scene.add(this.highlightB);

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
    let shown = false;
    for (const entity of this.queries.snappables.entities) {
      if (!this.heldEntities.has(entity.index)) continue;
      const result = findBestSnap(entity, this.queries.snapTargets.entities);
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
