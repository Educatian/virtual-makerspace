// The lobby preview of Sound Flow Studio (public/lobby/sound.webp), rendered from the app itself:
// a patched desk at 1280×898 (the other lobby images' size) with the panels hidden.
//   node scripts/qa-sound-lobby.mjs http://127.0.0.1:4173 <out.png>
// then: python3 -c "from PIL import Image; Image.open('<out.png>').save('public/lobby/sound.webp', quality=82)"
import { chromium } from "playwright";
import { instrument, settled } from "./lib/e2e-readiness.mjs";

const [base = "http://127.0.0.1:4173", out = "sound-lobby.png"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-proxy-server"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 898 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
await instrument(context);
const page = await context.newPage();
page.setDefaultTimeout(600_000);
await page.goto(`${base}/?room=QLBY&name=QA&studio=sound&qa=1&quality=high`);
await page.click("#enter-room");
await page.waitForFunction(() => Boolean(window.__vmQa?.sound));
await page.locator("#dock-collapse").click();
for (const [id, a, b] of [["snd-cable-a", 0, 1], ["snd-cable-b", 2, 3], ["snd-cable-c", 4, 5]]) {
  await page.evaluate(({ id, a, b }) => { window.__vmQa.dropEnd(id, 0, a); window.__vmQa.dropEnd(id, 1, b); }, { id, a, b });
}
await page.addStyleTag({ content: ".workspace-header,.component-rail,.discussion-dock,.viewport-toolbar,.view-presets,.scene-status,.challenge-card,.attempt-drawer,.dock-reopen,.selection-toolbar,.recovery-banner{visibility:hidden!important}" });
await page.evaluate(() => window.__vmQa.view([-0.2, 5.4, 6.3], [-1.05, 0.35, 0.35]));
await settled(page, "lobby");
await page.screenshot({ path: out });
await browser.close();
