/**
 * Teachable-agent mind for Bolt, the AI teammate (Betty's Brain-style learning by teaching).
 *
 * Bolt starts with naive ideas and only changes them when a teammate *teaches* it — names
 * the idea and says why. It never learns from the simulator on its own and never offers a
 * correct idea nobody taught it, so it cannot leak hints into a Productive Failure session.
 * Everything here is deterministic and free of DOM / three.js; the controller in
 * `ai-teammate.ts` feeds it chat and board analyses and acts on what it returns.
 */
import type { CircuitAnalysis, LayoutBeliefs } from "./circuit-topology.js";

export type ConceptId = "loop" | "strips" | "resistor";
/** naive: still holds the misconception · partial: told what, not why · taught: told why. */
export type BeliefStatus = "naive" | "partial" | "taught";
export type AgentProfileId = "novice" | "intermediate";

export interface Belief {
  status: BeliefStatus;
  /** The teammate's own words when the idea was taught (kept locally, never exported). */
  quote?: string;
  taughtBy?: string;
  changedAt?: number;
}

interface ConceptCopy {
  label: string;
  /** Bolt's naive reasoning, voiced when asked (or proactively outside PF). */
  naiveThought: string;
  /** Asked when a teammate names the idea without explaining it. */
  askWhy: string;
  /** Asked as verifier when a teammate's build contradicts Bolt's naive idea. */
  conflict: (parts: string) => string;
  /** Bolt's restatement once taught. */
  restate: string;
  keywords: RegExp;
  /** Words that carry the mechanism, so naming them counts as explaining. */
  mechanism: RegExp;
}

export const CONCEPTS: Record<ConceptId, ConceptCopy> = {
  loop: {
    label: "complete loop",
    naiveThought: "I think the battery pushes power out into the LED, so one connection from the battery should be enough.",
    askWhy: "Okay — but why does it have to go back to the battery? I thought power just flows out into the LED.",
    conflict: () => "Why is something connected to both sides of the battery? I thought one side was enough.",
    restate: "the current has to travel all the way around and come back into the other side of the battery — a complete loop.",
    keywords: /\b(loop|circle|all the way around|goes? around|complete (path|circuit|loop)|closed (path|circuit|loop)|back to (the )?(battery|negative|minus|other)|return(s|ing)? (path|wire|to)|both (sides|ends|terminals)|other (side|end|terminal) of the battery|negative (side|terminal|end))\b|고리|루프|닫힌|닫혀|한 바퀴|돌아(와|가|오)|반대쪽|양쪽 단자/,
    mechanism: /\b(complete (loop|circuit|path)|closed (loop|circuit|path)|all the way around|goes? around|(flows?|travels?|moves?|goes) (back|around|through)|comes? back|returns? to)\b|고리|루프|닫힌|한 바퀴|돌아/,
  },
  strips: {
    label: "breadboard column strips",
    naiveThought: "I think holes in the same row are connected, like a line, so I lined the parts up side by side.",
    askWhy: "Okay — but why would that connect them? I thought holes next to each other in a row were connected.",
    conflict: (parts) => `How are ${parts} connected? They're in different rows.`,
    restate: "the holes connect up and down in little column strips, not along the row — two parts only connect if they share a column strip.",
    keywords: /\b(columns?|vertical(ly)?|up and down|up-and-down|strips?|five holes|5 holes|rows? (are|is)( not|n'?t)|not connected (across|along|sideways|in (a|the) row)|same col(umn)?|center (gap|channel|line)|middle (gap|channel))\b|세로|같은 열|열끼리|가운데 (홈|틈)|다섯 구멍|가로.*연결.*(안|않)/,
    mechanism: /\b(connect(ed|s)?|share|same strip|metal (strip|clip)s?|joined|linked)\b|연결|이어/,
  },
  resistor: {
    label: "series resistor",
    naiveThought: "I think extra parts just slow things down, so I put the LED right on the battery.",
    askWhy: "Okay, I can add a resistor — but why? What does it actually do for the LED?",
    conflict: () => "Why add the resistor? I'd have put the LED straight on the battery.",
    restate: "the resistor limits how much current flows, so the LED doesn't get too much and burn out.",
    keywords: /\bresistors?\b|저항/,
    mechanism: /\b(limit(s|ing)?|less current|too much|protect(s|ing)?|burn(s|ing|t)?|blow(s|n)?|fry|fries|break(s)?|safe|reduc(e|es|ing)|control(s)? (the )?current|slow(s)? (down )?(the )?current)\b|제한|줄여|줄이|막아|보호|타(버|서|지)|터(져|지)|망가|과전류|너무 많/,
  },
};

const CONCEPT_ORDER: ConceptId[] = ["strips", "loop", "resistor"];

/** Reason-giving words. Directives ("needs to", "must") alone say what, not why. */
const CAUSAL = /\b(because|since|so that|so the|so it|otherwise|or else|if you don'?t|if it|if there|that'?s why|which means|in order to|the reason)\b|왜냐|때문|그래서|안 그러면|않으면|니까|므로|려면/;
const ASKS_WHY = /\b(why|how come|explain|reason|what were you thinking)\b|왜|이유/;
/** The message speaks to Bolt rather than to another human. */
const ADDRESSED = /\b(bolt|you|your)\b|볼트|너|네가/;

export const AGENT_PROFILES: Record<AgentProfileId, Record<ConceptId, BeliefStatus>> = {
  novice: { loop: "naive", strips: "naive", resistor: "naive" },
  intermediate: { loop: "taught", strips: "naive", resistor: "naive" },
};

export type AgentCommand = "rebuild" | "become-builder" | "become-verifier";

export interface LearningEvent {
  concept: ConceptId;
  from: BeliefStatus;
  to: BeliefStatus;
  quality: "explained" | "named";
  teacher: string;
}

export interface HearResult {
  replies: string[];
  learned: LearningEvent[];
  commands: AgentCommand[];
  /** Concept Bolt asked "why" about in this reply, if any. */
  asked?: ConceptId;
}

export interface MindSnapshot {
  profile: AgentProfileId;
  beliefs: Record<ConceptId, Belief>;
}

export interface NotebookEntry {
  concept: ConceptId;
  label: string;
  restatement: string;
  quote: string;
  taughtBy: string;
}

export interface BoardRemark {
  text: string;
  concept: ConceptId;
  kind: "conflict" | "applied";
}

const PENDING_WINDOW_MS = 90_000;
const STATUSES: BeliefStatus[] = ["naive", "partial", "taught"];

function isSnapshot(value: unknown): value is MindSnapshot {
  const snapshot = value as MindSnapshot | null | undefined;
  return Boolean(
    snapshot &&
    (snapshot.profile === "novice" || snapshot.profile === "intermediate") &&
    snapshot.beliefs &&
    CONCEPT_ORDER.every((concept) => STATUSES.includes(snapshot.beliefs[concept]?.status)),
  );
}

export class TeachableMind {
  readonly profile: AgentProfileId;
  private readonly state: Record<ConceptId, Belief>;
  private readonly now: () => number;
  /** Remarks already made since the board last changed shape, so Bolt does not nag. */
  private readonly raised = new Set<string>();
  private pending: { concept: ConceptId; at: number; nudged?: boolean } | null = null;
  private readonly transitions: Array<{ concept: ConceptId; from: BeliefStatus; to: BeliefStatus; at: number; quality: string }> = [];

  constructor(options: { profile?: AgentProfileId; restored?: MindSnapshot | null; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    const requested = options.profile ?? "novice";
    // Saved memory is used only if it is well formed and from the same study profile.
    const restored = isSnapshot(options.restored) && options.restored.profile === requested ? options.restored : null;
    this.profile = requested;
    const base = AGENT_PROFILES[this.profile];
    this.state = {
      loop: { ...{ status: base.loop }, ...restored?.beliefs.loop },
      strips: { ...{ status: base.strips }, ...restored?.beliefs.strips },
      resistor: { ...{ status: base.resistor }, ...restored?.beliefs.resistor },
    };
  }

  belief(concept: ConceptId): Belief {
    return { ...this.state[concept] };
  }

  knows(concept: ConceptId): boolean {
    return this.state[concept].status === "taught";
  }

  /** What Bolt will build: a partially taught idea is not yet trusted. */
  layoutBeliefs(): LayoutBeliefs {
    return { strips: this.knows("strips"), loop: this.knows("loop"), resistor: this.knows("resistor") };
  }

  /** Concepts Bolt still gets wrong, in the order its plan exposes them. */
  naiveConcepts(): ConceptId[] {
    return CONCEPT_ORDER.filter((concept) => !this.knows(concept));
  }

  /** Forget which remarks were made, e.g. after a test or a phase change. */
  resetRemarks(): void {
    this.raised.clear();
  }

  /**
   * Interpret one chat message. `addressed` says the speaker is talking to Bolt even without
   * naming it (e.g. the only human in the room); otherwise commands and bare follow-up
   * explanations need "Bolt" or "you" so human-to-human chat doesn't steer it.
   */
  hear(text: string, teacher: string, options: { addressed?: boolean } = {}): HearResult {
    const raw = text.trim();
    const t = raw.toLowerCase();
    const result: HearResult = { replies: [], learned: [], commands: [] };
    if (!t) return result;

    const causal = CAUSAL.test(t);
    const mentioned = CONCEPT_ORDER.filter((concept) => CONCEPTS[concept].keywords.test(t));
    const isQuestion = t.includes("?") || /^(why|how|what|can|could|do|does|is|are|should)\b/.test(t) || /까\s*\??$/.test(t);
    const asksWhy = ASKS_WHY.test(t);
    const addressed = options.addressed === true || ADDRESSED.test(t);

    if (!addressed) {
      // Commands below need to be meant for Bolt.
    } else if (/\b(you build|you be the builder|you('| a)re the builder|your turn to build)\b|네가 만들/.test(t)) {
      result.commands.push("become-builder");
    } else if (/\b(you check|you verify|you('| a)re the (checker|verifier)|i('| wi)ll build)\b|네가 확인/.test(t)) {
      result.commands.push("become-verifier");
    }
    if (addressed && /\b(rebuild|build it|try (it )?again|go ahead|fix it|your turn)\b|다시 (만들|해)|고쳐/.test(t)) {
      result.commands.push("rebuild");
    }

    // Questions never teach ("Is the resistor safe?" is not an explanation). A "why" question
    // about Bolt's own choices gets its reasoning.
    if (isQuestion) {
      if (!asksWhy) return result;
      const about = mentioned[0] ?? this.naiveConcepts()[0];
      if (about && !this.knows(about)) {
        result.replies.push(`Here's what I was thinking: ${CONCEPTS[about].naiveThought} Is that wrong?`);
        this.pending = { concept: about, at: this.now() };
        result.asked = about;
      } else if (about) {
        result.replies.push(`You taught me that ${CONCEPTS[about].restate}`);
      } else {
        result.replies.push("I followed what you've taught me so far. Is something still off?");
      }
      return result;
    }

    // A reply to Bolt's last "why?" may explain without repeating the keyword.
    const pendingConcept = this.pending && this.now() - this.pending.at < PENDING_WINDOW_MS ? this.pending.concept : null;
    if (
      pendingConcept &&
      mentioned.length === 0 &&
      (CONCEPTS[pendingConcept].mechanism.test(t) || (causal && addressed))
    ) {
      mentioned.push(pendingConcept);
    }

    // A bare "because" explains the idea only when the message is about one idea; with
    // several, each needs its own mechanism words. Incidental mentions next to an
    // explained idea are ignored, and Bolt asks "why" about one idea at a time.
    const explains = (concept: ConceptId): boolean =>
      CONCEPTS[concept].mechanism.test(t) || (causal && mentioned.length === 1);
    const anyExplained = mentioned.some((concept) => explains(concept) && !this.knows(concept));
    let askedWhy = false;
    for (const concept of mentioned) {
      const copy = CONCEPTS[concept];
      const belief = this.state[concept];
      const explained = explains(concept);
      if (!explained && belief.status !== "taught" && (anyExplained || askedWhy)) continue;
      if (belief.status === "taught") {
        if (anyExplained) continue;
        result.replies.push(`Right — I remember: ${copy.restate}`);
        continue;
      }
      if (explained) {
        this.setStatus(concept, "taught", "explained", { quote: raw.slice(0, 240), taughtBy: teacher });
        result.learned.push({ concept, from: belief.status, to: "taught", quality: "explained", teacher });
        result.replies.push(`Oh, I get it now: ${copy.restate} I'll remember that.`);
        if (this.pending?.concept === concept) this.pending = null;
      } else {
        if (belief.status === "naive") {
          this.setStatus(concept, "partial", "named", { taughtBy: teacher });
          result.learned.push({ concept, from: "naive", to: "partial", quality: "named", teacher });
        }
        result.replies.push(copy.askWhy);
        this.pending = { concept, at: this.now() };
        result.asked = concept;
        askedWhy = true;
      }
    }

    if (result.replies.length === 0 && addressed && pendingConcept && this.pending && !this.pending.nudged && result.commands.length === 0) {
      this.pending.nudged = true;
      result.replies.push(`Hmm, I'm not sure I follow yet. Can you say more about the ${CONCEPTS[pendingConcept].label}?`);
    }
    return result;
  }

  describePlan(explain: boolean): string {
    const beliefs = this.layoutBeliefs();
    const order = ["the battery", ...(beliefs.resistor ? ["the resistor"] : []), "the LED", ...(beliefs.loop ? ["a wire back to the battery"] : [])];
    let text = `My plan: ${order.join(" → ")}.`;
    if (explain) {
      const thoughts = this.naiveConcepts().map((concept) => CONCEPTS[concept].naiveThought);
      if (thoughts.length) text += ` ${thoughts.join(" ")}`;
    }
    return text;
  }

  /**
   * As verifier, Bolt reacts to a teammate's build: it questions what contradicts its naive
   * ideas, and applies what it was taught. One remark at a time, each made once per change.
   */
  reviewBoard(analysis: CircuitAnalysis, describe: (pair: [string, string]) => string): BoardRemark | null {
    const candidates: BoardRemark[] = [];
    for (const concept of CONCEPT_ORDER) {
      const copy = CONCEPTS[concept];
      if (!this.knows(concept)) {
        if (concept === "resistor" && analysis.resistorPlaced) candidates.push({ concept, kind: "conflict", text: copy.conflict("") });
        if (concept === "loop" && analysis.bothBatteryTerminalsUsed) candidates.push({ concept, kind: "conflict", text: copy.conflict("") });
        if (concept === "strips" && analysis.columnBridges.length) candidates.push({ concept, kind: "conflict", text: copy.conflict(describe(analysis.columnBridges[0])) });
        continue;
      }
      if (concept === "strips" && analysis.rowNeighbors.length) {
        candidates.push({ concept, kind: "applied", text: `Wait — ${describe(analysis.rowNeighbors[0])} sit side by side in one row. You taught me rows aren't connected, so are they actually joined?` });
      }
      if (concept === "resistor" && analysis.unsafeLeds.length) {
        candidates.push({ concept, kind: "applied", text: "The LED is straight across the battery with no resistor in its path. You taught me that could burn it out — should we add one?" });
      }
      if (concept === "loop" && analysis.batteryPlaced && analysis.placed.length >= 3 && !analysis.bothBatteryTerminalsUsed) {
        candidates.push({ concept, kind: "applied", text: "Nothing reaches the other side of the battery yet. You taught me the current has to come back around — where does it return?" });
      }
    }
    const remark = candidates.find((candidate) => !this.raised.has(`${candidate.kind}:${candidate.concept}:${candidate.text}`));
    if (!remark) return null;
    this.raised.add(`${remark.kind}:${remark.concept}:${remark.text}`);
    if (remark.kind === "conflict") this.pending = { concept: remark.concept, at: this.now() };
    return remark;
  }

  /** Bolt's reaction after the team powers the circuit. */
  reactToTest(analysis: CircuitAnalysis, builtByBolt: boolean, explain: boolean): string {
    if (analysis.powered) {
      if (analysis.unsafeLeds.length) {
        if (this.knows("resistor")) {
          return "It lights — but there's no resistor in the loop. You taught me too much current could burn the LED out. Should we add one?";
        }
        return explain
          ? `It lights! So the LED was fine right on the battery? ${CONCEPTS.resistor.naiveThought}`
          : "It lights! So we're done?";
      }
      if (!this.knows("resistor")) {
        this.pending = { concept: "resistor", at: this.now() };
        return "It lights! But I still don't get why we needed the resistor.";
      }
      return "It lights, and the resistor is in the loop — that matches what you taught me.";
    }
    if (builtByBolt) {
      const naive = this.naiveConcepts();
      if (explain && naive.length) {
        return `Hmm, the LED is dark. What did I get wrong? ${CONCEPTS[naive[0]].naiveThought}`;
      }
      return "Hmm, the LED is dark. What did I get wrong?";
    }
    return "Still dark. Where do you think the path breaks?";
  }

  notebook(): NotebookEntry[] {
    return CONCEPT_ORDER
      .filter((concept) => this.knows(concept) && this.state[concept].quote)
      .map((concept) => ({
        concept,
        label: CONCEPTS[concept].label,
        restatement: CONCEPTS[concept].restate,
        quote: this.state[concept].quote ?? "",
        taughtBy: this.state[concept].taughtBy ?? "A teammate",
      }));
  }

  reflection(): string {
    const entries = this.notebook();
    const unsure = CONCEPT_ORDER.filter((concept) => this.state[concept].status === "partial").map((concept) => CONCEPTS[concept].label);
    if (!entries.length) {
      return unsure.length
        ? `I didn't really learn anything yet — I'm still unsure about the ${unsure.join(" and the ")}. What's one rule I should remember?`
        : "I don't think I learned anything new yet. What's one rule I should remember for next time?";
    }
    const learned = entries.map((entry) => `${entry.label}: ${entry.restatement}`).join(" ");
    const rest = unsure.length ? ` I'm still unsure about the ${unsure.join(" and the ")}.` : "";
    return `Here's what you taught me today. ${learned}${rest}`;
  }

  snapshot(): MindSnapshot {
    return {
      profile: this.profile,
      beliefs: { loop: { ...this.state.loop }, strips: { ...this.state.strips }, resistor: { ...this.state.resistor } },
    };
  }

  /** Research export: belief states and transitions only — no quotes or message bodies. */
  exportState(): { profile: AgentProfileId; beliefs: Record<ConceptId, BeliefStatus>; transitions: Array<{ concept: ConceptId; from: BeliefStatus; to: BeliefStatus; at: number; quality: string }> } {
    return {
      profile: this.profile,
      beliefs: { loop: this.state.loop.status, strips: this.state.strips.status, resistor: this.state.resistor.status },
      transitions: [...this.transitions],
    };
  }

  private setStatus(concept: ConceptId, status: BeliefStatus, quality: string, extra: Partial<Belief> = {}): void {
    const from = this.state[concept].status;
    this.state[concept] = { ...this.state[concept], ...extra, status, changedAt: this.now() };
    this.transitions.push({ concept, from, to: status, at: this.now(), quality });
  }
}
