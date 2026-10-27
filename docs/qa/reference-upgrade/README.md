# Snapino bench reference-quality upgrade: test and render evidence

Developer environment:
- headless Chromium 1194 with SwiftShader software WebGL;
- wrangler dev with `scripts/access-proxy.mjs` for the Worker runs;
- 2 CPU cores.

These are **not GitHub CI** runs; the repository's only GitHub check is GitGuardian. Every room was a fresh random QA room, never 7K3M. Draw calls and triangles are renderer counters, not frame rates.

Design, provenance and the REA blocker: [`../../reference-benchmark.md`](../../reference-benchmark.md).

## Commits

| Commit | What |
|---|---|
| `7cea8a6` | Live Snapino circuit diagram plus its oracle check |
| `da304f1` | One dock column, Bench inspector, camera views, stud collars and labels, highlight rings |
| `34cd760` | Browser tests (`e2e-bench-inspector`, `qa-reference`); rescue/qa scripts follow the dock tab |
| `57506d3` | Inspector: report an unconfirmed (timed-out) S1 flip honestly. Found by the first browser run. |
| `a9fefef` | PF: diagram notes arrive with a lone sender's solo check too |
| `dc51187` | Diagram: the wire list stays in the label column (overlap seen in the DI capture) |
| `73ebb42`, `13f5dba`, `d3485c8`, `4b65d6a`, `dfdaa29`, `781a2c5` | Test-script fixes only (see below) |

**Final application code:** `dc51187`. It differs from `a9fefef` only in where the diagram draws its wire list (`src/circuit/snapino-diagram.ts`).

## Results

| Suite | App | Result | Log |
|---|---|---|---|
| `npm test`: typecheck, circuit 17,742, agent, project 270, snapino, sync 858, tools 36, rescue signal 17,738, episode sync 55, **diagram 62,861** | `dc51187` | all passed | — |
| `npm run build` | `dc51187` | OK | — |
| `e2e-bench-inspector.mjs` (two browsers, Worker) | `dc51187` | **29/29** | [`inspector-dc51187.txt`](inspector-dc51187.txt) |
| `qa-reference.mjs after` (captures, layouts, PF/DI) | `dc51187` | **14/14**, 11 shots | [report](qa-reference-after-report.json) |
| `qa-episode.mjs` (Episode 1 captures) | `dc51187` | no issues on the third attempt; the first two stopped on test-script problems (items 6 and 7 below). Bulb pixels 193.3 lit vs 158.0 unlit. | [renders](../../images/episodes/rescue-signal/README.md) |
| `e2e-bench-inspector.mjs` | `a9fefef` | 29/29 | [`inspector-a9fefef.txt`](inspector-a9fefef.txt) |
| `e2e-rescue-signal.mjs` (two browsers, Worker) | `a9fefef` | **58/58** | [`rescue-a9fefef.txt`](rescue-a9fefef.txt) |
| `e2e-ai-teammate.mjs` (peer) | `a9fefef` | 37/37 | [log](e2e-ai-teammate-a9fefef.txt) |
| `e2e-ai-teammate-worker.mjs` | `a9fefef` | 9/10, then 10/10 and 10/10 | [1](e2e-ai-teammate-worker-a9fefef.txt), [2](e2e-ai-teammate-worker-2-a9fefef.txt), [3](e2e-ai-teammate-worker-3-a9fefef.txt) |
| `e2e-worker-sync.mjs` | `a9fefef` | 18/18 | [log](e2e-worker-sync-a9fefef.txt) |
| `e2e-snapino-history.mjs` | `a9fefef` | 25/25 | [log](e2e-snapino-history-a9fefef.txt) |
| `e2e-room-sync.mjs` | `a9fefef` | 13/13 | [log](e2e-room-sync-a9fefef.txt) |
| `e2e-cable-end.mjs` | `a9fefef` | 12/12 | [log](e2e-cable-end-a9fefef.txt) |

Every non-passing run is listed here, with what it was:

1. **`e2e-bench-inspector`, first run (`da304f1` app): 27/28.** This was a **real defect.** The host's S1 flip was accepted by the room and reached both clients. But the host's page was stalled past the client's 8 s edit deadline (a SwiftShader shader link), so the inspector said "Not changed: the room did not accept the flip". It now distinguishes a timeout ("Not confirmed in time … switches when its answer arrives") and updates the note if the answer lands within 60 s (`57506d3`). [Log](inspector-da304f1-first-run.txt).
2. **`e2e-rescue-signal` attempt 1 (`a9fefef`): stopped at the export step.** The tap helper now refuses invisible elements, and Export lives in the closed project menu. The test now opens the menu first, as a person would (`73ebb42`). All 47 checks before that point had passed. [Log](rescue-a9fefef-attempt1-export-tap.txt).
3. **`e2e-ai-teammate-worker` run 1: 9/10. Cause unknown.** The check for Bolt saying "Done." failed. The following check (the host's circuit lit safely from Bolt's relayed moves) passed.
   - **Why "Done." can be missing:** Bolt counts a part as skipped, and then does not say "Done.", if the part was held by someone else, its claim was refused, its claim was not granted within 4 s, or its release was refused. A build superseded by a later lesson also ends without "Done.".
   - **What we know:** that run kept no record of what Bolt said or of those outcomes, so none of these can be singled out. The two later 10/10 runs do not explain the failure either.
   - **Diagnostics now kept:** Bolt keeps a per-part build log, and the test retains it on every run (`6c14f4c`), with Bolt's lines and the final bench. See the diagnostic runs below.
   - **Scope:** this suite is Circuit Bench only.
4. **`qa-episode` attempt 1 (`a9fefef`): stopped at Stop.** With the workshop in the open dock, the 110 s capture flash ended before the script reached Stop, and the fail-fast tap refused the absent button. The script now presses Stop only while the flash still runs, and records which way it ended (`d3485c8`).
5. **`qa-reference` (`a9fefef`): the first shot's counters were read too early.** `same-01-overview` read 81 calls before the GLB parts replaced the stand-ins; the image itself was fine. A dedicated re-measure gave **687 calls and 104,890 triangles** (after) against **683 and 96,826** (before), each the same over three reads. The script now settles twice before reading (`4b65d6a`), and the `dc51187` run reads 687 / 104,890 directly.
6–7. **`qa-episode` on `dc51187`, attempts 1 and 2: stopped at the phone section.** All 11 desktop shots completed (`e01`–`e09`, `e12`, `e13`). The phone page could not press the field-test button, which is `display: none` below 620 px; that rule predates this branch. The old capture had clicked it while it was hidden. The phone page now submits the same layout as one room edit (`dfdaa29`). The rerun then lost the Stop race again: the flash ended between the "still running" check and the click. Stop may now lose that race only if the round is verified to have ended; any other missing Stop still fails (`781a2c5`).

## What the browser tests prove, and what they do not

**`e2e-bench-inspector`** uses Playwright `mouse` and `keyboard`, not `element.click()`, for the actions under test. It checks:
- **Pointer selection.** A pointer click on the 3D lamp selects it and brings the inspector to the front. The diagram marks the lamp's rung and its two rows (D5, GND).
- **3D rings.** The 3D rings equal the studs of both nets as rebuilt **in node** from the bench the page reports, with `buildSnapinoDiagram`. That is the diagram module itself, so it checks the 3D view against the diagram model. The model's own correctness is checked separately against an independent BFS oracle in `snapino-diagram-check`.
- **Keyboard path.** Tab reaches the S1 rung (14 presses) and Enter selects S1. Tab reaches "Switch S1 on" (2 presses) and Enter submits one room edit.
- **Accepted flip.** Both clients show S1 on in the bench, the diagram (S1 closed, D2's net at 5 V) and the code panel's D2 LED (HIGH). Both clients' diagrams list identical connections. The unsaved code draft is unchanged.
- **Declined.** While the member holds S1 with a real mouse-down, the host's inspector names the holder and disables the switch. A host double-click on S1 changes nothing for anyone.
- **Stale.** Two simultaneous flips: in the final run the room accepted the member's flip and refused the host's. The host's note says "Not changed", and both clients hold the same state ([attempts](inspector-dc51187-stale-attempts.json)). The refusal is classified as "not a timeout". The test does not read the exact refusal reason.
- **Camera views:**
  - **Bench:** the base and carrier lie inside the free view, 504 of 588 px wide at 1000×700.
  - **Top:** directly above, with columns left to right.
  - **Table:** pulled back.
  - **Key 4:** the lamp.
  - **Key 1:** back to Bench.
  - **F:** fits the selected lamp.

**`qa-reference`:**
- **Same-camera renders.** Before (`040df7c`) and after, with identical locally placed parts. The dock is closed and the after build's view bar hidden, so only bench detail differs.
- **Composition metric.** The bench fills **85%** of the free width in the new Bench view, against **47%** with the old default camera in the same layout.
- **Layouts.** 1440×900, 1280×720 and 390×844: no page scroll, the Chat tab reachable, and every inspector, dock-tab and view button at least 44 px.
- **PF vs DI.** A lamp bypassed by a wire is drawn as built in both conditions. PF withholds the notes and gives the reason; DI flags and explains them.

**Not covered:**
- touch input;
- real GPUs, phones or headsets;
- screen-reader output, beyond the accessible names and the text connection list;
- an animated current-flow view, which does not exist;
- Circuit Bench composition, which was not changed.

## Renderer counters (SwiftShader, last frame)

| View | Before `040df7c` calls / triangles | After calls / triangles |
|---|---:|---:|
| Old default camera, 1440×900 | 683 / 96,826 | 687 / 104,890 |
| Close three-quarter over rows C–F | 347 / 74,106 | 351 / 82,170 |
| Low angle on the row and column labels | 401 / 79,746 | 405 / 87,810 |
| Near-top grid | 329 / 73,154 | 333 / 81,218 |
| Default composition, workshop open | 981 / 112,266 | 509 / 94,506 |

The microdetail costs **+4 draw calls and +8,064 triangles** at any view: stud collars, enlarged labels, and the highlight rings, which are instanced and drawn only when shown. The default composition draws fewer calls because the Bench view frames the bench rather than the whole room.

Per view in the two-browser test, at 1000×700 with S1 and the lamp seated:

| View | Calls | Triangles |
|---|---:|---:|
| Bench | 551 | 98,026 |
| Top | 481 | 95,810 |
| Table | 739 | 109,186 |
| Lamp | 367 | 86,026 |
| Fit | 412 | 86,666 |

## Images

All under [`../../images/reference-upgrade/`](../../images/reference-upgrade/):
- `compare-*`: before and after side by side, at the same camera and viewport, plus the two builds' own default compositions;
- `after-*`: the final build at 1440, 1280 and 390 px; the Top view; PF vs DI on a bypassed lamp; the Pinout and Behaviour cards;
- `inspector-*`: the two-browser run.
