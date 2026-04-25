import { createComponent, Types } from "@iwsdk/core";

export const Snappable = createComponent("Snappable", {
  leadAOffset: { type: Types.Vec3, default: [-0.012, -0.036, 0] },
  leadBOffset: { type: Types.Vec3, default: [0.012, -0.036, 0] },
  leadASocket: { type: Types.Int32, default: -1 },
  leadBSocket: { type: Types.Int32, default: -1 },
  snapThreshold: { type: Types.Float32, default: 0.027 },
  spawnPos: { type: Types.Vec3, default: [0, 0, 0] },
});

export const SnapTarget = createComponent("SnapTarget", {});
