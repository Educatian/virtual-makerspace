# Snapino bench reference-quality upgrade: test and render evidence

Developer environment:
- headless Chromium 1194 with SwiftShader software WebGL;
- wrangler dev with `scripts/access-proxy.mjs` for the Worker runs;
- 2 CPU cores.

These are **not GitHub CI** runs; the repository's only GitHub check is GitGuardian. Every test room was a fresh random QA room. In the historical runs below, the AI-worker refusal probe used the code 7K3M on the *local* wrangler Worker (not production); since `c418a85` it uses a fresh random room. Draw calls and triangles are renderer counters, not frame rates.

Design, provenance and the REA blocker: [`../../reference-benchmark.md`](../../reference-benchmark.md).

This file has two parts:
- **[Current: the follow-up to the re-review of `ad5cac6`](#current-the-follow-up-to-the-re-review-of-ad5cac6)**: the last fixes and what was retested for them.
- **[The re-review of `563c645`](#the-re-review-of-563c645-current-for-the-code-it-covers)**: the runs for the code they cover, with every attempt.
- **[Historical: before the re-review](#historical-before-the-re-review)**: the earlier results, unchanged.

## Current: the follow-up to the re-review of `ad5cac6`

**Final application code: `6cd66df`.** It changes `ai-teammate.ts`, `main.ts` (one host callback), `scene.ts` and `workbench-tools.ts` (flow note), and adds `flow-plan.ts`. Records: [`rereview2/`](rereview2/).

| Item | What changed | Evidence |
|---|---|---|
| **P2 · Bolt's false completion from a stale host board** (predates `10ed709`; the part lock did not cover it) | Before planning, a build waits, bounded at 8 s, until the host's board has applied every room revision Bolt's own connection has seen. If it has not, Bolt does not plan and stays unconfirmed (`builtByBolt`/`workDone` false). It retries 3 times, 3 s apart, then asks a person to check the board. (`346f1bd`) | New `scripts/ai-teammate-sync-check.mjs` (in `npm run test:agent`): the real `AiTeammate`, a real `DesktopRoom` each for Bolt and the host over simulated WebSockets, and the real SyncReplica, planner and RoomCore, on a virtual clock. **A:** the host's copy arrives 2.3 s late. There is no false match, and the newest build puts the resistor back at [138,141] and says "Done." (0 skipped). **B:** the host's copy never arrives. Bolt does not plan, says neither "Done." nor "already matches", and asks a person. 19 checks ([log](rereview2/ai-teammate-sync-check-fixed.txt)). **The same harness on the `10ed709` code fails at A** with "The board already matches how I'd build it." ([log](rereview2/ai-teammate-sync-check-on-10ed709-code.txt)). |
| 15 s part-lock bound (a known limit, not a confirmed failure) | On that bound a build no longer moves past an unsettled move: it stops unconfirmed, and later builds still wait for that move. | **Not exercised by a test.** With one WebSocket per participant, the older move's acknowledgement reaches Bolt before anything that could start a newer build, so no transport-faithful schedule reaches the bound. Strict serialization in every case is not claimed. |
| Bolt's skip messages | "Someone was holding a part" now means only a held or refused claim. A timed-out claim or a refused release says "the room didn't confirm one of my moves". A build with skips is saved as "built part of its plan". (`346f1bd`) | Source; build-log reasons |
| **P3 · small current called zero** | `planFlow` (`src/desktop/flow-plan.ts`): currents of at least 100 µA are drawn as before. Currents from 1 nA to 100 µA are listed as "too small to draw (not zero)", with their values. Open, short, no-supply and unsolved cases are unchanged. (`6cd66df`) | New `scripts/flow-plan-check.mjs` (in `npm run test:tools`), 12 checks on real solves. They include the exact bench (battery [21,23], 100 kΩ [36,39], red LED [53,54], red jumper [70,68]: 70.99 µA, solver OK) ([log](rereview2/flow-plan-check.txt)). |
| Clock checks | Each 250 ms clock check now also requires both samples to be non-null with round trips of at most 400 ms, and the host's clock waits for such a sample too. There are no new checks; the count stays 59. (`14d9517`) | Not rerun in the browser. In the last run (attempt 12) the samples were 29/7 and 19/3 ms. |
| Wording | The snapino-history attempt-1 cause is now marked unknown. The irregular light "reduces" aliasing rather than making it impossible. Bolt's 9/10 is a reproduced mechanism, not proof of the original event. The two-client captions no longer claim a visible panel. The PR's PF/DI text is corrected. | Documents |

**Retested on `6cd66df` / `14d9517`:**
- `npm test`, all passed: typecheck; circuit 17,742; agent including the new sync check (19); project 270; snapino; sync 858; tools 36 plus flow 12; rescue signal 17,751; episode sync 55; diagram 66,886 ([log](rereview2/npm-test-14d9517.txt)). `npm run build` OK ([log](rereview2/build-14d9517.txt)).
- `e2e-ai-teammate-worker.mjs` (browser, Worker), two runs: **10/10 and 10/10**. Both ended "Done." with 0 skipped, and no build was held back by the new gate ([1](rereview2/ai-worker-run1-14d9517.txt) ([json](rereview2/ai-worker-run1-14d9517-results.json)), [2](rereview2/ai-worker-run2-14d9517.txt) ([json](rereview2/ai-worker-run2-14d9517-results.json))).
- `e2e-ai-teammate.mjs` (browser, peer room): **37/37** ([log](rereview2/e2e-ai-teammate-peer-14d9517.txt)).

**Not rerun (code unchanged since `10ed709`, results stay attributed to it):** rescue, inspector, worker-sync, room-sync, cable, snapino-history, qa-reference and qa-episode.

**`e06` (running transmission), one bounded capture-only attempt:** `scripts/qa-e06-running.mjs`, a legal 115 s QA light, no paused or faked clock.
- **It did not succeed.** By the time the transmit click had been answered and Stop was shown, the light was 38.7 s in. The 1440×900 screenshot then took 75.3 s, ending at 126.4 s of 115 s, so the shot could not be proven to show the running, lit round. The same `tx` was seen before and after.
- The `dc51187` `e06` stays, marked ([record](rereview2/qa-e06-running-attempt-record.json), [log](rereview2/qa-e06-running-attempt.txt)).

## The re-review of `563c645` (current for the code it covers)

**These runs were on application code `10ed709`** (or `52cc67c` where noted). Since then `6cd66df` changed Bolt's planning and the flow note; see the follow-up above for what was retested. Built and unit-tested at that commit: [build](rereview/build-10ed709.txt), [`npm test`](rereview/npm-test-10ed709.txt).

The application commits of this re-review:

| Commit | What |
|---|---|
| `997412d` | **A.** A 5V light that a bench change cuts off is "recorded up to the cut", never "stays on". |
| `841885d` | **D.** One selection-tone contract for the 3D rings and the diagram; optional Snapino logical-drive view. |
| `1c13a95` | **D.** Circuit Bench meter in the dock inspector; optional solved-current view; compact phone chrome. |
| `8205d51` | **D.** The phone's tool row no longer widens the page (a 20 px horizontal overflow found by the new phone check). |
| `52cc67c` | A `?qa`-only hook that stops or resumes drawing a page (test budget on this machine; see "Why the browser tests changed"). |
| `10ed709` | **C.** Bolt moves one part at a time across builds. This fixes a mechanism with the earlier 9/10's symptom, reproduced by the diagnostic set below; the original run's own cause stays unknown. |

### Results on the final application code

| Suite | Tests at | Result | Record |
|---|---|---|---|
| `npm test`: typecheck, circuit 17,742, agent, project 270, snapino, sync 858, tools 36, rescue signal 17,751, episode sync 55, diagram 66,886 | `10ed709` | all passed | [record](rereview/npm-test-10ed709.txt) |
| `npm run build` | `10ed709` | OK | [record](rereview/build-10ed709.txt) |
| `e2e-rescue-signal.mjs` (two makers plus a late joiner, Worker + Durable Object) | `27eea0c` | **60/60**, attempt 12 of 12 (all below) | [log](rereview/rescue-attempt12-tests-27eea0c.txt), [results](rereview/rescue-attempt12-tests-27eea0c-results.json) |
| `e2e-bench-inspector.mjs` (two makers, real pointer and keyboard) | `10ed709` | **30/30**, attempt 3 of 3 | [log](rereview/inspector-attempt3-tests-10ed709.txt) |
| `e2e-ai-teammate-worker.mjs`, three runs | `10ed709` | **10/10, 10/10, 10/10**, each ending "Done." with 0 skipped. Before the Bolt fix: 9, 8 and 9 of 10 (see C) | [1](rereview/ai-worker-after-fix-run1.txt), [2](rereview/ai-worker-after-fix-run2.txt), [3](rereview/ai-worker-after-fix-run3.txt) |
| `e2e-ai-teammate.mjs` (peer) | `10ed709` | 37/37 | [log](rereview/e2e-ai-teammate-10ed709.txt) |
| `e2e-worker-sync.mjs` | `10ed709` | 18/18 | [log](rereview/e2e-worker-sync-10ed709.txt) |
| `e2e-snapino-history.mjs` | `f266066` | 25/25, attempt 2. Attempt 1 (`10ed709`): 24/25, "import Q/T reaches both peers" failed without detail; its cause is unknown (a page applying the room's state after the 60 s limit is plausible, not proven). The check now waits (bounded) for each page and says what each held | [2](rereview/e2e-snapino-history-attempt2-tests-f266066.txt), [1](rereview/e2e-snapino-history-attempt1-10ed709.txt) |
| `e2e-room-sync.mjs` | `10ed709` | 13/13 | [log](rereview/e2e-room-sync-10ed709.txt) |
| `e2e-cable-end.mjs` | `10ed709` | 12/12 | [log](rereview/e2e-cable-end-10ed709.txt) |
| `qa-episode.mjs` (Episode 1 captures, one maker, peer room) | `3014a8a` | 12 of 13 captures renewed, no other issue (bulb 193.3 lit vs 158.0 unlit). **Issue in both attempts:** the running-transmission shot `e06` was reached only after the 110 s flash ended (151.7 s, then 116.3 s after the shot was moved first, `88a31e2`), so the `dc51187` `e06` is kept and marked | [2](rereview/qa-episode-attempt2.txt) ([stats](rereview/qa-episode-attempt2-stats.json)), [1](rereview/qa-episode-attempt1.txt) ([stats](rereview/qa-episode-attempt1-stats.json)) |
| `qa-reference.mjs after`: composition, 1440/1280 layouts, phone interaction (390×844), Circuit Bench meter and flow, PF/DI | `3014a8a` (`QA_SKIP_SAME=1`) | **33/33** checks, 14 images. Phone: the bench starts at 192 px, the dock's tab row at 775 px of 844; wheel scrolling of 450 px reaches the dock, pointer clicks on the Inspector tab and a diagram rung work, and ArrowRight moves across the inspector's tabs. Attempt 1 (`88a31e2`) captured the four same-camera shots with counters identical to the earlier after-build (687/104,890, 351/82,170, 405/87,810, 333/81,218), then was killed by a container restart; attempt 2 stopped at the near-top same-camera shot (page not ready within 900 s). Attempt 3 left the same-camera set out | [log](rereview/qa-reference-after-10ed709.txt), [report](rereview/qa-reference-after-10ed709-report.json); [1](rereview/qa-reference-attempt1-killed.txt) ([counters](rereview/qa-reference-attempt1-killed-same-camera-report.json)), [2](rereview/qa-reference-attempt2-not-ready.txt) |

### Every attempt, in order

Nothing below was rerun until green without a change: each attempt after a failure ran a changed test (or, where marked, the same test again), and each change is its own commit.

**`e2e-rescue-signal.mjs`** (the strengthened provenance tests, item B):

| # | App | Tests | Result | What failed, and what changed next |
|---|---|---|---|---|
| 1 | `8205d51` | `8205d51` | stopped at the late join, 50 passed, 1 failed | **Aliasing.** After the reconnect, 7 fresh frames of round 6, all lit: a strictly periodic 9 s light sampled by a page drawing about every 9 s. The earlier passes could count frames drawn before the reconnect: the false positive the reviewer named. Then the late joiner had no room state within 300 s and the script crashed (`TypeError`). Next: irregular on/off phases (`2a02707`). [Log](rereview/rescue-attempt1-tests-8205d51.txt) |
| 2 | `8205d51` | `2a02707` | stopped at the late join, 49 passed, 2 failed | The reconnect check now **passed** with the irregular light (3 fresh frames, lit and dark). Round 5 still used the periodic light and aliased the same way (5 frames, all lit). The role check read the member's view before its slow page had applied the claim. The late join crashed as in 1. Next: `b96462a`, `916736b`, `21ebbdf`. [Log](rereview/rescue-attempt2-tests-2a02707.txt) |
| 3 | `8205d51` | `21ebbdf` | stopped in round 1 (4 passed) | Every maker in its own browser process. The receiver's page froze for 120 s (SwiftShader linking the lit lamp's program the first time), and round 1 (14.8 s) ended before "Receiver's view" could be pressed. [Log](rereview/rescue-attempt3-tests-21ebbdf.txt) |
| 4 | `8205d51` | `e22b7a7` | 56/60 | Host and member in one browser again, the joiner in its own. **The late join now worked:** in at 55 s of 107.5 s, 11 fresh frames, lit and dark. Failed: the sender drew no frame in round 1; the reconnect saw 3 fresh frames, all dark; no pixel pair; the joiner's best clock round trip was 1328 ms. [Log](rereview/rescue-attempt4-tests-e22b7a7.txt) |
| 5 | `8205d51` | `95fc44a` | stopped in round 1 (4 passed) | Smaller pages (800×544). The same 120 s shader stall as in 3. Next: a lamp warm-up before round 1 (`c983374`). [Log](rereview/rescue-attempt5-tests-95fc44a.txt) |
| 6 | `8205d51` | `c983374` | stopped after round 6, 37 passed, 2 failed | The sender drew no frame in round 1, because a screenshot inside the round held the shared GPU process (`e18e5b3`). The open-circuit round (10 s) gave the receiver no frame (`cd1fc9a`). The script crashed when the light ended between "still running" and the Stop click (`42733f0`). [Log](rereview/rescue-attempt6-tests-c983374.txt) |
| 7 | `8205d51` | `42733f0` | timed out at 70 min, 45 passed, 4 failed | Reconnect: back in round 6 only at 97 of 107.5 s, so no fresh frame fit (`8b9595a`). No pixel pair. Round 8's edit and round 9's import both landed after their lights had ended. This led to the render-cost measurements below and to `52cc67c` / `8243ec8`. [Log](rereview/rescue-attempt7-tests-42733f0.txt) |
| 8 | `52cc67c` | `8243ec8` | 54/60 | Fresh frames after the reconnect **passed** (3, lit and dark). Failed: round 1 sender (no frame); the reconnect clock (best round trip 7446 ms while drawing); no pixel pair; rounds 8/9 edits too late; the role-swap view race. Next: `507e5b0`, `cbe0c5f`, `129b689`, `97c78b6`. [Log](rereview/rescue-attempt8-tests-8243ec8.txt) |
| 9 | `52cc67c` | `97c78b6` | 59/60 | Only the late joiner's clock failed: it was compared on a 756 ms sample whose own error bound (378 ms) is above the 250 ms asserted, and it was 377 ms off. Next: compare only samples with round trips of at most 400 ms (`fdfee0a`). [Log](rereview/rescue-attempt9-tests-97c78b6.txt) |
| 10 | `52cc67c` | `fdfee0a` | **60/60** (59 checks plus the count check) | The first full pass. [Log](rereview/rescue-attempt10-tests-fdfee0a.txt), [results](rereview/rescue-attempt10-tests-fdfee0a-results.json) |
| 11 | `10ed709` | `f266066` | 59/60 | The same test again, on the final app (Bolt's fix only). The receiver drew no frame in round 1's 14.8 s message; its diagnostics show a frame every ~11 s and one 17.8 s gap. Next: round 1's message is followed by 30 s dark (`27eea0c`); the message is unchanged. [Log](rereview/rescue-attempt11-tests-f266066.txt), [diagnostics](rereview/rescue-attempt11-round1-receiver-no-frames.json) |
| **12** | **`10ed709`** | **`27eea0c`** | **60/60** | The final app and the final test. [Log](rereview/rescue-attempt12-tests-27eea0c.txt), [results](rereview/rescue-attempt12-tests-27eea0c-results.json) |

**`e2e-bench-inspector.mjs`** (two makers, real pointer and keyboard):

| # | App | Tests | Result | Notes |
|---|---|---|---|---|
| 1 | `8205d51` | `8205d51` | stopped by the 40 min limit after 24 of 24 checks had passed | One shared browser. [Log](rereview/inspector-attempt1-tests-8205d51-timeout.txt) |
| 2 | `52cc67c` | `fdfee0a` | 30/31 | Separate browser processes. The setup check failed: it also required the host's own answer to the layout edit, which timed out on the slow page although the room accepted the edit (every later check passed on that bench). The check now reads the room's state as the member received it, and records the host's answer (`7673526`). This is the one assertion in this re-review that was relaxed, and it is a setup step, not a behaviour under test. [Log](rereview/inspector-attempt2-tests-fdfee0a.txt) |
| **3** | **`10ed709`** | **`10ed709`** | **30/30** | The host's answer was `true`. The number of checks varies by one with the number of concurrent-flip attempts the stale test needs. [Log](rereview/inspector-attempt3-tests-10ed709.txt), [results](rereview/inspector-attempt3-tests-10ed709-results.json), [stale attempts](rereview/inspector-attempt3-tests-10ed709-stale-attempts.json), [renderer counters](rereview/inspector-attempt3-tests-10ed709-render-stats.json) |


### What the strengthened rescue test checks now (item B)

- **Provenance.** Every probe frame carries the transmission id (`tx`) and the page's capture time. A frame counts only for its own transmission, and with a boundary only if captured after it.
- **Reconnect.** The receiver's socket is dropped during a 107.5 s light with irregular phases (2.5–5 s; this reduces aliasing with a steady frame period, it does not make it impossible). As soon as the reconnect is confirmed (online, no role, in round 6), the log is drained and a boundary is set. Only frames of round 6 captured after it count, and they must include lit **and** dark, all agreeing with the timeline. Attempt 12: back at 35 of 107.5 s; 3 fresh frames, 1 lit, 2 dark; clocks 14 ms apart. The role is retaken and the clocks compared (within 250 ms) afterwards.
- **Late join.** The joiner's page and lobby are opened before the light starts. Unconditionally, with bounded waits: it joins during the light (attempt 12: at 35 of 107.5 s, same `tx`), logs lit **and** dark frames of that transmission (10 frames: 3 lit, 7 dark), and its clock agrees with the sender's within 250 ms (Δ 8 ms; round trips 19 / 3 ms). A missing state is a failure with a reason, never a crash.
- **A fixed count.** The run must execute exactly 59 checks.
- **The QA lights are slow on purpose** so that this machine can sample them. They say nothing about timing on real devices.

### Why the browser tests changed, and what that does not change

Measured on this machine with [`scripts/qa-render-cost.mjs`](../../../scripts/qa-render-cost.mjs) (records in [`rereview/`](rereview/)). These are rough relative counts, not frame rates:

| Pages (Snapino, workshop open, lamp seated) | Frames per page | Draw calls |
|---|---|---|
| 1 page, 1000×680, `a9fefef` | 15 in 99 s | 533 |
| 1 page, 1000×680, `8205d51` | 14 in 94 s | 533 |
| 2 pages, one browser, 1000×680, `a9fefef` | 7 and 7 in ~112 s | 533 |
| 2 pages, one browser, 1000×680, `8205d51` | 7 and 7 in ~112 s | 533 |
| 2 pages, one browser, 800×544 | 15 in 96 s and 5 in 133 s (uneven) | 303 |
| 2 pages, separate browser processes, 800×544 | 9 in 97 s and 10 in 107 s | 303 |
| 2 pages, one browser, 800×544, the second not drawing (`?qa` hook) | 17 in 94 s | 303 |

- **Not an app regression.** The upgrade (`8205d51`) draws as many frames as the build before it (`a9fefef`). The machine is slower than when the earlier runs passed (then a late joiner entered in 19 s).
- **Where the time goes.** A CPU profile of an idle page ([`profile-idle.json`](rereview/render-profile-idle.json)) spent 39.6 of 43.2 s in native calls, i.e. waiting for SwiftShader, and drew 9 frames in 40 s.
- **What the tests do about it:**
  - each maker in its own browser process;
  - 800×544 maker pages;
  - a lamp warm-up before round 1;
  - screenshots outside timed rounds;
  - where only one page's frames are checked, and while clocks are sampled, the other pages stop drawing through the `?qa` hook (their room traffic and clocks keep running).
- **No frame, clock or provenance assertion was weakened.** One temporary relaxation (`95fc44a`, a stated-error bound for the joiner's clock) was removed again in `cbe0c5f`; the clock checks now also require samples whose own error is below the 250 ms they assert (`fdfee0a`). The inspector's setup check is the one relaxed assertion (see above).
- **The tests also gained:** bounded waits for each client's own view, the provenance and fixed count above, and reasons on failure.
- **Freezing pages through the browser's page-lifecycle control did not help** (the joiner then needed 712 s); [probe](rereview/probe-freeze-pages.txt). [Separate processes](rereview/probe-separate-browsers.txt) did.

### A: the 5V lamp cut off by a bench edit

Before: a 5V lamp `[14,32]` with wire `[32,15]` and a 1000 ms wait, cut at 300 ms by an accepted bench edit that removes the lamp, was diagnosed as "stays on afterwards", and the strip said "still lit after the transmission". The recording holds the old bench, so it cannot know what the changed bench did.

Now (`997412d`, unit checks in `scripts/rescue-signal-check.mjs`, 17,751 checks in all):
- **Lamp removed / path opened by the edit:** the pulse is recorded from 0 to 300 ms and marked `unrecorded` after that. There is no falling edge and no "continues". Decode gives `?` with reason "unended", as before. The diagnosis says "lit at the cut": the recording ends there, and what the changed bench did next is not part of it. It never says "stays on afterwards" or "switched off". The strip says "a bench change cut the recording off (not recorded after that)".
- **Unchanged 5V wiring at the natural end:** still "continues", and the strip still says "still lit after the transmission ended".
- **D-pin lamp cut by a bench change:** the pins go LOW at the cut, so the pulse really ends at 300 ms.
- **Stop, a program change, an emptied room, a reset:** the bench is unchanged, so the 5V light continues, as before.

### C: evidence

- **Records.** Every record is committed as `.txt` or `.json` (`*.log` is ignored by git). Every relative link in these documents was checked at the final remote commit (see the PR).
- **Bolt (Circuit Bench AI teammate).** A mechanism that produces the earlier 9/10's symptom (no "Done.") is **reproduced and fixed**. The original `a9fefef` run kept no record, so whether this was its cause cannot be known; the diagnostics support the mechanism, not that event.
  - **The diagnostic set:** three runs on `7673526` / `c418a85`, before the fix, each keeping Bolt's lines, every part's claim and release outcome, and the final bench.
    - **Runs 2 and 3 reproduced the missing "Done.".** A newer build (run 4) started while a superseded build (run 3) was carrying the battery. The room client keeps one hold per part, so run 3's release came back refused, and so did run 4's own release of the battery. Bolt counted the battery as skipped and said "Someone was holding a part, so I left it". Yet the final bench had the battery where the plan put it, and the circuit lit safely.
    - **Run 1 did not hit the race.** It said "Done.".
  - **A test bug in the same set.** "Worker refuses an AI teammate whose host isn't in the room" failed in runs 1 and 2. The fresh random probe room (replacing 7K3M, `6c14f4c`) did not exist, so the Worker answered 404 before its host-presence rule could answer 403. The probe room is now created by the local admin and left empty (`c418a85`). Run 3 already used that version: 403.
  - **The fix** (`10ed709`): one part move at a time across builds; a newer build waits, bounded at 15 s, until the move in progress is released.
  - **After the fix:** three runs on `10ed709`, all 10/10, all ending "Done." with 0 skipped. In run 2 the same overlap happened (run 4 started during run 3's battery move), and both releases were accepted.
  - Records: before the fix [1](rereview/ai-worker-before-fix-run1.txt) ([json](rereview/ai-worker-before-fix-run1-results.json)), [2](rereview/ai-worker-before-fix-run2.txt) ([json](rereview/ai-worker-before-fix-run2-results.json)), [3](rereview/ai-worker-before-fix-run3.txt) ([json](rereview/ai-worker-before-fix-run3-results.json)); after the fix [1](rereview/ai-worker-after-fix-run1.txt) ([json](rereview/ai-worker-after-fix-run1-results.json)), [2](rereview/ai-worker-after-fix-run2.txt) ([json](rereview/ai-worker-after-fix-run2-results.json)), [3](rereview/ai-worker-after-fix-run3.txt) ([json](rereview/ai-worker-after-fix-run3-results.json)).
- **Probe room.** `e2e-ai-teammate-worker` refuses any origin other than `vm.test`, `localhost` or `127.0.0.1`. Its unaffiliated-connection probe uses a fresh random room that differs from the test room, never 7K3M.
- **REA.** The raw outputs, exit codes, full SHA-256 hashes and commands are in [`rea-evidence/`](rea-evidence/README.md). REA remains **[blocked]**: the environment's egress proxy refuses the target (`CONNECT … 403`), and nothing was retried unchanged or routed around it.

### D: presentation scope

- **Circuit Bench meter in the dock inspector** (`1c13a95`). Readings, the selected part's leads, and the real resistor and supply editors now sit in the dock's Inspector tab, not over the scene. The editors keep the room path: authority, refusals and Undo. The "never re-render under the cursor" draft guard is unchanged, and so are PF/DI and the curved-wire detail. No numeric controls were invented for fixed Snapino parts. `qa-reference` checks that a 3D selection opens it in the dock, and that a preset edits the real resistor through the room and Undo restores it.
- **One selection-tone contract** (`841885d`, `src/desktop/selection-style.ts`). The 3D rings, the diagram's rows and the legend and pinout all share it:
  - A: amber, solid, letter `A`;
  - B: cyan, dashed, letter `B`;
  - both ends on one net: red, double, `!`.
  
  Colour is never the only cue: each tone has a ring pattern, a letter badge and text. Checked by:
  - `e2e-bench-inspector`: every ringed stud's 3D tone equals its diagram row's tone, with the A/B badges;
  - `snapino-diagram-check`: tones, badges and CSS variables.
- **Optional flow views, off by default:**
  - **Circuit Bench, solved current.** Arrows ride each carrying jumper's own curve, in the sign of the DC solver's reading (positive means end A to end B). The speed is log-scaled and labelled "not to scale". The arrows stand still under reduced motion, are hidden when the studio changes and are disposed with the scene.
  - **No arrows** for a short, an open loop, no supply or an unsolvable circuit; a labelled note says which. `qa-reference` checks solved, short, open and off, with and without reduced motion.
  - **Snapino, logical drive.** A dashed source-to-GND path on running loads, labelled on screen "Show logical drive (source → GND, not current)", with a note that it is "the bench model's on/off decision, not measured current or amperage". It is never drawn through a shorted bench. It is compared with the independent oracle on every random bench.
- **Phone (≤ 620 px).** One studio-and-parts row and one scrollable tool row; the bench starts at about 192 px, and the dock's tabs are on the first screen. The page scrolls **vertically** by design: the earlier "no page scroll" was wrong and now reads "no horizontal overflow". The new phone check found a 20 px horizontal overflow, fixed in `8205d51`. `qa-reference` uses real wheel scrolling, pointer clicks (Inspector tab, a diagram rung) and the keyboard (ArrowRight across the inspector's tabs), and captures the first screen, the inspector with a part selected, the 3D view selected, and the folded workshop. No touch input was tested.

### Images

All under [`../../images/reference-upgrade/`](../../images/reference-upgrade/), captured on `10ed709` unless noted:
- `after-phone-first-screen`, `after-phone-inspector-selected`, `after-phone-3d-selected`, `after-phone-workshop-folded`: the phone inspector reached by scrolling, a part selected in it and in 3D, and the folded workshop;
- `after-circuit-meter-docked`, `after-circuit-flow`: the Circuit Bench meter in the dock, and the solved-current view;
- `after-inspector-1440/1280`, `after-inspector-pinout-card`, `after-inspector-behaviour-card`, `after-top-preset-1440`, `after-composition-1440-workshop`, `after-diagram-PF/DI-bypassed`;
- `inspector-01`…`05`: the two-maker run (attempt 3), with the A/B tone rings and badges;
- `rereview-same-01`…`04`: the same-camera set from qa-reference attempt 1 on `10ed709`.

From earlier builds, kept:
- `compare-*`: the before/after pairs of `dc51187`; the re-review's same-camera counters are identical to their after side;
- `after-inspector-390`: the old phone chrome, superseded by `after-phone-*`.

## Historical: before the re-review

The results below were reported for `dc51187` / `a9fefef` and are kept as they were. Two statements in them are superseded:
- "no page scroll" at 390 px: the phone page scrolls vertically by design; the check is "no horizontal overflow" (see the current part).
- "an animated current-flow view, which does not exist": the Circuit Bench now has an optional solved-current view, and Snapino an optional logical-drive view.

### Commits

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

### Results

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

### What the browser tests proved then, and what they did not

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

### Renderer counters (SwiftShader, last frame)

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

### Images

All under [`../../images/reference-upgrade/`](../../images/reference-upgrade/):
- `compare-*`: before and after side by side, at the same camera and viewport, plus the two builds' own default compositions;
- `after-*`: the final build at 1440, 1280 and 390 px; the Top view; PF vs DI on a bypassed lamp; the Pinout and Behaviour cards;
- `inspector-*`: the two-browser run.
