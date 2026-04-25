import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const URL = process.env.URL ?? "https://localhost:8081/";
const OUT_DIR = "docs/images";

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  args: ["--ignore-certificate-errors"],
});

async function newPage(width = 1600, height = 900) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("PAGE ERR:", msg.text());
  });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => (window).__VM !== undefined, { timeout: 15000 });
  await page.waitForTimeout(2500);
  return { page, ctx };
}

async function setCamera(page, pos, lookAt) {
  await page.evaluate(
    ([p, l]) => {
      const w = window.__VM.world;
      w.camera.position.set(p[0], p[1], p[2]);
      w.camera.lookAt(l[0], l[1], l[2]);
    },
    [pos, lookAt],
  );
  await page.waitForTimeout(400);
}

async function shoot(name, page) {
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: false });
  console.log(`Captured ${name}.png`);
}

// Reusable snap helper installed in page context
const installSnapHelpers = `(() => {
  function getSocketLocalPosition(idx, cols, rowsPerHalf, pitch, channelGap) {
    const totalRows = 2 + 2 * rowsPerHalf;
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const xStart = -((cols - 1) * pitch) / 2;
    const halfHeight = (rowsPerHalf - 0.5) * pitch + channelGap / 2;
    const railOffset = halfHeight + 1.5 * pitch;
    const x = xStart + col * pitch;
    let z;
    if (row === 0) z = -railOffset;
    else if (row === totalRows - 1) z = railOffset;
    else if (row <= rowsPerHalf) {
      const r = row - 1;
      z = -(channelGap / 2 + (rowsPerHalf - 0.5 - r) * pitch);
    } else {
      const r = row - rowsPerHalf - 1;
      z = channelGap / 2 + (r + 0.5) * pitch;
    }
    return { x, y: 0.027 / 2 + 0.0001, z };
  }
  function localToWorld(boardObj, lp) {
    boardObj.updateWorldMatrix(true, false);
    const e = boardObj.matrixWorld.elements;
    return {
      x: e[0] * lp.x + e[4] * lp.y + e[8] * lp.z + e[12],
      y: e[1] * lp.x + e[5] * lp.y + e[9] * lp.z + e[13],
      z: e[2] * lp.x + e[6] * lp.y + e[10] * lp.z + e[14],
    };
  }
  function snapEntityToSockets(entity, board, sa, sb) {
    const { Snappable, SocketGrid } = window.__VM.components;
    const cols = board.getValue(SocketGrid, "cols");
    const rowsPerHalf = board.getValue(SocketGrid, "rowsPerHalf");
    const pitch = board.getValue(SocketGrid, "pitch");
    const channelGap = board.getValue(SocketGrid, "channelGap");
    const sAW = localToWorld(board.object3D, getSocketLocalPosition(sa, cols, rowsPerHalf, pitch, channelGap));
    const sBW = localToWorld(board.object3D, getSocketLocalPosition(sb, cols, rowsPerHalf, pitch, channelGap));
    const angleY = Math.atan2(sBW.z - sAW.z, sBW.x - sAW.x);
    const obj = entity.object3D;
    obj.rotation.set(0, angleY, 0);
    obj.updateMatrixWorld(true);
    const off = entity.getVectorView(Snappable, "leadAOffset");
    const c = Math.cos(angleY);
    const s = Math.sin(angleY);
    const rx = c * off[0] + s * off[2];
    const ry = off[1];
    const rz = -s * off[0] + c * off[2];
    obj.position.set(sAW.x - rx, sAW.y - ry, sAW.z - rz);
    entity.setValue(Snappable, "leadASocket", sa);
    entity.setValue(Snappable, "leadBSocket", sb);
  }
  window.__VM_HELPERS = {
    getSocketLocalPosition,
    localToWorld,
    snapEntityToSockets,
    findEntities: () => {
      const { world, SnapSystem, components } = window.__VM;
      const { Snappable, WireEnds, LedState, PowerSource } = components;
      const snapSys = world.getSystem(SnapSystem);
      const snappables = Array.from(snapSys.queries.snappables.entities);
      const targets = Array.from(snapSys.queries.snapTargets.entities);
      return {
        board: targets[0],
        battery: snappables.find((e) => e.hasComponent(PowerSource)),
        leds: snappables.filter((e) => e.hasComponent(LedState)),
        wires: snappables.filter((e) => e.hasComponent(WireEnds)),
      };
    },
    findWireByLength: (wires, halfLen) => {
      const { Snappable } = window.__VM.components;
      return wires.find(
        (w) => Math.abs(w.getVectorView(Snappable, "leadAOffset")[0] + halfLen) < 0.001,
      );
    },
  };
})()`;

// 1. Hero — default player POV
{
  const { page, ctx } = await newPage(1600, 900);
  await shoot("hero", page);
  await ctx.close();
}

// 2. Robot character close-up
{
  const { page, ctx } = await newPage(1400, 900);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const w = window.__VM.world;
    const r = window.__VM.robot;
    r.updateMatrixWorld(true);
    const rx = r.position.x;
    const ry = r.position.y;
    const rz = r.position.z;
    w.camera.position.set(rx + 1.4, ry + 0.6, rz + 1.0);
    w.camera.lookAt(rx, ry + 0.35, rz);
  });
  await page.waitForTimeout(400);
  await shoot("robot", page);
  await ctx.close();
}

// 3. Breadboard zoom
{
  const { page, ctx } = await newPage(1400, 900);
  await setCamera(page, [-0.2, 1.15, -0.45], [-0.2, 0.86, -1.05]);
  await shoot("breadboard", page);
  await ctx.close();
}

// 4. Tray
{
  const { page, ctx } = await newPage(1400, 900);
  await setCamera(page, [0.4, 1.2, -0.45], [0.4, 0.92, -1.1]);
  await shoot("tray", page);
  await ctx.close();
}

// 5. Assembled circuit
{
  const { page, ctx } = await newPage(1400, 900);
  await page.evaluate(installSnapHelpers);
  await page.evaluate(() => {
    const { snapEntityToSockets, findEntities, findWireByLength } = window.__VM_HELPERS;
    const { board, battery, leds, wires } = findEntities();
    const mediumWire = findWireByLength(wires, 0.06);
    const shortWire = findWireByLength(wires, 0.024);
    if (battery && board) snapEntityToSockets(battery, board, 4, 20);
    if (mediumWire && board) snapEntityToSockets(mediumWire, board, 20, 25);
    if (leds[0] && board) snapEntityToSockets(leds[0], board, 25, 26);
    if (shortWire && board) snapEntityToSockets(shortWire, board, 26, 10);
  });
  await page.waitForTimeout(600);
  await setCamera(page, [-0.2, 1.05, -0.5], [-0.2, 0.88, -1.05]);
  await shoot("assembled", page);
  await ctx.close();
}

// 6. Wands + workspace — IWER XR session shows controller meshes in spectator view
{
  const { page, ctx } = await newPage(1600, 900);
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    if (!window.IWER_DEVICE) return;
    await window.IWER_DEVICE.remote.acceptSession();
  });
  await page.waitForTimeout(2000);
  await page.evaluate(async () => {
    const dev = window.IWER_DEVICE;
    if (!dev) return;
    // Headset at participant eye level facing the workspace
    await dev.remote.dispatch("set_transform", {
      device: "headset",
      position: { x: 0.0, y: 1.55, z: 0.0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    });
    // Controllers held forward toward the breadboard, like a typical reach pose
    await dev.remote.dispatch("set_transform", {
      device: "controller-left",
      position: { x: -0.22, y: 1.15, z: -0.5 },
      orientation: { x: -0.35, y: 0.05, z: 0, w: 0.93 },
    });
    await dev.remote.dispatch("set_transform", {
      device: "controller-right",
      position: { x: 0.22, y: 1.15, z: -0.5 },
      orientation: { x: -0.35, y: -0.05, z: 0, w: 0.93 },
    });
  });
  await page.waitForTimeout(1500);
  // Crop the "Remote Control Active" overlay strip at the bottom
  await page.screenshot({
    path: `${OUT_DIR}/wands.png`,
    clip: { x: 0, y: 0, width: 1600, height: 850 },
  });
  console.log("Captured wands.png");
  await ctx.close();
}

// 7. Hover preview — held LED near sockets shows green markers
{
  const { page, ctx } = await newPage(1400, 900);
  await page.evaluate(installSnapHelpers);
  await page.evaluate(() => {
    const {
      getSocketLocalPosition,
      localToWorld,
      findEntities,
    } = window.__VM_HELPERS;
    const { Snappable, SocketGrid } = window.__VM.components;
    const { board, leds } = findEntities();
    const led = leds[0];

    const cols = board.getValue(SocketGrid, "cols");
    const rowsPerHalf = board.getValue(SocketGrid, "rowsPerHalf");
    const pitch = board.getValue(SocketGrid, "pitch");
    const channelGap = board.getValue(SocketGrid, "channelGap");
    const sAW = localToWorld(
      board.object3D,
      getSocketLocalPosition(25, cols, rowsPerHalf, pitch, channelGap),
    );
    const sBW = localToWorld(
      board.object3D,
      getSocketLocalPosition(26, cols, rowsPerHalf, pitch, channelGap),
    );

    // Hover the LED close to target sockets (within 27mm snap threshold)
    // but offset by 1 column so the actual LED body doesn't overlap the
    // green markers — gives a clearer "where it would snap" preview.
    const off = led.getVectorView(Snappable, "leadAOffset");
    const cx = (sAW.x + sBW.x) / 2 + pitch * 1.0;
    const cz = (sAW.z + sBW.z) / 2;
    const cy = sAW.y - off[1] + 0.012;
    led.object3D.position.set(cx, cy, cz);
    led.object3D.rotation.set(0, 0, 0);
    led.object3D.updateMatrixWorld(true);

    // Mark as held so HoverPreviewSystem renders the green markers
    const hoverSys = window.__VM.world.getSystem(window.__VM.HoverPreviewSystem);
    hoverSys.heldEntities.add(led.index);
  });
  await page.waitForTimeout(300);
  await setCamera(page, [-0.2, 1.0, -0.55], [-0.2, 0.88, -1.05]);
  await shoot("hover-preview", page);
  await ctx.close();
}

// 8. Mid-progress — partial circuit (battery + 1 wire snapped, LED still in tray)
{
  const { page, ctx } = await newPage(1400, 900);
  await page.evaluate(installSnapHelpers);
  await page.evaluate(() => {
    const { snapEntityToSockets, findEntities, findWireByLength } =
      window.__VM_HELPERS;
    const { board, battery, wires } = findEntities();
    const mediumWire = findWireByLength(wires, 0.06);
    if (battery && board) snapEntityToSockets(battery, board, 4, 20);
    if (mediumWire && board) snapEntityToSockets(mediumWire, board, 20, 25);
  });
  await page.waitForTimeout(500);
  await setCamera(page, [-0.05, 1.05, -0.5], [-0.2, 0.88, -1.05]);
  await shoot("in-progress", page);
  await ctx.close();
}

await browser.close();
console.log(`All shots saved to ${OUT_DIR}/`);
