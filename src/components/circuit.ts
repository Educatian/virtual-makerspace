import { createComponent, Types } from "@iwsdk/core";

export const CircuitNode = createComponent("CircuitNode", {});

export const WireEnds = createComponent("WireEnds", {});

export const LedState = createComponent("LedState", {
  lit: { type: Types.Boolean, default: false },
});

export const PowerSource = createComponent("PowerSource", {
  voltage: { type: Types.Float32, default: 9.0 },
});
