# Circuit engine, inspector and project workflow

This document describes the Circuit Bench upgrade on `feat/circuit-workbench-upgrade`
(stacked on PR #2, `feat/teachable-ai-teammate`). It covers the shared DC engine, how its
result drives every view, the inspector, editing and project files, the 3D bench models,
migration notes for researchers, and what is **not** implemented.

## One electrical truth

Before this branch there were three different circuit evaluators. They all treated resistors
like wires, lit an LED in either polarity, and used a constant brightness:

| Before | Where | Now |
|---|---|---|
| `evaluateCircuit` (net union) | `src/desktop/scene.ts` | Calls the engine through `analyzeCircuit` |
| `analyzeCircuit` (duplicate union) | `src/desktop/circuit-topology.ts` | Wraps the engine; adds Bolt's layout reasoning |
| `CircuitEvalSystem` (net union) | `src/systems/circuit-eval-system.ts` | Legacy by default; engine with `?circuitModel=dc`; DC result always logged |

The engine lives in `src/circuit/` and has no DOM or three.js dependency:

- `dc-engine.ts`: netlist validation and the solver (`solveCircuit`), `SOLVER_VERSION = "dc-mna-1.0.0"`.
- `breadboard.ts`: socket → net mapping (`socketNet`), the netlist builder (`buildBoardNetlist`)
  and `analyzeBoard` (success, glowing/safe/overdriven/burnt/reversed LEDs, net voltages).
- `part-props.ts`: editable values (`ohms`, `volts`), their bounds, rounding, parsing ("4.7k")
  and the resistor color code.

The desktop scene (LED glow, status line, the check button), the inspector, Bolt's planner and
reactions, and the tests all read the same `CircuitAnalysis`.

## Model and educational approximations

The solver uses **modified nodal analysis**: one unknown per node voltage and one per voltage
source current. The dense system is solved by Gaussian elimination with partial pivoting.

| Part | Model | Notes |
|---|---|---|
| Battery | Ideal source in series with a 1 Ω internal resistance | Real 9 V cells are about 1–2 Ω when fresh and sag non-linearly; there is no state of charge. |
| Resistor | Ideal, value from the part (10 Ω – 1 MΩ, three significant figures) | Power is reported, but there is no thermal model or power rating. |
| LED | Two segments: *off* = 1 nS leakage; *on* = forward drop Vf in series with 15 Ω | Red Vf ≈ 1.9 V, green ≈ 2.1 V. This is not the Shockley exponential, so currents are representative only to about 10–20 % in the 1–30 mA range. |
| Jumper wire | 0.05 Ω | Its current can be shown, and a wire across the battery reads as a short. |
| Breadboard strip | Ideal join | Rails are rows 0 and 11, and columns join rows a–e and f–j. |

The solver iterates the LED states. It flips the single most-inconsistent LED each pass (at most
60 passes), so the states cannot oscillate. If they never settle, the result is flagged
`non-convergence` and nothing is shown as working.

For robustness, every node gets a 10⁻¹² S conductance to ground, so floating islands keep the
matrix regular. Floating parts are found by graph search and reported as such, never as 0 V. A
second battery in its own separate loop is tied to the reference by a single bridge, which
carries no current. A numerically zero pivot returns `singular`.

**Diagnostics** carry a code, a severity and a plain-language message:

| Code | Severity | Meaning |
|---|---|---|
| `invalid-input` | error | A rejected part, such as a NaN/∞/out-of-range value, an unknown kind, a duplicate id or a socket that does not exist. The part is left out, and the status is `invalid`, never `ok`. |
| `no-source` | info | No battery is placed. |
| `open-circuit` | info | A battery is placed but delivers less than 1 µA. |
| `short-circuit` | error | The battery's terminals are joined, or a source or wire carries more than 1 A. A short is never treated as success, and LEDs show dark. |
| `reverse-led` | warning | An LED is reverse-biased by more than 0.5 V. Above 5 V the message also warns about LED damage. |
| `led-overcurrent` | warning | The LED is above its 20 mA rating but below 100 mA. It glows, but the circuit is not a success. |
| `led-burnout` | error | 100 mA or more, for example an LED with no resistor on 9 V (about 440 mA). The LED briefly flashes, then shows dark and scorched. |
| `floating` | info | A part is not connected to the battery's circuit. |
| `singular` / `non-convergence` | error | The circuit could not be solved, so nothing is shown as working. |

The overall `status`, most severe first, is `invalid`, `singular`/`non-convergence`,
`short-circuit`, `unsafe` (an LED overdriven or burning out), `open-circuit`, `no-source`, then
`ok`. *Open* is topological: it means no conducting path (resistors, wires and LEDs that are on)
runs from the battery's + back to its −. A closed 2 MΩ loop carrying 0.75 µA is therefore `ok`,
not open, while a loop blocked only by a backwards LED is open. Pivots are judged against their
own row, and every solution is checked by its residual. A stiff 1 mΩ source next to floating
parts still solves, and a near-singular system is refused rather than trusted.

A circuit is a **success** only when all of these hold: it solved, it has no error-severity
diagnostic, at least one LED is `lit` (from 10 % up to its rating), and no LED is overdriven.

### Worked example: why the safe plan uses 1 kΩ

At 9 V a red LED drops about 1.9 V, leaving about 7 V for the resistor:

- **220 Ω:** about 7 V / 236 Ω ≈ 30 mA. That is above a 5 mm indicator LED's 20 mA rating, so it
  is *not* a safe 20 mA example at 9 V. (The rough "9 V − 2 V over 220 Ω ≈ 32 mA" estimate gives
  the same answer.) The engine reports `led-overcurrent`.
- **1 kΩ:** about 7 V / 1016 Ω ≈ 7.0 mA, which is safe and clearly lit. Bolt's taught plan, the
  diagnostic demo and the e2e tests use 1 kΩ.
- 220 Ω *is* a safe example at 5 V: about 13 mA.

A plain series resistor does not by itself stop an LED from lighting. Treating it as a wire, as
the old evaluators did, removed its voltage drop, not its connectivity.

## Polarity convention

Lead A is `sockets[0]`, the part's local −x end. For a battery it is **+**; for an LED it is the
**anode** (the long lead; the flat side of the flange and the larger anvil inside the resin mark
the cathode, lead B). The XR spawner already used this convention (`posTerm` at −x).

Bolt's plans place the battery with + toward the chain, so every planned LED is forward-biased.
The old demo layout had the LED backwards; it now uses `led-red: [53, 52]`.

## Synchronized electrical values

`SharedTransform` gained an optional `props: { ohms?, volts? }`.

- Every snapshot (`getSharedTransforms`, attempts, late-join `state-response`) includes `props`
  explicitly for the resistors and the battery.
- **Absent `props` means "unchanged"**, so older clients that never send it do not reset values.
- The Cloudflare Worker validates `props` in `sanitizeTransform`
  (`cloudflare/sanitize.js`, shared by `transform` and `state-response`). It uses the same bounds
  and rounding as `src/circuit/part-props.ts`, and `scripts/project-state-check.mjs` asserts the
  two agree. Invalid values are dropped, never relayed. The local relay
  (`server/collaboration.mjs`) passes messages through; every client sanitizes on apply.
- A value edit is claim → transform → release, with no `claim`/`move` trace. It is recorded as
  the new trace action **`edit`**. The Worker refuses a transform for a part someone else holds,
  and the inspector disables editing while a teammate or Bolt holds the part.

## Inspector (circuit meter)

The meter is a floating, collapsible glass panel in the Circuit Bench. Its collapsed state is
remembered per browser, and it starts collapsed on phones. Everything it shows comes from the
engine result:

- A status pill (*Safe · 7.0 mA*, *Overdriven*, *LED burns out*, *Short circuit*, *Open circuit*,
  *LED reversed*) and the diagnostic explanation.
- Readings with units: battery terminal voltage and current; each LED's current, voltage and
  state; each resistor's voltage, current and power; and wire currents when non-zero.
- For the selected part: lead A/B with polarity names, each lead's hole (`c5`, `+ rail, column 3`)
  and that net's voltage, live V/I/P, and **Return to tray**.
- Bounded value editing:
  - Resistors: 10 Ω – 1 MΩ, typed (`470`, `4.7k`, `1M`) or as preset chips.
  - Battery: 1–12 V, typed or as presets.
  - Out-of-range or unreadable input is refused with an explanation.
- Optional measurement tags that float over the LEDs (current) and resistors (voltage).

## Undo/redo, project files, recovery, reset

**Undo/redo** (toolbar buttons, Ctrl/Cmd+Z, Ctrl+Shift+Z or Ctrl+Y) covers only *your own*
completed edits: moves, value edits, return-to-tray, import and reset.

- An undo applies only if every affected part still matches its post-edit state. If a teammate
  or Bolt changed it since, the step is refused as stale ("their work is kept") and discarded.
- A part currently held by someone else blocks the step without discarding it.
- Undo is itself a shared edit, so every bench converges.
- History is cleared on a studio change.

**Project files** (toolbar folder menu → Export / Import):

- The format is `virtual-makerspace.project`, version 1. It holds sockets per part, electrical
  values, slide-switch state and, on Snapino, the sanitized block program.
- It holds no participant ids, names, chat, traces, recordings or tokens.
- It does not store positions: import recomputes them from sockets.
- Import is capped at 64 KB, uses a strict schema and accepts only catalog ids, in-range unique
  sockets and validated values. Unknown fields are dropped, and nothing from the file is rendered
  as HTML.
- Import asks for confirmation and refuses while Bolt is building or while anyone holds a part.
  It applies as shared edits and one undo step.

**Local recovery:** after changes, this browser keeps the latest project for the room and studio
(`localStorage`, same content as an export). On re-entry, if the room's bench differs, a banner
offers to restore it. Restoring is never automatic.

**Reset bench** (with a confirmation dialog) returns every part of the studio to the tray with
default values, as one undoable shared edit.

**Not implemented:** duplicating parts or adding parts from a catalog. Part ids are a fixed set,
enforced by the Worker's `COMPONENT_IDS`, the scene and Bolt. Dynamic ids would need protocol,
Worker, scene and research-schema changes, so no non-functional "duplicate" button was added.

## Snapino code: honest scope

The Snapino studio still runs **block statements** in a limited in-browser runner: pin on/off,
wait, and follow S1.

- The **Run blocks** button (formerly "Upload & Run") says what it does.
- The code panel shows the generated `.ino` sketch with a header stating that the bench did not
  compile or emulate it. **Download .ino** and **Copy** let learners build and upload it with the
  Arduino IDE.
- `scripts/snapino-sketch-check.mjs` checks every example and a set of generated programs with
  `g++ -fsyntax-only -Wall -Werror` against a minimal stub `Arduino.h`. This proves the C++ is
  well-formed and uses only `pinMode`/`digitalWrite`/`digitalRead`/`delay`. It is not an AVR
  build.
- **Not implemented:** compiling or emulating arbitrary Arduino/AVR sketches in the browser. The
  Nano model on the carrier carries a silkscreen note: "BLOCK RUNNER · NOT AN AVR EMULATOR".

## 3D bench models (`src/desktop/bench-models.ts`)

These are original procedural meshes, with no external or paid assets. 1 scene unit ≈ 10.6 mm
(0.24 units = 2.54 mm pitch).

- **Breadboard:**
  - A bevelled ABS frame and a printed top skin with real square cut-outs (alpha-tested) at
    exactly the picking/snap socket coordinates.
  - Through each hole you see a dark cavity floor, instanced hole walls and instanced nickel
    spring leaves.
  - A real center trench, red "+" and blue "−" rail stripes and marks, column numbers 1–16 and
    row letters a–j.
- **LED (5 mm):**
  - A lathe-turned tinted resin dome (clear-coated, translucent) and a flange with the
    cathode-side flat.
  - Visible post and anvil internals, and tinned leads that stop at the hole floor.
  - Emission follows the engine's current, kept moderate so the tint stays saturated. A burnt-out
    LED flashes, then shows a dark, smoky core.
- **Resistor (¼ W):**
  - A lathe body with bulged end caps and bent axial leads.
  - Color bands drawn from the actual value: 4-band carbon film (beige) when two digits are exact,
    otherwise 5-band metal film (blue, 1 %). Bands update when the value is edited.
- **9 V battery:**
  - A rounded graphite shell with a voltage label (it updates with the edited supply), a metal
    top, and a round + snap and hexagonal − snap above lead A and lead B.
  - It stands in a slim vertical PCB-mount clip (one row deep) whose pins are the leads; the
    shell starts above resistor height so parts in neighbouring rows are not buried in it.
  - Drawn at 25 % scale (true 26.5 × 17.5 × 48.5 mm proportions) so it does not bury the
    16-column board; everything else is 1:1. (A real 9 V battery would connect through a snap
    clip with wires; LEDs in directly adjacent holes can still touch, as real 5 mm LEDs do.)
- **Jumper wires:** smooth centripetal Catmull-Rom insulation that rises vertically out of each
  hole, ends just above the board, and continues as a bare tinned conductor down to the hole
  floor, anchored to the exact socket points.
- **Snapino PCB:** the Blender-built board gains a silkscreen with pin names, a "SNAPINO" title,
  the not-an-emulator note, and two rows of header strips with gold pins.
- **Materials and lighting:**
  - A PBR palette that separates matte ABS, tinned and nickel metal, resin, PVC and the label.
  - A hemisphere fill, one shadow-casting key light with a frustum fitted to the bench, a warm
    pendant, a cool rim and a dim room environment for reflections.
  - Soft contact-shadow decals under seated parts.
  - No bloom or post-processing.

**Performance budget:** holes, walls and contacts are 3 instanced meshes, and geometry and
materials are shared through a module cache.

- **Shadows:** the shadow map re-renders only for a few frames after something changes
  (`shadowMap.autoUpdate = false`), not every frame.
- **Quality tiers:** `?quality=low|medium|high`. *Low* is pixel ratio 1, no shadows and no LED
  point lights. *Medium* (the default on desktop) is a pixel ratio of at most 1.5 and a 1024
  shadow map. *High* is a pixel ratio of at most 2 and a 2048 shadow map. Coarse-pointer devices
  and devices with 2 or fewer cores start on *low*.
- **Adaptive resolution:** averages above 33 ms per frame step the pixel ratio down within the
  tier; averages below 14 ms step it back up, a bounded number of times.

The WebXR path (`src/index.ts`, IWSDK) does not use these desktop models. Its geometry is
unchanged, and **no Quest performance claim is made**: this was not measured on a headset.

### BEFORE / AFTER (same placements and camera, `scripts/qa-3d.mjs`)

![Overview](images/circuit-upgrade-2-overview-collapsed.jpg)
![LED powered (red, 7 mA)](images/circuit-upgrade-11-led-powered.jpg)
![LED unpowered (green, not connected)](images/circuit-upgrade-12-led-unpowered.jpg)
![Occupied sockets](images/circuit-upgrade-13-occupied-sockets.jpg)
![Cable tip](images/circuit-upgrade-14-cable-tip-macro.jpg)
![Snapino PCB](images/circuit-upgrade-9-pcb-close.jpg)
![Circuit meter with the 1 kΩ resistor set to 220 Ω](images/circuit-upgrade-15-meter-editor.jpg)

The renderer counters below are steady-state frames (SwiftShader, 1440×900, medium quality,
pixel ratio 1). The shadow map is cached between changes.

| View | Draw calls before → after | Triangles before → after |
|---|---|---|
| Circuit overview (panel open) | 508 → 270 | 79k → 41k |
| Circuit overview (panel collapsed) | 364 → 163 | 72k → 36k |
| Laptop 1180×760 | 534 → 266 | 77k → 38k |
| Snapino overview (unchanged GLB) | 1220 → 1229 | 96k → 97k |

## Research migration notes

- **Desktop `powered` / check-button meaning changed:** it now means *safe success*. Before, it
  meant "an LED's nets equal the battery's nets in either polarity". Two consequences:
  - Strips plus loop with no resistor is now a *burnout*, not a success.
  - A reversed LED or 220 Ω at 9 V is no longer a success.

  Sessions recorded before this branch should be compared on the old definition.
- **Bolt:**
  - The taught plan uses `resistor-1k`.
  - Test reactions name the current ("about 7 mA, inside the LED's 20 mA rating"), report
    burnout, overdrive, reversed LEDs and shorts, and keep the naive-idea phrasing in DI.
  - Its belief model, learning rules and `teach` traces are unchanged.
- **Trace schema:** a new `edit` action, so `claim`/`move` counts are unchanged by value edits,
  undo, import or reset. The Worker allows `edit`. The test-trace wording ("Ran motherboard
  power-path test") is unchanged even though the studio heading is now "Circuit Bench".
- **XR telemetry:**
  - `led_state_change` keeps `{ entity_id, lit }` with legacy semantics and adds
    `circuit_model`, `solver_version` and `dc_lit`.
  - A new event `circuit_dc_eval` (`solver_version`, `circuit_model`, `entity_id`, `dc_state`,
    `dc_lit`, `current_ma`, `status`) is logged when the placement changes.
  - `markTaskComplete` keeps legacy semantics unless `?circuitModel=dc`.
  - XR resistors carry nominal values (gold body = 220 Ω, brown body = 1 kΩ) in
    `CircuitNode.ohms`.
- **Protocol:** `SharedTransform.props` is optional and backward compatible (absent = unchanged).

## Tests

```bash
npm test              # typecheck + engine + agent + project-state + Snapino (incl. g++ syntax check)
npm run build
node scripts/e2e-ai-teammate.mjs http://localhost:4173          # BroadcastChannel, one browser
node scripts/e2e-ai-teammate-worker.mjs                        # Worker + Durable Object (wrangler dev)
node scripts/qa-3d.mjs http://localhost:4173 ./qa-3d [quality]  # renders + renderer counters
```

## Known limitations

- The model is DC-only: no capacitors, inductors, transients, AC, temperature or battery
  discharge. It is not SPICE, and LED currents are approximate (see the table above).
- The only editable values are resistance and supply voltage. LED color and forward voltage are
  fixed per part.
- The catalog is fixed. No duplication or new parts are possible (see above).
- Undo history is per browser tab and is lost on reload. Local recovery covers the bench state,
  not the history.
- A value edit made while a teammate is just starting a grab of the same part can lose the race.
  The Worker drops the transform, and the holder's next release re-synchronizes everyone to their
  state.
- Arduino sketches are generated and syntax-checked only. There is no AVR compile, upload or
  emulation.
- The renders were checked with software WebGL (SwiftShader) in headless Chromium. They were not
  checked on real GPUs, phones or a Quest headset.
