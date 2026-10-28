// Shared browser-test helpers for software-rendered (SwiftShader) runs.
//
// Why: under SwiftShader the first draw of a new three.js material blocks the page's main thread
// while the GPU process compiles and links the shader program (three.js reads the link status in
// WebGLProgram.getUniforms). On a 2-core machine with two Snapino pages this was measured at
// 56–115 s per long task (scripts/e2e-room-sync.mjs diagnosis, baseline 3394e4b and head alike):
// timers, animation frames and Playwright evaluations all wait. A step timeout that starts while
// such a compile is running measures the renderer, not the app.
//
// So a test waits for an explicit, measured readiness condition after each change that brings new
// geometry or materials on screen: N animation frames rendered AFTER the call and a responsive main
// thread. The time spent is logged; if the budget runs out, diagnostics are written (DOM state,
// heartbeat/frame gaps, long tasks, screenshot) and the test fails — it never skips a check.
import { mkdirSync, writeFileSync } from "node:fs";

/** Counters the readiness check and the diagnostics read (installed before any page script). */
export async function instrument(context) {
  await context.addInitScript(() => {
    const diag = (window.__e2eDiag = { frames: 0, lastFrame: performance.now(), maxFrameGap: 0, beats: 0, lastBeat: performance.now(), maxBeatGap: 0, longTasks: [] });
    setInterval(() => {
      const now = performance.now();
      diag.maxBeatGap = Math.max(diag.maxBeatGap, now - diag.lastBeat);
      diag.lastBeat = now;
      diag.beats += 1;
    }, 250);
    const frame = () => {
      const now = performance.now();
      diag.maxFrameGap = Math.max(diag.maxFrameGap, now - diag.lastFrame);
      diag.lastFrame = now;
      diag.frames += 1;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (diag.longTasks.length < 200) diag.longTasks.push([Math.round(entry.startTime), Math.round(entry.duration)]);
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // Long-task timing is optional diagnostics.
    }
  });
}

// The timeout never keeps the test process alive after the run (unref) and is cleared when the
// promise settles first.
const race = (promise, ms, fallback) => {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Waits until `frames` animation frames have rendered after this call and two consecutive
 * evaluations returned within `responsiveMs` (a page in a shader link does not answer for 50–120 s;
 * an ordinary software-rendered Snapino frame can itself take 5–15 s). Returns the wait in ms.
 */
export async function settled(page, label, { budgetMs = 900_000, frames = 3, responsiveMs = 20_000, diagnostics = null } = {}) {
  const started = Date.now();
  const first = await race(page.evaluate(() => window.__e2eDiag?.frames ?? 0), budgetMs, null);
  if (first === null) return fail();
  let quick = 0;
  while (Date.now() - started < budgetMs) {
    const t0 = Date.now();
    const now = await race(page.evaluate(() => window.__e2eDiag?.frames ?? 0), Math.max(1000, budgetMs - (Date.now() - started)), null);
    if (now === null) break;
    quick = Date.now() - t0 < responsiveMs ? quick + 1 : 0;
    if (now - first >= frames && quick >= 2) {
      const ms = Date.now() - started;
      console.log(`  [ready] ${label}: ${Math.round(ms / 1000)} s (+${now - first} frames)`);
      return ms;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return fail();
  async function fail() {
    if (diagnostics) await dumpDiagnostics(page, diagnostics, `not-ready-${label}`);
    throw new Error(`${label}: page not ready within ${Math.round(budgetMs / 1000)} s`);
  }
}

/** Writes DOM/renderer-health diagnostics and a screenshot (each step bounded in time). */
export async function dumpDiagnostics(page, dir, why, extra = {}) {
  mkdirSync(dir, { recursive: true });
  const tag = `${page.e2eLabel ?? "page"}-${why}`.replace(/[^a-z0-9.-]+/gi, "_").slice(0, 120);
  const started = Date.now();
  const state = await race(page.evaluate(() => ({
    url: location.href,
    title: document.title,
    heading: document.querySelector("#viewport-heading")?.textContent ?? null,
    inLobby: Boolean(document.querySelector("#enter-room")),
    visibility: document.visibilityState,
    readyState: document.readyState,
    buttons: document.querySelectorAll("button").length,
    diag: window.__e2eDiag ? { ...window.__e2eDiag, longTasks: [...window.__e2eDiag.longTasks].sort((a, b) => b[1] - a[1]).slice(0, 10) } : null,
  })).catch((error) => ({ error: error.message })), 30_000, { error: "evaluate did not return within 30 s (main thread busy)" });
  const screenshot = await race(page.screenshot({ path: `${dir}/${tag}.png` }).then(() => `${tag}.png`).catch((error) => error.message), 30_000, "screenshot did not complete within 30 s");
  writeFileSync(`${dir}/${tag}.json`, JSON.stringify({ why, at: new Date().toISOString(), evaluateMs: Date.now() - started, state, screenshot, ...extra }, null, 1));
  console.error(`  [diagnostics] ${dir}/${tag}.json`);
}
