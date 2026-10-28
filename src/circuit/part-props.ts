/**
 * Editable electrical properties of Circuit Bench parts, and their validation.
 *
 * These are the only part properties that travel over the room protocol (inside a
 * SharedTransform as `props`) and into project files. The Cloudflare Worker and the local relay
 * re-implement `sanitizeProps` in plain JS with the same bounds (see cloudflare/worker.js);
 * scripts/project-state-check.mjs checks the two stay in agreement.
 */

export interface PartProps {
  /** Resistance of a resistor, in ohms. */
  ohms?: number;
  /** Battery / supply voltage, in volts. */
  volts?: number;
}

/** Bounds a learner may set in the inspector. */
export const RESISTANCE_RANGE = { min: 10, max: 1_000_000 } as const;
export const VOLTAGE_RANGE = { min: 1, max: 12 } as const;

/** Standard fixed values offered as one-tap choices. */
export const RESISTOR_PRESETS = [100, 220, 330, 470, 1000, 2200, 4700, 10000] as const;
export const VOLTAGE_PRESETS = [1.5, 3, 4.5, 5, 6, 9, 12] as const;

export type PropKind = "resistor" | "battery";

/** Rounds to three significant figures, the precision of a printed resistor value. */
export function roundOhms(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return Number.NaN;
  const digits = Math.floor(Math.log10(value)) - 2;
  const step = 10 ** digits;
  return Math.round(value / step) * step;
}

export function roundVolts(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Returns a clean props object for `kind`, or null when nothing valid is present. Never throws. */
export function sanitizeProps(kind: PropKind | string | undefined, raw: unknown): PartProps | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (kind === "resistor" && typeof input.ohms === "number" && Number.isFinite(input.ohms)) {
    const ohms = roundOhms(input.ohms);
    if (ohms >= RESISTANCE_RANGE.min && ohms <= RESISTANCE_RANGE.max) return { ohms };
  }
  if (kind === "battery" && typeof input.volts === "number" && Number.isFinite(input.volts)) {
    const volts = roundVolts(input.volts);
    if (volts >= VOLTAGE_RANGE.min && volts <= VOLTAGE_RANGE.max) return { volts };
  }
  return null;
}

/** Parses typed input like "4.7k", "220", "1 M", "330Ω". Returns NaN when unreadable. */
export function parseOhms(text: string): number {
  const match = String(text).trim().replace(/[Ωω]|ohms?/gi, "").trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!match) return Number.NaN;
  const base = Number(match[1]);
  // Lowercase "m" would mean milli-ohms; it is rejected rather than guessed.
  const scale = match[2] === "k" || match[2] === "K" ? 1e3 : match[2] === "M" ? 1e6 : match[2] === "m" ? Number.NaN : 1;
  return base * scale;
}

const BAND_DIGITS = ["black", "brown", "red", "orange", "yellow", "green", "blue", "violet", "grey", "white"] as const;
export type BandColor = (typeof BAND_DIGITS)[number] | "gold" | "silver";

/**
 * Four-band color code (two digits, multiplier, 5 % gold tolerance) for values that have one
 * exactly; null for values that would need more digits (the model then shows a printed label).
 */
export function resistorBands(ohms: number): BandColor[] | null {
  if (!Number.isFinite(ohms) || ohms < 10) return null;
  const exponent = Math.floor(Math.log10(ohms)) - 1;
  const digits = ohms / 10 ** exponent;
  if (Math.abs(digits - Math.round(digits)) > 1e-6 || exponent > 9) return null;
  const two = Math.round(digits);
  if (two < 10 || two > 99) return null;
  return [BAND_DIGITS[Math.floor(two / 10)], BAND_DIGITS[two % 10], BAND_DIGITS[exponent], "gold"];
}
