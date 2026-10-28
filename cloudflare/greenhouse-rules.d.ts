export type GhPortType = "water" | "power" | "probe";
export interface GhPort { index: number; key: string; module: string; role: "in" | "out"; type: GhPortType; label: string }
export interface GhManifoldProps { valveA: number; valveB: number }
export interface GhControllerProps { pumpBelow: number; fanAbove: number }
export type GhProps = Partial<GhManifoldProps & GhControllerProps>;
export type GhPropKind = "manifold" | "controller";
type Sockets = [number | null, number | null] | null | undefined;

export const GH_FIXTURE_IDS: string[];
export const GH_HOSE_IDS: string[];
export const GH_CABLE_IDS: string[];
export const GH_PROBE_ID: "soil-sensor";
export const GH_LINE_IDS: string[];
export const GH_IDS: string[];
export const GH_PORTS: GhPort[];
export const GH_PORT: Record<string, number>;
export const GH_PROBE_SLOTS: { A: [number, number]; B: [number, number] };
export const GH_BOUNDS: Record<"valveA" | "valveB" | "pumpBelow" | "fanAbove", { min: number; max: number; step: number }>;
export const GH_DEFAULT_PROPS: { "valve-manifold": GhManifoldProps; "farm-controller": GhControllerProps };
export const GH_FIXTURE_POSES: Record<string, [number, number, number]>;
export function isGreenhouseId(componentId: string): boolean;
export function isGreenhouseFixture(componentId: string): boolean;
export function isGreenhouseHose(componentId: string): boolean;
export function isGreenhouseCable(componentId: string): boolean;
export function isGreenhouseLine(componentId: string): boolean;
export function greenhousePropKind(componentId: string): GhPropKind | null;
export function lineType(componentId: string): "water" | "power" | null;
export function sanitizeGreenhouseProps(kind: GhPropKind | string | null | undefined, raw: unknown): GhProps | null;
export function sanitizeGreenhouseTransform<T>(componentId: string, raw: Record<string, unknown>, clean: T): T | null;
export function greenhousePortConflict(componentId: string, sockets: [number | null, number | null] | null, socketsOf: (id: string) => Sockets): { port: number; line: string } | null;
export function probeBed(sockets: unknown): "A" | "B" | null;
