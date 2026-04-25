import { createComponent, Types } from "@iwsdk/core";

export const IdleCharacter = createComponent("IdleCharacter", {
  centerX: { type: Types.Float32, default: 0 },
  centerY: { type: Types.Float32, default: 0 },
  centerZ: { type: Types.Float32, default: 0 },
  radius: { type: Types.Float32, default: 0.5 },
  walkSpeed: { type: Types.Float32, default: 0.25 },
  bobAmplitude: { type: Types.Float32, default: 0.04 },
  bobFrequency: { type: Types.Float32, default: 4.0 },
});
