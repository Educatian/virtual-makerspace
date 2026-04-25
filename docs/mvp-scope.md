# Virtual Makerspace — MVP Scope

Research-grade VR prototype for studying learning behavior in an electronics-breadboard makerspace.

Draft: 2026-04-24

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

### Phase 2 — Optional collaborative mode (2–3 users)

Add Colyseus server and LiveKit voice. Solo experience from Phase 1 is unchanged when client connects to no room.

**Deliverables:**
- Colyseus server (Node.js) with `MakerspaceRoom` schema (participants, breadboard state, held objects).
- Avatar presence: head + 2 hands per participant (IWSDK pose → Colyseus state at ~20 Hz).
- Object ownership model: one participant holds a component at a time; soft-takeover on request.
- Voice: LiveKit room per Colyseus room; join on room entry.
- Desktop spectator: researcher joins as `role: observer` (no avatar, read-only).
- Server-side event log: unified across all participants in a room, single source of truth for analysis.

**Open design decisions (Phase 2):**
- Avatar representation (capsule vs. simple humanoid vs. VRM)
- Conflict resolution when two hands grab same object (first-come-first-served vs. tug)
- Server hosting (Railway / Fly.io / self-host on department server — depends on IRB)

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
| `peer_join` | `{ peer_id, role: 'participant' \| 'observer' }` |
| `peer_leave` | `{ peer_id, reason }` |
| `object_ownership_transfer` | `{ entity_id, from, to }` |
| `voice_speaking_state` | `{ peer_id, speaking: boolean }` *(from LiveKit)* |

### Storage / export

- **Phase 1:** Client-side IndexedDB ring buffer (~100 MB). Export as gzipped NDJSON at session end; manual upload to Vercel Blob or research server.
- **Phase 2:** Stream events to Colyseus server (single source of truth across participants). Server batches and writes NDJSON per room. Client also keeps local copy as backup.
- **Anonymization:** `participant_id` is a random per-session UUID by default; mapping to real IDs kept in a separate encrypted lookup owned by the researcher, never in telemetry files.

---

## Success criteria (Phase 1)

- A participant can complete the LED-circuit task in < 10 min without researcher intervention.
- ≥ 99% of observable physical actions are reflected as telemetry events (spot-check with video recording).
- Scene runs at ≥ 72 FPS on Meta Quest 3.
- Session JSON export is parseable by a Python analysis notebook (provide a `schemas/` JSON Schema definition).
- Researcher can replay a session from the event log (deterministic enough for qualitative review).

## Success criteria (Phase 2)

- 3 participants + 1 observer can connect to a room, speak, and interact for ≥ 15 min without disconnect.
- Server-side event log is byte-identical to merged client logs (no loss).
- Object ownership transfers feel responsive (< 150 ms perceived latency).

---

## Next implementation steps (not yet tasks)

1. Replace the scaffolded `src/index.ts`, `src/robot.ts`, `src/panel.ts` demo content with a minimal breadboard scene skeleton.
2. Define custom ECS components: `SocketGrid`, `CircuitNode`, `WireEnds`, `LedState`, `PowerSource`.
3. Build telemetry system (`src/systems/TelemetrySystem.ts`) as an ECS system that subscribes to events and writes to IndexedDB ring buffer.
4. Author `schemas/telemetry-v0.1.json` (JSON Schema) for validation.
5. Stand up `npm run dev` + connect Claude Code MCP for agentic iteration on the scene.

Once Phase 1 is validated with a solo pilot, Phase 2 networking work begins in a separate branch.
