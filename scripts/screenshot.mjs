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

// 1. Hero — default player POV
{
  const { page, ctx } = await newPage(1600, 900);
  await shoot("hero", page);
  await ctx.close();
}

// 2. Robot character close-up — dynamic camera tracks robot position
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
    // Camera in front of robot's walking circle, at eye-level for the bot
    w.camera.position.set(rx + 1.4, ry + 0.6, rz + 1.0);
    w.camera.lookAt(rx, ry + 0.35, rz);
  });
  await page.waitForTimeout(400);
  await shoot("robot", page);
  await ctx.close();
}

// 3. Breadboard zoom — shows socket grid + transparent placement guides
{
  const { page, ctx } = await newPage(1400, 900);
  await setCamera(page, [-0.2, 1.15, -0.45], [-0.2, 0.86, -1.05]);
  await shoot("breadboard", page);
  await ctx.close();
}

// 4. Tray zoom — all parts visible
{
  const { page, ctx } = await newPage(1400, 900);
  await setCamera(page, [0.4, 1.2, -0.45], [0.4, 0.92, -1.1]);
  await shoot("tray", page);
  await ctx.close();
}

// 5. Assembled circuit — programmatically snap target parts, LED lights up
{
  const { page, ctx } = await newPage(1400, 900);
  await page.evaluate(() => {
    const { world, SnapSystem, components } = window.__VM;
    const { Snappable, SnapTarget, SocketGrid, WireEnds, LedState, PowerSource } =
      components;
    const snapSys = world.getSystem(SnapSystem);

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
      const thickness = 0.027;
      return { x, y: thickness / 2 + 0.0001, z };
    }

    function snapEntityToSockets(entity, board, sa, sb) {
      const cols = board.getValue(SocketGrid, "cols");
      const rowsPerHalf = board.getValue(SocketGrid, "rowsPerHalf");
      const pitch = board.getValue(SocketGrid, "pitch");
      const channelGap = board.getValue(SocketGrid, "channelGap");
      const sAL = getSocketLocalPosition(sa, cols, rowsPerHalf, pitch, channelGap);
      const sBL = getSocketLocalPosition(sb, cols, rowsPerHalf, pitch, channelGap);
      const tObj = board.object3D;
      tObj.updateWorldMatrix(true, false);
      const v = (x, y, z) => {
        const out = { x, y, z };
        const e = tObj.matrixWorld.elements;
        return {
          x: e[0] * x + e[4] * y + e[8] * z + e[12],
          y: e[1] * x + e[5] * y + e[9] * z + e[13],
          z: e[2] * x + e[6] * y + e[10] * z + e[14],
        };
      };
      const sAW = v(sAL.x, sAL.y, sAL.z);
      const sBW = v(sBL.x, sBL.y, sBL.z);
      const dx = sBW.x - sAW.x;
      const dz = sBW.z - sAW.z;
      const angleY = Math.atan2(dz, dx);
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

    const snappables = Array.from(snapSys.queries.snappables.entities);
    const targets = Array.from(snapSys.queries.snapTargets.entities);
    const board = targets[0];
    const battery = snappables.find((e) => e.hasComponent(PowerSource));
    const wires = snappables.filter((e) => e.hasComponent(WireEnds));
    const leds = snappables.filter((e) => e.hasComponent(LedState));
    const mediumWire = wires.find(
      (w) => Math.abs(w.getVectorView(Snappable, "leadAOffset")[0] + 0.06) < 0.001,
    );
    const shortWire = wires.find(
      (w) => Math.abs(w.getVectorView(Snappable, "leadAOffset")[0] + 0.024) < 0.001,
    );
    const redLed = leds[0];

    if (battery && board) snapEntityToSockets(battery, board, 4, 20);
    if (mediumWire && board) snapEntityToSockets(mediumWire, board, 20, 25);
    if (redLed && board) snapEntityToSockets(redLed, board, 25, 26);
    if (shortWire && board) snapEntityToSockets(shortWire, board, 26, 10);
  });
  await page.waitForTimeout(600);
  await setCamera(page, [-0.2, 1.05, -0.5], [-0.2, 0.88, -1.05]);
  await shoot("assembled", page);
  await ctx.close();
}

await browser.close();
console.log(`All shots saved to ${OUT_DIR}/`);
