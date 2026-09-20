# Interaction blueprint: HUD condition split (PF vs DI)

Pedagogy gate: `docs/pedagogy/hud-condition-split.md` (APPROVE WITH CHANGES). This document specifies the perceptual contract only.

## Sensory contract

- **What the user does**: nothing — the HUD is ambient. They glance at it (head pitch ~15° down) when they want a reminder of the goal or, in DI, the next step.
- **What they perceive in response**:
  - PF: one static white sentence. Never changes mid-task. Replaced once at completion.
  - DI: one white sentence that swaps instantly when a step is satisfied. Replaced once at completion.
- **Latency budget**: text swap < 16ms (already met — synchronous in `update()`).
- **Failure mode feel**: no failure feedback in HUD. The world (LED, snap, return-to-spawn) is the failure channel. Confirms charter §6 and `interaction-spec.md` §8.

## Decisions

### 1. `#progress` element after counter removal — **hide it**
Recommend `display: none` via class swap (or omit element entirely). Justifications:
- Empty-string leaves a 1.6-unit-tall blank reserved row → HUD card becomes visually top-heavy, telegraphs "something used to be here."
- Repurposing as static affordance text (e.g., "Goal" label) adds chrome without information. The `step` text already carries the message; a label restates it.
- Hiding the row also tightens the panel height by ~0.022m, which improves the "calm workshop" feel (style-guide §1).

Implementation note: do not delete the `<span id="progress">` — toggle a `hidden` class so future reuse (e.g., timer in a follow-up study) doesn't require markup churn. Both conditions hide it; the row is gone, not condition-specific.

### 2. PF text styling — **keep `.step` class as-is**
2.2 UIKit unit, `#f0f0f0`, line-height 1.3 is correct. Reasoning:
- PF goal must read at the same legibility budget as DI step text (§2.1 UX equivalence in pedagogy charter). Different size = different perceptual weight = participants notice and form hypotheses.
- One sentence at 2.2 units fits the 50-unit-wide card on two lines max. Verified: `"Build a circuit that lights the LED. Components are on the tray."` ≈ 64 chars.
- No italics, no muted color. The text is the *only* HUD content in PF; muting it would feel like a placeholder.

### 3. DI step list — **one step at a time, unchanged**
Do NOT stack all 4. Reasoning:
- Stacking 4 steps compresses each line to ~1.4 units to fit the card → worse legibility at 0.7m.
- Stacking implies a checklist with completed/pending visual states (struck-through, checkmarked) — that is exactly the score-like progress meter the pedagogy doc bans.
- The current "next incomplete step only" pattern matches the DI scaffold intent: tell the participant what to do *now*, not where they are in a sequence.

The counter removal does not change what should be on screen — it removes the meta-information *about* progress, not the step itself.

### 4. Step transition (DI) — **confirm instant swap**
Style guide §6 default is 0ms. Hold to that. Rationale:
- Fade-in on text swap (e.g., 150ms) reads as "the system is acknowledging your action" — score-like signal in DI, even worse if PF telemetry shows participants comparing notes.
- Instant swap matches snap, hover preview, LED — the entire scene is on the same motion contract. Adding a fade here would make the HUD feel different from the world, breaking immersion.
- Risk: participant glancing at HUD mid-swap may miss the transition. Acceptable — the *content* of the next step doesn't depend on having seen the moment of change.

### 5. `hud.uikitml` changes

Specific edits to `ui/hud.uikitml`:

```diff
   .progress {
-    font-size: 1.6;
-    color: #00ff66;
-    text-align: left;
-    margin-bottom: 0.6;
+    display: none;
   }
```

Keep the `<span id="progress">` element in markup (forward-compat), or omit if uikitml doesn't compile a `display: none` empty span efficiently — equivalent outcome. Do NOT add a condition-specific class on `<div class="hud">`; the visible content is identical-shape across conditions, only the *string* differs.

Initial `#step` text: change `"Loading..."` to empty string. Avoids a flash of placeholder before `HudSystem.update()` runs.

### 6. `hud-system.ts` changes

Branch logic:

```ts
import { condition } from "../experiment.js";

// in init() — set initial text once based on condition
if (condition === "PF") {
  this.stepEl.setProperties({
    text: "Build a circuit that lights the LED. Components are on the tray.",
  });
  telemetry.log("goal_state_change", { state: "start", condition });
}
// DI: leave to update() loop as today, but also emit goal_state_change start
```

PF state to track: a single boolean `private completionEmitted = false;` to gate the "complete" telemetry event and the `"Circuit complete."` text swap. PF `update()` body is ~5 lines: check if all 4 step `check()` predicates pass → set text + emit once.

DI: existing `update()` mostly unchanged. Remove the `progressEl.setProperties(...)` calls (the element is hidden now). Keep `step_advance` emission. Add a single `goal_state_change` emission on first frame (state="start") and on completion (state="complete"). Drop "Is the LED lit?" from completion text — both conditions now emit `"Circuit complete."`.

Pitfall: do NOT reuse the DI `Step[]` array as the PF completion check. Define a single shared predicate (e.g., `isCircuitComplete()`) that returns true when the LED is lit. Reusing `findCurrentStep() >= total` works in DI because steps mirror the canonical solution, but PF participants may build a *valid alternate topology* that lights the LED without satisfying step 1's specific socket pair. Charter §2.1 forbids penalizing PF for divergent solutions.

This is the most important code-level change in the blueprint and the easiest to miss. Flag to implementer.

### 7. Telemetry payload shapes

| Event | Conditions | Payload | Rationale |
|---|---|---|---|
| `step_advance` | DI only | `{step: number, total: number, completed: boolean, condition: "DI"}` | Add `condition` for downstream filtering hygiene; otherwise as today. |
| `goal_state_change` | both | `{state: "start" \| "complete", condition: "PF" \| "DI", t_ms: number}` | `t_ms` is a relative timestamp from session start; matches `telemetry.ts` convention. Refine: drop `timestamp` (telemetry layer adds it). |

Do NOT emit `goal_state_change` with `state: "in_progress"` (the pedagogy doc mentioned it as an option) — it would fire on every step advance in DI and on nothing meaningful in PF. Two events per session per condition is the right cardinality.

### 8. Latency

PF: HUD allocates two `setProperties` calls total per session. Effectively zero per-frame cost. The `update()` loop should early-return after the completion check is satisfied. No regression vs current.

DI: identical to current — one `setProperties` call per step transition (~3-4 per session) plus the now-removed `progressEl` write. Net slight improvement.

Both: the `findCurrentStep()` / `isCircuitComplete()` predicate runs every frame. Already O(components × sockets) and zero-allocation per `interaction-spec.md` §10. No change.

## What feels wrong with the current HUD that the locked changes will NOT fix

Three issues remain after this split:

1. **HUD border color is `#00ff66` (`accent-circuit`) — the same green that means "valid snap target."** When a hover preview sphere appears in the user's peripheral vision, the HUD border subtly competes for the same semantic. Style guide §2 reserves `accent-circuit` for "the thing is working." A static border is not "working"; it's chrome. Recommend changing border to `border-subtle` (`#2a3245`) or removing entirely. Out of scope for the condition-split work but worth noting.

2. **HUD position `[0, -0.25, -0.7]` is below the breadboard plane in many seated postures.** When the participant leans in to inspect a snap, the HUD slides into the workspace foreground. This was acceptable when the HUD carried action-relevant text (DI steps) — participants needed it visible. For PF, where the HUD is read once at session start and once at completion, the HUD competing with the workbench is pure cost. Consider PF-specific offset of `[0, -0.4, -0.9]` (further down and back). Flag to learning-designer because it reintroduces a condition-asymmetry — likely a no-go, but worth one round.

3. **No "you have read the goal" confirmation.** In PF, a participant who never glances up will miss the goal entirely. The HUD is passive. Pedagogy locks "no tutor pointing at HUD" but consider: a 200ms gentle pulse of the HUD card opacity (1.0 → 0.7 → 1.0) at session start, once. Within style-guide §6 motion budget, charter-neutral (no correctness signal), and ensures the surface is perceived. Open question for learning-designer; do not implement unilaterally.

## Open questions

- **HUD-text language localization for Korean participants?** If the study runs Korean-speaking subjects, "Build a circuit that lights the LED. Components are on the tray." needs a translation that preserves character count budget. Out of UX scope; flag to research lead.
- **PF completion message timing**: identical to DI — fires the instant `isCircuitComplete()` first returns true. Charter accepts this (§6 task_complete row), but a 500ms delay would let the LED-lit moment land first as the *primary* feedback, with text as acknowledgment. Possible polish; do not block on it.
