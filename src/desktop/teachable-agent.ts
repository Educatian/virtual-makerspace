/**
 * Teachable-agent mind for Bolt, the AI teammate (Betty's Brain-style learning by teaching).
 *
 * Bolt starts with naive ideas and only changes them when a teammate *teaches* it: states the
 * correct idea and why. A bare instruction earns a "why?"; a wrong explanation is taken at
 * face value ("that's what I thought too"), never corrected, so Bolt cannot leak hints into a
 * Productive Failure session. It never learns from the simulator on its own.
 *
 * Teaching is read clause by clause: each clause is checked for the concept's subject, its
 * mechanism, and negation, so "rows aren't connected" teaches while "rows are connected" or
 * "you don't need a resistor" do not. Everything here is deterministic and free of DOM /
 * three.js; `ai-teammate.ts` feeds it chat and board analyses and acts on what it returns.
 */
import type { CircuitAnalysis, LayoutBeliefs } from "./circuit-topology.js";

export type ConceptId = "loop" | "strips" | "resistor";
/** naive: holds the misconception · partial: told what, not why · taught: told why. */
export type BeliefStatus = "naive" | "partial" | "taught";
export type AgentProfileId = "novice" | "intermediate";

export interface Belief {
  status: BeliefStatus;
  /** The teammate's own words when the idea was taught (kept locally, never exported). */
  quote?: string;
  /** Who taught it; absent when Bolt started out knowing the idea. */
  taughtBy?: string;
  changedAt?: number;
}

/** How a clause bears on a concept. */
type Stance = "correct" | "wrong" | "mention";

interface ConceptCopy {
  /** Sentence-case name, shown in the notebook once the idea is taught. */
  label: string;
  /** Bolt's naive reasoning, voiced when asked (or unprompted outside PF). */
  naiveThought: string;
  /** Asked when a teammate names the idea without saying why. */
  askWhy: string;
  /** Asked as verifier when a teammate's build contradicts Bolt's naive idea. */
  conflict: (parts: string) => string;
  /** Short restatement once taught; never more than what a correct explanation implies. */
  learned: string;
  /** "...that <recall>", used when Bolt applies the idea later. */
  recall: string;
  /** What Bolt says it is unsure about, without naming the answer. */
  unsure: string;
  /** Reply when a teammate affirms the naive idea. */
  agree: string;
  mention: RegExp;
  /**
   * How one clause bears on the idea. `fault` says the message explains what is wrong
   * ("it's dark because the current doesn't come back"), where a negated mechanism describes
   * the fault rather than denying the rule.
   */
  read: (clause: string, negated: boolean, fault: boolean) => Stance | null;
}

/** Negation that flips a clause. "Unless / otherwise / without" are reasons, not negation. */
const NEGATION = /\b(not|no|never|none)\b|n't\b|\bcannot\b|안 |않|없|아니/;
const CONDITIONAL = /\b(unless|otherwise|or else|without|if (it|you|we|they) (do|does)n'?t)\b|않으면|안 그러면|없으면|아니면/;
/** The message diagnoses a fault, so negation in it describes what's missing. */
const FAULT = /\b(because|since|that'?s why|which is why|so (it|the led)|unless|otherwise|dark|no power|(won'?t|doesn'?t|isn'?t|can'?t) (light|work|turn on))\b|때문|그래서|안 켜|불이 안/;
const CLAUSE_SPLIT = /[.!?;:—–]|,\s*(?:but|and|so|the|it|they|while)\b|\bbut\b|하지만|그런데/;

const CONNECT = /(connect|join|link|share|wired|tied|연결|이어|통해)/;
const BURN = /\b(burn\w*|blow\w*|fry|fries|fried|damag\w*|break\w*|overload\w*|too much)\b|타(버|서|지|면|요|$)|탈 ?수|터(져|지)|망가|과전류|너무 많/;

export const CONCEPTS: Record<ConceptId, ConceptCopy> = {
  strips: {
    label: "Column strips",
    naiveThought: "I think holes next to each other in a row are connected, like a line.",
    askWhy: "Why would that connect them? I thought holes in a row were connected.",
    conflict: (parts) => `How are ${parts} connected? They're in different rows.`,
    learned: "So parts only connect when they share a column. Got it.",
    recall: "parts only connect when they share a column",
    unsure: "how the holes are connected",
    agree: "So holes in a row are connected? That's what I thought too.",
    // A row alone isn't a topic ("move it up one row"); rows count when connection is the point.
    mention: /\b(columns?|vertical(ly)?|up and down|strips?)\b|세로|같은 열|\b(rows?|horizontal(ly)?|side by side)\b.*(connect|join|link)|(connect|join|link).*\b(rows?|horizontal(ly)?|side by side)\b|가로.*(연결|이어)/,
    read(clause, negated, fault) {
      if (/\b(share|same|different) (a |the |one )?(column|strip)s?\b|같은 (열|세로)|다른 (열|세로)/.test(clause)) {
        const different = /\bdifferent\b|다른/.test(clause);
        // "not in the same column" is the reason it fails; "they don't need the same column" denies the rule.
        return negated && !fault && !different ? "wrong" : "correct";
      }
      const column = /\b(columns?|vertical(ly)?|up and down|strips?)\b|세로/.test(clause);
      const row = /\b(rows?|horizontal(ly)?|side by side|across)\b|가로|옆/.test(clause);
      if (!CONNECT.test(clause)) return column ? "mention" : null;
      if (column && !row) return negated && !fault ? "wrong" : "correct";
      if (row && !column) return negated ? "correct" : "wrong";
      // Both named in one clause ("columns, not rows"): read by which one is negated.
      if (column && row) return /\bnot (across |along |in )?(a |the )?rows?\b|가로.*(안|않)/.test(clause) ? "correct" : "mention";
      return null;
    },
  },
  loop: {
    label: "Complete loop",
    naiveThought: "I think one wire from the battery to the LED is enough, since the battery pushes power out.",
    askWhy: "Why does that matter? I thought one wire from the battery to the LED was enough.",
    conflict: () => "Why is something connected to both sides of the battery? I thought one side was enough.",
    learned: "So the current has to come back to the battery. Got it.",
    recall: "the current has to come back to the battery",
    unsure: "where the current goes after the LED",
    agree: "So one connection from the battery is enough? That's what I thought too.",
    mention: /\b(loop|circle|(one|a single) (wire|side|connection) is enough|(complete|closed|full|whole) (circuit|path)|return (path|wire)|path back|all the way around|(flows?|goes|go|travels?|runs?) (all the way )?around|back (in)?to (the )?(battery|other side|negative|minus)|(both|other) (sides?|ends?|terminals?)( of the battery)?|negative (side|terminal|end)|minus (side|terminal|end))\b|고리|루프|한 바퀴|반대쪽|양쪽|음극|마이너스|배터리로 돌아|돌아와/,
    read(clause, negated, fault) {
      // The idea needs a mechanism; "the loop" on its own (or "the loop is broken") is a topic, not a reason.
      // The current's journey, not just where a wire goes: "connect it back to the battery" says what, not why.
      const mechanism = /\b((complete|closed|full|whole) (loop|circuit|path)|in a loop|around (a|the) (loop|circuit)|all the way around|(current|electricity|power|it|electrons?|charge) (has to |needs to |must |should |can |doesn'?t |does not |won'?t |can'?t |never )?(flows?|goes|go|travels?|comes?|come|gets?|get|runs?|returns?|return) (all the way )?(back|around|to)|path back|(flows?|travels?|runs?) (all the way )?(back|around)|(flows?|goes|travels?|runs?)\b[^,;]*\bback (in)?to\b|returns? to (the )?(battery|other side|negative|minus))\b|고리|루프|닫힌|한 바퀴|돌아(와|가|오)/;
      const denies = /\b(do|does)(n'?t| not) (need|have) to (come|go|get|flow|run) (back|around)|\bno need (for|to)\b|\b(one|a single) (wire|side|connection) is enough\b|\bdon'?t need (a |the )?(loop|return)\b|한쪽만|안 돌아와도/;
      if (denies.test(clause)) return "wrong";
      if (!mechanism.test(clause)) return this.mention.test(clause) ? "mention" : null;
      // "It's dark because the current doesn't come back" describes the fault: still the rule.
      if (negated && !fault) return "mention";
      return "correct";
    },
  },
  resistor: {
    label: "Series resistor",
    naiveThought: "I think extra parts just slow things down, so the LED can go right on the battery.",
    askWhy: "What does the resistor actually do for the LED?",
    conflict: () => "Why add the resistor? I'd have put the LED straight on the battery.",
    learned: "So the resistor keeps too much current from reaching the LED. Got it.",
    recall: "the resistor keeps too much current from reaching the LED",
    unsure: "what the resistor is for",
    agree: "So the LED is fine without it? That's what I thought too.",
    mention: /\bresistors?\b|저항/,
    read(clause, negated) {
      const dismissive = /\b(do|does)(n'?t| not) need (a |the )?resistor|\bno need for (a |the )?resistor|resistor (is|'s) (not needed|useless|unnecessary|optional|pointless)|resistors? (does|do|will|would)(n'?t| not) (do|matter|help|limit|protect|change|reduce)|resistors? (protects?|limits?|does) nothing|\b(fine|okay|ok) without (a |the )?resistor|저항(은|이|는)? ?(필요 ?없|없어도|안 ?필요|의미 ?없)/;
      if (dismissive.test(clause)) return "wrong";
      const mechanism = /\b(limit\w*|reduc\w*|lower\w*|less current|control\w* (the )?current|protect\w*|safe\w*|prevent\w*)\b|제한|줄여|줄이|막아|보호/;
      // Burn-out talk is naturally negated ("so it doesn't burn out"), so negation doesn't flip it.
      if (BURN.test(clause)) return "correct";
      if (mechanism.test(clause)) return negated ? "wrong" : "correct";
      return this.mention.test(clause) ? "mention" : null;
    },
  },
};

const CONCEPT_ORDER: ConceptId[] = ["strips", "loop", "resistor"];

const ASKS_WHY = /\b(why|how come|explain|reason|what were you thinking)\b|왜|이유/;
/** The message speaks to Bolt rather than to another human. */
const ADDRESSED = /\b(bolt|you|your)\b|볼트|너(?!무)|네가/;
/** First-person plans ("I'll fix it") are not requests for Bolt to act. */
const FIRST_PERSON = /\b(i'?ll|i will|i'?m going to|let me|i can|we'?ll|we will)\b|내가|제가/;

export const AGENT_PROFILES: Record<AgentProfileId, Record<ConceptId, BeliefStatus>> = {
  novice: { loop: "naive", strips: "naive", resistor: "naive" },
  intermediate: { loop: "taught", strips: "naive", resistor: "naive" },
};

export type AgentCommand = "rebuild" | "become-builder" | "become-verifier";

export interface LearningEvent {
  concept: ConceptId;
  from: BeliefStatus;
  to: BeliefStatus;
  /** explained: taught with a reason · named: told what, not why · affirmed-naive: told the misconception. */
  quality: "explained" | "named" | "affirmed-naive";
  teacher: string;
}

export interface HearResult {
  replies: string[];
  learned: LearningEvent[];
  commands: AgentCommand[];
  /** Concept Bolt asked "why" about in this reply, if any. */
  asked?: ConceptId;
}

interface Transition {
  concept: ConceptId;
  from: BeliefStatus;
  to: BeliefStatus;
  at: number;
  quality: string;
}

export interface MindSnapshot {
  profile: AgentProfileId;
  beliefs: Record<ConceptId, Belief>;
  transitions?: Transition[];
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

function clauses(text: string): Array<{ text: string; negated: boolean }> {
  return text
    .split(CLAUSE_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ text: part, negated: NEGATION.test(part) && !CONDITIONAL.test(part) }));
}

/** The strongest stance any clause takes on the concept: wrong outranks correct outranks mention. */
function stanceOn(concept: ConceptId, text: string): Stance | null {
  let stance: Stance | null = null;
  const fault = FAULT.test(text);
  for (const clause of clauses(text)) {
    const read = CONCEPTS[concept].read(clause.text, clause.negated, fault);
    if (read === "wrong") return "wrong";
    if (read === "correct") stance = "correct";
    else if (read === "mention" && !stance) stance = "mention";
  }
  return stance;
}

export class TeachableMind {
  readonly profile: AgentProfileId;
  private readonly state: Record<ConceptId, Belief>;
  private readonly now: () => number;
  /** Remarks already made since the board last changed shape, so Bolt does not nag. */
  private readonly raised = new Set<string>();
  private pending: { concept: ConceptId; at: number; nudged?: boolean } | null = null;
  /** When Bolt last asked "why" about each idea, so it asks once, not on every mention. */
  private readonly askedAt = new Map<ConceptId, number>();
  private readonly transitions: Transition[];

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
    this.transitions = Array.isArray(restored?.transitions) ? restored.transitions.slice(-200) : [];
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
   * naming it (e.g. the only human in the room). Unaddressed talk can still teach Bolt, but
   * never triggers questions, nudges or commands.
   */
  hear(text: string, teacher: string, options: { addressed?: boolean } = {}): HearResult {
    const raw = text.trim();
    const t = raw.toLowerCase();
    const result: HearResult = { replies: [], learned: [], commands: [] };
    if (!t) return result;

    const addressed = options.addressed === true || ADDRESSED.test(t);
    const question = t.includes("?") || /^(why|how|what|where|when|which|can|could|would|will|do|does|did|is|are|should)\b/.test(t) || /까\s*\??$/.test(t);

    if (addressed) {
      // Read commands clause by clause: "you build, I'll check" is a command plus a plan.
      for (const part of t.split(/[,.;!?]|\band\b|그리고/).map((piece) => piece.trim()).filter(Boolean)) {
        if (FIRST_PERSON.test(part)) {
          if (/\b(i'?ll|let me|i will) (check|verify|watch|look)\b|내가 (확인|볼)/.test(part)) result.commands.push("become-builder");
          else if (/\b(i'?ll|let me|i will) build\b|내가 만들/.test(part)) result.commands.push("become-verifier");
          continue;
        }
        const ask = /^(bolt,? )?(can|could|would|will) you (please )?/.test(part);
        if (question && !ask) continue;
        if (/\b(you build|you('re| are) the builder|be the builder|your turn to build)\b|네가 만들|너가 만들/.test(part) || (ask && /\byou (please )?(re)?build\b/.test(part))) {
          result.commands.push("become-builder");
        } else if (!ask && /\b(you check|you verify|you('re| are) the (checker|verifier))\b|네가 확인|너가 확인/.test(part)) {
          result.commands.push("become-verifier");
        }
        if (/\b(rebuild|build it|try (it )?again|go ahead|fix it|your turn)\b|다시 (만들어|해 ?봐|해줘)|고쳐 ?(봐|줘)/.test(part) || (ask && /\byou (please )?(re)?build\b/.test(part))) {
          result.commands.push("rebuild");
        }
      }
      result.commands = [...new Set(result.commands)];
      if (result.commands.includes("become-builder") && result.commands.includes("become-verifier")) {
        result.commands = result.commands.filter((command) => command !== "become-verifier");
      }
    }

    // Questions never teach ("Is the resistor safe?" is not an explanation).
    if (question) {
      if (!ASKS_WHY.test(t) || !addressed) return result;
      const about = CONCEPT_ORDER.find((concept) => CONCEPTS[concept].mention.test(t)) ?? this.naiveConcepts()[0];
      if (about && !this.knows(about)) {
        // Asked again soon after: Bolt sticks to its idea rather than repeating itself word for word.
        const recently = this.askedAt.has(about) && this.now() - (this.askedAt.get(about) ?? 0) < PENDING_WINDOW_MS;
        result.replies.push(recently
          ? "That's still what I think. What makes you think it's wrong?"
          : `${CONCEPTS[about].naiveThought} Is that wrong?`);
        this.pending = { concept: about, at: this.now() };
        this.askedAt.set(about, this.now());
        result.asked = about;
      } else if (about) {
        result.replies.push(`${this.source(about)} ${CONCEPTS[about].recall}.`);
      } else {
        result.replies.push("I followed what you've taught me so far. Is something still off?");
      }
      return result;
    }

    const pendingConcept = this.pending && this.now() - this.pending.at < PENDING_WINDOW_MS ? this.pending.concept : null;
    const stances = new Map<ConceptId, Stance>();
    for (const concept of CONCEPT_ORDER) {
      const stance = stanceOn(concept, t);
      // A reason counts only for an idea the message is about, or the one Bolt just asked about.
      const about = CONCEPTS[concept].mention.test(t) || concept === pendingConcept;
      if (stance && (about || stance === "mention")) stances.set(concept, stance);
    }

    for (const [concept, stance] of stances) {
      if (stance === "mention") continue;
      const copy = CONCEPTS[concept];
      const belief = this.state[concept];
      if (stance === "correct") {
        if (belief.status === "taught") continue;
        this.setStatus(concept, "taught", "explained", { quote: raw.slice(0, 240), taughtBy: teacher });
        result.learned.push({ concept, from: belief.status, to: "taught", quality: "explained", teacher });
        result.replies.push(copy.learned);
        if (this.pending?.concept === concept) this.pending = null;
      } else {
        // A teammate affirmed the naive idea: Bolt takes it at face value and never corrects.
        if (belief.status === "taught") {
          const who = !belief.taughtBy || belief.taughtBy === teacher ? "you" : belief.taughtBy;
          result.replies.push(belief.quote
            ? `Wait — earlier ${who} said "${shorten(belief.quote)}". Which is it?`
            : `Hmm, I thought ${copy.recall}. Which is it?`);
          continue;
        }
        this.transitions.push({ concept, from: belief.status, to: belief.status, at: this.now(), quality: "affirmed-naive" });
        result.learned.push({ concept, from: belief.status, to: belief.status, quality: "affirmed-naive", teacher });
        result.replies.push(copy.agree);
        if (this.pending?.concept === concept) this.pending = null;
      }
    }
    if (result.replies.length > 0) return result;

    // Named but not explained: ask why, once per idea, and only when spoken to.
    if (!addressed) return result;
    const named = CONCEPT_ORDER.find((concept) => stances.get(concept) === "mention" && !this.knows(concept));
    if (named) {
      const belief = this.state[named];
      if (belief.status === "naive") {
        this.setStatus(named, "partial", "named", { taughtBy: teacher });
        result.learned.push({ concept: named, from: "naive", to: "partial", quality: "named", teacher });
      }
      const lastAsked = this.askedAt.get(named);
      if (lastAsked === undefined || this.now() - lastAsked > PENDING_WINDOW_MS) {
        result.replies.push(CONCEPTS[named].askWhy);
        this.askedAt.set(named, this.now());
        this.pending = { concept: named, at: this.now() };
        result.asked = named;
      }
      return result;
    }

    // A reply to Bolt's "why?" that doesn't explain anything: one gentle nudge, no hints.
    if (pendingConcept && this.pending && !this.pending.nudged && result.commands.length === 0) {
      this.pending.nudged = true;
      result.replies.push("Hmm, I'm not sure I follow. Can you tell me why?");
    }
    return result;
  }

  /** Bolt's plan in one line; outside PF it also voices the first idea it would get wrong. */
  describePlan(explain: boolean): string {
    const beliefs = this.layoutBeliefs();
    const order = ["battery", ...(beliefs.resistor ? ["resistor"] : []), "LED", ...(beliefs.loop ? ["back to the battery"] : [])];
    const naive = this.naiveConcepts()[0];
    const thought = explain && naive ? ` ${CONCEPTS[naive].naiveThought}` : "";
    return `My plan: ${order.join(" → ")}.${thought}`;
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
      const source = this.source(concept);
      if (concept === "strips" && analysis.rowNeighbors.length) {
        candidates.push({ concept, kind: "applied", text: `Wait — ${describe(analysis.rowNeighbors[0])} sit side by side in one row. ${source} ${copy.recall}, so are they actually joined?` });
      }
      if (concept === "resistor" && analysis.unsafeLeds.length) {
        candidates.push({ concept, kind: "applied", text: `The LED is straight across the battery. ${source} ${copy.recall} — should we add one?` });
      }
      if (concept === "loop" && analysis.batteryPlaced && analysis.placed.length >= 3 && !analysis.bothBatteryTerminalsUsed) {
        candidates.push({ concept, kind: "applied", text: `Nothing reaches the other side of the battery yet. ${source} ${copy.recall} — where does it return?` });
      }
    }
    const remark = candidates.find((candidate) => !this.raised.has(`${candidate.kind}:${candidate.concept}:${candidate.text}`));
    if (!remark) return null;
    this.raised.add(`${remark.kind}:${remark.concept}:${remark.text}`);
    if (remark.kind === "conflict") {
      this.pending = { concept: remark.concept, at: this.now() };
      this.askedAt.set(remark.concept, this.now());
    }
    return remark;
  }

  /** Bolt's reaction after the team powers the circuit. */
  reactToTest(analysis: CircuitAnalysis, builtByBolt: boolean, explain: boolean): string {
    if (analysis.powered) {
      if (analysis.unsafeLeds.length) {
        if (this.knows("resistor")) {
          return `It lights — but there's no resistor in the loop. ${this.source("resistor")} ${CONCEPTS.resistor.recall}. Should we add one?`;
        }
        return explain
          ? `It lights! So the LED was fine right on the battery? ${CONCEPTS.resistor.naiveThought}`
          : "It lights! So we're done?";
      }
      if (!this.knows("resistor")) {
        this.pending = { concept: "resistor", at: this.now() };
        this.askedAt.set("resistor", this.now());
        return "It lights! But I still don't get why we needed the resistor.";
      }
      return "It lights, and the resistor is in the loop. That matches what I know now.";
    }
    if (builtByBolt) {
      const naive = this.naiveConcepts();
      return explain && naive.length
        ? `Hmm, the LED is dark. What did I get wrong? ${CONCEPTS[naive[0]].naiveThought}`
        : "Hmm, the LED is dark. What did I get wrong?";
    }
    return "Still dark. Where do you think the path breaks?";
  }

  notebook(): NotebookEntry[] {
    return CONCEPT_ORDER
      .filter((concept) => this.knows(concept) && this.state[concept].quote)
      .map((concept) => ({
        concept,
        label: CONCEPTS[concept].label,
        restatement: CONCEPTS[concept].recall,
        quote: this.state[concept].quote ?? "",
        taughtBy: this.state[concept].taughtBy ?? "A teammate",
      }));
  }

  reflection(): string {
    const learned = this.notebook().map((entry) => entry.restatement);
    const unsure = CONCEPT_ORDER.filter((concept) => !this.knows(concept)).map((concept) => CONCEPTS[concept].unsure);
    const tail = unsure.length ? ` I'm still not sure about ${joinList(unsure)}.` : "";
    if (!learned.length) return `I don't think I learned anything new yet.${tail} What's one rule I should remember?`;
    const opening = `Here's what I learned today: ${joinList(learned)}.`;
    return `${opening.charAt(0).toUpperCase()}${opening.slice(1)}${tail}`;
  }

  snapshot(): MindSnapshot {
    return {
      profile: this.profile,
      beliefs: { loop: { ...this.state.loop }, strips: { ...this.state.strips }, resistor: { ...this.state.resistor } },
      transitions: this.transitions.slice(-200),
    };
  }

  /** Research export: belief states and transitions only — no quotes or message bodies. */
  exportState(): { profile: AgentProfileId; beliefs: Record<ConceptId, BeliefStatus>; transitions: Transition[] } {
    return {
      profile: this.profile,
      beliefs: { loop: this.state.loop.status, strips: this.state.strips.status, resistor: this.state.resistor.status },
      transitions: [...this.transitions],
    };
  }

  /** "You taught me" for taught ideas; "I know" for ideas Bolt started with. */
  private source(concept: ConceptId): string {
    return this.state[concept].taughtBy ? "You taught me that" : "I know that";
  }

  private setStatus(concept: ConceptId, status: BeliefStatus, quality: string, extra: Partial<Belief> = {}): void {
    const from = this.state[concept].status;
    this.state[concept] = { ...this.state[concept], ...extra, status, changedAt: this.now() };
    this.transitions.push({ concept, from, to: status, at: this.now(), quality });
  }
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function shorten(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77).trimEnd()}…` : text;
}
