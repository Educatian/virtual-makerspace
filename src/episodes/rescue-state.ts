/**
 * Rescue Signal Workshop — the room's authoritative episode state and the only way it
 * changes (a pure reducer). The room server (cloudflare/room-core.js, for the Durable Object
 * and the local relay) applies every action here, in arrival order, with its own clock; same
 * device tabs without a server apply it locally (see DesktopRoom). Everything the episode
 * shows — whose turn it is, the running transmission, the receiver's reading, the comparison,
 * completion and traces — is derived from this state with the pure functions in
 * rescue-signal.ts, so all participants see the same thing.
 *
 * Timing: a transmission stores the server time it started (`startedAt`) and its length.
 * Nothing on the server ticks: "running" means now < startedAt + duration and not stopped.
 * Clients render it from the elapsed time the server reports with every update (see
 * `elapsedMs` in DesktopRoom), so a late joiner or a reconnecting tab lands at the right point.
 */
import { OUTPUT_PINS, sanitizeProgram, type SnapinoStatement } from "../desktop/snapino.ts";
import { SNAPINO_PART_IDS, SNAPINO_SOCKET_COUNT, SNAPINO_SWITCH, type SnapinoBench } from "../circuit/snapino-circuit.ts";
import { isMission, isWord, MAX_TRANSMISSION_MS, MAX_WORDS, MISSIONS, programDurationMs, type Reading, type Word } from "./rescue-signal.ts";

export const EPISODE_ID = "rescue-signal";
/** v2: rounds carry a transmission id (`tx`); revisions never restart (also not on reset). */
export const EPISODE_STATE_VERSION = 2;
export const MAX_HISTORY = 12;
export const MAX_EXPLANATION = 600;

export type Role = "sender" | "receiver";
export interface RoleHolder {
  id: string;
  name: string;
}
export type StopReason = "stopped" | "bench-changed" | "program-changed" | "room-empty" | "reset";
export type BenchSnapshot = Record<string, { sockets: [number | null, number | null] | null; on?: boolean }>;

export interface RescueRound {
  /** Round number shown to learners (restarts at 1 after a reset; never an identity). */
  n: number;
  /**
   * Identity of the CURRENT transmission of this round: the room revision that started it.
   * Revisions only grow (a reset continues them), so a tx is never reused — not by a
   * retransmission, not after a reset. Every action about a round names the tx it was made
   * for; an action for any other transmission is stale.
   */
  tx: number;
  mission: string;
  /** The sender's intention, fixed when the round's first transmission starts. */
  intent: Word[];
  program: SnapinoStatement[];
  /** The Snapino parts as the room had them when this transmission started. */
  bench: BenchSnapshot;
  startedAt: number;
  durationMs: number;
  stoppedAtMs: number | null;
  stopReason: StopReason | null;
  /** How many times this round was transmitted (a retransmission before any reading). */
  transmissions: number;
  /** Participants who transmitted this round. None of them may give its reading (they know the
   * intention), so none may take the receiver role while it is unread. Empty in older states. */
  sentBy: string[];
  /** The receiver's FIRST interpretation; it never changes once given. */
  reading: { words: Reading; confidence: "sure" | "unsure" } | null;
  explanation: string;
}

export interface RescueState {
  episode: typeof EPISODE_ID;
  v: typeof EPISODE_STATE_VERSION;
  rev: number;
  active: boolean;
  roles: { sender: RoleHolder | null; receiver: RoleHolder | null };
  mission: string;
  /** The sender's planned message for the next round. */
  intent: Word[];
  round: RescueRound | null;
  history: RescueRound[];
}

export type RescueAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "claim-role"; role: Role }
  | { type: "release-role"; role: Role }
  | { type: "swap-roles" }
  | { type: "set-design"; mission: string; words: Word[] }
  /** `tx`: the transmission of the open round this repeats, or null for a new round. */
  | { type: "transmit"; program: SnapinoStatement[]; tx: number | null }
  | { type: "stop"; tx: number }
  | { type: "read"; tx: number; words: Reading; confidence: "sure" | "unsure" }
  | { type: "explain"; tx: number; text: string }
  | { type: "close-round"; tx: number }
  | { type: "reset" };

export type RescueRefusal =
  | "not-sender" | "not-receiver" | "not-in-role" | "role-taken" | "one-role" | "transmitting" | "round-open"
  | "no-intent" | "bad-program" | "no-round" | "stale-round" | "not-ended" | "already-read" | "no-reading" | "inactive"
  | "sent-this-round";

export type RescueResult =
  | { ok: true; state: RescueState; program?: { program: SnapinoStatement[]; running: false } }
  | { ok: false; reason: RescueRefusal };

export function initialRescueState(): RescueState {
  return { episode: EPISODE_ID, v: EPISODE_STATE_VERSION, rev: 0, active: false, roles: { sender: null, receiver: null }, mission: MISSIONS[0].id, intent: [], round: null, history: [] };
}

/**
 * Whether a client that holds `held` applies an `episode-state` update `incoming` from the room.
 * Revisions only grow (a reset continues them), so an older revision is a late duplicate and is
 * dropped. (A room-state on join or reconnect replaces the held state unconditionally.)
 */
export const supersedes = (held: RescueState | null, incoming: RescueState): boolean => !held || incoming.rev >= held.rev;

export const transmitting = (state: RescueState, now: number): boolean =>
  Boolean(state.round && state.round.stoppedAtMs === null && now < state.round.startedAt + state.round.durationMs);

export const roleOf = (state: RescueState, participantId: string): Role | null =>
  state.roles.sender?.id === participantId ? "sender" : state.roles.receiver?.id === participantId ? "receiver" : null;

/** The Snapino parts' state as a snapshot (defaults: off the base, switch off). */
export function benchSnapshot(read: (id: string) => { sockets?: unknown; on?: unknown } | null | undefined): BenchSnapshot {
  const snapshot: BenchSnapshot = {};
  for (const id of SNAPINO_PART_IDS) {
    const part = read(id);
    const raw = Array.isArray(part?.sockets) && part.sockets.length === 2 ? part.sockets : null;
    const sockets = raw && raw.every((socket) => socket === null || (Number.isInteger(socket) && (socket as number) >= 0 && (socket as number) < SNAPINO_SOCKET_COUNT))
      ? ([raw[0], raw[1]] as [number | null, number | null])
      : null;
    snapshot[id] = { sockets, ...(id === SNAPINO_SWITCH ? { on: part?.on === true } : {}) };
  }
  return snapshot;
}

export const asCircuitBench = (snapshot: BenchSnapshot): SnapinoBench => snapshot;

// ── Strict validation of untrusted actions ────────────────────────────────────────────────

const ROLES: readonly Role[] = ["sender", "receiver"];
const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);
const isRound = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isTx = isRound;

function sanitizeWords(value: unknown, allowUnknown: boolean): (Word | "?")[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WORDS) return null;
  const words: (Word | "?")[] = [];
  for (const word of value) {
    if (isWord(word) || (allowUnknown && word === "?")) words.push(word);
    else return null;
  }
  return words;
}

/** Returns a clean action or null. Never throws, never coerces. */
export function sanitizeRescueAction(value: unknown): RescueAction | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    switch (raw.type) {
      case "open":
      case "close":
      case "swap-roles":
      case "reset":
        return { type: raw.type };
      case "claim-role":
      case "release-role":
        return isRole(raw.role) ? { type: raw.type, role: raw.role } : null;
      case "set-design": {
        // An empty list is allowed while the sender is still choosing (transmit needs ≥ 1).
        const words = Array.isArray(raw.words) && raw.words.length === 0 ? [] : (sanitizeWords(raw.words, false) as Word[] | null);
        return isMission(raw.mission) && words ? { type: "set-design", mission: raw.mission, words } : null;
      }
      case "transmit": {
        const program = sanitizeProgram(raw.program);
        if (!program) return null;
        return raw.tx === null || isTx(raw.tx) ? { type: "transmit", program, tx: raw.tx } : null;
      }
      case "stop":
      case "close-round":
        return isTx(raw.tx) ? { type: raw.type, tx: raw.tx } : null;
      case "read": {
        const words = sanitizeWords(raw.words, true);
        const confidence = raw.confidence === "sure" || raw.confidence === "unsure" ? raw.confidence : null;
        return isTx(raw.tx) && words && confidence ? { type: "read", tx: raw.tx, words, confidence } : null;
      }
      case "explain":
        return isTx(raw.tx) && typeof raw.text === "string" && raw.text.length <= MAX_EXPLANATION * 2
          ? { type: "explain", tx: raw.tx, text: raw.text.trim().slice(0, MAX_EXPLANATION) }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ── The reducer ──────────────────────────────────────────────────────────────────────────

const ok = (state: RescueState, program?: SnapinoStatement[]): RescueResult => ({
  ok: true,
  state: { ...state, rev: state.rev + 1 },
  ...(program ? { program: { program, running: false } } : {}),
});
const no = (reason: RescueRefusal): RescueResult => ({ ok: false, reason });

/**
 * Applies `action` by `actor` at server time `now`. `bench` reads the room's authoritative
 * part state (used to snapshot the transmitter when a transmission starts).
 */
export function reduceRescue(
  state: RescueState,
  action: RescueAction,
  actor: RoleHolder,
  now: number,
  bench: (id: string) => { sockets?: unknown; on?: unknown } | null | undefined,
): RescueResult {
  const role = roleOf(state, actor.id);
  const running = transmitting(state, now);
  const round = state.round;
  // While a round is unread, whoever transmitted it knows the intention: they may not read it.
  const unread = Boolean(round && !round.reading);
  const sentIt = Boolean(round && round.sentBy.includes(actor.id));
  if (!state.active && action.type !== "open" && action.type !== "reset") return no("inactive");
  switch (action.type) {
    case "open":
      return ok({ ...state, active: true });
    case "close":
      if (running) return no("transmitting");
      return ok({ ...state, active: false });
    case "claim-role": {
      const holder = state.roles[action.role];
      if (holder && holder.id !== actor.id) return no("role-taken");
      if (role && role !== action.role) return no("one-role");
      if (action.role === "receiver" && unread && sentIt) return no("sent-this-round");
      return ok({ ...state, roles: { ...state.roles, [action.role]: { id: actor.id, name: actor.name } } });
    }
    case "release-role":
      if (state.roles[action.role]?.id !== actor.id) return no("not-in-role");
      return ok({ ...state, roles: { ...state.roles, [action.role]: null } });
    case "swap-roles": {
      if (!role) return no("not-in-role");
      if (running) return no("transmitting");
      if (unread) return no("round-open");
      return ok({ ...state, roles: { sender: state.roles.receiver, receiver: state.roles.sender } });
    }
    case "set-design":
      // Only the sender designs the message (with no sender, nobody: a receiver must not choose
      // the message they will read).
      if (role !== "sender") return no("not-sender");
      if (round) return no("round-open");
      return ok({ ...state, mission: action.mission, intent: [...action.words] });
    case "transmit": {
      if (role !== "sender") return no("not-sender");
      if (running) return no("transmitting");
      if (action.tx !== (round?.tx ?? null)) return no("stale-round");
      if (round?.reading) return no("round-open");
      const intent = round ? round.intent : state.intent;
      if (!intent.length) return no("no-intent");
      const durationMs = programDurationMs(action.program);
      if (durationMs <= 0 || durationMs > MAX_TRANSMISSION_MS) return no("bad-program");
      const lastN = round?.n ?? state.history[state.history.length - 1]?.n ?? 0;
      const next: RescueRound = {
        n: round ? round.n : lastN + 1,
        tx: state.rev + 1,
        mission: round ? round.mission : state.mission,
        intent: [...intent],
        program: action.program.map((statement) => ({ ...statement })),
        bench: benchSnapshot(bench),
        startedAt: now,
        durationMs,
        stoppedAtMs: null,
        stopReason: null,
        transmissions: (round?.transmissions ?? 0) + 1,
        sentBy: [...new Set([...(round?.sentBy ?? []), actor.id])].slice(-8),
        reading: null,
        explanation: "",
      };
      return ok({ ...state, round: next }, next.program);
    }
    case "stop":
      if (!round || round.tx !== action.tx) return no("stale-round");
      if (!running) return no("not-ended");
      return ok(stopRound(state, now, "stopped"));
    case "read":
      if (role !== "receiver") return no("not-receiver");
      if (!round) return no("no-round");
      // A reading belongs to the transmission the receiver watched: a reading made for an
      // earlier transmission (before a retransmission or a reset) is refused.
      if (round.tx !== action.tx) return no("stale-round");
      if (running) return no("not-ended");
      if (round.reading) return no("already-read");
      if (sentIt) return no("sent-this-round");
      return ok({ ...state, round: { ...round, reading: { words: [...action.words], confidence: action.confidence } } });
    case "explain":
      if (!role) return no("not-in-role");
      if (!round || round.tx !== action.tx) return no("stale-round");
      if (!round.reading) return no("no-reading");
      return ok({ ...state, round: { ...round, explanation: action.text } });
    case "close-round":
      if (!role) return no("not-in-role");
      if (!round || round.tx !== action.tx) return no("stale-round");
      if (running) return no("transmitting");
      return ok({ ...state, round: null, history: [...state.history, round].slice(-MAX_HISTORY) });
    case "reset":
      // Someone in a role resets (anyone, once nobody holds one); never over a running signal.
      if (running) return no("transmitting");
      if ((state.roles.sender || state.roles.receiver) && !role) return no("not-in-role");
      // The revision continues (clients drop anything older than what they hold, so a restart
      // at 0 would be ignored by everyone already connected), and so do transmission ids.
      return ok({ ...initialRescueState(), rev: state.rev, active: state.active, roles: state.roles, mission: state.mission });
  }
}

function stopRound(state: RescueState, now: number, reason: StopReason): RescueState {
  const round = state.round!;
  return { ...state, round: { ...round, stoppedAtMs: Math.max(0, Math.min(round.durationMs, now - round.startedAt)), stopReason: reason } };
}

/**
 * Server-side hooks. A transmission is a physical run of the transmitter: if the room accepts
 * any change to a Snapino part or the program while it runs, the transmission ends there (so
 * the light everyone saw always matches the snapshot the round records).
 */
export function onTransmitterChanged(state: RescueState, now: number, reason: "bench-changed" | "program-changed"): RescueState | null {
  if (!transmitting(state, now)) return null;
  return { ...stopRound(state, now, reason), rev: state.rev + 1 };
}

/** A participant left: their roles are free again. */
export function onParticipantLeft(state: RescueState, participantId: string): RescueState | null {
  const sender = state.roles.sender?.id === participantId ? null : state.roles.sender;
  const receiver = state.roles.receiver?.id === participantId ? null : state.roles.receiver;
  if (sender === state.roles.sender && receiver === state.roles.receiver) return null;
  return { ...state, roles: { sender, receiver }, rev: state.rev + 1 };
}

/** Everyone left: no roles, and a running transmission ends. Rounds and the design stay. */
export function onRoomEmpty(state: RescueState, now: number): RescueState | null {
  const running = transmitting(state, now);
  if (!running && !state.roles.sender && !state.roles.receiver) return null;
  const stopped = running ? stopRound(state, now, "room-empty") : state;
  return { ...stopped, roles: { sender: null, receiver: null }, rev: state.rev + 1 };
}

/** Validates a full state from storage or a same-device tab; null if anything is off. */
export function sanitizeRescueState(value: unknown): RescueState | null {
  try {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    if (raw.episode !== EPISODE_ID || raw.v !== EPISODE_STATE_VERSION || typeof raw.rev !== "number" || !Number.isSafeInteger(raw.rev) || raw.rev < 0) return null;
    const holder = (entry: unknown): RoleHolder | null | undefined => {
      if (entry === null) return null;
      const item = entry as Record<string, unknown> | undefined;
      return item && typeof item.id === "string" && item.id.length <= 300 && typeof item.name === "string" && item.name.length <= 80 ? { id: item.id, name: item.name } : undefined;
    };
    const roles = raw.roles as Record<string, unknown> | undefined;
    const sender = holder(roles?.sender);
    const receiver = holder(roles?.receiver);
    if (sender === undefined || receiver === undefined || typeof raw.active !== "boolean" || !isMission(raw.mission)) return null;
    const intent = Array.isArray(raw.intent) && raw.intent.length <= MAX_WORDS && raw.intent.every(isWord) ? (raw.intent as Word[]) : null;
    if (!intent || !Array.isArray(raw.history) || raw.history.length > MAX_HISTORY) return null;
    const rounds: RescueRound[] = [];
    for (const entry of [...raw.history, ...(raw.round ? [raw.round] : [])]) {
      const clean = sanitizeRound(entry);
      if (!clean) return null;
      rounds.push(clean);
    }
    const round = raw.round ? rounds.pop()! : null;
    return { episode: EPISODE_ID, v: EPISODE_STATE_VERSION, rev: raw.rev, active: raw.active, roles: { sender, receiver }, mission: raw.mission, intent: [...intent], round, history: rounds };
  } catch {
    return null;
  }
}

function sanitizeRound(value: unknown): RescueRound | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const program = sanitizeProgram(raw.program);
  const intent = Array.isArray(raw.intent) && raw.intent.length >= 1 && raw.intent.length <= MAX_WORDS && raw.intent.every(isWord) ? (raw.intent as Word[]) : null;
  const number = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item);
  if (!isRound(raw.n) || !isTx(raw.tx) || !isMission(raw.mission) || !intent || !program || !number(raw.startedAt) || !number(raw.durationMs)) return null;
  if (raw.durationMs !== programDurationMs(program) || !(raw.stoppedAtMs === null || number(raw.stoppedAtMs))) return null;
  const reasons: (StopReason | null)[] = [null, "stopped", "bench-changed", "program-changed", "room-empty", "reset"];
  if (!reasons.includes(raw.stopReason as StopReason | null) || !isRound(raw.transmissions)) return null;
  const benchRaw = raw.bench as Record<string, { sockets?: unknown; on?: unknown }> | undefined;
  if (!benchRaw || typeof benchRaw !== "object") return null;
  const bench = benchSnapshot((id) => benchRaw[id]);
  let reading: RescueRound["reading"] = null;
  if (raw.reading !== null) {
    const item = raw.reading as Record<string, unknown> | undefined;
    const words = sanitizeWords(item?.words, true);
    if (!words || (item?.confidence !== "sure" && item?.confidence !== "unsure")) return null;
    reading = { words, confidence: item.confidence };
  }
  if (typeof raw.explanation !== "string" || raw.explanation.length > MAX_EXPLANATION) return null;
  const sentBy = raw.sentBy === undefined ? [] : Array.isArray(raw.sentBy) && raw.sentBy.length <= 8 && raw.sentBy.every((id) => typeof id === "string" && id.length <= 300) ? [...(raw.sentBy as string[])] : null;
  if (!sentBy) return null;
  return {
    n: raw.n, tx: raw.tx, mission: raw.mission, intent: [...intent], program, bench, startedAt: raw.startedAt, durationMs: raw.durationMs,
    stoppedAtMs: raw.stoppedAtMs as number | null, stopReason: raw.stopReason as StopReason | null, transmissions: raw.transmissions, sentBy, reading, explanation: raw.explanation,
  };
}

export { OUTPUT_PINS };
