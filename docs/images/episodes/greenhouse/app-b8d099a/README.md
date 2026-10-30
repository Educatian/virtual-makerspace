# Episode 3 · Resource-Limited Greenhouse — renders of the first correction round (`b8d099a`)

> These are the renders of app `b8d099a`, which the review of `d06712c` kept blocked. They were moved here, unchanged, when the second correction round's renders (app `abd2f51`) took their place in [the folder above](../README.md). The same-camera pairs stay in [`../compare/`](../compare/).

**App code:** `b8d099a`, the app of the correction round after the first gate, built with `npx vite build` in a worktree exactly at that commit, with its own `dist/`. `record.json` names it. The renders of the first submission, `faa7c09`, are in [`app-faa7c09/`](../app-faa7c09/README.md). Same-camera before/after pairs are [below](#before-and-after-the-same-cameras).

**Where:** a developer environment (headless Chromium with SwiftShader software WebGL, 2 CPU cores). These are not GitHub CI runs.

**Rooms:** fresh random local same-device (peer) rooms (`Q…` codes). The production room 7K3M was never used.

**Script:** `node scripts/qa-greenhouse.mjs http://127.0.0.1:4173 <dir> <sha>`, run against a static server over `dist/`.
- **Attempt 1 failed.** The script chose a prediction after its own mid-day steps had begun attempt 1's day. That day now fixes the attempt's prediction, so the choice was disabled and the script timed out after 4 checks ([log](../../../../qa/greenhouse/app-b8d099a/qa-greenhouse-attempt1.txt)).
- **Attempt 2 passed.** The script now starts a new attempt there; this changes the test script only. It ran 2,066 s with no issues and 12/12 checks ([`record.json`](record.json), [log](../../../../qa/greenhouse/app-b8d099a/qa-greenhouse.txt)).

The images are JPEG (quality 84) conversions of the PNG captures. The renderer counters are the draw calls and triangles of the frame shown, **not** frame rates. Nothing here was measured on a GPU, phone or Quest. 390×844 is a viewport check in desktop Chromium, not testing on a phone.

## Checks in this run

| Check | Result |
|---|---|
| 1440×900 overview: the greenhouse's projected width ÷ the free width between the parts rail and the dock | **0.914** (≥ 0.6) |
| 1280×720 overview, same measure | **0.919** |
| Camera keys `2` and `3` frame different views | yes |
| Wrong build (tank straight to bed A, valve A OUT → valve B OUT, a loose cable end) drawn as built, nothing flows | hose 1 `no-pump`, hose 3 `out-out`, cable 1 `loose` |
| Mid-day, paused at 13:00 (step 28): resources from the model; water and energy ledgers balanced | tank 25.6 L; residuals 0 |
| Dock collapsed: the day keeps running, the HUD clock follows | 08:00 → 09:30 with the dock hidden |
| Failure (attempt 2): the default allocation on the brief's day | G1 met; bed A 0 h; **bed B 9.5 h** out of range; air above 35 °C **1.5 h**; 16.0 L left |
| Recovery (attempt 3): the worked allocation | all five met: bed A 0 h, bed B 1 h, air 0 h, 11.2 L left |
| Phone 390×844: horizontal overflow | 0 px |
| Phone: *Start the day* reached by Tab after real wheel scrolling | yes; 129.8×44 px |
| Phone: every visible control in the Greenhouse tab at least 44 px tall | yes (none smaller) |
| PF: no worked example | hidden |

The 3D controls are measured in [their own run](../../../../qa/greenhouse/README.md#the-3d-controls-on-b8d099a-measured): 44 px squares, real clicks at fixed points, poses, the running lock, at 1440 and 1280.

## Shots

| Shot | Viewport | Draw calls | Triangles |
|---|---|---:|---:|
| `01` overview, nothing built (DI, brief and worked example) | 1440×900 | 265 | 57,586 |
| `02` overview | 1280×720 | 264 | 57,478 |
| `03` top (key `2`) | 1440×900 | 254 | 57,326 |
| `04` beds (key `3`) | 1440×900 | 172 | 43,112 |
| `05` wrong build, as built | 1440×900 | 274 | 61,298 |
| `06` the brief's rig, paused at 13:00 | 1440×900 | 266 | 57,586 |
| `07` close-up: pump and manifold ports | 1440×900 | 242 | 55,888 |
| `07b` close-up: the valve handwheels and the controller knobs | 1440×900 | 210 | 48,494 |
| `08` close-up: the beds, the probe in bed A | 1440×900 | 131 | 35,968 |
| `09` failure: the default allocation's day | 1440×900 | 266 | 57,586 |
| `10` recovery: the worked allocation's day | 1440×900 | 266 | 57,586 |
| `12` phone, top | 390×844 | 246 | 55,978 |
| `13` phone, dock reached by wheel and Tab | 390×844 | 246 | 55,978 |

`05b`, `06b`, `09b`, `10b` and `11` are crops of the dock in the frames of `05`, `06`, `09` and `10` (`11` after the manifold was selected), so they carry those frames' counters. `14` is a crop of a separate PF page at 1440×900 (265 draw calls, 57,586 triangles).

## Overview and camera views

The power cables now lie coiled on the floor in front of the plinth, below their sockets.

![Overview, 1440×900](01-overview.jpg)

| 1280×720 | Top | Beds |
|---|---|---|
| ![1280](02-overview-1280.jpg) | ![Top](03-top.jpg) | ![Beds](04-beds.jpg) |

## The 3D controls

The two valve handwheels sit on square position plates at the front of the plinth, SHUT to OPEN, with the outlets and hose fittings behind them. The controller's PUMP BELOW and FAN ABOVE knobs sit on scale plates on a sloped console above the sockets and plugs. All four face the room.

![Valves and knobs](07b-closeup-controls.jpg)

## Wrong build, as built

Hose 1 runs from TANK OUT straight to bed A's inlet (no pump; the tank sits below the beds), hose 3 joins valve A OUT to valve B OUT, and cable 1 has a loose end. Nothing is repaired: red fault collars sit at the ports, the diagram draws the wrong lines dotted with ✕, and the notes and the connection list say what each fault does.

| 3D | Live resource flow |
|---|---|
| ![Wrong build](05-wrong-build.jpg) | ![Flow card](05b-wrong-build-flow.jpg) |

## The brief's rig, mid-day

| 3D | The day |
|---|---|
| ![Mid-day](06-built-midday.jpg) | ![Day card](06b-day-card.jpg) |

| Pump and manifold | The beds, the probe in bed A |
|---|---|
| ![Pump and manifold](07-closeup-pump-manifold.jpg) | ![Beds and probe](08-closeup-beds-probe.jpg) |

## Failure and recovery

The default allocation (both valves 100 %, pump below 50 %, fan above 30 °C) on the brief's day as attempt 2, then the worked allocation (valve A 30 %, valve B 50 %, pump below 60 %, fan above 26 °C) as attempt 3.

| Failure | Its verdict (DI reasons) |
|---|---|
| ![Failure](09-failure.jpg) | ![Failure verdict](09b-failure-verdict.jpg) |

| Recovery | Its verdict |
|---|---|
| ![Recovery](10-recovery.jpg) | ![Recovery verdict](10b-recovery-verdict.jpg) |

![The selected manifold's card](11-selected-manifold.jpg)

## Phone (390×844) and PF

| Phone, top | Phone, dock (wheel + Tab) | PF panel (no worked example) |
|---|---|---|
| ![Phone top](12-phone-top.jpg) | ![Phone dock](13-phone-dock.jpg) | ![PF](14-pf-panel.jpg) |

## Before and after: the same cameras

`scripts/qa-greenhouse-compare.mjs` captured the same three cameras with the brief's rig fully plumbed and wired, on both apps:
- **before:** `faa7c09`, from its own worktree and `dist/`;
- **after:** `b8d099a`.

Records: [`compare/before-faa7c09-record.json`](../compare/before-faa7c09-record.json) and [`compare/after-b8d099a-record.json`](../compare/after-b8d099a-record.json).

| Camera | Before (`faa7c09`) | After (`b8d099a`) |
|---|---|---|
| Overview 1440×900 | ![before](../compare/before-faa7c09-overview-1440.jpg) 252 calls, 53,682 triangles | ![after](../compare/after-b8d099a-overview-1440.jpg) 265 calls, 57,586 triangles |
| Overview 1280×720 | ![before](../compare/before-faa7c09-overview-1280.jpg) 251 calls, 53,574 triangles | ![after](../compare/after-b8d099a-overview-1280.jpg) 264 calls, 57,478 triangles |
| Close-up of the controls | ![before](../compare/before-faa7c09-closeup-controls.jpg) 196 calls, 44,590 triangles | ![after](../compare/after-b8d099a-closeup-controls.jpg) 209 calls, 48,494 triangles |

## Earlier capture runs

- The `faa7c09` renders are kept in [`app-faa7c09/`](../app-faa7c09/README.md).
- `b9dde3c` was not rendered with this script.
- Development captures on earlier commits are not evidence of either app.
