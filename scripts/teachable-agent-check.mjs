// Self-check for the AI teammate's pure logic:
//   node --experimental-strip-types scripts/teachable-agent-check.mjs
import assert from "node:assert/strict";
const { analyzeCircuit, planCircuitLayout, socketIndex } = await import("../src/desktop/circuit-topology.ts");
const { TeachableMind } = await import("../src/desktop/teachable-agent.ts");

const toPlacements = (plan) => Object.fromEntries(plan.map((part) => [part.id, part.sockets]));
const all = (strips, loop, resistor) => analyzeCircuit(toPlacements(planCircuitLayout({ strips, loop, resistor })));

// The scene's own diagnostic layout (DesktopWorkbenchScene.loadCircuitDemo) must read as powered.
const demo = analyzeCircuit({ "battery-9v": [21, 23], "resistor-220": [36, 39], "led-red": [52, 53] });
assert.equal(demo.powered, true, "demo circuit lights");
assert.equal(demo.resistorInSeries, true);
assert.deepEqual(demo.unsafeLeds, []);

// Only a builder holding all three ideas makes a safe, lit circuit.
for (const strips of [false, true]) for (const loop of [false, true]) for (const resistor of [false, true]) {
  const a = all(strips, loop, resistor);
  const shouldLight = strips && loop;
  assert.equal(a.powered, shouldLight, `powered for strips=${strips} loop=${loop} resistor=${resistor}`);
  assert.equal(a.unsafeLeds.length > 0, shouldLight && !resistor, `unsafe for strips=${strips} loop=${loop} resistor=${resistor}`);
}
const correct = all(true, true, true);
assert.ok(correct.columnBridges.length >= 3, "correct build joins parts through column strips");
assert.equal(correct.bothBatteryTerminalsUsed, true);
const naive = all(false, false, false);
assert.ok(naive.rowNeighbors.length >= 1, "naive build puts parts side by side in a row");
assert.equal(naive.columnBridges.length, 0);

// Plans never reuse a socket and stay on the board.
for (const strips of [false, true]) for (const loop of [false, true]) for (const resistor of [false, true]) {
  const sockets = planCircuitLayout({ strips, loop, resistor }).flatMap((part) => part.sockets);
  assert.equal(new Set(sockets).size, sockets.length, "no shared hole");
  assert.ok(sockets.every((socket) => socket >= 0 && socket < 16 * 12));
}

// Learning by teaching.
let clock = 1_000;
const mind = new TeachableMind({ now: () => clock });
assert.deepEqual(mind.layoutBeliefs(), { strips: false, loop: false, resistor: false });

// Naming without a reason earns a "why?" and only partial credit.
let heard = mind.hear("Put a resistor in there.", "Ana");
assert.equal(mind.belief("resistor").status, "partial");
assert.equal(heard.asked, "resistor");
assert.match(heard.replies[0], /why/i);
assert.equal(mind.layoutBeliefs().resistor, false, "partial knowledge is not acted on");

// Answering the pending "why" without repeating the keyword still teaches.
clock += 5_000;
heard = mind.hear("It stops too much current from burning out the LED.", "Ana");
assert.equal(mind.belief("resistor").status, "taught");
assert.equal(heard.learned[0].quality, "explained");
assert.equal(mind.belief("resistor").quote, "It stops too much current from burning out the LED.");

// Explained in one go.
mind.hear("The holes are connected in vertical columns, not across the row.", "Ana");
assert.equal(mind.knows("strips"), true);
mind.hear("It has to go all the way around back to the other side of the battery because current flows in a loop", "Ana");
assert.equal(mind.knows("loop"), true);
assert.deepEqual(mind.layoutBeliefs(), { strips: true, loop: true, resistor: true });

// A why-question about Bolt's choice gets its reasoning, not learning.
const fresh = new TeachableMind();
heard = fresh.hear("Why did you put the LED right next to the battery?", "Ana");
assert.equal(heard.learned.length, 0);
assert.match(heard.replies[0], /Here's what I was thinking/);

// Korean teaching works too.
const ko = new TeachableMind();
ko.hear("저항은 전류를 제한해서 LED가 타지 않게 보호해", "지민");
assert.equal(ko.knows("resistor"), true);

// Questions and incidental phrases never teach; human-to-human chat doesn't steer Bolt.
const careful = new TeachableMind();
careful.hear("Do we have a complete circuit?", "Ana");
careful.hear("Is the resistor safe?", "Ana");
careful.hear("move it around a bit", "Ana");
assert.deepEqual(careful.layoutBeliefs(), { strips: false, loop: false, resistor: false });
assert.deepEqual(careful.hear("ok go ahead", "Ana").commands, [], "unaddressed chat is not a command");
assert.deepEqual(careful.hear("ok go ahead", "Ana", { addressed: true }).commands, ["rebuild"]);
careful.hear("Add a resistor.", "Ana");
careful.hear("I think so, since the bus is late", "Ana");
assert.equal(careful.belief("resistor").status, "partial", "an unaddressed 'since' doesn't answer Bolt's why");

// Saved memory only applies to the same, well-formed profile.
assert.equal(new TeachableMind({ profile: "intermediate", restored: mind.snapshot() }).knows("strips"), false);
assert.equal(new TeachableMind({ restored: { profile: "novice" } }).knows("loop"), false, "malformed memory is ignored");

// Verifier review: questions contradictions once, then applies what it learned.
const reviewer = new TeachableMind();
const describe = ([a, b]) => `${a} and ${b}`;
const firstRemark = reviewer.reviewBoard(correct, describe);
assert.equal(firstRemark.kind, "conflict");
assert.equal(firstRemark.concept, "strips");
const seen = new Set([firstRemark.concept]);
let remark;
while ((remark = reviewer.reviewBoard(correct, describe))) seen.add(remark.concept);
assert.deepEqual([...seen].sort(), ["loop", "resistor", "strips"]);
assert.equal(reviewer.reviewBoard(correct, describe), null, "no repeats until reset");

const unsafe = all(true, true, false);
assert.equal(mind.reviewBoard(unsafe, describe).kind, "applied", "taught Bolt flags a missing resistor");
assert.match(mind.reactToTest(unsafe, false, false), /no resistor/);
assert.match(fresh.reactToTest(naive, true, false), /What did I get wrong/);
assert.doesNotMatch(fresh.reactToTest(naive, true, false), /row/, "PF: no unprompted reasoning");
assert.match(fresh.reactToTest(naive, true, true), /row/, "DI: voices its own reasoning");

// Export carries states and transitions but never the teacher's words.
const exported = JSON.stringify(mind.exportState());
assert.doesNotMatch(exported, /burning/);
assert.equal(mind.exportState().beliefs.resistor, "taught");
assert.equal(new TeachableMind({ restored: mind.snapshot() }).knows("loop"), true);
assert.equal(mind.notebook().length, 3);

console.log("teachable-agent: all checks passed");
