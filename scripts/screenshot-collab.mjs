/**
 * Capture a collaborative-mode screenshot: role-A participant's view with the
 * role-B partner's avatar (head + hands) standing across the workbench.
 *
 * Uses the deployed realtime worker (wss) for room sync, so two browser pages in
 * the same room see each other. Page B enters an emulated XR session and is moved
 * across the table; Page A stays in desktop spectator view for a clean framing.
 *
 * USAGE:  URL=https://localhost:8081/ node scripts/screenshot-collab.mjs
 * Requires `npm run dev` running.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.URL ?? "https://localhost:8081/";
const ROOM = "tut" + "1";
const OUT = "docs/images";
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });

async function open(role, pid, nick, w = 1600, h = 900) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`[${role} ERR]`, m.text());
  });
  const url = `${BASE}?mode=collab&role=${role}&room=${ROOM}&pid=${pid}&nick=${nick}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => window.__VM !== undefined, { timeout: 20000 });
  return { page, ctx };
}

// --- Partner B joins first and enters XR, positioned across the table ---
const b = await open("B", "bob", "Bob");
await b.page.waitForTimeout(1500);
await b.page.evaluate(async () => {
  if (window.IWER_DEVICE) await window.IWER_DEVICE.remote.acceptSession();
});
await b.page.waitForTimeout(1500);
await b.page.evaluate(async () => {
  const dev = window.IWER_DEVICE;
  if (!dev) return;
  // Stand at the LEFT side of the workbench, leaning in toward the board so the
  // avatar head + both hands are large and unoccluded in role A's framing.
  await dev.remote.dispatch("set_transform", {
    device: "headset",
    position: { x: -0.7, y: 1.42, z: -1.25 },
    orientation: { x: 0, y: 0.92, z: 0, w: 0.38 }, // face toward the board/right
  });
  await dev.remote.dispatch("set_transform", {
    device: "controller-left",
    position: { x: -0.5, y: 1.0, z: -1.05 },
    orientation: { x: -0.3, y: 0.6, z: 0, w: 0.74 },
  });
  await dev.remote.dispatch("set_transform", {
    device: "controller-right",
    position: { x: -0.18, y: 0.98, z: -1.1 },
    orientation: { x: -0.3, y: 0.6, z: 0, w: 0.74 },
  });
});

// --- Role A joins, receives B's pose, spawns B's avatar ---
const a = await open("A", "alice", "Alice");
// Give pose sync (15 Hz) time to populate B's avatar in A's scene.
await a.page.waitForTimeout(3500);

// Confirm A actually sees a remote avatar before shooting.
const remoteCount = await a.page.evaluate(() => {
  const w = window.__VM?.world;
  if (!w) return -1;
  let n = 0;
  w.scene?.traverse?.((o) => {
    if (o.name && o.name.startsWith("remote-avatar-")) n++;
  });
  return n;
});
console.log("remote avatars visible to A:", remoteCount);

// Wait until the partner avatar's head has lerped up above the floor (it parks
// underground until the first pose), so framing is deterministic, not mid-lerp.
await a.page
  .waitForFunction(
    () => {
      const w = window.__VM?.world;
      let y = -99;
      w?.scene?.traverse?.((o) => {
        if (o.name === "head" && o.parent?.name?.startsWith("remote-avatar-")) {
          o.updateWorldMatrix(true, false);
          y = o.matrixWorld.elements[13];
        }
      });
      return y > 1.2; // near the partner's real head height (~1.4), not mid-lerp
    },
    { timeout: 8000 },
  )
  .catch(() => console.warn("avatar head did not rise above floor in time"));

// Find the partner avatar's HEAD-mesh world position (the group sits at origin;
// the head child carries the streamed world pose) so we can aim the camera.
const avPos = await a.page.evaluate(() => {
  const w = window.__VM?.world;
  let pos = null;
  w?.scene?.traverse?.((o) => {
    if (o.name === "head" && o.parent?.name?.startsWith("remote-avatar-")) {
      o.updateWorldMatrix(true, false);
      const e = o.matrixWorld.elements;
      pos = [e[12], e[13], e[14]];
    }
  });
  return pos;
});
console.log("avatar head world pos:", avPos);

// Frame: A on the near-RIGHT, looking left-across the board to B's avatar. Camera
// pushed right so the orange ambient robot (far left, x=-1.8) stays out of frame.
await a.page.evaluate((av) => {
  const w = window.__VM.world;
  // Aim between the board and the partner head, biased high to keep the
  // floor-level ambient robot (far left) out of frame.
  const board = [-0.2, 1.0, -1.05];
  const look = av
    ? [(board[0] + av[0]) / 2, 1.25, (board[2] + av[2]) / 2]
    : [-0.4, 1.25, -1.15];
  w.camera.position.set(0.95, 1.55, -0.05);
  w.camera.lookAt(look[0], look[1], look[2]);
}, avPos);
await a.page.waitForTimeout(500);
await a.page.screenshot({ path: `${OUT}/collab.png`, fullPage: false });
console.log(`Captured collab.png (remote avatars: ${remoteCount})`);

// A tighter portrait of the partner avatar (head + hands) over the board.
await a.page.evaluate((av) => {
  const w = window.__VM.world;
  if (av) {
    w.camera.position.set(av[0] + 1.05, av[1] - 0.05, av[2] + 0.95);
    w.camera.lookAt(av[0], av[1] - 0.12, av[2]);
  }
}, avPos);
await a.page.waitForTimeout(400);
await a.page.screenshot({ path: `${OUT}/collab-wide.png`, fullPage: false });
console.log("Captured collab-wide.png");

await browser.close();
process.exit(remoteCount > 0 ? 0 : 3);
