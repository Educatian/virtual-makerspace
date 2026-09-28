// End-to-end room sync against a local `wrangler dev` Worker (Durable Object + WebSocket).
// Three headless makers (host, member, late joiner) check studio locking, program sync,
// persistence, and host studio switching.
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799      # stands in for Cloudflare Access
//   node scripts/e2e-room-sync.mjs               # → http://vm.test:8800
//
// vm.test (not localhost) is required: on localhost the client skips the WebSocket and
// syncs tabs over BroadcastChannel only.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `T${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8799", "--ignore-certificate-errors"] });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

async function maker(email) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  // plain-http test origin is not a secure context; production (https) has randomUUID natively
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on("pageerror", (e) => console.error(`[${email}] pageerror:`, e.message));
  return page;
}
const heading = (page) => page.locator("#viewport-heading").textContent();
const d5High = async (page) => (await page.locator(".pin-led", { hasText: "D5" }).getAttribute("class")).includes("is-high");
async function sawD5Toggle(page) {
  let high = false, low = false;
  for (let i = 0; i < 20 && !(high && low); i++) { (await d5High(page)) ? (high = true) : (low = true); await page.waitForTimeout(100); }
  return high && low;
}

// Host creates a Snapino room
const host = await maker("host@example.test");
await host.goto(`${base}/?room=${room}`);
await host.getByRole("radio", { name: /Snapino Bridge/ }).click();
await host.getByRole("button", { name: "Enter Room" }).click();
await host.waitForSelector("#viewport-heading");
await host.waitForTimeout(3000);
check("host enters the chosen studio", (await heading(host)) === "Snapino", await heading(host));
check("host sees studio tabs", await host.locator(".studio-switch").isVisible());

// Member previews the room, then enters the same studio
const member = await maker("member@example.test");
await member.goto(`${base}/?room=${room}`);
await member.waitForTimeout(1500);
const note = (await member.locator("#room-studio").textContent())?.trim() ?? "";
check("member lobby shows the room's studio", note.includes("Snapino Bridge"), note);
check("other studio cards are locked", await member.getByRole("radio", { name: /Greenhouse/ }).isDisabled());
await member.getByRole("button", { name: "Enter Room" }).click();
await member.waitForSelector("#viewport-heading");
await member.waitForTimeout(3000);
check("member enters the room's studio", (await heading(member)) === "Snapino", await heading(member));
check("member has no studio tabs", await member.locator(".studio-switch").isHidden());

// Host wires the lamp; member's scene receives the transforms
await host.getByRole("button", { name: "Load Snapino lamp" }).click();
await member.waitForTimeout(1500);
await member.getByRole("button", { name: "Snapino code" }).click();
await host.getByRole("button", { name: "Snapino code" }).click();

// Host uploads; member's board runs it and the lamp powers on the member's side
await host.getByRole("button", { name: "Upload & Run" }).click();
await member.waitForTimeout(1200);
check("member receives the upload", ((await member.locator("#code-status").textContent()) ?? "").includes("Running"), await member.locator("#code-status").textContent());
check("member's D5 blinks", await sawD5Toggle(member));
let memberLit = false;
for (let i = 0; i < 12 && !memberLit; i++) {
  memberLit = (await member.locator("#check-circuit").getAttribute("class")).includes("is-valid");
  await member.waitForTimeout(100);
}
check("member's lamp lights from synced wiring + code", memberLit);

// Late joiner gets the persisted program without anyone re-uploading
const late = await maker("late@example.test");
await late.goto(`${base}/?room=${room}`);
await late.getByRole("button", { name: "Enter Room" }).click();
await late.waitForSelector("#viewport-heading", { state: "attached", timeout: 90000 });
await late.waitForTimeout(3000);
await late.getByRole("button", { name: "Snapino code" }).click();
check("late joiner loads the persisted running program", ((await late.locator("#code-status").textContent()) ?? "").includes("Running"), await late.locator("#code-status").textContent());

// Member stops it for everyone
await member.getByRole("button", { name: "Stop" }).click();
await host.waitForTimeout(1200);
check("stop propagates to host", ((await host.locator("#code-status").textContent()) ?? "").includes("Stopped"), await host.locator("#code-status").textContent());

// Host moves the room; member follows, member cannot move it
await host.locator('.studio-tab[data-studio="circuit"]').click();
await member.waitForTimeout(1500);
check("host studio switch moves member", (await heading(member)) === "Motherboard", await heading(member));

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · room ${room}`);
assert.equal(failed.length, 0);
