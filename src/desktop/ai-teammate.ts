/**
 * Bolt, the AI teammate: a teachable agent that joins the room as a real participant.
 *
 * Bolt opens its own `DesktopRoom` connection, so every claim, move, chat line, readiness
 * change and trace it produces travels the same path as a remote human's — the host's scene
 * applies Bolt's moves through `applyRemoteTransform`, and human–human and human–AI sessions
 * share one log schema. What Bolt believes lives in `TeachableMind`; this file only decides
 * when to speak and act. Bolt is hosted by one human's browser tab and leaves with it.
 */
import {
  DesktopRoom,
  type ActivityTrace,
  type CollaborationPhase,
  type CollaborationRole,
  type Participant,
  type RoomChatMessage,
  type SharedTransform,
  type StudioChoice,
} from "./collaboration.js";
import {
  analyzeCircuit,
  CIRCUIT_PARTS,
  partLabel,
  planCircuitLayout,
  type CircuitAnalysis,
  type CircuitPlacements,
  type SocketPair,
} from "./circuit-topology.js";
import {
  CONCEPTS,
  TeachableMind,
  type AgentProfileId,
  type LearningEvent,
  type MindSnapshot,
} from "./teachable-agent.js";

export const AI_TEAMMATE_NAME = "Bolt";
/** Activity detail Bolt shows while composing a message; the chat renders it as "typing". */
export const TYPING_DETAIL = "Typing…";

const CIRCUIT_IDS: string[] = [
  CIRCUIT_PARTS.battery,
  ...CIRCUIT_PARTS.resistors,
  ...CIRCUIT_PARTS.leds,
  ...CIRCUIT_PARTS.wires,
];

/** What Bolt needs from the human tab that hosts it. */
export interface TeammateHost {
  roomCode: string;
  authId: string;
  studio(): StudioChoice;
  phase(): CollaborationPhase;
  transforms(): Record<string, SharedTransform>;
  placementTransform(componentId: string, sockets: SocketPair): SharedTransform | null;
  homeTransform(componentId: string): SharedTransform | null;
  yieldComponent(componentId: string): void;
  /** True when someone other than Bolt holds the part or either of its cable ends. */
  isHeldByOther(componentId: string): boolean;
  saveAttempt(summary: string): void;
  /** Bolt took a role, so a lone human can take the other one. */
  onRole(role: CollaborationRole): void;
  /** Bolt's beliefs or notebook changed. */
  onChange(): void;
}

export interface TeammateOptions {
  profile: AgentProfileId;
  /** Voice its own (naive) reasoning unprompted. Off in the PF condition. */
  explain: boolean;
  role: CollaborationRole;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

export class AiTeammate {
  readonly room: DesktopRoom;
  readonly mind: TeachableMind;
  private readonly host: TeammateHost;
  private readonly options: TeammateOptions;
  private readonly timers = new Set<number>();
  private participants: Participant[] = [];
  private speaking: Promise<void> = Promise.resolve();
  private buildRun = 0;
  /** The build run currently moving parts, if any. */
  private activeRun: number | null = null;
  /** The parts on the board are the way Bolt last left them. */
  private builtByBolt = false;
  private workDone = false;
  private reviewTimer = 0;
  /** Bolt reacts to phases only after its greeting, so it doesn't talk over itself on join. */
  private started = false;
  private enteredKey = "";
  /** One-time lines already said this session, so Bolt never repeats its prompts. */
  private readonly said = new Set<string>();
  private lastPlan = "";
  /** A build was announced and hasn't finished yet; a restart carries on without re-announcing. */
  private buildAnnounced = false;
  private disposed = false;

  constructor(host: TeammateHost, options: TeammateOptions) {
    this.host = host;
    this.options = options;
    this.mind = new TeachableMind({ profile: options.profile, restored: this.loadMemory() });
    this.room = new DesktopRoom(
      host.roomCode,
      AI_TEAMMATE_NAME,
      {
        onParticipants: (next) => {
          this.participants = next;
          this.maybeReady();
        },
        onChat: (message) => this.onChat(message),
        onPhase: (phase) => this.enterPhase(phase),
        onTrace: (trace) => this.onTrace(trace),
        onTransform: (componentId, _transform, participantId) => this.onBoardChange(componentId, participantId),
        onStudio: () => {
          this.cancelBuild();
          this.later(400, () => this.enterPhase(this.host.phase()));
        },
      },
      host.authId,
      { agent: true },
    );
    this.room.setRole(options.role);
    this.host.onRole(options.role);
    this.later(900, () => {
      const remembered = this.mind.notebook().length > 0;
      void this.say(
        remembered
          ? `Hi again! I'm ${AI_TEAMMATE_NAME}. I still remember what you taught me.`
          : `Hi! I'm ${AI_TEAMMATE_NAME}. I'm still learning circuits, so I'll make mistakes — tell me what's wrong and why, and I'll remember.`,
      );
      this.started = true;
      this.enterPhase(this.host.phase());
    });
  }

  get id(): string {
    return this.room.participant.id;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.buildRun += 1;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    window.clearTimeout(this.reviewTimer);
    this.room.close();
  }

  // ── Listening ────────────────────────────────────────────────────────────────

  private onChat(message: RoomChatMessage): void {
    if (this.disposed || message.participantId === this.id) return;
    const speaker = this.participants.find((participant) => participant.id === message.participantId);
    if (!speaker || speaker.kind === "agent") return;
    if (this.host.studio() !== "circuit") {
      if (/\bbolt\b|볼트/i.test(message.body)) this.sayOnce(`elsewhere:${this.host.studio()}`, "I only know the Circuit Bench so far, so you lead here.");
      return;
    }

    // With a single human in the room, everything they say is addressed to Bolt.
    const humans = this.participants.filter((participant) => participant.kind !== "agent").length;
    const heard = this.mind.hear(message.body, speaker.name, { addressed: humans <= 1 });
    this.saveMemory();
    for (const event of heard.learned) this.trace("teach", teachTrace(event));
    for (const reply of heard.replies) void this.say(reply, heard.asked ? `Asked ${speaker.name} why` : undefined);

    for (const command of heard.commands) {
      if (command === "become-builder" && this.room.participant.role !== "builder") {
        this.setRole("builder");
        void this.say("Okay, I'll build. You check my work.");
      } else if (command === "become-verifier" && this.room.participant.role !== "verifier") {
        this.setRole("verifier");
        this.said.add("verifier-intro");
        void this.say("Okay, you build. I'll ask when something surprises me.");
      }
    }

    const learnedSomething = heard.learned.some((event) => event.to === "taught" && event.from !== "taught");
    const wantsBuild = heard.commands.includes("rebuild") || heard.commands.includes("become-builder");
    // A builder fixes its own build as soon as it is taught; otherwise it waits to be asked.
    const fixOwnBuild = learnedSomething && (this.builtByBolt || this.building || this.host.phase() === "build");
    if (this.room.participant.role === "builder" && (wantsBuild || fixOwnBuild)) this.scheduleBuild(1600);
    if (heard.learned.length) this.host.onChange();
  }

  private onTrace(trace: ActivityTrace): void {
    if (this.disposed || trace.participantId === this.id) return;
    if (trace.action !== "test" || this.host.studio() !== "circuit") return;
    this.later(1100, () => {
      void this.say(this.mind.reactToTest(this.analyze(), this.builtByBolt, this.options.explain));
      this.mind.resetRemarks();
    });
    this.later(900, () => {
      if (this.room.participant.ready) this.room.setReady(false);
      this.workDone = this.room.participant.role === "verifier" || (this.builtByBolt && !this.building);
    });
  }

  private onBoardChange(componentId: string, participantId: string): void {
    if (this.disposed || participantId === this.id || !CIRCUIT_IDS.includes(componentId.split("::")[0])) return;
    this.builtByBolt = false;
    if (this.room.participant.role !== "verifier" || !["build", "test"].includes(this.host.phase())) return;
    window.clearTimeout(this.reviewTimer);
    this.reviewTimer = window.setTimeout(() => this.review(), 2600);
  }

  // ── Acting ───────────────────────────────────────────────────────────────────

  private enterPhase(phase: CollaborationPhase): void {
    if (this.disposed || !this.started) return;
    // The room re-announces the current phase to newcomers; only a real change counts.
    const key = `${this.host.studio()}:${phase}`;
    if (key === this.enteredKey) return;
    this.enteredKey = key;
    this.mind.resetRemarks();

    if (this.host.studio() !== "circuit") {
      this.workDone = true;
      this.sayOnce(`studio:${this.host.studio()}`, "I've only learned the Circuit Bench so far. I'll watch here, and mark ready when you do.");
      this.maybeReady();
      return;
    }
    const builder = this.room.participant.role === "builder";
    this.workDone = !builder || (this.builtByBolt && !this.building);

    if (phase === "frame") {
      if (builder) this.sayPlan();
      else this.sayOnce("verifier-plan", "What's your plan? Walk me through it and I'll check each step.");
    } else if (phase === "build") {
      if (builder) this.scheduleBuild(1200);
      else {
        this.sayOnce("verifier-intro", "Okay, you build. I'll ask when something surprises me.");
        this.later(2600, () => this.review());
      }
    } else if (phase === "reflect") {
      void this.say(this.mind.reflection());
      this.workDone = true;
    }
    // Test: Bolt never rebuilds here, so it can't undo a teammate's fix just before the test.
    this.maybeReady();
  }

  private sayPlan(): void {
    const plan = this.mind.describePlan(this.options.explain);
    if (plan === this.lastPlan) return;
    this.lastPlan = plan;
    void this.say(`${plan} Does that sound right?`);
  }

  private review(): void {
    if (this.disposed || this.host.studio() !== "circuit") return;
    const remark = this.mind.reviewBoard(this.analyze(), ([a, b]) => `${partLabel(a)} and ${partLabel(b)}`);
    this.saveMemory();
    if (!remark) return;
    void this.say(remark.text, remark.kind === "conflict" ? "Asked about the build" : "Applied what it was taught");
  }

  private scheduleBuild(delay: number): void {
    const run = ++this.buildRun;
    this.later(delay, () => void this.build(run));
  }

  /** Stop any build in progress, e.g. when Bolt changes role or the studio changes. */
  private cancelBuild(): void {
    this.buildRun += 1;
    this.buildAnnounced = false;
  }

  private get building(): boolean {
    return this.activeRun !== null;
  }

  private async build(run: number): Promise<void> {
    if (this.disposed || run !== this.buildRun) return;
    // This run supersedes any older one; it alone clears the flag when it ends.
    const superseding = this.activeRun !== null;
    this.activeRun = run;
    try {
      await this.runBuild(run, superseding);
    } finally {
      if (this.activeRun === run) {
        this.activeRun = null;
        if (!this.disposed) {
          this.room.setActivity("available");
          this.maybeReady();
        }
      }
    }
  }

  private async runBuild(run: number, superseding: boolean): Promise<void> {
    if (this.host.studio() !== "circuit" || this.room.participant.role !== "builder") return;
    const current = this.placements();
    const plan = planCircuitLayout(this.mind.layoutBeliefs());
    const planned = new Map(plan.map((part) => [part.id, part.sockets] as const));
    const moves: Array<{ id: string; transform: SharedTransform }> = [];
    for (const id of CIRCUIT_IDS) {
      if (current[id] && !planned.has(id)) {
        const home = this.host.homeTransform(id);
        if (home) moves.push({ id, transform: home });
      }
    }
    for (const part of plan) {
      const existing = current[part.id];
      if (existing && existing[0] === part.sockets[0] && existing[1] === part.sockets[1]) continue;
      const transform = this.host.placementTransform(part.id, part.sockets);
      if (transform) moves.push({ id: part.id, transform });
    }
    if (moves.length === 0) {
      this.builtByBolt = true;
      this.workDone = true;
      this.buildAnnounced = false;
      if (!superseding) void this.say("The board already matches how I'd build it.");
      return;
    }

    this.workDone = false;
    if (this.room.participant.ready) this.room.setReady(false);
    // One announcement per build; a build restarted mid-way just carries on quietly.
    if (!superseding && !this.buildAnnounced) {
      this.buildAnnounced = true;
      await this.say(this.builtByBolt || this.said.has("built")
        ? "Let me rebuild with what you taught me."
        : "I'll build my plan now.");
    }
    if (this.disposed || run !== this.buildRun) return;
    this.room.setActivity("moving", "Building its plan");

    let skipped = 0;
    for (const move of moves) {
      if (this.disposed || run !== this.buildRun || this.host.studio() !== "circuit") return;
      if (this.host.isHeldByOther(move.id)) {
        skipped += 1;
        continue;
      }
      const name = partLabel(move.id);
      this.host.yieldComponent(move.id);
      // Grab (the host renders Bolt's hand on the part), carry, then let go.
      this.room.claim(move.id);
      this.trace("claim", { objectId: move.id, objectName: name });
      await sleep(650);
      if (this.disposed) return;
      if (run !== this.buildRun) {
        this.room.release(move.id);
        return;
      }
      this.room.sendTransform(move.id, move.transform);
      await sleep(900);
      if (this.disposed) return;
      this.room.release(move.id);
      this.trace("move", { objectId: move.id, objectName: name });
      await sleep(350);
    }
    if (this.disposed || run !== this.buildRun) return;

    this.said.add("built");
    this.buildAnnounced = false;
    this.builtByBolt = skipped === 0;
    this.workDone = true;
    this.host.saveAttempt(`${AI_TEAMMATE_NAME} built its plan`);
    void this.say(skipped
      ? "Someone was holding a part, so I left it. Have a look, then we can test."
      : "Done. Have a look, then we can test.");
  }

  private maybeReady(): void {
    if (this.disposed || !this.workDone || this.building || this.room.participant.ready) return;
    const humanReady = this.participants.some((participant) => participant.kind !== "agent" && participant.ready);
    if (!humanReady && this.host.phase() !== "test") return;
    this.later(700, () => {
      if (this.disposed || this.room.participant.ready || !this.workDone || this.building) return;
      this.room.setReady(true);
      this.trace("ready", { detail: "Marked ready to test" });
    });
  }

  private setRole(role: CollaborationRole): void {
    this.cancelBuild();
    this.room.setRole(role);
    this.trace("role", { detail: `Became ${role}` });
    this.workDone = role === "verifier" || this.builtByBolt;
    if (role === "builder" && this.room.participant.ready) this.room.setReady(false);
    this.host.onRole(role);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Chat as Bolt, one line at a time, with a short "typing" pause. */
  private say(text: string, detail?: string): Promise<void> {
    this.speaking = this.speaking.then(async () => {
      if (this.disposed) return;
      this.room.setActivity("discussing", TYPING_DETAIL);
      await sleep(Math.min(500 + text.length * 14, 2000));
      if (this.disposed) return;
      this.room.sendChat(text);
      this.trace("discuss", { detail: detail ?? "Room discussion" });
      this.room.setActivity(this.building ? "moving" : "available", this.building ? "Building its plan" : undefined);
    });
    return this.speaking;
  }

  private sayOnce(key: string, text: string): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    void this.say(text);
  }

  private trace(action: ActivityTrace["action"], details: Pick<ActivityTrace, "objectId" | "objectName" | "detail"> = {}): void {
    if (this.disposed) return;
    this.room.recordTrace(action, this.host.phase(), this.host.studio(), details);
  }

  private placements(): CircuitPlacements {
    const transforms = this.host.transforms();
    const placements: CircuitPlacements = {};
    for (const id of CIRCUIT_IDS) {
      const sockets = transforms[id]?.sockets;
      placements[id] = sockets && Number.isInteger(sockets[0]) && Number.isInteger(sockets[1])
        ? [sockets[0] as number, sockets[1] as number]
        : null;
    }
    return placements;
  }

  private analyze(): CircuitAnalysis {
    return analyzeCircuit(this.placements());
  }

  private later(ms: number, task: () => void): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) task();
    }, ms);
    this.timers.add(timer);
  }

  private loadMemory(): MindSnapshot | null {
    try {
      const raw = localStorage.getItem(memoryKey(this.host.roomCode, this.host.authId));
      return raw ? (JSON.parse(raw) as MindSnapshot) : null;
    } catch {
      return null;
    }
  }

  private saveMemory(): void {
    try {
      localStorage.setItem(memoryKey(this.host.roomCode, this.host.authId), JSON.stringify(this.mind.snapshot()));
    } catch {
      // Memory is a convenience; Bolt still works for this session without it.
    }
  }
}

/** Bolt remembers per learner and room, so the next person at a shared machine starts fresh. */
function memoryKey(roomCode: string, authId: string): string {
  return `vm-agent:${roomCode}:${authId}`;
}

/** Trace text for a belief change. It names the idea only once the team has taught it. */
function teachTrace(event: LearningEvent): Pick<ActivityTrace, "objectId" | "objectName" | "detail"> {
  const label = CONCEPTS[event.concept].label;
  const detail = event.quality === "explained"
    ? `Learned from ${event.teacher}: ${label.toLowerCase()}`
    : event.quality === "named"
      ? `Asked ${event.teacher} why`
      : `Took ${event.teacher}'s idea on board`;
  return { objectId: `concept:${event.concept}`, objectName: event.quality === "explained" ? label : undefined, detail };
}

/** Forget what Bolt was taught in a room by this learner (the notebook's "Reset" control). */
export function forgetAiTeammate(roomCode: string, authId: string): void {
  try {
    localStorage.removeItem(memoryKey(roomCode, authId));
  } catch {
    // ignore
  }
}
