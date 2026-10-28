import type { GhRig, GhSnapshot, PlantState, PumpState } from "./greenhouse-model.js";

export type RunStatus = "idle" | "running" | "paused" | "ended";
export interface CompactRecord {
  k: number; air: number; outside: number; sun: number; tank: number; battery: number; solarW: number; loadW: number;
  pump: PumpState; fan: "off" | "running" | "starved"; reading: number | null;
  beds: { A: { theta: number; in: number; et: number; drainage: number; state: PlantState }; B: { theta: number; in: number; et: number; drainage: number; state: PlantState } };
}
export interface GhRun { v: 1; runId: number; seed: number; status: RunStatus; speed: 1 | 4; tick: number; anchorAt: number; snapshot: GhSnapshot; records: CompactRecord[] }
export type GhAction = { type: "start" } | { type: "pause" } | { type: "resume" } | { type: "step" } | { type: "speed"; speed: 1 | 4 } | { type: "reset"; seed?: number };
export const STEP_MS: number;
export const SPEEDS: Array<1 | 4>;
export function initialRun(seed?: number): GhRun;
export function currentTick(run: GhRun, now: number): number;
export function compactRecord(record: unknown): CompactRecord;
export function settle(run: GhRun, now: number, rig: GhRig): GhRun;
export function reduceGreenhouseRun(run: GhRun, action: GhAction, now: number, rig: GhRig): { ok: true; run: GhRun } | { ok: false; reason: string };
export function onGreenhouseRoomEmpty(run: GhRun, now: number, rig: GhRig): GhRun | null;
export function rigLocked(run: GhRun, now: number): boolean;
export function sanitizeGreenhouseRun(value: unknown): GhRun | null;
export function sanitizeGreenhouseAction(value: unknown): GhAction | null;
