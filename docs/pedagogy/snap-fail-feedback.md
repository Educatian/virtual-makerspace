# Pedagogy review: snap-fail visual feedback (red near-miss markers)

## Decision
APPROVE WITH CHANGES

The mechanism is acceptable as a non-linguistic, non-evaluative locator cue, but **color and framing must change** before implementation.

## Why this decision
- Charter §6 permits "Visual feedback only (LED state, return to spawn). No language." after a failure attempt. Marking *where* the leads were aiming is a spatial referent, not a score or a hint about the correct answer — it shows the learner what their own hands did, not what they *should* do. This is consistent with §2.2 (the manipulation itself is the encoding).
- However, charter §6 ("Forbidden in any condition") explicitly bans "Penalty animations (red shake, etc.)". Red is a culturally loaded punitive signal. `interaction-spec.md §8` reinforces: "The learner should be able to fail 30 times in a row without feeling worse than they did at attempt 1." Red near-miss markers, repeated 30×, will not satisfy that.
- The spec's open question (`interaction-spec.md §11`) explicitly flags this design as undecided, so the right answer is to resolve it now in a charter-compliant way rather than ship the red version.

## Acceptance criteria
1. Marker color is **neutral grey** (e.g., `#888888`, matte, no emissive boost), not red. Same hue intensity as the inactive socket appearance so it reads as "this socket, here" not "this socket is bad."
2. Two markers appear at `nearMissPayload.socket_a` and `socket_b` world positions only when `findBestSnap` returns null AND `findNearestCandidate` returns non-null.
3. Markers are visible for ≤ 200ms then disappear (fade or instant — UX call). No pulse, no shake, no scale animation.
4. Behavior is **identical in PF and DI conditions** — gated by no condition flag.
5. No accompanying audio, haptic, text, or HUD change.
6. Telemetry: re-uses existing `grab_end.near_miss` payload. **One new event** `near_miss_marker_shown` with `{ entity_id, socket_a, socket_b, dist_a_m, dist_b_m }` so we can later test whether seeing the marker changes subsequent attempt precision (research question, not a UX claim).
7. Markers do not appear when `findNearestCandidate` returns null (e.g., release far from board) — silence is the correct feedback for "you weren't even trying to snap."

## Required changes
- `src/systems/snap-system.ts:100-102` — when `!snapped`, after `returnToSpawn`, also dispatch a "show near-miss markers" call using the already-computed `nm` candidate. Don't recompute.
- New small system or extension to `HoverPreviewSystem` that owns the two grey marker meshes and a 200ms timer. Reuse mesh allocation from hover preview (already exists, charter-aligned with §10 `interaction-spec.md` perf contract).
- `interaction-spec.md §3` and `§11` — update to reflect resolved decision: grey, ≤200ms, both conditions.
- `docs/pedagogy-charter.md §6`, "After failure attempt" row — append: "May include neutral-grey spatial locator markers at near-miss sockets, ≤200ms, no color encoding of correctness." (Propose to human; do not edit unilaterally.)

## Threats to validity
- **Pedagogical**: even grey markers may inadvertently teach "the snap rule" by repeated exposure — i.e., the learner discovers via marker pairs that "two sockets must be in the same row." That is *intended* productive discovery, not a hint about the target circuit, so it does not violate §2.1. But it does mean the marker subtly conveys snap-mechanic knowledge faster than pure return-to-spawn would. Confirm in pilot that PF condition still shows initial conceptual struggle (low pre→early-task accuracy).
- **Measurement**: `grab_end.near_miss` semantics are unchanged, but if the marker influences the *next* grab's targeting precision, the near-miss distance distribution is no longer an independent measure of unaided spatial estimation. Mitigation: log the new `near_miss_marker_shown` event and analyze post-hoc whether marker exposure correlates with subsequent grab precision — this is itself a useful process measure.
- **Condition equivalence**: applies equally to PF and DI by design. No threat.
- **Time pressure**: the 200ms cap prevents lingering "you failed" state. Acceptable.

## Open questions for the human
1. **Color**: agree on grey, or prefer the same `accent-circuit` green as hover preview (would fully neutralize valence — "here is where your leads were" is just spatial information, no failure connotation at all)?
2. **Frequency cap**: should we suppress the marker if the same near-miss pair is shown >3 times in succession, to avoid annoyance? My recommendation: no cap — the markers are the *only* failure feedback besides return-to-spawn, and suppressing them creates an asymmetry where struggling learners get *less* spatial information.
3. **Charter amendment**: §6 currently doesn't anticipate this class of feedback. Approve the proposed wording above, or rephrase?
