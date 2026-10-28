# Episode 2 · Sound Flow Studio — test records

These records come from a developer environment: headless Chromium (SwiftShader), wrangler dev on 8799, and the local access proxy on 8800 with `vm.test` mapped to 127.0.0.1. The machine has 2 CPU cores. **None of this is GitHub CI.** Every room was a fresh random QA room; the production room 7K3M was never used.

The records were sanitized:
- scratch paths are replaced by `<scratch>`;
- the per-connection ids after `host@example.test:` / `member@example.test:` are replaced by `<connection>`;
- Chromium's own stderr lines (`[pid=…]`) are dropped.

Logs are kept as `.txt`, because the repository ignores `*.log`. Nothing else was edited.

## Which app each record covers

| Folder | App | Why it exists |
|---|---|---|
| [`app-63a3421/`](app-63a3421/) | **`63a3421` (final)** | After the independent review of PR #5 and the follow-up review of `ad7fd3c`. |
| [`app-ad7fd3c/`](app-ad7fd3c/) | `ad7fd3c` | After the first review fixes (two blockers, two hardening items, inspector copy). |
| [`app-1eaf1dd/`](app-1eaf1dd/) | `1eaf1dd` | The app as first submitted in PR #5 (head `5e1a595`). |

Each folder has a `summary.txt` listing every command in run order, with its exit code and duration, a log for each command, and the browser tests' `results.json`.

## Final app `63a3421`

| Command | Result | Duration | Record |
|---|---|---:|---|
| `npm test` (typecheck, circuit 17,742, project 270, sync 858, tools 36 + flow 12, rescue signal 17,751, episode sync 55, diagram 66,886, **sound model 89,528**, **sound engine 47**) | all passed | — | `npm-test.txt`. Run on the working tree that became `63a3421`, before the commit, with nothing changed after it. |
| `npx vite build` | OK; entry `./assets/index-ChPnB4X3.js` | — | `build.txt` |
| `node scripts/sound-dsp-check.mjs` | **101/101** | — | `dsp.txt`, `dsp-record.json` |
| `e2e-sound-worker.mjs` (two makers plus a late joiner) | **29/29**, room SH3V | 3,632 s | `e2e-sound.txt`, `e2e-sound-results.json` |
| `e2e-worker-sync.mjs` | 18/18 | 3 s | `worker-sync.txt` |
| `e2e-cable-end.mjs` | 12/12 | 444 s | `cable-end.txt` |
| `e2e-room-sync.mjs` | 13/13 | 988 s | `room-sync.txt` |
| `e2e-snapino-history.mjs` | 25/25 | 1,142 s | `snapino-history.txt` |
| `e2e-ai-teammate-worker.mjs` | 10/10 | 384 s | `ai-teammate-worker.txt` |
| `e2e-bench-inspector.mjs`, attempt 1 | **not completed.** Killed by this harness's own 45-minute per-test limit (exit 124, 2,700 s) while taking the `04-view-top.png` screenshot at line 271. | 2,700 s | `bench-inspector-attempt1-limit.txt`, `inspector-attempt1-limit-results.json` |
| `e2e-bench-inspector.mjs`, attempt 2 (limit raised to 90 min; test and app unchanged) | **30/30**, room IWTT | 3,014 s | `bench-inspector.txt`, `inspector-results.json` |
| `e2e-rescue-signal.mjs` (Episode 1; one bounded attempt) | **60/60**, room RGZS | 4,047 s | `rescue-signal.txt`, `rescue-results.json` |
| `qa-sound.mjs` (renders) | **7/7**, no issues | 2,236 s | `qa-sound.txt`; renders in [`../../images/episodes/sound-flow/`](../../images/episodes/sound-flow/README.md) |
| `e2e-ai-teammate.mjs` (peer) | 37/37 | 521 s | `ai-teammate-peer.txt` |

**Bench-inspector attempt 1 is a partial prefix, not a pass.**
- **Passed before the kill:** 25 checks, from building the bench through "Top view: camera above the bench, columns left to right".
- **Not reached in that attempt:** the top-view screenshot itself, the table view, keys `4`/`1`/`F`, the renderer counters, and "no page errors".
- The last wait logged before the kill was "waiting for fonts to load". That proves neither that font loading took the 45 minutes nor any cause.
- Attempt 2 then ran the same unchanged test on the same app to completion: 30/30.

## App `ad7fd3c`

| Command | Result |
|---|---|
| `npm test` (sound model 89,722, sound engine 22) | all passed |
| `npx vite build` | OK |
| `sound-dsp-check.mjs` | 101/101 |
| `e2e-sound-worker.mjs` | **29/29** (room S8MD, 4,247 s) |

The other suites were run on `63a3421`, not on `ad7fd3c`. `63a3421` changed the room code again (cables the room has never stored), so the final app is the one they cover.

## App `1eaf1dd` (as first submitted)

| Command | Result |
|---|---|
| `npm test` (sound model 89,299), build, DSP 98/98, `qa-sound` 7/7, peer 37/37 | all passed |
| `e2e-sound-worker.mjs` | 29/29 (room SN2Y, 4,241 s) |
| `e2e-worker-sync`, `e2e-room-sync`, `e2e-cable-end` | 18/18, 13/13, 12/12 |
| `e2e-snapino-history`, attempt 1 | **failed.** 8 checks passed (P/S, import, Undo, Redo). Then the program-only import's confirmation dialog did not open within the test's 30 s, and the script aborted. The status line still showed the Redo. Cause not established. |
| `e2e-snapino-history`, attempt 2 | 25/25 |
| `e2e-bench-inspector`, attempt 1 | **stopped.** The background task holding the chain hit its 2-hour limit during the test (0/1 recorded, the browser was closed). |
| `e2e-bench-inspector`, attempt 2 | **failed**, 0/1. The host's click on `#load-field-test` completed ("click action done"), then Playwright waited for scheduled navigations and hit its 300 s limit. Cause not established. On `63a3421` the same step passed in both attempts. |
| `e2e-ai-teammate-worker` | 10/10 |
| `e2e-rescue-signal` | not run on this app (it was run once, on `63a3421`) |

## Two-client attempts during development (before `3698dc5`)

The script is `node --experimental-strip-types scripts/e2e-sound-worker.mjs http://vm.test:8800 <dir>`. Each check records its time, the acting maker, and the room revisions each client held.

| Attempt | App code | Room | Result | What went wrong, and what changed |
|---|---|---|---|---|
| 1 | Uncommitted tree after `340ce2b` (desk and dock in progress) | SC4T | 5/7, then stopped | The host's keyboard Source edit (220 Hz sawtooth) never reached the room; the member still had 440 Hz sine. The run was then killed at the background task's 30-minute default limit. |
| 2 | Same tree, test viewport 800×544 | SKXR | 2/4, then stopped | At 800×544 the last plug (blue → Speaker IN) was released off the jack, so `snd-cable-c` stayed `[4, null]` for both. **A test-geometry problem**: the viewport went back to 1000×700. |
| 3 | Tree with the dock fixes | S4Z5 | 5/8, then stopped | The Source edit failed again: the tools said "Set Source to sine 440 Hz", that is, the old values. The member's draft check failed as a consequence. |
| 4 | Same, with a focus trail added to the test | SYQM | 5/7, then stopped | The tools now named the new values but nothing changed in the room. **Root cause:** `edit-history.sameTransform` compared only some props, not the Sound knobs, so the workbench tools saw "nothing to change". Fixed in `3698dc5` (all prop keys compared), with a regression check. |
| 5 | Tree before `3698dc5` was committed | SF9B | 15/16 | Every scenario check passed. "Run completed" failed on a strict-mode selector clash: `[data-speaker]` also matched chat messages. The speaker switch's attribute was renamed to `data-speaker-switch`. |
| 6 | `3698dc5` | SC95 | **29/29** | — |

Records: `e2e-attempt{1..6}-results.json` and `e2e-attempt{1..6}-run.txt`.

**Correction.** An earlier version of this README (commit `5e1a595`) pointed to `-run.log` and `final-*.log` files. Those files were never committed, because `*.log` is git-ignored. They are now committed as `.txt`.
