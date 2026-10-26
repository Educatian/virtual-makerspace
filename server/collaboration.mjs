// Local WebSocket room relay for development (npm run collab). Uses the same room coordination
// as the Cloudflare Durable Object (cloudflare/room-core.js): claims, authoritative bench state,
// revisions, atomic edits and refusals. Other messages are relayed as before. No auth: the
// participant id comes from the socket URL, as the client sends it.
import { WebSocket, WebSocketServer } from "ws";

import { RoomCore } from "../cloudflare/room-core.js";
import { componentResource, sanitizeEdit, sanitizeProgram, sanitizeTransform } from "../cloudflare/sanitize.js";
import { sanitizeRescueAction } from "../src/episodes/rescue-state.ts";

const port = Number(process.env.COLLAB_PORT ?? 8787);
const rooms = new Map();
const server = new WebSocketServer({ host: "0.0.0.0", port });

function roomFor(request) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  return {
    room: (url.searchParams.get("room") ?? "").trim().toUpperCase().slice(0, 12),
    participantId: (url.searchParams.get("participant") ?? "").slice(0, 260),
  };
}

/** What a client may send (as the Worker's list). Room replies — room-state, edit-result,
 * rev-ack, claim-granted/denied, transform-rejected — come only from the room, never relayed. */
const CLIENT_KINDS = new Set([
  "hello", "presence", "goodbye", "chat", "transform", "claim", "release", "voice-state", "phase", "trace",
  "attention", "state-request", "state-response", "signal", "studio", "program", "edit", "room-state-request", "episode",
]);

/** Validates the bench messages the room core acts on; other client kinds pass through. */
function sanitize(message, participant) {
  if (!CLIENT_KINDS.has(message.kind)) return null;
  switch (message.kind) {
    case "claim":
    case "release": {
      const componentId = componentResource(message.componentId, true);
      return componentId ? { kind: message.kind, participantId: participant.id, participantName: participant.name, componentId } : null;
    }
    case "transform": {
      const componentId = componentResource(message.componentId, false);
      const transform = componentId ? sanitizeTransform(message.transform, componentId) : null;
      if (!transform || !Number.isSafeInteger(message.sequence)) return null;
      return { kind: "transform", participantId: participant.id, componentId, transform, sequence: message.sequence };
    }
    case "edit": {
      const edit = sanitizeEdit(message);
      return edit ? { kind: "edit", participantId: participant.id, ...edit } : null;
    }
    case "episode": {
      const action = sanitizeRescueAction(message.action);
      return action && typeof message.opId === "string" && /^[\w-]{1,80}$/.test(message.opId) ? { kind: "episode", participantId: participant.id, opId: message.opId, action } : null;
    }
    case "program": {
      const program = sanitizeProgram(message.program);
      return program && typeof message.running === "boolean" ? { kind: "program", participantId: participant.id, program, running: message.running } : null;
    }
    default:
      return message;
  }
}

server.on("connection", (socket, request) => {
  const { room, participantId } = roomFor(request);
  if (!room || !participantId) {
    socket.close(1008, "Room code and participant required");
    return;
  }
  const entry = rooms.get(room) ?? { peers: new Set(), core: new RoomCore() };
  entry.peers.add(socket);
  rooms.set(room, entry);
  const participant = { id: participantId, name: "Maker" };

  socket.on("message", (payload, isBinary) => {
    if (isBinary || payload.byteLength > 64 * 1024) return;
    let message;
    try {
      const parsed = JSON.parse(payload.toString());
      if (!parsed || typeof parsed.kind !== "string") return;
      if (parsed.kind === "hello" && typeof parsed.participant?.name === "string") participant.name = parsed.participant.name.slice(0, 80);
      message = sanitize(parsed, participant);
    } catch {
      return;
    }
    if (!message) return;
    const result = entry.core.handle(participant, message);
    for (const reply of result.sender) socket.send(JSON.stringify(reply));
    if (message.kind === "hello") for (const reply of entry.core.join()) socket.send(JSON.stringify(reply));
    for (const relay of result.others) {
      const encoded = JSON.stringify(relay);
      for (const peer of entry.peers) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(encoded);
      }
    }
  });

  socket.on("close", () => {
    entry.peers.delete(socket);
    const released = entry.core.leave(participant);
    for (const peer of entry.peers) {
      if (peer.readyState !== WebSocket.OPEN) continue;
      for (const message of released) peer.send(JSON.stringify(message));
      peer.send(JSON.stringify({ kind: "goodbye", participantId: participant.id }));
    }
    if (entry.peers.size === 0) rooms.delete(room);
  });
});

server.on("listening", () => {
  console.log(`Virtual Makerspace collaboration server listening on ws://0.0.0.0:${port}`);
});
