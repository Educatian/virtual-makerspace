// Bolt over the production transport: Worker + Durable Object WebSocket rooms.
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799      # stands in for Cloudflare Access
//   node scripts/e2e-ai-teammate-worker.mjs      # → http://vm.test:8800
//
// Checks that the Worker admits Bolt only beside its host, names it and marks it as an agent,
// relays its moves, and that a late joiner gets the board from the human host, not from Bolt.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import WebSocket from "ws";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `W${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // --no-proxy-server: keep the local WebSocket off any machine-wide HTTP proxy.
  args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function maker(email, query = "") {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  page.on("pageerror", (error) => console.error(`[${email}] pageerror:`, error.message));
  await page.goto(`${base}/?room=${room}&studio=circuit${query}`);
  await page.waitForSelector("#enter-room");
  await page.waitForFunction(() => !document.querySelector("#enter-room")?.disabled);
  await page.evaluate(() => document.querySelector("#enter-room").click());
  await page.waitForSelector("#viewport-heading");
  return page;
}
const boltLines = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".chat-message")]
    .filter((row) => row.querySelector(".avatar.is-agent"))
    .map((row) => row.querySelector("p")?.textContent ?? ""));
async function waitFor(page, pattern, count = 1, timeout = 150_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if ((await boltLines(page)).filter((line) => pattern.test(line)).length >= count) return true;
    await page.waitForTimeout(500);
  }
  return false;
}
const say = (page, text) => page.evaluate((body) => {
  document.querySelector("#chat-input").value = body;
  document.querySelector("#chat-form").requestSubmit();
}, text);
const powered = (page) => page.evaluate(() => document.querySelector("#check-circuit")?.classList.contains("is-valid") ?? false);
const roster = (page) => page.evaluate(() => {
  document.querySelector('.discussion-tab[data-tab="team"]')?.click();
  return [...document.querySelectorAll(".team-member")].map((row) => ({
    name: row.querySelector("strong")?.textContent ?? "",
    agent: Boolean(row.querySelector(".avatar.is-agent")),
  }));
});

// An agent socket with no host in the room is refused.
const refused = await new Promise((resolve) => {
  const socket = new WebSocket(
    `${base.replace("http", "ws")}/api/room?room=7K3M&participant=solo@example.test:x&agent=1`,
    { headers: { Origin: base, Host: new URL(base).host, Cookie: "e2e_email=solo%40example.test" }, lookup: (_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]) },
  );
  socket.on("open", () => { socket.close(); resolve(false); });
  socket.on("unexpected-response", (_request, response) => resolve(response.statusCode === 403));
  socket.on("error", (error) => { console.error("agent socket error:", error.message); resolve(false); });
});
check("Worker refuses an AI teammate whose host isn't in the room", refused);

const host = await maker("host@example.test", "&teammate=ai");
await host.waitForFunction(() => document.querySelector(".chat-message .avatar.is-agent"), null, { timeout: 120_000 });
const hostRoster = await roster(host);
check("Bolt joins over the Worker as an agent named Bolt", hostRoster.some((row) => row.agent && /Bolt/.test(row.name)), JSON.stringify(hostRoster));
check("Bolt's greeting relays through the Durable Object", await waitFor(host, /I'm Bolt/));

await say(host, "Bolt, you build it. Holes in a row aren't connected — the board connects them in vertical column strips, so parts have to share a column.");
await waitFor(host, /share a column\. Got it/);
await say(host, "The path has to come back to the other side of the battery because current flows around a complete loop.");
// Teaching mid-build supersedes the running build, so expect at least one finished build.
check("Bolt builds over WebSocket after being taught", await waitFor(host, /^Done\./, 1, 300_000));
let lit = false;
for (let i = 0; i < 60 && !lit; i += 1) { lit = await powered(host); if (!lit) await host.waitForTimeout(2000); }
check("host scene lights from Bolt's relayed moves", lit);

const member = await maker("member@example.test");
await member.waitForTimeout(8000);
const memberRoster = await roster(member);
check("a late joiner sees Bolt as an agent", memberRoster.some((row) => row.agent && /Bolt/.test(row.name)), JSON.stringify(memberRoster));
check("the late joiner gets Bolt's circuit from the human host", await powered(member));
check("the late joiner is not offered a second Bolt", await member.evaluate(() => !document.querySelector("#invite-ai")));

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
