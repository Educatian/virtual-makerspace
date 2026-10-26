/**
 * Rescue Signal Workshop — the signal domain (pure; used by the client, the room server and
 * the tests).
 *
 * Protocol "Rescue Flash Code v1" (explicit, inspectable, deliberately small):
 *   - Six words, each a short sequence of flashes: S = short flash, L = long flash.
 *   - A flash is a continuous stretch of light from a lamp or LED that the circuit really
 *     powers. Its length classifies it: SHORT 200–450 ms, LONG 650–1500 ms. Anything in
 *     between (450–650 ms), shorter than 200 ms or longer than 1500 ms is ambiguous.
 *   - Dark gaps: 200–600 ms separates flashes of one word; 1200 ms or more is a pause
 *     boundary between words; 600–1200 ms (or under 200 ms) is an ambiguous gap.
 *   - A message is 1–3 words. There is no Morse decoding and no letters.
 * Times are what the block program commands (the bench's `wait` blocks); the transmitter's
 * light follows its pins instantly (no filament warm-up modelled).
 */
import { analyzeSnapino, lightDrivers, SNAPINO_LIGHTS, type SnapinoBench } from "../circuit/snapino-circuit.ts";
import { LOW_PINS, OUTPUT_PINS, type PinStates, type SnapinoPin, type SnapinoStatement } from "../desktop/snapino.ts";

export const PROTOCOL_ID = "rescue-flash-v1";

export type Flash = "S" | "L";
export const WORDS = {
  HELP: ["S", "S", "S"],
  INJURED: ["L", "L"],
  WATER: ["S", "L"],
  SAFE: ["L", "S"],
  NORTH: ["L", "S", "S"],
  SOUTH: ["S", "S", "L"],
} as const satisfies Record<string, readonly Flash[]>;
export type Word = keyof typeof WORDS;
export const WORD_LIST = Object.keys(WORDS) as Word[];
export const MAX_WORDS = 3;
export const isWord = (value: unknown): value is Word => typeof value === "string" && Object.prototype.hasOwnProperty.call(WORDS, value);

export const TIMING = {
  shortMin: 200,
  shortMax: 450,
  longMin: 650,
  longMax: 1500,
  gapMin: 200,
  gapMax: 600,
  pauseMin: 1200,
} as const;

/** The timing the DI worked example (and the "write blocks" helper) uses. */
export const RECOMMENDED = { short: 300, long: 900, gap: 300, pause: 1500 } as const;

export interface Mission {
  id: string;
  title: string;
  situation: string;
  /** What a good message would say (shown to the sender only); null = free choice. */
  suggested: Word[] | null;
}
export const MISSIONS: Mission[] = [
  { id: "ridge", title: "North ridge", situation: "A hiker on the north ridge has hurt an ankle and cannot walk out.", suggested: ["INJURED", "NORTH"] },
  { id: "creek", title: "Dry creek camp", situation: "Everyone at the creek camp is fine, but the water ran out yesterday.", suggested: ["SAFE", "WATER"] },
  { id: "storm", title: "Storm shelter", situation: "The storm cut the trail south of the shelter; the group needs help to come out that way.", suggested: ["HELP", "SOUTH"] },
  { id: "free", title: "Your own situation", situation: "Agree on a situation with your team, then choose the words that describe it.", suggested: null },
];
export const isMission = (value: unknown): value is string => typeof value === "string" && MISSIONS.some((mission) => mission.id === value);

// ── Programs → pin timeline → light ───────────────────────────────────────────────────────

/** A stretch of time with constant pin levels. */
export interface PinSegment {
  start: number;
  end: number;
  pins: PinStates;
}

/** Hard limits for one transmission (the server checks these too). */
export const MAX_TRANSMISSION_MS = 120_000;

/** Total time a program takes when run once from the top (the sum of its waits). */
export function programDurationMs(program: readonly SnapinoStatement[]): number {
  return program.reduce((total, statement) => total + (statement.op === "wait" ? statement.ms : 0), 0);
}

/**
 * Runs the blocks ONCE from the top (a transmission, unlike Run's endless loop()): writes and
 * follows change pins instantly, waits advance time. All pins are LOW before and after.
 * `follow` reads D2, which is fixed for the whole transmission (the bench cannot change
 * during one; any change ends it).
 */
export function pinTimeline(program: readonly SnapinoStatement[], inputHigh: boolean): PinSegment[] {
  const segments: PinSegment[] = [];
  let pins: PinStates = { ...LOW_PINS };
  let time = 0;
  for (const statement of program) {
    if (statement.op === "wait") {
      if (statement.ms > 0) segments.push({ start: time, end: time + statement.ms, pins: { ...pins } });
      time += statement.ms;
    } else if (statement.op === "write") {
      pins = { ...pins, [statement.pin]: statement.value };
    } else {
      pins = { ...pins, [statement.pin]: inputHigh !== statement.invert };
    }
  }
  return segments;
}

/** Pin levels after the last block ran (before the transmitter switches everything off). */
export function finalPins(program: readonly SnapinoStatement[], inputHigh: boolean): PinStates {
  let pins: PinStates = { ...LOW_PINS };
  for (const statement of program) {
    if (statement.op === "write") pins = { ...pins, [statement.pin]: statement.value };
    else if (statement.op === "follow") pins = { ...pins, [statement.pin]: inputHigh !== statement.invert };
  }
  return pins;
}

/** A stretch of light, in ms from the start of the transmission. */
export interface LightPulse {
  start: number;
  end: number;
  /** Which light loads were on. */
  sources: string[];
  /**
   * The light was still on when the transmission ended and stayed on afterwards (a lamp powered
   * from 5V, not by a D pin): `end` is where the recording stops, not a falling edge.
   */
  continues?: boolean;
}

export interface Transmission {
  program: readonly SnapinoStatement[];
  bench: SnapinoBench;
  durationMs: number;
  /** Where it was cut short (stop, or the bench/program changed), or null if it ran out. */
  stoppedAtMs: number | null;
}

/** When the transmission's light actually ended (its program end or where it was stopped). */
export const transmissionEnd = (transmission: Pick<Transmission, "durationMs" | "stoppedAtMs">): number =>
  transmission.stoppedAtMs === null ? transmission.durationMs : Math.min(transmission.durationMs, Math.max(0, transmission.stoppedAtMs));

/**
 * The light a receiver could see: the shared circuit model (`analyzeSnapino`) evaluated on
 * every pin segment of the program, cut at the transmission's end. An open, unpowered or
 * miswired lamp produces no pulses, whatever the code does.
 */
export function lightPulses(transmission: Transmission): LightPulse[] {
  const end = transmissionEnd(transmission);
  const input = analyzeSnapino(transmission.bench, LOW_PINS).inputHigh;
  const pulses: LightPulse[] = [];
  for (const segment of pinTimeline(transmission.program, input)) {
    if (segment.start >= end) break;
    const stop = Math.min(segment.end, end);
    const running = analyzeSnapino(transmission.bench, segment.pins).running;
    const sources = SNAPINO_LIGHTS.filter((id) => running.has(id));
    if (!sources.length) continue;
    const last = pulses[pulses.length - 1];
    if (last && last.end === segment.start && last.sources.join() === sources.join()) last.end = stop;
    else pulses.push({ start: segment.start, end: stop, sources });
  }
  // Light is light: back-to-back stretches with different sources are one visible flash.
  const merged: LightPulse[] = [];
  for (const pulse of pulses) {
    const last = merged[merged.length - 1];
    if (last && last.end === pulse.start) {
      last.end = pulse.end;
      last.sources = [...new Set([...last.sources, ...pulse.sources])];
    } else merged.push({ ...pulse, sources: [...pulse.sources] });
  }
  // After the end the transmitter's D pins are LOW. A light that is still lit with every pin LOW
  // (5V-powered) does not switch off there: mark its last stretch as continuing.
  const last = merged[merged.length - 1];
  if (last && last.end === end) {
    const after = analyzeSnapino(transmission.bench, LOW_PINS).running;
    if (SNAPINO_LIGHTS.some((id) => after.has(id))) last.continues = true;
  }
  return merged;
}

/** D pins that were set HIGH while wired straight to GND at some point of the transmission. */
export function pinShorts(transmission: Transmission): SnapinoPin[] {
  const end = transmissionEnd(transmission);
  const input = analyzeSnapino(transmission.bench, LOW_PINS).inputHigh;
  const found = new Set<SnapinoPin>();
  for (const segment of pinTimeline(transmission.program, input)) {
    if (segment.start >= end) break;
    if (segment.end <= segment.start) continue;
    for (const pin of OUTPUT_PINS) {
      if (segment.pins[pin] && analyzeSnapino(transmission.bench, { ...LOW_PINS, [pin]: true }).pinShort === pin) found.add(pin);
    }
  }
  return OUTPUT_PINS.filter((pin) => found.has(pin));
}

/** Pin levels at `ms` into the transmission (all LOW outside it). */
export function pinsAt(program: readonly SnapinoStatement[], inputHigh: boolean, ms: number, end: number): PinStates {
  if (ms < 0 || ms >= end) return { ...LOW_PINS };
  for (const segment of pinTimeline(program, inputHigh)) {
    if (ms >= segment.start && ms < segment.end) return segment.pins;
  }
  return { ...LOW_PINS };
}

// ── Decoding (what a receiver following protocol v1 reads) ───────────────────────────────

export type FlashClass = Flash | "?";
export interface DecodedFlash {
  start: number;
  duration: number;
  kind: FlashClass;
  /** `unended`: still lit when the recording ended (it has no measurable length). */
  reason?: "too-short" | "between" | "too-long" | "unended";
}
export interface DecodedGap {
  after: number;
  duration: number;
  kind: "within" | "pause" | "?";
  reason?: "too-short" | "between";
}
export interface DecodedGroup {
  pattern: FlashClass[];
  word: Word | null;
  ambiguous: boolean;
}
export interface Decoded {
  flashes: DecodedFlash[];
  gaps: DecodedGap[];
  groups: DecodedGroup[];
  /** One entry per group: the word, or null when the group is ambiguous or not a word. */
  words: (Word | null)[];
  /** Any flash or gap outside the protocol's bands. */
  ambiguous: boolean;
  /** No light at all. */
  empty: boolean;
}

export function classifyFlash(duration: number): Pick<DecodedFlash, "kind" | "reason"> {
  if (duration < TIMING.shortMin) return { kind: "?", reason: "too-short" };
  if (duration <= TIMING.shortMax) return { kind: "S" };
  if (duration < TIMING.longMin) return { kind: "?", reason: "between" };
  if (duration <= TIMING.longMax) return { kind: "L" };
  return { kind: "?", reason: "too-long" };
}

export function classifyGap(duration: number): Pick<DecodedGap, "kind" | "reason"> {
  if (duration < TIMING.gapMin) return { kind: "?", reason: "too-short" };
  if (duration <= TIMING.gapMax) return { kind: "within" };
  if (duration < TIMING.pauseMin) return { kind: "?", reason: "between" };
  return { kind: "pause" };
}

const patternWord = (pattern: readonly FlashClass[]): Word | null =>
  WORD_LIST.find((word) => WORDS[word].length === pattern.length && WORDS[word].every((flash, index) => flash === pattern[index])) ?? null;

/**
 * Splits the light into words at pause boundaries. An ambiguous gap keeps its flashes in one
 * group (so the group reads as ambiguous rather than silently splitting or merging words).
 */
export function decode(pulses: readonly LightPulse[]): Decoded {
  const flashes: DecodedFlash[] = pulses.map((pulse) => ({
    start: pulse.start,
    duration: pulse.end - pulse.start,
    ...(pulse.continues ? { kind: "?" as const, reason: "unended" as const } : classifyFlash(pulse.end - pulse.start)),
  }));
  const gaps: DecodedGap[] = [];
  for (let index = 1; index < pulses.length; index += 1) {
    const duration = pulses[index].start - pulses[index - 1].end;
    gaps.push({ after: index - 1, duration, ...classifyGap(duration) });
  }
  const groups: DecodedGroup[] = [];
  let current: { pattern: FlashClass[]; ambiguous: boolean } = { pattern: [], ambiguous: false };
  flashes.forEach((flash, index) => {
    current.pattern.push(flash.kind);
    if (flash.kind === "?") current.ambiguous = true;
    const gap = gaps[index];
    if (!gap) return;
    if (gap.kind === "pause") {
      groups.push({ ...current, word: null });
      current = { pattern: [], ambiguous: false };
    } else if (gap.kind === "?") current.ambiguous = true;
  });
  if (current.pattern.length) groups.push({ ...current, word: null });
  for (const group of groups) group.word = group.ambiguous ? null : patternWord(group.pattern);
  return {
    flashes,
    gaps,
    groups,
    words: groups.map((group) => group.word),
    ambiguous: flashes.some((flash) => flash.kind === "?") || gaps.some((gap) => gap.kind === "?"),
    empty: flashes.length === 0,
  };
}

// ── Comparing intention, signal and reading ──────────────────────────────────────────────

export type Reading = (Word | "?")[];
export type SignalQuality = "none" | "ambiguous" | "clear";

export interface Comparison {
  signal: SignalQuality;
  /** Under the protocol, the signal says exactly the intended words. */
  encodesIntent: boolean;
  /** The receiver read exactly the words the signal says (only when the signal is clear). */
  readAsSent: boolean;
  /** The receiver's reading equals the sender's intention. */
  understood: boolean;
  /** All three agree on a clear, real signal: the message got through. */
  delivered: boolean;
  outcome: "delivered" | "no-signal" | "ambiguous-signal" | "signal-differs" | "read-differently";
}

const sameWords = (a: readonly (string | null)[], b: readonly (string | null)[]): boolean => a.length === b.length && a.every((word, index) => word === b[index]);

export function compare(intent: readonly Word[], decoded: Decoded, reading: Reading): Comparison {
  const signal: SignalQuality = decoded.empty ? "none" : decoded.ambiguous || decoded.words.some((word) => word === null) ? "ambiguous" : "clear";
  const encodesIntent = signal === "clear" && sameWords(decoded.words, intent);
  const readAsSent = signal === "clear" && sameWords(reading, decoded.words);
  const understood = intent.length > 0 && sameWords(reading, intent);
  const delivered = signal === "clear" && encodesIntent && readAsSent;
  const outcome = delivered ? "delivered" : signal === "none" ? "no-signal" : signal === "ambiguous" ? "ambiguous-signal" : !encodesIntent ? "signal-differs" : "read-differently";
  return { signal, encodesIntent, readAsSent, understood, delivered, outcome };
}

// ── Neutral, factual diagnosis (shown after a round is compared) ──────────────────────────

export interface Finding {
  code: string;
  message: string;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : ms % 100 === 0 ? 1 : 2)} s`;
const LIGHT_NAMES: Record<string, string> = { "sno-l1": "Lamp L1", "sno-d1": "LED D1" };

/**
 * What happened, stated as observations against the circuit and the protocol — never a
 * suggestion of what to build. Order: circuit, program, timing, reading.
 */
export function diagnose(transmission: Transmission, intent: readonly Word[], reading: Reading | null): Finding[] {
  const findings: Finding[] = [];
  const drivers = lightDrivers(transmission.bench);
  const usedPins = new Set<SnapinoPin>(transmission.program.filter((statement) => statement.op !== "wait" && (statement.op !== "write" || statement.value)).map((statement) => (statement as { pin: SnapinoPin }).pin));
  const pulses = lightPulses(transmission);
  const decoded = decode(pulses);
  if (drivers.short) findings.push({ code: "short", message: "5V is joined straight to GND on the snap base, so nothing could light." });
  const seatedLights = drivers.lights.filter((light) => light.seated);
  if (!seatedLights.length) findings.push({ code: "no-light-part", message: "No lamp or LED was seated on the base during this transmission." });
  for (const light of seatedLights) {
    const name = LIGHT_NAMES[light.id] ?? light.id;
    if (light.bypassed) findings.push({ code: "bypassed", message: `Both ends of ${name} were on the same connected net (a snap wire joins them), so there was no difference across it and it could not light.` });
    else if (!light.grounded) findings.push({ code: "not-grounded", message: `${name} had no end reaching GND, so no current could flow through it.` });
    else if (light.always) findings.push({ code: "always-on", message: `${name} was wired to 5V and GND, so it stayed lit whatever the program did.` });
    else if (!light.pins.length) findings.push({ code: "not-driven", message: `${name} reached GND, but its other end was not on a D pin.` });
    else {
      const unused = light.pins.filter((pin) => !usedPins.has(pin));
      if (unused.length === light.pins.length) findings.push({ code: "wrong-pin", message: `${name} was wired to ${light.pins.join("/")}, but the program never set ${light.pins.length > 1 ? "those pins" : "that pin"} HIGH (it switched ${[...usedPins].join(", ") || "no pin"}).` });
    }
  }
  for (const pin of pinShorts(transmission)) {
    findings.push({ code: "pin-short", message: `${pin} was set HIGH while its pad was wired straight to GND (a short at the pin), so nothing could be driven from ${pin}.` });
  }
  if (transmission.stoppedAtMs !== null && transmission.stoppedAtMs < transmission.durationMs) {
    findings.push({ code: "stopped", message: `The transmission was cut off at ${seconds(transmissionEnd(transmission))} of ${seconds(transmission.durationMs)}.` });
  }
  const input = analyzeSnapino(transmission.bench, LOW_PINS).inputHigh;
  const continuing = pulses.some((pulse) => pulse.continues);
  const litAtEnd = SNAPINO_LIGHTS.some((id) => analyzeSnapino(transmission.bench, finalPins(transmission.program, input)).running.has(id));
  if (continuing) {
    findings.push({ code: "still-lit", message: "The light was still on when the transmission ended and stays on afterwards (it is powered from 5V, not switched by a D pin), so its last flash has no end to measure." });
  } else if (litAtEnd && pulses.length && transmission.stoppedAtMs === null) {
    findings.push({ code: "on-at-end", message: "The blocks left a D pin HIGH when they finished; the transmitter set its pins LOW at the end of the transmission, which is where the last flash ended." });
  }
  decoded.flashes.forEach((flash, index) => {
    if (flash.kind !== "?" || flash.reason === "unended") return;
    const band = flash.reason === "between" ? `between short (≤${TIMING.shortMax} ms) and long (≥${TIMING.longMin} ms)` : flash.reason === "too-short" ? `shorter than a short flash (${TIMING.shortMin} ms)` : `longer than a long flash (${TIMING.longMax} ms)`;
    findings.push({ code: `flash-${flash.reason}`, message: `Flash ${index + 1} lasted ${flash.duration} ms: ${band}.` });
  });
  decoded.gaps.forEach((gap) => {
    if (gap.kind !== "?") return;
    const band = gap.reason === "between" ? `longer than a gap inside a word (≤${TIMING.gapMax} ms) but shorter than a pause between words (≥${TIMING.pauseMin} ms)` : `too short to see as a gap (under ${TIMING.gapMin} ms)`;
    findings.push({ code: `gap-${gap.reason}`, message: `The dark gap after flash ${gap.after + 1} lasted ${gap.duration} ms: ${band}.` });
  });
  decoded.groups.forEach((group, index) => {
    if (!group.ambiguous && !group.word) findings.push({ code: "not-a-word", message: `Group ${index + 1} (${group.pattern.join(" ")}) is not one of the six protocol words.` });
  });
  if (!decoded.empty && !decoded.ambiguous && decoded.words.every((word) => word !== null) && !sameWords(decoded.words, intent)) {
    findings.push({ code: "differs", message: `Under the protocol the signal reads ${decoded.words.join(" · ")}; the intended message was ${intent.join(" · ") || "(none)"}.` });
  }
  if (reading && !decoded.empty && !decoded.ambiguous && decoded.words.every((word) => word !== null) && !sameWords(reading, decoded.words)) {
    findings.push({ code: "read-differently", message: `The receiver read ${reading.join(" · ") || "(nothing)"}, which is not what the signal says under the protocol.` });
  }
  return findings;
}

// ── Building blocks for a message (DI helper) ─────────────────────────────────────────────

/**
 * Write/wait blocks that send `words` on `pin` with the recommended timing. Gaps follow each
 * flash; a word boundary replaces the last gap with a pause. Returns null if it would not fit
 * in a program (`maxStatements`).
 */
export function compileMessage(words: readonly Word[], pin: SnapinoPin, maxStatements: number, timing: { short: number; long: number; gap: number; pause: number } = RECOMMENDED): SnapinoStatement[] | null {
  const program: SnapinoStatement[] = [];
  words.forEach((word, wordIndex) => {
    WORDS[word].forEach((flash, flashIndex) => {
      const lastOfWord = flashIndex === WORDS[word].length - 1;
      const lastOfMessage = lastOfWord && wordIndex === words.length - 1;
      program.push({ op: "write", pin, value: true });
      program.push({ op: "wait", ms: flash === "S" ? timing.short : timing.long });
      program.push({ op: "write", pin, value: false });
      if (!lastOfMessage) program.push({ op: "wait", ms: lastOfWord ? timing.pause : timing.gap });
    });
  });
  return program.length <= maxStatements ? program : null;
}

/** The output pin a seated light is wired to (for the helper), if exactly one. */
export function wiredPin(bench: SnapinoBench): SnapinoPin | null {
  const pins = new Set(lightDrivers(bench).lights.flatMap((light) => light.pins));
  return pins.size === 1 ? [...pins][0] : null;
}

export { OUTPUT_PINS };
