export type ProbeItem = {
  id: string;
  stem: string;
  options: string[];
  correct: number;
};

export type ReflectionPrompt = {
  id: string;
  prompt: string;
  placeholder?: string;
};

export type ProbeSet = {
  pre: ProbeItem[];
  post: ProbeItem[];
  reflection: ReflectionPrompt[];
};

export const PROBE_ITEMS: ProbeSet = {
  pre: [
    {
      id: "pre_polarity",
      stem: "If you swap a battery's + and − connections to an LED, the LED will:",
      options: [
        "Light up the same",
        "Light up dimmer",
        "Stay off",
        "Burn out immediately",
      ],
      correct: 2,
    },
    {
      id: "pre_resistor",
      stem: "What is the primary role of a resistor in a simple LED circuit?",
      options: [
        "Provides energy to the LED",
        "Limits current to protect the LED",
        "Stores electrical charge",
        "Reverses current direction",
      ],
      correct: 1,
    },
    {
      id: "pre_series_parallel",
      stem: "Two identical resistors are connected. Which arrangement has higher total resistance?",
      options: [
        "Series",
        "Parallel",
        "Both are equal",
        "Depends on the battery",
      ],
      correct: 0,
    },
    {
      id: "pre_open_circuit",
      stem: "An LED in an otherwise complete circuit will not light up if:",
      options: [
        "The wire is too short",
        "There is a break (open) anywhere in the loop",
        "The breadboard is plastic",
        "The components are touching",
      ],
      correct: 1,
    },
  ],
  post: [
    {
      id: "post_polarity",
      stem: "After your work today: which terminal of a battery does conventional current flow OUT of?",
      options: [
        "The negative (−) terminal",
        "The positive (+) terminal",
        "Either, depending on the LED",
        "Neither — current flows in both directions",
      ],
      correct: 1,
    },
    {
      id: "post_short",
      stem: "A wire connected directly across a battery (no resistor or LED) creates a:",
      options: [
        "Working circuit",
        "Short circuit (dangerous)",
        "Parallel circuit",
        "Open circuit",
      ],
      correct: 1,
    },
    {
      id: "post_transfer",
      stem: "If you replaced the LED with a small motor in the same circuit, the motor would:",
      options: [
        "Not work at all",
        "Run in one direction only",
        "Run, and reverse if the battery is flipped",
        "Run only with two batteries",
      ],
      correct: 2,
    },
    {
      id: "post_confidence",
      stem: "How confident are you that you understand why your circuit lit up (or didn't)?",
      options: ["Not at all", "A little", "Mostly", "Very confident"],
      correct: -1,
    },
  ],
  reflection: [
    {
      id: "reflection_explain",
      prompt:
        "In your own words: why did the LED light up (or fail to light up)? Walk me through the path the current took.",
      placeholder: "Describe what was happening in the circuit...",
    },
    {
      id: "reflection_struggle",
      prompt:
        "What was the hardest part of figuring this out? Was there a moment where you tried something that didn't work?",
      placeholder: "Be specific — failed attempts are useful data!",
    },
    {
      id: "reflection_principle",
      prompt:
        "If a friend asked you for ONE rule for making a circuit work, what would you tell them?",
      placeholder: "One sentence is fine.",
    },
  ],
};
