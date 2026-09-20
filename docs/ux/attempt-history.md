# Interaction blueprint: Attempt History panel

Backward-looking 4-slot snapshot strip. Pedagogy clearance: `docs/pedagogy/attempt-history.md` (APPROVE WITH CHANGES — locks listed below).

## Locks (do not re-litigate)

- Trigger: 1500ms stable dwell after `socket_connect` / `socket_disconnect` (and on `task_complete`)
- Representation: 2D abstract socket-grid, neutral grey, type-by-shape only
- K = 4 FIFO, no count label, no time label
- Read-only, identical in PF and DI
- De-duplication on identical placement set vs most-recent slot

## Sensory contract

- **What the user does**: builds, breaks, rebuilds. Does not interact with the panel directly.
- **What they perceive in response**: a low-contrast strip of up to four 2D thumbnails sitting on the workbench, behind/beside the breadboard. New thumbnail appears in the right-most slot 1500ms after the last topology change settles. No animation, no chime.
- **Latency budget**: dwell timer expiry → thumbnail visible ≤ 50ms. Drawing is canvas-backed (no per-frame cost while idle).
- **Failure mode feel**: there is none — the panel never evaluates. If the user fails 30 times in a row, the strip shows their last 4 of 30, neutrally. Compliance with `interaction-spec.md §8` and `style-guide.md §1`.

## 1. Placement — locked: Option A (workbench-static, world-positioned)

**Rejected: Option B (HUD follower).** A follower puts the history *inside* the working FOV. Charter §6 forbids score-like presence; a head-locked record of attempts will read as a scoreboard regardless of styling. Worse, four thumbnails attached to head will compete with the live breadboard for the same 0.7m focal plane.

**Rejected: Option C (mounted to breadboard).** Breadboard is currently static (`index.ts:155-157`); parenting buys nothing now. If the board ever moves, the strip moving with it would re-frame the panel as part of the task instead of beside it. Reject for charter framing, not engineering.

**Locked: Option A — static board behind the breadboard, slightly raised.**

- World position: `[-0.2, 1.04, -1.20]` (centered above-back of breadboard at `[-0.2, 0.86, -1.05]`; +0.18m up, -0.15m further from player)
- Rotation: tilted toward player ~15° around X (lifts the bottom edge slightly into view without forcing a head-turn)
- Visible only after first snapshot exists (see §7)
- No `Follower` — entity sits in world space, learner can ignore by not looking up

This puts the panel *behind* the manipulation zone — visible peripherally when the head is tilted toward the board, requires a deliberate ~10° upward glance to read in detail. Embodies "available but ignorable."

## 2. Panel size & layout — locked: 1×4 horizontal strip

**Rejected: 2×2 grid.** Reads as a "results matrix" — implies comparison. Horizontal-temporal reads as a tape, which matches "history."

**Rejected: vertical stack.** Forces head-tilt at neck-strain angles to read top→bottom; horizontal reads in a single saccade.

- Strip: 4 thumbnails left → right, oldest to newest. New attempts append on the right; left-most drops on overflow.
- Each thumbnail: 0.08m × 0.05m (board aspect ~16:6 with rowsPerHalf=2; 16:12 if rowsPerHalf=5 — see §3 note)
- Spacing: 0.014m gap between thumbnails (visually separates without grouping)
- Total panel: 0.32m wide × 0.06m tall plus 0.008m padding → 0.34m × 0.07m board with `bg-panel` `#141a26` background, `border-subtle` `#2a3245` 1px, no rounded corners.
- Empty slots not drawn (no placeholder rectangles). Strip width is dynamic until full.

## 3. Thumbnail rendering — locked: shape-only, compressed grid

**Note on grid dimensions**: pedagogy doc and user brief assumed cols=16, rowsPerHalf=2 (96 sockets). Actual code default in `breadboard.ts:67` is rowsPerHalf=**5** (192 sockets). Blueprint targets *whatever the live `SocketGrid` reports* via `entity.getValue(SocketGrid, 'cols' | 'rowsPerHalf')`. Numbers below assume rowsPerHalf=5 with auto-fit; visually similar at rowsPerHalf=2.

### Cell rendering

- One filled circle per socket *that is occupied by a lead*. Diameter = 60% of cell pitch.
- Empty sockets: NOT drawn. Pedagogy doc forbids dot-grid backdrops (would read as "fill in the missing dots" puzzle). The board outline alone provides spatial reference.
- Board outline: 1px `border-subtle` rectangle at thumbnail bounds.
- Center channel gap: 1px `border-subtle` horizontal line at vertical midpoint (signals breadboard halves; matches the live board's channel).
- Power rails: NOT marked separately. Charter §6 — minimum semantic load.

### Component shape mapping (locked per pedagogy §3)

| Component type | Shape on placed-lead pair | Rendering |
|---|---|---|
| Wire (`WireEnds`) | Straight line connecting the two lead sockets | 1px `text-muted` `#9aa6bd` line, no fill |
| Battery (`PowerSource` + `CircuitNode`) | Filled square at *each* lead socket | 60% pitch, `text-muted` fill |
| LED (`LedState`) | Filled circle at *each* lead socket | 60% pitch, `text-muted` fill — **no lit/unlit distinction** |
| Resistor (`CircuitNode` only, has WireEnds=false) | Filled triangle at *each* lead socket | 60% pitch, `text-muted` fill, point-up |

**Component type detection**: read from ECS components on the `entity.index` referenced in the `placements` payload — `WireEnds`=wire, `PowerSource`=battery, `LedState`=LED, otherwise=resistor. Cache the mapping at snapshot time so later component changes don't retroactively redraw history.

**Forbidden**: color (only `text-muted` grey allowed), checkmark, X, fill saturation variations, glow, lit/unlit emissive on LED shape, "most-recent" highlight. Per charter §6.

### Scale — fixed, not auto-fit

Each thumbnail is a fixed 96×30 px canvas (or 96×60 px at rowsPerHalf=5). Same scale across all four slots so attempts are visually comparable. Auto-fit would break that comparability and create the score-like "this attempt is bigger" misread.

## 4. Implementation approach — locked: Option A (Canvas → CanvasTexture → PlaneGeometry)

| Option | Verdict | Reason |
|---|---|---|
| A. HTML canvas → CanvasTexture | **LOCKED** | Custom dot/shape grid is trivial in 2D canvas; texture upload is once per snapshot, not per frame; bytes-cheap (4 thumbnails × 96×60 RGBA = ~92KB total). Matches `accent-circuit` precedent of one-shot mesh writes. |
| B. PanelUI / UIKitML | Reject | UIKit primitives are flex/text-oriented; a 16×12 dot grid needs 192 nested elements per thumbnail, 768 total. Layout cost and node count both excessive. Also pedagogy needs *exact pixel control* over shape rendering; UIKit's defaults do not give it. |
| C. Three.js mesh primitives | Reject | 4 boards × ~96 occupied cells is *fine* perf-wise (low dozens of meshes), BUT each shape variant (square/circle/line/triangle) needs a different geometry, and they are 0.5mm-scale meshes that will alias badly at 60cm read distance. Canvas anti-aliases for free. |

### Implementation skeleton (advisory, implementer owns details)

```ts
// One canvas + CanvasTexture per slot. Reuse, don't recreate.
class AttemptHistoryPanel {
  private slots: Array<{ canvas: HTMLCanvasElement; texture: CanvasTexture; mesh: Mesh }> = [];
  private snapshots: Snapshot[] = [];  // FIFO, max 4
  // Snapshot = { placements: Array<{id, a, b, kind: 'wire'|'battery'|'led'|'resistor'}> }

  addSnapshot(placements, kindMap): void {
    if (this.isDuplicateOfMostRecent(placements)) return;
    this.snapshots.push({ placements, kinds: kindMap });
    if (this.snapshots.length > 4) this.snapshots.shift();
    this.redrawAll();  // 4 canvases × ~96 strokes — sub-millisecond
    this.show();
  }

  private redrawAll(): void {
    for (let i = 0; i < 4; i++) {
      const slot = this.slots[i];
      slot.mesh.visible = i < this.snapshots.length;
      if (i < this.snapshots.length) {
        this.drawThumbnail(slot.canvas, this.snapshots[i]);
        slot.texture.needsUpdate = true;
      }
    }
  }
}
```

`drawThumbnail` walks `placements`, looks up kind, draws shape per §3. Pure 2D canvas calls — no Three.js work in the hot path beyond `texture.needsUpdate = true`.

## 5. Update mechanism — locked

### Storage

Module-scope FIFO array inside a new `src/systems/attempt-history-system.ts`. **Not** `world.globals` signal — no part of the system reactively depends on snapshot state, signals would add overhead for nothing. Snapshots are append-only structured data, not reactive UI inputs.

### Capture trigger (1500ms stable dwell)

The trigger lives in the system. State machine:

| State | Enter | Exit |
|---|---|---|
| `idle` | system init | `socket_connect` or `socket_disconnect` event → record current placements → `pending`, set `dwellDeadline = now + 1500` |
| `pending` | above | (a) another `socket_connect`/`socket_disconnect`/`grab_start` event → reset deadline, stay `pending`; (b) `update()` sees `now >= dwellDeadline` → `commit` |
| `commit` | dwell elapsed | snapshot current `placements` (read from `Snappable` queries), de-dup vs slot[-1], append to FIFO, redraw, log telemetry → `idle` |
| `commit` (forced) | `vm:task_complete` event | snapshot immediately (no dwell), append, → terminal |

**Why frame-checked deadline, not setTimeout**: see snap-fail-feedback pitfall #1 — `setTimeout` is throttled in inactive tabs and stretched during XR blur. `performance.now()` deadline checked in `update()` is the project convention.

### FIFO semantics

- Newest on RIGHT. Oldest dropped from LEFT. Matches the temporal-tape reading.
- When less than 4 snapshots exist, slots fill left-to-right (panel grows). When full, the strip is fixed width and content shifts left.

### Redraw scope

On new snapshot: redraw ALL four canvases. Cost is ~4 × <1ms canvas work + texture upload. Cheaper than tracking dirty slots and indexing shifts. Total budget: well under one frame (16ms).

## 6. Latency

- Dwell timer expiry → snapshot captured: ≤ 16ms (one frame, dwell checked in `update()`)
- Snapshot captured → canvas redrawn → texture uploaded → mesh visible: ≤ 16ms (synchronous; texture.needsUpdate=true is GPU-side next frame)
- **Total visible-update latency from dwell expiration**: ≤ 50ms worst case (two frames at 60fps + texture upload)

## 7. Visibility & lifecycle

- **At session start**: panel entity exists but `visible = false`. No placeholder. Pedagogy lock: "panel's existence implies recency" — showing an empty strip would imply attempts already happened.
- **First snapshot committed**: `visible = true`. No fade. Per `style-guide.md §6`, instant on.
- **After `vm:task_complete`**: final snapshot (the success topology) appended as the right-most slot with no special styling. Panel remains visible for the rest of the session. Re-grabs after completion do *not* trigger new snapshots (terminal lock — match hypothesis-card pattern).
- **Reset**: panel does not survive a page reload (snapshots are session-local per pedagogy §44 lock).

## 8. Telemetry hooks

```ts
telemetry.log("attempt_snapshot_captured", {
  snapshot_index: number,            // 0-based count of snapshots taken this session (NOT slot index)
  slot_count_after: number,          // 1..4 — how many slots are filled after this capture
  trigger_reason: "stable_dwell" | "task_complete",
  placements: Array<{ id: number; a: number; b: number; kind: "wire" | "battery" | "led" | "resistor" }>,
  // kind included so downstream analysis doesn't have to re-resolve from session ECS state
});
```

Naming follows existing `snake_case` convention (`circuit_topology`, `socket_connect`). Pedagogy doc §22 specifies `attempt_snapshot` as the event family; `_captured` action-suffix matches `near_miss_marker_shown`, `hover_target_clear` style.

**Skip `attempt_history_panel_viewed`.** Gaze is already covered by the existing `GazeSystem` (5Hz raycast against `GazeTarget`-tagged entities, see `gaze-system.ts` and `interaction-spec.md §5`). Add `GazeTarget` component to the panel root entity with `name: "attempt_history"` — the existing pipeline emits gaze events, no new event type needed. One source of truth for gaze, period.

## 9. Pitfalls to watch

1. **Component-kind resolution timing**. The kind for each placement is read at snapshot time. If the same `entity.index` is later re-assigned to a different component type (shouldn't happen in current code, but recycling could), the cached snapshot stays correct. **Do not** resolve kind at draw time.
2. **De-duplication compare**. Compare placement *sets*, not arrays — same circuit with reordered iteration order should de-dup. Use `id`-sorted JSON or a sorted hash. Pedagogy doc §21.
3. **Dwell debounce reset on `grab_start`**. Per pedagogy lock, an in-progress grab means the iteration is not stable. `grab_start` resets the deadline even if no `socket_*` event fires. Implementer must subscribe to `vm:task_start` AND listen for grab events (custom or polling SnapSystem state).
4. **Canvas at non-power-of-2 sizes**. WebGL is fine with NPOT textures since GLES2; ensure `minFilter: LinearFilter`, `generateMipmaps: false` to avoid the silent fallback to nearest-mipmap.
5. **Memory: 4 canvases stay alive forever**. ~92KB. Acceptable. Do not allocate a fresh canvas per snapshot.
6. **Texture upload cost on Quest**. CanvasTexture upload is bandwidth-bound; 4 × 96×60 RGBA = 92KB total per redraw is negligible. If we ever raise to 256×128 thumbnails, re-measure.
7. **Panel mesh is `MeshBasicMaterial`** — not StandardMaterial. The thumbnails are UI, not lit world objects. `transparent: true` (for the `bg-panel` 0.92 alpha), `depthWrite: true` (it's a solid panel; lets components occlude correctly if learner reaches behind board).
8. **Coordinate system in canvas**. Breadboard's local Z-axis runs front-to-back; thumbnail's canvas Y-axis is top-down. Map socket `row` → canvas Y with `(row / totalRows) * canvasHeight`. Confirm orientation matches what the learner sees on the live board (a placement at the top rail in world should appear at the top of the thumbnail).
9. **Charter §6 leak via shape distinction**. Pedagogy locked shape encoding (square/circle/line/triangle) as acceptable because 3D component shape is already visible to the learner. Do *not* add fill density variation, outline thickness variation, or any second visual axis. Shape only.
10. **Panel must not be `Interactable`**. Pedagogy lock: read-only, no hover tooltip, no click. Skip the `Interactable` component entirely. Hover preview will not target it. The user cannot accidentally "press" it.
11. **`world.createTransformEntity` parent**. Use `parent: world.sceneEntity, persistent: true` so the panel survives any future level reload — same pattern as hover-preview highlight spheres.

## 10. Push-back on locked decisions / scope check

**Buildable in one session?** Yes, with discipline. Estimated work:

- New system file `attempt-history-system.ts` (~200 lines): state machine + dwell timer + canvas drawing + 4 mesh slots + telemetry. ~2-3 hours.
- Wire system into `index.ts`. Register, instantiate panel mesh group at locked world position. ~15 min.
- Hook event listeners on `socket_connect` / `socket_disconnect`. Either listen for new `vm:socket_connect` / `vm:socket_disconnect` window events (do these exist? — see below) OR subscribe in-system to query `qualify` and watch component changes.
- Visual QA — get the shape mapping right, confirm read distance.

**Caveat — event plumbing.** The codebase currently emits `socket_connect`/`socket_disconnect` only via `telemetry.log` (`snap-system.ts:59-63, 146-150`), not as DOM CustomEvents. The hypothesis-card system listens for `vm:regrab_detected` (added explicitly at `snap-system.ts:64-68`). Two options for the new system:

- **Option α**: Add `window.dispatchEvent(new CustomEvent("vm:socket_connect", ...))` and same for disconnect, parallel to existing `vm:regrab_detected`. Cleanest; 4 lines of code in `snap-system.ts`. Recommend this.
- **Option β**: Have `attempt-history-system.ts` watch `Snappable.leadASocket` per-frame for changes. Reactive but per-frame O(snappables), wasteful when nothing changes.

Pick α.

**Cut from scope (defer to follow-up)**:

- Modular-synth representation (pedagogy §43 open question 2 — defer until that task arrives; do not pre-generalize)
- Localization of any text (no text in this panel by design)

**Don't gold-plate**:

- No "fade in first thumbnail" (locked: no animation)
- No hover-tooltip with placement details (locked: read-only)
- No click-to-replay (locked: no replay)

## Open questions (pilot, not pre-decision)

1. **Read distance**. 0.08m × 0.05m thumbnail at 0.30m glance distance subtends ~9° horizontally. At rowsPerHalf=5 the cell pitch is ~3mm in the thumbnail — borderline for shape distinction. If pilot users describe the thumbnails as "blobs," scale up to 0.10m × 0.062m and reposition to `[-0.2, 1.06, -1.22]`.
2. **Panel raised vs flat**. 15° tilt is a guess. If users miss it (pilot retro: "I didn't notice the strip"), increase tilt to 25° or move 0.05m forward toward the player. If they over-attend ("I kept looking at the strip"), flatten and push back.
3. **Channel-gap line on thumbnail**. May be visual noise at this scale. If pilot users don't reference it, drop.
4. **Empty-strip first impression**. Confirmed: hidden until first snapshot. But the very first snapshot landing 1500ms after a learner's first connect could surprise them. Watch for startle reactions in retro; consider a one-frame delay scaled longer if startle is reported.

## Korean summary

판넬 위치는 워크벤치 정적(브레드보드 뒤·약간 위, 15° 틸트). 1×4 가로 스트립, 슬롯당 0.08m×0.05m. 캔버스→CanvasTexture로 그리고 placement당 도형(와이어=선/배터리=사각/LED=원/저항=삼각) 회색 단색만 사용. 1500ms 안정 후 스냅샷 캡처, FIFO K=4, 첫 스냅샷 전에는 패널 비표시, 인터랙션 없음. 텔레메트리는 `attempt_snapshot_captured` + 기존 `GazeSystem`에 `GazeTarget` 추가로 충분; 게이즈 이벤트 따로 안 만듦. 한 세션 내 구현 가능 — 단, `snap-system.ts`에서 `vm:socket_connect`/`vm:socket_disconnect` CustomEvent 4줄 추가 필요.
