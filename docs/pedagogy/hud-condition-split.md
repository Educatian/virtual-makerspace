# Pedagogy review: HUD condition split

## Decision
APPROVE WITH CHANGES

Split HUD content by condition. Current single-content HUD violates charter §6 by delivering DI-equivalent worked-example scaffolding to PF participants, collapsing the IV.

## Why this decision
- Current `hud-system.ts:47-64` shows numbered, socket-specific instructions to all participants. This is a tutorial overlay (forbidden in PF, §6) and a hint stream (forbidden in PF, §6 "During struggle: Silence").
- §3 explicitly defines PF as "only goal description in HUD" — current implementation contradicts the charter's own condition table.
- §2.1: PF requires attempt "without prior instruction or worked examples." The four numbered steps with explicit socket coordinates are a worked example rendered as live HUD text.
- The split is necessary, not optional. Status-quo invalidates the IV.

## Required changes

- `src/systems/hud-system.ts:47-64` — Branch on `condition` from `src/experiment.ts`. PF path must not enumerate steps or expose socket coordinates. DI path retains current step text (this *is* the DI scaffold).
- `src/systems/hud-system.ts:79-102` — Remove `Step X / Y` rendering in PF. See "Progress bar" question below.
- `ui/hud.uikitml:28` — `#progress` element must render empty (or be hidden) in PF. Do not show "Step - / -" placeholder either; that telegraphs that steps exist.
- `src/systems/hud-system.ts:96-100` — `step_advance` telemetry: keep emitting in DI. In PF, replace with `goal_state_change` events (e.g., `{state: "in_progress" | "complete"}`) so we still capture completion timing without imposing step semantics on PF participants' solution paths.
- PF goal text: `"Build a circuit that lights the LED. Components are on the tray."` — one sentence. Names the goal (LED lit) + points to affordance (tray) for UX equivalence per §2.1, without prescribing topology.
- Completion message: identical text in both conditions (`"Circuit complete."` — drop the question mark "Is the LED lit?", which functions as a soft hint/check). Permitted by §6 "After task_complete" row.

## Acceptance criteria
1. With `?condition=PF`, HUD renders exactly: goal sentence (above) before completion; "Circuit complete." after. No numbers, no socket references, no progress indicator visible at any time.
2. With `?condition=DI`, HUD renders current step text + step counter (see threat below) + completion message.
3. Telemetry: PF emits `goal_state_change` (start, complete) only. DI emits `step_advance` as today.
4. UX latency, panel position, font, color scheme identical across conditions (§2.1 equivalence).
5. No path through code can leak DI step text into PF render (verified by reading the conditional branch, not by runtime inspection alone).

## Threats to validity

- **Progress bar as score-like signal (DI side, unresolved)**: "Step 3 / 4" in DI is a percent-completable progress signal. Charter §6 forbids "Score, XP, streaks, badges" in *any* condition; learning-designer principles extend this to "Progress bar implying X% done." DI scaffolding legitimately needs *which step is current*, but the `N / total` framing imports a completion-meter that is forbidden cross-condition. Recommend DI shows current step text only, no "X / Y" counter. This keeps the scaffold (what to do next) without the score-like meter. Open question flagged below.
- **PF goal text affordance hint**: Saying "components are on the tray" is borderline. Justification: in physical makerspaces the workbench layout is itself a scene affordance, not a hint; equivalent VR framing preserves §2.1 UX equivalence. Without it, PF participants may waste time hunting for components — that's noise, not productive struggle. If the human disagrees, drop to bare goal: `"Build a circuit that lights the LED."`
- **Completion message timing as implicit feedback**: "Circuit complete." appearing the moment topology resolves teaches participants that the system can detect correctness. In PF this risks reframing the task as "find the configuration the system accepts" rather than "reason about circuits." Mitigated by the LED itself lighting (embodied feedback per §2.2); the text is acknowledgment, not evaluation. Acceptable per §6 task_complete row, but flag for post-pilot review.
- **Telemetry asymmetry**: `step_advance` events become condition-specific. Analysis pipelines that join across conditions on this event will silently drop PF participants. Mitigation: emit `goal_state_change` in *both* conditions in addition to `step_advance` in DI, so cross-condition completion-time analysis has a single canonical event.

## Open questions for the human
1. Remove "Step X / Y" counter from DI entirely (recommended, see threat 1)? Or keep it because DI is explicitly the scaffolded condition and the counter is part of the scaffold being studied?
2. PF goal text: include "Components are on the tray." (UX equivalence) or strip to bare goal (maximum minimalism)?
