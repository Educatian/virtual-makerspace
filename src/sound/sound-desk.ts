/**
 * Sound Flow Studio (Episode 2): the 3D patch desk, procedurally modelled at one coherent scale
 * (1 scene unit ≈ 4 cm): a desktop case with walnut cheeks holding four modules (Source, Filter,
 * Drive, Speaker) with brushed-aluminium panels, knurled skirted knobs, recessed 3.5 mm-style jacks
 * (hex nut, bushing, dark bore), printed scales and labels, signal LEDs, and patch cables with
 * moulded plugs whose sleeves seat inside the jack bores.
 *
 * Printed graphics are small canvas textures per label (not one texture per panel), static parts
 * are merged per material, and nothing glows that would not emit light on a real desk: only the
 * LEDs are emissive, driven by the modelled signal (sound-model.ts), never by a decorative timer.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  Path,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SOUND_BOUNDS, SOUND_JACKS, SOUND_MODULE_POSES, type SoundModuleId, type SoundProps, type SoundWave } from "../../cloudflare/sound-rules.js";

/** Panel surface height (world y) and the jack's socket point on top of its nut. */
export const PANEL_TOP = 0.62;
export const JACK_Y = PANEL_TOP + 0.035;
/** Height a dragged plug is carried at (above the knobs). */
export const SOUND_DRAG_Y = 1.05;
/** Where a released, unplugged plug comes to rest: on a panel or on the table. */
export const PANEL_REST_Y = PANEL_TOP + 0.08;
export const TABLE_REST_Y = 0.08;

export const MODULE_WIDTH: Record<SoundModuleId, number> = { "snd-source": 1.5, "snd-filter": 1.5, "snd-drive": 1.5, "snd-speaker": 1.9 };
const MODULE_DEPTH = 2.7;
const JACK_ROW_Z = 0.82;
const SPEAKER_CENTER = { x: 0.22, z: -0.32 };
const KNOB_Z = -0.3;
/** Each jack's position in its module's frame (x, z). */
const JACK_LOCAL: Array<[number, number]> = [[0.38, JACK_ROW_Z], [-0.38, JACK_ROW_Z], [0.38, JACK_ROW_Z], [-0.38, JACK_ROW_Z], [0.38, JACK_ROW_Z], [-0.62, JACK_ROW_Z]];

/** Jack socket points in world space, indexed like SOUND_JACKS (what cables' `sockets` hold). */
export function soundJackPositions(): Vector3[] {
  return SOUND_JACKS.map((jack, index) => {
    const pose = SOUND_MODULE_POSES[jack.module];
    const [x, z] = JACK_LOCAL[index];
    return new Vector3(pose[0] + x, JACK_Y, pose[2] + z);
  });
}

/** The desk's footprint (world x/z): an unplugged plug released over it rests on a panel. */
export const DESK_BOUNDS = { minX: -4.62, maxX: 2.22, minZ: -1.66, maxZ: 1.24 };
/** The case and the cable mat, for camera framing. */
export const DESK_FRAME = { min: new Vector3(-4.65, 0, -1.7), max: new Vector3(2.25, 0.95, 1.3) };
export const MAT_FRAME = { min: new Vector3(-3.4, 0, 1.55), max: new Vector3(1.0, 0.2, 2.95) };

export interface CableSpec {
  id: string;
  color: number;
  css: string;
  rest: number;
  home: [number, number, number];
}
export const CABLE_SPECS: CableSpec[] = [
  { id: "snd-cable-a", color: 0xd8312b, css: "#e0483f", rest: 2.4, home: [-1.2, TABLE_REST_Y, 1.82] },
  { id: "snd-cable-b", color: 0xe7b416, css: "#e7b416", rest: 3.0, home: [-1.2, TABLE_REST_Y, 2.25] },
  { id: "snd-cable-c", color: 0x2f6fd8, css: "#4f86e6", rest: 3.6, home: [-1.2, TABLE_REST_Y, 2.68] },
];

// ── Materials (shared) ───────────────────────────────────────────────────────────────

const cache = new Map<string, unknown>();
function once<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}
const mat = {
  aluminium: () => once("aluminium", () => new MeshStandardMaterial({ name: "panel_brushed_aluminium", color: 0xc5cbd2, metalness: 0.82, roughness: 0.36 })),
  graphite: () => once("graphite", () => new MeshStandardMaterial({ name: "panel_graphite", color: 0x2a2e35, metalness: 0.55, roughness: 0.48 })),
  anodized: () => once("anodized", () => new MeshStandardMaterial({ name: "case_anodized", color: 0x1c2027, metalness: 0.6, roughness: 0.46 })),
  walnut: () => once("walnut", () => new MeshStandardMaterial({ name: "case_walnut", color: 0x5b3920, metalness: 0, roughness: 0.58 })),
  rubber: () => once("rubber", () => new MeshStandardMaterial({ name: "foot_rubber", color: 0x111214, metalness: 0, roughness: 0.92 })),
  nickel: () => once("nickel", () => new MeshStandardMaterial({ name: "jack_nickel", color: 0xb7bcc2, metalness: 1, roughness: 0.3 })),
  bore: () => once("bore", () => new MeshStandardMaterial({ name: "jack_bore", color: 0x0b0b0d, metalness: 0.2, roughness: 0.85, side: DoubleSide })),
  knob: () => once("knob", () => new MeshStandardMaterial({ name: "knob_soft_touch", color: 0x1a1b1f, metalness: 0.05, roughness: 0.52 })),
  knobCap: () => once("knobCap", () => new MeshStandardMaterial({ name: "knob_cap_satin", color: 0x2c2e33, metalness: 0.35, roughness: 0.38 })),
  paint: () => once("paint", () => new MeshStandardMaterial({ name: "pointer_paint", color: 0xf4f4f2, metalness: 0, roughness: 0.4 })),
  screw: () => once("screw", () => new MeshStandardMaterial({ name: "screw_steel", color: 0x8d939b, metalness: 1, roughness: 0.32 })),
  felt: () => once("felt", () => new MeshStandardMaterial({ name: "cable_mat_felt", color: 0x2d3440, metalness: 0, roughness: 0.96 })),
  cone: () => once("cone", () => new MeshStandardMaterial({ name: "speaker_cone_paper", color: 0x1f2024, metalness: 0, roughness: 0.82, side: DoubleSide })),
  surround: () => once("surround", () => new MeshStandardMaterial({ name: "speaker_surround_rubber", color: 0x141517, metalness: 0, roughness: 0.7 })),
  plugBody: () => once("plugBody", () => new MeshPhysicalMaterial({ name: "plug_moulded", color: 0x16171a, metalness: 0, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.4 })),
};

function canvasTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D, w: number, h: number) => void): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) draw(context, width, height);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** A printed decal lying on a panel (depth-tested, never on top of the cables). */
function decal(width: number, depth: number, pxPerUnit: number, draw: (context: CanvasRenderingContext2D, w: number, h: number) => void, y = PANEL_TOP + 0.0015): Mesh {
  const texture = canvasTexture(Math.max(32, Math.round(width * pxPerUnit)), Math.max(32, Math.round(depth * pxPerUnit)), draw);
  const material = new MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.55, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  material.name = "panel_print";
  const mesh = new Mesh(new PlaneGeometry(width, depth).rotateX(-Math.PI / 2), material);
  mesh.position.y = y;
  mesh.renderOrder = 2;
  mesh.userData.noShadow = true;
  return mesh;
}

const FONT = "Inter, system-ui, sans-serif";

// ── The case ──────────────────────────────────────────────────────────────────────

/** The desktop case, walnut cheeks and the felt cable mat (static: merged per material). */
export function createSoundDeskFixture(): Group {
  const group = new Group();
  group.name = "sound_desk_case";
  const body = new RoundedBoxGeometry(DESK_BOUNDS.maxX - DESK_BOUNDS.minX - 0.36, PANEL_TOP - 0.1, DESK_BOUNDS.maxZ - DESK_BOUNDS.minZ, 4, 0.05);
  body.translate((DESK_BOUNDS.minX + DESK_BOUNDS.maxX) / 2, 0.04 + (PANEL_TOP - 0.1) / 2, (DESK_BOUNDS.minZ + DESK_BOUNDS.maxZ) / 2);
  group.add(new Mesh(body, mat.anodized()));
  const cheeks: BufferGeometry[] = [];
  for (const x of [DESK_BOUNDS.minX + 0.09, DESK_BOUNDS.maxX - 0.09]) {
    const cheek = new RoundedBoxGeometry(0.18, PANEL_TOP + 0.16, DESK_BOUNDS.maxZ - DESK_BOUNDS.minZ + 0.08, 4, 0.06);
    cheek.translate(x, (PANEL_TOP + 0.16) / 2, (DESK_BOUNDS.minZ + DESK_BOUNDS.maxZ) / 2);
    cheeks.push(cheek);
  }
  group.add(new Mesh(mergeGeometries(cheeks)!, mat.walnut()));
  const feet: BufferGeometry[] = [];
  for (const x of [DESK_BOUNDS.minX + 0.4, DESK_BOUNDS.maxX - 0.4]) {
    for (const z of [DESK_BOUNDS.minZ + 0.3, DESK_BOUNDS.maxZ - 0.3]) feet.push(new CylinderGeometry(0.16, 0.18, 0.05, 20).translate(x, 0.025, z));
  }
  group.add(new Mesh(mergeGeometries(feet)!, mat.rubber()));
  // Mounting rails between the panels (visible as thin dark seams).
  const rails: BufferGeometry[] = [];
  for (const z of [DESK_BOUNDS.minZ + 0.04, DESK_BOUNDS.maxZ - 0.04]) rails.push(new BoxGeometry(DESK_BOUNDS.maxX - DESK_BOUNDS.minX - 0.36, 0.05, 0.07).translate((DESK_BOUNDS.minX + DESK_BOUNDS.maxX) / 2, PANEL_TOP - 0.035, z));
  group.add(new Mesh(mergeGeometries(rails)!, mat.anodized()));
  // Cable mat with a printed label.
  const matMesh = new Mesh(new RoundedBoxGeometry(MAT_FRAME.max.x - MAT_FRAME.min.x, 0.02, MAT_FRAME.max.z - MAT_FRAME.min.z, 2, 0.008).translate((MAT_FRAME.min.x + MAT_FRAME.max.x) / 2, 0.01, (MAT_FRAME.min.z + MAT_FRAME.max.z) / 2), mat.felt());
  group.add(matMesh);
  const label = decal(1.6, 0.16, 640, (context, w, h) => {
    context.fillStyle = "rgba(226,232,240,0.75)";
    context.font = `600 ${Math.round(h * 0.52)}px ${FONT}`;
    context.textBaseline = "middle";
    context.fillText("PATCH CABLES · 3.5 mm", 0, h / 2);
  }, 0.021);
  label.position.set(MAT_FRAME.min.x + 0.95, 0.021, MAT_FRAME.max.z - 0.13);
  group.add(label);
  for (const child of group.children) child.userData.noPick = true;
  return group;
}

// ── Modules ───────────────────────────────────────────────────────────────────────

function roundedRect(width: number, depth: number, radius: number): Shape {
  const shape = new Shape();
  const x = -width / 2;
  const y = -depth / 2;
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + depth - radius);
  shape.quadraticCurveTo(x + width, y + depth, x + width - radius, y + depth);
  shape.lineTo(x + radius, y + depth);
  shape.quadraticCurveTo(x, y + depth, x, y + depth - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

/** Panel plate with bevelled edges, top at PANEL_TOP, drilled through where jacks mount. */
function panelPlate(width: number, material: Material, holes: Array<[number, number, number?]> = []): Mesh {
  const shape = roundedRect(width - 0.03, MODULE_DEPTH - 0.03, 0.05);
  for (const [x, z, radius = 0.062] of holes) {
    // Shape y maps to world −z once the plate is laid flat.
    const hole = new Path();
    hole.absarc(x, -z, radius, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  const geometry = new ExtrudeGeometry(shape, { depth: 0.025, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.014, bevelSegments: 2, curveSegments: 10 });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, PANEL_TOP - 0.037, 0);
  return new Mesh(geometry, material);
}

function screws(width: number): Mesh {
  const parts: BufferGeometry[] = [];
  for (const x of [-width / 2 + 0.11, width / 2 - 0.11]) {
    for (const z of [-MODULE_DEPTH / 2 + 0.11, MODULE_DEPTH / 2 - 0.11]) {
      const head = new CylinderGeometry(0.045, 0.05, 0.022, 20).translate(x, PANEL_TOP + 0.011, z);
      parts.push(head);
    }
  }
  return new Mesh(mergeGeometries(parts)!, mat.screw());
}

function screwSlots(width: number): Mesh {
  const parts: BufferGeometry[] = [];
  for (const x of [-width / 2 + 0.11, width / 2 - 0.11]) {
    for (const z of [-MODULE_DEPTH / 2 + 0.11, MODULE_DEPTH / 2 - 0.11]) {
      parts.push(new BoxGeometry(0.07, 0.008, 0.012).translate(x, PANEL_TOP + 0.022, z));
      parts.push(new BoxGeometry(0.012, 0.008, 0.07).translate(x, PANEL_TOP + 0.022, z));
    }
  }
  return new Mesh(mergeGeometries(parts)!, mat.bore());
}

/** A Thonkiconn-style panel jack: hex nut (a real ring), threaded bushing, dark bore with a floor. */
function jack(): Group {
  const group = new Group();
  const hex = new Shape();
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    if (i === 0) hex.moveTo(0.13 * Math.cos(a), 0.13 * Math.sin(a));
    else hex.lineTo(0.13 * Math.cos(a), 0.13 * Math.sin(a));
  }
  hex.closePath();
  const bore = new Path();
  bore.absarc(0, 0, 0.088, 0, Math.PI * 2, true);
  hex.holes.push(bore);
  const nutGeometry = new ExtrudeGeometry(hex, { depth: 0.024, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.004, bevelSegments: 1, curveSegments: 20 });
  nutGeometry.rotateX(-Math.PI / 2).translate(0, PANEL_TOP + 0.003, 0);
  const nut = new Mesh(nutGeometry, mat.nickel());
  const bushing = new Mesh(new CylinderGeometry(0.085, 0.085, 0.012, 32, 1, true).translate(0, JACK_Y - 0.002, 0), mat.nickel());
  const lip = new Mesh(new RingGeometry(0.056, 0.086, 32).rotateX(-Math.PI / 2).translate(0, JACK_Y + 0.004, 0), mat.nickel());
  const sleeve = new Mesh(new CylinderGeometry(0.06, 0.06, 0.2, 24, 1, true).translate(0, JACK_Y - 0.1, 0), mat.bore());
  const floor = new Mesh(new CircleGeometry(0.06, 24).rotateX(-Math.PI / 2).translate(0, JACK_Y - 0.2, 0), mat.bore());
  group.add(nut, bushing, lip, sleeve, floor);
  return group;
}

/** A knurled, skirted knob with a painted pointer; rotate `knob.rotation.y` to show a value. */
function knob(scale = 1): Group {
  const group = new Group();
  const profile = [
    new Vector2(0, 0), new Vector2(0.255, 0), new Vector2(0.262, 0.01), new Vector2(0.258, 0.028), new Vector2(0.2, 0.04),
    new Vector2(0.186, 0.05), new Vector2(0.184, 0.19), new Vector2(0.176, 0.212), new Vector2(0.16, 0.222), new Vector2(0, 0.224),
  ].map((point) => new Vector2(point.x * scale, point.y * scale));
  const geometry = new LatheGeometry(profile, 72);
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    if (y > 0.06 * scale && y < 0.185 * scale) {
      const ribs = 1 + 0.04 * Math.max(0, Math.cos(24 * Math.atan2(z, x)));
      position.setXYZ(i, x * ribs, y, z * ribs);
    }
  }
  geometry.computeVertexNormals();
  const body = new Mesh(geometry, mat.knob());
  const cap = new Mesh(new CylinderGeometry(0.15 * scale, 0.15 * scale, 0.006, 40).translate(0, 0.226 * scale, 0), mat.knobCap());
  const pointer = new Mesh(new BoxGeometry(0.022 * scale, 0.008, 0.13 * scale).translate(0, 0.229 * scale, -0.085 * scale), mat.paint());
  const skirtLine = new Mesh(new BoxGeometry(0.016 * scale, 0.006, 0.06 * scale).translate(0, 0.036 * scale, -0.235 * scale), mat.paint());
  group.add(body, cap, pointer, skirtLine);
  group.position.y = PANEL_TOP;
  return group;
}

/** A 3 mm LED in a chrome bezel: emissive only when the modelled signal lights it. */
function led(color: number): { group: Group; material: MeshStandardMaterial } {
  const group = new Group();
  const bezel = new Mesh(new CylinderGeometry(0.055, 0.06, 0.02, 24).translate(0, PANEL_TOP + 0.01, 0), mat.nickel());
  const material = new MeshStandardMaterial({ name: "led_lens", color, emissive: color, emissiveIntensity: 0, roughness: 0.25, metalness: 0, transparent: true, opacity: 0.92 });
  material.color.multiplyScalar(0.35);
  const dome = new Mesh(new SphereGeometry(0.04, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, PANEL_TOP + 0.018, 0), material);
  group.add(bezel, dome);
  return { group, material };
}

/** Knob scale printed around a knob: ticks and labels at the given values. */
function knobScale(size: number, ticks: Array<{ t: number; label: string; major?: boolean }>, accent: string, dark = false): Mesh {
  return decal(size, size, 600, (context, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const unit = w / size;
    context.strokeStyle = dark ? "rgba(236,240,244,0.9)" : "rgba(28,30,34,0.92)";
    context.fillStyle = dark ? "rgba(236,240,244,0.95)" : "rgba(24,26,30,0.95)";
    context.lineCap = "round";
    // Sweep arc (−135° … +135°).
    context.lineWidth = unit * 0.012;
    context.beginPath();
    context.arc(cx, cy, unit * 0.315, (-225 * Math.PI) / 180, (45 * Math.PI) / 180);
    context.stroke();
    context.strokeStyle = accent;
    context.lineWidth = unit * 0.02;
    context.beginPath();
    context.arc(cx, cy, unit * 0.315, (-225 * Math.PI) / 180, (-215 * Math.PI) / 180);
    context.stroke();
    context.strokeStyle = dark ? "rgba(236,240,244,0.9)" : "rgba(28,30,34,0.92)";
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const tick of ticks) {
      const angle = (-135 + 270 * tick.t) * (Math.PI / 180);
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const inner = unit * (tick.major ? 0.29 : 0.3);
      const outer = unit * 0.345;
      context.lineWidth = unit * (tick.major ? 0.014 : 0.009);
      context.beginPath();
      context.moveTo(cx + inner * sin, cy - inner * cos);
      context.lineTo(cx + outer * sin, cy - outer * cos);
      context.stroke();
      if (tick.label) {
        context.font = `600 ${Math.round(unit * 0.058)}px ${FONT}`;
        const r = unit * 0.395;
        context.fillText(tick.label, cx + r * sin, cy - r * cos);
      }
    }
  });
}

function titleStrip(width: number, title: string, subtitle: string, accent: string, dark: boolean): Mesh {
  return decal(width - 0.16, 0.34, 700, (context, w, h) => {
    context.fillStyle = accent;
    context.fillRect(0, h * 0.08, w * 0.012 + 6, h * 0.84);
    context.fillStyle = dark ? "rgba(240,243,247,0.96)" : "rgba(20,22,26,0.96)";
    context.textBaseline = "alphabetic";
    context.font = `800 ${Math.round(h * 0.42)}px ${FONT}`;
    context.fillText(title, w * 0.04, h * 0.5);
    context.fillStyle = dark ? "rgba(203,213,225,0.9)" : "rgba(52,58,66,0.92)";
    context.font = `600 ${Math.round(h * 0.2)}px ${FONT}`;
    context.fillText(subtitle, w * 0.04, h * 0.82);
  });
}

/** IN / OUT label under a jack: outputs inverted (light on dark), as on modular synths. */
function jackLabel(text: "IN" | "OUT", dark: boolean): Mesh {
  return decal(0.42, 0.16, 640, (context, w, h) => {
    const inverted = text === "OUT";
    const radius = h * 0.28;
    if (inverted) {
      context.fillStyle = dark ? "rgba(236,240,244,0.95)" : "rgba(22,24,28,0.95)";
      context.beginPath();
      context.roundRect(w * 0.06, h * 0.08, w * 0.88, h * 0.84, radius);
      context.fill();
    }
    context.fillStyle = inverted ? (dark ? "rgba(22,24,28,0.98)" : "rgba(244,246,248,0.98)") : dark ? "rgba(236,240,244,0.95)" : "rgba(22,24,28,0.95)";
    context.font = `800 ${Math.round(h * 0.56)}px ${FONT}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text === "OUT" ? "OUT ▸" : "▸ IN", w / 2, h * 0.54);
  });
}

function smallLabel(text: string, width: number, dark: boolean, align: CanvasTextAlign = "center"): Mesh {
  return decal(width, 0.1, 640, (context, w, h) => {
    context.fillStyle = dark ? "rgba(226,232,240,0.92)" : "rgba(30,34,40,0.92)";
    context.font = `700 ${Math.round(h * 0.62)}px ${FONT}`;
    context.textAlign = align;
    context.textBaseline = "middle";
    context.fillText(text, align === "left" ? 2 : align === "right" ? w - 2 : w / 2, h * 0.55);
  });
}

const HZ_TICKS = [55, 110, 220, 440, 880, 1760];
const CUTOFF_TICKS = [80, 200, 500, 1000, 2000, 8000];

export function knobT(param: "hz" | "cutoff" | "gain", value: number): number {
  const bounds = SOUND_BOUNDS[param];
  if (param === "gain") return Math.max(0, Math.min(1, (value - bounds.min) / (bounds.max - bounds.min)));
  return Math.max(0, Math.min(1, Math.log(value / bounds.min) / Math.log(bounds.max / bounds.min)));
}

const WAVE_ANGLES: Record<SoundWave, number> = { sine: -40, square: 0, sawtooth: 40 };

export interface ModuleVisuals {
  /** Knob groups by parameter (rotation.y shows the value). */
  knobs: Partial<Record<"hz" | "cutoff" | "gain" | "wave", Group>>;
  leds: { signal: MeshStandardMaterial; clip?: MeshStandardMaterial; power?: MeshStandardMaterial };
  lever?: Group;
}

/** One module's visuals in its own frame (origin on the table, panel top at PANEL_TOP). */
export function createSoundModule(id: SoundModuleId): Group {
  const group = new Group();
  const width = MODULE_WIDTH[id];
  const dark = id === "snd-speaker";
  const holes: Array<[number, number, number?]> = SOUND_JACKS.filter((entry) => entry.module === id).map((entry) => JACK_LOCAL[entry.index]);
  // The Speaker's driver sits in a cut-out under its grille.
  if (id === "snd-speaker") holes.push([SPEAKER_CENTER.x, SPEAKER_CENTER.z, 0.6]);
  group.add(panelPlate(width, dark ? mat.graphite() : mat.aluminium(), holes), screws(width), screwSlots(width));
  const signalLed = led(0x22c55e);
  const visuals: ModuleVisuals = { knobs: {}, leds: { signal: signalLed.material } };
  const add = (object: Mesh | Group, x: number, z: number): void => {
    object.position.x += x;
    object.position.z += z;
    group.add(object);
  };
  const accent = id === "snd-source" ? "#0f9f8f" : id === "snd-filter" ? "#d98a10" : id === "snd-drive" ? "#d23b33" : "#7c8aa0";
  const titles: Record<SoundModuleId, [string, string]> = {
    "snd-source": ["SOURCE", "OSCILLATOR · 55 Hz–1.76 kHz · 0.5 FS"],
    "snd-filter": ["FILTER", "LOW-PASS · 12 dB/oct · Q 0.707"],
    "snd-drive": ["DRIVE", "GAIN ×0–×4 · CLIPS AT ±1.0 FS"],
    "snd-speaker": ["SPEAKER", "MONITOR · OUTPUT CAP −12 dBFS"],
  };
  add(titleStrip(width, titles[id][0], titles[id][1], accent, dark), 0, -1.08);

  const jackIndices = SOUND_JACKS.filter((entry) => entry.module === id).map((entry) => entry.index);
  for (const index of jackIndices) {
    const [x, z] = JACK_LOCAL[index];
    add(jack(), x, z);
    add(jackLabel(SOUND_JACKS[index].port === "out" ? "OUT" : "IN", dark), x, z + 0.24);
  }

  if (id === "snd-source") {
    const frequency = knob(1.15);
    visuals.knobs.hz = frequency;
    add(frequency, 0, KNOB_Z);
    add(knobScale(1.0, HZ_TICKS.map((hz) => ({ t: knobT("hz", hz), label: hz >= 1000 ? `${hz / 1000}k` : String(hz), major: true }))
      .concat(Array.from({ length: 21 }, (_, i) => ({ t: i / 20, label: "", major: false }))), accent), 0, KNOB_Z);
    add(smallLabel("FREQUENCY · Hz", 0.9, false), 0, KNOB_Z + 0.5);
    const wave = knob(0.55);
    visuals.knobs.wave = wave;
    add(wave, -0.4, 0.66);
    add(decal(0.62, 0.42, 600, (context, w, h) => {
      context.fillStyle = "rgba(24,26,30,0.95)";
      context.strokeStyle = "rgba(24,26,30,0.95)";
      context.font = `700 ${Math.round(h * 0.14)}px ${FONT}`;
      context.textAlign = "center";
      const cx = w / 2;
      const cy = h * 0.62;
      const labels: Array<[SoundWave, string]> = [["sine", "SIN"], ["square", "SQR"], ["sawtooth", "SAW"]];
      for (const [wave, label] of labels) {
        const angle = (WAVE_ANGLES[wave] * Math.PI) / 180;
        const r = h * 0.42;
        context.fillText(label, cx + r * Math.sin(angle) * 1.25, cy - r * Math.cos(angle));
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(cx + h * 0.2 * Math.sin(angle), cy - h * 0.2 * Math.cos(angle));
        context.lineTo(cx + h * 0.27 * Math.sin(angle), cy - h * 0.27 * Math.cos(angle));
        context.stroke();
      }
    }), -0.4, 0.66 - 0.05);
    add(signalLed.group, 0.38, 0.5);
    add(smallLabel("SIG", 0.3, false), 0.38, 0.38);
  }
  if (id === "snd-filter" || id === "snd-drive") {
    const main = knob(1.15);
    const param = id === "snd-filter" ? "cutoff" : "gain";
    visuals.knobs[param] = main;
    add(main, 0, KNOB_Z);
    const ticks = id === "snd-filter"
      ? CUTOFF_TICKS.map((hz) => ({ t: knobT("cutoff", hz), label: hz >= 1000 ? `${hz / 1000}k` : String(hz), major: true }))
      : [0, 1, 2, 3, 4].map((gain) => ({ t: knobT("gain", gain), label: `×${gain}`, major: true }));
    const minorCount = id === "snd-filter" ? 21 : 17;
    const minor = Array.from({ length: minorCount }, (_, i) => ({ t: i / (minorCount - 1), label: "", major: false }));
    add(knobScale(1.0, ticks.concat(minor), accent), 0, KNOB_Z);
    add(smallLabel(id === "snd-filter" ? "CUTOFF · Hz" : "GAIN · ×", 0.9, false), 0, KNOB_Z + 0.5);
    add(signalLed.group, 0.38, 0.5);
    add(smallLabel("SIG", 0.3, false), 0.38, 0.38);
    if (id === "snd-drive") {
      const clip = led(0xef4444);
      visuals.leds.clip = clip.material;
      add(clip.group, -0.38, 0.5);
      add(smallLabel("CLIP", 0.34, false), -0.38, 0.38);
    }
  }
  if (id === "snd-speaker") {
    const center = SPEAKER_CENTER;
    const frame = new Mesh(new TorusGeometry(0.64, 0.035, 12, 72).rotateX(Math.PI / 2).translate(0, PANEL_TOP + 0.02, 0), mat.nickel());
    // The rubber roll surround: a half-round profile turned on a lathe.
    const surround = new Mesh(new LatheGeometry(Array.from({ length: 9 }, (_, i) => {
      const a = Math.PI * (i / 8);
      return new Vector2(0.575 + 0.045 * Math.cos(a), PANEL_TOP - 0.02 + 0.03 * Math.sin(a));
    }), 72), mat.surround());
    // Shallow enough to stay above the case floor (y 0.56) under the cut-out.
    const cone = new Mesh(new LatheGeometry([new Vector2(0.6, PANEL_TOP - 0.01), new Vector2(0.53, PANEL_TOP - 0.018), new Vector2(0.4, PANEL_TOP - 0.03), new Vector2(0.26, PANEL_TOP - 0.042), new Vector2(0.17, PANEL_TOP - 0.05)], 72), mat.cone());
    const cap = new Mesh(new SphereGeometry(0.17, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2.6).scale(1, 0.35, 1).translate(0, PANEL_TOP - 0.052, 0), mat.surround());
    const grilleTexture = canvasTexture(512, 512, (context, w, h) => {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, w, h);
      context.fillStyle = "#000";
      const pitch = w / 34;
      for (let row = 0; row < 40; row += 1) {
        for (let col = 0; col < 40; col += 1) {
          const x = col * pitch + (row % 2) * pitch * 0.5;
          const y = row * pitch * 0.866;
          context.beginPath();
          context.arc(x, y, pitch * 0.34, 0, Math.PI * 2);
          context.fill();
        }
      }
    });
    grilleTexture.colorSpace = NoColorSpace;
    const grilleMaterial = new MeshStandardMaterial({ name: "speaker_grille_perforated", color: 0x9aa1aa, metalness: 0.85, roughness: 0.4, alphaMap: grilleTexture, alphaTest: 0.5, side: DoubleSide });
    const grille = new Mesh(new CircleGeometry(0.61, 64).rotateX(-Math.PI / 2).translate(0, PANEL_TOP + 0.03, 0), grilleMaterial);
    for (const part of [frame, surround, cone, cap, grille]) add(part, center.x, center.z);
    // Toggle switch: hex nut, bushing, chrome bat lever.
    const toggle = new Group();
    toggle.add(new Mesh(new CylinderGeometry(0.1, 0.1, 0.025, 6).translate(0, PANEL_TOP + 0.0125, 0), mat.nickel()));
    toggle.add(new Mesh(new CylinderGeometry(0.06, 0.06, 0.05, 24).translate(0, PANEL_TOP + 0.05, 0), mat.nickel()));
    const lever = new Group();
    lever.position.y = PANEL_TOP + 0.07;
    lever.add(new Mesh(new CylinderGeometry(0.018, 0.026, 0.2, 16).translate(0, 0.1, 0), mat.nickel()));
    lever.add(new Mesh(new SphereGeometry(0.03, 16, 10).translate(0, 0.205, 0), mat.nickel()));
    toggle.add(lever);
    visuals.lever = lever;
    add(toggle, 0.52, 0.72);
    add(decal(0.5, 0.62, 600, (context, w, h) => {
      context.fillStyle = "rgba(236,240,244,0.95)";
      context.font = `800 ${Math.round(h * 0.12)}px ${FONT}`;
      context.textAlign = "center";
      context.fillText("ON", w / 2, h * 0.12);
      context.fillText("OFF", w / 2, h * 0.97);
    }), 0.52, 0.72);
    const power = led(0xf59e0b);
    visuals.leds.power = power.material;
    add(power.group, 0.12, 0.72);
    add(smallLabel("POWER", 0.4, true), 0.12, 0.6);
    add(signalLed.group, -0.62, 0.5);
    add(smallLabel("SIG", 0.3, true), -0.62, 0.38);
    add(smallLabel("Output never above 0.25 FS × your volume", 1.5, true), 0.02, 1.2);
  }
  group.userData.soundVisuals = visuals;
  return group;
}

/** Shows knob values and the Speaker switch on a module (from the room's state only). */
export function showModuleValues(module: Group, props: SoundProps | undefined, on?: boolean): void {
  const visuals = module.userData.soundVisuals as ModuleVisuals | undefined;
  if (!visuals) return;
  const angle = (t: number): number => -((-135 + 270 * t) * Math.PI) / 180;
  if (props?.hz !== undefined && visuals.knobs.hz) visuals.knobs.hz.rotation.y = angle(knobT("hz", props.hz));
  if (props?.cutoff !== undefined && visuals.knobs.cutoff) visuals.knobs.cutoff.rotation.y = angle(knobT("cutoff", props.cutoff));
  if (props?.gain !== undefined && visuals.knobs.gain) visuals.knobs.gain.rotation.y = angle(knobT("gain", props.gain));
  if (props?.wave && visuals.knobs.wave) visuals.knobs.wave.rotation.y = -(WAVE_ANGLES[props.wave] * Math.PI) / 180;
  if (on !== undefined && visuals.lever) visuals.lever.rotation.x = on ? -0.42 : 0.42;
  if (on !== undefined && visuals.leds.power) visuals.leds.power.emissiveIntensity = on ? 1.6 : 0;
}

/** LED brightness from the modelled signal: `level` is the output peak in FS. */
export function showModuleSignal(module: Group, level: number, clipping = false): void {
  const visuals = module.userData.soundVisuals as ModuleVisuals | undefined;
  if (!visuals) return;
  visuals.leds.signal.emissiveIntensity = level > 1e-4 ? 0.5 + 2.2 * Math.min(1, level / 0.5) : 0;
  if (visuals.leds.clip) visuals.leds.clip.emissiveIntensity = clipping ? 2.4 : 0;
}

// ── Patch cables ────────────────────────────────────────────────────────────────────

/** Plug parts along +Y from the jack's socket point: sleeve (in the bore), barrel, strain relief. */
const PLUG = { sleeveBottom: -0.13, sleeveTop: 0.012, barrelTop: 0.32, reliefTop: 0.43, cableRadius: 0.032 };

function plug(color: number): Group {
  const group = new Group();
  const sleeve = new Mesh(new CylinderGeometry(0.05, 0.05, PLUG.sleeveTop - PLUG.sleeveBottom, 20).translate(0, (PLUG.sleeveTop + PLUG.sleeveBottom) / 2, 0), mat.nickel());
  const tip = new Mesh(new SphereGeometry(0.05, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).translate(0, PLUG.sleeveBottom, 0), mat.nickel());
  const ring = new Mesh(new CylinderGeometry(0.052, 0.052, 0.012, 20).translate(0, PLUG.sleeveBottom + 0.05, 0), mat.bore());
  const barrel = new Mesh(new LatheGeometry([
    new Vector2(0.0, PLUG.sleeveTop), new Vector2(0.074, PLUG.sleeveTop), new Vector2(0.082, PLUG.sleeveTop + 0.02), new Vector2(0.082, PLUG.barrelTop - 0.03),
    new Vector2(0.074, PLUG.barrelTop), new Vector2(0.05, PLUG.barrelTop + 0.02), new Vector2(0.04, PLUG.reliefTop), new Vector2(0, PLUG.reliefTop),
  ], 28), mat.plugBody());
  const band = new Mesh(new CylinderGeometry(0.084, 0.084, 0.05, 28).translate(0, PLUG.barrelTop - 0.09, 0), new MeshStandardMaterial({ name: "plug_colour_band", color, roughness: 0.45, metalness: 0 }));
  group.add(sleeve, tip, ring, barrel, band);
  return group;
}

export function buildPatchCable(group: Group, color: number, rest: number): void {
  const half = rest / 2;
  group.userData.endpointPositions = [new Vector3(-half, 0, 0), new Vector3(half, 0, 0)];
  const insulation = new MeshPhysicalMaterial({ name: "patch_cable_pvc", color, roughness: 0.4, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.35 });
  const body = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(-half, 0, 0), new Vector3(half, 0, 0)]), 8, PLUG.cableRadius, 10, false), insulation);
  body.userData.flexibleWireBody = true;
  group.userData.wireBody = body;
  group.add(body);
  const plugs: Group[] = [];
  const indicators: Mesh[] = [];
  const hitTargets: Mesh[] = [];
  for (const index of [0, 1] as const) {
    const part = plug(color);
    part.userData.endpointIndex = index;
    group.add(part);
    plugs.push(part);
    // Selection ring: printed-style, depth-tested, never additive.
    const indicator = new Mesh(new RingGeometry(0.15, 0.19, 40).rotateX(-Math.PI / 2), new MeshBasicMaterial({ name: "plug_selection_ring", color: 0xf59e0b, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
    indicator.visible = false;
    indicator.renderOrder = 3;
    indicator.userData.endpointIndex = index;
    indicator.userData.noShadow = true;
    group.add(indicator);
    indicators.push(indicator);
    const hit = new Mesh(new SphereGeometry(0.2, 14, 10), new MeshBasicMaterial({ transparent: true, opacity: 0.001, depthWrite: false }));
    hit.userData.endpointIndex = index;
    hit.userData.endpointHandle = true;
    hit.userData.noShadow = true;
    group.add(hit);
    hitTargets.push(hit);
  }
  group.userData.patchPlugs = plugs;
  group.userData.endpointIndicators = indicators;
  group.userData.endpointHitTargets = hitTargets;
  group.userData.restLength = rest;
  group.userData.wireTips = [];
  group.userData.wireCollars = [];
}

const UP = new Vector3(0, 1, 0);

/**
 * Lays out a patch cable from its two end positions (cable-local): a plugged end stands in its
 * jack (sleeve in the bore, barrel upright); a free end lies along the cable. The tube leaves
 * each plug's strain relief along the plug's axis and arches with the cable's slack.
 */
export function layoutPatchCable(group: Group, seated: [boolean, boolean], sway = 0, motion = 0): void {
  group.updateMatrixWorld(true);
  const endpoints = group.userData.endpointPositions as [Vector3, Vector3];
  const plugs = group.userData.patchPlugs as Group[];
  const body = group.userData.wireBody as Mesh<TubeGeometry>;
  const indicators = group.userData.endpointIndicators as Mesh[];
  const hits = group.userData.endpointHitTargets as Mesh[];
  const rest = Number(group.userData.restLength ?? 2.4);
  const axes: Vector3[] = [];
  const exits: Vector3[] = [];
  for (const index of [0, 1] as const) {
    const point = endpoints[index];
    const other = endpoints[index === 0 ? 1 : 0];
    const plugGroup = plugs[index];
    let axis: Vector3;
    // Carried (being dragged, above the knobs): the plug hangs tip-down under the hand.
    const carried = !seated[index] && group.position.y + point.y > PANEL_TOP + 0.25;
    if (seated[index]) {
      axis = UP.clone();
      plugGroup.position.copy(point);
    } else if (carried) {
      axis = UP.clone();
      plugGroup.position.copy(point).addScaledVector(axis, -PLUG.sleeveBottom);
    } else {
      axis = new Vector3(other.x - point.x, 0, other.z - point.z);
      if (axis.lengthSq() < 1e-6) axis.set(index === 0 ? 1 : -1, 0, 0);
      axis.normalize();
      // Lying: the sleeve's tip at the end point, the plug's round barrel resting on its side.
      plugGroup.position.copy(point).addScaledVector(axis, -PLUG.sleeveBottom);
    }
    plugGroup.quaternion.copy(new Quaternion().setFromUnitVectors(UP, axis));
    axes.push(axis);
    exits.push(plugGroup.position.clone().addScaledVector(axis, PLUG.reliefTop));
    indicators[index].position.set(point.x, seated[index] ? point.y + 0.012 : carried ? point.y : point.y - 0.06, point.z);
    hits[index].position.copy(plugGroup.position).addScaledVector(axis, (PLUG.sleeveTop + PLUG.barrelTop) / 2);
  }
  const [a, b] = exits;
  const span = a.distanceTo(b);
  const slack = Math.max(rest - span - 2 * PLUG.reliefTop, 0);
  const anySeated = seated[0] || seated[1] || axes.some((axis) => axis.y > 0.5);
  const arch = anySeated ? 0.12 + slack * 0.42 + motion * 0.1 : 0.02 + motion * 0.1;
  const lead = Math.min(0.32, 0.12 + span * 0.08);
  const across = new Vector3(b.x - a.x, 0, b.z - a.z);
  const side = new Vector3(-across.z, 0, across.x);
  if (side.lengthSq() > 1e-8) side.normalize();
  const lateral = sway * 0.4 + (anySeated ? 0 : Math.min(0.35, slack * 0.25));
  const mid = (t: number, lift: number, offset: number): Vector3 => a.clone().lerp(b, t).add(new Vector3(0, lift, 0)).addScaledVector(side, offset);
  const points = [
    a.clone(),
    a.clone().addScaledVector(axes[0], lead),
    mid(0.3, arch * 0.85, lateral * 0.7),
    mid(0.5, arch, lateral),
    mid(0.7, arch * 0.85, lateral * 0.7),
    b.clone().addScaledVector(axes[1], lead),
    b.clone(),
  ];
  // Free cables lie on their surface: never below the ends.
  if (!anySeated) for (const point of points) point.y = Math.max(point.y, Math.min(a.y, b.y));
  const curve = new CatmullRomCurve3(points, false, "centripetal");
  group.userData.wireCurve = curve;
  body.geometry.dispose();
  body.geometry = new TubeGeometry(curve, 72, PLUG.cableRadius, 10, false);
}
