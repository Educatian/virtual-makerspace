/**
 * Conflict-safe undo/redo for a shared workbench.
 *
 * Only this participant's own completed edits are recorded. Each entry stores, per part, the
 * shared state before and after the edit. Undo applies an entry only if every part still
 * matches its `after` state — if a teammate (human or Bolt) changed any of them since, the
 * entry is stale and is refused instead of overwriting their work. Parts currently held by
 * someone else are refused too. Applying an undo is an ordinary shared edit, so every peer
 * converges on the same state. Pure: no DOM, no three.js.
 */
import type { SharedTransform } from "./collaboration.js";

export interface HistoryChange {
  id: string;
  before: SharedTransform;
  after: SharedTransform;
}

export interface HistoryEntry {
  label: string;
  changes: HistoryChange[];
}

export type HistoryVerdict =
  | { ok: true; label: string; apply: Array<{ id: string; transform: SharedTransform }> }
  | { ok: false; reason: "empty" | "stale" | "held"; label?: string; partId?: string };

const LIMIT = 50;

const round = (value: number): number => Math.round(value * 1000) / 1000;
const roundTuple = (tuple: readonly number[] | undefined): string => (tuple ? tuple.map(round).join(",") : "");

/**
 * Whether two shared states are the same placement: sockets, electrical values, switch state,
 * and (for unseated parts) position, compared at millimetre precision.
 */
export function sameTransform(a: SharedTransform | null | undefined, b: SharedTransform | null | undefined): boolean {
  if (!a || !b) return a === b;
  const socketsA = a.sockets ?? null;
  const socketsB = b.sockets ?? null;
  if (JSON.stringify(socketsA) !== JSON.stringify(socketsB)) return false;
  if ((a.props?.ohms ?? null) !== (b.props?.ohms ?? null) || (a.props?.volts ?? null) !== (b.props?.volts ?? null)) return false;
  if ((a.on ?? null) !== (b.on ?? null)) return false;
  const seated = Array.isArray(socketsA) && socketsA.length === 2 && socketsA.every((socket) => Number.isInteger(socket));
  if (seated) return true;
  if (roundTuple(a.position) !== roundTuple(b.position)) return false;
  if (roundTuple(a.rotation) !== roundTuple(b.rotation)) return false;
  return roundTuple(a.endpoints?.flat()) === roundTuple(b.endpoints?.flat());
}

export class EditHistory {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  /** Records a completed local edit. No-op changes are dropped; a new edit clears redo. */
  record(label: string, changes: HistoryChange[]): boolean {
    const real = changes.filter((change) => !sameTransform(change.before, change.after));
    if (!real.length) return false;
    this.undoStack.push({ label, changes: real.map((change) => ({ ...change })) });
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
   * Checks the newest undo against the live state. `current(id)` returns the part's present
   * shared state; `heldByOther(id)` says whether a teammate or Bolt holds it right now.
   * On success the entry moves to the redo stack; the caller applies `apply` as shared edits.
   */
  undo(current: (id: string) => SharedTransform | null, heldByOther: (id: string) => boolean): HistoryVerdict {
    return this.step(this.undoStack, this.redoStack, "after", "before", current, heldByOther);
  }

  redo(current: (id: string) => SharedTransform | null, heldByOther: (id: string) => boolean): HistoryVerdict {
    return this.step(this.redoStack, this.undoStack, "before", "after", current, heldByOther);
  }

  /** Forget everything (e.g. on studio change), so no entry can reach across contexts. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  private step(
    from: HistoryEntry[],
    to: HistoryEntry[],
    expect: "before" | "after",
    target: "before" | "after",
    current: (id: string) => SharedTransform | null,
    heldByOther: (id: string) => boolean,
  ): HistoryVerdict {
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
    from.pop();
    to.push(entry);
    return { ok: true, label: entry.label, apply: entry.changes.map((change) => ({ id: change.id, transform: change[target] })) };
  }
}
