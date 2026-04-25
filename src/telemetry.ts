export interface TelemetryEvent {
  event_id: string;
  session_id: string;
  event_type: string;
  timestamp_ms: number;
  frame_time_ms: number;
  payload: Record<string, unknown>;
}

const DB_NAME = "vm-telemetry";
const STORE = "events";

class Telemetry {
  readonly sessionId: string;
  private sessionStartMs: number;
  private buffer: TelemetryEvent[] = [];
  private db: IDBDatabase | null = null;
  private flushTimer: number | null = null;

  constructor() {
    this.sessionId = crypto.randomUUID();
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
      event_type,
      timestamp_ms: Date.now(),
      frame_time_ms: performance.now() - this.sessionStartMs,
      payload,
    };
    this.buffer.push(event);
    if (this.buffer.length >= 50) this.flush();
  }

  private flush(): void {
    if (!this.db || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const tx = this.db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const e of batch) store.add(e);
  }

  async export(): Promise<TelemetryEvent[]> {
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
