# Pedagogy review: Hypothesis Card

## Decision
APPROVE WITH CHANGES

The proposal targets the documented RO/AC gap (charter §2.5) with metacognitive scaffolding rather than content scaffolding, which is the correct mechanism. However, the trigger model, prompt wording, and input modality must be tightened before it can be implemented without leaking structure or disrupting productive struggle.

## Why this decision
- §2.5 explicitly names externalized reflection (hypothesis cards, attempt history) as *theoretical infrastructure* for converting CE-heavy struggle into AC-stage schema. Approving the category is consistent with the charter.
- §2.5's constraint — "RO/AC affordances must not collapse into hint-giving in the PF condition" — is satisfied only if the prompt asks the learner to *articulate their own model* and provides no model content. The proposed prompt ("What do you think will be different this time?") meets that bar; alternative phrasings nearby do not (see Required changes).
- §6 forbids "you've been here a while" time-based prompts, "Try again" / "Almost!" framing, and any encouragement language. The card must avoid all of these even by tone or placement.
- §6 forbids comparing to other participants and score-like signals. The card must not summarize prior attempts as counts ("Attempt 3 of N") or quality judgments.

## Acceptance criteria
1. **Identical text across PF and DI.** The card emits the same prompt regardless of `?condition=`. (Charter §2.5 — RO/AC is metacognitive, not condition-specific.)
2. **No content scaffolding.** Prompt contains no domain words beyond what the goal description already exposes. Forbidden in the prompt: "polarity," "resistor," "series," "parallel," "ground," "current," "LED state," "wrong," "correct," "almost," "try."
3. **Trigger is iteration-bounded, not time-bounded.** Fire on the first `grab_start` of any *previously-snapped* component within an iteration (i.e., `socket_disconnect` followed by `grab_start` of the same entity). Do **not** fire on first-ever grab. Do **not** use wall-clock thresholds like "after 30s of inactivity" — that is the §6 time-pressure pattern in disguise.
4. **Throttle: at most once per iteration cycle, hard-capped at once per 90s globally.** An "iteration cycle" ends at the next `socket_connect` or `task_complete`. Multiple re-grabs within the same cycle yield at most one card.
5. **Non-blocking, dismissable, opt-out by default for input.** The card appears in a fixed corner of the player's view (HUD-adjacent, not overlay-modal), does not pause the simulation, and offers a one-tap "skip" that emits `hypothesis_skipped` and never re-prompts within the same cycle. Voice/text input is opt-in via an explicit affordance on the card.
6. **Input modality fallback chain.** Web Speech API STT is offered if available and permission granted; otherwise text via virtual keyboard; otherwise a 3-option closed prompt **only if both fail** (see Required changes #4 — the closed list must remain content-free).
7. **Telemetry contract.** Emit `hypothesis_card_shown { entity_id, cycle_index, trigger_reason }`, `hypothesis_logged { entity_id, cycle_index, modality: "voice"|"text"|"closed", text, char_count, duration_ms }`, `hypothesis_skipped { entity_id, cycle_index, reason: "explicit"|"timeout_ignored" }`. Existing event semantics unchanged.
8. **Removal criterion.** If pilot data show that >70% of cards are skipped *or* that card presence reduces between-condition variance on near-miss precision (i.e., it homogenizes the manipulation signal), remove the feature. Pre-register this in the analysis plan.

## Required changes
- **Trigger definition** — re-grab heuristic must use the `socket_disconnect` → `grab_start (same entity_id)` sequence, not "2nd grab_start of any component." The latter fires on accidental fumbles and on lead-swap behavior, which is not an iteration boundary.
- **Prompt text — fixed string, no variations.** Use exactly: *"Before you place this again — what do you expect to be different?"* This avoids "this time" (mild time-pressure framing), avoids "try" (§6 forbidden), and frames the act as expectation articulation (AE phase of Kolb §2.5), not retry exhortation.
- **Visual treatment** — must not use red, must not pulse or animate attention-getters, must not occlude the breadboard or current grabbed object. Hand off to `ux-feel-critic` for placement; constraint is "peripheral and ignorable."
- **Closed-prompt fallback content** — if both voice and text fail, show three deliberately content-free response chips: *"a different position"*, *"a different orientation"*, *"something else"*. Do **not** include chips like "use a resistor" or "connect to power" — those leak structure. If even this is too leaky for review, drop the closed fallback and accept skip-only behavior in that path.
- **No prior-attempt summary on the card.** Do not show "Attempt 2" or list prior placements. The card is forward-looking (expectation), not backward-looking (audit). A backward-looking attempt-history view is a separate proposal; defer.

## Threats to validity
- **Demand characteristics.** Asking "what do you expect to be different" implies the prior attempt was wrong. In PF, that signal is *already* present via LED state and `returnToSpawn`, so the card adds little leakage; in DI, the placement guides already convey intended placement. Net leak is small but non-zero — log it and code reflection text for whether the learner *uses* the card to reason vs. ritualistically dismisses it.
- **Process-measure contamination.** Articulation introduces a verbal/textual loop that the embodied-encoding hypothesis (§2.2) does not predict. If the card *causes* better post-test performance in PF, it confounds the embodied-PF claim with a generic articulation-prompt claim. Mitigation: the card fires identically in DI, so any condition × card interaction is interpretable; main-effect contamination remains a known limit.
- **Flow disruption.** §2.1 requires the learner stay in struggle. A card that pops mid-grab is disruptive; the iteration-boundary trigger (after release, before next grab) is the only acceptable timing.
- **Skip-rate floor.** If learners habitually skip, the card becomes noise in the telemetry stream. The §8 removal criterion above gates this.
- **Voice STT permission prompt** is itself a non-task interruption. Recommend gating the STT permission ask to once at task start, not on first card.

## Open questions for the human
1. **Pilot vs. main study placement.** Is this intended for the next pilot only (where adjustments are cheap) or the main study run? Recommend pilot-only first, with the §8 removal criterion evaluated before main.
2. **Transfer-task parity (§2.4).** When the modular-synth task arrives, the card must fire on its iteration boundary too, with prompt text that is task-agnostic. The current text passes; confirm before locking.
3. **Reflection coding overhead.** Hypothesis text adds a qualitative coding load on top of `reflection_response`. Is the analysis budget there?
