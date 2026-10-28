# Matched BEFORE/AFTER renders

Rendered with `scripts/qa-3d.mjs` (same camera positions and part placements in both builds) for commit `(the commit that adds docs/images/qa)`.
Software WebGL (SwiftShader) in headless Chromium; not checked on real GPUs, phones or a Quest headset.

### Overview, same camera and placements

![BEFORE (left) and AFTER (right): Overview, same camera and placements](compare-2-overview-collapsed.jpg)

### Red LED powered (about 7 mA through 1 kOhm)

![BEFORE (left) and AFTER (right): Red LED powered (about 7 mA through 1 kOhm)](compare-11-led-powered.jpg)

### Green LED unpowered (unconnected strips)

![BEFORE (left) and AFTER (right): Green LED unpowered (unconnected strips)](compare-12-led-unpowered.jpg)

### Occupied sockets, low close-up

![BEFORE (left) and AFTER (right): Occupied sockets, low close-up](compare-13-occupied-sockets.jpg)

### Jumper cable tip in a socket

![BEFORE (left) and AFTER (right): Jumper cable tip in a socket](compare-14-cable-tip-macro.jpg)

### Breadboard sockets close-up

![BEFORE (left) and AFTER (right): Breadboard sockets close-up](compare-3-breadboard-close.jpg)

### LED and resistor close-up

![BEFORE (left) and AFTER (right): LED and resistor close-up](compare-4-led-resistor-close.jpg)

### Snapino PCB close-up

![BEFORE (left) and AFTER (right): Snapino PCB close-up](compare-9-pcb-close.jpg)

### Laptop viewport 1180x760

![BEFORE (left) and AFTER (right): Laptop viewport 1180x760](compare-10-laptop.jpg)

### Phone viewport 390x844

![BEFORE (left) and AFTER (right): Phone viewport 390x844](compare-16-phone.jpg)

## Renderer counters (draw calls / triangles / pixel ratio)

| View | BEFORE | AFTER |
|---|---|---|
| 1-overview | 508 / 79k / 1 | 271 / 41k / 1 |
| 2-overview-collapsed | 364 / 72k / 1 | 164 / 36k / 1 |
| 3-breadboard-close | 192 / 54k / 1 | 88 / 26k / 1 |
| 4-led-resistor-close | 133 / 40k / 1 | 64 / 19k / 1 |
| 5-cable-ends-close | 208 / 55k / 1 | 103 / 27k / 1 |
| 6-battery-close | 189 / 48k / 1 | 86 / 22k / 1 |
| 7-rails-close | 150 / 42k / 1 | 71 / 16k / 1 |
| 8-snapino-overview | 1220 / 96k / 1 | 1229 / 97k / 1 |
| 9-pcb-close | 448 / 30k / 1 | 457 / 30k / 1 |
| 10-laptop | 534 / 77k / 1 | 266 / 38k / 1 |
| 11-led-powered | 140 / 42k / 1 | 67 / 20k / 1 |
| 12-led-unpowered | 178 / 53k / 1 | 83 / 25k / 1 |
| 13-occupied-sockets | 160 / 42k / 1 | 76 / 19k / 1 |
| 14-cable-tip-macro | 157 / 43k / 1 | 69 / 18k / 1 |
| 15-meter-editor | — | 178 / 38k / 1 |
| 16-phone | 293 / 59k / 1 | 131 / 29k / 1 |

Raw numbers: [`stats.json`](stats.json).
