/**
 * Snapino Bridge: a tiny, screen-reader-friendly program model for the Snapino
 * board (Arduino Nano on a Snap Circuits carrier). Programs are a flat list of
 * statements that run as Arduino's loop(); the same list renders as C source.
 */

export const OUTPUT_PINS = ["D3", "D5", "D6"] as const;
export type SnapinoPin = (typeof OUTPUT_PINS)[number];
export type PinStates = Record<SnapinoPin, boolean>;

export type SnapinoStatement =
  | { op: "write"; pin: SnapinoPin; value: boolean }
  | { op: "wait"; ms: number }
  | { op: "follow"; pin: SnapinoPin; invert: boolean };

export const MAX_STATEMENTS = 24;
export const LOW_PINS: PinStates = { D3: false, D5: false, D6: false };

export const EXAMPLES: Record<string, { label: string; program: SnapinoStatement[] }> = {
  blink: {
    label: "Blink D5",
    program: [
      { op: "write", pin: "D5", value: true },
      { op: "wait", ms: 500 },
      { op: "write", pin: "D5", value: false },
      { op: "wait", ms: 500 },
    ],
  },
  switch: {
    label: "S1 controls D5",
    program: [
      { op: "follow", pin: "D5", invert: false },
      { op: "wait", ms: 50 },
    ],
  },
  chase: {
    label: "Chase D3 → D5 → D6",
    program: [
      { op: "write", pin: "D3", value: true },
      { op: "wait", ms: 300 },
      { op: "write", pin: "D3", value: false },
      { op: "write", pin: "D5", value: true },
      { op: "wait", ms: 300 },
      { op: "write", pin: "D5", value: false },
      { op: "write", pin: "D6", value: true },
      { op: "wait", ms: 300 },
      { op: "write", pin: "D6", value: false },
    ],
  },
};

const isPin = (value: unknown): value is SnapinoPin => OUTPUT_PINS.includes(value as SnapinoPin);

/** Validates untrusted program data (from peers or storage). */
export function sanitizeProgram(value: unknown): SnapinoStatement[] | null {
  if (!Array.isArray(value) || value.length > MAX_STATEMENTS) return null;
  const program: SnapinoStatement[] = [];
  for (const raw of value) {
    const item = raw as Record<string, unknown>;
    if (item?.op === "write" && isPin(item.pin) && typeof item.value === "boolean") {
      program.push({ op: "write", pin: item.pin, value: item.value });
    } else if (item?.op === "wait" && Number.isFinite(item.ms)) {
      program.push({ op: "wait", ms: clampMs(Number(item.ms)) });
    } else if (item?.op === "follow" && isPin(item.pin) && typeof item.invert === "boolean") {
      program.push({ op: "follow", pin: item.pin, invert: item.invert });
    } else {
      return null;
    }
  }
  return program;
}

export function clampMs(ms: number): number {
  return Math.min(5000, Math.max(50, Math.round(ms / 50) * 50));
}

export function describeStatement(statement: SnapinoStatement): string {
  if (statement.op === "write") return `Turn ${statement.pin} ${statement.value ? "on" : "off"}`;
  if (statement.op === "wait") return `Wait ${statement.ms} milliseconds`;
  return `${statement.pin} ${statement.invert ? "opposite of" : "follows"} switch on D2`;
}

const pinNumber = (pin: SnapinoPin): number => Number(pin.slice(1));

export function toArduino(program: SnapinoStatement[]): string {
  const used = OUTPUT_PINS.filter((pin) => program.some((statement) => "pin" in statement && statement.pin === pin));
  const readsSwitch = program.some((statement) => statement.op === "follow");
  const setup = [
    ...used.map((pin) => `  pinMode(${pinNumber(pin)}, OUTPUT);`),
    ...(readsSwitch ? ["  pinMode(2, INPUT);  // S1 bridges D2 to 5V"] : []),
  ];
  const body = program.map((statement) => {
    if (statement.op === "write") return `  digitalWrite(${pinNumber(statement.pin)}, ${statement.value ? "HIGH" : "LOW"});`;
    if (statement.op === "wait") return `  delay(${statement.ms});`;
    return `  digitalWrite(${pinNumber(statement.pin)}, ${statement.invert ? "!" : ""}digitalRead(2));`;
  });
  return ["void setup() {", ...setup, "}", "", "void loop() {", ...(body.length ? body : ["  // add a statement"]), "}"].join("\n");
}

/**
 * Cooperative interpreter for loop(): statements run in order, `wait` yields,
 * and every pass through loop() takes at least one frame so a program with no
 * waits cannot lock the tab.
 */
export class SnapinoRunner {
  private timer = 0;
  private generation = 0;
  private pins: PinStates = { ...LOW_PINS };
  private readonly onPins: (pins: PinStates) => void;
  private readonly readSwitch: () => boolean;

  constructor(onPins: (pins: PinStates) => void, readSwitch: () => boolean) {
    this.onPins = onPins;
    this.readSwitch = readSwitch;
  }

  get running(): boolean {
    return this.timer !== 0;
  }

  start(program: SnapinoStatement[]): void {
    this.stop();
    const generation = ++this.generation;
    let index = 0;
    let passStartedAt = performance.now();
    const step = (): void => {
      if (generation !== this.generation) return;
      let changed = false;
      while (index < program.length) {
        const statement = program[index++];
        if (statement.op === "wait") {
          if (changed) this.onPins({ ...this.pins });
          this.timer = window.setTimeout(step, statement.ms);
          return;
        }
        const value = statement.op === "write" ? statement.value : this.readSwitch() !== statement.invert;
        if (this.pins[statement.pin] !== value) {
          this.pins[statement.pin] = value;
          changed = true;
        }
      }
      if (changed) this.onPins({ ...this.pins });
      index = 0;
      const elapsed = performance.now() - passStartedAt;
      passStartedAt = performance.now();
      this.timer = window.setTimeout(step, Math.max(16, 50 - elapsed));
    };
    this.timer = window.setTimeout(step, 0);
  }

  stop(): void {
    this.generation += 1;
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.pins = { ...LOW_PINS };
    this.onPins({ ...this.pins });
  }
}
