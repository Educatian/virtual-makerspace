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

**On screen.** The workshop is the **Workshop** tab of the single right-hand dock. Next to it are:
- the **Bench inspector**: a live circuit diagram derived from the seated parts, plus per-part pinout, behaviour and limits;
- Code;
- the collaboration tabs.

The 3D bench fills the space between the parts rail and the dock. Camera views: Bench 1, Top 2, Table 3, Lamp 4, and Fit part F. See [`reference-benchmark.md`](reference-benchmark.md).

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

**The circuit rule** (educational, not an electrical simulation): snap wires and a closed S1 join studs into nets. A load runs when its two ends are on **different** nets, one driven HIGH (the 5V pad, or a D pin set HIGH) and the other reaching GND. A D pin set LOW is not a current sink here.

**Faults.** The rule has three faults:
- 5V joined to GND is a short, and nothing runs.
- A D pin set HIGH whose pad is wired to GND is a **pin short**. That net is ground, never HIGH, so nothing is driven from it. The 3D bench shows its warning, and the round's diagnosis names the pin.
- A load whose two ends share a net (for example, a snap wire across it) is **bypassed** and never runs.

An earlier version let a HIGH pin wired to GND make the GND net "HIGH". A lamp bridged by a wire across D6–GND then "delivered" HELP. The parent review found this, and it is fixed and tested with an independent oracle.

**Transmit once.** A transmission runs the blocks **once from the top**, unlike Run's endless `loop()`:
- writes and follows switch pins instantly, and waits advance time;
- every pin is LOW before and after;
- `follow` reads D2, which is fixed for the transmission.

**Light that does not end.** After a transmission the transmitter's D pins are LOW. A lamp powered from 5V stays lit, on the bench and in reality.
- The recording marks its last stretch as **continuing**. The strip shows it with an open right edge.
- The decoder treats it as a flash with no measurable end, which makes the signal ambiguous.
- The diagnosis says it was still lit. It never says "switched off".
- A D-pin light that the blocks left on really does go out when the pins go LOW, and is reported that way.
- **Cut off by a bench change while lit.** The record holds the bench as it was when the transmission started, so it cannot know what the changed bench did next. For example, the edit may have removed the lamp.
  - The last stretch is marked **recorded up to the cut** (open right edge), not continuing.
  - The diagnosis says the light was still on when the change cut the transmission off, and that what followed is not part of the recording.
- A Stop, a program change, an emptied room or a reset leave the bench as it was, so a 5V light there is still reported as continuing.

**Simplifications**
- The light follows the pin with no filament warm-up.
- The LED is non-polar here, exactly as the Snapino studio always treated it.

**Authoritative state.** The room's episode state (`src/episodes/rescue-state.ts`, version 2) changes only through a validated reducer applied by the room server (`cloudflare/room-core.js`, shared by the Durable Object and the local relay).

**Revisions** only grow, and a reset continues them. Connected clients drop only *older* revisions (`supersedes()`), so a reset reaches everyone at once while late duplicates are still dropped.

**Transmission ids.** Every transmission gets a `tx`: the revision that started it. A tx is never reused, not by a retransmission and not after a reset, although round numbers restart at 1. Stop, read, explain, close and "transmit again" all name the tx they were made for, and an action for any other transmission is refused as stale.
- A reading of a replaced transmission, for example one delayed until after a retransmission ended, is refused.
- The receiver's draft is discarded when the tx changes.
- Stored v1 states, which used round numbers as the identity, are not loaded; the room starts a fresh state.

The state holds:
- roles, the mission and the sender's intended words;
- the current round: intent fixed at its first transmission, the transmitted program, a **server-side snapshot of the Snapino parts**, `startedAt` (server time), duration and stop;
- the receiver's **first** reading (never changeable);
- the team explanation and the round history.

**Derived, never stored.** Outcome, diagnosis, completion and traces are derived from that state by pure functions. Every client derives the same result, and there is no cosmetic success.

**Timing and synchronization**
- **Shared clock.** No client runs its own timer for the signal. Each client renders the transmission from `room server time − startedAt`. Clients estimate the room clock from **round-trip clock samples**:
  - the client sends a `clock` ping on connect, then every 20 s;
  - the room echoes it with its own time;
  - the offset is `serverNow − (sent + received) / 2`, with an error of at most half the round trip;
  - the smallest round trip wins;
  - a page busy with slow frames answers late, so while the estimate's round trip is over 500 ms the client resamples every 2 s;
  - a minute-old estimate may be refreshed against drift, but only by a sample of comparable quality (at most twice its round trip, or 500 ms). A slow sample never replaces a good estimate (`src/desktop/room-clock.ts`);
  - before the first sample, the `serverNow` stamp on room messages is used.
- **Late joiners and reconnects** land at the right moment, with nothing sent per frame. The two-browser test requires two pages' room-clock estimates on the same machine to agree within 250 ms.
- **Hidden tabs** jump to the correct point when shown again. The receiver is told that part of the signal was not watched, and should use Replay before reading.
- **The transmitter is fixed while transmitting.** Any accepted change to a Snapino part or to the program ends the transmission at that moment: a teammate's edit, an import (including importing the *identical* running program, which sends an authoritative stop), or Run/Stop. The recorded snapshot therefore always matches the light everyone saw.
- **Stopping.** Anyone in the room may stop a transmission.
- **Leaving** frees the leaver's roles. When everyone leaves, a running transmission ends, rounds and design stay, and roles clear.

**Other behavior**
- **Replay** is local and drawn in the panel (a lamp and a playhead on the recorded light strip), never on the bench, so it can't be mistaken for a new transmission.
- **Solo.** With nobody else in the room, the sender can transmit and see a *solo check*: what a receiver following the protocol would read, plus the diagnosis. A real reading needs a second person; Bolt is not involved.
- **Pedagogical separation.** The receiver's normal panel does not show the intended words before the first reading. The data is in every client's room state, so this is not client-side secrecy.
- **Rules that protect the first reading** (enforced by the room's reducer, not only the panel):
  - Only the sender sets the design. With no sender, nobody does: a receiver cannot choose the message they will read.
  - A round records who transmitted it (`sentBy`). While it is unread, none of them can take the receiver role or record its reading, and roles cannot be swapped.
  - The round list shows an unread (abandoned) round's message only to whoever transmitted it, since the same message may be sent again.
  - Exports and autosaves carry the design only when made by the sender.
  - An import never opens the workshop as a side effect. Its design is applied only into an open workshop, by the sender.
- **Stale views.** "Transmit" names the round it repeats (or none), so a click from an outdated view cannot open a new round. Reset needs a role (anyone, once nobody holds one) and is refused during a transmission.

### PF and DI

**Both conditions: the protocol, as task rules**
- Both conditions see the vocabulary (words → flash patterns) **and its timing bands**: short, long, gap within a word, and pause between words.
- The decoder judges every team against these fixed bands, so they are rules of the task, not hints. Hiding them in PF while telling learners to "choose their own timings" was a contradiction, and the parent review flagged it.
- Choosing timings that fall inside the bands, and building and coding the transmitter, remain the learners' work in both conditions.

**DI only: solution guidance**
- A worked example of timings that work (300/900/300/1500 ms).
- The "Write blocks for this message" helper.

**Unchanged**
- No hints are added, adaptive or otherwise, and Bolt is not involved.
- Other studios' PF/DI behavior is unchanged.

**Diagnoses**
- In both conditions, diagnoses appear only after the receiver has committed a first reading, or to a lone sender in the *solo check*.
- They are factual measurements against the circuit and the protocol: wiring, pins, flash and gap lengths, cut-offs and what the light said. They are not suggestions.

**Live diagram (Bench inspector)**
- In both conditions it draws every connection exactly as built.
- Its wiring-fault notes (bypassed, no GND path, pin on GND, and so on) follow the same timing as the diagnoses:
  - **DI:** shown at once.
  - **PF:** withheld until the team's first compared round: a reading given, a lone sender's solo check, or a round closed. The reason is shown in their place.

### Outcomes

| Outcome | Meaning |
|---|---|
| Message delivered | The light was clear under the protocol, said exactly the intended words, and was read as sent. |
| No light reached the receiver | Open circuit, wrong pin, no lamp, a bypassed lamp, a pin short, or a 5V–GND short. |
| The signal was ambiguous | A flash or gap was outside its band, a light was still on when the transmission ended, or a group is not a word. |
| The signal said something else | Clear light whose words differ from the intention. A lucky guess on such a signal is **not** delivery. |
| Read differently | A clear, correct signal whose reading differs. |

The workshop goal is met by a delivered round that the team has also explained.

**Status shown.** The panel's header pill and stepper describe only the **current** round: design, transmitting, reading, or delivered / not delivered. An earlier delivered round is a milestone shown in the round history ("Workshop goal met in round n"). It is never shown as the status of a later round that is running, unread, ambiguous, cut off or without light. The previous version did show it that way, and the parent review saw it in four committed screenshots.

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
| `npm run test:episode` | **Domain and reducer checks** (`scripts/rescue-signal-check.mjs`):<ul><li>protocol band edges;</li><li>**every** 1-, 2- and 3-word message on every pin (774 messages, 648 of them three-word) compiles within 48 blocks, decodes to itself and is delivered;</li><li>delivered, misread, lucky-guess, open, wrong-pin, no-lamp, always-on, short, ambiguous-flash, ambiguous-gap, cut-off, left-on and follow cases;</li><li>the parent review's counterexamples: the bridged lamp on a shorted D6, and the 5V lamp that keeps shining.</li></ul>**An independent circuit oracle**, written as component potentials (not the product's union-find), checked against:<ul><li>13 hand-made topologies with stated expectations, for both the oracle and the product;</li><li>1 ms sampling of random programs on random layouts that include bridges, pin shorts, 5V wires and S1;</li><li>`lightDrivers` on 3,000 random layouts.</li></ul>Run against the old circuit code, these fail on the counterexample.<br>**Reducer rules:** roles, first reading, stale transmissions (`tx`), retransmission identity, reset (revision continues; pre-reset actions refused), round-open, swap, stop, leave, v1 states refused, and hostile actions and states.<br>**Current-phase sequence:** success and explanation, then running / unread / ambiguous / open / cut-off, never shown as "Delivered".<br>**PF/DI rendering:** bands in both conditions; the worked example and helper in DI only.<br>**Room-core checks** (`scripts/episode-sync-check.mjs`): clients that apply only newer revisions (the client's own `supersedes()`), on the real room core with a controllable clock. Covers shared elapsed time, edits ending a transmission, the atomic import, stale program revisions, swap, stale roles after reconnect, an emptied room, a delayed reading after a retransmission (refused), reset at a high revision reaching both connected clients and a late joiner, pre-reset read/explain/close refused, a late pre-reset duplicate dropped, a storage round trip, and the clock echo. |
| `npm run test:tools` | `WorkbenchTools` exact code: the design is exported, autosaved and applied after the parts edit; refusals are reported; tampered designs are refused before any edit. |
| `npm run test:project` | Project-file design validation (hostile values; Snapino only; older files). |
| `npm run test:snapino` | The raised block cap: 48 blocks accepted, 49 refused (client; the Worker's sanitizer uses the same cap). |
| `node --experimental-strip-types scripts/e2e-rescue-signal.mjs` | **Two real browser pages** (plus a late joiner in a browser process of its own) over wrangler dev (Durable Object + WebSocket), clicking the real panel; every click fails fast if its button is absent or disabled:<ul><li>the full loop; the receiver never sees the intent;</li><li>a second reading attempt is refused, and the UI offers none;</li><li>the ambiguous, open-circuit and recovery rounds, each checked to **not** show "Delivered" in the header after an earlier success;</li><li>a retransmission: the receiver's draft is discarded and a delayed reading of the replaced transmission is refused;</li><li>a 107.5 s recurring light with irregular on/off phases (2.5–5 s; a strictly periodic light aliased with a ~9 s software frame period in two runs): the sender **and** the receiver each log lit **and** dark render-driven frames of that transmission that agree with the timeline;</li><li>a steady light: **screenshot crops** of the receiver's lamp are brighter while lit than while dark;</li><li>Stop;</li><li>a socket drop during the irregular light: the role is released, the client reconnects by itself inside the running round, and its room-clock estimate is within 250 ms of the sender's. Every logged frame carries the transmission id and its capture time; the log is drained after the confirmed reconnect, and only frames of this transmission captured **after** that boundary count. They must include lit **and** dark, all agreeing with the timeline;</li><li>a teammate's edit and an identical-program import each end a transmission;</li><li>a reload; a role swap;</li><li>export: allowed keys only, and the design is exactly `{id, v, mission, intent}`;</li><li>**reset** reaches both clients at once with a higher revision, and the next transmission reaches the other client;</li><li>a **late joiner**: its page and lobby are opened **before** the irregular light starts, then it joins while the light runs. Unconditionally (no skip), it must log lit **and** dark frames of that transmission, within a bounded wait, and pass the clock check. The joiner runs in a browser process of its own: in the browser the host and member share, SwiftShader renders every page's WebGL in one GPU process, one after another, and a third page there got no room state within 300 s in two runs, longer than any transmission;</li><li>leaving: always on a fresh transmission started for it;</li><li>a phone-width **layout** check (layout only; no touch interaction).</li></ul>The drop uses a `?qa`-only hook that closes the socket; the normal reconnect path follows. The run must execute exactly 59 checks. The QA lights are slow on purpose so that seconds-per-frame software rendering can sample them; they say nothing about timing on real devices. |
| `node scripts/qa-episode.mjs` | Visual capture (solo sender, peer mode): overview, matched lamp close-ups lit/unlit, the snaps, the receiver's framing, running / working / open / recovered states, phone width, and renderer counters. See [`docs/images/episodes/rescue-signal/`](images/episodes/rescue-signal/README.md). |
| `scripts/e2e-room-sync.mjs`, `scripts/e2e-cable-end.mjs` | Existing suites, now with measured readiness and diagnostics (`scripts/lib/e2e-readiness.mjs`). The cable test now performs the undo (both screens restore the free end, nothing left to undo) and the redo, checks both makers' studios and the second drop, and keeps a trail of wire values for diagnosis. |

**Panel actions are serialized.** While one room action is in flight, every action button in the panel is disabled (and `aria-busy` is set), so a quick second click is never dropped silently or built on a not-yet-updated design. An earlier e2e run caught exactly that: the second word was added on top of a state that did not yet contain the first.

### Results of the last developer-environment run

These runs were made in a developer environment: headless Chromium with SwiftShader, wrangler dev and a local proxy, on 2 CPU cores. They are not GitHub CI; the repository's only GitHub check is GitGuardian. Every room was a random QA room, never 7K3M. Logs and diagnosis: [`docs/qa/episode1-review/`](qa/episode1-review/README.md).

| Command | App commit | Result |
|---|---|---|
| `npm test` (typecheck, circuit, agent, project, snapino, sync, tools, episode) | `13aa2aa` | All passed. Rescue signal 17,738 checks; episode sync 55; tools 36; project 270; sync 858; circuit engine 17,742. |
| `npm run build` | `13aa2aa` | OK |
| `e2e-rescue-signal.mjs` (two browsers, Worker) | `13aa2aa` | **58/58** |
| `e2e-rescue-signal.mjs` | `040df7c` | 57/58. The late joiner's clock check failed: a real defect, fixed in `13aa2aa` (see the QA README). |
| `qa-episode.mjs` (capture) | `13aa2aa` | No issues. Bulb pixels 193.2 lit vs 158.2 unlit ([renders](images/episodes/rescue-signal/README.md)). |
| `e2e-ai-teammate.mjs` (peer) | `13aa2aa` | 37/37 |
| `e2e-ai-teammate-worker.mjs` | `13aa2aa` | 10/10 |
| `e2e-worker-sync.mjs` | `13aa2aa` | 18/18 |
| `e2e-snapino-history.mjs` | `13aa2aa` | 25/25 |
| `e2e-room-sync.mjs` | `606fa07` app (alternating with base `3394e4b`) | 13/13 in 3 of 3 runs on head and 3 of 3 on base. The earlier timeout was diagnosed as SwiftShader shader-link stalls (50–120 s main-thread tasks), present on the base too; the test now waits for measured readiness. |
| `e2e-cable-end.mjs` | `606fa07` app | 12/12 in 5 of 5 fresh-room runs, including real undo and redo |

Between `606fa07` and `13aa2aa`, only the room client's clock sampling changed (`040df7c`, `13aa2aa`). The room-sync and cable suites do not use the clock.

**After the reference-quality upgrade** of the Snapino bench and Episode 1 presentation: the workshop moved into the dock, and the Bench inspector, live diagram, camera views and stud detail were added. See [`reference-benchmark.md`](reference-benchmark.md). The full suite was run again. Final app `dc51187`; `a9fefef` differs from it only in the diagram's wire-list position. Details and every non-passing run: [`docs/qa/reference-upgrade/`](qa/reference-upgrade/README.md).

| Command | App commit | Result |
|---|---|---|
| `npm test` (now with the diagram oracle, 62,861 checks) | `dc51187` | All passed |
| `e2e-bench-inspector.mjs` (two browsers, Worker; real pointer and keyboard) | `dc51187` | 29/29. The first run on `da304f1` (27/28) found a wrong "Not changed" note on a timed-out but accepted flip; fixed in `57506d3`. |
| `qa-reference.mjs` (same-camera before/after, layouts at 1440/1280/390, PF vs DI) | `dc51187` | 14/14 |
| `qa-episode.mjs` (Episode 1 captures in the new layout) | `dc51187` | No issues on the third attempt, after two test-script fixes. Bulb pixels 193.3 lit vs 158.0 unlit. |
| `e2e-rescue-signal.mjs` | `a9fefef` | 58/58 (after a test fix: Export is inside the project menu) |
| `e2e-ai-teammate.mjs`, `e2e-worker-sync.mjs`, `e2e-snapino-history.mjs`, `e2e-room-sync.mjs`, `e2e-cable-end.mjs` | `a9fefef` | 37/37, 18/18, 25/25, 13/13, 12/12 |
| `e2e-ai-teammate-worker.mjs` | `a9fefef` | 9/10 once (Bolt's "Done." line missing; cause not established), then 10/10 twice |

### Limits (honest)

- **Not a radio or optics model.** Light reaches the receiver if the lamp is lit; there is no distance, glare or brightness threshold.
- **Not an AVR.** The blocks run in the bench's block runner; the generated `.ino` is not executed.
- **Software-rendered evidence.** Frame-timing evidence comes from SwiftShader in headless Chromium; there are no real-GPU, phone or Quest measurements.
  - The Snapino base and carrier GLBs (hundreds of static meshes) are now merged per material at load. The same 1440×900 overview (`scripts/qa-3d.mjs`, shot `8-snapino-overview`) went from 1,229 to 683 draw calls with identical triangles (96,826). The PCB close-up draws 115 calls, but more triangles (45,914), because merged meshes are culled as a whole. This is still a heavy scene for a low-end phone, and no real phone was measured.
  - On a slow frame, the lamp shows the state at that frame's time: the transmission sets the bench pins in the scene's pre-render hook, so the frame that is drawn and the frame that is logged are the same. The test checks exactly that, not a frame rate.
- **Same-device tabs.** Without a server, tabs converge by Lamport order. Concurrent conflicting actions resolve to one winner, and roles are not arbitrated as strictly as on the server.
- **Desktop only.** The WebXR path does not include the episode.
- **Identity is the participant id.** The `sentBy` rule follows the room's participant id, not the person: someone who joins again under a new id is treated as a new participant.
- **The team explanation is last-writer-wins.** Either role can save it; two people saving at once keep the later text.
- **Local relay.** `npm run collab` (development) forgets a room when its last socket closes, so the episode history is not kept there. The Durable Object keeps it.
- **Clock estimate.** The error bound is half the round trip of the sample in use, so a client whose page stays busy for a long time keeps its last good estimate rather than a slow one. Before the first ping returns, the least-delayed `serverNow` stamp is used. That stamp never moves the lamp's clock back during a transmission.

---

## Acceptance contracts for the next episodes (not implemented)

Each starts only after the previous episode passes independent review.

### Presentation and workbench quality contract for Episodes 2–5

The common Snapino bench and Episode 1 were upgraded to this standard first; see [`reference-benchmark.md`](reference-benchmark.md) for the criteria, the provenance (the REA capture of the public reference was blocked) and the evidence. Every later episode must meet the same bar before review.

**1. Composition**
- The episode's 3D artifact is the largest thing on screen at 1440×900 and 1280×720:
  - Its framing preset fills at least 60% of the width the panels leave free, measured with the projected-bounds hook as in `benchRect`.
  - One side column only: the episode's panel is a tab of the dock, never a second floating column over the scene.
  - Panels collapse, and the episode keeps working with the dock closed.
- Camera presets fit the episode's own artifacts, not the Snapino bench:
  - an overview;
  - a top or plan view where the artifact has one;
  - the view a role needs (the listener's speaker, the plant bed, the sorting bins, the loaded span);
  - fit-selected.
  - Each preset has a number key, and F fits the selection.
- Phone width: no horizontal overflow; compact chrome so the 3D work area starts high on the first screen; the dock follows below by normal vertical scrolling, and is reached in the test by real scrolling, pointer and keyboard; Chat stays one tap away.

**2. Microdetail**
- Up close, every manipulable part has:
  - legible printed markings at its scale;
  - real terminals, jacks, sockets or joints with depth;
  - seated tips;
  - bevels where real parts have them.
- Selection and connection highlighting is printed-style and depth-tested. There is no additive "glow" used as decoration, and emissive light only where the physical part emits light.
- Before/after renders are taken at the same camera, with draw calls and triangles for each shot.

**3. Semantic cross-link**
- Selecting a part in 3D, in the parts rail or in the episode's diagram selects it everywhere:
  - the inspector shows it;
  - its terminals and connections are marked in 3D;
  - its node and edges are marked in the diagram.
- Inspector edits are bounded room edits through the existing submit path. A declined, stale or offline edit leaves no local change and says so, and an unsaved draft (code, patch, labels, design) is never overwritten.
- One canonical state drives simulation, render, diagram, inspector and export.

**4. A live diagram of the episode's own flow, derived from the actual state.**
It is never a static illustration, and wrong builds stay visibly wrong. Each episode's graph:

| Episode | Graph | Drawn from |
|---|---|---|
| 2 · Sound Flow Studio | Signal-flow graph of the patched modules (source → processing → output). It shows open outputs, feedback loops and unpatched inputs as patched. | The same patch state that builds the Web Audio graph |
| 3 · Greenhouse | Resource-flow graph of water and power: tank → pump → hoses → beds; supply → fan or pump. Flows are labelled in L/min and W, and invalid hoses are drawn and marked. | The water-balance and climate model's state at the current model time |
| 4 · Smart Sorting Center | Data-flow graph: collected → labelled → training or held-out → model → predictions, with a confusion matrix from the actual held-out predictions. | The versioned dataset and model, never the label key |
| 5 · Structural Test Yard | Member and joint diagram with supports, loads and member forces (tension or compression, with units), plus explicit mechanism or singular markers. | The solver's own result |

- PF/DI: the diagram always shows the structure. Explanatory fault notes follow the episode's PF/DI rule.

**5. Depth**
- Each part has an Overview, Ports/Pinout and Behaviour & limits. Limits state real-world ratings with units, and where the model simplifies.
- Keyboard: every diagram node and edge and every inspector control is reachable with Tab and operable with Enter/Space; tab lists use the arrow keys.
- Targets are at least 44 px.
- Text alternatives: a connection list for the diagram.
- No fake compiler or upload badges, no fake training animations, no XP or points.

**6. Validation for review**
- An oracle for the diagram derivation, independent of the product's graph code, run on curated and random states.
- Two-client browser tests with real pointer and keyboard input covering:
  - selection cross-link;
  - accepted, declined and stale inspector edits;
  - draft preservation;
  - presets.
- Render comparisons and layout checks at 1440, 1280 and 390 px.
- The full regression suite on the final SHA.

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
