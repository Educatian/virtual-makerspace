# Episode 1 · parent-review follow-up: regression evidence

These runs happened in a developer environment: headless Chromium 1194 with SwiftShader software WebGL, wrangler dev with `scripts/access-proxy.mjs`, and a 2-core VM. They are **not** GitHub CI; the repository's only GitHub check is GitGuardian. Every room was a random QA room, never 7K3M.

## `e2e-room-sync.mjs`: cause of the "Snapino code" timeout

**Symptom.** The original test timed out after 120 s waiting for the member's enabled "Snapino code" button. This happened on head and on the unmodified baseline `3394e4b` (built in a separate worktree and served by its own wrangler and proxy). In another attempt it timed out reading `#viewport-heading`.

**Method.** An instrumented copy of the original test (same steps, same animation-frame polling) added:
- a page heartbeat (`setInterval` every 250 ms);
- an animation-frame counter;
- a long-task observer;
- a node-side probe that evaluates in each page every 5 s;
- on timeout, a dump of the DOM, buttons, URL and lobby state, plus a screenshot;
- a V8 CPU profile of the member page.

**Findings.** They were the same for head and baseline.

| | head (`606fa07` app) | baseline `3394e4b` |
|---|---|---|
| member DOM at timeout | workspace intact, heading "Snapino", **one "Snapino code" button: enabled, not hidden, connected**, not in the lobby | same |
| heartbeat (timer) max gap | **122 s** | **140 s** |
| animation-frame max gap | 89 s | 100 s |
| longest main-thread tasks | 115 s, 89 s, 8 s … | 100 s, 83 s, 57 s … |
| hottest stack (CPU profile) | `WebGLProgram.getUniforms` → link-status check (`getProgramParameter(LINK_STATUS)`) ← `renderBufferDirect` ← `WebGLRenderer.render` ← app render loop: **107 s** in one call | the same stack: **101 s** |
| screenshot during the stall | did not complete within 30 s | did not complete within 30 s |

**Cause.** When a new three.js material is first drawn, three.js reads the program's link status. Under SwiftShader this blocks the page's main thread for 50–120 s while the shader program compiles and links, measured with two Snapino pages on two cores. Timers, animation frames, Playwright evaluations and screenshots all wait for it.

The DOM is never missing and the button is never disabled. Animation-frame polling is not the special problem: the timer heartbeat stops too, so numeric polling alone cannot help (tried: it then timed out in `textContent`).

The same stall explains a later symptom: at 1440×900, every ordinary frame took about 15 s, so the original "two quick evaluations" readiness idea also failed.

**Fix (test harness only, no app change).** The fix is `scripts/lib/e2e-readiness.mjs`:
- After every step that brings new parts or materials on screen, the test waits for at least 3 animation frames rendered *after* the step, plus two evaluations that return within 20 s. The time is logged, with a 900 s budget.
- If the budget runs out, diagnostics are written and the test fails; no check is skipped.
- Buttons are polled on a timer (250 ms), and a timeout writes diagnostics.
- The room-sync viewport is 1000×700, like the other two-browser tests. At 1440×900 a frame took about 15 s.
- The original assertions are all kept and all executed, down to the studio switch.
- The readiness timers are `unref`'d. Before that, each run's node process stayed alive up to 15 minutes after finishing.

**Results.** The same test file was run on both builds, alternating, each in a fresh room:

| run | build | result | longest readiness wait |
|---|---|---|---|
| [rs-head-3](room-sync/rs-head-3.log) | head | 13/13 | member after lamp placed: 93 s |
| [rs-base-1](room-sync/rs-base-1.log) | baseline | 13/13 | member after lamp: 29 s |
| [rs-head-r2](room-sync/rs-head-r2.log) | head | 13/13 | member entered: 90 s |
| [rs-base-r2](room-sync/rs-base-r2.log) | baseline | 13/13 | member entered: 104 s; late joiner: 96 s |
| [rs-head-r3](room-sync/rs-head-r3.log) | head | 13/13 | member after lamp: 71 s |
| [rs-base-r3](room-sync/rs-base-r3.log) | baseline | 13/13 | member entered: 95 s |

The 70–104 s waits move between steps and occur on both builds. They are the shader-link stalls, not a regression on this branch.

Evidence for the diagnosis is in [`room-sync/`](room-sync/):
- the timeout dumps for head and baseline;
- the CPU-profile top functions and hot stacks for both;
- the six run logs.

## `e2e-cable-end.mjs`: late-join flake and the strengthened test

**The earlier failure.** One run on `8261420` failed its late-joiner check (6/7), and an unchanged rerun passed. That run kept no artifacts, so its cause cannot be established from evidence.

**What the instrumented runs show.**
- The first run of the strengthened test failed differently: the teammate did not see the host's drop within the old 30 s window (value `null`).
- The readiness log then showed the member's main thread busy for 44–49 s after the drop, a shader link for the moved cable end. That is longer than the test's 30 s window.
- The late joiner's first readiness wait was 5–34 s, which straddles that window.

The same stall therefore explains how a 30 s check could fail. The test now waits for measured readiness after each change, and writes the wire value, the host's value and a trail on failure.

**Other changes to the test.**
- It checks both makers' studios and asserts the second drop.
- It replaces the `canUndo`-only "one undo step" claim with an actual **undo**: the free end comes back on both screens, nothing is left to undo, and redo is available. It then **redoes**, and the end is seated again on both screens.
- Undo and redo are clicked by id, because their labels change to "Undo: Moved …".

**Five fresh-room runs on head**, in a row, with every result reported:

| run | result | readiness after the host's drop | late joiner entered |
|---|---|---|---|
| [cable-1](cable/cable-1.log) | 12/12 | 44 s | 5 s |
| [cable-2](cable/cable-2.log) | 12/12 | 49 s | 34 s |
| [cable-3](cable/cable-3.log) | 12/12 | 13 s | 5 s |
| [cable-4](cable/cable-4.log) | 12/12 | 15 s | 33 s |
| [cable-5](cable/cable-5.log) | 12/12 | 14 s | 30 s |

## `e2e-rescue-signal.mjs`: final runs, and one more defect found

The strengthened two-browser test (58 checks) was run on the final app before this report.

| run | app | result |
|---|---|---|
| [rescue-040df7c](rescue-signal/rescue-040df7c.log) ([results](rescue-signal/rescue-040df7c-results.json)) | `040df7c` | **57/58** |
| [rescue-13aa2aa](rescue-signal/rescue-13aa2aa.log) ([results](rescue-signal/rescue-13aa2aa-results.json)) | `13aa2aa` | **58/58** |

**The failure on `040df7c` was a real defect, not a flake.** The late joiner's room-clock estimate was 2,626 ms away from the sender's. The round trips were 9 ms for the joiner and 5,271 ms for the sender.

**How the sender's clock went wrong:**
1. The sender's page was busy rendering the running light.
2. One minute after its last good sample, the client accepted a 5.3 s round-trip sample as a "refresh" against drift.
3. That threw away a good estimate for one that could be off by up to 2.6 s.
4. The fast resampling had already used up its fixed budget of retries, so the estimate did not recover in the 180 s the test waits.

**Fix (`13aa2aa`, `src/desktop/room-clock.ts`):**
- A stale estimate may be refreshed only by a sample of comparable quality: at most twice its round trip, or 500 ms.
- The fast resampling restarts whenever the estimate is poor.
- `episode-sync-check` now checks the rule, including the failing sequence replayed.

On `13aa2aa` both clock checks pass:
- reconnect: Δ 3 ms, with round trips of 7 and 3 ms;
- late join: Δ 2 ms, with round trips of 11 and 6 ms.

**Other measurements in the passing run:**
- **Pixels:** the receiver's lamp crop has mean luminance 201.6 while lit and 164.5 while dark, from separate screenshots at the same camera.
- **Late joiner:** it joined 94.6 s into the 108 s recurring light. Its 4 driven frames (1 lit, 3 dark) all agree with the timeline.
