var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// cloudflare/worker.js
import { DurableObject } from "cloudflare:workers";
var ROOM_CODE = /^[A-Z2-9]{4,12}$/;
var COMPONENT_IDS = /* @__PURE__ */ new Set([
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
  "snap-b1",
  "snap-s1",
  "snap-l1",
  "snap-m1",
  "snap-w2",
  "snap-w3a",
  "snap-w3b",
  "snap-w4",
  "sno-l1",
  "sno-d1",
  "sno-m1",
  "sno-s1",
  "sno-w2a",
  "sno-w2b",
  "sno-w3",
  "sno-w4a",
  "sno-w4b"
]);
var STUDIOS = /* @__PURE__ */ new Set(["circuit", "greenhouse", "snap", "snapino"]);
var SNAPINO_PINS = /* @__PURE__ */ new Set(["D3", "D5", "D6"]);
function sanitizeProgram(value) {
  if (!Array.isArray(value) || value.length > 24) return null;
  const program = [];
  for (const item of value) {
    if (item?.op === "write" && SNAPINO_PINS.has(item.pin) && typeof item.value === "boolean") {
      program.push({ op: "write", pin: item.pin, value: item.value });
    } else if (item?.op === "wait" && Number.isFinite(item.ms)) {
      program.push({ op: "wait", ms: Math.min(5e3, Math.max(50, Math.round(item.ms / 50) * 50)) });
    } else if (item?.op === "follow" && SNAPINO_PINS.has(item.pin) && typeof item.invert === "boolean") {
      program.push({ op: "follow", pin: item.pin, invert: item.invert });
    } else {
      return null;
    }
  }
  return program;
}
__name(sanitizeProgram, "sanitizeProgram");
var studioOr = /* @__PURE__ */ __name((value, fallback = "circuit") => STUDIOS.has(value) ? value : fallback, "studioOr");
var MAX_ROOM_MESSAGES_PER_SECOND = 120;
var AI_TEAMMATE_NAME = "Bolt";
var MAX_CLAIMS_PER_PARTICIPANT = 16;
var ALLOWED_MESSAGE_KINDS = /* @__PURE__ */ new Set([
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
  "studio",
  "program"
]);
function componentResource(value, allowEndpoint = true) {
  const resource = String(value || "").slice(0, 160);
  const match = resource.match(/^([a-z0-9-]+)(?:::endpoint-([01]))?$/);
  if (!match || !COMPONENT_IDS.has(match[1]) || !allowEndpoint && match[2] !== void 0) return null;
  return resource;
}
__name(componentResource, "componentResource");
function finiteTuple(value, limit = 20) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const tuple = value.map(Number);
  if (tuple.some((item) => !Number.isFinite(item) || Math.abs(item) > limit)) return null;
  return tuple;
}
__name(finiteTuple, "finiteTuple");
function sanitizeTransform(value) {
  if (!value || typeof value !== "object") return null;
  const position = finiteTuple(value.position);
  const rotation = finiteTuple(value.rotation, Math.PI * 16);
  if (!position || !rotation) return null;
  const transform = { position, rotation };
  if (value.sockets === null) transform.sockets = null;
  else if (value.sockets !== void 0) {
    if (!Array.isArray(value.sockets) || value.sockets.length !== 2) return null;
    const sockets = value.sockets.map((socket) => {
      if (socket === null) return null;
      const index = Number(socket);
      return Number.isInteger(index) && index >= 0 && index <= 2e3 ? index : void 0;
    });
    if (sockets.includes(void 0)) return null;
    transform.sockets = sockets;
  }
  if (value.endpoints !== void 0) {
    if (!Array.isArray(value.endpoints) || value.endpoints.length !== 2) return null;
    const endpoints = value.endpoints.map((endpoint) => finiteTuple(endpoint, 20));
    if (endpoints.some((endpoint) => !endpoint)) return null;
    transform.endpoints = endpoints;
  }
  if (value.activeEndpoint !== void 0) {
    if (value.activeEndpoint !== 0 && value.activeEndpoint !== 1) return null;
    transform.activeEndpoint = value.activeEndpoint;
  }
  if (typeof value.on === "boolean") transform.on = value.on;
  return transform;
}
__name(sanitizeTransform, "sanitizeTransform");
function sanitizeSignal(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "offer" || value.type === "answer") {
    const sdp = String(value.sdp?.sdp || "");
    if (!sdp || sdp.length > 48e3) return null;
    return { type: value.type, sdp: { type: value.type, sdp } };
  }
  if (value.type !== "candidate") return null;
  const candidateText = String(value.candidate?.candidate || "");
  if (!candidateText || candidateText.length > 4096) return null;
  const candidate = { candidate: candidateText };
  if (value.candidate.sdpMid !== void 0 && value.candidate.sdpMid !== null) {
    candidate.sdpMid = String(value.candidate.sdpMid).slice(0, 128);
  }
  if (value.candidate.sdpMLineIndex !== void 0 && value.candidate.sdpMLineIndex !== null) {
    const index = Number(value.candidate.sdpMLineIndex);
    if (!Number.isInteger(index) || index < 0 || index > 64) return null;
    candidate.sdpMLineIndex = index;
  }
  if (value.candidate.usernameFragment) {
    candidate.usernameFragment = String(value.candidate.usernameFragment).slice(0, 256);
  }
  return { type: "candidate", candidate };
}
__name(sanitizeSignal, "sanitizeSignal");
function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}
__name(json, "json");
function configuredValues(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}
__name(configuredValues, "configuredValues");
function isAdminEmail(env, email) {
  return configuredValues(env.ADMIN_EMAILS).has(String(email || "").toLowerCase());
}
__name(isAdminEmail, "isAdminEmail");
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
__name(accessClaims, "accessClaims");
async function accessIdentity(request, context, env) {
  let identity = null;
  if (context.access) {
    try {
      identity = await context.access.getIdentity();
    } catch {
    }
  }
  const assertion = request.headers.get("cf-access-jwt-assertion");
  const claims = accessClaims(assertion);
  const assertedEmail = assertion ? request.headers.get("cf-access-authenticated-user-email") : null;
  const emailValue = identity?.email || claims?.email || assertedEmail;
  if (!emailValue) return null;
  const email = String(emailValue).toLowerCase().slice(0, 320);
  const id = String(identity?.user_uuid || identity?.id || claims?.sub || email).slice(0, 200);
  const name = String(identity?.name || claims?.name || claims?.given_name || email.split("@")[0] || "Maker").slice(0, 80);
  return { id, name, email, role: isAdminEmail(env, email) ? "admin" : "member" };
}
__name(accessIdentity, "accessIdentity");
function neonEndpoint(connectionString) {
  const connection = new URL(connectionString);
  return `https://${connection.hostname}/sql`;
}
__name(neonEndpoint, "neonEndpoint");
async function neonQuery(env, query, params = []) {
  if (!env.DATABASE_URL) return null;
  const response = await fetch(neonEndpoint(env.DATABASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Neon-Connection-String": env.DATABASE_URL
    },
    body: JSON.stringify({ query, params })
  });
  if (!response.ok) {
    throw new Error(`Neon query failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}
__name(neonQuery, "neonQuery");
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
    [identity.id, identity.email, identity.name]
  );
  await neonQuery(
    env,
    `INSERT INTO makerspace_rooms (code, created_by)
     VALUES ($1, $2)
     ON CONFLICT (code) DO NOTHING`,
    [roomCode, identity.id]
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
    [roomCode, identity.id, membershipRole]
  );
  return true;
}
__name(recordRoomMembership, "recordRoomMembership");
function roomStub(env, roomCode) {
  return env.MAKERSPACE_ROOMS.getByName(roomCode);
}
__name(roomStub, "roomStub");
async function roomMetadata(env, roomCode) {
  const response = await roomStub(env, roomCode).fetch("https://room.internal/meta");
  return response.status === 200 ? response.json() : null;
}
__name(roomMetadata, "roomMetadata");
async function createRoomRecord(env, roomCode, creator, studio = "circuit") {
  const response = await roomStub(env, roomCode).fetch("https://room.internal/meta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: roomCode,
      createdById: creator.id,
      createdByEmail: creator.email,
      createdByName: creator.name,
      createdAt: Date.now(),
      studio: studioOr(studio)
    })
  });
  if (!response.ok) throw new Error(`Room registry write failed (${response.status})`);
  return response.json();
}
__name(createRoomRecord, "createRoomRecord");
async function ensureKnownRoom(env, roomCode) {
  const existing = await roomMetadata(env, roomCode);
  if (existing) return existing;
  if (!configuredValues(env.PRECREATED_ROOMS).has(roomCode.toLowerCase())) return null;
  const [adminEmail = "system"] = configuredValues(env.ADMIN_EMAILS);
  return createRoomRecord(env, roomCode, {
    id: `precreated:${roomCode}`,
    email: adminEmail,
    name: "Makerspace administrator"
  });
}
__name(ensureKnownRoom, "ensureKnownRoom");
function roomCodeFromPath(pathname, suffix = "/join") {
  const match = pathname.match(new RegExp(`^/api/rooms/([^/]+)${suffix}$`));
  const code = match ? decodeURIComponent(match[1]).trim().toUpperCase() : "";
  return ROOM_CODE.test(code) ? code : null;
}
__name(roomCodeFromPath, "roomCodeFromPath");
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
    redirect: "follow"
  });
}
__name(fetchStaticSite, "fetchStaticSite");
var worker_default = {
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
          roomTransport: "durable-object-websocket"
        });
      }
      const infoCode = roomCodeFromPath(url.pathname, "");
      if (infoCode && request.method === "GET") {
        const metadata = await ensureKnownRoom(env, infoCode);
        if (!metadata) return json({ room: infoCode, exists: false }, { status: 404 });
        return json({ room: infoCode, exists: true, studio: studioOr(metadata.studio) });
      }
      const joinCode = roomCodeFromPath(url.pathname);
      if (joinCode && request.method === "POST") {
        try {
          const body = await request.json().catch(() => ({}));
          let metadata = await ensureKnownRoom(env, joinCode);
          let created = false;
          if (!metadata) {
            if (identity.role !== "admin") {
              return json({ error: "Only an administrator can create a new room" }, { status: 404 });
            }
            metadata = await createRoomRecord(env, joinCode, identity, body?.studio);
            created = true;
          }
          const membershipRole = metadata.createdByEmail === identity.email ? "owner" : "member";
          const persisted = await recordRoomMembership(env, joinCode, identity, membershipRole);
          return json({
            room: joinCode,
            joined: true,
            created,
            persisted,
            role: membershipRole,
            studio: studioOr(metadata.studio),
            program: metadata.program ?? null,
            programRunning: Boolean(metadata.programRunning)
          });
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
        const isAgent = url.searchParams.get("agent") === "1";
        const requestedSession = (url.searchParams.get("participant") || "").slice(0, 260);
        const sessionId = requestedSession.startsWith(`${identity.id}:`) ? requestedSession : `${identity.id}:${crypto.randomUUID()}`;
        if (env.DATABASE_URL && !isAgent) {
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
        headers.set("x-maker-name", encodeURIComponent(isAgent ? AI_TEAMMATE_NAME : identity.name));
        headers.set("x-maker-host", !isAgent && (identity.role === "admin" || metadata.createdByEmail === identity.email) ? "1" : "0");
        headers.set("x-maker-agent", isAgent ? "1" : "0");
        const room = roomStub(env, roomCode);
        return room.fetch(new Request(request, { headers }));
      }
      return json({ error: "Not found" }, { status: 404 });
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return fetchStaticSite(request, env, url);
  }
};
var MakerspaceRoom = class extends DurableObject {
  static {
    __name(this, "MakerspaceRoom");
  }
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.claims = /* @__PURE__ */ new Map();
    this.messageRates = /* @__PURE__ */ new Map();
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
          studio: studioOr(incoming.studio)
        };
        await this.state.storage.put("metadata", metadata);
        return json(metadata, { status: 201 });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    if (request.headers.get("x-maker-agent") === "1") {
      const hostId = request.headers.get("x-maker-id");
      const hostPresent = this.state.getWebSockets().some((socket) => {
        const attachment2 = socket.deserializeAttachment();
        return attachment2 && attachment2.userId === hostId && !attachment2.agent;
      });
      if (!hostPresent) return new Response("AI teammate needs its host in the room", { status: 403 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment = {
      id: request.headers.get("x-maker-session-id") || crypto.randomUUID(),
      userId: request.headers.get("x-maker-id") || "unknown",
      name: decodeURIComponent(request.headers.get("x-maker-name") || "Maker").slice(0, 80),
      canHost: request.headers.get("x-maker-host") === "1",
      agent: request.headers.get("x-maker-agent") === "1",
      joinedAt: Date.now()
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
    const rate = !previousRate || now - previousRate.startedAt >= 1e3 ? { startedAt: now, count: 1 } : { startedAt: previousRate.startedAt, count: previousRate.count + 1 };
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
      const participantClaimCount = [...this.claims.values()].filter((claim) => claim.participantId === attachment.id).length;
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
      const resourceId = endpoint === 0 || endpoint === 1 ? `${message.componentId}::endpoint-${endpoint}` : message.componentId;
      const current = this.claims.get(resourceId);
      if (current && current.participantId !== attachment.id) return;
    }
    if (message.kind === "studio" || message.kind === "program") {
      const update = message.kind === "studio" ? { studio: message.studio } : { program: message.program, programRunning: message.running };
      this.state.storage.get("metadata").then((metadata) => {
        if (metadata) return this.state.storage.put("metadata", { ...metadata, ...update });
      });
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
        componentId: resourceId
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
          activity: ["available", "inspecting", "moving", "discussing", "testing", "reflecting"].includes(incoming.participant?.activity) ? incoming.participant.activity : "available",
          activityDetail: incoming.participant?.activityDetail ? String(incoming.participant.activityDetail).slice(0, 120) : void 0,
          lastActiveAt: Number.isFinite(incoming.participant?.lastActiveAt) ? incoming.participant.lastActiveAt : Date.now(),
          kind: participant.agent ? "agent" : "human"
        }
      };
    }
    if (incoming.kind === "chat") {
      return {
        kind: "chat",
        message: {
          id: String(incoming.message?.id || crypto.randomUUID()).slice(0, 100),
          participantId: participant.id,
          author: participant.name,
          body: String(incoming.message?.body || "").slice(0, 4e3),
          createdAt: Date.now(),
          context: incoming.message?.context ? String(incoming.message.context).slice(0, 160) : void 0
        }
      };
    }
    if (incoming.kind === "claim" || incoming.kind === "release") {
      const componentId = componentResource(incoming.componentId, true);
      if (!componentId) return null;
      return {
        kind: incoming.kind,
        participantId: participant.id,
        participantName: participant.name,
        componentId
      };
    }
    if (incoming.kind === "studio") {
      if (!participant.canHost || !STUDIOS.has(incoming.studio)) return null;
      return { kind: "studio", participantId: participant.id, studio: incoming.studio };
    }
    if (incoming.kind === "program") {
      const program = sanitizeProgram(incoming.program);
      if (!program || typeof incoming.running !== "boolean") return null;
      return { kind: "program", participantId: participant.id, program, running: incoming.running };
    }
    if (incoming.kind === "phase") {
      if (!["frame", "build", "test", "reflect"].includes(incoming.phase)) return null;
      return { kind: "phase", participantId: participant.id, phase: incoming.phase };
    }
    if (incoming.kind === "trace") {
      const trace = incoming.trace || {};
      if (!["inspect", "claim", "move", "discuss", "test", "snapshot", "role", "phase", "ready", "reflect", "teach"].includes(trace.action)) return null;
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
          studio: studioOr(trace.studio),
          objectId: trace.objectId ? String(trace.objectId).slice(0, 160) : void 0,
          objectName: trace.objectName ? String(trace.objectName).slice(0, 160) : void 0,
          detail: trace.detail ? String(trace.detail).slice(0, 240) : void 0
        }
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
        componentName: String(incoming.componentName || "Component").slice(0, 160)
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
        muted: incoming.muted !== false
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
};

// ../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-wwXtea/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-wwXtea/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  MakerspaceRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
