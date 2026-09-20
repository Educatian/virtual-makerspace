# Pedagogy Charter

The research identity of Virtual Makerspace. Every feature decision must be justifiable against this doc. Aesthetic / engineering choices are downstream of these commitments.

## 1. Research positioning (one paragraph)

Virtual Makerspace is a research-grade VR prototype investigating **embodied Productive Failure**: the conjecture that PF's generative learning effect operates differently when the failure is enacted through 6DoF physical manipulation, compared to desktop/screen settings. The breadboard circuit task is the substrate; planned 2nd task is modular synthesis (isomorphic causal-network structure for transfer testing); planned Phase 2 IV is shared gaze coupling in collaborative VR. This is not edutainment, not a polished product, not a clinical trainer.

## 2. Core theoretical commitments

These are non-negotiable. Features that violate them are out of scope.

### 2.1 Productive Failure (Kapur)
- Learners attempt the task **without prior instruction or worked examples** in the PF condition.
- Initial failure is *expected and required* — the design must afford generative struggle, not prevent it.
- Direct Instruction (DI) condition keeps the same task but provides scaffolds (placement guides, future: worked example).
- DI is the **comparison condition**, not a "better" mode. Quality of UX must be equivalent in both.

### 2.2 Embodied cognition (Slater, Klatzky, Wilson)
- 6DoF physical manipulation is hypothesized to alter the *encoding* of failure, not just engagement.
- This means manipulation telemetry (grab paths, hesitation, near-misses) is a *theoretical* signal, not just instrumentation.
- Implication: every grab-related interaction is research-load-bearing. Casual UX changes can invalidate measures.

### 2.3 Process measures over outcome-only (Schneider, Sharma, Pea)
- Pre/post conceptual gain is necessary but not sufficient.
- The contribution is showing *which* in-task processes (gaze, manipulation, dwell, near-miss) mediate the PF effect.
- Implication: telemetry coverage and integrity is a first-class concern, not an afterthought.

### 2.4 Schema-level transfer (planned)
- The 2nd task (modular synthesis) is structurally isomorphic to circuits: signal source → modulation → sink.
- Transfer evidence requires that learning in one task predicts performance in the other on schema-aligned items, not surface-aligned items.
- Implication: don't add features that uniquely advantage the circuit task.

### 2.5 Experiential Learning Cycle (Kolb)
- Productive Failure operates *inside* a broader cycle: Concrete Experience (CE: manipulation) → Reflective Observation (RO: what happened) → Abstract Conceptualization (AC: rule/schema formation) → Active Experimentation (AE: hypothesis test) → back to CE.
- The current task affords CE strongly but provides minimal explicit RO/AC scaffolding. Without externalized reflection tools, generative struggle (§2.1) often fails to consolidate into transferable schema — this is well-documented in the PF and Kolb literature alike.
- Implication: features that externalize reflection (hypothesis cards, attempt history snapshots, post-completion causal narration) are *theoretical infrastructure*, not optional polish. They are how the cycle's RO and AC phases are made observable and supportable.
- **Constraint**: RO/AC affordances must not collapse into hint-giving in the PF condition. They prompt the learner to *articulate their own model* — they do not provide model content.

### 2.6 Game-Based Learning (GBL), not gamification
- Design follows GBL principles. GBL ≠ gamification (extrinsic reward systems are forbidden by §6).
- **Compatible (use these)**: meaningful agency, world-as-feedback (LED state, snap-fail markers), failure-as-data framing, intrinsic motivation via competence/autonomy/curiosity, rule-as-mechanic constraints (physical laws of circuits *are* the rules), mastery curves measured by transfer not by score.
- **Incompatible (already forbidden by §6)**: score, XP, streaks, badges, achievement language, adaptive difficulty, sycophantic praise.
- **Distinction in one line**: GBL *enables discovery*; gamification *substitutes reward for discovery*. When in doubt, ask: does this feature give the learner more space to think, or substitute for thinking?
- This frame aligns with §2.1 PF and §2.2 embodied cognition — the three commitments converge on the same design principle: *the world teaches; the system stays out of the way*.

## 3. Conditions

| Condition | Code (`?condition=`) | Differences from baseline |
|---|---|---|
| **PF** | `PF` | Placement guides hidden; no key shortcut to reveal; no worked example; only goal description in HUD |
| **DI** | `DI` (default) | Placement guides shown by default; `g` toggles them; (future: worked example panel) |

Future conditions (Phase 2):
- `PF-collab` / `DI-collab` × shared-gaze visibility on/off

**Adding a condition** requires an updated mediation hypothesis in this doc, not just a new param value.

## 4. Outcome measures (currently)

| Measure | Source | What it tests |
|---|---|---|
| Pre conceptual score | `probe_response` events, phase=pre, items 1-4 | Baseline circuit knowledge (polarity, resistor role, series/parallel, open circuit) |
| Post conceptual score | `probe_response`, phase=post, items 1-3 (item 4 confidence-only, not scored) | Conceptual gain |
| Transfer (limited) | `post_transfer` item: motor-substitution scenario | Schema-level reasoning beyond memorized fact |
| Reflection text | `reflection_response` events | Qualitative coding for explanation quality, productive struggle markers |

**Gaps to address** (before main study):
- Larger pre/post item bank (current: 4 / 4 — too few for reliable score)
- Transfer subtask separated from post (currently mixed)
- Confidence calibration item per scored item (Brier score possible)

## 5. Process measures (currently)

| Measure | Telemetry source | Theoretical role |
|---|---|---|
| Time on task | `task_start` → `task_complete` | Effort baseline |
| Attempt cycles | derived from `socket_connect`/`socket_disconnect` sequences | Volume of generative struggle |
| Near-miss precision | `grab_end.near_miss.dist_*` | Subgoal targeting accuracy |
| Hover intent transitions | `hover_target` / `hover_target_clear` | Hesitation, plan revision |
| Gaze fixations on components | `gaze_enter` / `gaze_leave` with dwell_ms | Attention allocation |
| Circuit configurations explored | `circuit_topology` snapshots | Solution space coverage |

**Phase 2 additions**:
- `gaze_coupling` (joint attention windows between two participants)
- `verbal_turn` (if voice channel added)

## 6. PF policy — what scaffolding is allowed when

This is the line agents must not cross.

| State | PF condition | DI condition |
|---|---|---|
| Pre-task (probe) | Same | Same |
| Task start | Goal stated, no how | Goal stated + placement guides visible |
| During struggle | **Silence** — no hints, no encouragements, no time pressure | Guides remain visible; participant may toggle |
| After failure attempt | Visual feedback only (LED state, return to spawn). No language. | Same |
| After task_complete | Brief acknowledgment in HUD; post-probe begins | Same |
| Post-probe reflection | Open-ended prompts, equal across conditions | Same |

**Forbidden in PF condition**:
- Tutorial overlays
- "Try again" or "Almost!" messages
- Hint buttons
- Adaptive difficulty
- Time-based prompts ("you've been here a while")
- Voice agent intervention during struggle (deferred capability — see voice-agent memory)

**Forbidden in any condition**:
- Score, XP, streaks, badges
- Visible timers
- Comparing to other participants
- "Wrong!" / "Correct!" verbal feedback
- Penalty animations (red shake, etc.)

**Allowed exceptions (with constraints)**:
- Neutral spatial locator markers (e.g., grey ≤ #9aa6bd brightness, ≤ 200ms duration, no fade) shown at the user's intended near-miss socket pair on snap failure. Justification: spatial reference for self-diagnosis (§2.2 embodied encoding) — not a hint, not score-like, not punitive. Implemented in `SnapFailFeedbackSystem`.

## 7. Acceptance criteria template (use for every feature)

Every new feature must fill in:

1. **Pedagogical justification**: which commitment in §2 does this serve? Cite by section.
2. **Affected measures**: does this change any process or outcome measure? If yes, what's the threat to validity?
3. **Condition equivalence**: does this work the same in PF and DI, or differently? If differently, justify with §6.
4. **Failure framing**: does failure within this feature comply with §6 anti-patterns?
5. **Telemetry contract**: what new events does this emit? Does it break any existing event semantics?
6. **Removal criterion**: under what evidence would we remove this feature?

Features without satisfactory answers don't get implemented.

## 8. What's NOT pedagogy concern (delegate elsewhere)

- Visual polish → `style-guide.md`
- Frame-rate, latency, raycast jitter → `interaction-spec.md`
- Code structure, ECS patterns → CLAUDE.md
- Networking, server infrastructure → engineering backlog (TBD)

## 9. Out of scope (explicit)

- Edutainment / gamification (XP, badges, level-up)
- Adaptive content based on performance (this changes the IV)
- Multi-language localization (English only for now)
- Accessibility for visual/motor impairment (real concern, but out of scope until protocol is stable)
- Clinical-grade NPC dialogue (memory: separate project track if pursued)

## 10. References (for agents reasoning about pedagogy)

Core:
- Kapur, M. (2008, 2014). Productive failure in mathematical problem solving. *Cognition and Instruction*; *Educational Psychologist*.
- Schneider, B., Pea, R., Sharma, K. (multiple years). Gaze coupling in CSCL. *International Journal of Computer-Supported Collaborative Learning*.
- Makransky, G., & Petersen, G. B. (2021). The Cognitive-Affective Model of Immersive Learning (CAMIL). *Educational Psychology Review*.

Methods:
- Mediation analysis: Hayes, A. F. (2017). *Introduction to mediation, moderation, and conditional process analysis*.

Agents may cite or extend; humans verify before paper draft.

## 11. When to update this doc

- Adding/removing a condition → update §3
- Adding/changing a measure → update §4 or §5
- New scaffolding decision → update §6
- Theoretical pivot (e.g., adopting a new framework) → discuss with research lead first, then update §2
