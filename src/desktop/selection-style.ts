/**
 * One style contract for "which net is which" when a part is selected, used by the 3D bench
 * (stud rings), the live diagram (row strokes and badges) and the inspector's text. Colour is
 * never the only cue: each tone also has a letter and a ring/stroke pattern, and the inspector
 * names both.
 */
export type NetTone = "a" | "b" | "fault";

export interface NetToneStyle {
  /** For three.js materials. */
  hex: number;
  /** For CSS and SVG. */
  css: string;
  /** Text badge on the diagram row and in the pinout. */
  letter: string;
  /** Ring pattern in 3D, and the matching stroke pattern on the diagram. */
  pattern: "solid" | "dashed" | "double";
  /** How the inspector names the cue. */
  description: string;
}

export const NET_TONES: Record<NetTone, NetToneStyle> = {
  a: { hex: 0xf59e0b, css: "#f59e0b", letter: "A", pattern: "solid", description: "amber, solid ring" },
  b: { hex: 0x22d3ee, css: "#22d3ee", letter: "B", pattern: "dashed", description: "cyan, dashed ring" },
  fault: { hex: 0xef4444, css: "#ef4444", letter: "!", pattern: "double", description: "red, double ring (both ends on one net)" },
};

/** CSS custom properties carrying the contract into stylesheets (`--tone-a`, …). */
export function toneCssVariables(): string {
  return (Object.keys(NET_TONES) as NetTone[]).map((tone) => `--tone-${tone}:${NET_TONES[tone].css}`).join(";");
}
