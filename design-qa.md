# Design QA — Minimal Smart Greenhouse Studio

## Evidence

- Source visual truth: private design storyboard used during implementation review.
- Browser-rendered implementation: `greenhouse-implementation.png`
- Motherboard endpoint + multi-user implementation: verified in the live Circuit Bench.
- Combined comparison evidence: `greenhouse-qa-comparison.png`
- Viewport: 1157 × 912 CSS px, device scale factor 1
- Source pixels: 1680 × 945
- Implementation pixels: 1157 × 912
- Normalization: both images were proportionally fit into adjacent 1160 × 860 comparison regions on a 2400 × 900 canvas; neither image was stretched.
- State: English desktop workspace, Greenhouse Studio selected, field-test layout connected, irrigation and ventilation active, live environmental readings stable.

## Full-view comparison

The implementation retains the selected visual system and information architecture from the storyboard: dark navy application shell, green/blue state accents, left component rail, dominant central 3D workspace, right discussion dock, compact top-level collaboration controls, and visible shared-state feedback. The requested minimalist pivot is intentional: persistent instructional copy has been replaced by Phosphor icons, accessible names, native titles, and hover/focus tooltips while chat content and live measurements remain visible.

## Focused-region comparison

- **Left component rail:** storyboard cards with image and labels were reduced to large color-coded component icons. Every icon has an accessible label and a verified `title` tooltip, e.g. `Soil Sensor · Moisture`.
- **Viewport toolbar:** verbose controls became four icon buttons for magnetism, camera reset, system test, and contextual help. The magnetic button’s verified tooltip is `Magnetic guidance on`.
- **Live conditions:** the text-heavy first pass was reduced to four icon/value cells plus two subsystem status icons. Values remain readable at the target viewport.
- **Discussion dock:** navigation is icon-only, but human-authored messages remain readable because conversation content is essential rather than chrome.

## Required fidelity surfaces

- **Fonts and typography:** Inter 400/500/600/700 remains consistent with the target. Numeric values use strong weight and tabular numerals. Small UI text remains legible; no unintended wrapping or truncation was observed.
- **Spacing and layout rhythm:** major regions align to a compact 94 px / flexible viewport / 320 px grid. Icon buttons use consistent 34–58 px hit areas, 7–10 px gaps, and 7–12 px radii. No persistent controls overflow the viewport.
- **Colors and tokens:** navy panels, cool gray borders, green valid state, blue action state, amber challenge state, and red leave action map consistently to the source design language. Contrast remains strong on the dark background.
- **Image quality and asset fidelity:** the central experience is live Three.js geometry rather than placeholder imagery. UI icons come from Phosphor; no emoji, inline SVG, CSS illustration, or placeholder image substitutes are used.
- **Detailed meshes:** the greenhouse now includes a pitched translucent roof, framed glazing, a banded water tank with gauge and cap, rounded sensor housings with vent slots, controller traces, pump feet/nozzles, connector collars, and a gridded solar panel.
- **Flexible routing:** wire and hose geometry is rebuilt from a seven-point Catmull–Rom curve while it moves. Drag velocity adds lift and lateral spring sway; denser radial segments and physical materials keep the line visibly soft rather than rod-like.
- **Magnetic feedback:** endpoint rings grow, brighten, and shift toward green as each lead enters the magnetic field. Additive guide beams connect lead-to-socket, magnetic force increases quadratically with proximity, and a bright 720 ms confirmation pulse marks a successful snap.
- **Independent endpoints:** every wire and irrigation hose now stores two independent local endpoints. Selecting a flexible line reveals two pulsing grab rings; dragging A keeps B fixed (and vice versa), permits controlled stretch up to 1.85× resting length, preserves partial socket state, and records endpoint-level attempts.
- **Concurrent collaboration:** component bodies and cable endpoints use separate claim keys. Multiple participants can manipulate different components—and even opposite ends of one cable—without a whole-scene lock. Endpoint transform patches merge independently, presence avatars remain visible, and abandoned claims clear when a participant disconnects.
- **Motherboard task fidelity:** the circuit task retains its LED learning path while adding a layered green PCB carrier, rounded breadboard, metallic mounting holes, copper traces, paired power rails, controller package, connector, capacitors, and a runnable battery → resistor → LED diagnostic reference layout.
- **Copy and content:** the greenhouse-specific guide now references sensing, water, air, and power. The composer changes to `Discuss this system…`. Circuit-only instructional copy is no longer shown in the greenhouse state.

## Interaction verification

- Entered the room from the lobby.
- Switched between Circuit Bench and Greenhouse Studio.
- Loaded the connected field-test layout.
- Verified live transition from approximately 41% soil moisture, 27.7°C, 63% grow light, and 0.5 L/min flow into the balanced target range as simulation continued.
- Verified irrigation and ventilation active states and stable-system state.
- Dragged the irrigation hose in the live Three.js viewport and verified a curved, non-rigid route with spring-like motion.
- Verified progressive magnetic-field rings/beams and post-snap confirmation pulse in the rendered interaction path.
- Verified two independent cable grab rings and a successful `Wire (Blue) end A magnetically connected` interaction in the live browser.
- Joined room `7K3M` as Alex Chen and Sam Rivera in separate browser tabs; both presence avatars appeared and a diagnostic circuit loaded by Sam synchronized into Alex's scene.
- Verified the optional cross-device WebSocket relay by connecting two independent clients to room `7K3M` and relaying an endpoint-scoped transform (`wire-blue`, endpoint `0`). The app falls back to same-device `BroadcastChannel` when no relay URL is configured.
- Verified browser consoles in both participant tabs: no warnings or errors.
- Verified component and magnetic-control tooltip text via rendered DOM attributes.
- Verified greenhouse-specific chat guidance.
- Checked browser console: no errors.
- TypeScript validation: `npx tsc --noEmit` passed.
- Production build: `npm run build` passed.

## Comparison history

### Pass 1

- **P2 — Persistent instructional text competed with the 3D scene.** The component cards, studio tabs, toolbar actions, control legend, challenge brief, discussion tabs, and attempt history all carried visible labels.
- **P2 — Live conditions and challenge panels occupied too much of the viewport.** They obscured the workbench at the desktop preview size.
- **P2 — Greenhouse chat guidance still referred to the circuit board.** This created a content mismatch.

### Fixes made

- Converted navigation and controls to Phosphor icon buttons with accessible labels and hover/focus tooltips.
- Collapsed the component rail to 94 px, compressed attempts to numbered restore chips, hid the control legend by default, and reduced the environment HUD to values and icons.
- Replaced the challenge card with two compact action orbs.
- Repositioned transient status feedback away from the environmental HUD.
- Expanded the terminal strip to separate connected greenhouse components.
- Replaced circuit-specific guide and composer copy with greenhouse-specific language.
- Removed horizontal overflow from the component rail.
- Rebuilt flexible line motion, progressive magnetic guidance, and successful-snap feedback.
- Added higher-detail greenhouse, sensor, controller, pump, tank, hose, and solar geometry with soft shadows.

### Post-fix visual evidence

`greenhouse-implementation.png` and `greenhouse-qa-comparison.png` show the unobstructed 3D scene, compact stable-state HUD, icon-only tool rails, curved irrigation route, higher-detail meshes, separated connected components, and clean right-side discussion dock.

## Findings

No actionable P0, P1, or P2 issues remain at the verified desktop viewport.

## Follow-up polish

- **P3:** A future optional collapse control for the discussion dock could create an even larger inspection viewport when teams are not actively chatting.

## Final result

final result: passed
