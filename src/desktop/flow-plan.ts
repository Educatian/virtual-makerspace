/**
 * What the Circuit Bench's optional flow view draws, from the DC solve: arrows on jumper wires
 * whose solved current is large enough to draw, the wires whose current is real but smaller than
 * that, and otherwise the reason nothing is drawn. Pure (no scene), so it is tested directly.
 */
import { formatAmps } from "../circuit/dc-engine.ts";

/** Below this the view draws no arrows (it says so; it never calls the current zero). */
export const FLOW_DRAW_MIN_AMPS = 1e-4;
/** Below this a solved current is numerical noise: no current. */
const FLOW_NOISE_AMPS = 1e-9;

export interface FlowReading {
  connected?: boolean;
  amps: number;
}

export interface FlowPlan {
  reason: string;
  wires: Array<{ id: string; amps: number; direction: 1 | -1; speed: number }>;
  /** Wires carrying a real current too small to draw. */
  small: Array<{ id: string; amps: number }>;
}

export function planFlow(
  result: { status: string; elements: Record<string, FlowReading | undefined> } | null,
  short: boolean,
  wireIds: readonly string[],
): FlowPlan {
  const plan: FlowPlan = { reason: "", wires: [], small: [] };
  if (!result) return { ...plan, reason: "not solved yet" };
  const status = result.status;
  if (short || status === "short-circuit") return { ...plan, reason: "short circuit" };
  if (status === "open-circuit") return { ...plan, reason: "open circuit" };
  if (status === "no-source") return { ...plan, reason: "no supply in the circuit" };
  if (status !== "ok" && status !== "unsafe") return { ...plan, reason: "the circuit could not be solved" };
  for (const id of wireIds) {
    const reading = result.elements[id];
    if (!reading?.connected || !Number.isFinite(reading.amps)) continue;
    const magnitude = Math.abs(reading.amps);
    if (magnitude < FLOW_NOISE_AMPS) continue;
    if (magnitude < FLOW_DRAW_MIN_AMPS) {
      plan.small.push({ id, amps: reading.amps });
      continue;
    }
    const speed = Math.min(0.5, Math.max(0.12, 0.12 + 0.1 * Math.log10(magnitude / FLOW_DRAW_MIN_AMPS)));
    plan.wires.push({ id, amps: reading.amps, direction: reading.amps > 0 ? 1 : -1, speed });
  }
  plan.reason = plan.wires.length
    ? "solved"
    : plan.small.length
      ? `the solved current is below ${formatAmps(FLOW_DRAW_MIN_AMPS)}, too small to draw (not zero)`
      : "no current through any jumper wire";
  return plan;
}
