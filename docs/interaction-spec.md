# Interaction Spec

How interactions feel, frame by frame. The goal is *embodied confidence*: the learner believes their hands and gaze are doing what they think they're doing, with no perceptible lag or ambiguity.

VR has zero tolerance for sluggish UI — anything > 100ms feels broken in headset.

## 1. Latency budget

| Action → feedback | Budget | Where measured |
|---|---|---|
| Trigger pull → grab attaches to ray | < 16ms (1 frame at 60fps) | DistanceGrabbable |
| Component release → snap or return | < 16ms | SnapSystem.onPointerUp |
| Component movement → hover preview update | every frame while held | HoverPreviewSystem |
| Snap → telemetry log | < 5ms | telemetry.log() — synchronous push to buffer |
| LED state change → emissive update | same frame | CircuitEvalSystem |
| Gaze raycast → telemetry | 200ms throttle (5Hz) | GazeSystem |
| Probe overlay submit → next state | < 100ms | DOM event handler |

## 2. Grab

**Mechanism**: `DistanceGrabbable` with `MovementMode.MoveAtSource` — component teleports to controller ray endpoint while held. Trigger to grab/release.

**Feel goals**:
- **No grab arc / no flying-at-you animation** — `MoveAtSource` is correct: the object appears AT the ray. Faster perceived response than `MoveTowardsTarget`.
- **No haptic** yet — when added, single short pulse (50ms, 0.4 strength) on grab, none on release
- **No collision physics during hold** — held objects pass through other objects (intentional, prototype simplicity)

**Edge cases**:
- Grab while already snapped → emit `socket_disconnect`, set leadASocket/leadBSocket to -1, then start grab. (Implemented.)
- Release with no nearby socket → return to `spawnPos`. (Implemented.)
- Grab with controller out of view → no special behavior; ray works regardless.

## 3. Snap

**Threshold**: `snapThreshold = 0.027m` (~2.7cm) — measured from each lead world position to nearest socket.

**Both leads must be within threshold AND target distinct sockets** for snap to engage (current logic in `findBestSnap`).

**Feel goals**:
- **Magnetic-feeling but not aggressive** — 2.7cm is the current empirical sweet spot. Larger threshold = "the thing snaps where I didn't mean it"; smaller = "why won't it click".
- **Hover preview must precede snap** — green spheres at the *intended* sockets while held within threshold. This makes the snap predictable.
- **Snap is silent and instant** until SFX are added (then: short woody click).

**Failure feel**:
- If lead positions miss threshold → return to spawn position. *Currently no visible "snap rejected" feedback.* Consider adding: brief red pulse on the offending lead OR red sphere at the nearest invalid pair, ≤ 200ms.

## 4. Hover preview

**Trigger**: while user holds a `Snappable`, `HoverPreviewSystem.update()` runs `findBestSnap` every frame. If a valid snap target exists, two green spheres mark socket A and socket B in world space.

**Feel goals**:
- **Always-on while plausibly snappable** — there's no debounce. As soon as both leads are within threshold, spheres appear.
- **Disappears the moment leads stray** — instant on/off avoids "ghost target" confusion.
- **Color is `accent-circuit` (#00ff66)** to associate "this will become a working circuit if you let go now."

**Anti-pattern (do not introduce)**: spheres on every nearby socket — only the *best valid pair* shows. The user should see exactly one prediction.

## 5. Gaze

**Sampling**: 5Hz (200ms interval) — this is for *research data*, NOT interaction. No gaze-driven UI yet.

**Targets**: only entities tagged with `GazeTarget` register. 11 entities currently (board, hud, 8 components, robot).

**Feel goals**:
- **Invisible to the user** — gaze tracking is silent telemetry. No reticle, no hover effect, no audio.
- **Future**: if gaze ever drives UI (e.g., dwell-to-select), needs explicit visual cursor + dwell timer arc. Not in current scope.

## 6. HUD

**Position**: PivotY follower, offset `[0, -0.25, -0.7]` from head. Means: ~0.7m in front, ~25cm below eye level. User looks slightly down to read it without obscuring world.

**Feel goals**:
- **Stays still when user moves head slightly** — `tolerance: 0.3m`, `maxAngle: 25°` mean the HUD doesn't jiggle with every micro-movement, but follows when user turns body.
- **Updates instantly** when state changes — no fade transitions on text content.
- **Always legible** — black background + green/white text, high contrast.

**Anti-pattern**: stacking new UI on the HUD. Keep it minimal: progress + current step only. Anything richer goes to a dedicated panel.

## 7. Probe overlay (out-of-task UI)

**Triggered**: pre-test on page load (before XR), post-test on `vm:task_complete`.

**Feel goals**:
- **Modal and inescapable** — fullscreen, can't be dismissed without submitting (or all answers required).
- **Calm pace** — `Best guess is fine — there is no time limit.` framing. No timer, no countdown.
- **Validation is gentle** — error message at submit if questions missing; never red-highlight individual items.

**XR interaction during probe**: the overlay covers the page; the VR headset shows whatever XR session was last in. Procedure: researcher prompts participant to remove headset for post-probe.

## 8. Failure framing (PF-specific)

This is where most "feels punishing" mistakes happen in learning UI. Rules:

- **No buzzer / harsh sound on wrong placement** — see audio rules
- **No "Wrong!" text feedback ever** — the *world* gives feedback (LED off = obvious), language amplifies shame
- **Returning to spawn is neutral, not punitive** — fast, silent
- **No score, no points, no streak** — these convert exploration into performance anxiety
- **Time is invisible** — no clock, no "you've been struggling for 5 minutes"

The learner should be able to fail 30 times in a row without feeling worse than they did at attempt 1. PF requires this.

## 9. Robot (idle character)

**Behavior**: walks in a 0.4m radius, 0.25 m/s, bobs 4cm. Currently no interactivity.

**Feel goals**:
- **Atmospheric, not attention-grabbing** — the robot is *room-presence*, not a tutor.
- **Doesn't approach the player** — stays in its centered orbit, ~2m away.
- **Future**: if it ever speaks, follow voice agent rules from project memory (gaze-triggered scaffolding only after task_complete).

## 10. Performance contracts

These keep the interaction budget intact:

- `findBestSnap` is called **every frame while a component is held** by HoverPreviewSystem. Must remain O(targets × sockets) with zero allocations (enforced in `snap-helpers.ts` via module-scope scratch vectors).
- `GazeSystem.update()` runs raycaster at 5Hz, not every frame. Per-tick cost: 1 raycast across ~11 mesh roots.
- Telemetry: `telemetry.log()` is sync push to in-memory buffer; flush is async on 5s interval or 50-event batch. Never blocks the frame.

Breaking any of these contracts requires an explicit "we accept the regression because X" note in the PR.

## 11. Open questions (mark before resolving)

- Should snap failure get visual feedback (red flash) or stay silent?
- Should the robot ever look at the player (gaze toward head)?
- When voice agent is added, does it speak during XR or only out-of-XR?
- HUD shows "Step X / Y" — but currently there's only one step (build the target circuit). Is this misleading?
