import {
  createSystem,
  Object3D,
  Raycaster,
  Types,
  Vector3,
  type Entity,
} from "@iwsdk/core";

import { GazeTarget } from "../components/gaze-target.js";
import { telemetry } from "../telemetry.js";

interface GazeMeta {
  index: number;
  name: string;
}

export class GazeSystem extends createSystem(
  {
    targets: { required: [GazeTarget] },
  },
  {
    sampleIntervalMs: { type: Types.Float32, default: 200 },
    logSamples: { type: Types.Boolean, default: false },
    maxDistance: { type: Types.Float32, default: 5 },
  },
) {
  private raycaster!: Raycaster;
  private origin!: Vector3;
  private direction!: Vector3;
  private gazeMeta = new WeakMap<Object3D, GazeMeta>();
  private targetRoots: Object3D[] = [];
  private currentIndex: number | null = null;
  private currentName = "";
  private gazeStartMs = 0;
  private lastSampleMs = 0;

  init() {
    this.raycaster = new Raycaster();
    this.raycaster.far = this.config.maxDistance.peek();
    this.origin = new Vector3();
    this.direction = new Vector3();

    this.cleanupFuncs.push(
      this.config.maxDistance.subscribe((v) => {
        this.raycaster.far = v;
      }),
    );

    this.queries.targets.subscribe("qualify", (entity) => {
      this.registerTarget(entity);
    });
    this.queries.targets.subscribe("disqualify", (entity) => {
      const obj = entity.object3D;
      if (!obj) return;
      this.gazeMeta.delete(obj);
      const i = this.targetRoots.indexOf(obj);
      if (i >= 0) this.targetRoots.splice(i, 1);
      if (this.currentIndex === entity.index) {
        this.endCurrentGaze("target_removed");
      }
    });

    for (const entity of this.queries.targets.entities) {
      this.registerTarget(entity);
    }
  }

  private registerTarget(entity: Entity): void {
    const obj = entity.object3D;
    if (!obj) return;
    const name =
      (entity.getValue(GazeTarget, "name") as string) ||
      `entity_${entity.index}`;
    this.gazeMeta.set(obj, { index: entity.index, name });
    if (this.targetRoots.indexOf(obj) < 0) this.targetRoots.push(obj);
  }

  update(): void {
    const nowMs = performance.now();
    const interval = this.config.sampleIntervalMs.peek();
    if (nowMs - this.lastSampleMs < interval) return;
    this.lastSampleMs = nowMs;

    this.player.head.getWorldPosition(this.origin);
    this.player.head.getWorldDirection(this.direction);
    this.raycaster.set(this.origin, this.direction);

    let hitIndex: number | null = null;
    let hitName = "";
    let hitDistance = 0;

    if (this.targetRoots.length > 0) {
      const hits = this.raycaster.intersectObjects(this.targetRoots, true);
      for (const hit of hits) {
        let cur: Object3D | null = hit.object;
        let meta: GazeMeta | undefined;
        while (cur) {
          meta = this.gazeMeta.get(cur);
          if (meta) break;
          cur = cur.parent;
        }
        if (meta) {
          hitIndex = meta.index;
          hitName = meta.name;
          hitDistance = hit.distance;
          break;
        }
      }
    }

    if (hitIndex !== this.currentIndex) {
      if (this.currentIndex !== null) {
        telemetry.log("gaze_leave", {
          name: this.currentName,
          entity_index: this.currentIndex,
          dwell_ms: Math.round(nowMs - this.gazeStartMs),
        });
      }
      if (hitIndex !== null) {
        telemetry.log("gaze_enter", {
          name: hitName,
          entity_index: hitIndex,
          distance_m: Math.round(hitDistance * 1000) / 1000,
        });
        this.gazeStartMs = nowMs;
      }
      this.currentIndex = hitIndex;
      this.currentName = hitName;
    }

    if (this.config.logSamples.peek()) {
      telemetry.log("gaze_sample", {
        origin: [
          Math.round(this.origin.x * 1000) / 1000,
          Math.round(this.origin.y * 1000) / 1000,
          Math.round(this.origin.z * 1000) / 1000,
        ],
        direction: [
          Math.round(this.direction.x * 10000) / 10000,
          Math.round(this.direction.y * 10000) / 10000,
          Math.round(this.direction.z * 10000) / 10000,
        ],
        target: this.currentName || null,
      });
    }
  }

  private endCurrentGaze(reason: string) {
    if (this.currentIndex === null) return;
    telemetry.log("gaze_leave", {
      name: this.currentName,
      entity_index: this.currentIndex,
      dwell_ms: Math.round(performance.now() - this.gazeStartMs),
      reason,
    });
    this.currentIndex = null;
    this.currentName = "";
  }
}
