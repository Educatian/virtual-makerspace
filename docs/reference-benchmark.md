# Reference benchmark: Snapino workbench and Episode 1 presentation

This file records what we tried to learn from the public reference lesson
<https://learn-arduino-red.vercel.app/#rgb>, how we tried, and what we built. It does not contain the
reference's code, text, images, models or branding. Nothing here was derived from the target's
bundles: the analysis tool could not reach the site (see **Provenance**).

## Provenance

### REA (Reverse Engineer Anything): attempted and blocked

**Tool and version:**
- `rea-agents` 6.8.0 from npm (canonical project github.com/morluto/rea, MIT). It needs Node `^22.23.4 || ^24.22.1`.
- It ran on Node 24.22.1 from the npm package `node-linux-x64@24.22.1`.
- The tool and Node were installed only into a private scratch folder. No global install was made.

**Settings we left alone:**
- We did not run `rea setup`.
- We did not change any client configuration.
- We did not install Hopper, Ghidra, IDA, JADX or Kuna.

**Browser:**
- A fresh, owned Chromium profile in a temporary folder, not the user's profile or cookies.
- Chromium 141 headless (Playwright's build).
- CDP was bound to loopback only (`--remote-debugging-address=127.0.0.1 --remote-debugging-port=9333`).
- It navigated once to the public URL.

| Step | Command (CLI) | Result |
|---|---|---|
| health | `rea doctor --format json` | Node 24.22.1 and host healthy. Native engines (Hopper, Ghidra, IDA, JADX, Kuna) are missing; none is needed for web analysis. The skill or client registration is "not configured" because we did not run setup. |
| open target | owned Chromium → `https://learn-arduino-red.vercel.app/#rgb` | `net::ERR_TUNNEL_CONNECTION_FAILED` |
| list targets | `rea list-browser-targets http://127.0.0.1:9333 --format json` | ok: one page target listed with the target URL. It is Chrome's network-error page, so the site's document never loaded. |
| inspect | `rea inspect-web-page http://127.0.0.1:9333 <targetId> --allowed-origins https://learn-arduino-red.vercel.app --observation-ms 2000 --format json` | `target_unavailable` / `target_not_allowed` |
| bundle | `rea analyze-web-bundle http://127.0.0.1:9333 <targetId> --allowed-origins https://learn-arduino-red.vercel.app --observation-ms 2000 --format json` | `target_unavailable` / `target_not_allowed` |
| static capture | `curl` of the public bundles the parent observed (`/assets/index-GGrOCNGj.js`, `/assets/index-CqDNWwLj.css`) | `CONNECT tunnel failed, response 403` for both. The proxy status lists `connect_rejected … learn-arduino-red.vercel.app:443` |
| static app | `rea analyze-javascript-application <path> --json` | Not run: it needs a local copy of the shipped bundles, and none could be captured. |
| direct check | `curl https://learn-arduino-red.vercel.app/` | `CONNECT tunnel failed, response 403` from the environment's egress proxy |

We also did not get as far as the flags the parent suggested (`--observation-ms 10000 --include-accessibility-text --include-json-body-shapes --include-script-sources`). Inspection was refused before any observation, so they would not have changed the result. The parent's notes cite 6.4.0 from the docs; npm resolved `@latest` to **6.8.0**, which is what ran.

**Cause.** This environment's outbound proxy refuses the target host: CONNECT returns 403. Chromium and curl fail the same way. REA had nothing loaded to inspect, which is why it reports `target_not_allowed`.

**What we did not do.**
- We did not work around the proxy with mirrors, caches or another route.
- We did not use the user's own browser or computer.
- We did not present any other analysis as REA's.

**Evidence.** The raw JSON outputs and their SHA-256 sums are kept outside the repository, in the session scratch folder `rea/evidence-final/`:

| File | SHA-256 (prefix) |
|---|---|
| `analyze-web-bundle.json` | `62192544f2e5…` |
| `inspect-web-page.json` | `b8944b6119aa…` |
| `list-browser-targets.json` | `871f25a77a09…` |
| `doctor.json` | `978147315d42…` |

**To complete the REA step,** run the same commands from a network that can reach the site. For example, the user's machine, with the same owned and isolated profile and loopback CDP.

### Non-REA observation (labelled as such)

One fetch of the public page through the assistant's web-fetch tool returned a short structural summary. This is not REA, and nothing from it was copied. In outline:
- top navigation;
- a 3D board with pan, rotate and zoom controls;
- per-lesson tabs: Overview, Pinout, Example, Specifications;
- a "try it" region with a code editor, a run control and a serial monitor;
- 16 basics lessons with a progress counter.

The fetch did not include the RGB lesson's own content.

The parent review's description of the reference sets the bar we worked to:
- the 3D board dominates the screen;
- each part has a reference with a pinout;
- a schematic is tied to the board;
- the board shows crisp detail.

### Parent-observed reference behaviour, and what we did with it

The parent browsed the site and recorded the observations below. They are the parent's, not REA's, and we could not reproduce or trace any of them here. Each maps to our own design for our five episodes. Nothing was copied.

| Observed in the reference (parent) | Our original counterpart | Status |
|---|---|---|
| A large, labelled 3D hero, with turn, zoom and reset controls | The Snapino bench fills the free view. There are five camera views: Bench, Top, Table, Lamp and Fit part, on keys 1–4 and F. | **Done** |
| A contextual Part inspector with Overview / Pinout / Example / Specifications tabs and "Zoom to it" | The Bench inspector, with Overview / Pinout / Behaviour & limits and Zoom to it. Limits give real ratings with units and say where the bench simplifies. | **Done.** We have no "Example" tab: worked examples are DI-only in Episode 1. |
| Clicking a value opens the part. A preset updates the rendered state, the code values and the schematic together. | Selecting a part (3D, rail or diagram) cross-links the inspector, the 3D terminal and net rings, and the diagram's rung and rows. The S1 flip is one room edit, and the bench, diagram and D2 input LED follow from canonical state on every client. | **Partly.** Our only inspector edit is S1. The Snapino blocks have no per-part numeric values to edit, and we did not invent some. Resistor and voltage edits exist on the Circuit Bench meter. |
| A schematic overlay and a current-flow toggle | The live ladder diagram, derived from the actual nets. Wrong wiring is drawn as built; fault notes follow PF/DI. | **Done** for the schematic. **Deferred:** an animated current-flow toggle; the diagram shows levels and running state instead. |
| Shaped PCB, chips, headers, metal pins, breadboard holes, curved colour-coded wires, soft shadows | Stud collars (socket depth), legible row and column marks, and printed-style terminal and net rings. The existing GLB carrier, header and part models are kept. | **Partly.** Snap parts are rigid, so this studio has no curved wires. The Circuit Bench jumpers were not changed. |
| A 16-lesson rail | Not adopted. We keep our five original episodes, with no placeholder lessons. | By design |
| "Compiling…" / "Uploading…" labels | Not adopted. Our blocks run in a stated block runner, with no compiler or upload claims. Whether the reference compiles anything is unknown to us, since REA could not trace it. | By design |

## What "reference quality" means here (our criteria)

| # | Criterion | How we test it |
|---|---|---|
| 1 | **Composition.** The 3D bench is the main thing on screen, with one side column, not two. Panels collapse. There are camera views and fit-part. It works on desktop, laptop and phone. Collaboration stays one click away. | Projected-bench metric (`benchRect`): share of the free view the bench fills. Layout checks at 1440, 1280 and 390 px: no page scroll, Chat tab present, targets ≥ 44 px. |
| 2 | **Microdetail.** Legible board markings, depth at the sockets, connection highlighting, and no fake glow. | Same-camera before/after renders, with draw calls and triangles for each shot. |
| 3 | **Semantic cross-link.** Selecting a part shows it in the inspector, rings its terminals and nets in 3D, and marks its rung and nets on the diagram. Edits go through the room: accepted, declined or stale. A dirty draft is never overwritten. | Two-client end-to-end test with real pointer and keyboard input. 3D rings are compared to a diagram rebuilt independently from the reported bench. |
| 4 | **Live diagram.** Derived from the actual connections. Wrong wiring is drawn as built. Fault notes follow the PF/DI rule. | 62,859 oracle checks (an independent BFS over the placements, 4,000 random benches). Browser check of a bypassed lamp under PF and DI. |
| 5 | **Depth.** Per-part overview, pinout, on-bench behaviour and real-hardware limits with units. Keyboard access and minimum target size. No fake compiler or upload badges, no XP. | Inspector content review, keyboard path in the end-to-end test, target-size check. |

## What we built (original implementation)

### One dock column instead of two side panels

**Before:**
- The Rescue Signal panel floated over the left of the scene.
- The chat, voice, team, notes and code dock sat on the right.
- The 3D bench was squeezed between them.

**Now:**
- The workshop is the first tab of the single right-hand dock.
- A new Bench inspector tab sits next to it.
- Code and the collaboration tabs stay in the same row.

**Behaviour:**
- **Opening the workshop.** The dock opens on the Workshop tab once. Collapsing the dock gives the scene the full width. The toolbar's Workshop button reopens it.
- **New chat.** A chat message that arrives while another tab is in front puts a dot on the Chat tab.
- **Selecting a part.** This brings the inspector to the front. It does not take the learner off the Workshop or Code tab, or away from a message or note they are writing; the inspector tab gets a dot instead.

### Camera views

The bar is at the top left of the scene. The views are:
- Bench, key 1;
- Top, key 2;
- Table with tray, key 3;
- Lamp (the receiver's view), key 4;
- Fit part, key F.

How they work:
- Each view fits its target box into the free area between the panels, using the live projection: the view offset and the zoom.
- The Snapino studio opens on the Bench view.
- Moves take 420 ms, and are instant with reduced motion.

### Live circuit diagram

The diagram is a ladder schematic built in `src/circuit/snapino-diagram.ts`:
- Rows are snap-wire nets. All six pads always appear, and joined pads read "D3 = D5".
- Rungs are the lamp, the LED, the motor and the S1 switch, which is drawn open or closed.
- A part with both ends on one net is drawn as a loop.
- Rows and rungs are keyboard buttons, and a text list of connections serves screen readers.

**Fault notes:**
- The notes cover:
  - short;
  - pin on GND;
  - pin joined to 5V;
  - pins joined;
  - bypassed;
  - no GND path;
  - nothing can drive it;
  - always on from 5V.
- **PF condition:** the notes are withheld, with the reason shown, until the team's first compared round.
- **DI condition:** shown at once.
- The wiring itself is always drawn as built.

### Bench inspector

The inspector is `src/desktop/snapino-inspector.ts`, with content in `src/desktop/snapino-parts.ts`:
- **For a part:**
  - an Overview, with what can drive it as wired;
  - a Pinout: each end's stud name (e.g. B-4), pad, net and level;
  - Behaviour and limits: how this bench decides on/off, and real-part ratings in V and mA.
- **Real hardware, stated plainly:**
  - the 20 mA recommended and 40 mA absolute-maximum pin limit;
  - why lamps and motors need a transistor;
  - that the LED is treated as non-polar here;
  - the floating input and pull-down.
- **For a net:** its studs, wires and pads.
- **Actions:**
  - Zoom to it.
  - Switch S1. This is one room edit through the existing path. Nothing changes locally until the room accepts it; a refused or stale flip says "Not changed".

### Microdetail in the 3D bench

- **Socket collars.** A shaded ring where each of the 63 studs meets the plate, in one instanced draw call.
- **Board labels.** The base's row letters (A–G) and column numbers (1–9) are enlarged about 1.9–2× and printed darker, so the stud names the inspector uses can be found on the board.
- **Selection rings.** Rings mark the selected part's terminals (larger) and every stud of its two nets: amber for end A's net, cyan for end B's, red when both ends share a net. They are printed-style, depth-tested and unlit, with no additive glow and no bloom. They use one instanced draw call.

Not changed:
- The parts' models.
- Snap parts are rigid, so there are no curved jumpers in this studio. Curved wire tangents are drawn on the diagram's loop only.

## Results

Run in the developer environment: headless Chromium with SwiftShader, not a GPU and not CI. Full logs and numbers are in [`docs/qa/reference-upgrade/README.md`](qa/reference-upgrade/README.md), and the images in [`docs/images/reference-upgrade/`](images/reference-upgrade/).

## Limits

- The REA analysis of the target is blocked here, as described above. These criteria come from our own design goals, the parent review, and a one-line structural fetch. They do not come from the target's code.
- The circuit meter of the Circuit Bench studio still floats over the left of that studio. This upgrade covers the Snapino bench and Episode 1.
- SwiftShader draw-call and triangle counts are not frame rates. Nothing was measured on a real GPU, phone or headset.
- **Not done:**
  - an animated current-flow view;
  - inspector value edits beyond S1;
  - Circuit Bench wire and meter composition;
  - matching the diagram's highlight colours to the 3D ring tones (rows are highlighted, but not in amber and cyan).
- The 3D stud rings sit at the plate. A seated part's rivet covers its own terminal stud, so only a rim of the larger terminal ring shows from most angles.
