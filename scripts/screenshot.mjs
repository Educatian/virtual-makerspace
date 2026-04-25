import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const URL = process.env.URL ?? "https://localhost:8081/";
const OUT_DIR = "docs/images";

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  args: ["--ignore-certificate-errors"],
});

async function shoot(name, viewport, cameraSetup) {
  const context = await browser.newContext({
    viewport,
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("PAGE ERROR:", msg.text());
  });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4500);
  if (cameraSetup) {
    await page.evaluate(cameraSetup);
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: false });
  await context.close();
  console.log(`Captured ${name}.png`);
}

await shoot("hero", { width: 1600, height: 900 });

await shoot(
  "breadboard-closeup",
  { width: 1400, height: 900 },
  () => {
    const c = document.querySelector("canvas");
    if (c) {
      // tap into Three.js camera if exposed
    }
  },
);

await browser.close();
console.log("All shots saved to docs/images/");
