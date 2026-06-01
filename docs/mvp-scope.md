# Virtual Makerspace — MVP Scope

Research-grade VR prototype for studying learning behavior in an electronics-breadboard makerspace.

Draft: 2026-04-24; updated 2026-05-31 after Phase 2 CPS implementation

---

## Research goals

1. **Primary:** Instrument learner behavior (exploration, manipulation, failure, recovery) at high temporal resolution in an embodied VR makerspace task.
2. **Secondary:** Support solo-vs-collaborative comparison conditions (dyads/triads) for collaborative-learning studies.
3. **Tertiary:** Produce a reusable WebXR + telemetry foundation that future studies (affective agent, SRL, creativity) can extend.

## Out of scope (explicit anti-scope)

- Horizon Store native app — WebXR deployment only.
- Curriculum / instructional design content beyond a minimal "build this circuit" prompt.
- Realistic circuit simulation (SPICE-level). MVP uses symbolic connection validation.
- Accessibility adaptations beyond IWSDK defaults (Phase 3+).
- Asynchronous / turn-based collaboration. Collab mode is synchronous only.

---

## Phases

### Phase 1 — Solo breadboard + telemetry (core MVP)

Single-user VR. All telemetry local-to-client, POSTed to research server on session end (or streamed if server up).

**Deliverables:**
- Scene: one breadboard, component tray (LEDs, resistors, wires, 9V battery), work area.
- Interactions: pickup, place (on breadboard holes), connect (wire ends to holes), remove.
- Feedback: visual snap-to-grid on placement, LED lights up when circuit closed.
- Prompt UI: "Build a circuit that lights the LED" (minimal).
- Telemetry: all events logged with schema below; local IndexedDB + JSON export.
- Spectator-URL mode: same build served at `/spectate` renders scene as a desktop third-person camera (no XR session), for researcher monitoring of a single participant.

**Explicit non-goals for Phase 1:** networking, voice, multi-user state sync, avatars.

### Phase 2 — Collaborative CPS mode (2 users, implemented)

Add a Cloudflare Durable Object realtime worker and optional LiveKit voice. Solo experience from Phase 1 is unchanged when the client runs without a collab room.

**Deliverables:**
- Durable Object `MakerspaceRoom` with authoritative participants, part ownership, snap state, LED state, and pose relay.
- Avatar presence: head + 2 hands per participant (IWSDK pose → worker state at ~15 Hz).
- Asymmetric jigsaw task: role A owns the power half, role B owns the load half; neither can close the circuit alone.
- Object ownership model: one participant holds a component at a time; server ignores conflicting grabs.
- Voice: optional LiveKit room per worker room; join on room entry when credentials are configured.
- Server-side event log: persisted room-level NDJSON export via `GET /room/<code>/telemetry`, with client IndexedDB as backup.
- CPS signal layer: joint gaze, joint attention samples, partner orientation, handoff, voice speaking state, and turn-taking.

**Open design decisions (Phase 2):**
- Avatar representation (capsule vs. simple humanoid vs. VRM)
- Conflict resolution when two hands grab same object (first-come-first-served vs. tug)
- Shared partner-gaze visibility on/off as an experimental manipulation
- Empirical calibration thresholds for joint gaze, partner orientation, and handoff windows
- LiveKit Egress + local Whisper transcription pipeline

### Phase 3 — Extensions (placeholders, not in MVP)

- Affective agent integration (tie-in with existing affective-video-agent research)
- Adaptive prompting / scaffolding system
- Second maker tool (3D-printing sim? woodworking? — revisit after Phase 1 learnings)
- PWA manifest for install-on-Quest experience

---

## Scene entities (Phase 1)

| Entity | Count | Components (ECS) | Notes |
|---|---|---|---|
| Work table | 1 | `StaticCollider`, `LocomotionEnvironment` | IWSDK requires env for locomotion |
| Breadboard | 1 | `Grabbable`, `PhysicsBody` (static), `SocketGrid` *(custom)* | Grid of snap-sockets for component leads |
| Component tray | 1 | `StaticCollider`, `ComponentSpawner` *(custom)* | Respawns components when tray empty |
| LED | 3–5 | `OneHandGrabbable`, `PhysicsBody`, `CircuitNode` *(custom)*, `LedState` *(custom)* | Lights up when circuit closed |
| Resistor | 5 | `OneHandGrabbable`, `PhysicsBody`, `CircuitNode` *(custom)* | Symbolic resistance value |
| Wire | 5 | `OneHandGrabbable`, `WireEnds` *(custom)* | Two endpoints, each can snap to a socket |
| 9V Battery | 1 | `OneHandGrabbable`, `PhysicsBody`, `CircuitNode` *(custom)`, `PowerSource` *(custom)* | Drives the circuit |
| Prompt panel | 1 | `StaticCollider`, `UIKitML` | Floating in-world instruction card |
| HUD / menu | 1 | `SpatialUI` | Restart, export log, settings |

## Interaction verbs (Phase 1)

| Verb | Trigger | Effects | Telemetry |
|---|---|---|---|
| `grab` | Hand trigger near grabbable | Attach to hand | `grab_start` |
| `release` | Trigger released | Detach, physics resumes | `grab_end` |
| `place_on_socket` | Release while lead near socket | Snap transform, register connection | `socket_connect` |
| `disconnect` | Grab away from socket | Release connection | `socket_disconnect` |
| `circuit_evaluate` | Any socket change | Re-run closure detection | `circuit_state_change` |
| `restart` | Menu button | Reset scene, preserve log | `session_reset` |

---

## Telemetry schema (draft v0.1)

All events share a base envelope:

```typescript
interface TelemetryEvent {
  event_id: string;           // uuid v7 (time-ordered)
  session_id: string;         // uuid per VR session
  participant_id: string;     // stable ID; anonymized in export
  room_id?: string;           // present only in collab mode
  event_type: string;         // see Event catalog
  timestamp_ms: number;       // client wall-clock (ms since unix epoch)
  frame_time_ms: number;      // ms since session start (monotonic)
  // transform context (when applicable)
  head_pose?: Pose;
  hand_l_pose?: Pose;
  hand_r_pose?: Pose;
  // event-specific payload
  payload: Record<string, unknown>;
}

interface Pose {
  pos: [number, number, number];
  rot: [number, number, number, number]; // quaternion
}
```

### Event catalog (v0.1)

| event_type | Payload | Emitted when |
|---|---|---|
| `session_start` | `{ build_id, iwsdk_version, device }` | World created |
| `session_end` | `{ duration_ms, reason }` | User ends or timeout |
| `grab_start` | `{ entity_id, entity_type, hand }` | Grab begins |
| `grab_end` | `{ entity_id, hand, held_duration_ms }` | Release |
| `socket_connect` | `{ entity_id, socket_id, lead_index }` | Lead snaps to socket |
| `socket_disconnect` | `{ entity_id, socket_id }` | Lead leaves socket |
| `circuit_state_change` | `{ closed: boolean, components_in_loop: string[] }` | Topology change |
| `circuit_closed_success` | `{ time_to_close_ms, attempts, components_used }` | LED lights up |
| `gaze_dwell` | `{ target_entity, duration_ms }` | Gaze fixated ≥500 ms on an entity |
| `teleport` | `{ from_pos, to_pos, distance_m }` | Locomotion |
| `ui_interaction` | `{ element_id, action }` | Any UIKitML event |
| `error_recovery` | `{ error_type, prior_state }` | User undoes a misplacement |
| `think_aloud_marker` | `{ marker_type: 'pause' \| 'verbalization' }` | (optional) manual researcher marker |

### Collab-only events (Phase 2)

| event_type | Payload |
|---|---|
| `partner_join` | `{ partner_pid, partner_role, partner_nickname }` |
| `partner_leave` | `{ partner_pid }` |
| `avatar_spawn` | `{ partner_pid }` |
| `avatar_despawn` | `{ partner_pid }` |
| `joint_gaze_start/end` | `{ partner_pid, target_id, server_time_ms, ... }` |
| `joint_attention_sample` | `{ partner_pid, target_id, server_time_ms, ... }` |
| `partner_orient_start/end` | `{ partner_pid, server_time_ms, ... }` |
| `handoff` | `{ from_pid, to_pid, part_id, server_time_ms }` |
| `voice_connected` | `{ room }` |
| `voice_unavailable` | `{ status }` |
| `voice_error` | `{ message }` |
| `voice_speaking_state` | `{ peer_id, speaking: boolean, server_time_ms }` *(from LiveKit)* |
| `turn_take` | `{ previous_speaker, new_speaker, gap_ms, overlap_ms, server_time_ms }` |

### Storage / export

- **Phase 1:** Client-side IndexedDB ring buffer (~100 MB). Export as gzipped NDJSON at session end; manual upload to Vercel Blob or research server.
- **Phase 2:** Stream events to the Durable Object room. The worker persists ordered telemetry events in DO storage and exports NDJSON at `GET /room/<code>/telemetry`. Client IndexedDB also keeps a local backup.
- **Anonymization:** `participant_id` is a random per-session UUID by default; mapping to real IDs kept in a separate encrypted lookup owned by the researcher, never in telemetry files.

---

## Success criteria (Phase 1)

- A participant can complete the LED-circuit task in < 10 min without researcher intervention.
- ≥ 99% of observable physical actions are reflected as telemetry events (spot-check with video recording).
- Scene runs at ≥ 72 FPS on Meta Quest 3.
- Session JSON export is parseable by a Python analysis notebook (provide a `schemas/` JSON Schema definition).
- Researcher can replay a session from the event log (deterministic enough for qualitative review).

## Success criteria (Phase 2)

- 2 participants can connect to a room, speak when LiveKit is configured, and interact for ≥ 15 min without disconnect.
- Server-side event log covers all client-sent CPS events and exports as valid `schemas/telemetry-v1.json` NDJSON.
- Object ownership transfers feel responsive (< 150 ms perceived latency).

---

## Next implementation steps

1. Configure production LiveKit credentials and verify `/token/<room>` returns a token JSON or controlled 503.
2. Run in-headset dyad pilot on Quest 2/3 and validate joint gaze / partner orientation thresholds against video.
3. Connect LiveKit Egress to audio storage and run local Whisper transcription on JACOB GPU.
4. Merge client exports and worker NDJSON on `server_time_ms`, then run `python scripts/analyze_session.py <export.ndjson> --strict`.
5. Decide whether shared partner-gaze visibility is a main experimental manipulation or a Phase 3 extension.
