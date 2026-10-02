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
  type MindSnapshot,
} from "./teachable-agent.js";

export const AI_TEAMMATE_NAME = "Bolt";

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
  private readonly joinedAt = Date.now();
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
  private studioNoticeFor: StudioChoice | null = null;
  private disposed = false;

  constructor(host: TeammateHost, options: TeammateOptions) {
    this.host = host;
    this.options = options;
    this.mind = new TeachableMind({ profile: options.profile, restored: this.loadMemory() });
    this.saveMemory();
    this.room = new DesktopRoom(
      host.roomCode,
      AI_TEAMMATE_NAME,
      {
        onParticipants: (next) => {
          this.participants = next;
          this.maybeReady();
        },
        onChat: (message) => this.onChat(message),
        onPhase: (phase) => this.enterPhase(phase, true),
        onTrace: (trace) => this.onTrace(trace),
        onTransform: (componentId, _transform, participantId) => this.onBoardChange(componentId, participantId),
        onStudio: () => this.later(400, () => this.enterPhase(this.host.phase(), true)),
      },
      host.authId,
      { agent: true },
    );
    this.room.setRole(options.role);
    this.later(900, () => {
      const remembered = this.mind.notebook().length > 0;
      void this.say(
        remembered
          ? `Hi again! I'm ${AI_TEAMMATE_NAME}. I still remember what you taught me last time.`
          : `Hi! I'm ${AI_TEAMMATE_NAME}, your AI teammate. I'm still learning circuits, so I'll make mistakes. When I do, teach me why — I'll remember what you tell me.`,
      );
      this.enterPhase(this.host.phase(), false);
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
      if (/\b(bolt)\b/i.test(message.body)) void this.say("I've only learned the Circuit Bench so far — I'll follow your lead here.");
      return;
    }

    // With a single human in the room, everything they say is addressed to Bolt.
    const humans = this.participants.filter((participant) => participant.kind !== "agent").length;
    const heard = this.mind.hear(message.body, speaker.name, { addressed: humans <= 1 });
    this.saveMemory();
    for (const event of heard.learned) {
      this.trace("teach", {
        objectId: `concept:${event.concept}`,
        objectName: CONCEPTS[event.concept].label,
        detail: event.to === "taught"
          ? `Learned "${CONCEPTS[event.concept].label}" from ${event.teacher} (explained)`
          : `Heard "${CONCEPTS[event.concept].label}" from ${event.teacher} without a reason`,
      });
    }
    for (const reply of heard.replies) void this.say(reply, heard.asked ? `Asked why: ${CONCEPTS[heard.asked].label}` : undefined);

    for (const command of heard.commands) {
      if (command === "become-builder" && this.room.participant.role !== "builder") {
        this.setRole("builder");
        void this.say("Okay, I'll build. You check my work.");
      } else if (command === "become-verifier" && this.room.participant.role !== "verifier") {
        this.setRole("verifier");
        void this.say("Okay — you build, and I'll ask about anything I don't understand.");
      }
    }

    const learnedSomething = heard.learned.some((event) => event.to === "taught");
    const wantsBuild = heard.commands.includes("rebuild") || heard.commands.includes("become-builder");
    // A builder fixes its own build as soon as it is taught; otherwise it waits for Build.
    const fixOwnBuild = learnedSomething && (this.builtByBolt || ["build", "test"].includes(this.host.phase()));
    if (this.room.participant.role === "builder" && (wantsBuild || fixOwnBuild)) {
      this.scheduleBuild(1600);
    }
    if (learnedSomething) this.host.onChange();
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

  private enterPhase(phase: CollaborationPhase, changed: boolean): void {
    if (this.disposed) return;
    this.mind.resetRemarks();
    if (this.host.studio() !== "circuit") {
      this.workDone = true;
      if (this.studioNoticeFor !== this.host.studio()) {
        this.studioNoticeFor = this.host.studio();
        void this.say("I've only learned the Circuit Bench so far. I'll watch, and mark ready when you do.");
      }
      this.maybeReady();
      return;
    }
    this.studioNoticeFor = null;
    const builder = this.room.participant.role === "builder";
    this.workDone = !builder || (this.builtByBolt && !this.building);

    if (phase === "frame") {
      void this.say(builder
        ? `${this.mind.describePlan(this.options.explain)} Does that sound right?`
        : "What's your plan? Walk me through it and I'll check each step.");
    } else if (phase === "build") {
      if (builder) this.scheduleBuild(changed ? 1400 : 600);
      else {
        void this.say("Go ahead and build — I'll ask about anything I don't understand.");
        this.later(2600, () => this.review());
      }
    } else if (phase === "test") {
      if (builder && !this.builtByBolt) this.scheduleBuild(600);
    } else if (phase === "reflect") {
      void this.say(this.mind.reflection());
      this.workDone = true;
    }
    this.maybeReady();
  }

  private review(): void {
    if (this.disposed || this.host.studio() !== "circuit") return;
    const remark = this.mind.reviewBoard(this.analyze(), ([a, b]) => `${partLabel(a)} and ${partLabel(b)}`);
    this.saveMemory();
    if (!remark) return;
    void this.say(
      remark.text,
      remark.kind === "conflict"
        ? `Asked about ${CONCEPTS[remark.concept].label}`
        : `Applied what it was taught: ${CONCEPTS[remark.concept].label}`,
    );
  }

  private scheduleBuild(delay: number): void {
    const run = ++this.buildRun;
    this.later(delay, () => void this.build(run));
  }

  private get building(): boolean {
    return this.activeRun !== null;
  }

  private async build(run: number): Promise<void> {
    if (this.disposed || run !== this.buildRun) return;
    // This run supersedes any older one; it alone clears the flag when it ends.
    this.activeRun = run;
    try {
      await this.runBuild(run);
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

  private async runBuild(run: number): Promise<void> {
    if (this.host.studio() !== "circuit") return;
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
      void this.say("The board already matches how I'd build it.");
      return;
    }

    this.workDone = false;
    if (this.room.participant.ready) this.room.setReady(false);
    await this.say(this.builtByBolt
      ? "Let me rebuild with what you taught me."
      : this.options.explain ? `I'll build my plan. ${this.mind.describePlan(true)}` : "I'll build my plan now.");
    if (this.disposed || run !== this.buildRun) return;
    this.room.setActivity("moving", "Building its plan");

    let skipped = 0;
    for (const move of moves) {
      if (this.disposed || run !== this.buildRun) return;
      if (this.host.isHeldByOther(move.id)) {
        skipped += 1;
        continue;
      }
      const name = partLabel(move.id);
      this.host.yieldComponent(move.id);
      // Grab (the host renders Bolt's ghost hand on the part), carry, then let go.
      this.room.claim(move.id);
      this.trace("claim", { objectId: move.id, objectName: name });
      await sleep(550);
      if (this.disposed || run !== this.buildRun) {
        this.room.release(move.id);
        return;
      }
      this.room.sendTransform(move.id, move.transform);
      await sleep(800);
      if (this.disposed) return;
      this.room.release(move.id);
      this.trace("move", { objectId: move.id, objectName: name });
      await sleep(500);
    }
    if (this.disposed || run !== this.buildRun) return;

    this.builtByBolt = skipped === 0;
    this.workDone = true;
    this.host.saveAttempt(`${AI_TEAMMATE_NAME} built its plan`);
    void this.say(skipped
      ? "Someone was holding a part, so I skipped it. Check it over, then we can test."
      : "Done. Check it over, then we can test.");
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
    this.room.setRole(role);
    this.trace("role", { detail: `Became ${role}` });
    this.workDone = role === "verifier" || this.builtByBolt;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Chat as Bolt, one line at a time, with a short "typing" pause. */
  private say(text: string, detail?: string): Promise<void> {
    this.speaking = this.speaking.then(async () => {
      if (this.disposed) return;
      this.room.setActivity("discussing", "Typing…");
      await sleep(Math.min(600 + text.length * 12, 2200));
      if (this.disposed) return;
      this.room.sendChat(text);
      this.trace("discuss", { detail: detail ?? "AI teammate message" });
      if (!this.building) this.room.setActivity("available");
    });
    return this.speaking;
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

  private memoryKey(): string {
    return `vm-agent:${this.host.roomCode}`;
  }

  /** Saved beliefs for this room; the mind ignores them if they don't fit the requested profile. */
  private loadMemory(): MindSnapshot | null {
    try {
      const raw = localStorage.getItem(this.memoryKey());
      return raw ? (JSON.parse(raw) as MindSnapshot) : null;
    } catch {
      return null;
    }
  }

  private saveMemory(): void {
    try {
      localStorage.setItem(this.memoryKey(), JSON.stringify(this.mind.snapshot()));
    } catch {
      // Memory is a convenience; Bolt still works for this session without it.
    }
  }
}

/** Forget what Bolt was taught in a room (used by the "Reset" control). */
export function forgetAiTeammate(roomCode: string): void {
  try {
    localStorage.removeItem(`vm-agent:${roomCode}`);
  } catch {
    // ignore
  }
}
