import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const URL_BASE = process.env.URL ?? "https://localhost:8081/";
const OUT_DIR = "docs/images";

function urlWith(params) {
  const u = new URL(URL_BASE);
  u.searchParams.set("screenshot", "1");
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  args: ["--ignore-certificate-errors"],
});

async function newPage(width = 1600, height = 900, params = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("PAGE ERR:", msg.text());
  });
  await page.goto(urlWith(params), {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(() => window.__VM !== undefined, {
    timeout: 15000,
  });
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

// M3 hero — full workspace from default POV
{
  const { page, ctx } = await newPage(1600, 900, { module: "3" });
  await shoot("module3-hero", page);
  await ctx.close();
}

// M3 dataset cube close-up
{
  const { page, ctx } = await newPage(1400, 900, { module: "3" });
  await setCamera(page, [0.0, 1.25, -0.5], [0.0, 1.05, -1.1]);
  await shoot("module3-dataset", page);
  await ctx.close();
}

// M3 bins at table edge
{
  const { page, ctx } = await newPage(1400, 900, { module: "3" });
  await setCamera(page, [0.0, 1.25, -0.25], [0.0, 0.86, -0.65]);
  await shoot("module3-bins", page);
  await ctx.close();
}

// M3 accuracy meter close-up
{
  const { page, ctx } = await newPage(1400, 700, { module: "3" });
  await setCamera(page, [0.0, 1.55, -0.7], [0.0, 1.55, -1.1]);
  await shoot("module3-accuracy", page);
  await ctx.close();
}

// M2 stub
{
  const { page, ctx } = await newPage(1400, 900, { module: "2" });
  await setCamera(page, [0.0, 1.55, -0.6], [0.0, 1.5, -1.1]);
  await shoot("module2-stub", page);
  await ctx.close();
}

// M4 stub
{
  const { page, ctx } = await newPage(1400, 900, { module: "4" });
  await setCamera(page, [0.0, 1.55, -0.6], [0.0, 1.5, -1.1]);
  await shoot("module4-stub", page);
  await ctx.close();
}

await browser.close();
console.log(`Module screenshots saved to ${OUT_DIR}/`);
