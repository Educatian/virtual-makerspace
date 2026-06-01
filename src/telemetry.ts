export type SessionMode = "solo" | "collab";
export type ParticipantRole = "A" | "B" | "SOLO";

export interface TelemetryEvent {
  event_id: string;
  session_id: string;
  participant_id: string;
  mode: SessionMode;
  role: ParticipantRole;
  room: string;
  condition: string;
  event_type: string;
  timestamp_ms: number;
  frame_time_ms: number;
  payload: Record<string, unknown>;
}

const DB_NAME = "vm-telemetry";
const STORE = "events";

class Telemetry {
  readonly sessionId: string;
  readonly participantId: string;
  readonly mode: SessionMode;
  readonly role: ParticipantRole;
  readonly room: string;
  readonly nickname: string;
  readonly condition: string;
  readonly sessionStartMs: number;
  private buffer: TelemetryEvent[] = [];
  private db: IDBDatabase | null = null;
  private flushTimer: number | null = null;
  private flushing: Promise<void> | null = null;

  constructor() {
    this.sessionId = crypto.randomUUID();
    const params = new URLSearchParams(window.location.search);

    const urlPid = params.get("pid");
    this.participantId =
      urlPid && urlPid.length > 0 ? urlPid : crypto.randomUUID();

    const rawMode = params.get("mode")?.toLowerCase();
    const rawRole = params.get("role")?.toUpperCase();
    const rawRoom = params.get("room")?.toLowerCase().replace(/[^a-z0-9_-]/g, "");

    // Mode resolution: explicit mode= wins; otherwise infer from presence of
    // role/room. Strict requirement for collab: role∈{A,B} AND room set.
    let mode: SessionMode;
    if (rawMode === "collab") {
      mode = "collab";
    } else if (rawMode === "solo") {
      mode = "solo";
    } else if ((rawRole === "A" || rawRole === "B") && rawRoom) {
      mode = "collab";
    } else {
      mode = "solo";
    }

    if (mode === "collab" && (!rawRoom || (rawRole !== "A" && rawRole !== "B"))) {
      console.warn(
        "[VM] collab mode requires both ?role=A|B and ?room=... — falling back to solo",
      );
      mode = "solo";
    }

    this.mode = mode;
    this.role = mode === "collab" ? (rawRole as "A" | "B") : "SOLO";
    this.room = mode === "collab" ? rawRoom! : "";
    this.nickname =
      params.get("nick") ?? this.participantId.slice(0, 6);
    this.condition = params.get("cond") ?? "default";
    this.sessionStartMs = performance.now();
    this.openDB();
    this.flushTimer = window.setInterval(() => this.flush(), 5000);
    window.addEventListener("beforeunload", () => {
      this.log("session_end", { reason: "unload" });
      this.flush();
    });
  }

  private openDB(): void {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "event_id" });
      }
    };
    req.onsuccess = () => {
      this.db = req.result;
      this.flush();
    };
    req.onerror = () => {
      console.warn("[telemetry] IndexedDB open failed", req.error);
    };
  }

  log(event_type: string, payload: Record<string, unknown> = {}): void {
    const event: TelemetryEvent = {
      event_id: crypto.randomUUID(),
      session_id: this.sessionId,
      participant_id: this.participantId,
      mode: this.mode,
      role: this.role,
      room: this.room,
      condition: this.condition,
      event_type,
      timestamp_ms: Date.now(),
      frame_time_ms: performance.now() - this.sessionStartMs,
      payload,
    };
    this.buffer.push(event);
    if (this.buffer.length >= 50) this.flush();
  }

  private flush(): void {
    void this.flushNow();
  }

  private async flushNow(): Promise<void> {
    if (this.flushing) await this.flushing;
    if (!this.db || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    this.flushing = new Promise((resolve) => {
      const tx = this.db!.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        this.buffer.unshift(...batch);
        console.warn("[telemetry] IndexedDB flush failed", tx.error);
        resolve();
      };
      for (const e of batch) store.put(e);
    });
    await this.flushing;
    this.flushing = null;
  }

  async export(): Promise<TelemetryEvent[]> {
    await this.flushNow();
    if (!this.db) return [];
    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as TelemetryEvent[]);
      req.onerror = () => resolve([]);
    });
  }

  async clear(): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    this.buffer = [];
  }

  async download(): Promise<void> {
    const events = await this.export();
    const blob = new Blob([events.map((e) => JSON.stringify(e)).join("\n")], {
      type: "application/x-ndjson",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `telemetry-${this.sessionId}.ndjson`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

export const telemetry = new Telemetry();

declare global {
  interface Window {
    telemetry: Telemetry;
  }
}
window.telemetry = telemetry;
