# Episode 2 · Sound Flow Studio — test records

These records come from a developer environment: headless Chromium (SwiftShader), wrangler dev on 8799, and the local access proxy on 8800 with `vm.test` mapped to 127.0.0.1. The machine has 2 CPU cores. **None of this is GitHub CI.** Every room was a fresh random QA room; the production room 7K3M was never used.

The records were sanitized:
- scratch paths are replaced by `<scratch>`;
- the per-connection ids after `host@example.test:` / `member@example.test:` are replaced by `<connection>`;
- Chromium's own stderr lines (`[pid=…]`) are dropped.

Nothing else was edited.

## The two-client Worker test: every attempt

The script is `node --experimental-strip-types scripts/e2e-sound-worker.mjs http://vm.test:8800 <dir>`. Each check records its time, the acting maker, and the room revisions each client held.

| Attempt | App code | Room | Result | What went wrong, and what changed |
|---|---|---|---|---|
| 1 | Uncommitted tree after `340ce2b` (desk and dock in progress) | SC4T | 5/7, then stopped | The host's keyboard Source edit (220 Hz sawtooth) never reached the room; the member still had 440 Hz sine. The run was then killed at the background task's 30-minute default limit ("run completed" failed: the browser was closed). |
| 2 | Same tree, test viewport 800×544 | SKXR | 2/4, then stopped | At 800×544 the last plug (blue → Speaker IN) was released off the jack, so `snd-cable-c` stayed `[4, null]` for both. **A test-geometry problem**: the viewport went back to 1000×700. |
| 3 | Tree with the dock fixes | S4Z5 | 5/8, then stopped | The Source edit failed again: the tools said "Set Source to sine 440 Hz", that is, the old values. The member's draft check failed as a consequence. |
| 4 | Same, with a focus trail added to the test | SYQM | 5/7, then stopped | The tools now named the new values ("Set Source to sawtooth 220 Hz") but nothing changed in the room. **Root cause:** `edit-history.sameTransform` compared only `ohms`/`volts`-style props, not the Sound knobs, so the workbench tools saw "nothing to change". Fixed in `3698dc5` (all prop keys compared), with a regression check. The panel was also changed so that it does not rewrite a card that has focus, and the test now sets the wave radio by arrow keys. |
| 5 | Tree before `3698dc5` was committed | SF9B | 15/16 | Every scenario check passed. "Run completed" failed on a strict-mode selector clash: `[data-speaker]` also matched chat messages. The speaker switch's attribute was renamed to `data-speaker-switch`. |
| 6 | `3698dc5` | SC95 | **29/29** | — |
| final | `1eaf1dd` | see `e2e-final-results.json` | see below | The rerun on the final app. |

`e2e-attempt{1..6}-results.json` and `-run.log` are the records of attempts 1–6. Attempts 1–5 ran against working trees that were not committed at the time; the table says which fixes each one led to.

## The final run on app `1eaf1dd`

`final-summary.txt` lists every command in order, with its exit code and duration. The DSP record of the final run is `dsp-record.json`, and the renders are in [`../../images/episodes/sound-flow/`](../../images/episodes/sound-flow/README.md).
