import { createComponent, Types } from "@iwsdk/core";

/**
 * Electrical values for the shared DC engine (src/circuit). 0 = unspecified; the legacy
 * evaluator ignores these fields, so existing XR scoring and telemetry are unchanged.
 */
export const CircuitNode = createComponent("CircuitNode", {
  /** Resistance in ohms for resistors. */
  ohms: { type: Types.Float32, default: 0 },
  /** LED forward voltage (red ≈ 1.9 V, green ≈ 2.1 V). */
  forwardVolts: { type: Types.Float32, default: 0 },
});

export const WireEnds = createComponent("WireEnds", {});

export const LedState = createComponent("LedState", {
  lit: { type: Types.Boolean, default: false },
});

export const PowerSource = createComponent("PowerSource", {
  voltage: { type: Types.Float32, default: 9.0 },
});
