/**
 * Realtime client for CPS multi-user state sync.
 *
 * Connects to vm-realtime Cloudflare Worker via WebSocket.
 * Single source of truth for: part ownership, snap state, LED-lit,
 * remote player poses, and merged telemetry.
 */
import { telemetry } from "../telemetry.js";

const WORKER_URL =
  (import.meta.env.VITE_REALTIME_URL as string | undefined) ??
  "wss://vm-realtime.jewoong-moon.workers.dev";

export interface PartState {
  id: string;
  ownerId: string;
  socketA: number;
  socketB: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export interface PlayerState {
  pid: string;
  role: "A" | "B" | "SOLO";
  nickname: string;
  isResearcher: boolean;
  head: { p: [number, number, number]; q: [number, number, number, number] };
  left: { p: [number, number, number]; q: [number, number, number, number] };
  right: { p: [number, number, number]; q: [number, number, number, number] };
}

type ServerMsg =
  | { t: "state"; players: PlayerState[]; parts: PartState[]; ledLit: boolean }
  | { t: "playerJoin"; player: PlayerState }
  | { t: "playerLeave"; pid: string }
  | { t: "partUpdate"; part: PartState }
  | {
      t: "pose";
      pid: string;
      head: { p: [number, number, number]; q: [number, number, number, number] };
      left: { p: [number, number, number]; q: [number, number, number, number] };
      right: { p: [number, number, number]; q: [number, number, number, number] };
    }
  | { t: "ledLit"; lit: boolean }
  | { t: "telemetryAck"; event_id: string }
  | { t: "pong"; ts: number; serverTs: number }
  | { t: "error"; message: string };

type Listener = (msg: ServerMsg) => void;

class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: number | null = null;
  private connected = false;
  private clockOffsetMs = 0;
  public readonly roomCode: string;
  public readonly enabled: boolean;

  constructor() {
    // Network is on only when telemetry decided this is a collab session.
    this.roomCode = telemetry.room;
    this.enabled = telemetry.mode === "collab" && this.roomCode.length > 0;
  }

  connect(): void {
    if (!this.enabled) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    const url = `${WORKER_URL}/room/${this.roomCode}`;
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      this.connected = true;
      console.info(
        `%c[VM-Net] connected to room "${this.roomCode}"`,
        "background:#2e7d32;color:#fff;padding:2px 6px;border-radius:3px",
      );
      this.send({
        t: "hello",
        pid: telemetry.participantId,
        role: telemetry.role as "A" | "B" | "SOLO",
        nickname: telemetry.nickname,
      });
      window.setInterval(() => this.ping(), 10000);
    });
    this.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMsg;
        if (msg.t === "pong") {
          const rtt = Date.now() - msg.ts;
          this.clockOffsetMs = msg.serverTs - (msg.ts + rtt / 2);
          return;
        }
        for (const l of this.listeners) l(msg);
      } catch (e) {
        console.warn("[VM-Net] parse error", e);
      }
    });
    this.ws.addEventListener("close", () => {
      this.connected = false;
      console.warn("[VM-Net] disconnected, reconnecting in 2s");
      if (this.reconnectTimer === null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 2000);
      }
    });
    this.ws.addEventListener("error", (e) => {
      console.warn("[VM-Net] socket error", e);
    });
  }

  send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ping(): void {
    this.send({ t: "ping", ts: Date.now() });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get serverTimeNow(): number {
    return Date.now() + this.clockOffsetMs;
  }
}

export const realtime = new RealtimeClient();

declare global {
  interface Window {
    realtime: RealtimeClient;
  }
}
window.realtime = realtime;
