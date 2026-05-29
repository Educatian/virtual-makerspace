# Phase 2 — Collaborative Problem-Solving (CPS) Build

Status: **complete and runnable** (2026-05-28). `npx tsc --noEmit` clean for root and
`server/`, `npm run build` green, telemetry contract validated end-to-end.

This phase turns the solo breadboard MVP into a 2-person asymmetric CPS research
environment instrumented against the **PISA 2015** collaborative problem-solving
framework (Graesser / Foltz / Rosen / Andrews-Todd 12-cell matrix: 3 collaboration
dimensions x 4 problem-solving stages).

## Architecture

```
 Browser A (role A: power)          Cloudflare Worker                 Browser B (role B: load)
 ┌─────────────────────┐      ┌──────────────────────────┐      ┌─────────────────────┐
 │ IWSDK / WebXR scene  │ WS   │  MakerspaceRoom (DO)       │  WS  │ IWSDK / WebXR scene  │
 │  realtime-client ────┼─────▶│   authoritative state:     │◀─────┼──── realtime-client │
 │  network-sync-system │      │   parts, players, poses,   │      │  network-sync-system│
 │  remote-avatar-system│      │   LED, telemetry log       │      │  remote-avatar-system│
 │  cps-signal-system   │      │  GET /token/:room (LiveKit │      │  cps-signal-system  │
 │  livekit-client ─────┼─http▶│   JWT mint, HS256)         │◀http─┼──── livekit-client  │
 └─────────────────────┘      └──────────────────────────┘      └─────────────────────┘
            │ mic/audio  ────────────  LiveKit Cloud  ────────────  mic/audio │
```

- **Realtime sync** — `server/src/index.ts` Durable Object is the single source of
  truth for part ownership, snap state, LED-lit, and merged telemetry. Clients send
  `hello/grab/release/snap/pose/telemetry/ping`; server broadcasts
  `state/playerJoin/playerLeave/partUpdate/pose/ledLit/...`.
- **Asymmetric jigsaw task** — Role A owns the battery + blue wire (power half),
  Role B owns the LED + red wire (load half). Neither can close the circuit alone, so
  the task *requires* coordination — the precondition for observable CPS.
- **Voice** — `livekit-client.ts` fetches a JWT from the worker `/token/:room`,
  joins a LiveKit room, publishes mic, and derives speaking-state telemetry. Fully
  gated on `realtime.enabled`; degrades to a clean no-op when LiveKit is unconfigured.

## CPS measurement layer (`src/systems/cps-signal-system.ts`)

Pure client-side geometry from data already on the wire (local `this.player` head/hands,
partner pose via the realtime `pose` stream, part ownership via `partUpdate`). Zero
per-frame allocation; all events are dwell + hysteresis gated (state transitions, not
per-frame spam). Every payload carries `server_ts` (clock-synced) as the dyad join key.

| Event | Trigger | PISA dimension |
|---|---|---|
| `joint_gaze_start/end` | both heads converge on the breadboard (<25° enter / >32° exit, 800 ms dwell) | Dim1 shared understanding |
| `joint_attention_sample` | continuous 5 s sample of gaze/orient/distance | Dim1 (continuous proxy) |
| `partner_orient_start/end` | local head faces partner head (<20°, <3 m, 600 ms dwell) | Dim3 team organisation |
| `handoff` | part ownership crosses the me/partner boundary within 4 s of a release/grab | Dim2 appropriate action |
| `voice_speaking_state` | per-peer speaking on/off edge (LiveKit ActiveSpeakers) | Dim1 shared understanding |
| `turn_take` | dominant-speaker transition, with gap_ms / overlap_ms | Dim1 shared understanding |

> Thresholds are first-pass and **not empirically calibrated** — tune against pilot
> dyad recordings. The 4 PISA *stages* (columns) are assigned downstream by binning
> `server_ts` against task-phase markers, not in this system.

## Data contract + analysis

- `schemas/telemetry-v1.json` — JSON Schema (draft 2020-12) validating the envelope
  and the per-event payload of **every** `telemetry.log()` call site. This is the
  single source of truth; emitters and the schema are kept in lockstep.
- `scripts/analyze_session.py` — validates an NDJSON export against the schema, prints
  a session summary, a CPS-signal timeline (with start/end pairing), and a PISA 12-cell
  scaffold tally. `python scripts/analyze_session.py export.ndjson --strict`.
  Requires `pip install jsonschema`. Each export is one client's view; true dyadic
  coding merges both participants' exports on `server_ts`.

## Run a 2-person session locally

```bash
# Terminal 1 — realtime worker (Durable Object)
cd server && npm run dev          # wrangler dev, http://localhost:8787

# Terminal 2 — IWSDK client (Vite, HTTPS)
npm run dev                       # https://localhost:8081
```

To point the client at the local worker, set `VITE_REALTIME_URL=ws://localhost:8787`
in a root `.env` before `npm run dev` (default target is the deployed worker).

Open two tabs/headsets, same `room`, distinct `pid`:

- Role A: `https://localhost:8081/?mode=collab&role=A&room=demo1&pid=p1&nick=Alice&cond=baseline`
- Role B: `https://localhost:8081/?mode=collab&role=B&room=demo1&pid=p2&nick=Bob&cond=baseline`
- Solo:   `https://localhost:8081/?mode=solo&pid=p0&cond=baseline` (no CPS/voice signals)

## Enabling voice (LiveKit)

Voice is optional and off until configured. To enable:

1. Create a LiveKit Cloud project; note `LIVEKIT_URL` (wss://…livekit.cloud), API key, secret.
2. Local: `server/.dev.vars` with `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   (gitignored). Production: `wrangler secret put LIVEKIT_API_KEY` / `..._SECRET`, and
   `LIVEKIT_URL` as a `[vars]` entry or secret.
3. Without these, `/token/:room` returns `503 voice-not-configured` and the client logs
   `voice_unavailable` and runs without audio — state sync and CPS signals are unaffected.

**Recording** is LiveKit Egress (deploy/ops config), keyed by room name to object
storage; the client captures the speaking timeline as the analyzable signal. Ensure
IRB / consent covers audio before enabling recording.
