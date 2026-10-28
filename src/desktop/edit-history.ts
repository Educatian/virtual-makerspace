/**
 * Conflict-safe undo/redo for a shared workbench.
 *
 * Only this participant's own edits that the room ACCEPTED are recorded. Each entry stores,
 * per part, the shared state before and after the edit — and, for a Snapino import, the room
 * program before and after. Undo applies an entry only if every part (and the program) still
 * matches its `after` state: if a teammate (human or Bolt) changed any of them since, the
 * entry is stale and is discarded instead of overwriting their work. Parts currently held by
 * someone else are refused (the entry is kept for later).
 *
 * Undo/redo is two-phase because the room decides: `peek()` checks the newest entry and
 * returns what to submit; `commit()` moves it once the room accepts the edit, `drop()` discards
 * it if the room says it is stale, and anything else (held, offline, timeout) leaves it.
 *
 * Program policy: an entry's program is compared by its statements only (Run/Stop is not an
 * edit), and restoring a program — by undo, redo or import — always leaves it stopped.
 * Pure: no DOM, no three.js.
 */
import type { SharedTransform } from "./collaboration.js";
import type { SnapinoStatement } from "./snapino.ts";

export interface HistoryChange {
  id: string;
  before: SharedTransform;
  after: SharedTransform;
}

export interface ProgramChange {
  before: SnapinoStatement[];
  after: SnapinoStatement[];
}

export interface HistoryEntry {
  label: string;
  changes: HistoryChange[];
  program?: ProgramChange;
}

export type HistoryVerdict =
  | { ok: true; label: string; apply: Array<{ id: string; transform: SharedTransform }>; program?: SnapinoStatement[]; entry: HistoryEntry }
  | { ok: false; reason: "empty" | "stale" | "held"; label?: string; partId?: string };

const LIMIT = 50;

const round = (value: number): number => Math.round(value * 1000) / 1000;
const roundTuple = (tuple: readonly number[] | undefined): string => (tuple ? tuple.map(round).join(",") : "");

/**
 * What an explicit program load (import, restore) must send to the room. The policy is that a
 * loaded program is always stopped, so a stop is sent whenever the room's program is running —
 * even if the statements are identical. Only a statement change is an undo step (Run/Stop is
 * not edit history).
 */
export function planProgramLoad(
  roomProgram: readonly SnapinoStatement[],
  roomRunning: boolean,
  requested: readonly SnapinoStatement[] | undefined,
): { send?: { program: SnapinoStatement[]; running: false }; statementsChanged: boolean; stops: boolean } {
  if (!requested) return { statementsChanged: false, stops: false };
  const statementsChanged = !sameProgram(roomProgram, requested);
  if (!statementsChanged && !roomRunning) return { statementsChanged: false, stops: false };
  return { send: { program: [...requested], running: false }, statementsChanged, stops: roomRunning };
}

/** Whether two programs have the same statements (running state is not part of an edit). */
export function sameProgram(a: readonly SnapinoStatement[] | null | undefined, b: readonly SnapinoStatement[] | null | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * Whether two shared states are the same placement: sockets, electrical values, switch state,
 * and (for unseated parts) position, compared at millimetre precision.
 */
export function sameTransform(a: SharedTransform | null | undefined, b: SharedTransform | null | undefined): boolean {
  if (!a || !b) return a === b;
  const socketsA = a.sockets ?? null;
  const socketsB = b.sockets ?? null;
  if (JSON.stringify(socketsA) !== JSON.stringify(socketsB)) return false;
  // Every value a part carries: a resistor's ohms, a battery's volts, a Sound module's knobs.
  const keys = new Set([...Object.keys(a.props ?? {}), ...Object.keys(b.props ?? {})]) as Set<keyof NonNullable<SharedTransform["props"]>>;
  for (const key of keys) if ((a.props?.[key] ?? null) !== (b.props?.[key] ?? null)) return false;
  if ((a.on ?? null) !== (b.on ?? null)) return false;
  const seated = Array.isArray(socketsA) && socketsA.length === 2 && socketsA.every((socket) => Number.isInteger(socket));
  if (seated) return true;
  if (roundTuple(a.position) !== roundTuple(b.position)) return false;
  if (roundTuple(a.rotation) !== roundTuple(b.rotation)) return false;
  return roundTuple(a.endpoints?.flat()) === roundTuple(b.endpoints?.flat());
}

type Direction = "undo" | "redo";

export class EditHistory {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  /** Records an accepted local edit. No-op changes are dropped; a new edit clears redo. */
  record(label: string, changes: HistoryChange[], program?: ProgramChange): boolean {
    const real = changes.filter((change) => !sameTransform(change.before, change.after));
    const programChanged = program && !sameProgram(program.before, program.after);
    if (!real.length && !programChanged) return false;
    const entry: HistoryEntry = { label, changes: real.map((change) => ({ ...change })) };
    if (programChanged) entry.program = { before: [...program.before], after: [...program.after] };
    this.undoStack.push(entry);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  /**
   * Checks the newest entry in `direction` against the live state without applying it.
   * `current(id)`: the part's present shared state; `heldByOther(id)`: a teammate or Bolt holds
   * it now; `currentProgram()`: the room's program now. A stale entry is discarded here.
   */
  peek(
    direction: Direction,
    current: (id: string) => SharedTransform | null,
    heldByOther: (id: string) => boolean,
    currentProgram: () => readonly SnapinoStatement[] = () => [],
  ): HistoryVerdict {
    const from = direction === "undo" ? this.undoStack : this.redoStack;
    const expect = direction === "undo" ? "after" : "before";
    const target = direction === "undo" ? "before" : "after";
    const entry = from[from.length - 1];
    if (!entry) return { ok: false, reason: "empty" };
    for (const change of entry.changes) {
      if (heldByOther(change.id)) return { ok: false, reason: "held", label: entry.label, partId: change.id };
    }
    for (const change of entry.changes) {
      if (!sameTransform(current(change.id), change[expect])) {
        // Someone else changed this part since; this entry can never apply cleanly again.
        from.pop();
        return { ok: false, reason: "stale", label: entry.label, partId: change.id };
      }
    }
    if (entry.program && !sameProgram(currentProgram(), entry.program[expect])) {
      from.pop();
      return { ok: false, reason: "stale", label: entry.label, partId: "program" };
    }
    return {
      ok: true,
      label: entry.label,
      apply: entry.changes.map((change) => ({ id: change.id, transform: change[target] })),
      ...(entry.program ? { program: [...entry.program[target]] } : {}),
      entry,
    };
  }

  /**
   * The room accepted the peeked step: move that entry (by identity — never whatever happens to
   * be on top now) to the other stack.
   */
  commit(direction: Direction, entry?: HistoryEntry): void {
    const from = direction === "undo" ? this.undoStack : this.redoStack;
    const to = direction === "undo" ? this.redoStack : this.undoStack;
    const index = entry ? from.lastIndexOf(entry) : from.length - 1;
    if (index < 0) return;
    const [moved] = from.splice(index, 1);
    to.push(moved);
  }

  /** The room found the peeked step stale (a teammate got there first): discard that entry. */
  drop(direction: Direction, entry?: HistoryEntry): void {
    const from = direction === "undo" ? this.undoStack : this.redoStack;
    const index = entry ? from.lastIndexOf(entry) : from.length - 1;
    if (index >= 0) from.splice(index, 1);
  }

  /** Check-and-commit in one call, for callers that apply locally (tests, single user). */
  undo(current: (id: string) => SharedTransform | null, heldByOther: (id: string) => boolean): HistoryVerdict {
    const verdict = this.peek("undo", current, heldByOther);
    if (verdict.ok) this.commit("undo");
    return verdict;
  }

  redo(current: (id: string) => SharedTransform | null, heldByOther: (id: string) => boolean): HistoryVerdict {
    const verdict = this.peek("redo", current, heldByOther);
    if (verdict.ok) this.commit("redo");
    return verdict;
  }

  /** Forget everything (e.g. on studio change), so no entry can reach across contexts. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
