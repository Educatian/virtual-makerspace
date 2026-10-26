# Makerspace episodes

Five learning episodes built on the shared 3D workbench, delivered **one complete vertical
episode at a time**. Each episode is reviewed before the next one starts.

| # | Episode | Studio | Status |
|---|---|---|---|
| 1 | Rescue Signal Workshop | Snapino Bridge | **Implemented on this branch.** Awaiting independent review. |
| 2 | Sound Flow Studio | new | Planned. The acceptance contract is below; not started. |
| 3 | Resource-Limited Greenhouse | Greenhouse | Planned. The acceptance contract is below; not started. |
| 4 | Smart Sorting Center | new | Planned. The acceptance contract is below; not started. |
| 5 | Structural Test Yard | new | Planned. The acceptance contract is below; not started. |

Episodes 2–5 are not in the app. There are no placeholder buttons, rooms or stubs for them.

## Quality contract (applies to every episode)

**3D and interaction**
- Each episode must match the refined desktop bench up close:
  - plausible physical scale and purposeful materials and light;
  - detailed terminals and connectors, with correctly seated cable tips;
  - legible controls and labels;
  - no floating or intersecting leads, and no bare primitive stand-ins.
- Learners manipulate meaningful 3D artifacts, not a worksheet pasted over a scene. The loop is goal → prediction/design → construction → test → explanation → revision. Success, incorrect construction, diagnosis and recovery are all playable.
- There are no points, XP or countdowns.

**Research conditions**
- PF/DI condition boundaries and existing research semantics are preserved.
- No unsolicited hints in PF. Bolt is never an answer oracle.

**State and collaboration**
- **One authoritative domain state** drives simulation, feedback, completion, collaboration and instrumentation. Assumptions and approximations are stated.
- Room authority applies throughout:
  - claims and simultaneous edits, with stale refusals;
  - late join and reconnect;
  - undo/redo where the state is an edit;
  - validated, versioned export/import;
  - autosave, recovery and reset of meaningful state, with drafts kept separately.
- Older projects and other studios keep working.
- Validation happens on the server, not only in client clamps.

**Tests and evidence**
- Tests cover:
  - deterministic domain logic, positive and negative cases, with independent reference/oracle cases;
  - multi-client behavior on the actual server path;
  - real browser interaction;
  - the full existing regression suite plus typecheck and build.
- Tests use random local QA rooms, never the production room 7K3M. Runs are labelled as developer-environment runs; the repository's only GitHub check is GitGuardian.
- Visual evidence is committed and tied to a code SHA or build. It uses a reproducible capture script and covers:
  - an overview and close-ups of connectors and controls;
  - running, error and recovery states;
  - desktop and phone-width viewports;
  - renderer counters where available.
- SwiftShader numbers are not real-device frame rates. No GPU, phone or Quest certification is claimed.

**Honesty and cleanup**
- No XR parity or AVR execution is claimed unless implemented.
- Audio, timers and resources are cleaned up when leaving, switching studios or disconnecting.

---

## Episode 1 · Rescue Signal Workshop (implemented)

**Story.** Two learners must get a rescue message across using light alone. The **sender** chooses a situation (mission), decides what the message should say, builds a transmitter on the Snapino base (Lamp L1 or LED D1 wired from a D pin to GND) and writes the write/wait blocks. The **receiver** watches the light on the shared bench and records a first reading. Both then compare:
- what was intended;
- what the light actually said under the protocol;
- what was read.

They explain the difference, revise and retest.

### Protocol: Rescue Flash Code v1

The protocol is explicit, inspectable and small (`src/episodes/rescue-signal.ts`):

| Word | Flashes | | Word | Flashes |
|---|---|---|---|---|
| HELP | ● ● ● | | SAFE | ▬ ● |
| INJURED | ▬ ▬ | | NORTH | ▬ ● ● |
| WATER | ● ▬ | | SOUTH | ● ● ▬ |

**Light bands**
- A *flash* is a continuous stretch of light from a lamp or LED that the circuit actually powers.
- Short (●): 200–450 ms. Long (▬): 650–1500 ms.
- Anything else is ambiguous, including 450–650 ms.

**Dark bands**
- A dark gap of 200–600 ms separates flashes within one word.
- A dark gap of 1200 ms or more is a **pause boundary** between words.
- 600–1200 ms is ambiguous.

**Messages and scope**
- A message is 1–3 words.
- There is no Morse code, letters or free text, and no hidden scoring.

### What is modelled, and how

**One circuit model.** `src/circuit/snapino-circuit.ts` is a pure function of stud placements and pin levels. The same model drives:
- the 3D lamp (the scene's `evaluateSnapino` was refactored to use it);
- the round's recorded light;
- the tests.

So an open, unpowered or miswired lamp gives no light, whatever the code does.

**Transmit once.** A transmission runs the blocks **once from the top**, unlike Run's endless `loop()`:
- writes and follows switch pins instantly, and waits advance time;
- every pin is LOW before and after;
- `follow` reads D2, which is fixed for the transmission.

**Simplifications**
- The light follows the pin with no filament warm-up.
- The LED is non-polar here, exactly as the Snapino studio always treated it.

**Authoritative state.** The room's episode state (`src/episodes/rescue-state.ts`) changes only through a validated reducer applied by the room server (`cloudflare/room-core.js`, shared by the Durable Object and the local relay). It holds:
- roles, the mission and the sender's intended words;
- the current round: intent fixed at its first transmission, the transmitted program, a **server-side snapshot of the Snapino parts**, `startedAt` (server time), duration and stop;
- the receiver's **first** reading (never changeable);
- the team explanation and the round history.

**Derived, never stored.** Outcome, diagnosis, completion and traces are derived from that state by pure functions. Every client derives the same result, and there is no cosmetic success.

**Timing and synchronization**
- **Shared clock.** No client runs its own timer for the signal. Each client renders the transmission from `room server time − startedAt`. The server time comes from the `serverNow` stamp the room adds to every update.
- **Late joiners and reconnects** land at the right moment. Tolerance is one network transit (tens of milliseconds locally). Nothing is sent per frame.
- **Hidden tabs** jump to the correct point when shown again. The receiver is told that part of the signal was not watched, and should use Replay before reading.
- **The transmitter is fixed while transmitting.** Any accepted change to a Snapino part or to the program ends the transmission at that moment: a teammate's edit, an import (including importing the *identical* running program, which sends an authoritative stop), or Run/Stop. The recorded snapshot therefore always matches the light everyone saw.
- **Stopping.** Anyone in the room may stop a transmission.
- **Leaving** frees the leaver's roles. When everyone leaves, a running transmission ends, rounds and design stay, and roles clear.

**Other behavior**
- **Replay** is local and drawn in the panel (a lamp and a playhead on the recorded light strip), never on the bench, so it can't be mistaken for a new transmission.
- **Solo.** With nobody else in the room, the sender can transmit and see a *solo check*: what a receiver following the protocol would read, plus the diagnosis. A real reading needs a second person; Bolt is not involved.
- **Pedagogical separation.** The receiver's normal panel does not show the intended words before the first reading. The data is in every client's room state, so this is not client-side secrecy.

### PF and DI

**Both conditions**
- Both see the vocabulary (words → flash patterns). It is the shared code both roles need.

**DI only**
- The timing bands, a worked recommendation (300/900/300/1500 ms) and a "Write blocks for this message" helper are shown up front.

**PF**
- The bands appear only after the team has compared its first round (consolidation). Learners decide their timing first.

**Diagnoses**
- In both conditions, diagnoses appear only after the receiver has committed a first reading.
- They are factual measurements against the circuit and the protocol: wiring, pins, flash and gap lengths, cut-offs and what the light said. They are not suggestions.

### Outcomes

| Outcome | Meaning |
|---|---|
| Message delivered | The light was clear under the protocol, said exactly the intended words, and was read as sent. |
| No light reached the receiver | Open circuit, wrong pin, no lamp, or a short. |
| The signal was ambiguous | A flash or gap was outside its band, or a group is not a word. |
| The signal said something else | Clear light whose words differ from the intention. A lucky guess on such a signal is **not** delivery. |
| Read differently | A clear, correct signal whose reading differs. |

The workshop goal is met by a delivered round that the team has also explained.

### Collaboration, files and persistence

- **Program and bench**
  - Transmitting makes the sent program the room's program (stopped), so program revisions stay consistent.
  - Bench and program edits keep all earlier rules: claims, stale refusals, undo/redo, and atomic parts+program imports.
- **Episode actions** (roles, design, transmit, stop, read, explain, close round, reset) are room events. They are validated and ordered by the server, and they are **not** undo steps.
- **Room guidance.** While the workshop is open, the Workshop Guide's pinned line describes the two workshop roles instead of the studio's default wirer/coder split.
- **Project files**
  - A Snapino project may carry `episode: { id: "rescue-signal", v: 1, mission, intent }`. Older projects import unchanged.
  - Rounds, readings and explanations are session activity and are never exported.
  - On import, the design is applied after the atomic parts+program edit. If the room refuses it (not the sender, or during a round), the learner is told.
- **Persistence**
  - Local recovery saves the design. A design with words is not an "empty" bench.
  - The Durable Object persists the episode state (`episode` key) and validates it on load. Claims survive hibernation.
- **Traces**
  - Episode traces use the existing actions (`role`, `test`, `reflect`). Example: "Rescue signal · round 2 transmitted (18 blocks, 6.3 s)".
  - Traces never contain the learner's words: no explanation text and no reading words.

### Tests (developer environment)

| Command | What it checks |
|---|---|
| `npm run test:episode` | Domain + reducer checks (`scripts/rescue-signal-check.mjs`): protocol band edges; every 1–3-word message round-trips on every pin; delivered, misread, lucky-guess, open, wrong-pin, no-lamp, always-on, short, ambiguous-flash, ambiguous-gap, cut-off, left-on and follow cases; an **independent 1 ms oracle** with its own interpreter and stud search on random programs and layouts; roles, first-reading, stale, round-open, swap, stop and leave rules; hostile actions and states. Room-core checks (`scripts/episode-sync-check.mjs`): two clients and a late joiner on the real room core with a controllable clock — shared elapsed time, bench and program edits ending a transmission, an atomic import, stale program revisions, role swap, stale roles after reconnect, an emptied room. |
| `npm run test:tools` | `WorkbenchTools` exact code: the design is exported, autosaved and applied after the parts edit, refusals are reported, and tampered designs are refused before any edit. |
| `npm run test:project` | Project-file design validation (hostile values; Snapino only; older files). |
| `npm run test:snapino` | The raised block cap: 48 blocks accepted, 49 refused (client; the Worker's sanitizer uses the same cap). |
| `node --experimental-strip-types scripts/e2e-rescue-signal.mjs` | Two real browsers over wrangler dev (Durable Object + WebSocket) clicking the real panel. The full loop, the receiver's own bench lamp checked frame by frame against the timeline (at least three driven frames, at least one lit, none wrong), the ambiguous, open-circuit and recovery rounds, a dropped connection mid-transmission (the room releases the receiver's role, the client reconnects by itself inside the still-running round at the shared elapsed time, must retake the role, and its lamp keeps following the timeline), a full page reload (re-entering from the lobby restores the round, without a role), a teammate's edit and an identical-program import ending a transmission, the sender's Stop (lamp dark on the receiver's bench), a role swap, export, leaving mid-transmission (the leaver's role is freed), and a late joiner on a phone-width viewport who receives the rounds, the current round and the roles. The drop uses a `?qa`-only hook that closes the socket; everything after it is the normal reconnect path. |
| `node scripts/qa-episode.mjs` | Visual capture (solo sender, peer mode): overview, matched lamp close-ups lit/unlit on its snaps, a low angle on the snaps, the receiver's framing, a running transmission, the solo check of a working round, an open circuit and its recovery, a phone viewport; renderer counters per view. Output and SHA: [`docs/images/episodes/rescue-signal/`](images/episodes/rescue-signal/README.md). |

**Panel actions are serialized.** While one room action is in flight, every action button in the panel is disabled (and `aria-busy` is set), so a quick second click is never dropped silently or built on a not-yet-updated design. An earlier e2e run caught exactly that: the second word was added on top of a state that did not yet contain the first.

### Limits (honest)

- **Not a radio or optics model.** Light reaches the receiver if the lamp is lit; there is no distance, glare or brightness threshold.
- **Not an AVR.** The blocks run in the bench's block runner; the generated `.ino` is not executed.
- **Software-rendered evidence.** Frame-timing evidence comes from SwiftShader in headless Chromium; there are no real-GPU, phone or Quest measurements.
  - The Snapino base and carrier GLBs (hundreds of static meshes) are now merged per material at load. The same 1440×900 overview (`scripts/qa-3d.mjs`, shot `8-snapino-overview`) went from 1,229 to 683 draw calls with identical triangles (96,826). The PCB close-up draws 115 calls, but more triangles (45,914), because merged meshes are culled as a whole. This is still a heavy scene for a low-end phone, and no real phone was measured.
  - On a slow frame, the lamp shows the state at that frame's time. The test checks exactly that, not a frame rate.
- **Same-device tabs.** Without a server, tabs converge by Lamport order. Concurrent conflicting actions resolve to one winner, and roles are not arbitrated as strictly as on the server.
- **Desktop only.** The WebXR path does not include the episode.

---

## Acceptance contracts for the next episodes (not implemented)

Each starts only after the previous episode passes independent review.

### 2 · Sound Flow Studio

**Content and audio**
- Original, high-detail oscillator/source, filter, gain and speaker modules, with real patch jacks, cables and knobs.
- The signal path is source → processing → output, and it runs an actual Web Audio graph.
- The sound follows the patched graph and its settings. Mute, mispatch and distortion are diagnosable.

**Safety and accessibility**
- Audio starts only on a user gesture.
- Gain is conservatively limited, and mute takes effect immediately.
- Audio is cleaned up on leave, studio switch and disconnect.
- There is a non-audio indication of the sound for accessibility.

**Sync and honesty**
- Parameters and patch state are synced. Sample-accurate remote audio is not claimed.
- The docs explain that this is an educational signal abstraction, not SPICE-equivalent electronics.

**Tests**
- DSP behavior checked offline against references (OfflineAudioContext or pure DSP).
- Browser audio activation and stop.
- Not only visual meters.

### 3 · Resource-Limited Greenhouse

**Model**
- Keep and improve the existing sensors, hoses, pump and fan.
- Add tank volume, irrigation consumption, plant and soil states, and environmental disturbances.
- Water level, flow and plant response follow a documented, tested water balance and a simplified climate model. This is not botanical prediction.

**Learning design**
- Learners choose allocation strategies with tradeoffs, rather than plugging in every part.

**Constraints**
- Deterministic seeds and time controls.
- Bounded resources: no negative water, and no water through an invalid hose.
- The server's saved state includes remaining resources and model time.

### 4 · Smart Sorting Center

**Data and model**
- Physical, manipulable objects with inspectable features, and a collect → label → train → test loop.
- A real simple classifier, with:
  - explicit held-out data and deterministic splits;
  - model and data versions;
  - no answer leakage.
- Labeling correctness is kept separate from predictive performance. The fraction of currently correct labels is never called "model accuracy".
- Support for unseen examples, distribution shift, dataset revision, and uncertain or misclassified outcomes.

**3D**
- Polished bins, conveyor and sensor area.
- No pretend training animation disconnected from the computation.

### 5 · Structural Test Yard

**Construction and solver**
- Detailed beams, supports and joints, with coherent snapping and connection degrees of freedom, and adjustable load positions.
- Deformations come from a verified, appropriately limited solver: for example, a supported planar small-displacement linear truss. Full structural engineering is not claimed.
- Mechanisms, unsupported geometry and singular cases are detected explicitly. Collapse is never a fabricated success.

**Validation and design**
- Simple known structures are compared to analytical references.
- Material and budget constraints drive iteration, not arbitrary points.
- Polished connection hardware and loading apparatus, with honest limits.
- Build narrower and correct rather than a large unvalidated physics demo.
