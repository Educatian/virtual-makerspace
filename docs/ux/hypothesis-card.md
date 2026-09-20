# Interaction blueprint: Hypothesis Card

Out-of-task metacognitive prompt fired on the first re-grab of a previously-snapped component within a task session. Pedagogy clearance: `docs/pedagogy/hypothesis-card.md` (APPROVE WITH CHANGES).

## Sensory contract

- **What the user does**: releases a placed component (`socket_disconnect`), then triggers `grab_start` on the *same entity* — the system reads "I'm picking this up again to redo it."
- **What they perceive in response**: a small panel slides into the lower-right of their head-locked field of view (peripheral, not center), showing the prompt, an idle voice-input affordance, and a Skip button. No sound, no haptic. The card persists until the user acts (skip, submit, or auto-dismiss at 30s).
- **Latency budget**: < 100ms from `grab_start` to card visible. Card is a pre-built `PanelUI` made invisible, not constructed on demand. No allocation in the hot path.
- **Failure mode feel**: card is *peripheral and ignorable*, not modal. Skip is one tap. The phrasing is forward-looking ("what do you expect to be different"), not evaluative ("you got it wrong"). Compliance with `interaction-spec.md §8` and pedagogy doc Required-changes.

## Specifics

### Placement — recommend Option B variant: HUD-adjacent peripheral follower

**Rejected: Option A (floating near component).** The component is in motion (just grabbed, ray-attached). A panel pinned to a moving object would either lag the ray or jitter — both break embodied confidence. Worse, the panel competes with the user's primary visual channel (where their hands are) at the exact moment they're trying to *use* their hands.

**Rejected: Option C (notebook prop).** Requires the learner to disengage from the workbench and walk/reach to a separate prop. That is a flow break of 2-3s minimum and turns reflection into a chore. Also charter §6-adjacent: a "pick up the notebook" mechanic frames the prompt as a task to complete, not a quiet question.

**Locked: Option B variant — secondary follower offset to lower-right.** Same `Follower` pattern as the existing HUD (`hud-system.ts`), but:
- offset `[+0.28, -0.30, -0.6]` from head (right of HUD, ~30cm below eye level, ~60cm forward)
- slightly closer than HUD (0.6m vs HUD's 0.7m) so it reads at a glance without occluding the breadboard
- `tolerance: 0.4m`, `maxAngle: 30°` — slightly looser than HUD so the card stays planted while the user works, only catches up when they turn their body
- panel size 0.32m wide × 0.18m tall — about 60% of HUD width

The user can ignore it by simply not turning their head right. That is the embodiment of "peripheral and ignorable."

### Visual — out-of-task palette (`bg-panel`, not HUD black)

Per `style-guide.md §2` reconciliation: HUD = circuit-state mirror (green); probe overlay = out-of-task UI (blue/panel). The hypothesis card is **out-of-task UI inside the XR session** — first of its kind. It must read as "meta, not the work." Use:

| Surface | Token | Hex |
|---|---|---|
| Panel background | `bg-panel` | `#141a26` (90% opacity over world) |
| Panel border | `border-subtle` | `#2a3245`, 1px |
| Prompt text | `text-primary` | `#e8eef7` |
| Voice idle hint / chip text | `text-muted` | `#9aa6bd` |
| Voice listening indicator | `accent-action` | `#3b82f6` |
| Skip button text | `text-muted` | `#9aa6bd` (no background, ghost button) |
| Submit button | `accent-action` | `#3b82f6` background, white text |

**Forbidden**: `accent-circuit` green anywhere on this card. Green is reserved for "the thing is working" semantics — the card is reflective, not validating. **Forbidden**: `signal-error` red anywhere. The card is not an error.

**No glow, no pulse, no slide-in animation.** Per `style-guide.md §6` — instant on, instant off. A card that *sneaks* into peripheral vision is more hostile than one that simply appears; the user's peripheral-motion detector flags sliding UI as a threat.

### Geometry & layout

- 0.32m × 0.18m PanelUI, root background `bg-panel`
- Padding 0.012m (per `style-guide.md §4` in-VR padding 0.01m base, +20% for breathing room since this is text-heavy)
- Single column:
  - **Prompt** (top, full width, 1.6 UIKit units): `"Before you place this again — what do you expect to be different?"` — exact wording, no variants.
  - **Voice-input row** (mid): a microphone glyph + label.
    - Idle: glyph `text-muted`, label `"Tap trigger on this card to speak"` (`text-muted`)
    - Listening: glyph `accent-action`, label `"Listening…"`. A simple 3-dot animation is permitted *only* during listening (it is informative, not decorative — the user needs to know STT is live).
    - Recognized: glyph hidden, recognized text shown in `text-primary`, with a small `Edit` ghost-button if user wants to retry voice.
  - **Chip row** (below voice, hidden by default): three chips on one line:
    - `"different position"` / `"different orientation"` / `"something else"`
    - `bg-near-black` background, `text-primary` text, `border-subtle` 1px border, 0.012m corner radius. Selected state: border becomes `accent-action`.
    - This row is shown **only** if STT init failed (`webkitSpeechRecognition` undefined) OR permission denied OR user explicitly taps a "Use chips instead" affordance under the voice row.
  - **Bottom row**: `Skip` (left, ghost, `text-muted`) and `Submit` (right, `accent-action`) — Submit disabled until either text is captured or a chip is selected.

### Audio

None. `style-guide.md §7` — no UI sounds yet. Adding a "card appears" sound would game-ify the moment. Speech recognition uses no chime on start/stop; the listening text label is sufficient confirmation.

### Haptic

None for show/hide. Optional polish (post-pilot): single 30ms × 0.3 pulse on the controller whose trigger committed Submit, as a generic UI commit confirmation. **Not** on Skip — that should feel weightless.

### State machine

| State | Enter trigger | Exit trigger |
|---|---|---|
| `dormant` | system init / `task_complete` | re-grab detected (see throttle §6) |
| `idle_voice` | re-grab detected, STT available | voice-button trigger pull → `listening`; chip tap → `chip_selected`; skip → `dismissed_skip`; 30s elapsed → `dismissed_timeout` |
| `idle_chips` | re-grab detected, STT unavailable/denied | chip tap → `chip_selected`; skip → `dismissed_skip`; 30s elapsed → `dismissed_timeout` |
| `listening` | trigger pulled while card hovered | STT result → `voice_captured`; STT error → `idle_chips` (fallback); 8s elapsed → `idle_voice` |
| `voice_captured` | STT returns text | Edit tap → `idle_voice`; Submit → `submitted` |
| `chip_selected` | chip tap | Submit → `submitted`; skip → `dismissed_skip` |
| `submitted` / `dismissed_*` | terminal | none — system locks for the rest of session |

## Latency & timing

- **`grab_start` → card visible**: < 100ms. Implementation: card is a pre-instantiated PanelUI hidden via `entity.object3D.visible = false` at scene load. Show is one bool flip + one Follower position update.
- **Card persistence if ignored**: 30s. Then auto-dismiss with `hypothesis_card_dismissed { reason: "timeout_ignored" }`. 30s is long enough that a learner mid-iteration won't have it yank under them, short enough that it doesn't haunt them across attempts. (Pedagogy doc requires the throttle to prevent re-prompts; auto-dismiss is the ignore-path counterpart.)
- **STT permission**: requested at task start (in `markTaskStart`), not on first card. The mic-permission browser dialog mid-task would be the worst possible interruption. If denied at task start, the card boots straight to `idle_chips` mode.
- **STT max listening duration**: 8s, then auto-stop and present whatever was captured. Avoids a learner accidentally leaving STT live for the rest of the session.
- **Non-modal**: card does NOT pause grab interaction. The learner can hold the component while the card is up — they can keep working. The card's Follower offset means it sits *beside* their hands, not on top of them. Ignoring it costs zero motor effort.

## Telemetry hooks

Three new events. All include `condition` (PF/DI) and `entity_id`:

```ts
telemetry.log("hypothesis_card_shown", {
  entity_id: number,
  trigger_reason: "regrab_after_disconnect",
  stt_available: boolean,        // navigator/webkit support detected at task start
  stt_permission: "granted" | "denied" | "unknown",
});

telemetry.log("hypothesis_logged", {
  entity_id: number,
  input_mode: "voice" | "chip",
  text: string,                  // verbatim — voice STT result or chip label
  char_count: number,
  duration_ms: number,           // shown → submitted
});

telemetry.log("hypothesis_card_dismissed", {
  entity_id: number,
  reason: "skip" | "timeout_ignored",
  duration_ms: number,           // shown → dismissed
});
```

Skip and timeout are *both* logged so analysis can distinguish "actively rejected" from "ignored entirely" — those are different cognitive signals. Naming follows existing `snake_case` convention (`grab_start`, `socket_disconnect`, `near_miss_marker_shown`).

## Throttle implementation

**Locked: once per task session.** A module-scope flag in a new `src/systems/hypothesis-system.ts` — `let cardFiredThisSession = false`. Reset by listening to `vm:task_start` (sets to `false`) and never re-set within a session. The `vm:task_complete` event is also a hard lock (in case a learner somehow re-grabs after completion).

**Why module flag, not `task-progress.ts`**: `task-progress.ts` is a thin task-lifecycle module; coupling hypothesis state into it inverts the dependency. Hypothesis-system already needs to listen to `vm:task_start`/`vm:task_complete` for visibility/lock; owning its own flag is cleaner.

**Note on pedagogy-doc divergence**: the pedagogy review specified "at most once per iteration cycle, hard-capped at once per 90s globally" (multiple iteration cycles within a session each get a card). The user's locked decision tightens this to "once per task session." This is more conservative — fewer prompts, less risk of the card homogenizing the manipulation signal (pedagogy §8 removal criterion). Flagged so reviewer is aware of the deliberate tightening; no action needed.

## Pitfalls to watch

1. **Web Speech API is `webkitSpeechRecognition` on most browsers** — feature-detect both. Quest browser support for Web Speech API is partial; expect to land in `idle_chips` mode often. Detect at task start, store the result, do not re-probe per card show.
2. **Mic permission denial is silent** — `getUserMedia` returns a rejected promise but no event fires later. Track permission state explicitly; never assume "card showed STT row → user has mic." Always check the cached state from task start.
3. **Card while a component is held** — the user grabbed the component to re-place it; the card fires *during* the grab. Do NOT make the card grab-blocking. Do NOT re-fire the card when they release and grab again later in the same session (the throttle handles this, but only if the flag is checked at re-grab, not at release).
4. **Follower jitter** — copy HUD's Follower setup exactly. Tighter `tolerance` than HUD's 0.3m would cause the card to jiggle whenever the user looks down at their hands; that defeats "peripheral and ignorable."
5. **Voice-input committed by trigger** — the same trigger button used for grab also commits the voice mic. Risk: a user trying to grab a component while the card is up accidentally starts STT. Mitigation: voice-mic is only triggerable when the controller ray is *hovering the card* (use `Interactable` on the card body). Outside that hover, trigger pulls go to grab as normal.
6. **Auto-dismiss timer using `setTimeout`** — *do not*. Per `snap-fail-feedback.md` pitfall #1, `setTimeout` is throttled in inactive tabs and stretched during XR blur. Use a frame-checked deadline: store `shownAt = performance.now()`, compare in `update()`, dismiss when `now - shownAt >= 30000`.
7. **Card state survives `vm:task_complete`** — if the user re-grabs after completion (e.g., to play around), do NOT re-fire. The flag is a one-way latch.
8. **Recognized speech text length** — STT can return paragraphs. Truncate display at 80 chars (with ellipsis), but log full text in `hypothesis_logged.text`. Pedagogy doc wants the full reflection; UI must not be hostage to verbose users.
9. **PanelUI text wrapping** — the prompt is 65 characters. Test that it wraps cleanly at 0.32m panel width with the chosen font size before locking layout. If it overflows, drop prompt to 1.4 UIKit units (still legible at 0.6m per `style-guide.md §3`).
10. **Glyph asset for microphone** — there is no current mic icon in the project. Use a Unicode glyph (U+1F3A4 🎤) as a placeholder; flag for asset replacement before main study. Style-guide currently has no icon system; this likely needs a §10 amendment.

## Push-back on locked decisions

**None blocking.** Two notes for the human:

- **Once-per-session is more conservative than pedagogy specified.** If pilot data show that learners only re-grab once anyway (likely — task is short), the throttle is moot. If learners iterate heavily, the once-per-session rule means later iterations get no metacognitive prompt. This is fine *if* the research question is "does the prompt at all matter," but limits the dose-response analysis. Flag for analysis plan.
- **The mic permission ask at task start** is itself a non-task interruption (pedagogy doc threats §5). Keeping it before `markTaskStart` (so it lands during page-load / probe-overlay phase) is recommended — fold into the existing `runPreProbe` flow if possible. That moves the permission ask out of the XR session entirely.

## Open questions (need pilot data)

1. **30s auto-dismiss** vs 60s: short enough to not haunt, long enough that a deliberating learner doesn't lose it. 30s is a guess. Watch `hypothesis_card_dismissed.duration_ms` distribution in pilot — if mode is near 30s (timeouts dominate), users were close to deciding; lengthen. If mode is 2-5s (skip dominates), shorten or it's just clutter.
2. **Card placement L vs R**: lower-right assumes right-handed dominant. For a left-handed participant, the card sits over their primary working hand. Consider reading dominance from a pre-task config or mirroring at task start.
3. **Voice-listening 8s cap**: arbitrary. If pilot users get cut off mid-sentence, raise to 12s.
4. **Chip wording empirics**: "different position" / "different orientation" / "something else" are deliberately content-free per pedagogy lock, but in pilot, watch for users who say (in retrospective) they wanted to say something specific (e.g., "different wire") and felt the chips didn't fit. If >30% report this, the closed fallback is leaking constraint and should drop to skip-only mode.
