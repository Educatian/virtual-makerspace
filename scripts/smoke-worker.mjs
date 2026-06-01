#!/usr/bin/env node

const base = process.env.VM_WORKER_URL ?? "https://vm-realtime.jewoong-moon.workers.dev";
const room = process.env.VM_ROOM ?? `codexcheck${Date.now().toString(36)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readText(url) {
  const res = await fetch(url);
  return { res, text: await res.text() };
}

async function main() {
  const health = await readText(`${base}/health`);
  assert(health.res.ok && health.text === "ok", `health failed: ${health.res.status} ${health.text}`);

  const token = await readText(`${base}/token/${room}?identity=smoke&name=Smoke`);
  assert(
    token.res.ok || token.res.status === 503,
    `token route returned unexpected status ${token.res.status}`,
  );
  if (token.res.status === 503) {
    assert(
      token.text.includes("voice-not-configured"),
      `token 503 did not report voice-not-configured: ${token.text}`,
    );
  } else {
    const payload = JSON.parse(token.text);
    assert(payload.token && payload.url, "token response missing token/url");
  }

  const event = {
    event_id: crypto.randomUUID(),
    session_id: "worker-smoke",
    participant_id: "worker-smoke",
    mode: "collab",
    role: "A",
    room,
    condition: "smoke",
    event_type: "session_start",
    timestamp_ms: Date.now(),
    frame_time_ms: 0,
    payload: { smoke: true },
  };

  await new Promise((resolve, reject) => {
    const wsUrl = `${base.replace(/^http/, "ws")}/room/${room}`;
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch (_) {}
      reject(new Error("websocket telemetry ack timeout"));
    }, 10000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "hello", pid: "worker-smoke", role: "A", nickname: "Smoke" }));
      ws.send(JSON.stringify({ t: "telemetry", event }));
    });
    ws.addEventListener("message", (msg) => {
      const data = JSON.parse(msg.data);
      if (data.t === "telemetryAck" && data.event_id === event.event_id) {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });
    ws.addEventListener("error", reject);
  });

  const state = await readText(`${base}/room/${room}/state`);
  assert(state.res.ok, `state failed: ${state.res.status} ${state.text}`);
  const stateJson = JSON.parse(state.text);
  assert(stateJson.telemetryCount >= 1, `state telemetryCount not updated: ${state.text}`);

  const telemetry = await readText(`${base}/room/${room}/telemetry`);
  assert(telemetry.res.ok, `telemetry export failed: ${telemetry.res.status}`);
  assert(telemetry.text.includes(event.event_id), "telemetry export missing smoke event");

  console.log(
    JSON.stringify({
      ok: true,
      base,
      room,
      tokenStatus: token.res.status,
      telemetryCount: stateJson.telemetryCount,
      lines: telemetry.text.trim() ? telemetry.text.trim().split("\n").length : 0,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
