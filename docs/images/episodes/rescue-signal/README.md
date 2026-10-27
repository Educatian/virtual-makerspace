# Episode 1 · Rescue Signal Workshop — renders

**App code:**
- `e01`–`e13` at commit `dc51187`;
- the two-client set at `a9fefef`, which differs from `dc51187` only in the diagram's wire-list position.

Both are on branch `feat/makerspace-episodes`, built with `npm run build`. These renders show the **reference-quality layout**: the workshop is a tab of the right-hand dock, and there is a single side column. Earlier versions of these files showed `13aa2aa` and `89a238c`, with the workshop floating over the left of the scene. The same-camera before/after comparisons are in [`../../reference-upgrade/`](../../reference-upgrade/).
**Where:** a developer environment (headless Chromium 1194 with SwiftShader software WebGL, 2 CPU cores). These are not GitHub CI runs; the repository's only GitHub check is GitGuardian.
**Rooms:** fresh random local QA rooms for every page (`Q…` and `R…` codes). The production room 7K3M was never used.

Software rendering is slow: a Snapino frame takes seconds. The renderer counters below are draw calls and triangles per view. They are **not** frame rates, and nothing here was measured on a real GPU, phone or Quest headset. No XR view of the episode exists.

## How they were made

| Set | Script | Mode |
|---|---|---|
| `e01`–`e13` | `node scripts/qa-episode.mjs http://localhost:4173 <dir>` (static server over `dist/`) | One maker, solo sender, same-device (peer) room. Close-ups use the `?qa` camera hook, with the dock closed by its own button. The matched lit/unlit pair drives D5 HIGH/LOW through `__vmQa.pins`, the same pin path a transmission uses. |
| `two-client-*` | `node --experimental-strip-types scripts/e2e-rescue-signal.mjs http://vm.test:8800 <dir>` (wrangler dev + `scripts/access-proxy.mjs`) | Two browsers in one room over the real Worker/Durable Object, clicking the real panel. This run passed 58/58 checks ([log](../../../qa/reference-upgrade/rescue-a9fefef.txt)). |

JPEG (quality 84) conversions of the PNG captures. Counters for `e01`–`e11` are in [`stats.json`](stats.json).

## Overview and close-ups (1440×900)

| View | Draw calls | Triangles |
|---|---:|---:|
| `e01` overview, sender designing INJURED · NORTH (workshop tab open, Bench view) | 487 | 92,850 |
| `e02` / `e03` lamp L1 lit / unlit, identical camera, dock closed | 241 | 65,946 |
| `e04` low angle on L1's snaps and the D5 pad | 303 | 68,546 |
| `e05`–`e09`, `e12`, `e13` the receiver's framing, with the workshop tab | 372 | 86,246 |
| `e10` phone 390×844, workshop open | 327 | 76,298 |
| `e11` phone 390×844, workshop folded | 227 | 70,370 |

**Pixel check.** In the matched close-ups, separate from the scene's own state, the bulb crop has mean luminance **193.3 lit** and **158.0 unlit** (`stats.json`).

![Overview](e01-overview-design.jpg)

Lamp L1 seated on its snaps, D5 HIGH (left) and LOW (right), same camera:

| Lit | Unlit |
|---|---|
| ![Lamp lit](e02-lamp-lit-close.jpg) | ![Lamp unlit](e03-lamp-unlit-close.jpg) |

![Low angle on the lamp's snaps and the D5 pad](e04-lamp-snaps-low.jpg)
![Receiver's view, lamp lit](e05-receiver-view-lit.jpg)

## Running, working, error and recovery states

- **`e06` running.** The transmission is running: progress bar, elapsed time, Stop, and the lamp lit on the bench. This capture round is one deliberately long 110 s flash, which is not a protocol word, so that a seconds-per-frame renderer can catch it. The shot was taken 74.3 s in, and the flash ran to its end before the script reached Stop (`stats.json`). Stop itself is exercised in the two-client run.
- **`e07` working round.** The solo check after the DI helper's INJURED · NORTH blocks: both words are decoded and no problems are found.
- **`e08` error.** The return wire `W2a` is off the base, which leaves an open circuit. The code ran, but there was no light at all. The diagnosis says L1 had no end reaching GND.
- **`e09` recovery.** The loop is rebuilt, the same message is transmitted again, and no problems are found.

![Running](e06-transmitting.jpg)
![Working round, solo check](e07-solo-check-delivered.jpg)
![Open circuit](e08-open-circuit-solo-check.jpg)
![Recovered](e09-recovered-solo-check.jpg)

These two faults come from the parent review, imported through the real project-file path:
- **`e12` pin short and bypassed lamp.** A snap wire runs from D5 straight to GND. The solo check says there was no light at all. It names both causes: L1's ends on one connected net, and D5 set HIGH with its pad wired straight to GND. The 3D bench shows nothing running.
- **`e13` the 5V lamp.** The lamp runs from 5V to GND. The solo check says it was still on when the transmission ended; it is not "switched off". The recorded strip marks the light as continuing, and the bench still shows it lit.

![Pin short and bypassed lamp](e12-pin-short-bypassed-solo-check.jpg)
![5V lamp still lit](e13-5v-still-lit-solo-check.jpg)

## Phone width (390×844)

| Panel open | Panel folded |
|---|---|
| ![Phone, panel](e10-phone-design.jpg) | ![Phone, 3D](e11-phone-collapsed-3d.jpg) |

## Two clients over the Worker (1000×680 each, 390×844 late joiner)

| File | What it shows |
|---|---|
| `two-client-01-sender-design` | The sender has chosen North ridge and INJURED · NORTH, and the DI helper has written the blocks. |
| `two-client-02-receiver-watching` | The receiver's screen, framed with "Receiver's view", right after the transmission ended. The lamp is dark, as the timeline says. |
| `two-client-03-receiver-reading` | The receiver builds the first reading. The intended message is not shown. |
| `two-client-04-sender/receiver-compare-delivered` | Both screens: intended, what the light said under the protocol, what was read, and "Message delivered". |
| `two-client-05-ambiguous-diagnosis` | A 500 ms flash: the signal is ambiguous even though the reading guessed right. It shows the measured flash against the bands. |
| `two-client-06-open-circuit-no-light` | The open circuit: no light reached the receiver. |
| `two-client-07-cut-off-by-bench-change` | A teammate's bench edit cut the transmission off. The strip's axis is labelled. |
| `two-client-08-unread-after-success` | After a delivered round, a new unread round. The header pill and stepper show **Reading** for the current round, not the earlier "Delivered". |
| `two-client-09-phone-late-joiner` | A late joiner on a phone, joined while the 108 s recurring light ran. It gets the rounds, the current round and the roles from the room. |
| `two-client-pixel-lit/dark` | The receiver's lamp crops used for the pixel check: luminance 200.8 lit vs 163.5 dark. |

![Sender design](two-client-01-sender-design.jpg)
![Receiver after the transmission](two-client-02-receiver-watching.jpg)
![Receiver reading](two-client-03-receiver-reading.jpg)
![Sender compare](two-client-04-sender-compare-delivered.jpg)
![Receiver compare](two-client-04-receiver-compare-delivered.jpg)
![Ambiguous](two-client-05-ambiguous-diagnosis.jpg)
![Open circuit](two-client-06-open-circuit-no-light.jpg)
![Cut off](two-client-07-cut-off-by-bench-change.jpg)
![Unread round after a success](two-client-08-unread-after-success.jpg)
![Phone late joiner](two-client-09-phone-late-joiner.jpg)
