/// <reference types="@cloudflare/workers-types" />

interface Env {
  ROOM: DurableObjectNamespace;
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
}

interface PartState {
  id: string;
  ownerId: string;
  socketA: number;
  socketB: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

interface PlayerState {
  pid: string;
  role: "A" | "B" | "SOLO";
  nickname: string;
  isResearcher: boolean;
  head: { p: [number, number, number]; q: [number, number, number, number] };
  left: { p: [number, number, number]; q: [number, number, number, number] };
  right: { p: [number, number, number]; q: [number, number, number, number] };
}

type ClientMsg =
  | { t: "hello"; pid: string; role: "A" | "B" | "SOLO"; nickname: string }
  | { t: "grab"; partId: string }
  | { t: "release"; partId: string }
  | {
      t: "snap";
      partId: string;
      socketA: number;
      socketB: number;
      position: [number, number, number];
      quaternion: [number, number, number, number];
    }
  | {
      t: "pose";
      head: { p: [number, number, number]; q: [number, number, number, number] };
      left: { p: [number, number, number]; q: [number, number, number, number] };
      right: { p: [number, number, number]; q: [number, number, number, number] };
    }
  | { t: "telemetry"; event: unknown }
  | { t: "ping"; ts: number };

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

const ZERO_VEC: [number, number, number] = [0, 0, 0];
const IDENT_QUAT: [number, number, number, number] = [0, 0, 0, 1];

function defaultParts(): PartState[] {
  // mirrors src/index.ts spawn positions; ids match per-role
  return [
    {
      id: "battery",
      ownerId: "",
      socketA: -1,
      socketB: -1,
      position: [0.62, 0.94, -1.22],
      quaternion: IDENT_QUAT,
    },
    {
      id: "wire-blue-med",
      ownerId: "",
      socketA: -1,
      socketB: -1,
      position: [0.55, 0.94, -1.05],
      quaternion: IDENT_QUAT,
    },
    {
      id: "led-red",
      ownerId: "",
      socketA: -1,
      socketB: -1,
      position: [0.1, 0.94, -1.22],
      quaternion: IDENT_QUAT,
    },
    {
      id: "wire-red-short",
      ownerId: "",
      socketA: -1,
      socketB: -1,
      position: [0.3, 0.94, -1.05],
      quaternion: IDENT_QUAT,
    },
  ];
}

interface Session {
  socket: WebSocket;
  pid: string;
}

export class MakerspaceRoom {
  state: DurableObjectState;
  env: Env;
  sessions: Map<string, Session> = new Map();
  players: Map<string, PlayerState> = new Map();
  parts: Map<string, PartState> = new Map();
  ledLit: boolean = false;
  telemetryCount: number = 0;
  private readonly ready: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    for (const p of defaultParts()) this.parts.set(p.id, p);
    this.ready = this.loadPersistedState();
  }

  private async loadPersistedState(): Promise<void> {
    this.telemetryCount =
      (await this.state.storage.get<number>("telemetryCount")) ?? 0;
  }

  private telemetryKey(index: number): string {
    return `telemetry:${index.toString().padStart(10, "0")}`;
  }

  private async appendTelemetry(event: unknown): Promise<string> {
    const eid = (event as { event_id?: string }).event_id ?? "";
    const index = this.telemetryCount;
    this.telemetryCount += 1;
    await this.state.storage.put({
      [this.telemetryKey(index)]: event,
      telemetryCount: this.telemetryCount,
    });
    return eid;
  }

  private async exportTelemetry(): Promise<Response> {
    const lines: string[] = [];
    let startAfter: string | undefined;
    while (true) {
      const stored = await this.state.storage.list<unknown>({
        prefix: "telemetry:",
        startAfter,
        limit: 1000,
      });
      if (stored.size === 0) break;
      for (const event of stored.values()) {
        lines.push(JSON.stringify(event));
      }
      if (stored.size < 1000) break;
      startAfter = [...stored.keys()][stored.size - 1];
    }
    const ndjson = lines.join("\n");
    return new Response(ndjson, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "X-Telemetry-Count": String(this.telemetryCount),
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      const url = new URL(request.url);
      if (url.pathname === "/state") {
        return Response.json({
          players: [...this.players.values()],
          parts: [...this.parts.values()],
          ledLit: this.ledLit,
          telemetryCount: this.telemetryCount,
        });
      }
      if (url.pathname === "/telemetry") {
        return this.exportTelemetry();
      }
      return new Response("Expected WebSocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { socket: server, pid: "" });

    server.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as ClientMsg;
        void this.handleMessage(sessionId, msg);
      } catch (e) {
        this.send(server, {
          t: "error",
          message: `parse error: ${(e as Error).message}`,
        });
      }
    });

    server.addEventListener("close", () => this.handleClose(sessionId));
    server.addEventListener("error", () => this.handleClose(sessionId));

    return new Response(null, { status: 101, webSocket: client });
  }

  send(socket: WebSocket, msg: ServerMsg): void {
    try {
      socket.send(JSON.stringify(msg));
    } catch (_) {
      // socket closing
    }
  }

  broadcast(msg: ServerMsg, except?: string): void {
    for (const [id, s] of this.sessions) {
      if (id === except) continue;
      this.send(s.socket, msg);
    }
  }

  async handleMessage(sessionId: string, msg: ClientMsg): Promise<void> {
    await this.ready;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (msg.t) {
      case "hello": {
        const player: PlayerState = {
          pid: msg.pid,
          role: msg.role,
          nickname: msg.nickname,
          isResearcher: false,
          head: { p: ZERO_VEC, q: IDENT_QUAT },
          left: { p: ZERO_VEC, q: IDENT_QUAT },
          right: { p: ZERO_VEC, q: IDENT_QUAT },
        };
        session.pid = msg.pid;
        this.players.set(msg.pid, player);
        this.send(session.socket, {
          t: "state",
          players: [...this.players.values()],
          parts: [...this.parts.values()],
          ledLit: this.ledLit,
        });
        this.broadcast({ t: "playerJoin", player }, sessionId);
        break;
      }
      case "grab": {
        const part = this.parts.get(msg.partId);
        if (!part) return;
        if (part.ownerId && part.ownerId !== session.pid) return; // someone else holds
        part.ownerId = session.pid;
        part.socketA = -1;
        part.socketB = -1;
        this.broadcast({ t: "partUpdate", part }, sessionId);
        break;
      }
      case "release": {
        const part = this.parts.get(msg.partId);
        if (!part) return;
        if (part.ownerId !== session.pid) return;
        part.ownerId = "";
        this.broadcast({ t: "partUpdate", part }, sessionId);
        break;
      }
      case "snap": {
        const part = this.parts.get(msg.partId);
        if (!part) return;
        if (part.ownerId && part.ownerId !== session.pid) return;
        // Check socket collision
        for (const [otherId, other] of this.parts) {
          if (otherId === msg.partId) continue;
          if (
            other.socketA === msg.socketA ||
            other.socketB === msg.socketB ||
            other.socketA === msg.socketB ||
            other.socketB === msg.socketA
          ) {
            this.send(session.socket, {
              t: "error",
              message: `socket conflict on ${otherId}`,
            });
            return;
          }
        }
        part.ownerId = "";
        part.socketA = msg.socketA;
        part.socketB = msg.socketB;
        part.position = msg.position;
        part.quaternion = msg.quaternion;
        this.broadcast({ t: "partUpdate", part });
        this.evaluateCircuit();
        break;
      }
      case "pose": {
        const player = this.players.get(session.pid);
        if (!player) return;
        player.head = msg.head;
        player.left = msg.left;
        player.right = msg.right;
        this.broadcast(
          {
            t: "pose",
            pid: session.pid,
            head: msg.head,
            left: msg.left,
            right: msg.right,
          },
          sessionId,
        );
        break;
      }
      case "telemetry": {
        const eid = await this.appendTelemetry(msg.event);
        this.send(session.socket, { t: "telemetryAck", event_id: eid });
        break;
      }
      case "ping": {
        this.send(session.socket, {
          t: "pong",
          ts: msg.ts,
          serverTs: Date.now(),
        });
        break;
      }
    }
  }

  handleClose(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.pid) {
      this.players.delete(session.pid);
      // Release any parts they held
      for (const part of this.parts.values()) {
        if (part.ownerId === session.pid) {
          part.ownerId = "";
          this.broadcast({ t: "partUpdate", part });
        }
      }
      this.broadcast({ t: "playerLeave", pid: session.pid });
    }
  }

  evaluateCircuit(): void {
    // Target topology: battery (4-20) + wire-blue-med (20-25) + led-red (25-26) + wire-red-short (26-10)
    const targets: Record<string, [number, number]> = {
      battery: [4, 20],
      "wire-blue-med": [20, 25],
      "led-red": [25, 26],
      "wire-red-short": [26, 10],
    };
    let allMatch = true;
    for (const [id, [a, b]] of Object.entries(targets)) {
      const p = this.parts.get(id);
      if (
        !p ||
        !(
          (p.socketA === a && p.socketB === b) ||
          (p.socketA === b && p.socketB === a)
        )
      ) {
        allMatch = false;
        break;
      }
    }
    if (allMatch !== this.ledLit) {
      this.ledLit = allMatch;
      this.broadcast({ t: "ledLit", lit: allMatch });
    }
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Base64url-encode a string, Uint8Array, or ArrayBuffer.
 * Strings are UTF-8 encoded first. Binary input (e.g. the HMAC signature)
 * is taken as-is. A byte-by-byte loop avoids String.fromCharCode(...spread)
 * call-stack overflow on large buffers (signatures are small, but this is robust).
 */
function b64url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a LiveKit AccessToken (HS256 JWT) with no Node deps, using Web Crypto.
 * Returns { token, url } on success or a 503 'voice-not-configured' when the
 * LIVEKIT_* env is absent — mirroring realtime.enabled gating on the client.
 */
async function handleToken(
  room: string,
  url: URL,
  env: Env,
): Promise<Response> {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) {
    return Response.json(
      { error: "voice-not-configured" },
      { status: 503, headers: corsHeaders },
    );
  }

  const identity = url.searchParams.get("identity") || crypto.randomUUID();
  const name = url.searchParams.get("name") || identity;
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    iss: env.LIVEKIT_API_KEY,
    sub: identity,
    nbf: now,
    exp: now + 21600, // 6h
    name,
    video: {
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    },
  };

  const signingInput =
    b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.LIVEKIT_API_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  const token = signingInput + "." + b64url(sig);

  return Response.json({ token, url: env.LIVEKIT_URL }, { headers: corsHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers: corsHeaders });
    }

    // /token/:code -> LiveKit voice JWT (or 503 if LIVEKIT_* unconfigured)
    const tm = url.pathname.match(/^\/token\/([a-zA-Z0-9_-]{1,32})$/);
    if (tm && request.method === "GET") {
      return handleToken(tm[1].toLowerCase(), url, env);
    }

    // /room/:code  -> WS upgrade
    // /room/:code/state and /room/:code/telemetry -> room diagnostics/export
    const m = url.pathname.match(
      /^\/room\/([a-zA-Z0-9_-]{1,32})(\/state|\/telemetry)?$/,
    );
    if (m) {
      const roomCode = m[1].toLowerCase();
      const id = env.ROOM.idFromName(roomCode);
      const stub = env.ROOM.get(id);
      if (m[2]) {
        const roomUrl = new URL(request.url);
        roomUrl.pathname = m[2];
        return stub.fetch(new Request(roomUrl, request));
      }
      return stub.fetch(request);
    }

    return new Response(
      "vm-realtime worker — WS /room/:code, GET /room/:code/state, GET /room/:code/telemetry",
      {
      status: 200,
      headers: corsHeaders,
      },
    );
  },
};
