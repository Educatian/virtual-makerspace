/**
 * Reference copy for the Snapino bench's parts: what each part is, its ends ("pinout"), how
 * THIS bench models it, and where the model differs from real hardware. Written for this
 * project; values are typical published ratings and are marked as such.
 *
 * The bench is an educational connection model (`snapino-circuit.ts`): it decides on/off from
 * which nets a part's ends sit on. It does not compute current, so every current figure here is
 * reference information about real parts, never a reading.
 */
export interface PartReference {
  id: string;
  short: string;
  name: string;
  role: string;
  overview: string;
  /** The two ends, in the order the bench stores them (end A, end B). */
  ends: [string, string];
  /** How the bench decides what this part does. */
  behavior: string[];
  /** Real-hardware limits and where the bench simplifies. */
  limits: string[];
}

const LOAD_RULE = "Runs when one end sits on a net driven HIGH (the 5V pad, or a D pin the program sets HIGH) and the other end reaches GND.";
const PIN_LIMIT = "A real Nano's ATmega328P pin is rated 40 mA absolute maximum (about 20 mA recommended). This bench does not model current.";

export const SNAPINO_PART_REFERENCE: Record<string, PartReference> = {
  "sno-l1": {
    id: "sno-l1",
    short: "L1",
    name: "Lamp L1",
    role: "Output load · light",
    overview: "A small incandescent bulb on a two-snap carrier. In the Rescue Signal Workshop it is the transmitter the receiver watches.",
    ends: ["End A · either side (not polarised)", "End B · either side"],
    behavior: [
      LOAD_RULE,
      "Either way round works: the bench treats the lamp as non-polar, like a real filament.",
      "Both ends on the same net (bridged by a wire or a closed switch): bypassed, never lights.",
      "From 5V to GND it lights whenever the board is powered, and code cannot switch it off.",
    ],
    limits: [
      "Typical kit lamp rating: 2.5 V, 0.3 A (300 mA).",
      `${PIN_LIMIT} 300 mA is far beyond a pin, so real builds switch a lamp through a transistor.`,
      "A filament takes tens of milliseconds to brighten and fade; the bench switches instantly.",
    ],
  },
  "sno-d1": {
    id: "sno-d1",
    short: "D1",
    name: "LED D1",
    role: "Output load · light",
    overview: "A red light-emitting diode on a two-snap carrier, with a current-limiting resistor built in as on kit LED modules.",
    ends: ["End A · anode (+) on real modules", "End B · cathode (−) on real modules"],
    behavior: [
      LOAD_RULE,
      "Simplification: the bench treats D1 as non-polar. A real LED conducts only from + to −, so reversed it stays dark.",
      "Both ends on the same net: bypassed, never lights.",
    ],
    limits: [
      "Typical red LED: about 1.8–2.2 V forward voltage at 10–20 mA.",
      `${PIN_LIMIT} An LED with its resistor is within what one pin can drive.`,
      "LEDs switch in microseconds; flashes stay sharp at any blink rate this bench can run.",
    ],
  },
  "sno-m1": {
    id: "sno-m1",
    short: "M1",
    name: "Motor M1",
    role: "Output load · motion",
    overview: "A small DC motor with a fan blade. It moves, but gives no light a receiver could read.",
    ends: ["End A · direction depends on polarity", "End B"],
    behavior: [
      LOAD_RULE,
      "The bench spins the fan when it runs; it does not model direction or speed.",
    ],
    limits: [
      "Typical kit motor: 3 V; hundreds of mA running and more at start-up (stall).",
      `${PIN_LIMIT} A motor also kicks back voltage when it stops, so real builds use a transistor and a flyback diode.`,
    ],
  },
  "sno-s1": {
    id: "sno-s1",
    short: "S1",
    name: "Slide switch S1",
    role: "Input · on/off contact",
    overview: "A single-pole slide switch. On, it joins its two snaps into one net; off, it separates them.",
    ends: ["Contact A", "Contact B"],
    behavior: [
      "On: its two studs become one net (it conducts like a wire). Off: they are separate.",
      "Between the 5V pad and D2, it makes D2 read HIGH while on; the Follow S1 block copies D2 to an output pin.",
      "A switch flip is a shared room edit: it shows for everyone once the room accepts it.",
    ],
    limits: [
      "Simplification: an open D2 reads LOW here. A real input left open floats, so real circuits add a pull-down resistor (about 10 kΩ) or use INPUT_PULLUP with the switch to GND.",
      "Real contacts bounce for a few milliseconds when flipped; the bench switches cleanly.",
    ],
  },
};

/** Snap wires and pads share one reference each. */
export const SNAP_WIRE_REFERENCE = {
  role: "Conductor",
  overview: "A rigid snap wire joins the studs under its two snaps, two to four stud spacings apart. Wires do not appear as rungs on the diagram: a wire IS a net.",
  behavior: [
    "Every stud a wire touches joins one net; wires chain into larger nets.",
    "A wire from a load's end to the GND pad completes the return path; a wire across a load bypasses it.",
  ],
  limits: ["Treated as zero resistance. A wire straight from 5V to GND is a short; the bench stops everything until it is removed."],
};

export const SNAPINO_PAD_REFERENCE: Record<string, string> = {
  "5V": "Supply pad: always 5 V while the board is powered.",
  GND: "Ground pad: 0 V, the return path every load needs.",
  D2: "Input pad: the program reads it (Follow S1). HIGH when joined to 5V.",
  D3: "Output pad: 5 V when the program sets it HIGH. LOW is 0 V, but this bench never uses a LOW pin as a path to GND (loads return to the GND pad).",
  D5: "Output pad: 5 V when the program sets it HIGH. LOW is 0 V, but this bench never uses a LOW pin as a path to GND (loads return to the GND pad).",
  D6: "Output pad: 5 V when the program sets it HIGH. LOW is 0 V, but this bench never uses a LOW pin as a path to GND (loads return to the GND pad).",
};
