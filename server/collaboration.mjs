import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.COLLAB_PORT ?? 8787);
const rooms = new Map();
const server = new WebSocketServer({ host: "0.0.0.0", port });

function roomFor(request) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  return (url.searchParams.get("room") ?? "").trim().toUpperCase().slice(0, 12);
}

server.on("connection", (socket, request) => {
  const room = roomFor(request);
  if (!room) {
    socket.close(1008, "Room code required");
    return;
  }

  const peers = rooms.get(room) ?? new Set();
  peers.add(socket);
  rooms.set(room, peers);

  socket.on("message", (payload, isBinary) => {
    if (isBinary || payload.byteLength > 64 * 1024) return;
    let message;
    try {
      message = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (!message || typeof message.kind !== "string") return;
    const encoded = JSON.stringify(message);
    for (const peer of peers) {
      if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(encoded);
    }
  });

  socket.on("close", () => {
    peers.delete(socket);
    if (peers.size === 0) rooms.delete(room);
  });
});

server.on("listening", () => {
  console.log(`Virtual Makerspace collaboration server listening on ws://0.0.0.0:${port}`);
});
