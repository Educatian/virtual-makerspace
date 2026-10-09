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
- `src/desktop/remote-hands.ts` — translucent hands shown when Bolt or any remote maker holds a part (MIT WebXR generic hand, `public/models/hand/`).

Because Bolt is a real participant on the wire, **human–human and human–AI sessions produce the same trace schema** and the same participation measures. In production the Worker admits Bolt with `?agent=1` only while its host (the same signed-in maker) is connected: fixed name "Bolt", `kind: "agent"` in presence, no host rights, no Neon membership row. Bolt never becomes the room's state coordinator and never decides the human builder role. One Bolt per room: if two tabs invite one, the later Bolt steps aside.

## Bolt's knowledge (Circuit Bench)

| Concept | Naive idea Bolt starts with | Taught idea | Visible consequence when naive |
|---|---|---|---|
| `strips` | Holes in the same row are connected | Holes connect in vertical column strips; parts must share a strip | Parts lined up end-to-end along one row → open circuit |
| `loop` | One connection from the battery is enough | Current must return to the other battery terminal | No return wire → open circuit |
| `resistor` | Extra parts just slow things down | A series resistor limits current so the LED doesn't burn out | LED straight across the battery → lights, but unsafe |

Belief states: `naive` → `partial` (told *what*, not *why*) → `taught`. Bolt acts only on `taught` ideas.

**Teaching** happens in chat and is read clause by clause. A clause teaches an idea only when it is about that idea (or answers Bolt's pending "why?") **and** states the correct mechanism without negating it:

| Learner says | Bolt hears | Bolt replies |
|---|---|---|
| "Holes in a row aren't connected — the columns are" | `strips` taught | "So parts only connect when they share a column. Got it." |
| "Use the columns." | `strips` named, no reason → `partial` | "Why would that connect them? I thought holes in a row were connected." (asked once) |
| "Rows are connected" / "the columns aren't connected" | affirms the naive idea | "So holes in a row are connected? That's what I thought too." (never corrected — no hints) |
| "you don't need a resistor because the LED is fine" | affirms the naive idea | "So the LED is fine without it? That's what I thought too." |
| "yes because it's wrong" (to Bolt's "why?") | no reason | "Hmm, I'm not sure I follow. Can you tell me why?" (once) |
| "Is the resistor safe?" | a question | nothing — questions never teach |

A bare "because" is not enough, and neither is naming the topic ("the loop", "connect it back to the battery"); the mechanism must be there. "Unless / otherwise / without" count as reasons, not negation ("it won't light unless the current goes all the way around" teaches the loop), and a diagnosis reads as the rule ("it's dark because the current doesn't come back to the battery"). If someone later contradicts a taught idea, Bolt quotes the original teacher back ("Wait — earlier Ana said … Which is it?") instead of giving the answer. When more than one human is in the room, Bolt still learns from what it overhears, but only asks "why?", nudges or takes commands when addressed ("Bolt…", "you…"). Korean phrasing is recognized too. The learner's exact words are stored in **Bolt's notebook** (Team tab) — the analogue of Betty's Brain's student-built concept map.

Profiles: `?agentProfile=novice` (default, all naive) or `intermediate` (`loop` already taught).

## Behavior by role and phase

| | Bolt is **builder** | Bolt is **verifier** (default when the learner builds) |
|---|---|---|
| Frame | States its plan from its beliefs; asks "Does that sound right?" | Asks the learner to walk through the plan |
| Build | Builds its plan, part by part, with its ghost hand; rebuilds right after being taught | After the learner's moves settle, questions what contradicts its naive ideas ("Why add the resistor?") or applies what it was taught ("You taught me rows aren't connected — are these joined?") |
| Test | Reacts to the result: dark → "What did I get wrong?"; lit but unsafe → depends on whether it was taught `resistor` | Same reactions |
| Reflect | Restates what it was taught and by whom, and what it is still unsure about | Same |

Readiness: Bolt marks ready once its own work is done and a human is ready (or the team is in Test), so it never blocks the shared test. Bolt never rebuilds on entering Test, so it can't undo a teammate's fix. Chat commands: "Bolt, you build" / "you check" / "I'll build" swap roles (a lone human takes the other role automatically); "rebuild" / "try again" / "can you build it?" ask it to build. Questions ("did you build it right?") and first-person plans ("I'll fix it") are never commands. Each one-time prompt ("What's your plan?") is said once per session, and a build restarted mid-way is not re-announced.

## Conditions and URL parameters

| Parameter | Values | Effect |
|---|---|---|
| `teammate` | `ai` | Invite Bolt on room entry (same as the lobby's "Practice with Bolt" switch; otherwise "Add Bolt" in the Team tab). Removed from the URL on entry, so a copied room link doesn't bring a second Bolt |
| `agentRole` | `builder` \| `verifier` | Bolt's starting role (default: opposite of the learner's) |
| `agentProfile` | `novice` \| `intermediate` | Starting beliefs |
| `condition` | `PF` \| `DI` | `PF`: Bolt voices its own reasoning only when asked. `DI` (default): it thinks aloud about its plan and failures |

## Telemetry and privacy

- Bolt's actions are ordinary traces (`claim`, `move`, `discuss`, `ready`, `role`) attributed to Bolt's participant id.
- New trace action **`teach`** with `objectId: concept:<id>`. The visible detail names the idea only once the team has taught it (`Learned from Ana: series resistor`); otherwise it is neutral (`Asked Ana why`, `Took Ana's idea on board`), so the trace panel never leaks a concept.
- The export (`Shared trace → download`) adds `aiTeammate: { profile, beliefs, transitions[] }` (transition quality: `explained`, `named`, `affirmed-naive`) and each participant's `kind`. Transitions persist with Bolt's memory, so removing and re-adding Bolt keeps the history.
- The Participation bar counts Bolt's moves but not its chat, so a talkative agent can't crowd out the humans' share.
- **No message bodies** are logged or exported. The learner's words live only in the host browser's local storage (`vm-agent:<room>:<learner>`) to fill the notebook — keyed per learner (the signed-in account, or a stable local id in preview), so the next person at a shared machine starts with a fresh Bolt. "Reset" in the notebook erases it.

## Teammate hands

When any other participant claims a part or cable end, the scene shows a glassy hand in their color (violet for Bolt, blue for humans) with a name tag. It reaches down, closes its fingers on the part, rides with it while it moves, then opens and lifts away on release. The mesh is the MIT-licensed WebXR generic hand (`public/models/hand/`), posed by curling its finger joints; until it loads only the name tag shows. Remote moves glide with a small carry arc instead of teleporting; shared-state sync on join stays instant, and switching studio settles any glide in progress; a hand still holding a part reappears when you switch back. The hands are presence cues only — no input, no shadows, no effect on connectivity — and the per-frame update makes no per-hand allocations. Each hand frees its skinned skeleton when it goes.

## Verifying

```bash
node --experimental-strip-types scripts/teachable-agent-check.mjs   # pure logic
npm run build && python3 -m http.server 4173 --bind 127.0.0.1 -d dist
node scripts/e2e-ai-teammate.mjs http://localhost:4173 ./shots      # learner teaches Bolt end to end

# Production transport (Worker + Durable Object WebSocket rooms)
npx wrangler dev --port 8799 --ip 127.0.0.1 --var ADMIN_EMAILS:host@example.test
node scripts/access-proxy.mjs 8800 8799
node scripts/e2e-ai-teammate-worker.mjs                             # → http://vm.test:8800
```

Play link: <https://vm.teachplay.dev/?room=7K3M&studio=circuit&teammate=ai>

## Next steps

- Concept models for Snap Lab (short circuit, switch in series) and Snapino (pin vs. GND, HIGH/LOW).
- Optional LLM layer for interpreting free-form teaching, mapping utterances onto the same explicit belief states (the belief model stays deterministic and inspectable).
- Mixed teams (2 humans + Bolt): Bolt already works there; analyses should separate teaching acts by speaker.
