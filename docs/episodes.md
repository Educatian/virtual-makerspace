# Makerspace episodes

Five learning episodes built on the shared 3D workbench, delivered **one complete vertical
episode at a time**. Each episode is reviewed before the next one starts.

| # | Episode | Studio | Status |
|---|---|---|---|
| 1 | Rescue Signal Workshop | Snapino Bridge | Accepted at the parent gate (PR head `a0aaaec`, app `6cd66df`). Merged into the `desktop` release branch with PRs #2–#4 (`db85d85`); production deployment and live checks are recorded outside this document. |
| 2 | Sound Flow Studio | Sound Flow Studio (new) | **Implemented on `feat/sound-flow-studio`** (PR #5 against `desktop`, final app `63a3421`). Review findings fixed; awaiting the final gate. Not merged or deployed. |
| 3 | Resource-Limited Greenhouse | Greenhouse | **In progress on `feat/resource-limited-greenhouse`**. The model and criteria below are fixed before the code. |
| 4 | Smart Sorting Center | new | Planned. The acceptance contract is below; not started. |
| 5 | Structural Test Yard | new | Planned. The acceptance contract is below; not started. |

Episodes 4–5 are not in the app. There are no placeholder buttons, rooms or stubs for them.

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
| `node --experimental-strip-types scripts/e2e-rescue-signal.mjs` | **Two real browsers** (separate browser processes; a third for the late joiner) over wrangler dev (Durable Object + WebSocket), clicking the real panel; every click fails fast if its button is absent or disabled:<ul><li>the full loop; the receiver never sees the intent;</li><li>a second reading attempt is refused, and the UI offers none;</li><li>the ambiguous, open-circuit and recovery rounds, each checked to **not** show "Delivered" in the header after an earlier success;</li><li>a retransmission: the receiver's draft is discarded and a delayed reading of the replaced transmission is refused;</li><li>a 107.5 s recurring light with irregular on/off phases (2.5–5 s; a strictly periodic light aliased with a ~9 s software frame period in two runs): the sender **and** the receiver each log lit **and** dark render-driven frames of that transmission that agree with the timeline;</li><li>a steady light: **screenshot crops** of the receiver's lamp are brighter while lit than while dark;</li><li>Stop;</li><li>a socket drop during the irregular light: the role is released, the client reconnects by itself inside the running round, and its room-clock estimate is within 250 ms of the sender's. Every logged frame carries the transmission id and its capture time; the log is drained after the confirmed reconnect, and only frames of this transmission captured **after** that boundary count. They must include lit **and** dark, all agreeing with the timeline;</li><li>a teammate's edit and an identical-program import each end a transmission;</li><li>a reload; a role swap;</li><li>export: allowed keys only, and the design is exactly `{id, v, mission, intent}`;</li><li>**reset** reaches both clients at once with a higher revision, and the next transmission reaches the other client;</li><li>a **late joiner**: its page and lobby are opened **before** the irregular light starts, then it joins while the light runs. Unconditionally (no skip), it must log lit **and** dark frames of that transmission, within a bounded wait, and pass the clock check. Every maker runs in a browser process of its own: in one shared browser SwiftShader served two pages a frame every 6 s and every 26 s, and a third page got no room state within 300 s (two runs), longer than any transmission;</li><li>leaving: always on a fresh transmission started for it;</li><li>a phone-width **layout** check (layout only; no touch interaction).</li></ul>The drop uses a `?qa`-only hook that closes the socket; the normal reconnect path follows. Where only one page's frames are checked (the open circuit, the frames after the reconnect, the pixel crops, the late joiner), and while clocks are sampled, the pages not under test stop drawing through a `?qa`-only hook; their room traffic and clocks keep running, and both pages draw wherever both are checked. Before the first transmission each page lights its lamp once locally and settles (a shader warm-up: SwiftShader's first link of the lit lamp froze a page for 120 s inside an 18 s round). The two makers' pages are 800×544 (a probe on this machine measured about twice the frames of 1000×680). Clock estimates are compared (within 250 ms) while the pages are not drawing: here a frame blocks a page's main thread for seconds, so a page drawing without pause never gets a short round trip. The run must execute exactly 59 checks. The QA lights are slow on purpose so that seconds-per-frame software rendering can sample them; they say nothing about timing on real devices. |
| `node scripts/qa-episode.mjs` | Visual capture (solo sender, peer mode): overview, matched lamp close-ups lit/unlit, the snaps, the receiver's framing, running / working / open / recovered states, phone width, and renderer counters. See [`docs/images/episodes/rescue-signal/`](images/episodes/rescue-signal/README.md). |
| `scripts/e2e-room-sync.mjs`, `scripts/e2e-cable-end.mjs` | Existing suites, now with measured readiness and diagnostics (`scripts/lib/e2e-readiness.mjs`). The cable test now performs the undo (both screens restore the free end, nothing left to undo) and the redo, checks both makers' studios and the second drop, and keeps a trail of wire values for diagnosis. |

**Panel actions are serialized.** While one room action is in flight, every action button in the panel is disabled (and `aria-busy` is set), so a quick second click is never dropped silently or built on a not-yet-updated design. An earlier e2e run caught exactly that: the second word was added on top of a state that did not yet contain the first.

### Results of the last developer-environment run

**Current: final app `6cd66df`.** It fixes Bolt's false completion from a stale host board and the flow view's small-current note. For it, `npm test` passed (with two new exact-code checks), along with `e2e-ai-teammate-worker` 10/10 twice and the peer test; see [the follow-up](qa/reference-upgrade/README.md#current-the-follow-up-to-the-re-review-of-ad5cac6). The browser suites below ran on `10ed709`, whose code they cover is unchanged. Every attempt is listed in [the re-review part](qa/reference-upgrade/README.md#the-re-review-of-563c645-current-for-the-code-it-covers).

| Command | App / tests | Result |
|---|---|---|
| `npm test` (typecheck, circuit 17,742, agent, project 270, snapino, sync 858, tools 36, rescue signal 17,751, episode sync 55, diagram 66,886) | `10ed709` | All passed |
| `npm run build` | `10ed709` | OK |
| `e2e-rescue-signal.mjs` (two makers plus a late joiner, Worker) | `10ed709` / `27eea0c` | **60/60**, attempt 12 of 12; every attempt and change is listed in the QA README |
| `e2e-bench-inspector.mjs` | `10ed709` | **30/30**, attempt 3 of 3 |
| `e2e-ai-teammate-worker.mjs` | `10ed709` | 10/10 in 3 of 3 runs, after Bolt's fix (before it: 9, 8, 9 of 10; the build log recorded the mechanism) |
| `e2e-ai-teammate.mjs` (peer) | `10ed709` | 37/37 |
| `e2e-worker-sync.mjs`, `e2e-room-sync.mjs`, `e2e-cable-end.mjs` | `10ed709` | 18/18, 13/13, 12/12 |
| `e2e-snapino-history.mjs` | `10ed709` / `f266066` | 25/25 on attempt 2 (attempt 1: 24/25 without detail, cause unknown; a late view is plausible, not proven) |
| `qa-reference.mjs after` (layouts, phone scroll/pointer/keyboard, Circuit Bench meter and flow, PF/DI) | `10ed709` | 33/33 (same-camera shots left out after a 900 s readiness stall; their counters from a killed first attempt equal the earlier after-build) |
| `qa-episode.mjs` (captures) | `10ed709` | 12 of 13 renewed; the running shot `e06` missed its 110 s flash in both attempts, so the earlier capture is kept and marked |

**Historical.** The two tables below are earlier runs, kept as reported then.

These runs were made in a developer environment: headless Chromium with SwiftShader, wrangler dev and a local proxy, on 2 CPU cores. They are not GitHub CI; the repository's only GitHub check is GitGuardian. Every test room was a random QA room. **Correction:** the AI-worker test's refusal probe in those runs connected to the code 7K3M on the *local* wrangler Worker (its precreated dev room), not to production; it now uses a fresh random room (`c418a85`). Logs and diagnosis: [`docs/qa/episode1-review/`](qa/episode1-review/README.md).

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

## Episode 2 · Sound Flow Studio

### Goal and model criteria (fixed before the code was written)

**Story.** A team must patch a warning tone for a shared monitor speaker. They patch real cables between the jacks of four fixed modules on a desktop patch case, turn the knobs, listen (or watch the signal), explain what they hear and revise.

**The bounded goal: brief "Dark alarm tone".** It is met when one Test of the shared patch satisfies all five criteria. They are task rules, visible in both conditions:

| # | Criterion | Measured on |
|---|---|---|
| C1 | **Path.** Source OUT → Filter and Drive (either order, each OUT → IN) → Speaker IN. No loose cable end, no OUT→OUT or IN→IN cable, no loop. The Speaker is switched on. | The patch graph |
| C2 | **Tone.** The Source plays a sawtooth at 220 Hz. | The Source's knobs |
| C3 | **Dark.** At the Speaker input, the 660 Hz (3rd) harmonic is at least 18 dB below the 220 Hz fundamental. A raw sawtooth has it 9.5 dB below, so the filter must take about 8.5 dB more off 660 Hz than off 220 Hz. | The modelled signal at the Speaker input |
| C4 | **Clean.** Nothing clips: the signal entering the Drive, times its gain, stays within ±1.0 FS. | The modelled signal at the Drive |
| C5 | **Level.** The Speaker input peaks between −12 and −3 dBFS. | The modelled signal at the Speaker input |

The brief has many solutions (by the model, any cutoff from about 105 Hz to 410 Hz with a matching Drive gain), and many tempting failures: no filter (bright), Drive ×4 (clipped), a very low cutoff (too quiet even at ×4), filter and drive swapped with too much gain (clipped before the filter), the speaker switched off (silent at the output, but not a broken patch).

**The learning loop.**
1. **Predict / design.** Each learner records a prediction for the current attempt (meets the brief, too bright, clipped, too quiet or too loud, silent) and why. Predictions are local drafts, never shared or exported.
2. **Build.** Patch cables and turn knobs. Every change is a room edit.
3. **Test / listen / inspect.** *Test patch* evaluates the room's current patch with the model and shows the five criteria with their measured values next to the prediction. Listening is optional and needs a click to start audio; the signal is always shown without audio.
4. **Explain.** The learner writes what they heard or saw and why. The goal counts as met only for a passing test that has an explanation.
5. **Revise.** A new attempt keeps the history of earlier attempts.

No points, XP, timers or fake measurements.

**PF / DI.**
- Both conditions: the brief and its five criteria, the module ratings and safety limits, the signal display, and the measured criterion values after each Test.
- DI only: a worked example with its numbers (computed by the same model at runtime) and, after a Test, an explanation for each failed criterion.
- PF: no solution, hint or auto-patch. Measurements appear only after a Test. The diagram always draws the patch as built, including wrong cables and loops; its explanatory fault notes appear in PF only after the learner's own first Test in this browser session (a personal gate: a teammate's Test does not unlock it; DI: at once). Safety notes (a loop is silenced, the output is capped) are shown in both conditions at all times.
- Bolt keeps to the Circuit Bench; its domain is not extended.

**Model (an educational signal abstraction, not SPICE and not an acoustic room model).**

| Module | Jacks | Model |
|---|---|---|
| Source | OUT | Band-limited Web Audio oscillator (sine, square or sawtooth), 55–1760 Hz in 1 Hz steps, ×0.5. A sine peaks at exactly 0.5 FS (−6.02 dBFS). Web Audio scales square and sawtooth so that their full-band waveform peaks at 1.0 (coefficients ÷ (2/π)·Si(π) ≈ 1.179, measured in Chromium), so their band-limited versions peak a little lower: about 0.49 FS for a 220 Hz sawtooth, 0.46 FS at 1760 Hz. |
| Filter | IN, OUT | 2nd-order Butterworth low-pass (12 dB/octave, Q = 1/√2, no resonance knob), cutoff 80–8000 Hz. Web Audio `BiquadFilterNode` (its low-pass Q is in dB: −3.01 dB). The criteria use the analog prototype \|H\| = 1/√(1 + (f/fc)⁴); the offline tests bound the digital filter's difference. |
| Drive | IN, OUT | Linear gain ×0–×4 (0.01 steps), then an ideal hard clip at ±1.0 FS (`WaveShaperNode`, identity curve). The distortion is real time-domain clipping of the actual signal. Real overdrive clips more softly. |
| Speaker | IN | Shared power switch. Then a hard clip at ±1.0 FS and a fixed ×0.25 (−12.04 dBFS) safety ceiling, then **local** volume (0–100 %, default 50 %) and **local** mute. The digital output never exceeds 0.25 FS. What a person hears depends on their device; loudness (SPL, dBA) is not measured or modelled. |
| Patch cable | two plugs | Ideal and lossless. Signal flows OUT → IN. One plug per jack (a server rule). |

**Wrong builds are drawn as built, never repaired.**
- OUT→OUT and IN→IN cables carry nothing and are marked invalid.
- A loose cable end carries nothing.
- An unpatched input makes its module silent.
- **Feedback is unsupported, all of it:** any loop of modules, including a module's OUT patched to its own IN. Web Audio can only loop through a delay, and this studio does not model delay, resonance or oscillation. A loop is silenced (its modules are not connected), marked in the diagram, and said so; no stable audio is invented.
- Two plugs in one jack cannot be stored (the server refuses it); if one ever arrived (a same-device peer race), the model ignores both and says so.
- A switched-off Speaker or a muted listener is reported as such, not as a broken patch.

**One authoritative state.** The room's versioned part state (cable jacks, knob values, the Speaker switch) drives the 3D desk, the Web Audio graph, the diagram, the inspector, the signal display, the Test outcome and project files. Audio samples are never synced: each client builds its own Web Audio graph from the same patch. No sample-accurate or synchronized playback across clients is claimed.

**Audio safety (local, per listener).**
- Audio starts only from an explicit click or key press on *Start audio*; it is never started by a teammate's edit, an import, a reconnect or a page load.
- Mute applies at once (a 10 ms ramp, to avoid a click). Volume is bounded as above.
- Leaving the room, switching studios or losing the connection stops audio and closes the AudioContext (nodes, oscillators and listeners are released). Restarting needs a new click.
- A suspended AudioContext is resumed only from a click.
- The signal display is computed from the same graph: an `OfflineAudioContext` renders the patch (no gesture needed, no sound output). With audio on, a live analyser also shows what this client is playing. Offline numbers say nothing about any physical speaker.

### On screen

- **The desk** fills the space between the parts rail and the dock: a walnut-cheeked desktop case with four brushed-aluminium (Speaker: graphite) modules, knurled skirted knobs with printed scales, recessed jacks (hex nut, bushing, a bore drilled through the panel), IN/OUT labels (outputs inverted, as on modular synths), signal LEDs (the Drive's CLIP LED), the Speaker's grille, cone and power toggle, and three patch cables (red, yellow, blue) on a felt mat. A plug seats with its sleeve inside the jack's bore; a released plug lies on the panel or the table; a carried plug hangs under the pointer.
- **Camera views:** Overview `1`, Plan `2`, Speaker (the listener's view) `3`, Fit selected `F`, as buttons and keys.
- **One dock, two contextual tabs** (the rest stay: Chat, Voice, Activity, Notes):
  - **Studio:** the brief and its five criteria; the DI worked example; *Listen (this device only)* with Start/Stop, Mute and your volume; the signal display; the attempt loop (predict, build, test, explain, revise) with earlier attempts.
  - **Inspector:** the live signal-flow diagram with its legend, fault notes and the text connection list; the selected module or cable with Overview, Ports and Behaviour & limits tabs (arrow keys move between tabs).
- **Toolbar:** a speaker button starts audio (a click) or mutes/unmutes this device.
- **Cross-link:** selecting a module or cable in 3D, in the parts rail or on the diagram (click or Enter) selects it everywhere: the inspector shows it, its jacks get printed rings in 3D (amber solid: its own; cyan dashed: the far end of its cables; red double: a wrong cable's jacks), and the diagram marks its node, ports and edges. Clicking a knob or the Speaker's switch in 3D focuses that control in the inspector.
- **Edits:** the inspector's fields are drafts until *Apply to the room* (or Enter). A refused, stale or unconfirmed edit changes nothing and says so; the typed draft stays. The Speaker's switch is one shared edit. *Unplug and return to the mat* returns a cable.
- **Signal display (the non-audio indication):** one or two cycles of what reaches the Speaker input, rendered by Web Audio in an `OfflineAudioContext` from the same graph a listener hears; the ±1.0 FS rails; peak and RMS in dBFS; clipping; the Speaker switch; the first six harmonics in dB relative to the strongest. With audio on, a live line reads this device's analysers (Speaker input and output, or "muted").

### Collaboration, files and persistence

- **Room authority.** Plugging and unplugging are cable-end moves with claims; knob values and the Speaker's switch are atomic edits with the revision the sender saw. The server refuses moved or rotated modules, out-of-range or missing knob values (never clamped), jack indices outside 0–5, both ends in one jack and a second plug in a jack (`occupied`, for live moves and for edits, judged on the whole batch). An edit the server's validation refuses is answered (`invalid`) by the Worker and the local relay, instead of being dropped. Wrong patches a learner makes on purpose (OUT→OUT, IN→IN, loops) are allowed and diagnosed. A cable-end move changes only the end its sender holds: the room keeps its own other end whatever the message says about it (a cable the room has never stored counts as unplugged, as every client starts it on the mat), and a move that would leave both plugs of one cable in one jack (two people each moving one end there) is refused (`occupied`) before anything is stored. An end move must carry both end positions, or it is refused (a payload without them could not be applied end-only by the other clients).
- **Late join and reconnect** receive the room's state like any other studio. Audio is never part of it.
- **Undo/Redo** covers knob edits, the switch, moves of cable ends, imports, reset and returns to the mat, with the existing stale/held rules.
- **Project files.** Sound projects are **version 2**: knob values, the Speaker's switch and each cable's jacks (a half-plugged cable is saved unplugged). Fixture modules never carry sockets. The original four studios still write and read version 1; a version-1 file naming the sound studio, or a version-2 file naming another studio, is refused. Predictions, explanations, attempts, names and chat are never exported.
- **Autosave and recovery** follow the existing rules (a desk at its defaults, Speaker on, is "empty").
- **Local only:** audio start/stop, mute, volume, predictions, explanations and attempts (sessionStorage). The room's activity record gets one `test` trace per Test (attempt number and criterion codes, no words) and one `reflect` trace per saved explanation (no text).

### Tests (developer environment)

| Command | What it checks |
|---|---|
| `npm run test:sound` (in `npm test`) | `scripts/sound-model-check.mjs`:<ul><li>**review findings on PR #5, through the real sanitizer and RoomCore:** opposite end holders moving their ends into the same jack before seeing each other's move (both orders; refused `occupied`, nothing relayed or stored, the late joiner's state valid, the next move to a free jack accepted); an end move without endpoints (refused by the sanitizer) or naming another socket for the other end (only the claimed end changes, also in RoomCore alone, and also for a cable the room has never stored, fresh or after everyone left); a batch with both plugs of one cable in one jack (refused whole); 400 random runs of 12 moves (half from a never-stored cable) by two end holders and a whole-cable mover never leave two plugs in one jack;</li><li>**the patch graph against an independent oracle** written in the test (adjacency matrix and Warshall closure, not the product's Tarjan and propagation) on **every** patch of the three cables (43³ = 79,507, two-plug jacks included): live modules, cable statuses, faults, loops, chain;</li><li>13 curated patches with stated expectations, for both the product and the oracle;</li><li>the diagram's edges and nodes and the connection list against the oracle on every 25th patch (3,180);</li><li>the signal model against analytic references: a sine through the Butterworth magnitude, a sine driven past ±1.0 FS (clipped fraction 1 − (2/π)·asin(1/a), the clipped fundamental by dense integration), band-limited sawtooth harmonics with the Gibbs scaling (Si(π) integrated in the test), the Speaker's ceiling and switch, silence for open and looped patches;</li><li>the brief on 13 curated builds (each criterion's verdict stated) and the cutoff range in which it can be met;</li><li>the server rules: value bounds and rounding, moved or rotated modules, switches, jacks 0–5, both ends in one jack, out-of-range edits refused whole; RoomCore refusing a second plug in a jack for edits (judged on the batch) and live moves, keeping the other end on an end move, and stale knob edits;</li><li>project files: version 2 round trip, nine hostile files refused, older version-1 files still accepted, other studios still writing version 1, recovery emptiness.</li></ul> |
| `npm run test:sound` (second part) | `scripts/sound-engine-check.mjs`, the live engine's lifecycle with a fake AudioContext that starts suspended and whose resume settles when the test says: a disconnect or studio exit while a click's resume is pending closes that context through the panel's own exit helper, and the late resume never runs audio (the previous exit guard, as a negative control, lets it run); a stale start's late failure or success never touches a newer running start (each outcome on its own fresh promise); an accepted inspector edit clears only the drafts it carried; only definite refusals (held, stale, invalid, occupied, offline) say "nothing changed", while a timeout, a closed connection or any unconfirmed result says the value appears if the room accepted it; and an edit the room accepted whose answer was lost to a disconnect (the room's canonical state has the new value) is reported as uncertain, with the draft kept. Lifecycle and copy only, no audio. |
| `npm run test:sound:dsp` | `scripts/sound-dsp-check.mjs`, the actual Web Audio graph in headless Chromium: an `OfflineAudioContext` render measured against independent references — frequency (zero crossings), the fundamental of each waveform (0.5·b₁, divided by (2/π)·Si(π) for square and sawtooth), gain transfer, the low-pass against the RBJ biquad formula written in the test (Q in dB), the digital filter against the analog prototype, exact silence for open, looped and OUT→OUT patches, the Speaker switch, real clipping (2/3 of each cycle at 2 FS), the model's numbers against the rendered buffers, and the 0.25 FS ceiling on 24 random builds. Then the live engine on the page: no AudioContext from `apply()`; `start()` without user activation refused and creating nothing; a trusted click creating and running one context; live analysers; the volume cap; mute to exactly 0 within 80 ms while the Speaker input still carries the tone; a patch change while muted; `stop()` closing the context and stopping every oscillator it started; no restart afterwards; with `resume()` held: a disconnect or studio exit during a click's pending resume closes that context, and a stale start's late failure leaves a newer running start alone. In Chromium a context created inside the click usually reports "running" by itself, so this run has no negative control for the status-"off" case; that case (and the previous guard failing it) is in `sound-engine-check.mjs`. **What it proves:** the digital signal Web Audio computes. Nothing was heard through a physical speaker; no loudness was measured. |
| `node --experimental-strip-types scripts/e2e-sound-worker.mjs` | Two real browsers (separate processes) and a late joiner over wrangler dev (Durable Object + WebSocket), with real pointer and keyboard input; see the list at the top of the script. Every check records its time, the acting maker and the room revisions each client held. |
| `node scripts/qa-sound.mjs` | Render evidence (peer mode): see [`docs/images/episodes/sound-flow/`](images/episodes/sound-flow/README.md). |

### Results of the last developer-environment run

**Final app `63a3421`.** The run used headless Chromium with SwiftShader, wrangler dev and the local access proxy, on 2 CPU cores. It is not GitHub CI. Every room was a fresh random QA room; 7K3M was never used. Every command, its exit code, its duration and every non-passing attempt are in [the test records](qa/sound-flow/README.md), per app (`app-63a3421/`, `app-ad7fd3c/`, `app-1eaf1dd/`).

| Command | App | Result |
|---|---|---|
| `npm test` (typecheck, circuit 17,742, project 270, sync 858, tools 36, rescue signal 17,751, episode sync 55, diagram 66,886, **sound model 89,528**, **sound engine 47**) | `63a3421` | All passed |
| `npx vite build` | `63a3421` | OK |
| `npm run test:sound:dsp` | `63a3421` | **101/101** |
| `e2e-sound-worker.mjs` (two makers plus a late joiner, Worker) | `63a3421` | **29/29** (also 29/29 on `ad7fd3c` and on `1eaf1dd`) |
| `e2e-worker-sync`, `e2e-cable-end`, `e2e-room-sync`, `e2e-snapino-history` | `63a3421` | 18/18, 12/12, 13/13, 25/25 |
| `e2e-ai-teammate-worker` | `63a3421` | 10/10 |
| `e2e-bench-inspector` | `63a3421` | **30/30** on attempt 2. Attempt 1 was killed by the harness's own 45-minute limit after 25 checks; that is a partial prefix, not a pass. |
| `e2e-rescue-signal` (Episode 1) | `63a3421` | **60/60**, one bounded attempt |
| `qa-sound.mjs` (renders) | `63a3421` | **7/7**, no issues: desk fill 0.865 at 1440 and 0.857 at 1280; phone Test reached by keyboard (44 px); PF without the worked example ([renders](images/episodes/sound-flow/README.md)) |
| `e2e-ai-teammate` (peer) | `63a3421` | 37/37 |

**On `1eaf1dd`, two runs did not pass:**
- `e2e-snapino-history` attempt 1: an import's confirmation dialog did not open within 30 s; attempt 2 passed 25/25.
- `e2e-bench-inspector`: one attempt was stopped by a task limit, and one stalled 300 s after the field-test click.

Their causes were not established. They are listed with their logs, not counted as passes.

### Limits (honest)

- **An educational signal abstraction.** Periodic, band-limited waveforms through an analog-prototype Butterworth low-pass and an ideal hard clipper. Not SPICE, not circuit-level electronics, not an acoustic or room model. Levels are digital full scale (FS, dBFS), not volts; no loudness (SPL/dBA) is measured or modelled.
- **The model and the live graph differ slightly**, measured: the digital biquad within 0.011 dB of the analog prototype up to 1 kHz (0.08 dB across the tested range); Chromium's band-limited square/sawtooth have fewer harmonics than the model's Nyquist rule, so their peaks differ by up to about 0.1 dB at 220 Hz; after clipping the model removes harmonics above Nyquist while Web Audio's clipper aliases (clipping fails C4 anyway).
- **Feedback is not simulated**: every loop is silenced, as stated in the studio.
- **No synchronized playback.** Each listener's Web Audio graph is built locally from the shared patch; timing across clients is not aligned or claimed.
- **Nothing was heard through a physical speaker** in the tests: offline buffers and live analysers measure the digital signal only. Headless Chromium has no audio device that anyone listened to.
- **Same-device peer rooms** (no server) do not get the server's one-plug-per-jack refusal; the client still refuses an occupied jack, and the model ignores two plugs in one jack if a race ever produces them.
- **The PF notes gate is personal**: it opens on this learner's own first Test in this browser session, not on a teammate's.
- **Predictions, explanations and attempts are per learner and per tab session** (sessionStorage): they are not shared, synced or exported, so a teammate sees only the `test`/`reflect` activity traces.
- **Desktop only.** The WebXR path does not include the studio.
- **Software-rendered evidence.** Captures and frame counters come from SwiftShader in headless Chromium; no GPU, phone or Quest was measured.

## Episode 3 · Resource-Limited Greenhouse

### Goal and model (fixed before the code was written)

**Story.** A school greenhouse must get through one hot, dry day on the water already in its tank. Two raised beds need different amounts of water, the solar panel cannot run the pump and the vent fan at full power together, and clouds pass over. The team plumbs and wires the existing rig, sets the controller and valves, predicts, runs the day, inspects what happened, explains it and revises.

**The bounded goal: brief "Dry-spell day".** One complete run of the brief's day (scenario seed **11**, 06:00 to 06:00) meets all five criteria. They are task rules, visible in both conditions:

| # | Criterion | Measured on |
|---|---|---|
| G1 | **Plumbed and wired.** Water can reach both beds through the pump (tank → pump → bed A and bed B), the pump and fan are powered from the controller's channels, the solar panel feeds the controller, and the soil probe is in a bed. | The build |
| G2 | **Bed A.** Dry (θ < 30 %) or waterlogged (θ > 90 %) for at most 2 h of the day. | The run's record |
| G3 | **Bed B.** The same. | The run's record |
| G4 | **Air.** Greenhouse air above 35 °C for at most 1 h. | The run's record |
| G5 | **Reserve.** At least 8 L left in the tank at the end. | The run's record |

In the model, the brief cannot be met by plugging everything in at the default settings: the default allocation leaves bed B dry for about 9 h on the brief's day. A coarse search found successful strategies (for example valve A 30 %, valve B 50 %, pump below 60 %, fan above 26 °C). The success region is narrow: about 1.3 % of a 5 % / 5-point grid of valve, threshold, priority and probe choices.

These are the genuine tradeoffs:
- **Water:** the tank cannot keep both beds wet all day. Bed B transpires half as much again as bed A, and over-watering is lost to drainage.
- **Power:** the solar panel's 18 W peak is less than the 20 W the pump and fan draw together, and the 12 Wh battery covers the gap only briefly. The controller's channel 1 is served first.
- **Climate:** the fan is the only cooling, and the heat peaks when the pump is busiest.
- **Sensing:** there is one soil probe. The bed it sits in decides when the pump runs; the other bed is watered blind.

**The learning loop** (the same structure as Episode 2):
1. **Predict / design.** A private prediction per attempt: meets the brief, a bed dries out, a bed gets waterlogged, overheating, or the tank runs low. The learner adds why.
2. **Build / allocate.** Hoses, power cables, the soil probe, the valves, the controller thresholds. Every change is a room edit, and edits are refused while the day is running.
3. **Run / test / inspect.** Start, pause, step one hour, resume, speed ×1 or ×4, reset. The live resource graph, sensors and inspector show the current model time. The verdict and the measured values appear when the day ends.
4. **Explain.** What happened and why. The goal counts as met only for a passing run that has an explanation.
5. **Revise.** A new attempt resets the day (the tank refills only by an explicit reset, which starts a new run) and keeps the history of earlier attempts.

There are no points, XP or countdowns. The model clock is a time control, not a challenge timer.

**PF / DI.**
- **Both conditions:** the brief and criteria, the part ratings and safety limits, the live graph and sensors, and the measured values after each finished run.
- **DI only:** a worked example (one strategy that meets the brief, checked by the model's own test) and, after a run, a reason for each failed criterion.
- **PF:**
  - no solution, hint or auto-build;
  - explanatory fault notes on the diagram appear after the learner's own first finished run in this browser session (a personal gate);
  - safety notes (invalid hose carries nothing, no unregulated power) appear in both conditions.
- **Bolt** keeps to the Circuit Bench.

**Model (a teaching water-balance and climate abstraction; not a validated botanical, crop or weather prediction).**

| Quantity | Model |
|---|---|
| Time | 96 steps of 15 min (dt = 0.25 h), 06:00 → 06:00. Sensors are read at the start of a step; the controller decides the step's loads from those readings. |
| Weather (seeded) | Outside air T_out = T_min + (T_max − T_min)·(0.5 − 0.5·cos(2π(h − 4)/24)), peaking at 16:00. Sun S = sin(π(h − 6)/14) from 06:00 to 20:00, else 0. The seed sets T_max (31–37 °C), T_min (16–20 °C) and one or two cloud spells of 1–3 h (sun × 0.35). A seeded xorshift32 generator gives the same day everywhere. |
| Greenhouse air | T_air = T_out + 4 °C·S − 7 °C if the fan ran that step (steady state per step, no thermal mass). |
| Solar panel | 18 W × S, only when its cable reaches the controller's SOLAR IN. |
| Controller | A 12 Wh battery (starts at 6 Wh). Channel 1 is served before channel 2. A load runs a whole step only if solar + battery can supply its energy; otherwise it is starved for the step. Solar surplus charges the battery; the rest is curtailed. |
| Rules | The pump runs when the probed bed's soil θ < "pump below" (10–90 %, 5 % steps). The fan runs when the last air reading > "fan above" (20–40 °C, 1 °C steps). There is no probe reading without a probe, so the pump never runs. |
| Pump | 12 W, 0.4 L/min (6 L per step) when both valves allow it. It needs a hose from TANK OUT to PUMP IN and a hose from PUMP OUT to the manifold or a bed. Without a supply or an outlet it runs dry: it uses its power and delivers 0 L. |
| Valves | Manifold outlets A and B, 0–100 % in 5 % steps. Outlet flow q_i = Q·v_i / max(1, v_A + v_B). The pump delivers Q·min(1, v_A + v_B), and less if the tank holds less. An unconnected outlet is closed. |
| Fan | 8 W, cools the air by 7 °C for the step. |
| Beds | Water store W (L) of capacity 20 L, starting at 11 L; θ = W / 20. Uptake and evaporation ET = k·(0.5 + 0.05·(T_air − 20 °C))·dt·min(1, θ/0.4), with k = 0.8 L/h (bed A) and 1.2 L/h (bed B), never more than W. Gravity drainage removes 25 % of the water above θ = 0.8 per step, and anything above 20 L overflows. |
| Tank | 40 L at the start. It falls only by what the pump delivers. It is refilled only by resetting the day, which starts a new run. |
| Plant state | Shown per bed from θ and air: wilting below 30 %, severe below 15 %, waterlogged above 90 %, heat-stressed above 35 °C, otherwise healthy. There is no growth or yield model. |

**Water and energy balance.** Every step is accounted, and the tests check it to 1e-9 L or Wh:
- **Water:** tank₀ + W_A₀ + W_B₀ = tank + W_A + W_B + ET_total + drainage_total + overflow_total. Hoses hold no water, and nothing is created.
- **Energy:** solar_in + battery₀ = loads_used + battery + curtailed.
- No quantity is ever negative.

**Wrong builds are drawn as built, never repaired.** Each of these carries zero flow or power and is marked in the 3D rig, the diagram and the inspector:
- OUT→OUT and IN→IN hoses;
- loose hose ends;
- a hose from the tank straight to a bed (no pump, and the tank sits below the beds);
- the pump fed from its own outlet (a loop);
- solar wired straight to a load (unregulated, not supported);
- a power cable in a hose port or the reverse (the room refuses it: wrong connector type);
- two plugs in one port (refused, as in Episode 2).

An empty tank, a pump without supply, starved loads, no probe, extreme soil and heat are all reachable and named.

**One authoritative state.** The room's versioned parts drive the 3D rig, the model inputs, the graph, the inspector and project files: hose and cable ports, the probe slot, the valves and the thresholds. The room's **run state** drives model time and resources:
- seed, status, speed, attempt counter;
- the anchor tick and its server time;
- the resource snapshot at the anchor: tank, beds, battery, last air reading, and running totals for the balance and stress;
- the per-step record up to the anchor.

The current state at server time t is `simulate(anchor, current build, ticks since anchor)`. That is deterministic, so every client computes the same values regardless of frame rate.

**Time and collaboration policy.**
- Run actions are start, pause, resume, step one hour, speed ×1 (2.5 s per step) or ×4, and reset. Each is a room action, ordered and answered (accepted or refused) like an edit.
- Pause and step settle the model on the server: the snapshot and record advance to the current tick.
- While a day is running, every change to the rig is refused (`running`): edits, cable moves, imports, reset bench, Undo/Redo. Pause first. A change and a pause that race are ordered by the room.
- When the last participant leaves, the run pauses at that model time and its resources are kept. The bench resets as in every studio, and Recovery restores it. Nobody gets elapsed time or water for being away.
- A late joiner or a reconnecting client receives the run state and the server time, and so shows the same model time and resources.
- The run ends at step 96. If the server restarts mid-run, it continues from its persisted anchor by server time, up to that end.
- Project files hold the build only, never resources or model time, so importing cannot refill the tank or resurrect an old run.
- Same-device peer rooms (no server) apply the run actions in each tab with a shared clock, like Episode 1.

**Assumptions stated in the studio.**
- These are teaching numbers. Water uptake, weather and plant response are not validated crop, weather or botanical models.
- The greenhouse has no thermal mass, the pump has fixed flow, hoses are lossless, and valves split flow linearly.
- Power is accounted per 15-minute step.

---

## Acceptance contracts for the next episodes

Each starts only after the previous episode passes independent review. Episode 2's contract is implemented above; 3–5 are not.

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

*Implemented: see [Episode 2 · Sound Flow Studio](#episode-2--sound-flow-studio) above. The original contract is kept below for review.*

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
