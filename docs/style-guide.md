# Visual Style Guide

Source of truth for color, typography, spacing, lighting, and motion in Virtual Makerspace. Every visual decision should be traceable to this doc. When something looks "off," the answer is here or this doc needs updating — not improvisation.

## 1. Aesthetic intent

**One sentence**: a calm, slightly technical workshop — *not* a game, *not* a corporate productivity tool. Think "high-end soldering bench in a research lab at 9pm" rather than "edutainment science museum."

**What this rules out**:
- Bright primary-color cartoon palettes
- Glossy/skeuomorphic surfaces
- Glow/bloom-heavy effects
- Curved sans-serif "friendly" typography
- Sound effects that announce achievements

**What this rules in**:
- Desaturated, neutral world; saturated color reserved for *meaning* (LED lit, snap valid, error)
- Matte materials, restrained specular
- Monospaced or geometric sans for UI
- Subtle, short audio confirmations only

## 2. Color palette

### Core (use these, not arbitrary hex)

| Token | Hex | Use |
|---|---|---|
| `bg-deep` | `#0a0e18` | Probe overlay backdrop, far-distance fog |
| `bg-panel` | `#141a26` | UI cards, future in-VR panels |
| `bg-near-black` | `#0a0a0a` | HUD background |
| `border-subtle` | `#2a3245` | Panel borders, dividers |
| `text-primary` | `#e8eef7` | All UI body text |
| `text-muted` | `#9aa6bd` | Secondary text, instructions |
| `text-ui-bright` | `#f0f0f0` | HUD step text (high-attention) |

### Semantic (meaning-bearing — never decorative)

| Token | Hex | Meaning |
|---|---|---|
| `accent-circuit` | `#00ff66` | Active circuit / valid snap target / "the thing is working" |
| `accent-action` | `#3b82f6` | Click here, primary CTA |
| `signal-error` | `#ff7b7b` | Validation error, warning |

### Component physical colors (real-world fidelity, NOT semantic)

| Component | Hex | Note |
|---|---|---|
| Wood (table) | `#8b6f47` | Warm brown, low saturation |
| Metal lead | `#c0c0c0` | Brushed steel |
| Battery body | `#222222` | Matte black |
| Floor | `#4a4a4a` | Mid-grey, very rough |
| Tray | `#1a3a4a` | Deep teal, clearly "different surface" |

**Rule**: physical colors are realistic and desaturated. Semantic colors are saturated. If you find yourself using `#00ff66` on a non-meaningful element, stop.

### Reconciliation: HUD vs probe overlay

Currently the HUD uses `accent-circuit` (green) and the probe overlay uses `accent-action` (blue). This is **intentional**:
- HUD = *circuit-state mirror* — green ties to "the LED is alive"
- Probe overlay = *out-of-task UI* — blue ties to "this is meta, not the work"

Do not unify these. The split itself communicates context.

## 3. Typography

| Surface | Font | Why |
|---|---|---|
| HUD (in-VR) | UIKit default sans | Read at distance, must be legible at 0.5m |
| Probe overlay (DOM) | `system-ui, -apple-system, 'Segoe UI', Roboto` | Native feel on every OS |
| Future in-VR panels | TBD — pick a geometric sans (Inter, IBM Plex Sans) when porting probe to PanelUI |

Sizes (rem-equivalent for DOM, UIKit units for VR):
- Title / step: large (HUD: 2.2 UIKit units; DOM: 20px)
- Body: medium (DOM: 14-15px)
- Meta / muted: small (DOM: 13px)
- HUD progress: 1.6 UIKit units

## 4. Spacing & layout

- **Grid**: 4px base unit for DOM; 0.01m for in-VR panel padding
- **Card padding**: 28px / 32px (vertical / horizontal) for DOM panels
- **Fieldset gap**: 14px between question groups
- **Panel max-width**: 720px DOM / 0.5m VR
- **Tray distance from board**: 0.6m (current scene)
- **HUD offset from head**: `[0, -0.25, -0.7]` PivotY follower

## 5. Lighting

- Default IBL gradient (handled by IWSDK `defaultLighting: true`)
- No directional sun for now — keep it diffuse, lab-evening mood
- Component emissive ONLY for LED (intensity 1.8 when lit, 0 otherwise)
- No glow / bloom post-processing

## 6. Motion

| Element | Behavior | Timing |
|---|---|---|
| Snap (component → socket) | Instant teleport on release | 0ms |
| Hover preview spheres | Instant on/off, no fade | 0ms |
| HUD follower | Lerp to head position | speed 1, tolerance 0.3m, maxAngle 25° |
| Robot (idle character) | Walk 0.25 m/s, bob 4cm | continuous |
| Probe overlay show/hide | Instant (no fade) | 0ms |
| LED on/off | Instant emissive change | 0ms |

**No easing curves anywhere yet.** When motion is added, default to *short and decisive* (150-200ms ease-out). VR users have low tolerance for sluggish UI.

## 7. Audio (placeholder — no SFX yet)

When sound is added, follow these rules:
- **Snap success**: short woody click, ~50ms, low frequency
- **Snap failure (return to spawn)**: subtle, NOT punitive — short pluck, no buzzer
- **LED lit**: NO sound — visual is enough, sound would feel game-y
- **Probe submit**: subtle UI tick
- **Ambient**: optional very low room-tone hum, ≤ -30dB
- **Volume default**: 0.5

Spatial audio (3D positional) for snap clicks (positional from socket); UI sounds non-positional.

## 8. What this doc is not

- Not a brand book — no logos
- Not a content style guide (probe wording lives in `pedagogy-charter.md`)
- Not VR comfort spec (lives in `interaction-spec.md`)

## 9. When to update

- Adding a new UI surface → add tokens used here, even if you copy existing ones
- Changing a token's hex → update *every* call site in same PR; never leave drift
- Disagreeing with a rule → discuss with a human before overriding; prefer to amend this doc than to one-off
