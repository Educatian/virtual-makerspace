# Episode 3 · Resource-Limited Greenhouse — test records

These records come from a developer environment: headless Chromium (SwiftShader), wrangler dev on 8799, and the local access proxy on 8800 with `vm.test` mapped to 127.0.0.1. The machine has 2 CPU cores. **None of this is GitHub CI.** Every room was a fresh random QA room; the production room 7K3M was never used, and nothing was deployed.

The records were sanitized:
- scratch paths are replaced by `<scratch>`, other temporary paths by `<tmp>`;
- the per-connection ids after `host@example.test:` / `member@example.test:` are replaced by `<connection>`;
- Chromium's own stderr lines (`[pid=…]`) are dropped.

Logs are kept as `.txt`, because the repository ignores `*.log`. Nothing else was edited.

**App versus head (second correction round).** The app under test is `abd2f51` (`abd2f511bff3da9ce22763d8e143d58e0126a96d`). The commit that adds its records changes no app code: it adds records, renders, this text and `docs/episodes.md`, and three test scripts changed after `abd2f51` (listed in that section). Everything ran on a worktree exactly at `abd2f51` with its own `dist/`.

**App versus head (correction round). The app under test is `b8d099a`. The commit that adds its records changes no app code: it adds records, renders, this text and `docs/episodes.md`. It also changes one test script, `scripts/qa-greenhouse.mjs`, to start a new attempt before its failure day (see its attempt 1 below). `b9dde3c` and `b8d099a` were each tested on a worktree exactly at that commit, with its own `dist/` (`docs/episodes.md` held aside during the runs). The one exception is the renders' attempt 2, which ran that changed script.

**App versus head (first submission).** The app under test was `faa7c09`. The commit that adds these records changes no app code (`src/`, `cloudflare/`, `server/`, `public/`): it adds the records, the renders, `scripts/qa-greenhouse-controls.mjs` (which ran from the worktree on `faa7c09`'s `dist/`), and corrects two comment lines at the top of `scripts/e2e-greenhouse-worker.mjs` so they describe what the script checks (the reset race's two accepted outcomes; the dial, not the valve handle).

## Which app each record covers

| Folder | App | Why it exists |
|---|---|---|
| [`app-abd2f51/`](app-abd2f51/) | **`abd2f51` (final, second correction round)** | The app this PR now asks to be reviewed (the review of `d06712c` corrected). The suites listed in its section ran on it; the `control-*` files ran old code beside it. |
| [`app-b8d099a/`](app-b8d099a/) | `b8d099a` (first correction round) | Kept blocked by the review of `d06712c`. Its 3D-control, plugging and comparison runs are inherited by `abd2f51` (unchanged files), labelled as `b8d099a` runs. |
| [`app-b9dde3c/`](app-b9dde3c/) | `b9dde3c` | The first correction candidate. Its full two-client run failed (cables under the new knob console); kept, not counted. |
| [`dev-before-b9dde3c/`](dev-before-b9dde3c/), [`dev-before-b8d099a/`](dev-before-b8d099a/) | uncommitted trees | Development runs, including failures; not evidence of either app. |
| [`app-faa7c09/`](app-faa7c09/) | `faa7c09` (first submission) | Not accepted at the first gate. Every suite below its heading ran on it, on a clean worktree at that commit, with its own `dist/`. |
| [`app-fe4fdf8/`](app-fe4fdf8/) | `fe4fdf8` | The previous app candidate. Its two-client run failed one check (below); `faa7c09` was made to fix it. Kept as a failed attempt, not counted. |

Each folder has a `summary.txt` listing every command in run order with its exit code and duration, and a complete text log per command. JSON sidecars are listed per row.

## Second correction round (review of `d06712c`): final app `abd2f51`

The review of `d06712c` (app `b8d099a`) kept the gate blocked on four items. One app commit, **`abd2f51`**, corrects them; the commit that adds these records changes no app code. The records are in [`app-abd2f51/`](app-abd2f51/); its `summary.txt` lists every command in run order with its exit code and duration, failures and stopped runs included.

**What `abd2f51` changes against `b8d099a`** (`git diff --stat b8d099a abd2f51 -- src cloudflare server public`): `cloudflare/room-core.js`, `src/desktop/collaboration.ts`, `src/desktop/sync-replica.ts`, `src/desktop/workbench-tools.ts`, and one line of `src/greenhouse/gh-panel.ts`. No 3D, rig, scene, model or style file changed.

**Where it ran.** A worktree exactly at `abd2f51` with its own `dist/` (`npx vite build`, entry `index-CKwhT_ME.js`), and wrangler dev + the access proxy started from that worktree. The test scripts ran from the evidence head (`gh/scripts`). Three of them changed after `abd2f51`, test code only: `e2e-snapino-history.mjs` (the lamp wait, below), `e2e-snapino-import-probe.mjs` (fail-fast waits, below) and `e2e-greenhouse-join.mjs` (tab C closes before D opens, below). The node checks ran from the worktree's own `scripts/`.

### 1. Natural end: one clock reading per room operation

`RoomCore.handle()` read its clock once to settle a day that had reached its end and again for the rig lock. With the first reading at end − 1 ms and the second at the end, nothing was settled but the rig unlocked: an unplug was accepted while the stored run still ran from tick 0 with the new rig (tank 16 → 40 L, an "incomplete" end build, nothing final persisted).
- **Fix.** `handle()` and `reset()` read the clock once (`this.at`); settlement, lock, reducers and messages use that reading. Same-device peer tabs read `Date.now()` once for settle + lock (edit) and for settle + action.
- **Check.** `greenhouse-end-check.mjs` section 10: a clock that advances 1 ms per reading, the operation's first reading at end − 1, end and end + 1 ms, for an edit and for a live hose-end move (`activeEndpoint` 0). The room must refuse (still running, hose in) or settle with the OLD rig first. Then: the room's final day (resources, the 96 records, the end build) equals the unchanged day; what clients compute; the persisted payload; a JSON restore of the persisted payloads; a rejoin.
- **Results.** `abd2f51`: **62/62** (`end-check-final.txt`; also in `npm-test.txt`). `b8d099a`'s `cloudflare/` (from `git archive b8d099a`): **50/62** — all six end − 1 ms checks fail for both the edit and the move: accepted while running at tick 0, final tank 40 L, end build "no hose from the tank to the pump" (`control-b8-end-check.txt`). At end and end + 1 ms, `b8d099a` already settled first.

### 2. Peer joins keep the accepted run revision

A tab answering a join re-stamped its unchanged run copy with a new Lamport stamp, so the joiner could hold an older run under a newer stamp than a teammate's later step, and refuse that step.
- **Fix.** The state response carries the stamp the answering tab accepted for its run (`greenhouseStamp`), never a new one. An idle run nobody acted on carries `null`; a stampless copy only fills an empty tab or replaces another stampless run. Run id still orders first, so a reset still wins.
- **Deterministic check.** `greenhouse-join-check.mjs` runs the real `DesktopRoom` (bundled from source) for three tabs over a fake BroadcastChannel, with B's update held by the app's own QA hold. `abd2f51` **8/8**; `b8d099a`'s source **7/8**, failing exactly the counterexample: A 8, B 8, **C 4** (`join-check-final.txt`, `control-b8-join-check.txt`). Also covered: an idle join followed by a step, and a held reset against a copy of the old run handed to a joiner.
- **Real browsers.** `e2e-greenhouse-join.mjs`: three real tabs, real panel buttons, `__vmQa.holdPeer`, participant-id prefixes so the tie-break order is the counterexample's.
  - Attempt 1 on `abd2f51`: steps 1–4 passed — **A 8, B 8, C 8**. Opening a fourth tab for the reset scenario then failed: its Enter button was not clickable within 240 s with four SwiftShader pages in one browser (5/6; `e2e-greenhouse-join.txt`).
  - Attempt 1 on `b8d099a`'s `dist/`: **A 8, B 8, C 4** (step 4 fails), then the same fourth-tab timeout (4/6; `control-b8-e2e-greenhouse-join.txt`).
  - The script now closes tab C before D opens. Attempt 2 on `abd2f51`: **8/8** (A, B, C at tick 8; then A, B, D all on the reset). On `b8d099a`: **7/8**, failing only step 4, again A 8, B 8, **C 4**.

### 3. Snapino history: the harness gap and the late-answer path

All earlier results stay as recorded: `b8d099a` HMZB 24/25 and HSRZ 22/25, `faa7c09` HNNQ 24/25, and the earlier `faa7c09` HQD4 25/25.

**B. Product path, confirmed deterministically.** An edit whose answer reached the sender after `EDIT_TIMEOUT_MS` (8 s): the replica kept it pending and applied the late accepted answer, but the waiter had been resolved "timeout" and removed, and `WorkbenchTools` had returned before recording or committing. The state changed; the history never followed.
- **Check.** `history-late-ack-check.mjs`: the real `RoomCore` (with the room's edit sanitizer), `DesktopRoom`/`SyncReplica` in server mode, `EditHistory` and `WorkbenchTools`, over a fake socket with ordered, delayable delivery. The teammate gets the change at once; the sender's answer is delayed 9 s. Cases: a parts + program import, its Undo, its Redo, the next Undo, a late **stale** refusal, a program-only import, and a connection that drops before the late answer. Each has an immediate-answer control.
- **Before.** `b8d099a` and `faa7c09` (their own `src/` and `cloudflare/`): **15/27** each. Every immediate-answer control passes (10/10). Every late case fails:
  - a late-accepted import is not an undo step, and is not traced;
  - a late-accepted Undo leaves the entry in Undo (Redo stays disabled), so the next Undo drops it as stale;
  - the same for Redo;
  - a late stale refusal leaves the entry in Undo;
  - the dropped connection is not reported.
  Records: `control-b8-history-late.txt/.json`, `control-faa-history-late.txt/.json`.
- **Fix.** On a timeout, `DesktopRoom` gives the caller `later`, a promise that resolves exactly once with the room's late answer: accepted, refused, or "disconnected" if the socket closes first. `WorkbenchTools` then records the import, commits the undo/redo, or drops a stale step, with the trace and status once. It sends no other undo/redo until that answer. Copy: "not confirmed yet · still waiting for the room…". A late "disconnected" stays as before: nothing is committed on a guess, and the entry stays in Undo.
- **After.** `abd2f51` **27/27** (`history-late-final.txt/.json`; also in `npm-test.txt`). The shared-code regressions pass: `npm test` (sync 858, workbench tools 36, project 306, …).

**A. Harness gap, measured.** The room sends the sender's answer and the teammate's relay in the same turn, but each page handles it when its main thread is free. `e2e-snapino-import-probe.mjs` repeats the failing step in isolation: an import with changed parts and the same running program. For each opId it logs:
- the network and JavaScript times on both tabs;
- the 8 s timers that fired;
- both benches sampled the moment the teammate shows the change.

| Run | Iterations | Importer handled the answer after the teammate (JS) | Importer not yet converged at the teammate's readiness | 8 s timers fired |
|---|---|---|---|---|
| `b8d099a`, attempt 1 (`control-b8-probe-attempt1`) | 8 | — | — | 0 · **invalid probe**: it read the lamp before it was seated, so iterations 2–8 changed no parts (the app's status says "same program, now stopped"). Kept, not counted. |
| `b8d099a`, attempt 2 (`control-b8-probe`) | 8 | 3.6–6.1 s in 7 of 8 (in one, the teammate was 4.8 s later) | 0 of 8 | 0 |
| `abd2f51`, attempt 1 | 1 | 5.1 s | 0 | 0 · **stopped**: its 90 s lamp wait timed out on the teammate and it continued with an empty state; its own guard stopped it at iteration 2. The waits now fail at 300 s. |
| `abd2f51`, attempt 2 | 8 | **16.2 s** in iteration 1, 5.1–5.9 s in the others | 0 of 8 | 0 |

What this shows:
- The teammate routinely shows a change 4–6 s before the importer has handled the room's answer. The old harness checked the importer at once after the teammate. It usually passed only because `page.evaluate` on the busy importer page itself waited ~5 s behind that work. In `abd2f51` attempt 2, iteration 1, that sample ran **16 ms** after the answer was handled.
- The importer's main thread was blocked **16.2 s** — longer than the 8 s edit timeout. The answer's message task ran before the timer task there. Had the timer run first, `b8d099a` would have lost that history step (B).
- No run reproduced a failure. The cause of HMZB/HSRZ/HNNQ is therefore not proven, but both mechanisms were observed close to triggering. HSRZ's three failures (Redo, then two dependent checks) match B; HMZB/HNNQ's "and on the importer" matches A.

**Harness fix.** `e2e-snapino-history.mjs` now waits for every shared change on **both** peers, then for the importer's history, each bounded (teammate 180 s, importer 30 s, history 30 s — past the 8 s timeout, because the app now records a late answer; a history that never follows still fails). It prints the timings. The import/undo/redo sequence stops at its first failed check, and the rest is reported NOT RUN. The export/autosave/recovery tail checks its own precondition (room program R on both peers). The lamp is waited for until it is seated on both peers. Run on `abd2f51`: **30/30**, room HD68 (one run; `snapino-history.txt`).

### 4. Verdict copy

`gh-panel.ts`: "G1 is judged on the build recorded when the day ended; G2–G5 on the day's record." The panel check asserts it (C1, 39/39). The renders `09b`/`10b` were captured again on `abd2f51` (below).

### Results on `abd2f51`

| Command | Result | Duration | Record |
|---|---|---:|---|
| `npm test` (typecheck, circuit 17,742, agent, project 306, Snapino, sync 858, tools 36 + flow 12, rescue 17,751 + episode sync 55, diagram 66,886, sound 89,528 + 47, greenhouse model 2,835,645, **end 62/62, time 5/5, relay 3/3, peer 5/5, join 8/8, history late answer 27/27**) | all passed | 182 s | `npm-test.txt` |
| `npx vite build` | OK; entry `index-CKwhT_ME.js` | 19 s | `build.txt` |
| `greenhouse-panel-check.mjs`, attempt 1 | **did not run**: the browser path was not set, so Playwright found no browser (exit 1 in 1 s) | 1 s | `panel-attempt1-no-browser-path.txt` |
| `greenhouse-panel-check.mjs`, attempt 2 | **39/39** | 7 s | `panel.txt`, `panel-results.json` |
| old-code controls (node) | end 50/62 (`b8d099a`), join 7/8 (`b8d099a`), history late answer 15/27 (`b8d099a`) and 15/27 (`faa7c09`) | — | `control-*.txt` |
| `e2e-worker-sync.mjs` | 18/18, room SQXZ | 3 s | `worker-sync.txt` |
| `e2e-snapino-history.mjs` (fixed harness) | **30/30**, room HD68 | 687 s | `snapino-history.txt` |
| `e2e-snapino-import-probe.mjs`, attempts 1 and 2 | see the table above | 471 s, 1,013 s | `snapino-import-probe*.txt/.json` |
| `e2e-room-sync.mjs` | 13/13, room TGMZ | 646 s | `room-sync.txt` |
| `e2e-cable-end.mjs` | 12/12, room WEPD | 274 s | `cable-end.txt` |
| `e2e-greenhouse-fixes-worker.mjs` (two makers + a late joiner, Worker) | **11/11**, room G3MW | 1,021 s | `e2e-greenhouse-fixes.txt`, `e2e-greenhouse-fixes-results.json` |
| `e2e-greenhouse-peer.mjs` (two real tabs, reset vs step, both orders) | **7/7** | 359 s | `e2e-greenhouse-peer.txt`, `e2e-greenhouse-peer-results.json` |
| `e2e-greenhouse-join.mjs`, attempt 1 / `b8d099a` control | 5/6 / 4/6 (above) | 885 s / 909 s | `e2e-greenhouse-join.txt`, `control-b8-e2e-greenhouse-join.txt` |
| **`e2e-greenhouse-join.mjs`, attempt 2** (C closes before D opens) | **8/8**: A, B, C at tick 8; then A, B, D on the reset (run 2, seed 7) | 969 s | `e2e-greenhouse-join-attempt2.txt`, `e2e-greenhouse-join-attempt2-results.json` |
| control: the same on `b8d099a`'s `dist/` | **7/8**: step 4 fails with **A 8, B 8, C 4**; the reset scenario passes | 986 s | `control-b8-e2e-greenhouse-join-attempt2.txt`, `control-b8-e2e-greenhouse-join-attempt2-results.json` |
| `qa-greenhouse.mjs` (renders) | **12/12**, no issues: fill 0.914 at 1440 and 0.919 at 1280; the wrong build drawn as built; failure (default allocation) and recovery (worked allocation) as before; phone and PF checks pass. `09b`/`10b` show the new G1 line | 2,227 s | `qa-greenhouse.txt`, `qa-greenhouse-record.json`; renders in [`../../images/episodes/greenhouse/`](../../images/episodes/greenhouse/README.md) |

**Inherited from `b8d099a`, not rerun on `abd2f51`.** These cover only files that `abd2f51` does not change (rig geometry, scene, controls, styles):
- the 3D controls (`qa-greenhouse-controls`, 33/33);
- plugging all 14 ends by pointer (`qa-greenhouse-plug`, 7/7);
- the same-camera comparison.

They are runs of `b8d099a`, not of `abd2f51`. The full two-client greenhouse run (`e2e-greenhouse-worker`, 40/40 on `b8d099a`) was **not** rerun: it runs through the changed room and client code, so it is evidence for `b8d099a` only. `e2e-greenhouse-fixes-worker` (two makers + a late joiner) ran instead. Still not rerun since `faa7c09`: Sound, the bench inspector, Rescue Signal, the AI-teammate tests, `qa-sound` and the Sound DSP check.

**Not changed, noted.** The Rescue Signal episode (Episode 1's code) still re-stamps its copy in the same state response (`stamp: this.sync.stampTransform("episode")`). It is the same pattern as item 2, outside this round's scope, and left as it is.

## Correction round after the first gate: app `b8d099a`

The first independent gate did not accept `faa7c09`. It sent four blockers and, after its source audits, three more correction items and three secondary ones. Two app commits followed:
- **`b9dde3c`** corrected them all, but its full two-client run failed. It is kept below as a failed candidate.
- **`b8d099a`** fixes that failure and is the app this round asks to be reviewed.

The records are in [`app-b8d099a/`](app-b8d099a/) and [`app-b9dde3c/`](app-b9dde3c/). Each folder's `summary.txt` lists every command with its exit code and duration, and every interruption.

**Scope of the reruns.** This round did not rerun every suite. It ran:
- typecheck, build and all node checks;
- focused browser checks for what changed: the 3D controls, plugging by pointer, the panel record, run authority, peer ordering and the two-client flow;
- the room, recovery and sync regressions that the room code touches;
- the full two-client greenhouse run.

These suites were **not** run on `b8d099a` (or `b9dde3c`): `e2e-sound-worker`, `e2e-bench-inspector`, `e2e-rescue-signal`, `e2e-ai-teammate-worker`, `qa-sound`, the peer AI test and the Sound DSP check. Their last runs are the `faa7c09` records above and cover `faa7c09` only.

### Each original counterexample, on the old code and on the new

The checks that take a code directory ran unchanged against `faa7c09`'s `cloudflare/`, `server/` and `src/` (from `git archive faa7c09`), and fail there:

| Finding | Check | `faa7c09` | `b8d099a` |
|---|---|---|---|
| A day that reached 06:00 was rewritten by a rig change: unplugging the tank hose after the end took the final tank from 16 L to 40 L and pumped water from 24 L to 0, under the same run id (also after a JSON restore and for a late joiner). | `greenhouse-end-check.mjs` | **7/24** (1b–1i, 1k, 2b–2c, 3b–3c, 4a, 5a, 6a and 9a fail; `old-end-check.txt`) | 25/25 (in `npm-test.txt`) |
| A same-speed action every second for 240 s left the day at tick 0: sub-step time was discarded. | `greenhouse-time-check.mjs` | **0/5** (`old-time-check.txt`) | 5/5 |
| The local relay deleted an empty room: a day paused at tick 4 came back idle at tick 0. | `greenhouse-relay-check.mjs` (real sockets, real relay process) | **2/3** (`old-relay-check.txt`) | 3/3 |
| Peer tabs: a reset (run 2) and a concurrent step of run 1 both converged back to run 1 / tick 4. | `greenhouse-peer-check.mjs`, rule `stamp` (the old `SyncReplica.acceptTransform` LWW) vs `epoch` | **1/5**; 20 of 196 concurrent pairs end on an older run (`old-peer-check.txt`) | 5/5; 196/196 |
| A PF learner joining an already-ended room got notes unlocked, result run 1 and a personal test trace · a teammate's seed-7 reset was reported as my seed-11 reset (and the same for pause, resume, step, speed) · an erased saved explanation still read "brief met · explained" · a prediction changed after the result rewrote "You predicted" · focus was lost in the live connection list. | `greenhouse-panel-check.mjs` (the real panel bundled from source, in Chromium, with a scripted host) | **7/37** (`old-panel.txt`, `old-panel-results.json`) | 38/38 (`panel.txt`, `panel-results.json`) |

The old peer check uses the real `SyncReplica` with `faa7c09`'s acceptance rule. The old app has no hook that holds peer messages, so the real two-tab browser proof ran on the new apps only.

### Results on `b8d099a`

| Command | Result | Duration | Record |
|---|---|---:|---|
| `npm test` (typecheck, circuit 17,742, project 306, sync 858, rescue 17,751, diagram 66,886, sound 89,528 + 47, greenhouse model 2,835,645, **end 25/25, time 5/5, relay 3/3, peer 5/5**) | all passed | 131 s | `npm-test.txt` |
| `npx vite build` | OK; entry `./assets/index-ByYpp0um.js` | 9 s | `build.txt` |
| `greenhouse-panel-check.mjs` | **38/38** | 5 s | `panel.txt`, `panel-results.json` |
| **`e2e-greenhouse-worker.mjs`** (two makers + a late joiner, Worker; 960×640) | **40/40**, room G59F | 5,420 s | `e2e-greenhouse.txt`, `e2e-greenhouse-results.json` |
| **`e2e-greenhouse-fixes-worker.mjs`** (the corrections, two makers + a late joiner, Worker) | **11/11**, room G8ZT | 1,533 s | `e2e-greenhouse-fixes.txt`, `e2e-greenhouse-fixes-results.json` |
| **`qa-greenhouse-controls.mjs`** (3D controls, 1440 and 1280) | **33/33**, rooms Q63X, Q2YN | 2,993 s | `qa-greenhouse-controls.txt`, `qa-greenhouse-controls-record.json`, `qa-greenhouse-controls-overview-{1440,1280}.jpg` |
| **`qa-greenhouse-plug.mjs`** (all 14 ends by pointer, 1440 / 1280 / 960) | **7/7** | 2,581 s | `qa-greenhouse-plug.txt`, `qa-greenhouse-plug-record.json` |
| `e2e-greenhouse-peer.mjs` (two real tabs, reset vs step, both delivery orders) | **7/7** | 337 s | `e2e-greenhouse-peer.txt`, `e2e-greenhouse-peer-results.json` |
| `qa-greenhouse-compare.mjs` (the same cameras as the `faa7c09` capture) | 3 shots, no issues | 190 s | `qa-greenhouse-compare.txt`; images in [`../../images/episodes/greenhouse/compare/`](../../images/episodes/greenhouse/compare/) |
| `qa-greenhouse.mjs` (renders), attempt 1 | **failed** after 4 checks: the script chose a prediction after its own mid-day steps had begun attempt 1's day, which now fixes that attempt's prediction, so the choice was disabled and the script timed out. The app behaved as designed. | 1,402 s | `qa-greenhouse-attempt1.txt` |
| `qa-greenhouse.mjs` (renders), attempt 2: the script starts a new attempt there (a test-script change, committed with these records) | **12/12**, no issues: fill 0.914 at 1440 and 0.919 at 1280; phone *Start the day* reached by keyboard (44 px), no control under 44 px; PF without the worked example | 2,066 s | `qa-greenhouse.txt`, `qa-greenhouse-record.json`; renders in [`../../images/episodes/greenhouse/`](../../images/episodes/greenhouse/README.md) |
| `e2e-worker-sync.mjs` | 18/18, room STS5 | 3 s | `worker-sync.txt` |
| `e2e-cable-end.mjs` | 12/12, room WTKZ | 421 s | `cable-end.txt`, `cable-end-results.json` |
| `e2e-room-sync.mjs`, attempt 1 | **interrupted**: the container restarted during the run, closing its browser; no exit code | — | `room-sync-attempt1-interrupted.txt` |
| `e2e-room-sync.mjs`, attempt 2 | 13/13, room TTLZ | 666 s | `room-sync.txt` |
| `e2e-snapino-history.mjs`, attempt 1 | **failed, 24/25** (room HMZB): "changed parts + same running program … and on the importer" | 611 s | `snapino-history-attempt1.txt` |
| `e2e-snapino-history.mjs`, attempt 2 | **failed, 22/25** (room HSRZ): "Redo brings Q/T back on both peers", "its undo is exactly one step back to T", "and the parts stay as the room has them" | 761 s | `snapino-history.txt` |
| control: `e2e-snapino-history.mjs` on **`faa7c09`** (its own worktree, `dist/` and Worker), same environment, right after | **failed, 24/25** (room HNNQ), the same check as attempt 1 | — | `control-faa7c09-snapino-history.txt` |

**The Snapino history failures are not explained.** `faa7c09` passed this suite 25/25 before the container restarted. After the restart, `faa7c09` itself failed the same check as `b8d099a`'s attempt 1. So these runs show no difference between the two apps, but they do not prove that `b8d099a` is free of a Snapino regression either. The greenhouse changes touch the shared room code in one place: `RoomCore.handle` first settles a greenhouse day that is running past 06:00, which does nothing in a Snapino room, whose greenhouse day is idle. Attempts were bounded to two plus one control, and the cause was not established. The second correction round measured both candidate mechanisms and fixed the product path and the harness ([section 3 above](#3-snapino-history-the-harness-gap-and-the-late-answer-path)).

### The 3D controls on `b8d099a`, measured

Each control has a declared target: the centre of its knob. In the overview, with the brief's rig fully plumbed and wired:
- **Hittable area.** The whole 44×44 CSS px square around that centre shows the control as the first visible surface: 144 of 144 samples at a 4 px grid, for every control at both widths. No grab sphere or ring lies in front of it.
- **Plate sizes.** At 1440×900 the plates measure 67×68 (valve A), 67×67 (valve B), 63×62 (PUMP BELOW) and 63×63 px (FAN ABOVE). At 1280×720 they measure 58×59, 58×58, 54×54 and 55×54 px.
- **A grab sphere behind a plate.** At 1280, valve B's square has hose 4's grab sphere *behind* the plate at 3 of 144 samples. The visible plate is in front of it, and the app picks the frontmost visible surface.
- **Real clicks.** Clicks at five fixed points (the centre and ±15 px) each selected the part and focused the right field. Typed values were applied in the closed, middle and open poses, or the minimum, middle and maximum, and the centre still worked in each pose.
- **Nothing else moved.** A click or short drag on a control moved no line end, to the millimetre.
- **Running lock and drafts.** While the day ran, a 3D click locked the fields, kept the unapplied draft and sent nothing. After a pause, the draft applied.
- **The neighbouring hose end.** The hose end next to valve B was dragged out of its port and back by pointer.
- **Keyboard reach.** The fields reached from the 3D click are ≥ 44 px tall, and Tab moves on from them.
- **Plugging by pointer.** All 14 line ends were picked up and plugged by pointer at 1440, 1280 and 960 px, never under a control.

### Failed candidate `b9dde3c` (kept, not counted)

| Command | Result |
|---|---|
| `npm test`, build, panel 38/38, old-code counterexamples (as above) | all as on `b8d099a` |
| `qa-greenhouse-controls.mjs` | 33/33 (rooms QLHB, QJ2C, 4,581 s) |
| `e2e-greenhouse-peer.mjs`, `qa-greenhouse-compare.mjs` | 7/7; 3 shots |
| `e2e-greenhouse-fixes-worker.mjs`, `e2e-worker-sync.mjs`, `e2e-cable-end.mjs` | 11/11 (GU56), 18/18 (SUCD), 12/12 (WQZL) |
| **`e2e-greenhouse-worker.mjs`** | **failed**: "pointer-built rig" and "keyboard plumbing" failed, because cables 1 and 3 stayed loose after their pointer drags. The run was stopped by hand after 8 checks (6 passed, 2 failed). |

**Why it failed, reproduced.** The new sloped knob console covered the floor behind the controller, where the power cables' coils lay. At 960×640, cable 1's second end and cable 3's second end lay under the FAN ABOVE knob, its plate and its body. A press there picked the knob, the control in front, so the drag never started.
- `plug-probe-960-b9dde3c.txt` (a development probe) shows the first visible surface at each grab point: `farm-controller:control_plate` for cable 1's second end.
- `qa-greenhouse-plug.txt` ran the committed check on `b9dde3c`'s build at 960×640 and failed **1/3**, with the same two ends under the FAN ABOVE knob (`qa-greenhouse-plug-record.json`).
- `b8d099a` moves the coils to the floor in front of the plinth, below the sockets.

### Development runs before the commits (kept, not counted)

**Before `b9dde3c`** ([`dev-before-b9dde3c/`](dev-before-b9dde3c/)). These ran on the uncommitted working tree:
- **`dev-controls-1`** failed "no click or short drag … moved any hose or cable end". A drag on a fixture orbits the camera, and that version compared screen positions; the script now presses key 1 after each drag.
- **`dev-controls-2` and `dev-controls-3`** failed "valve B values … applied". The script pressed key 1 while the valve A field had focus, which typed "1" into it and left an invalid draft ("1100"). The form then refused the valve B edit with "Valve A: enter 0–100 %". The script now moves focus off the field first; the app keeps such a draft and names it, by design.
- **`dev-controls-4`** failed the same move check by 1–5 px: the overview framed slightly differently after the dock's tab changed. The check now compares each line end's world position to the millimetre.
- None of the four completed; each was stopped once its cause was known: `dev-controls-1` after 13 checks (12 passed), `dev-controls-2` after 9 (8), `dev-controls-3` after 6 (5), `dev-controls-4` after 28 (27).
- **`dev-fixes`** (11/11), **`dev-peer`** (7/7) and the **two probes** that measured the plates during the redesign passed.

**Before `b8d099a`** ([`dev-before-b8d099a/`](dev-before-b8d099a/)): `dev-plug` and `dev-plug-960` are pointer-plugging probes with the coils moved to the front floor. `dev-plug` completed at 1440 and then hit its own 2,400 s limit during 1280. `dev-plug-960` completed at 960.

## First submission, app `faa7c09`

| Command | Result | Duration | Record |
|---|---|---:|---|
| `npm test`: typecheck (`tsc --noEmit`), circuit 17,742, teachable agent, AI-teammate sync 19, project 306, Snapino self-check, sync 858, tools 36 + flow plan 12, rescue signal 17,751, episode sync 55, diagram 66,886, sound model 89,528, sound engine 47, **greenhouse model 2,835,644** | all passed | 103 s | `npm-test.txt` |
| `npx vite build` | OK; entry `./assets/index-BRy54_V2.js` | 10 s | `build.txt` |
| `npm run test:sound:dsp` | 101/101 | 12 s | `dsp.txt` |
| **`e2e-greenhouse-worker.mjs`** (two makers in separate browser processes plus a late joiner, Worker) | **40/40**, room GGNY | 6,213 s | `e2e-greenhouse.txt`, `e2e-greenhouse-results.json` |
| **`qa-greenhouse-controls.mjs`**, attempt 1 (first version: clicked each valve grip and dial centre) | **failed, 3/6** (room Q2R9). See below. | 910 s | `qa-greenhouse-controls-attempt1.txt`, `qa-greenhouse-controls-attempt1-record.json`, the script as it ran: `qa-greenhouse-controls-attempt1.mjs` |
| **`qa-greenhouse-controls.mjs`**, attempt 2 (the version committed in `063a024`, since replaced; kept as `qa-greenhouse-controls-attempt2.mjs`; same app) | **6/6** (room QEW5) | 478 s | `qa-greenhouse-controls.txt`, `qa-greenhouse-controls-record.json`, `qa-greenhouse-controls-valve-b-clicked.jpg` |
| **`qa-greenhouse.mjs`** (renders) | **12/12**, no issues | 3,286 s | `qa-greenhouse.txt`, `qa-greenhouse-record.json` (the same record as the renders folder's, with `.png` names); renders in [`../../images/episodes/greenhouse/`](../../images/episodes/greenhouse/README.md) |
| `e2e-sound-worker.mjs` (Episode 2) | 29/29, room SZSB | 3,566 s | `e2e-sound.txt`, `e2e-sound-results.json` |
| `e2e-worker-sync.mjs` | 18/18, room SALL | 3 s | `worker-sync.txt` |
| `e2e-cable-end.mjs` | 12/12, room WKZT | 430 s | `cable-end.txt`, `cable-end-results.json` |
| `e2e-room-sync.mjs` | 13/13, room T8ZV | 977 s | `room-sync.txt` |
| `e2e-snapino-history.mjs` | 25/25, room HQD4 | 847 s | `snapino-history.txt` |
| `e2e-ai-teammate-worker.mjs` | 10/10, room WCZL (refusal probe room V672) | 329 s | `ai-teammate-worker.txt`, `ai-teammate-worker-results.json` |
| `e2e-bench-inspector.mjs` | 30/30, room I9ZE, one attempt | 2,679 s | `bench-inspector.txt`, `inspector-results.json` |
| `e2e-rescue-signal.mjs` (Episode 1) | 60/60, room R7UZ, one bounded attempt | 3,500 s | `rescue-signal.txt`, `rescue-signal-results.json` |
| `qa-sound.mjs` (Episode 2 renders) | 7/7, no issues (fill 0.865 at 1440, 0.857 at 1280). Its images were not committed: the Episode 2 renders stay those of `63a3421`. | 1,865 s | `qa-sound.txt`, `qa-sound-record.json` |
| `e2e-ai-teammate.mjs` (peer) | 37/37 | 476 s | `ai-teammate-peer.txt` |

**Where the two tmpdir sidecars came from.** `cable-end-results.json` is the file `scripts/e2e-cable-end.mjs` wrote to `${tmpdir}/vm-e2e-cable-WKZT-results.json`; `ai-teammate-worker-results.json` is the file `scripts/e2e-ai-teammate-worker.mjs` wrote to `${tmpdir}/vm-e2e-ai-worker-WCZL/results.json`. Each was written in the same minute as its log, and each names the room in that log. They were copied unchanged (sha256 `9cd79205…` and `09cc8793…`); there was nothing to sanitize.

### 3D controls: what failed, and what the second version measures

The two-client run on `fe4fdf8` failed its check "clicking the valve B handle in 3D selects the manifold and focuses its valve B field" (39/40). That run recorded only the focus. The diagnosis afterwards found hose 4's brass fitting and its larger, invisible grab sphere around the valve grip, and `faa7c09` changed the app so that a valve lever or dial that is the first visible surface under the pointer wins over a grab sphere. **The two-client script was changed at the same time to click the controller's PUMP BELOW dial instead of the valve handle**, and passed 40/40 on `faa7c09`. So that run does not cover the valve handles.

`qa-greenhouse-controls.mjs` was written afterwards to cover them, on `faa7c09`, with the brief's rig fully plumbed and the overview camera at 1440×900:
- **Attempt 1** clicked each valve's grip and each dial's centre. Three of the four points showed something else in front: valve A's grip is behind the brass fitting of hose 3, valve B's behind that of hose 4, and the FAN ABOVE dial's centre behind power cable 3, which crosses the controller's face to CH2. Those clicks selected the hose or cable, as they should for what is in front. 3/6.
- **Attempt 2** (the script as committed in `063a024`, the same app) records what is in front of each grip or centre, scans an 81×81 px window around it, and clicks the nearest pixel where the control itself is the first visible surface. All four clicks selected the right part and focused the right field: 6/6.
- **The measured limit:** in that view, each control is the first visible surface at only 8–13 of 441 sampled pixels (a 4 px grid), so its exposed area is a few hundred square pixels, well below a 44 px target. In the overview of a plumbed rig, the 3D valve levers and dials are small targets partly covered by the fittings and the CH2 cable. The first gate rejected this as a quality-contract blocker; the correction round above replaced the controls.

## App `fe4fdf8` (previous candidate)

| Command | Result |
|---|---|
| `npm test`, build, `test:sound:dsp` | all passed |
| `e2e-greenhouse-worker.mjs` | **failed, 39/40** (room GP5D, 5,876 s): "clicking the valve B handle in 3D selects the manifold and focuses its valve B field", focus empty. The check recorded only the focus, not what the click picked. Every other check passed. |

No other suite was run on `fe4fdf8`.
