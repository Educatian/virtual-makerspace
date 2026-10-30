/**
 * Client-side rules for keeping one shared bench consistent. Pure (no DOM, sockets or
 * three.js), so scripts/sync-check.mjs can drive several replicas against the real room core
 * (cloudflare/room-core.js) with arbitrary message delays.
 *
 * Server mode (Worker or local relay):
 *   - Edits (value changes, undo/redo, import, reset, return to tray, demos, switch toggles,
 *     restores, program upload/stop) are NOT applied when made. They go to the room with the
 *     revision of each part (and of the program) this client last saw; the room accepts or
 *     refuses the whole batch. The sender applies it only on acceptance, and every client
 *     applies accepted edits in the room's order, so all end identical.
 *   - Live drags need a granted claim. Refused moves come back with the room's authoritative
 *     state, which replaces the sender's local guess (even if the holder has since
 *     disconnected) — unless a newer move of the sender's is still in flight, which then decides.
 *   - A drag "counts" (history, move trace) only once every move of it was acknowledged.
 *   - Joiners take the room's authoritative state, revisions, claims and program.
 * Peer mode (same-device tabs over BroadcastChannel, no server): edits and moves apply
 *   immediately and carry a Lamport stamp; each part keeps the highest stamp it has seen, so
 *   concurrent changes converge to the same winner on every tab.
 */
import type { SharedTransform } from "./collaboration.js";
import type { SnapinoStatement } from "./snapino.ts";

export type SyncMode = "server" | "peer";

export interface EditChange {
  componentId: string;
  transform: SharedTransform;
}

export interface EditProgram {
  program: SnapinoStatement[];
  running: boolean;
}

/** `conditional: false` = upload/stop that applies whatever the program revision is. */
export type EditProgramRequest = EditProgram & { conditional?: boolean };

/**
 * "invalid": the room's validation refused the batch (a value out of range, an unknown jack, a
 * moved fixture). "occupied": a Sound Flow Studio jack or greenhouse port already holds another
 * plug. "running": a greenhouse day is running, so its rig cannot change (pause first).
 */
export type EditRefusal = "held" | "stale" | "invalid" | "occupied" | "running" | "offline" | "timeout" | "disconnected";
export type EditResult =
  | { ok: true }
  | {
    ok: false;
    reason: EditRefusal;
    holderName?: string;
    componentId?: string;
    /**
     * "timeout" only: the edit is still pending (see `expire`), and this resolves exactly once
     * with the room's late answer — accepted, refused, or "disconnected" if the socket closed first.
     */
    later?: Promise<EditResult>;
  };

export type Stamp = [number, string];

export type SyncEffect =
  /**
   * `propsOnly`: this client has its own moves of the part in flight, which the room ordered
   * after this change — keep the local position, take only electrical values / switch state.
   */
  | { type: "apply"; componentId: string; transform: SharedTransform; force: boolean; propsOnly?: boolean }
  | { type: "program"; program: SnapinoStatement[]; running: boolean; participantId: string }
  | { type: "resolve"; opId: string; result: EditResult }
  /**
   * The room's state of a part replaces this client's local guess. `superseded`: this client
   * still has later moves of the part in flight (sent after a new claim); those decide, so keep
   * the local position and take only values — the last one's ack or refusal settles it.
   */
  | { type: "revert"; componentId: string; transform: SharedTransform | null; holderName?: string; superseded?: boolean; reason?: "occupied" | "running" }
  | { type: "claim-denied"; componentId: string; holderName: string }
  | { type: "claim-result"; resourceId: string; granted: boolean }
  /** Every move of a released drag was answered: `ok` if none was refused. */
  | { type: "settled"; componentId: string; ok: boolean }
  | { type: "claims"; claims: Array<{ componentId: string; participantId: string; participantName: string }> }
  /**
   * The room's full state follows as "apply" effects. Parts not listed are at their defaults in
   * the room — except `ownMovesInFlight`, which this client's own later moves will decide.
   * `fresh`: the room has no bench state at all (new, or everyone had left).
   */
  | { type: "room-state"; fresh: boolean; componentIds: string[]; ownMovesInFlight: string[] };

const later = (a: Stamp, b: Stamp | undefined): boolean => !b || a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const partOf = (resourceId: string): string => resourceId.split("::")[0];

interface PendingEdit {
  changes: EditChange[];
  program?: EditProgram;
  /** The sender stopped waiting; a late answer still applies so this client matches the room. */
  expired?: boolean;
}

type Incoming = Record<string, unknown> & { kind?: unknown };

export class SyncReplica {
  readonly participantId: string;
  readonly mode: SyncMode;
  readonly revs = new Map<string, number>();
  programRev = 0;
  /** True once the room sent its authoritative state (server mode); peer state-responses are then ignored. */
  hasRoomState = false;
  private lamport = 0;
  private readonly stamps = new Map<string, Stamp>();
  private readonly pending = new Map<string, PendingEdit>();
  /** Own live moves sent but not yet acknowledged, per part (server mode). */
  private readonly unacked = new Map<string, number>();
  /** Parts whose current hold had a move or claim refused. */
  private readonly refused = new Set<string>();
  /** Released parts waiting for their last moves to be answered. */
  private readonly settling = new Set<string>();

  constructor(participantId: string, mode: SyncMode) {
    this.participantId = participantId;
    this.mode = mode;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Builds the message for an edit batch, plus what to do locally right away (peer mode only). */
  createEdit(opId: string, changes: EditChange[], program?: EditProgramRequest): { message: Record<string, unknown>; immediate: SyncEffect[] } {
    const shared = program ? { program: program.program, running: program.running } : undefined;
    if (this.mode === "server") {
      this.pending.set(opId, { changes, program: shared });
      return {
        message: {
          kind: "edit",
          participantId: this.participantId,
          opId,
          changes: changes.map(({ componentId, transform }) => ({ componentId, transform, expectRev: this.revs.get(componentId) ?? 0 })),
          ...(shared ? { program: { ...shared, expectRev: program?.conditional === false ? null : this.programRev } } : {}),
        },
        immediate: [],
      };
    }
    const stamp = this.nextStamp();
    const immediate: SyncEffect[] = [];
    for (const change of changes) {
      this.stamps.set(change.componentId, stamp);
      immediate.push({ type: "apply", componentId: change.componentId, transform: change.transform, force: true });
    }
    if (shared) {
      this.stamps.set("program", stamp);
      immediate.push({ type: "program", ...shared, participantId: this.participantId });
    }
    immediate.push({ type: "resolve", opId, result: { ok: true } });
    return { message: { kind: "edit", participantId: this.participantId, opId, stamp, changes, ...(shared ? { program: shared } : {}) }, immediate };
  }

  private nextStamp(): Stamp {
    this.lamport += 1;
    return [this.lamport, this.participantId];
  }

  /** Peer mode: the stamp for an outgoing live move (the sender's own state is already applied). */
  stampTransform(componentId: string): Stamp {
    const stamp = this.nextStamp();
    this.stamps.set(componentId, stamp);
    return stamp;
  }

  /** Peer mode: whether a teammate's live move is newer than anything this tab has for the part. */
  acceptTransform(componentId: string, stamp: unknown): boolean {
    if (!Array.isArray(stamp) || typeof stamp[0] !== "number" || !Number.isSafeInteger(stamp[0]) || typeof stamp[1] !== "string") return true;
    const value: Stamp = [stamp[0], stamp[1]];
    this.lamport = Math.max(this.lamport, value[0]);
    if (!later(value, this.stamps.get(componentId))) return false;
    this.stamps.set(componentId, value);
    return true;
  }

  /** Every pending edit fails (socket closed); the room-state sent on reconnect resynchronizes. */
  failPending(reason: EditRefusal): SyncEffect[] {
    const effects: SyncEffect[] = [...this.pending.keys()].map((opId) => ({ type: "resolve", opId, result: { ok: false, reason } }));
    this.pending.clear();
    for (const componentId of this.settling) effects.push({ type: "settled", componentId, ok: false });
    this.settling.clear();
    return effects;
  }

  /**
   * A pending edit got no answer in time: the caller stops waiting ("timeout", not recorded),
   * but the edit stays pending — if the room accepted it, the late answer still applies it here
   * exactly as everyone else applied it.
   */
  expire(opId: string): SyncEffect[] {
    const pending = this.pending.get(opId);
    if (!pending || pending.expired) return [];
    pending.expired = true;
    return [{ type: "resolve", opId, result: { ok: false, reason: "timeout" } }];
  }

  /** Peer mode: a joiner adopts the clock of the tab that sent it the bench. */
  observeClock(clock: unknown): void {
    if (typeof clock === "number" && Number.isSafeInteger(clock) && clock > this.lamport) this.lamport = clock;
  }

  /** Peer mode: the clock to hand a joining tab with the bench. */
  get clock(): number {
    return this.lamport;
  }

  /** Lets go of the room's view on disconnect: the next room-state is authoritative again. */
  resetForReconnect(): void {
    this.hasRoomState = false;
    this.unacked.clear();
    this.refused.clear();
  }

  /** A claim for `resourceId` was sent: a new hold of the part starts with a clean slate. */
  beginHold(resourceId: string): void {
    this.refused.delete(partOf(resourceId));
  }

  /** A live move of `componentId` was sent; the room will acknowledge or refuse it. */
  noteOwnTransform(componentId: string): void {
    if (this.mode !== "server") return;
    this.unacked.set(componentId, (this.unacked.get(componentId) ?? 0) + 1);
  }

  /**
   * The part was released. Returns whether the hold stood (no refused move or claim), or null
   * if moves are still unanswered — a "settled" effect follows when they are.
   */
  settleRelease(componentId: string): boolean | null {
    if (this.mode !== "server") return true;
    if (!this.unacked.has(componentId)) return !this.refused.has(componentId);
    this.settling.add(componentId);
    return null;
  }

  private settleOwn(componentId: string, effects: SyncEffect[]): void {
    const count = (this.unacked.get(componentId) ?? 0) - 1;
    if (count > 0) {
      this.unacked.set(componentId, count);
      return;
    }
    this.unacked.delete(componentId);
    if (this.settling.delete(componentId)) effects.push({ type: "settled", componentId, ok: !this.refused.has(componentId) });
  }

  /**
   * Anything the room sends about a part while this client's own moves of it are unacknowledged
   * was accepted before those moves (the room relays in order, and nobody else can change a part
   * this client holds), so only its values apply; the position is about to be replaced.
   */
  private applyEffect(componentId: string, transform: SharedTransform, force: boolean): SyncEffect {
    return this.unacked.has(componentId)
      ? { type: "apply", componentId, transform, force, propsOnly: true }
      : { type: "apply", componentId, transform, force };
  }

  private revertEffect(componentId: string, transform: SharedTransform | null, holderName?: string): SyncEffect {
    return this.unacked.has(componentId)
      ? { type: "revert", componentId, transform, holderName, superseded: true }
      : { type: "revert", componentId, transform, holderName };
  }

  receive(raw: Incoming): SyncEffect[] {
    const kind = raw.kind;
    const effects: SyncEffect[] = [];
    const rev = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
    switch (kind) {
      case "transform": {
        const componentId = String(raw.componentId);
        const next = rev(raw.rev);
        if (next !== null) this.revs.set(componentId, next);
        const transform = raw.transform as SharedTransform;
        // A teammate's cable-end move only touches that end (which they hold, so not one this
        // client is moving): it applies even while this client moves the other end.
        effects.push(transform?.activeEndpoint === 0 || transform?.activeEndpoint === 1
          ? { type: "apply", componentId, transform, force: false }
          : this.applyEffect(componentId, transform, false));
        break;
      }
      case "rev-ack": {
        const componentId = String(raw.componentId);
        const next = rev(raw.rev);
        if (next !== null) this.revs.set(componentId, next);
        this.settleOwn(componentId, effects);
        break;
      }
      case "transform-rejected": {
        const componentId = String(raw.componentId);
        this.refused.add(componentId);
        const next = rev(raw.rev);
        if (next !== null) this.revs.set(componentId, next);
        // Only moves sent after this one may outrank the room's state.
        const count = this.unacked.get(componentId) ?? 0;
        const transform = (raw.transform as SharedTransform | null) ?? null;
        const holderName = typeof raw.holderName === "string" ? raw.holderName : undefined;
        const reason = raw.reason === "occupied" ? "occupied" as const : raw.reason === "running" ? "running" as const : undefined;
        effects.push(count > 1
          ? { type: "revert", componentId, transform, holderName, superseded: true, ...(reason ? { reason } : {}) }
          : { type: "revert", componentId, transform, holderName, ...(reason ? { reason } : {}) });
        this.settleOwn(componentId, effects);
        break;
      }
      case "claim-granted": {
        effects.push({ type: "claim-result", resourceId: String(raw.componentId), granted: true });
        break;
      }
      case "claim-denied": {
        const resourceId = String(raw.componentId);
        const holderName = typeof raw.holderName === "string" ? raw.holderName : "";
        effects.push({ type: "claim-denied", componentId: resourceId, holderName });
        effects.push({ type: "claim-result", resourceId, granted: false });
        // Whatever this client already did to the part locally is replaced by the room's state.
        if (typeof raw.partId === "string") {
          this.refused.add(raw.partId);
          const next = rev(raw.rev);
          if (next !== null) this.revs.set(raw.partId, next);
          effects.push(this.revertEffect(raw.partId, (raw.transform as SharedTransform | null) ?? null, holderName));
        }
        break;
      }
      case "edit": {
        const participantId = String(raw.participantId);
        const changes = Array.isArray(raw.changes) ? (raw.changes as Array<{ componentId: string; transform: SharedTransform; rev?: number }>) : [];
        const program = raw.program as (EditProgram & { rev?: number }) | undefined;
        if (this.mode === "server") {
          for (const change of changes) {
            const next = rev(change.rev);
            if (next !== null) this.revs.set(change.componentId, next);
            effects.push(this.applyEffect(change.componentId, change.transform, true));
          }
          if (program) {
            const next = rev(program.rev);
            if (next !== null) this.programRev = next;
            effects.push({ type: "program", program: program.program, running: program.running, participantId });
          }
          break;
        }
        const stamp = Array.isArray(raw.stamp) && typeof raw.stamp[0] === "number" && typeof raw.stamp[1] === "string" ? (raw.stamp as Stamp) : null;
        if (!stamp) break;
        this.lamport = Math.max(this.lamport, stamp[0]);
        for (const change of changes) {
          if (!later(stamp, this.stamps.get(change.componentId))) continue;
          this.stamps.set(change.componentId, stamp);
          effects.push({ type: "apply", componentId: change.componentId, transform: change.transform, force: true });
        }
        if (program && later(stamp, this.stamps.get("program"))) {
          this.stamps.set("program", stamp);
          effects.push({ type: "program", program: program.program, running: program.running, participantId });
        }
        break;
      }
      case "edit-result": {
        const opId = String(raw.opId);
        const pending = this.pending.get(opId);
        if (!pending) break;
        this.pending.delete(opId);
        if (raw.ok === true) {
          const accepted = Array.isArray(raw.changes) ? (raw.changes as Array<{ componentId: string; rev: number }>) : [];
          for (const entry of accepted) {
            const next = rev(entry.rev);
            if (next !== null) this.revs.set(entry.componentId, next);
          }
          for (const change of pending.changes) effects.push(this.applyEffect(change.componentId, change.transform, true));
          if (pending.program) {
            const next = rev(raw.programRev);
            if (next !== null) this.programRev = next;
            effects.push({ type: "program", ...pending.program, participantId: this.participantId });
          }
          effects.push({ type: "resolve", opId, result: { ok: true } });
        } else {
          for (const entry of Array.isArray(raw.current) ? (raw.current as Array<{ componentId: string; rev: number }>) : []) {
            const next = rev(entry.rev);
            if (next !== null) this.revs.set(entry.componentId, next);
          }
          const programRev = rev(raw.programRev);
          if (programRev !== null) this.programRev = programRev;
          const reason = raw.reason === "held" || raw.reason === "stale" || raw.reason === "invalid" || raw.reason === "occupied" || raw.reason === "running" ? raw.reason : "stale";
          effects.push({
            type: "resolve",
            opId,
            result: { ok: false, reason, holderName: typeof raw.holderName === "string" ? raw.holderName : undefined, componentId: typeof raw.componentId === "string" ? raw.componentId : undefined },
          });
        }
        break;
      }
      case "room-state": {
        this.hasRoomState = true;
        const transforms = raw.transforms && typeof raw.transforms === "object" ? (raw.transforms as Record<string, { transform: SharedTransform; rev: number }>) : {};
        const ids = Object.keys(transforms).filter((componentId) => transforms[componentId]?.transform);
        // Parts the room does not list are at revision 0 there (e.g. after the room reset).
        for (const componentId of [...this.revs.keys()]) if (!ids.includes(componentId)) this.revs.set(componentId, 0);
        effects.push({ type: "room-state", fresh: raw.fresh === true, componentIds: ids, ownMovesInFlight: [...this.unacked.keys()] });
        for (const componentId of Object.keys(transforms)) {
          const entry = transforms[componentId];
          const next = rev(entry?.rev);
          if (next !== null) this.revs.set(componentId, next);
          if (entry?.transform) effects.push(this.applyEffect(componentId, entry.transform, true));
        }
        const programRev = rev(raw.programRev);
        if (programRev !== null) this.programRev = programRev;
        const program = raw.program as EditProgram | undefined;
        if (program && Array.isArray(program.program) && typeof program.running === "boolean") {
          effects.push({ type: "program", program: program.program, running: program.running, participantId: "" });
        }
        const claims = (Array.isArray(raw.claims) ? raw.claims : []).filter((claim): claim is { componentId: string; participantId: string; participantName: string } =>
          Boolean(claim) && typeof claim.componentId === "string" && typeof claim.participantId === "string" && typeof claim.participantName === "string");
        effects.push({ type: "claims", claims });
        break;
      }
      case "program": {
        // A legacy direct upload relayed by the room: everyone applies it in the room's order.
        const next = rev(raw.programRev);
        if (next !== null) this.programRev = next;
        if (Array.isArray(raw.program) && typeof raw.running === "boolean") {
          effects.push({ type: "program", program: raw.program as SnapinoStatement[], running: raw.running, participantId: String(raw.participantId) });
        }
        break;
      }
      case "program-ack": {
        const next = rev(raw.programRev);
        if (next !== null) this.programRev = next;
        break;
      }
      default:
        break;
    }
    return effects;
  }
}
