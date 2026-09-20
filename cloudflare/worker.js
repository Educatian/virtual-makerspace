import { DurableObject } from "cloudflare:workers";

const ROOM_CODE = /^[A-Z2-9]{4,12}$/;
const COMPONENT_IDS = new Set([
  "led-red",
  "led-green",
  "resistor-220",
  "resistor-1k",
  "wire-red",
  "wire-blue",
  "wire-yellow",
  "battery-9v",
  "soil-sensor",
  "temp-sensor",
  "light-sensor",
  "farm-controller",
  "water-pump",
  "irrigation-hose",
  "vent-fan",
  "solar-panel",
]);
const MAX_ROOM_MESSAGES_PER_SECOND = 120;
const MAX_CLAIMS_PER_PARTICIPANT = 16;
const ALLOWED_MESSAGE_KINDS = new Set([
  "hello",
  "presence",
  "goodbye",
  "chat",
  "transform",
  "claim",
  "release",
  "voice-state",
  "phase",
  "trace",
  "attention",
  "state-request",
  "state-response",
  "signal",
]);

function componentResource(value, allowEndpoint = true) {
  const resource = String(value || "").slice(0, 160);
  const match = resource.match(/^([a-z0-9-]+)(?:::endpoint-([01]))?$/);
  if (!match || !COMPONENT_IDS.has(match[1]) || (!allowEndpoint && match[2] !== undefined)) return null;
  return resource;
}

function finiteTuple(value, limit = 20) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const tuple = value.map(Number);
  if (tuple.some((item) => !Number.isFinite(item) || Math.abs(item) > limit)) return null;
  return tuple;
}

function sanitizeTransform(value) {
  if (!value || typeof value !== "object") return null;
  const position = finiteTuple(value.position);
  const rotation = finiteTuple(value.rotation, Math.PI * 16);
  if (!position || !rotation) return null;
  const transform = { position, rotation };
  if (value.sockets === null) transform.sockets = null;
  else if (value.sockets !== undefined) {
    if (!Array.isArray(value.sockets) || value.sockets.length !== 2) return null;
    const sockets = value.sockets.map((socket) => {
      if (socket === null) return null;
      const index = Number(socket);
      return Number.isInteger(index) && index >= 0 && index <= 2_000 ? index : undefined;
    });
    if (sockets.includes(undefined)) return null;
    transform.sockets = sockets;
  }
  if (value.endpoints !== undefined) {
    if (!Array.isArray(value.endpoints) || value.endpoints.length !== 2) return null;
    const endpoints = value.endpoints.map((endpoint) => finiteTuple(endpoint, 20));
    if (endpoints.some((endpoint) => !endpoint)) return null;
    transform.endpoints = endpoints;
  }
  if (value.activeEndpoint !== undefined) {
    if (value.activeEndpoint !== 0 && value.activeEndpoint !== 1) return null;
    transform.activeEndpoint = value.activeEndpoint;
  }
  return transform;
}

function sanitizeSignal(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "offer" || value.type === "answer") {
    const sdp = String(value.sdp?.sdp || "");
    if (!sdp || sdp.length > 48_000) return null;
    return { type: value.type, sdp: { type: value.type, sdp } };
  }
  if (value.type !== "candidate") return null;
  const candidateText = String(value.candidate?.candidate || "");
  if (!candidateText || candidateText.length > 4_096) return null;
  const candidate = { candidate: candidateText };
  if (value.candidate.sdpMid !== undefined && value.candidate.sdpMid !== null) {
    candidate.sdpMid = String(value.candidate.sdpMid).slice(0, 128);
  }
  if (value.candidate.sdpMLineIndex !== undefined && value.candidate.sdpMLineIndex !== null) {
    const index = Number(value.candidate.sdpMLineIndex);
    if (!Number.isInteger(index) || index < 0 || index > 64) return null;
    candidate.sdpMLineIndex = index;
  }
  if (value.candidate.usernameFragment) {
    candidate.usernameFragment = String(value.candidate.usernameFragment).slice(0, 256);
  }
  return { type: "candidate", candidate };
}

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function configuredValues(value) {
  return new Set(String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function isAdminEmail(env, email) {
  return configuredValues(env.ADMIN_EMAILS).has(String(email || "").toLowerCase());
}

function accessClaims(assertion) {
  if (!assertion) return null;
  const parts = assertion.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

async function accessIdentity(request, context, env) {
  let identity = null;
  if (context.access) {
    try {
      identity = await context.access.getIdentity();
    } catch {
      // Standard Access applications provide the already-validated assertion below.
    }
  }

  const assertion = request.headers.get("cf-access-jwt-assertion");
  const claims = accessClaims(assertion);
  const assertedEmail = assertion
    ? request.headers.get("cf-access-authenticated-user-email")
    : null;
  const emailValue = identity?.email || claims?.email || assertedEmail;
  if (!emailValue) return null;

  const email = String(emailValue).toLowerCase().slice(0, 320);
  const id = String(identity?.user_uuid || identity?.id || claims?.sub || email).slice(0, 200);
  const name = String(identity?.name || claims?.name || claims?.given_name || email.split("@")[0] || "Maker").slice(0, 80);
  return { id, name, email, role: isAdminEmail(env, email) ? "admin" : "member" };
}

function neonEndpoint(connectionString) {
  const connection = new URL(connectionString);
  return `https://${connection.hostname}/sql`;
}

async function neonQuery(env, query, params = []) {
  if (!env.DATABASE_URL) return null;
  const response = await fetch(neonEndpoint(env.DATABASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Neon-Connection-String": env.DATABASE_URL,
    },
    body: JSON.stringify({ query, params }),
  });
  if (!response.ok) {
    throw new Error(`Neon query failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function recordRoomMembership(env, roomCode, identity, membershipRole = "member") {
  if (!env.DATABASE_URL) return false;
  await neonQuery(
    env,
    `INSERT INTO makerspace_users (id, email, display_name, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       last_seen_at = now()`,
    [identity.id, identity.email, identity.name],
  );
  await neonQuery(
    env,
    `INSERT INTO makerspace_rooms (code, created_by)
     VALUES ($1, $2)
     ON CONFLICT (code) DO NOTHING`,
    [roomCode, identity.id],
  );
  await neonQuery(
    env,
    `INSERT INTO makerspace_room_members (room_code, user_id, role, last_joined_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (room_code, user_id) DO UPDATE SET
       role = CASE
         WHEN makerspace_room_members.role = 'owner' OR EXCLUDED.role = 'owner' THEN 'owner'
         ELSE 'member'
       END,
       last_joined_at = now()`,
    [roomCode, identity.id, membershipRole],
  );
  return true;
}

function roomStub(env, roomCode) {
  return env.MAKERSPACE_ROOMS.getByName(roomCode);
}

async function roomMetadata(env, roomCode) {
  const response = await roomStub(env, roomCode).fetch("https://room.internal/meta");
  return response.status === 200 ? response.json() : null;
}

async function createRoomRecord(env, roomCode, creator) {
  const response = await roomStub(env, roomCode).fetch("https://room.internal/meta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: roomCode,
      createdById: creator.id,
      createdByEmail: creator.email,
      createdByName: creator.name,
      createdAt: Date.now(),
    }),
  });
  if (!response.ok) throw new Error(`Room registry write failed (${response.status})`);
  return response.json();
}

async function ensureKnownRoom(env, roomCode) {
  const existing = await roomMetadata(env, roomCode);
  if (existing) return existing;
  if (!configuredValues(env.PRECREATED_ROOMS).has(roomCode.toLowerCase())) return null;
  const [adminEmail = "system"] = configuredValues(env.ADMIN_EMAILS);
  return createRoomRecord(env, roomCode, {
    id: `precreated:${roomCode}`,
    email: adminEmail,
    name: "Makerspace administrator",
  });
}

function roomCodeFromPath(pathname) {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
  const code = match ? decodeURIComponent(match[1]).trim().toUpperCase() : "";
  return ROOM_CODE.test(code) ? code : null;
}

async function fetchStaticSite(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const origin = env.STATIC_ORIGIN || "https://virtual-makerspace.pages.dev";
  const target = new URL(`${url.pathname}${url.search}`, origin);
  const headers = new Headers();
  for (const name of ["accept", "accept-encoding", "accept-language", "if-modified-since", "if-none-match", "range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  return fetch(target, {
    method: request.method,
    headers,
    redirect: "follow",
  });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const identity = await accessIdentity(request, context, env);
      if (!identity) return json({ error: "Cloudflare Access authentication required" }, { status: 401 });

      if (url.pathname === "/api/me" && request.method === "GET") {
        return json({ ...identity, provider: "cloudflare-access" });
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({
          ok: true,
          authenticated: true,
          role: identity.role,
          neonConfigured: Boolean(env.DATABASE_URL),
          roomTransport: "durable-object-websocket",
        });
      }

      const joinCode = roomCodeFromPath(url.pathname);
      if (joinCode && request.method === "POST") {
        try {
          let metadata = await ensureKnownRoom(env, joinCode);
          let created = false;
          if (!metadata) {
            if (identity.role !== "admin") {
              return json({ error: "Only an administrator can create a new room" }, { status: 404 });
            }
            metadata = await createRoomRecord(env, joinCode, identity);
            created = true;
          }
          const membershipRole = metadata.createdByEmail === identity.email ? "owner" : "member";
          const persisted = await recordRoomMembership(env, joinCode, identity, membershipRole);
          return json({ room: joinCode, joined: true, created, persisted, role: membershipRole });
        } catch (error) {
          console.error("Room membership write failed", error);
          return json({ error: "Room membership could not be stored" }, { status: 503 });
        }
      }

      if (url.pathname === "/api/room" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const requestOrigin = request.headers.get("origin");
        if (!requestOrigin || requestOrigin !== url.origin) {
          return new Response("Same-origin WebSocket required", { status: 403 });
        }
        const roomCode = (url.searchParams.get("room") || "").trim().toUpperCase();
        if (!ROOM_CODE.test(roomCode)) return new Response("Valid room code required", { status: 400 });
        const metadata = await ensureKnownRoom(env, roomCode);
        if (!metadata) return new Response("Room does not exist", { status: 404 });

        const requestedSession = (url.searchParams.get("participant") || "").slice(0, 260);
        const sessionId = requestedSession.startsWith(`${identity.id}:`)
          ? requestedSession
          : `${identity.id}:${crypto.randomUUID()}`;

        if (env.DATABASE_URL) {
          try {
            const membershipRole = metadata.createdByEmail === identity.email ? "owner" : "member";
            await recordRoomMembership(env, roomCode, identity, membershipRole);
          } catch (error) {
            console.error("Neon room membership write failed", error);
            return new Response("Room membership unavailable", { status: 503 });
          }
        }

        const headers = new Headers(request.headers);
        headers.set("x-maker-id", identity.id);
        headers.set("x-maker-session-id", sessionId);
        headers.set("x-maker-name", encodeURIComponent(identity.name));
        const room = roomStub(env, roomCode);
        return room.fetch(new Request(request, { headers }));
      }

      return json({ error: "Not found" }, { status: 404 });
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return fetchStaticSite(request, env, url);
  },
};

export class MakerspaceRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.claims = new Map();
    this.messageRates = new Map();
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "room.internal" && url.pathname === "/meta") {
      if (request.method === "GET") {
        const metadata = await this.state.storage.get("metadata");
        return metadata ? json(metadata) : json({ error: "Room not found" }, { status: 404 });
      }
      if (request.method === "POST") {
        const existing = await this.state.storage.get("metadata");
        if (existing) return json(existing);
        const incoming = await request.json();
        const metadata = {
          code: String(incoming.code || "").slice(0, 12),
          createdById: String(incoming.createdById || "system").slice(0, 200),
          createdByEmail: String(incoming.createdByEmail || "system").toLowerCase().slice(0, 320),
          createdByName: String(incoming.createdByName || "Makerspace administrator").slice(0, 80),
          createdAt: Number.isFinite(incoming.createdAt) ? incoming.createdAt : Date.now(),
        };
        await this.state.storage.put("metadata", metadata);
        return json(metadata, { status: 201 });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment = {
      id: request.headers.get("x-maker-session-id") || crypto.randomUUID(),
      userId: request.headers.get("x-maker-id") || "unknown",
      name: decodeURIComponent(request.headers.get("x-maker-name") || "Maker").slice(0, 80),
      joinedAt: Date.now(),
    };
    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, payload) {
    if (typeof payload !== "string" || payload.length > 64 * 1024) return;
    const attachment = socket.deserializeAttachment();
    const now = Date.now();
    const previousRate = this.messageRates.get(attachment.id);
    const rate = !previousRate || now - previousRate.startedAt >= 1_000
      ? { startedAt: now, count: 1 }
      : { startedAt: previousRate.startedAt, count: previousRate.count + 1 };
    this.messageRates.set(attachment.id, rate);
    if (rate.count > MAX_ROOM_MESSAGES_PER_SECOND) {
      socket.close(1008, "Message rate exceeded");
      return;
    }
    let incoming;
    try {
      incoming = JSON.parse(payload);
    } catch {
      return;
    }
    const message = this.sanitizeMessage(incoming, attachment);
    if (!message) return;
    if (message.kind === "claim") {
      const current = this.claims.get(message.componentId);
      if (current && current.participantId !== attachment.id) {
        socket.send(JSON.stringify(current));
        return;
      }
      const participantClaimCount = [...this.claims.values()]
        .filter((claim) => claim.participantId === attachment.id).length;
      if (!current && participantClaimCount >= MAX_CLAIMS_PER_PARTICIPANT) return;
      this.claims.set(message.componentId, message);
    }
    if (message.kind === "release") {
      const current = this.claims.get(message.componentId);
      if (current?.participantId !== attachment.id) return;
      this.claims.delete(message.componentId);
    }
    if (message.kind === "transform") {
      const endpoint = message.transform?.activeEndpoint;
      const resourceId = endpoint === 0 || endpoint === 1
        ? `${message.componentId}::endpoint-${endpoint}`
        : message.componentId;
      const current = this.claims.get(resourceId);
      if (current && current.participantId !== attachment.id) return;
    }
    const encoded = JSON.stringify(message);
    for (const peer of this.state.getWebSockets()) {
      if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(encoded);
    }
  }

  webSocketClose(socket, code, reason) {
    const attachment = socket.deserializeAttachment();
    this.messageRates.delete(attachment.id);
    const released = [];
    for (const [resourceId, claim] of this.claims) {
      if (claim.participantId !== attachment.id) continue;
      this.claims.delete(resourceId);
      released.push(JSON.stringify({
        kind: "release",
        participantId: attachment.id,
        participantName: attachment.name,
        componentId: resourceId,
      }));
    }
    const goodbye = JSON.stringify({ kind: "goodbye", participantId: attachment.id });
    for (const peer of this.state.getWebSockets()) {
      if (peer === socket || peer.readyState !== WebSocket.OPEN) continue;
      for (const release of released) peer.send(release);
      peer.send(goodbye);
    }
    socket.close(code, reason);
  }

  sanitizeMessage(incoming, participant) {
    if (!incoming || typeof incoming !== "object" || !ALLOWED_MESSAGE_KINDS.has(incoming.kind)) return null;
    if (incoming.kind === "hello" || incoming.kind === "presence") {
      return {
        kind: incoming.kind,
        participant: {
          id: participant.id,
          name: participant.name,
          joinedAt: participant.joinedAt,
          voiceReady: Boolean(incoming.participant?.voiceReady),
          muted: incoming.participant?.muted !== false,
          role: incoming.participant?.role === "verifier" ? "verifier" : "builder",
          ready: Boolean(incoming.participant?.ready),
          activity: ["available", "inspecting", "moving", "discussing", "testing", "reflecting"].includes(incoming.participant?.activity)
            ? incoming.participant.activity
            : "available",
          activityDetail: incoming.participant?.activityDetail
            ? String(incoming.participant.activityDetail).slice(0, 120)
            : undefined,
          lastActiveAt: Number.isFinite(incoming.participant?.lastActiveAt)
            ? incoming.participant.lastActiveAt
            : Date.now(),
        },
      };
    }
    if (incoming.kind === "chat") {
      return {
        kind: "chat",
        message: {
          id: String(incoming.message?.id || crypto.randomUUID()).slice(0, 100),
          participantId: participant.id,
          author: participant.name,
          body: String(incoming.message?.body || "").slice(0, 4000),
          createdAt: Date.now(),
          context: incoming.message?.context ? String(incoming.message.context).slice(0, 160) : undefined,
        },
      };
    }
    if (incoming.kind === "claim" || incoming.kind === "release") {
      const componentId = componentResource(incoming.componentId, true);
      if (!componentId) return null;
      return {
        kind: incoming.kind,
        participantId: participant.id,
        participantName: participant.name,
        componentId,
      };
    }
    if (incoming.kind === "phase") {
      if (!["frame", "build", "test", "reflect"].includes(incoming.phase)) return null;
      return { kind: "phase", participantId: participant.id, phase: incoming.phase };
    }
    if (incoming.kind === "trace") {
      const trace = incoming.trace || {};
      if (!["inspect", "claim", "move", "discuss", "test", "snapshot", "role", "phase", "ready", "reflect"].includes(trace.action)) return null;
      if (!["frame", "build", "test", "reflect"].includes(trace.phase)) return null;
      return {
        kind: "trace",
        participantId: participant.id,
        trace: {
          id: String(trace.id || crypto.randomUUID()).slice(0, 100),
          participantId: participant.id,
          participantName: participant.name,
          createdAt: Date.now(),
          action: trace.action,
          phase: trace.phase,
          studio: trace.studio === "greenhouse" ? "greenhouse" : "circuit",
          objectId: trace.objectId ? String(trace.objectId).slice(0, 160) : undefined,
          objectName: trace.objectName ? String(trace.objectName).slice(0, 160) : undefined,
          detail: trace.detail ? String(trace.detail).slice(0, 240) : undefined,
        },
      };
    }
    if (incoming.kind === "attention") {
      const componentId = componentResource(incoming.componentId, false);
      if (!componentId) return null;
      return {
        kind: "attention",
        participantId: participant.id,
        participantName: participant.name,
        componentId,
        componentName: String(incoming.componentName || "Component").slice(0, 160),
      };
    }
    if (incoming.kind === "transform") {
      const componentId = componentResource(incoming.componentId, false);
      const transform = sanitizeTransform(incoming.transform);
      const sequence = Number(incoming.sequence);
      if (!componentId || !transform || !Number.isSafeInteger(sequence) || sequence < 0) return null;
      return { kind: "transform", participantId: participant.id, componentId, transform, sequence };
    }
    if (incoming.kind === "voice-state") {
      return {
        kind: "voice-state",
        participantId: participant.id,
        voiceReady: Boolean(incoming.voiceReady),
        muted: incoming.muted !== false,
      };
    }
    if (incoming.kind === "goodbye" || incoming.kind === "state-request") {
      return { kind: incoming.kind, participantId: participant.id };
    }
    if (incoming.kind === "state-response") {
      const targetId = String(incoming.targetId || "").slice(0, 260);
      if (!targetId || !incoming.transforms || typeof incoming.transforms !== "object" || Array.isArray(incoming.transforms)) return null;
      const transforms = {};
      const entries = Object.entries(incoming.transforms);
      if (entries.length > COMPONENT_IDS.size) return null;
      for (const [componentIdValue, transformValue] of entries) {
        const componentId = componentResource(componentIdValue, false);
        const transform = sanitizeTransform(transformValue);
        if (!componentId || !transform) return null;
        transforms[componentId] = transform;
      }
      return { kind: "state-response", participantId: participant.id, targetId, transforms };
    }
    if (incoming.kind === "signal") {
      const targetId = String(incoming.targetId || "").slice(0, 260);
      const signal = sanitizeSignal(incoming.payload);
      if (!targetId || !signal) return null;
      return { kind: "signal", participantId: participant.id, targetId, payload: signal };
    }
    return null;
  }
}
