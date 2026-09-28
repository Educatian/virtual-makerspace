// Test-only stand-in for Cloudflare Access: maps an `e2e_email` cookie to the Access
// headers on every request, WebSocket upgrades included, then forwards to wrangler dev.
import http from "node:http";
import net from "node:net";

const [listenPort = 8800, targetPort = 8799] = process.argv.slice(2).map(Number);
const emailFrom = (cookie = "") => /(?:^|;\s*)e2e_email=([^;]+)/.exec(cookie)?.[1];
const withAccess = (headers) => {
  const email = emailFrom(headers.cookie);
  const next = { ...headers };
  delete next["cf-access-jwt-assertion"];
  delete next["cf-access-authenticated-user-email"];
  if (email) {
    next["cf-access-jwt-assertion"] = "local-e2e";
    next["cf-access-authenticated-user-email"] = decodeURIComponent(email);
  }
  return next;
};

const server = http.createServer((req, res) => {
  const upstream = http.request(
    { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: withAccess(req.headers) },
    (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    },
  );
  upstream.on("error", () => res.destroy());
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(targetPort, "127.0.0.1", () => {
    const headers = withAccess(req.headers);
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`,
    );
    if (head?.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(listenPort, "127.0.0.1", () => console.log(`access proxy :${listenPort} → :${targetPort}`));
