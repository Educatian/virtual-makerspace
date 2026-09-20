import {
  createSystem,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from "@iwsdk/core";

import { telemetry } from "../telemetry.js";

const MARKER_DURATION_MS = 200;
const MARKER_COLOR = 0x9aa6bd;

let instance: SnapFailFeedbackSystem | null = null;

interface ShowPayload {
  entityId: number;
  socketA: number;
  socketB: number;
  distA: number;
  distB: number;
}

export function showSnapFailMarkers(
  socketAWorld: Vector3,
  socketBWorld: Vector3,
  payload: ShowPayload,
): void {
  instance?.show(socketAWorld, socketBWorld, payload);
}

export class SnapFailFeedbackSystem extends createSystem({}) {
  private markerA!: Mesh;
  private markerB!: Mesh;
  private hideAtMs = 0;
  private visible = false;

  init() {
    const geo = new SphereGeometry(0.012, 14, 10);
    const mat = new MeshBasicMaterial({
      color: MARKER_COLOR,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.markerA = new Mesh(geo, mat);
    this.markerB = new Mesh(geo, mat);
    this.markerA.visible = false;
    this.markerB.visible = false;
    this.world.createTransformEntity(this.markerA, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    this.world.createTransformEntity(this.markerB, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
    instance = this;
    this.cleanupFuncs.push(() => {
      if (instance === this) instance = null;
    });
  }

  show(
    socketAWorld: Vector3,
    socketBWorld: Vector3,
    payload: ShowPayload,
  ): void {
    this.markerA.position.copy(socketAWorld);
    this.markerB.position.copy(socketBWorld);
    this.markerA.visible = true;
    this.markerB.visible = true;
    this.visible = true;
    this.hideAtMs = performance.now() + MARKER_DURATION_MS;
    telemetry.log("near_miss_marker_shown", {
      entity_id: payload.entityId,
      socket_a: payload.socketA,
      socket_b: payload.socketB,
      dist_a_m: Math.round(payload.distA * 10000) / 10000,
      dist_b_m: Math.round(payload.distB * 10000) / 10000,
    });
  }

  update(): void {
    if (!this.visible) return;
    if (performance.now() >= this.hideAtMs) {
      this.markerA.visible = false;
      this.markerB.visible = false;
      this.visible = false;
    }
  }
}
