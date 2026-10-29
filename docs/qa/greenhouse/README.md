# Episode 3 · Resource-Limited Greenhouse — test records

These records come from a developer environment: headless Chromium (SwiftShader), wrangler dev on 8799, and the local access proxy on 8800 with `vm.test` mapped to 127.0.0.1. The machine has 2 CPU cores. **None of this is GitHub CI.** Every room was a fresh random QA room; the production room 7K3M was never used, and nothing was deployed.

The records were sanitized:
- scratch paths are replaced by `<scratch>`, other temporary paths by `<tmp>`;
- the per-connection ids after `host@example.test:` / `member@example.test:` are replaced by `<connection>`;
- Chromium's own stderr lines (`[pid=…]`) are dropped.

Logs are kept as `.txt`, because the repository ignores `*.log`. Nothing else was edited.

**App versus head.** The app under test is `faa7c09`. The commit that adds these records changes no app code (`src/`, `cloudflare/`, `server/`, `public/`): it adds the records, the renders, `scripts/qa-greenhouse-controls.mjs` (which ran from the worktree on `faa7c09`'s `dist/`), and corrects two comment lines at the top of `scripts/e2e-greenhouse-worker.mjs` so they describe what the script checks (the reset race's two accepted outcomes; the dial, not the valve handle).

## Which app each record covers

| Folder | App | Why it exists |
|---|---|---|
| [`app-faa7c09/`](app-faa7c09/) | **`faa7c09` (final)** | The app this PR asks to be reviewed. Every suite below ran on it, on a clean worktree at that commit, with its own `dist/`. |
| [`app-fe4fdf8/`](app-fe4fdf8/) | `fe4fdf8` | The previous app candidate. Its two-client run failed one check (below); `faa7c09` was made to fix it. Kept as a failed attempt, not counted. |

Each folder has a `summary.txt` listing every command in run order with its exit code and duration, and a complete text log per command. JSON sidecars are listed per row.

## Final app `faa7c09`

| Command | Result | Duration | Record |
|---|---|---:|---|
| `npm test`: typecheck (`tsc --noEmit`), circuit 17,742, teachable agent, AI-teammate sync 19, project 306, Snapino self-check, sync 858, tools 36 + flow plan 12, rescue signal 17,751, episode sync 55, diagram 66,886, sound model 89,528, sound engine 47, **greenhouse model 2,835,644** | all passed | 103 s | `npm-test.txt` |
| `npx vite build` | OK; entry `./assets/index-BRy54_V2.js` | 10 s | `build.txt` |
| `npm run test:sound:dsp` | 101/101 | 12 s | `dsp.txt` |
| **`e2e-greenhouse-worker.mjs`** (two makers in separate browser processes plus a late joiner, Worker) | **40/40**, room GGNY | 6,213 s | `e2e-greenhouse.txt`, `e2e-greenhouse-results.json` |
| **`qa-greenhouse-controls.mjs`**, attempt 1 (first version: clicked each valve grip and dial centre) | **failed, 3/6** (room Q2R9). See below. | 910 s | `qa-greenhouse-controls-attempt1.txt`, `qa-greenhouse-controls-attempt1-record.json`, the script as it ran: `qa-greenhouse-controls-attempt1.mjs` |
| **`qa-greenhouse-controls.mjs`**, attempt 2 (committed version, same app) | **6/6** (room QEW5) | 478 s | `qa-greenhouse-controls.txt`, `qa-greenhouse-controls-record.json`, `qa-greenhouse-controls-valve-b-clicked.jpg` |
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
- **Attempt 2** (the committed script, the same app) records what is in front of each grip or centre, scans an 81×81 px window around it, and clicks the nearest pixel where the control itself is the first visible surface. All four clicks selected the right part and focused the right field: 6/6.
- **The measured limit:** in that view, each control is the first visible surface at only 8–13 of 441 sampled pixels (a 4 px grid), so its exposed area is a few hundred square pixels, well below a 44 px target. In the overview of a plumbed rig, the 3D valve levers and dials are small targets partly covered by the fittings and the CH2 cable. The dock's fields (44 px, keyboard-operable) are the reliable way to set them; the 3D click is a shortcut. This is listed in the episode's limits.

## App `fe4fdf8` (previous candidate)

| Command | Result |
|---|---|
| `npm test`, build, `test:sound:dsp` | all passed |
| `e2e-greenhouse-worker.mjs` | **failed, 39/40** (room GP5D, 5,876 s): "clicking the valve B handle in 3D selects the manifold and focuses its valve B field", focus empty. The check recorded only the focus, not what the click picked. Every other check passed. |

No other suite was run on `fe4fdf8`.
