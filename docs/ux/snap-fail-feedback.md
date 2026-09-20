# Interaction blueprint: snap-fail near-miss markers

Spatial locator markers shown at the user's intended (near-miss) socket pair when `findBestSnap` returns null on `pointerup` but `findNearestCandidate` resolves a candidate. Pedagogy clearance: `docs/pedagogy/snap-fail-feedback.md` (APPROVE WITH CHANGES).

## Sensory contract

- **What the user does**: releases trigger while holding a component whose two leads are *near* but not within `snapThreshold = 0.027m` of a valid socket pair.
- **What they perceive in response**: the component teleports back to spawn (existing behavior, instant); two small grey spheres appear at the two sockets the system inferred they were aiming for, hold for 200ms, then disappear instantly.
- **Latency budget**: < 16ms from `pointerup` event to markers visible. The candidate is *already computed* by `SnapSystem.onPointerUp` (`snap-system.ts:83-86`), so this is one mesh-position write + visibility flip. Well inside budget.
- **Failure mode feel**: spatially informative without being evaluative. The markers say "here is where your hands ended up," not "wrong" and not "go here instead." Compliance with `interaction-spec.md §8` (fail 30× without escalating shame) and `pedagogy-charter.md §6` (no penalty animation, no language).

## Specifics

### Visual

- **Color**: `text-muted` `#9aa6bd` per locked decision. Chosen *against* `accent-circuit` green to avoid semantic collision: green = "valid target predicted" (hover preview); grey = "post-hoc spatial referent." Different valence, different meaning.
  - **Risk flagged**: `#9aa6bd` is a cool blue-grey. Against the desaturated board (`#8b6f47` wood / dim board surface) at 0.65 opacity it may read as a faint cyan, not pure neutral. If pilot users perceive it as a "color signal" (positive or negative), fall back to `#888888` matte (the pedagogy doc's original suggestion). Decide post-pilot, not pre.
- **Geometry**: identical `SphereGeometry(0.012, 14, 10)` to hover preview (`hover-preview-system.ts:38`). Reusing the geometry size keeps the spatial vocabulary consistent — same dot, different color = "same kind of thing the snap predictor draws, but after the fact, neutral."
- **Material**:
  - `MeshBasicMaterial`, `transparent: true`, `opacity: 0.55` (slightly *less* prominent than hover preview's 0.65 — these are confirmatory, not predictive; should not compete for attention with the next grab attempt's hover preview).
  - `depthWrite: false` to match hover preview. Markers should never z-fight the breadboard surface or get clipped by component geometry near the socket plane. Trade-off: they will render through occluders, which for a 12mm sphere at socket location is correct (a buried marker is invisible feedback).
- **Motion**: instant on, instant off after 200ms hold. No fade.
  - Per `style-guide.md §6` motion default is 0ms / no easing. A fade was considered (150ms ease-out within the 200ms budget = 50ms hold + 150ms fade) but rejected: a fade signals "something is leaving" which adds an additional perceptual event the user must parse. Instant-off matches hover-preview's instant-off (`interaction-spec.md §4`) and stays out of the way of the next attempt.
- **Spatial position**: world-space copy of `nearMissPayload`'s socket positions. Re-use the same socket world-position resolution path as hover preview — must NOT recompute via `findNearestCandidate` (which only returns indices and distances). Extend `NearestCandidate` to also carry `socketAWorld` / `socketBWorld` `Vector3` (using the existing module-scope scratch vectors in `snap-helpers.ts`), or have `SnapSystem.onPointerUp` resolve them from the socket grid before passing to the feedback system.

### Audio

None. Per `style-guide.md §7` snap-failure audio is a future "subtle pluck" but is explicitly out of scope for this feature. Adding sound now would couple two unrelated decisions.

### Haptic

None. Per `interaction-spec.md §2` haptics are not yet wired.

### State transitions

| State | Trigger to enter | Trigger to exit |
|---|---|---|
| `idle` (markers hidden) | system init | `pointerup` with `snapped=false` AND `nearMiss != null` |
| `showing` (markers at near-miss positions) | transition above | `performance.now() - shownAt >= 200` (checked each `update()`) |
| `idle` | timer expired in `update()` | — |

Re-entering `showing` while already showing (rapid retries) **resets** `shownAt` and updates positions to the new near-miss pair. No queue, no fade-overlap.

## Telemetry hooks

One new event per pedagogy doc §6:

```ts
telemetry.log("near_miss_marker_shown", {
  entity_id: number,
  socket_a: number,        // socket index of marker A
  socket_b: number,        // socket index of marker B
  dist_a_m: number,        // 4-decimal precision, matches grab_end.near_miss
  dist_b_m: number,
});
```

Emitted **once** at marker show (transition into `showing`), not per frame. No corresponding `_hidden` event — duration is fixed at 200ms and inferable from `_shown` timestamp; emitting hide events would double telemetry volume for no analytical gain.

Naming follows existing convention: `snake_case`, action-suffix verbs (`grab_start`, `socket_connect`, `hover_target_clear`).

## Pitfalls to watch

1. **`setTimeout` for the 200ms timer** — *do not use*. Tab throttling and XR session-blur can stretch JS timers to seconds, leaving ghost markers visible after the user resumes. Use a frame-checked deadline: store `shownAt: number` (= `performance.now()`), and in `update()` compare `now - shownAt >= 200`. Cost: marker freezes during `VisibleBlurred` instead of disappearing on schedule, which is acceptable (the user isn't perceiving anything during blur anyway).
2. **Recomputing `findNearestCandidate` in the feedback system** — the candidate is already resolved in `SnapSystem.onPointerUp` (`snap-system.ts:83-86`). The feedback system must consume the result, not re-walk all sockets. Pass `{ socketAWorld, socketBWorld }` directly. Otherwise: 2× O(targets × sockets) per release.
3. **Marker meshes added via `scene.add`** — must use `world.createTransformEntity(mesh, { parent: world.sceneEntity, persistent: true })` exactly like hover preview's `highlightA`/`highlightB`. Otherwise no Transform component, level lifecycle bypassed.
4. **Color competition with hover preview** — if the user grabs another component within the 200ms window, the green hover-preview spheres and the grey near-miss spheres will be visible *simultaneously* at potentially overlapping sockets. Acceptable (they encode different things: future intent vs past attempt) but worth watching in pilot — if it reads as visual noise, shorten near-miss hold to 120ms.
5. **`depthWrite: false` ordering** — when both green hover spheres and grey near-miss spheres render in the same frame, draw order can flicker. Both materials should share the same `transparent: true` / `depthWrite: false` setup (they already do); if flicker appears, set `renderOrder = 999` on near-miss meshes so they paint after hover preview.
6. **Marker size relative to socket pitch** — current `0.012m` radius is ~1/3 of typical breadboard pitch (`SocketGrid.pitch ≈ 0.025-0.030m`). At grey + 0.55 opacity this should sit cleanly inside one socket's visual footprint. If pitch is reduced in a future board revision, marker radius must scale proportionally — do not let two adjacent markers visually merge.
7. **Re-fire during grab** — `pointerup` fires again only after a new `pointerdown`. Markers will not flicker during a held drag; safe.
8. **Marker still visible while the user re-grabs the same component** — by design. Pedagogy doc §3 caps at 200ms; this happens whether or not the user retries. Do not add a "hide on next pointerdown" rule — it would suppress the marker exactly when the learner is most ready to use it.

## Architecture recommendation

**New file**: `src/systems/snap-fail-feedback-system.ts`. Reasoning:

- `SnapSystem` is already the busiest system (pointer handlers, snap math, telemetry, topology emission). Folding two marker meshes + a timer into it pushes single-responsibility past breaking.
- `HoverPreviewSystem` runs `findBestSnap` every frame for held entities — different cadence (continuous-while-held) vs near-miss feedback (one-shot, 200ms after release). Combining them complicates the `update()` loop.
- A dedicated system can subscribe to a custom event (`vm:snap_failed_with_near_miss`) emitted by `SnapSystem.onPointerUp`, keeping coupling one-directional. Alternative: expose a public `showNearMiss(socketAWorld, socketBWorld)` method on the new system and have `SnapSystem` call it directly via system-lookup.
- File naming follows project convention (one system per file, `kebab-case-system.ts`).

**Required wiring change**: `SnapSystem.onPointerUp` (`snap-system.ts:73-113`), in the `if (!snapped)` branch after `returnToSpawn`, emits the trigger to the new system. The world-position resolution for the near-miss sockets must happen here (not in the feedback system) because `SnapSystem` already has the socket grid in scope via `this.queries.snapTargets.entities`.

## State machine summary

```
SnapSystem.onPointerUp:
  snapped ? applySnap : returnToSpawn
  if !snapped && nearMiss:
    resolve nearMiss socket world positions (reuse socket grid)
    feedback.show(entityIndex, socketAWorld, socketBWorld, socketAIdx, socketBIdx, distA, distB)

SnapFailFeedbackSystem.show(...):
  copy positions to highlightA/B
  highlightA.visible = highlightB.visible = true
  shownAt = performance.now()
  telemetry.log("near_miss_marker_shown", {...})

SnapFailFeedbackSystem.update():
  if shownAt > 0 && now - shownAt >= 200:
    highlightA.visible = highlightB.visible = false
    shownAt = 0
```

## Open questions (need pilot data, not pre-decision)

1. **Color empirics**: does `#9aa6bd` read as neutral grey or as a faint cool tint against the breadboard? Decide between `#9aa6bd` and `#888888` after first 3 pilot sessions. Acceptance signal: zero participants describe the markers in color terms ("the blue/cyan dots") in retrospective interview.
2. **200ms vs 120ms**: if a pilot participant retries within 200ms (likely with low-precision hand tracking), do markers from attempt N still being visible during attempt N+1's hover preview create visual noise? If yes, shorten to 120ms.
3. **Hide-on-regrab override**: the blueprint says do not hide when user re-grabs. This is the conservative pedagogical choice (per pedagogy doc — markers are the only failure feedback besides return-to-spawn). Reconsider only if pilot shows the dual-marker overlap is genuinely confusing.
