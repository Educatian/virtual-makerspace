// Cable ends over the real Worker (Durable Object + WebSocket), two browsers, through the
// app's own drag path (claim → snapped move → release in one task, via the ?qa hook):
// a seated end must stay seated for its mover, reach the teammate, count as one undo step,
// and reach a late joiner; two people may each seat one end of the same cable.
//
//   npm run build
//   npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
//   node scripts/access-proxy.mjs 8800 8799
//   node scripts/e2e-cable-end.mjs                 # → http://vm.test:8800 (fresh random room)
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://vm.test:8800";
const room = `W${Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[01IO]/g, "Z")}`;
assert.notEqual(room, "7K3M");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--host-resolver-rules=MAP vm.test 127.0.0.1", "--unsafely-treat-insecure-origin-as-secure=http://vm.test:8799", "--no-proxy-server", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const press = async (page, name) => {
  const handle = await page.waitForFunction((label) => [...document.querySelectorAll("button")].find((candidate) =>
    !candidate.disabled && (candidate.getAttribute("aria-label") === label || candidate.textContent.trim() === label)), name, { timeout: 120_000 });
  await handle.evaluate((button) => button.click());
};
const until = async (read, test, timeout = 30_000) => {
  const started = Date.now();
  let value = await read();
  while (!test(value) && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
};
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

async function open(email, label) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.addCookies([{ name: "e2e_email", value: encodeURIComponent(email), url: base }]);
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  page.on("pageerror", (error) => console.error(`[${label}] pageerror:`, error.message));
  await page.goto(`${base}/?room=${room}&quality=low&qa`);
  await press(page, "Enter Room");
  await page.waitForSelector("#viewport-heading", { state: "attached" });
  await page.waitForFunction(() => Boolean(window.__vmQa?.dropEnd), null, { timeout: 300_000 });
  await page.waitForTimeout(2500);
  return page;
}
const wire = (page) => page.evaluate(() => window.__vmQa.bench().parts["wire-red"]?.sockets ?? null);

const host = await open("host@example.test", "host");
const member = await open("member@example.test", "member");
check("both makers are on the Circuit Bench", (await host.evaluate(() => window.__vmQa.bench().studio)) === "circuit");

// Host seats end A in c5 (socket 36) exactly as a pointer drag would.
check("the drag path accepts the drop", await host.evaluate(() => window.__vmQa.dropEnd("wire-red", 0, 36)));
const seen = await until(() => wire(member), (sockets) => sockets?.[0] === 36);
check("the teammate sees end A seated", seen?.[0] === 36, JSON.stringify(seen));
await host.waitForTimeout(1500);
check("the mover's end stays seated (its final move was not refused)", (await wire(host))?.[0] === 36, JSON.stringify(await wire(host)));
check("the accepted drag is one undo step", await host.evaluate(() => window.__vmQa.bench().canUndo));

// The teammate seats the other end of the same cable.
await member.evaluate(() => window.__vmQa.dropEnd("wire-red", 1, 39));
const both = await until(() => wire(host), (sockets) => sockets?.[1] === 39);
check("each end can be seated by a different maker", JSON.stringify(both) === "[36,39]" && JSON.stringify(await wire(member)) === "[36,39]", JSON.stringify(both));

// A late joiner gets both ends from the room.
await member.context().close();
const late = await open("late@example.test", "late");
const lateWire = await until(() => wire(late), (sockets) => JSON.stringify(sockets) === "[36,39]");
check("a late joiner gets both seated ends from the room", JSON.stringify(lateWire) === "[36,39]", JSON.stringify(lateWire));

await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · room ${room}`);
assert.equal(failed.length, 0);
