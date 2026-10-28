/**
 * Snapino carrier circuit, as pure functions of snap placements (socket indices on the 9 × 7
 * snap base) and pin levels. The 3D scene (`scene.ts` evaluateSnapino), the Rescue Signal
 * episode's transmitter timeline and the room server all use this one model, so the lamp a
 * receiver sees and the signal the episode scores can never disagree.
 *
 * Model (educational, not electrical simulation): conductors (snap wires, a closed slide
 * switch) join stud nets; a load (lamp, LED, motor) runs when its two ends are on DIFFERENT
 * nets, one driven HIGH (the 5V pad, or a D pin set HIGH) and the other reaching GND. The LED
 * is treated as non-polar here, exactly as the scene always has. A D pin set LOW is not a
 * current sink in this model (it drives nothing).
 *
 * Faults: 5V joined straight to GND is a short (nothing runs). A D pin set HIGH whose net is GND
 * is a pin short: that net is ground, never HIGH, so nothing is driven from it. A load whose two
 * ends are on the same net (for example bridged by a snap wire) is bypassed and never runs.
 */
import { OUTPUT_PINS, type PinStates, type SnapinoPin } from "../desktop/snapino.ts";

export const SNAPINO_SOCKET_COUNT = 63;
export const SNAPINO_PADS = { D2: 10, D3: 11, D5: 12, D6: 13, "5V": 14, GND: 15 } as const;
export const SNAPINO_LOADS = ["sno-l1", "sno-d1", "sno-m1"] as const;
/** Loads that give off light a receiver can see. */
export const SNAPINO_LIGHTS = ["sno-l1", "sno-d1"] as const;
export const SNAPINO_CONDUCTORS = ["sno-w2a", "sno-w2b", "sno-w3", "sno-w4a", "sno-w4b"] as const;
export const SNAPINO_SWITCH = "sno-s1";
export const SNAPINO_PART_IDS = [...SNAPINO_LOADS, SNAPINO_SWITCH, ...SNAPINO_CONDUCTORS] as const;

export type SnapinoPartId = (typeof SNAPINO_PART_IDS)[number];
/** Per part: its two stud indices (null = not seated) and, for S1, whether it is on. */
export type SnapinoBench = Partial<Record<string, { sockets?: readonly (number | null)[] | null; on?: boolean }>>;

const seated = (sockets: readonly (number | null)[] | null | undefined): sockets is [number, number] =>
  Array.isArray(sockets) && sockets.length === 2 && sockets.every((socket) => Number.isInteger(socket) && (socket as number) >= 0 && (socket as number) < SNAPINO_SOCKET_COUNT) && sockets[0] !== sockets[1];

export interface SnapinoNets {
  net(socket: number): number;
  vcc: number;
  gnd: number;
  short: boolean;
}

export function snapinoNets(bench: SnapinoBench): SnapinoNets {
  const parent = Array.from({ length: SNAPINO_SOCKET_COUNT }, (_, index) => index);
  const find = (value: number): number => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const join = (sockets: [number, number]): void => {
    parent[find(sockets[0])] = find(sockets[1]);
  };
  for (const id of SNAPINO_CONDUCTORS) {
    const sockets = bench[id]?.sockets;
    if (seated(sockets)) join(sockets);
  }
  const sw = bench[SNAPINO_SWITCH];
  if (sw?.on === true && seated(sw.sockets)) join(sw.sockets);
  const vcc = find(SNAPINO_PADS["5V"]);
  const gnd = find(SNAPINO_PADS.GND);
  return { net: find, vcc, gnd, short: vcc === gnd };
}

export interface SnapinoState {
  short: boolean;
  /** D2 reads HIGH (S1 or a wire bridges it to 5V). */
  inputHigh: boolean;
  /** A D pin set HIGH whose net is GND. */
  pinShort: SnapinoPin | null;
  running: Set<string>;
}

export function analyzeSnapino(bench: SnapinoBench, pins: PinStates): SnapinoState {
  const nets = snapinoNets(bench);
  const inputHigh = !nets.short && nets.net(SNAPINO_PADS.D2) === nets.vcc;
  const pinShort = OUTPUT_PINS.find((pin) => pins[pin] && nets.net(SNAPINO_PADS[pin]) === nets.gnd) ?? null;
  // The GND net is never HIGH: a HIGH pin wired to it is a pin short, not a source.
  const high = (net: number): boolean => net !== nets.gnd && (net === nets.vcc || OUTPUT_PINS.some((pin) => pins[pin] && nets.net(SNAPINO_PADS[pin]) === net));
  const running = new Set<string>();
  if (!nets.short) {
    for (const id of SNAPINO_LOADS) {
      const sockets = bench[id]?.sockets;
      if (!seated(sockets)) continue;
      const a = nets.net(sockets[0]);
      const b = nets.net(sockets[1]);
      if (a === b) continue; // bypassed: both ends on one net, no difference to drive it
      if ((high(a) && b === nets.gnd) || (high(b) && a === nets.gnd)) running.add(id);
    }
  }
  return { short: nets.short, inputHigh, pinShort, running };
}

/** How each light load can be driven: always (5V), by some D pins, or never. */
export interface LightDriver {
  id: string;
  seated: boolean;
  /** One end reaches GND. */
  grounded: boolean;
  /** Both ends on the same net (bridged), so it can never run. */
  bypassed: boolean;
  always: boolean;
  pins: SnapinoPin[];
}

export function lightDrivers(bench: SnapinoBench): { short: boolean; inputHigh: boolean; lights: LightDriver[] } {
  const nets = snapinoNets(bench);
  const lights = SNAPINO_LIGHTS.map((id): LightDriver => {
    const sockets = bench[id]?.sockets;
    if (!seated(sockets)) return { id, seated: false, grounded: false, bypassed: false, always: false, pins: [] };
    const ends = [nets.net(sockets[0]), nets.net(sockets[1])];
    const grounded = ends.includes(nets.gnd);
    const bypassed = ends[0] === ends[1];
    // A net can drive the load when it is not GND and the load's OTHER end is GND (as in
    // analyzeSnapino). A D pin on the GND net drives nothing (pin short).
    const driven = bypassed ? [] : ends.filter((net, index) => net !== nets.gnd && ends[1 - index] === nets.gnd);
    const always = !nets.short && driven.includes(nets.vcc);
    const pins = nets.short ? [] : OUTPUT_PINS.filter((pin) => driven.includes(nets.net(SNAPINO_PADS[pin])));
    return { id, seated: true, grounded, bypassed, always, pins };
  });
  return { short: nets.short, inputHigh: !nets.short && nets.net(SNAPINO_PADS.D2) === nets.vcc, lights };
}
