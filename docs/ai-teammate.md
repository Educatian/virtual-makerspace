# AI Teammate (Bolt) — teachable agent for collaborative problem solving

Status: implemented for the desktop **Circuit Bench** (`?studio=circuit`). Other studios: Bolt joins, watches, and follows readiness, but has no concept model yet.

## Why

The desktop collaborative mode was designed for 2–3 humans: builder/verifier roles, the shared frame → build → test → reflect protocol, readiness gating, and participation traces. A learner who is alone (common in rural or after-school settings) stalls at "Collaborator needed". Bolt fills the empty seat with a **teammate, not a tutor**: a teachable agent in the tradition of Betty's Brain (Biswas, Leelawong, Schwartz & Vye, 2005) that knows less than the learner and improves only when the learner teaches it.

Two design consequences follow:

1. **Learning by teaching.** Bolt's mistakes are the learner's opportunities to explain. The protégé effect (Chase, Chin, Oppezzo & Schwartz, 2009) predicts more effort and better explanations when learners are responsible for someone else's learning.
2. **Compatible with Productive Failure.** Bolt never holds a correct idea nobody taught it, so it cannot leak hints. In PF sessions it also stays quiet about its own reasoning unless asked (see Conditions).

## Architecture

```
learner tab
├── DesktopRoom (learner)  ◄──── room transport (BroadcastChannel | WebSocket/Durable Object) ────►  other makers
├── DesktopWorkbenchScene   applies Bolt's moves via applyRemoteTransform, like any remote maker
└── AiTeammate (Bolt)
    ├── DesktopRoom (agent: true)   its own participant: presence, chat, claim/move/release, ready, traces
    ├── TeachableMind               beliefs, teaching interpretation, plans, questions   (pure)
    └── circuit-topology            net analysis + belief-driven layout planner            (pure)
```

- `src/desktop/ai-teammate.ts` — the controller. Decides *when* Bolt speaks and acts; never decides *what is true*.
- `src/desktop/teachable-agent.ts` — `TeachableMind`. Deterministic, no DOM, unit-tested.
- `src/desktop/circuit-topology.ts` — breadboard nets (mirrors `evaluateCircuit`), `analyzeCircuit`, `planCircuitLayout(beliefs)`.
- `src/desktop/remote-hands.ts` — translucent ghost hands shown when Bolt or any remote maker holds a part.

Because Bolt is a real participant on the wire, **human–human and human–AI sessions produce the same trace schema** and the same participation measures. In production the Worker admits Bolt with `?agent=1` only while its host (the same signed-in maker) is connected: fixed name "Bolt", `kind: "agent"` in presence, no host rights, no Neon membership row. Bolt never becomes the room's state coordinator and never decides the human builder role. One Bolt per room: if two tabs invite one, the later Bolt steps aside.

## Bolt's knowledge (Circuit Bench)

| Concept | Naive idea Bolt starts with | Taught idea | Visible consequence when naive |
|---|---|---|---|
| `strips` | Holes in the same row are connected | Holes connect in vertical column strips; parts must share a strip | Parts lined up end-to-end along one row → open circuit |
| `loop` | One connection from the battery is enough | Current must return to the other battery terminal | No return wire → open circuit |
| `resistor` | Extra parts just slow things down | A series resistor limits current so the LED doesn't burn out | LED straight across the battery → lights, but unsafe |

Belief states: `naive` → `partial` (told *what*, not *why*) → `taught`. Bolt acts only on `taught` ideas.

**Teaching** happens in chat. A message counts as teaching an idea when it names the idea (keywords) **and** gives a reason — the idea's own mechanism words ("limits current", "share a column", "complete loop") or a causal connective ("because", "otherwise", "so that") when the message is about one idea. Directives alone ("use the columns", "add a resistor") earn a "why?" and only `partial` credit. Questions never teach ("Is the resistor safe?"). When more than one human is in the room, commands ("try again") and bare follow-ups to Bolt's "why?" must address Bolt ("Bolt…", "you…") so human-to-human talk doesn't steer it. A reply to Bolt's pending "why?" can explain without repeating the keyword. Korean phrasing is recognized too. The learner's exact words are stored in **Bolt's notebook** (Team tab) — the analogue of Betty's Brain's student-built concept map.

Profiles: `?agentProfile=novice` (default, all naive) or `intermediate` (`loop` already taught).

## Behavior by role and phase

| | Bolt is **builder** | Bolt is **verifier** (default when the learner builds) |
|---|---|---|
| Frame | States its plan from its beliefs; asks "Does that sound right?" | Asks the learner to walk through the plan |
| Build | Builds its plan, part by part, with its ghost hand; rebuilds right after being taught | After the learner's moves settle, questions what contradicts its naive ideas ("Why add the resistor?") or applies what it was taught ("You taught me rows aren't connected — are these joined?") |
| Test | Reacts to the result: dark → "What did I get wrong?"; lit but unsafe → depends on whether it was taught `resistor` | Same reactions |
| Reflect | Restates what it was taught and by whom, and what it is still unsure about | Same |

Readiness: Bolt marks ready once its own work is done and a human is ready (or the team is in Test), so it never blocks the shared test. Chat commands: "Bolt, you build" / "you check" swap roles; "rebuild" / "try again" asks it to build.

## Conditions and URL parameters

| Parameter | Values | Effect |
|---|---|---|
| `teammate` | `ai` | Invite Bolt on room entry (otherwise: "Add Bolt" in the Team tab) |
| `agentRole` | `builder` \| `verifier` | Bolt's starting role (default: opposite of the learner's) |
| `agentProfile` | `novice` \| `intermediate` | Starting beliefs |
| `condition` | `PF` \| `DI` | `PF`: Bolt voices its own reasoning only when asked. `DI` (default): it thinks aloud about its plan and failures |

## Telemetry and privacy

- Bolt's actions are ordinary traces (`claim`, `move`, `discuss`, `ready`, `role`) attributed to Bolt's participant id.
- New trace action **`teach`**: a belief change, with `objectId: concept:<id>` and a detail such as `Learned "series resistor" from Ana (explained)` or `… without a reason`.
- The export (`Shared trace → download`) adds `aiTeammate: { profile, beliefs, transitions[] }` and each participant's `kind`.
- **No message bodies** are logged or exported. The learner's words live only in the host browser's local storage (`vm-agent:<room>`) to fill the notebook. "Reset" in the notebook removes them.

## Ghost hands

When any other participant claims a part or cable end, the scene shows a translucent hand in their color (violet for Bolt, blue for humans) with a name tag. It reaches down, rides with the part while it moves, and lifts away on release. Remote moves now glide with a small carry arc instead of teleporting; shared-state sync on join stays instant. The hands are presence cues only — no input, no shadows, no effect on connectivity.

## Verifying

```bash
node --experimental-strip-types scripts/teachable-agent-check.mjs   # pure logic
npm run build && python3 -m http.server 4173 --bind 127.0.0.1 -d dist
node scripts/e2e-ai-teammate.mjs http://localhost:4173 ./shots      # learner teaches Bolt end to end
```

## Next steps

- Concept models for Snap Lab (short circuit, switch in series) and Snapino (pin vs. GND, HIGH/LOW).
- Optional LLM layer for interpreting free-form teaching, mapping utterances onto the same explicit belief states (the belief model stays deterministic and inspectable).
- Mixed teams (2 humans + Bolt): Bolt already works there; analyses should separate teaching acts by speaker.
