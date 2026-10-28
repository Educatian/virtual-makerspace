# REA attempt: raw evidence (public target unreachable from this environment)

These are the unedited outputs of the REA 6.8.0 attempt on `https://learn-arduino-red.vercel.app/#rgb`, made 2026-10-26 (UTC timestamp in `when.txt`). Two files are trimmed, as noted below; the analysis is in [`../../../reference-benchmark.md`](../../../reference-benchmark.md).

## Environment

- **REA:** `rea-agents` 6.8.0 (npm `@latest` resolved to it), installed into a private scratch folder. No global install, no `rea setup`, no client configuration changed.
- **Node:** 24.22.1, from the npm package `node-linux-x64@24.22.1` (REA needs `^22.23.4 || ^24.22.1`).
- **Browser:** Chromium 141 headless (Playwright build 1194) with an owned temporary profile, CDP on `127.0.0.1:9333` only.

## Commands, in order

| File | Command |
|---|---|
| `doctor.json` | `rea doctor --format json` |
| `chromium-probe.txt` | owned Chromium → `page.goto("https://learn-arduino-red.vercel.app/#rgb")` |
| `list-browser-targets.json` | `rea list-browser-targets http://127.0.0.1:9333 --format json` |
| `inspect-web-page.json` | `rea inspect-web-page http://127.0.0.1:9333 <target_id from the list> --allowed-origins https://learn-arduino-red.vercel.app --observation-ms 2000 --format json` |
| `analyze-web-bundle.json` | `rea analyze-web-bundle http://127.0.0.1:9333 <target_id> --allowed-origins https://learn-arduino-red.vercel.app --observation-ms 2000 --format json` |
| `curl-direct.txt` | `curl https://learn-arduino-red.vercel.app/` |
| `static-assets-curl.txt`, `static-asset-connect.txt` | `curl` of `/assets/index-GGrOCNGj.js` and `/assets/index-CqDNWwLj.css` (the bundles the parent observed) |

`exit-codes.txt` holds the exit codes. Its first lines come from an earlier attempt that took the wrong id field and wrong array syntax; the corrected run is the one recorded here.

## Result

- The Chromium navigation fails with `net::ERR_TUNNEL_CONNECTION_FAILED`.
- `inspect-web-page` and `analyze-web-bundle` return `target_unavailable` / `target_not_allowed`.
- Every route to the host gets `CONNECT … 403` from the environment's egress proxy.

**No target code, page or asset was captured.** `analyze-javascript-application` therefore had nothing to analyze and was not run.

## Trimming

- `static-asset-connect.txt` keeps only the CONNECT, response and error lines of `curl -v`. The full output repeats proxy settings.
- `doctor.json` is unedited. It is unhealthy only because native analysis engines (Hopper, Ghidra, IDA, JADX, Kuna) are absent, which web analysis does not need, and because we did not run `rea setup`.

SHA-256 of every file is in `SHA256SUMS`.
