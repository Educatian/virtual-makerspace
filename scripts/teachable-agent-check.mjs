// Self-check for the AI teammate's pure logic:
//   node --experimental-strip-types scripts/teachable-agent-check.mjs
import assert from "node:assert/strict";
const { analyzeCircuit, planCircuitLayout, socketIndex, WIRE_MAX_SPAN } = await import("../src/desktop/circuit-topology.ts");
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

// Wires never span more than they can reach, so every planned part actually snaps.
for (const strips of [false, true]) for (const loop of [false, true]) for (const resistor of [false, true]) {
  for (const part of planCircuitLayout({ strips, loop, resistor })) {
    if (!part.id.startsWith("wire-")) continue;
    const span = Math.abs((part.sockets[0] % 16) - (part.sockets[1] % 16));
    assert.ok(span <= WIRE_MAX_SPAN[part.id], `${part.id} spans ${span}`);
  }
}

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
const solo = { addressed: true };

// Naming without a reason earns one "why?" and only partial credit.
let heard = mind.hear("Put a resistor in there.", "Ana", solo);
assert.equal(mind.belief("resistor").status, "partial");
assert.equal(heard.asked, "resistor");
assert.match(heard.replies[0], /What does the resistor actually do/);
assert.equal(mind.layoutBeliefs().resistor, false, "partial knowledge is not acted on");
assert.deepEqual(mind.hear("I moved the resistor over.", "Ana", solo).replies, [], "asks why once, not on every mention");

// Answering the pending "why" without repeating the keyword still teaches.
clock += 5_000;
heard = mind.hear("It stops too much current from burning out the LED.", "Ana", solo);
assert.equal(mind.belief("resistor").status, "taught");
assert.equal(heard.learned[0].quality, "explained");
assert.equal(mind.belief("resistor").quote, "It stops too much current from burning out the LED.");

// Explained in one go.
mind.hear("The holes are connected in vertical columns, not across the row.", "Ana", solo);
assert.equal(mind.knows("strips"), true);
mind.hear("It has to go all the way around back to the other side of the battery because current flows in a loop", "Ana", solo);
assert.equal(mind.knows("loop"), true);
assert.deepEqual(mind.layoutBeliefs(), { strips: true, loop: true, resistor: true });
assert.match(mind.reflection(), /^Here's what I learned today: parts only connect/);

// A why-question about Bolt's choice gets its reasoning, not learning.
const fresh = new TeachableMind();
heard = fresh.hear("Why did you put the LED right next to the battery?", "Ana", solo);
assert.equal(heard.learned.length, 0);
assert.match(heard.replies[0], /Is that wrong\?$/);

// Korean teaching works too.
const ko = new TeachableMind();
ko.hear("저항은 전류를 제한해서 LED가 타지 않게 보호해", "지민", solo);
assert.equal(ko.knows("resistor"), true);
ko.hear("가로줄은 연결 안 돼, 세로로 연결돼", "지민", solo);
assert.equal(ko.knows("strips"), true);
assert.deepEqual(new TeachableMind().hear("너무 어렵다 다시 해볼게", "지민", { addressed: false }).commands, [], "너무 is not 너, and 해볼게 is first person");

// Wrong or empty reasons never teach — and Bolt never corrects them (no hints).
const wrongs = [
  ["strips", "rows are connected"],
  ["strips", "the columns are not connected"],
  ["strips", "가로 줄은 연결돼"],
  ["loop", "it doesn't need to come back to the battery"],
  ["resistor", "you don't need a resistor because the LED is fine"],
];
for (const [concept, line] of wrongs) {
  const m = new TeachableMind();
  const r = m.hear(line, "Ana", solo);
  assert.equal(m.knows(concept), false, `wrong idea taught: ${line}`);
  assert.equal(r.learned[0]?.quality, "affirmed-naive", `not logged as affirming the naive idea: ${line}`);
  assert.match(r.replies[0], /That's what I thought too/, line);
}
const vague = new TeachableMind({ now: () => clock });
vague.hear("Why did you line them up like that?", "Ana", solo);
for (const line of ["yes because it's wrong", "because I said so"]) {
  const r = vague.hear(line, "Ana", solo);
  assert.equal(vague.knows("strips"), false, `vague reason taught: ${line}`);
  assert.ok(r.replies.every((reply) => !/column/i.test(reply)), "no concept leak in the nudge");
}
// A taught idea contradicted later gets the teacher's own words back, not the answer.
const contradicted = mind.hear("actually rows are connected", "Ben", solo).replies[0];
assert.match(contradicted, /earlier Ana said "The holes are connected/);
assert.match(mind.hear("rows are connected after all", "Ana", solo).replies[0], /earlier you said/, "the same teacher is 'you'");

// Second review: empty or wrong reasons, fault diagnoses, and missing phrasings.
for (const [concept, line, expected] of [
  ["loop", "the loop", false],
  ["loop", "the loop is broken", false],
  ["resistor", "resistors don't limit current", false],
  ["resistor", "the resistor won't protect anything", false],
  ["resistor", "the resistor protects nothing", false],
  ["loop", "it won't light unless the current goes all the way around", true],
  ["loop", "the LED is dark because the current doesn't come back to the battery", true],
  ["loop", "the current needs a path back to the battery", true],
  ["loop", "전류가 배터리로 돌아와야 해", true],
  ["strips", "it's not connected because it's not in the same column", true],
  ["strips", "Holes in a row aren't connected, the columns are", true],
]) {
  const m = new TeachableMind();
  m.hear(line, "Ana", solo);
  assert.equal(m.knows(concept), expected, `${expected ? "should" : "should not"} teach ${concept}: ${line}`);
}
for (const line of ["the LED is dark because the current doesn't come back to the battery", "it's not connected because it's not in the same column"]) {
  assert.doesNotMatch(new TeachableMind().hear(line, "Ana", solo).replies.join(" "), /thought too/, `a correct diagnosis isn't the naive idea: ${line}`);
}
assert.ok(new TeachableMind().hear("move the LED up one row", "Ana", solo).replies.length === 0, "rows alone aren't a topic");
assert.deepEqual(new TeachableMind().hear("can you check the build?", "Ana", solo).commands, []);
assert.deepEqual(new TeachableMind().hear("Bolt you build, I'll check", "Ana", solo).commands, ["become-builder"]);
assert.deepEqual(new TeachableMind().hear("you build and I'll check it", "Ana", solo).commands, ["become-builder"]);
const asker = new TeachableMind();
const firstWhy = asker.hear("why did you do that?", "Ana", solo).replies[0];
assert.notEqual(asker.hear("why?", "Ana", solo).replies[0], firstWhy, "a repeated why gets a different answer");

// Questions and incidental phrases never teach; human-to-human chat doesn't steer Bolt.
const careful = new TeachableMind();
careful.hear("Do we have a complete circuit?", "Ana", solo);
careful.hear("Is the resistor safe?", "Ana", solo);
careful.hear("move it around a bit", "Ana", solo);
careful.hear("make it safe so it doesn't burn", "Ana", solo);
assert.deepEqual(careful.layoutBeliefs(), { strips: false, loop: false, resistor: false });
assert.deepEqual(careful.hear("ok go ahead").commands, [], "unaddressed chat is not a command");
assert.deepEqual(careful.hear("ok go ahead", "Ana", solo).commands, ["rebuild"]);
assert.deepEqual(careful.hear("can you check the LED?", "Ana", solo).commands, [], "a question is not a role change");
assert.deepEqual(careful.hear("did you build it right?", "Ana", solo).commands, []);
assert.deepEqual(careful.hear("I'll fix it", "Ana", solo).commands, [], "first person is not a request");
assert.deepEqual(careful.hear("Can you build it?", "Ana", solo).commands, ["become-builder", "rebuild"]);
assert.deepEqual(careful.hear("I'll build, you check", "Ana", solo).commands, ["become-verifier"]);
careful.hear("Add a resistor.", "Ana", solo);
careful.hear("I think so, since the bus is late", "Ana");
assert.equal(careful.belief("resistor").status, "partial", "an unaddressed 'since' doesn't answer Bolt's why");

// Prior knowledge is Bolt's own, not "you taught me".
const intermediate = new TeachableMind({ profile: "intermediate" });
assert.match(intermediate.hear("why did you add that wire?", "Ana", solo).replies[0] ?? "", /^(I know that|I think)/);

// Saved memory only applies to the same, well-formed profile, and keeps its history.
assert.equal(new TeachableMind({ profile: "intermediate", restored: mind.snapshot() }).knows("strips"), false);
assert.equal(new TeachableMind({ restored: { profile: "novice" } }).knows("loop"), false, "malformed memory is ignored");
assert.ok(new TeachableMind({ restored: mind.snapshot() }).exportState().transitions.length >= 3, "transitions survive a reload");

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
