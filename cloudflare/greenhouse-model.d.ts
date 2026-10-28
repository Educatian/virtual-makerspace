import type { GhControllerProps, GhManifoldProps } from "./greenhouse-rules.js";

export type GhLineStatus = "unplugged" | "loose" | "wrong-type" | "out-out" | "in-in" | "shared-port" | "supply" | "delivery" | "branch" | "no-pump" | "loop" | "charging" | "feed" | "unregulated" | "connected";
export interface GhLine { id: string; type: "water" | "power"; ends: [number | null, number | null]; from: number | null; to: number | null; status: GhLineStatus }
export interface GhFault { kind: string; line?: string; bed?: "A" | "B" }
export interface GhOutlet { bed: "A" | "B" | null; opening: number; from: number }
export interface GhRig {
  lines: GhLine[];
  supply: boolean;
  delivery: string | null;
  viaManifold: boolean;
  outlets: GhOutlet[];
  solar: boolean;
  pumpChannel: 1 | 2 | null;
  fanChannel: 1 | 2 | null;
  order: Array<"pump" | "fan">;
  probe: "A" | "B" | null;
  manifold: GhManifoldProps;
  controller: GhControllerProps;
  faults: GhFault[];
  complete: boolean;
}
export interface GhTotals { et: number; drainage: number; overflow: number; pumped: number; solarIn: number; used: number; curtailed: number }
export interface GhSnapshot {
  tick: number;
  tank: number;
  beds: { A: number; B: number };
  battery: number;
  air: number;
  totals: GhTotals;
  stress: { A: number; B: number; heat: number };
  start: { tank: number; beds: { A: number; B: number }; battery: number };
}
export type PlantState = "healthy" | "wilting" | "severe-wilt" | "waterlogged" | "heat-stressed";
export type PumpState = "off" | "running" | "starved" | "dry-no-supply" | "dead-headed" | "dry-tank-empty" | "tank-ran-out";
export interface GhBedStep { water: number; theta: number; in: number; et: number; drainage: number; overflow: number; state: PlantState }
export interface GhRecord {
  k: number; clock: string; outside: number; sun: number; air: number; tank: number; battery: number; solarW: number; loadW: number; curtailedWh: number;
  pump: PumpState; fan: "off" | "running" | "starved"; reading: number | null; beds: { A: GhBedStep; B: GhBedStep };
}
export interface GhWeather { seed: number; tMax: number; tMin: number; spells: Array<[number, number]>; outside: number[]; sun: number[] }
export interface GhCriterion { id: "G1" | "G2" | "G3" | "G4" | "G5"; pass: boolean; measured: string }

export const GH_MODEL: {
  steps: number; dtHours: number; startHour: number; tankLitres: number; bedCapacity: number; bedStart: number; batteryWh: number; batteryStart: number;
  solarW: number; pumpW: number; pumpLitresPerStep: number; fanW: number; greenhouseGain: number; fanCooling: number; uptake: { A: number; B: number };
  dryBelow: number; severeBelow: number; wetAbove: number; heatAbove: number; drainAbove: number; drainFraction: number; briefSeed: number; reserve: number; stressAllowance: number; heatAllowance: number;
};
export const GH_WORKED_EXAMPLE: { valveA: number; valveB: number; pumpBelow: number; fanAbove: number; pumpChannel: 1 | 2; probe: "A" | "B" };
export function hourAt(k: number): number;
export function clockAt(k: number): string;
export function isSeed(seed: unknown): boolean;
export function weatherFor(seed: number): GhWeather;
export function deriveRig(transformOf: (id: string) => { sockets?: unknown; props?: unknown } | null | undefined): GhRig;
export function initialSnapshot(seed: number): GhSnapshot;
export function stepModel(snapshot: GhSnapshot, rig: GhRig, weather: GhWeather): { snapshot: GhSnapshot; record: GhRecord | null };
export function simulate(snapshot: GhSnapshot, rig: GhRig, seed: number, toTick: number): { snapshot: GhSnapshot; records: GhRecord[] };
export function plantState(theta: number, air: number): PlantState;
export function balance(snapshot: GhSnapshot): { water: number; energy: number };
export function evaluateBrief(snapshot: GhSnapshot, rig: GhRig): { finished: boolean; met: boolean; criteria: GhCriterion[] };
