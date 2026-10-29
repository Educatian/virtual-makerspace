/**
 * Resource-Limited Greenhouse (Episode 3): the 3D rig, procedurally modelled at one coherent scale
 * (1 scene unit ≈ 0.5 m): a small aluminium-framed glasshouse over two timber raised beds with
 * plants, a 40 L water tank on the floor, a low equipment plinth with the pump, the valve manifold
 * and the farm controller, a vent fan in the gable, a solar panel on its stand, climate and light
 * sensors on stakes, four irrigation hoses with quick-connect couplings and three power cables with
 * weatherproof plugs, and one soil probe.
 *
 * Every port is a recessed, typed coupler (blue collar: water; black keyed socket: power; brass
 * pins: probe slot) at the position the room's port index refers to (cloudflare/greenhouse-rules.js).
 * What the rig shows comes from the model state (cloudflare/greenhouse-model.js) at the room's
 * current model time — tank level, gauge, soil wetness, plant posture and colour, the fan and pump
 * turning, the controller's channel LEDs and display, sensor readouts, water moving in a hose —
 * never from a decorative timer. Wrong hoses and cables carry nothing and wear red fault collars.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Object3D,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  RingGeometry,
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
import { GH_BOUNDS, GH_FIXTURE_POSES, GH_PORTS, type GhProps } from "../../cloudflare/greenhouse-rules.js";
import type { GhLineStatus, PlantState, PumpState } from "../../cloudflare/greenhouse-model.js";

/** Floor surface height; the plinth top; a carried hose end's height; where free ends lie. */
export const GH_FLOOR_Y = 0.11;
export const PLINTH_TOP = 0.47;
export const GH_DRAG_Y = 1.3;
export const GH_REST_Y = GH_FLOOR_Y + 0.05;

/** Bed geometry (world): centres, size, soil surface. */
export const BEDS = { A: { x: -2.45 }, B: { x: -0.25 }, z: -0.5, width: 1.8, depth: 1.9, rimTop: 0.66, soil: 0.6 };
const TANK = { x: 2.85, z: -1.15, r: 0.36, h: 0.9 };

/** Port socket points in world space, indexed like GH_PORTS (what lines' `sockets` hold). */
const PORT_POINTS: Array<[number, number, number]> = [
  [2.35, 0.48, -0.45], // tank out (coupler on a stand at the end of the tank's outlet pipe)
  [-1.95, 0.84, 1.98], // pump in
  [-0.85, 0.84, 1.98], // pump out
  [-0.35, 0.84, 1.98], // manifold in
  [0.55, 0.84, 1.7], // valve A out
  [0.95, 0.84, 2.22], // valve B out
  [BEDS.A.x + 0.55, 0.74, 0.4], // bed A inlet (drip header on the front rail)
  [BEDS.B.x + 0.55, 0.74, 0.4], // bed B inlet
  [3.3, 0.6, 1.24], // solar out (junction box on the stand)
  [1.45, 0.62, 2.4], // controller solar in
  [2.05, 0.62, 2.4], // controller CH1
  [2.65, 0.62, 2.4], // controller CH2
  [-1.4, 0.64, 2.4], // pump 12 V in
  [1.3, 0.56, 0.2], // fan 12 V in (junction box at the gable post's foot)
  [BEDS.A.x - 0.67, BEDS.soil + 0.02, 0.05], // bed A probe slot, pin 1
  [BEDS.A.x - 0.43, BEDS.soil + 0.02, 0.05], // pin 2
  [BEDS.B.x - 0.67, BEDS.soil + 0.02, 0.05], // bed B probe slot, pin 1
  [BEDS.B.x - 0.43, BEDS.soil + 0.02, 0.05], // pin 2
];
export function ghPortPositions(): Vector3[] {
  return PORT_POINTS.map(([x, y, z]) => new Vector3(x, y, z));
}

/** The whole rig, for camera framing and the composition metric. */
export const GH_FRAME = { min: new Vector3(-3.75, 0, -2.05), max: new Vector3(4.15, 2.95, 2.62) };
export const GH_BEDS_FRAME = { min: new Vector3(-3.5, 0, -1.6), max: new Vector3(0.75, 1.4, 0.6) };

export interface LineSpec { id: string; kind: "ghhose" | "ghcable"; name: string; color: number; css: string; rest: number; home: [number, number, number] }
export const LINE_SPECS: LineSpec[] = [
  { id: "irrigation-hose", kind: "ghhose", name: "Hose 1 · 2.7 m", color: 0x2f8f4e, css: "#3fa35f", rest: 5.4, home: [-3.15, GH_REST_Y, 0.72] },
  { id: "irrigation-hose-2", kind: "ghhose", name: "Hose 2 · 0.65 m", color: 0x2f8f4e, css: "#3fa35f", rest: 1.3, home: [-1.25, GH_REST_Y, 0.72] },
  { id: "irrigation-hose-3", kind: "ghhose", name: "Hose 3 · 1.8 m", color: 0x2f8f4e, css: "#3fa35f", rest: 3.6, home: [-3.15, GH_REST_Y, 1.22] },
  { id: "irrigation-hose-4", kind: "ghhose", name: "Hose 4 · 1.5 m", color: 0x2f8f4e, css: "#3fa35f", rest: 3.0, home: [-1.25, GH_REST_Y, 1.22] },
  { id: "power-cable-1", kind: "ghcable", name: "Cable 1 · 1.4 m", color: 0x1b1d22, css: "#e2b93b", rest: 2.8, home: [1.35, GH_REST_Y, 0.78] },
  { id: "power-cable-2", kind: "ghcable", name: "Cable 2 · 2.1 m", color: 0x1b1d22, css: "#e2b93b", rest: 4.2, home: [2.55, GH_REST_Y, 1.02] },
  { id: "power-cable-3", kind: "ghcable", name: "Cable 3 · 1.7 m", color: 0x1b1d22, css: "#e2b93b", rest: 3.4, home: [1.35, GH_REST_Y, 1.26] },
];
/** Where an unplugged line end lies when released (end separation at home: compact, slack curls). */
export const LINE_HOME_SPAN = 1.5;
export const PROBE_HOME: [number, number, number] = [-2.38, PLINTH_TOP + 0.02, 2.12];
/** The soil probe's pin spacing (= a slot's pin spacing). */
export const PROBE_PIN_SPACING = 0.24;

// ── Materials (shared) ───────────────────────────────────────────────────────────────

const cache = new Map<string, unknown>();
function once<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}
const mat = {
  aluminium: () => once("aluminium", () => new MeshStandardMaterial({ name: "frame_aluminium", color: 0xcfd6db, metalness: 0.78, roughness: 0.34 })),
  timber: () => once("timber", () => new MeshStandardMaterial({ name: "bed_timber_larch", color: 0x9a6a3f, metalness: 0, roughness: 0.78 })),
  timberEnd: () => once("timberEnd", () => new MeshStandardMaterial({ name: "bed_timber_endgrain", color: 0x7b5232, metalness: 0, roughness: 0.86 })),
  concrete: () => once("concrete", () => new MeshStandardMaterial({ name: "floor_concrete_paver", color: 0x7d7a74, metalness: 0, roughness: 0.92 })),
  plinth: () => once("plinth", () => new MeshStandardMaterial({ name: "plinth_powdercoat", color: 0x2b3640, metalness: 0.35, roughness: 0.55 })),
  hdpe: () => once("hdpe", () => new MeshStandardMaterial({ name: "tank_hdpe_translucent", color: 0xdfe8ea, metalness: 0, roughness: 0.6, transparent: true, opacity: 0.55 })),
  water: () => once("water", () => new MeshPhysicalMaterial({ name: "tank_water", color: 0x3d8fbf, metalness: 0, roughness: 0.15, transparent: true, opacity: 0.78, clearcoat: 0.6 })),
  steel: () => once("steel", () => new MeshStandardMaterial({ name: "fitting_steel", color: 0xa8b0b7, metalness: 0.95, roughness: 0.3 })),
  brass: () => once("brass", () => new MeshStandardMaterial({ name: "fitting_brass", color: 0xc79a3c, metalness: 0.95, roughness: 0.32 })),
  black: () => once("black", () => new MeshStandardMaterial({ name: "housing_black_abs", color: 0x17191d, metalness: 0.1, roughness: 0.48 })),
  grey: () => once("grey", () => new MeshStandardMaterial({ name: "housing_grey_abs", color: 0x5c6670, metalness: 0.15, roughness: 0.5 })),
  blue: () => once("blue", () => new MeshStandardMaterial({ name: "coupler_blue_pom", color: 0x1f6fbf, metalness: 0.05, roughness: 0.42 })),
  bore: () => once("bore", () => new MeshStandardMaterial({ name: "port_bore", color: 0x090a0c, metalness: 0.2, roughness: 0.85, side: DoubleSide })),
  pumpRed: () => once("pumpRed", () => new MeshStandardMaterial({ name: "pump_motor_paint", color: 0x9b2a24, metalness: 0.45, roughness: 0.42 })),
  cell: () => once("cell", () => new MeshPhysicalMaterial({ name: "solar_cell_glass", color: 0x14294a, metalness: 0.3, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 })),
  glazing: () => once("glazing", () => new MeshPhysicalMaterial({ name: "glazing_polycarbonate", color: 0xdcefe8, transparent: true, opacity: 0.16, roughness: 0.1, clearcoat: 0.5, depthWrite: false })),
  stem: () => once("stem", () => new MeshStandardMaterial({ name: "plant_stem", color: 0x3c7d34, metalness: 0, roughness: 0.7 })),
  white: () => once("white", () => new MeshStandardMaterial({ name: "radiation_shield_white", color: 0xeef1f2, metalness: 0, roughness: 0.55 })),
  fault: () => once("fault", () => new MeshStandardMaterial({ name: "fault_collar", color: 0xdc2626, emissive: 0x7f1d1d, emissiveIntensity: 0.35, metalness: 0, roughness: 0.5 })),
};
const FONT = "Inter, system-ui, sans-serif";

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

/** A printed label (a plane facing `normal`), depth-tested. */
function label(text: string, width: number, height: number, options: { color?: string; background?: string; weight?: number } = {}): Mesh {
  const texture = canvasTexture(Math.round(width * 400), Math.round(height * 400), (context, w, h) => {
    if (options.background) {
      context.fillStyle = options.background;
      context.fillRect(0, 0, w, h);
    }
    context.fillStyle = options.color ?? "#f1f5f9";
    context.font = `${options.weight ?? 700} ${Math.round(h * 0.62)}px ${FONT}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, w / 2, h / 2 + 1);
  });
  const material = new MeshStandardMaterial({ map: texture, transparent: !options.background, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: !!options.background });
  material.name = "printed_label";
  const mesh = new Mesh(new PlaneGeometry(width, height), material);
  mesh.userData.noShadow = true;
  return mesh;
}
/** A label lying flat (readable from the front, i.e. from +z). */
function flatLabel(text: string, width: number, height: number, x: number, y: number, z: number, options: { color?: string; background?: string } = {}): Mesh {
  const mesh = label(text, width, height, options);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
}

/** A live readout panel (canvas texture redrawn on change). */
export interface Readout { mesh: Mesh; draw: (lines: string[], tone?: "ok" | "warn" | "off") => void; last: string }
function readout(width: number, height: number): Readout {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * 420);
  canvas.height = Math.round(height * 420);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
  material.name = "lcd_readout";
  const mesh = new Mesh(new PlaneGeometry(width, height), material);
  mesh.userData.noShadow = true;
  const state: Readout = {
    mesh,
    last: "",
    draw: (lines, tone = "ok") => {
      const key = `${tone}|${lines.join("|")}`;
      if (key === state.last) return;
      state.last = key;
      const context = canvas.getContext("2d");
      if (!context) return;
      const w = canvas.width;
      const h = canvas.height;
      context.fillStyle = tone === "off" ? "#0b1410" : "#0d1d17";
      context.fillRect(0, 0, w, h);
      context.fillStyle = tone === "warn" ? "#fbbf24" : tone === "off" ? "#335546" : "#8ff0b8";
      // The largest monospace size at which every line fits the display's width.
      let size = Math.round(h / (lines.length + 0.6));
      context.font = `600 ${size}px ui-monospace, Menlo, monospace`;
      const widest = Math.max(...lines.map((line) => context.measureText(line).width));
      if (widest > w * 0.88) {
        size = Math.max(8, Math.floor((size * w * 0.88) / widest));
        context.font = `600 ${size}px ui-monospace, Menlo, monospace`;
      }
      context.textBaseline = "middle";
      lines.forEach((line, index) => context.fillText(line, w * 0.06, (h / lines.length) * (index + 0.5)));
      texture.needsUpdate = true;
    },
  };
  state.draw(["--"], "off");
  return state;
}

// ── Ports ───────────────────────────────────────────────────────────────────────────

/** A recessed water coupler (blue collar, steel valve body, dark bore); socket point at its lip. */
function waterCoupler(): Group {
  const group = new Group();
  const collar = new Mesh(new LatheGeometry([new Vector2(0.06, -0.05), new Vector2(0.11, -0.05), new Vector2(0.12, -0.03), new Vector2(0.12, 0.0), new Vector2(0.09, 0.012), new Vector2(0.06, 0.012)], 32), mat.blue());
  const body = new Mesh(new CylinderGeometry(0.075, 0.085, 0.16, 24).translate(0, -0.13, 0), mat.steel());
  const bore = new Mesh(new CylinderGeometry(0.058, 0.058, 0.13, 20, 1, true).translate(0, -0.055, 0), mat.bore());
  const floor = new Mesh(new CircleGeometry(0.058, 20).rotateX(-Math.PI / 2).translate(0, -0.12, 0), mat.bore());
  group.add(collar, body, bore, floor);
  return group;
}
/** A weatherproof power socket (black keyed shroud, brass contacts deep in the bore). */
function powerSocket(): Group {
  const group = new Group();
  const shroud = new Mesh(new LatheGeometry([new Vector2(0.062, -0.06), new Vector2(0.105, -0.06), new Vector2(0.108, 0.0), new Vector2(0.085, 0.014), new Vector2(0.062, 0.014)], 6), mat.black());
  shroud.rotation.y = Math.PI / 6;
  const bore = new Mesh(new CylinderGeometry(0.06, 0.06, 0.14, 18, 1, true).translate(0, -0.06, 0), mat.bore());
  const pins: BufferGeometry[] = [];
  for (const dx of [-0.022, 0.022]) pins.push(new CylinderGeometry(0.009, 0.009, 0.05, 8).translate(dx, -0.1, 0));
  const contacts = new Mesh(mergeGeometries(pins)!, mat.brass());
  const key = new Mesh(new BoxGeometry(0.024, 0.016, 0.03).translate(0, 0.006, -0.085), mat.grey());
  group.add(shroud, bore, contacts, key);
  return group;
}
/** One probe-slot pin socket (brass sleeve flush with the soil plate). */
function probePin(): Group {
  const group = new Group();
  const plate = new Mesh(new CylinderGeometry(0.06, 0.07, 0.03, 18).translate(0, -0.012, 0), mat.black());
  const sleeve = new Mesh(new CylinderGeometry(0.028, 0.028, 0.06, 14, 1, true).translate(0, -0.02, 0), mat.brass());
  group.add(plate, sleeve);
  return group;
}

/** Couplers at every port; returned for fault collars and highlights. */
function ports(): { group: Group; faultCollars: Mesh[] } {
  const group = new Group();
  const faultCollars: Mesh[] = [];
  const statics = new Group();
  GH_PORTS.forEach((port, index) => {
    const [x, y, z] = PORT_POINTS[index];
    const part = port.type === "water" ? waterCoupler() : port.type === "power" ? powerSocket() : probePin();
    part.position.set(x, y, z);
    statics.add(part);
    const collar = new Mesh(new TorusGeometry(port.type === "probe" ? 0.075 : 0.14, 0.022, 8, 28).rotateX(Math.PI / 2), mat.fault());
    collar.position.set(x, y + 0.02, z);
    collar.visible = false;
    collar.userData.noShadow = true;
    group.add(collar);
    faultCollars.push(collar);
  });
  // The couplers never move: one draw per material instead of four meshes per port.
  group.add(mergeStatic(statics));
  return { group, faultCollars };
}

/** Bakes a static group's meshes into one mesh per material (world transforms relative to the group). */
function mergeStatic(source: Group): Group {
  source.updateMatrixWorld(true);
  const buckets = new Map<Material, BufferGeometry[]>();
  source.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const geometry = (child.geometry as BufferGeometry).clone().applyMatrix4(child.matrixWorld);
    const material = child.material as Material;
    if (!buckets.has(material)) buckets.set(material, []);
    buckets.get(material)!.push(geometry.index ? geometry.toNonIndexed() : geometry);
  });
  const merged = new Group();
  for (const [material, geometries] of buckets) {
    const attributes = Object.keys(geometries[0].attributes);
    const compatible = geometries.map((geometry) => {
      for (const name of Object.keys(geometry.attributes)) if (!attributes.includes(name)) geometry.deleteAttribute(name);
      return geometry;
    });
    const geometry = mergeGeometries(compatible);
    if (geometry) merged.add(new Mesh(geometry, material));
  }
  return merged;
}

// ── The glasshouse, beds, plants, tank, plinth ──────────────────────────────────────

/** One bed's plants: every leaf (and every stem) of the bed is one instance of one mesh. */
interface PlantField { leaves: InstancedMesh; stems: InstancedMesh; roots: Vector3[]; seeds: number[] }
const LEAVES_PER_PLANT = 7;
export interface RigVisuals {
  soil: { A: MeshStandardMaterial; B: MeshStandardMaterial };
  puddles: { A: Mesh; B: Mesh };
  plants: { A: PlantField; B: PlantField };
  leafMaterials: { A: MeshStandardMaterial; B: MeshStandardMaterial };
  water: Mesh;
  needle: Mesh;
  gauge: Readout;
  faultCollars: Mesh[];
}

function plantField(leafMaterial: MeshStandardMaterial, roots: Vector3[], seedBase: number): PlantField {
  const leafGeometry = once("leafGeometry", () => {
    const g = new SphereGeometry(0.11, 12, 6);
    g.scale(1.6, 0.22, 0.75);
    g.translate(0.15, 0, 0);
    return g;
  });
  const stemGeometry = once("stemGeometry", () => new CylinderGeometry(0.018, 0.03, 0.46, 8).translate(0, 0.23, 0));
  const leaves = new InstancedMesh(leafGeometry, leafMaterial, roots.length * LEAVES_PER_PLANT);
  const stems = new InstancedMesh(stemGeometry, mat.stem(), roots.length);
  const field: PlantField = { leaves, stems, roots, seeds: roots.map((_, index) => seedBase + index) };
  posePlants(field, 0, 1, 1);
  return field;
}

const plantRoot = new Object3D();
const plantLeaf = new Object3D();
plantRoot.add(plantLeaf);
const plantMatrix = new Matrix4();
/** Poses every leaf and stem: `droop` lowers the leaves (rad), `curl` narrows them, `height` scales the plant. */
function posePlants(field: PlantField, droop: number, curl: number, height: number): void {
  field.roots.forEach((root, plantIndex) => {
    plantRoot.position.copy(root);
    plantRoot.scale.set(1, height, 1);
    plantRoot.updateMatrixWorld(true);
    field.stems.setMatrixAt(plantIndex, plantRoot.matrixWorld);
    for (let i = 0; i < LEAVES_PER_PLANT; i += 1) {
      plantLeaf.position.set(0, 0.14 + i * 0.055, 0);
      plantLeaf.rotation.set(0, field.seeds[plantIndex] * 1.7 + i * 2.4, -0.32 + (i % 2) * 0.08 - droop);
      plantLeaf.scale.set(1, 1, curl);
      plantLeaf.updateMatrixWorld(true);
      plantMatrix.copy(plantLeaf.matrixWorld);
      field.leaves.setMatrixAt(plantIndex * LEAVES_PER_PLANT + i, plantMatrix);
    }
  });
  field.leaves.instanceMatrix.needsUpdate = true;
  field.stems.instanceMatrix.needsUpdate = true;
  field.leaves.computeBoundingSphere();
  field.stems.computeBoundingSphere();
}

/** The static greenhouse with its live parts (soil, plants, tank level, gauge, fault collars). */
export function createGreenhouseRig(): Group {
  const group = new Group();
  group.name = "greenhouse_rig";
  // Floor: concrete pavers.
  const floor = new Mesh(new RoundedBoxGeometry(8.6, 0.16, 5.9, 2, 0.03).translate(0.15, GH_FLOOR_Y - 0.08, 0), mat.concrete());
  floor.receiveShadow = true;
  group.add(floor);
  const joints: BufferGeometry[] = [];
  for (let x = -4.1; x <= 4.4; x += 0.85) joints.push(new BoxGeometry(0.012, 0.004, 5.9).translate(x, GH_FLOOR_Y + 0.001, 0));
  for (let z = -2.9; z <= 2.95; z += 0.85) joints.push(new BoxGeometry(8.6, 0.004, 0.012).translate(0.15, GH_FLOOR_Y + 0.001, z));
  group.add(new Mesh(mergeGeometries(joints)!, mat.grey()));

  // Glasshouse frame over the beds (x −3.65..0.95, z −1.95..0.9).
  const frame: BufferGeometry[] = [];
  for (const x of [-3.65, -1.35, 0.95]) for (const z of [-1.95, 0.9]) frame.push(new BoxGeometry(0.07, 2.2, 0.07).translate(x, GH_FLOOR_Y + 1.1, z));
  for (const z of [-1.95, 0.9]) frame.push(new BoxGeometry(4.68, 0.07, 0.07).translate(-1.35, GH_FLOOR_Y + 2.2, z));
  for (const x of [-3.65, 0.95]) frame.push(new BoxGeometry(0.07, 0.07, 2.92).translate(x, GH_FLOOR_Y + 2.2, -0.525));
  frame.push(new BoxGeometry(4.68, 0.07, 0.07).translate(-1.35, GH_FLOOR_Y + 2.78, -0.525));
  for (const x of [-3.65, -1.35, 0.95]) {
    for (const [z0, z1] of [[-1.95, -0.525], [0.9, -0.525]] as const) {
      const a = new Vector3(x, GH_FLOOR_Y + 2.2, z0);
      const b = new Vector3(x, GH_FLOOR_Y + 2.78, z1);
      const length = a.distanceTo(b);
      const rafter = new BoxGeometry(0.06, 0.06, length);
      rafter.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), b.clone().sub(a).normalize()));
      rafter.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      frame.push(rafter);
    }
  }
  group.add(new Mesh(mergeGeometries(frame)!, mat.aluminium()));
  // Glazing: back wall, left gable and roof (front and right left open for the view).
  const glass: BufferGeometry[] = [];
  glass.push(new PlaneGeometry(4.6, 2.12).translate(-1.35, GH_FLOOR_Y + 1.1, -1.95));
  glass.push(new PlaneGeometry(2.84, 2.12).rotateY(Math.PI / 2).translate(-3.65, GH_FLOOR_Y + 1.1, -0.525));
  for (const [z0, z1] of [[-1.95, -0.525], [0.9, -0.525]] as const) {
    const a = new Vector3(-1.35, GH_FLOOR_Y + 2.2, z0);
    const b = new Vector3(-1.35, GH_FLOOR_Y + 2.78, z1);
    const pane = new PlaneGeometry(4.6, a.distanceTo(b)).rotateX(-Math.PI / 2);
    pane.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), b.clone().sub(a).normalize()));
    pane.translate(-1.35, (a.y + b.y) / 2, (a.z + b.z) / 2);
    glass.push(pane);
  }
  const glazing = new Mesh(mergeGeometries(glass)!, mat.glazing());
  glazing.userData.noShadow = true;
  glazing.renderOrder = 4;
  group.add(glazing);

  // Raised beds with soil and plants.
  const soilA = new MeshStandardMaterial({ name: "bed_soil_A", color: 0x5b4127, roughness: 0.95, metalness: 0 });
  const soilB = new MeshStandardMaterial({ name: "bed_soil_B", color: 0x5b4127, roughness: 0.95, metalness: 0 });
  const leafA = new MeshStandardMaterial({ name: "plant_leaf_A", color: 0x4caf50, roughness: 0.62, metalness: 0, side: DoubleSide });
  const leafB = new MeshStandardMaterial({ name: "plant_leaf_B", color: 0x4caf50, roughness: 0.62, metalness: 0, side: DoubleSide });
  const timber: BufferGeometry[] = [];
  const ends: BufferGeometry[] = [];
  const plants: Partial<RigVisuals["plants"]> = {};
  const puddles: Partial<RigVisuals["puddles"]> = {};
  for (const bed of ["A", "B"] as const) {
    const cx = BEDS[bed].x;
    const half = { x: BEDS.width / 2, z: BEDS.depth / 2 };
    for (let tier = 0; tier < 3; tier += 1) {
      const y = GH_FLOOR_Y + 0.09 + tier * 0.165;
      timber.push(new BoxGeometry(BEDS.width, 0.15, 0.09).translate(cx, y, BEDS.z - half.z + 0.045));
      timber.push(new BoxGeometry(BEDS.width, 0.15, 0.09).translate(cx, y, BEDS.z + half.z - 0.045));
      timber.push(new BoxGeometry(0.09, 0.15, BEDS.depth - 0.18).translate(cx - half.x + 0.045, y, BEDS.z));
      timber.push(new BoxGeometry(0.09, 0.15, BEDS.depth - 0.18).translate(cx + half.x - 0.045, y, BEDS.z));
    }
    for (const dx of [-half.x + 0.06, half.x - 0.06]) for (const dz of [-half.z + 0.06, half.z - 0.06]) ends.push(new BoxGeometry(0.1, BEDS.rimTop - GH_FLOOR_Y + 0.02, 0.1).translate(cx + dx, (BEDS.rimTop + GH_FLOOR_Y) / 2, BEDS.z + dz));
    const soil = new Mesh(new BoxGeometry(BEDS.width - 0.18, 0.06, BEDS.depth - 0.18).translate(cx, BEDS.soil - 0.03, BEDS.z), bed === "A" ? soilA : soilB);
    soil.receiveShadow = true;
    group.add(soil);
    const puddle = new Mesh(new CircleGeometry(0.42, 28).rotateX(-Math.PI / 2).translate(cx + 0.15, BEDS.soil + 0.003, BEDS.z - 0.2), new MeshPhysicalMaterial({ name: "puddle", color: 0x2b4150, roughness: 0.05, transparent: true, opacity: 0.6, clearcoat: 1 }));
    puddle.visible = false;
    puddle.userData.noShadow = true;
    group.add(puddle);
    puddles[bed] = puddle;
    // Drip line: a header from the inlet along the front, with laterals to each plant row.
    const inlet = PORT_POINTS[bed === "A" ? 6 : 7];
    const drip: BufferGeometry[] = [];
    drip.push(new TubeGeometry(new CatmullRomCurve3([new Vector3(inlet[0], inlet[1] - 0.18, inlet[2]), new Vector3(inlet[0] - 0.05, BEDS.soil + 0.03, BEDS.z + 0.3), new Vector3(cx - 0.6, BEDS.soil + 0.02, BEDS.z + 0.3)]), 20, 0.018, 6, false));
    drip.push(new TubeGeometry(new CatmullRomCurve3([new Vector3(cx + 0.55, BEDS.soil + 0.02, BEDS.z - 0.3), new Vector3(cx - 0.6, BEDS.soil + 0.02, BEDS.z - 0.3)]), 8, 0.018, 6, false));
    drip.push(new TubeGeometry(new CatmullRomCurve3([new Vector3(cx + 0.58, BEDS.soil + 0.02, BEDS.z + 0.3), new Vector3(cx + 0.58, BEDS.soil + 0.02, BEDS.z - 0.3)]), 6, 0.018, 6, false));
    group.add(new Mesh(mergeGeometries(drip)!, mat.black()));
    const roots: Vector3[] = [];
    for (const dx of [-0.38, 0.38]) for (const dz of [-0.3, 0.3]) roots.push(new Vector3(cx + dx + 0.1, BEDS.soil, BEDS.z + dz));
    const field = plantField(bed === "A" ? leafA : leafB, roots, bed === "A" ? 0 : 7);
    group.add(field.stems, field.leaves);
    plants[bed] = field;
    const sign = flatLabel(`BED ${bed}`, 0.62, 0.16, cx - 0.4, BEDS.rimTop + 0.002, BEDS.z + BEDS.depth / 2 - 0.045, { color: "#fef3c7" });
    group.add(sign);
    // The bed's rim label stands on the front rail top (printed on a strip).
    const rim = new Mesh(new BoxGeometry(BEDS.width, 0.012, 0.09).translate(cx, BEDS.rimTop - 0.006, BEDS.z + half.z - 0.045), mat.timberEnd());
    group.add(rim);
  }
  group.add(new Mesh(mergeGeometries(timber)!, mat.timber()));
  group.add(new Mesh(mergeGeometries(ends)!, mat.timberEnd()));

  // The 40 L tank on the floor, its level gauge and the outlet pipe to the TANK OUT coupler.
  const shell = new Mesh(new CylinderGeometry(TANK.r, TANK.r, TANK.h, 40, 1, true).translate(TANK.x, GH_FLOOR_Y + TANK.h / 2, TANK.z), mat.hdpe());
  shell.renderOrder = 3;
  group.add(shell);
  const tankParts: BufferGeometry[] = [];
  tankParts.push(new CylinderGeometry(TANK.r + 0.02, TANK.r + 0.02, 0.05, 40).translate(TANK.x, GH_FLOOR_Y + TANK.h + 0.025, TANK.z));
  tankParts.push(new CylinderGeometry(TANK.r + 0.015, TANK.r + 0.015, 0.04, 40).translate(TANK.x, GH_FLOOR_Y + 0.02, TANK.z));
  for (const y of [0.3, 0.62]) tankParts.push(new TorusGeometry(TANK.r + 0.008, 0.012, 6, 40).rotateX(Math.PI / 2).translate(TANK.x, GH_FLOOR_Y + y, TANK.z));
  group.add(new Mesh(mergeGeometries(tankParts)!, mat.grey()));
  const water = new Mesh(new CylinderGeometry(TANK.r - 0.02, TANK.r - 0.02, 1, 40).translate(0, 0.5, 0), mat.water());
  water.position.set(TANK.x, GH_FLOOR_Y + 0.04, TANK.z);
  water.scale.y = TANK.h - 0.1;
  water.renderOrder = 2;
  group.add(water);
  const outlet = PORT_POINTS[0];
  const pipe = new TubeGeometry(new CatmullRomCurve3([
    new Vector3(TANK.x - 0.2, GH_FLOOR_Y + 0.1, TANK.z + 0.3),
    new Vector3(TANK.x - 0.35, GH_FLOOR_Y + 0.1, TANK.z + 0.52),
    new Vector3(outlet[0] + 0.05, GH_FLOOR_Y + 0.1, outlet[2] - 0.1),
    new Vector3(outlet[0], outlet[1] - 0.25, outlet[2]),
  ]), 24, 0.04, 10, false);
  const stand = new BoxGeometry(0.2, outlet[1] - 0.15 - GH_FLOOR_Y, 0.2).translate(outlet[0], GH_FLOOR_Y + (outlet[1] - 0.15 - GH_FLOOR_Y) / 2, outlet[2]);
  group.add(new Mesh(pipe, mat.grey()), new Mesh(stand, mat.plinth()));
  // Level gauge: a dial on a post in front of the tank (needle angle = litres / 40).
  const gaugeFace = new Mesh(new CircleGeometry(0.17, 32), mat.white());
  gaugeFace.position.set(TANK.x + 0.45, GH_FLOOR_Y + 0.95, TANK.z + 0.38);
  gaugeFace.rotation.y = -0.5;
  const gaugePost = new Mesh(new CylinderGeometry(0.025, 0.025, 0.85, 10).translate(TANK.x + 0.45, GH_FLOOR_Y + 0.42, TANK.z + 0.36), mat.steel());
  const needle = new Mesh(new BoxGeometry(0.014, 0.13, 0.008).translate(0, 0.055, 0), new MeshBasicMaterial({ color: 0xdc2626 }));
  needle.position.copy(gaugeFace.position).add(new Vector3(0.01, 0, 0.01).applyAxisAngle(new Vector3(0, 1, 0), -0.5));
  needle.rotation.set(0, -0.5, 0);
  group.add(gaugeFace, gaugePost, needle);
  const gauge = readout(0.42, 0.13);
  gauge.mesh.position.set(TANK.x + 0.45, GH_FLOOR_Y + 0.7, TANK.z + 0.39);
  gauge.mesh.rotation.y = -0.5;
  group.add(gauge.mesh);
  const tankSign = label("TANK 40 L", 0.44, 0.1, { color: "#e2e8f0", background: "#1e293b" });
  tankSign.position.set(TANK.x, GH_FLOOR_Y + 0.6, TANK.z + TANK.r + 0.01);
  group.add(tankSign);

  // The equipment plinth.
  const plinth = new Mesh(new RoundedBoxGeometry(5.5, PLINTH_TOP - GH_FLOOR_Y, 1.0, 2, 0.03).translate(0.15, (PLINTH_TOP + GH_FLOOR_Y) / 2, 2.05), mat.plinth());
  group.add(plinth);
  const terminal = new Mesh(new RoundedBoxGeometry(1.7, 0.1, 0.24, 2, 0.02).translate(2.05, PLINTH_TOP + 0.05, 2.4), mat.black());
  group.add(terminal);
  for (const [text, x] of [["SOLAR IN", 1.45], ["CH1 ▲", 2.05], ["CH2", 2.65]] as const) group.add(flatLabel(text, 0.42, 0.09, x, PLINTH_TOP + 0.102, 2.5, { color: "#fde68a" }));
  // Junction boxes for the fan (at the gable post) and the solar panel (on its stand).
  const fanBox = new Mesh(new RoundedBoxGeometry(0.34, 0.42, 0.3, 2, 0.03).translate(PORT_POINTS[13][0], GH_FLOOR_Y + 0.21, PORT_POINTS[13][2]), mat.grey());
  const conduit = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(PORT_POINTS[13][0], GH_FLOOR_Y + 0.4, PORT_POINTS[13][2] - 0.12), new Vector3(1.0, 0.7, -0.1), new Vector3(1.0, 1.3, -0.5)]), 16, 0.025, 8, false), mat.black());
  group.add(fanBox, conduit);
  group.add(flatLabel("FAN 12 V", 0.34, 0.08, PORT_POINTS[13][0], GH_FLOOR_Y + 0.425, PORT_POINTS[13][2] + 0.11, { color: "#fde68a" }));
  // Port labels on the floor/plinth next to each water port.
  const portText: Array<[number, string, number, number]> = [[0, "TANK OUT", 0, 0.22], [1, "PUMP IN", 0, 0.24], [2, "PUMP OUT", 0, 0.24], [3, "MANIFOLD IN", 0, 0.24], [4, "VALVE A OUT", 0, -0.2], [5, "VALVE B OUT", -0.42, 0.12], [6, "INLET A", 0, -0.12], [7, "INLET B", 0, -0.12]];
  for (const [index, text, dx, dz] of portText) {
    const [x, y, z] = PORT_POINTS[index];
    const base = index === 6 || index === 7 ? BEDS.rimTop + 0.004 : index === 0 ? GH_FLOOR_Y + 0.002 : PLINTH_TOP + 0.003;
    group.add(flatLabel(text, 0.5, 0.085, x + dx, base, z + dz, { color: "#dbeafe" }));
    void y;
  }
  const portsGroup = ports();
  group.add(portsGroup.group);

  const visuals: RigVisuals = { soil: { A: soilA, B: soilB }, puddles: puddles as RigVisuals["puddles"], plants: plants as RigVisuals["plants"], leafMaterials: { A: leafA, B: leafB }, water, needle, gauge, faultCollars: portsGroup.faultCollars };
  group.userData.ghVisuals = visuals;
  for (const child of group.children) child.userData.noPick = true;
  return group;
}

// ── Fixtures (room parts that never move) ───────────────────────────────────────────

export interface FixtureVisuals {
  rotor?: Group;
  led?: MeshStandardMaterial;
  leds?: Record<string, MeshStandardMaterial>;
  display?: Readout;
  handles?: { valveA: Group; valveB: Group };
  dials?: { pumpBelow: Group; fanAbove: Group };
  controls?: Record<string, Object3DLike>;
}
type Object3DLike = Group | Mesh;

function ledLens(color: number): { mesh: Mesh; material: MeshStandardMaterial } {
  const material = new MeshStandardMaterial({ name: "indicator_led", color, emissive: color, emissiveIntensity: 0, roughness: 0.25, transparent: true, opacity: 0.95 });
  material.color.multiplyScalar(0.35);
  const mesh = new Mesh(new SphereGeometry(0.03, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), material);
  mesh.userData.noShadow = true;
  return { mesh, material };
}

/** A fixture's group, built at its local origin (the component is placed at its fixture pose). */
export function createGhFixture(id: string): Group {
  const group = new Group();
  const visuals: FixtureVisuals = {};
  const pose = GH_FIXTURE_POSES[id];
  const local = (index: number): Vector3 => new Vector3(PORT_POINTS[index][0] - pose[0], PORT_POINTS[index][1] - pose[1], PORT_POINTS[index][2] - pose[2]);
  if (id === "water-pump") {
    // A small 12 V centrifugal pump: motor can, volute, inlet/outlet elbows up to the couplers.
    const motor = new Mesh(new CylinderGeometry(0.17, 0.17, 0.46, 28).rotateZ(Math.PI / 2).translate(-0.05, PLINTH_TOP + 0.2, 0), mat.pumpRed());
    const fins: BufferGeometry[] = [];
    for (let i = 0; i < 8; i += 1) fins.push(new TorusGeometry(0.175, 0.008, 4, 28).rotateY(Math.PI / 2).translate(-0.24 + i * 0.05, PLINTH_TOP + 0.2, 0));
    const volute = new Mesh(new CylinderGeometry(0.22, 0.22, 0.12, 28).rotateZ(Math.PI / 2).translate(0.24, PLINTH_TOP + 0.22, 0), mat.grey());
    const foot = new Mesh(new BoxGeometry(0.62, 0.05, 0.3).translate(0, PLINTH_TOP + 0.025, 0), mat.black());
    const rotor = new Group();
    const hub = new Mesh(new CylinderGeometry(0.06, 0.06, 0.02, 16).rotateZ(Math.PI / 2), mat.steel());
    const vane = new Mesh(new BoxGeometry(0.01, 0.15, 0.025), mat.steel());
    const vane2 = vane.clone();
    vane2.rotation.x = Math.PI / 2;
    rotor.add(hub, vane, vane2);
    rotor.position.set(0.31, PLINTH_TOP + 0.22, 0);
    const pipes: BufferGeometry[] = [];
    const inlet = local(1);
    const outlet = local(2);
    pipes.push(new TubeGeometry(new CatmullRomCurve3([new Vector3(0.3, PLINTH_TOP + 0.22, 0), new Vector3(inlet.x + 0.05, PLINTH_TOP + 0.22, 0), new Vector3(inlet.x, PLINTH_TOP + 0.3, 0), new Vector3(inlet.x, inlet.y - 0.2, 0)]), 16, 0.045, 10, false));
    pipes.push(new TubeGeometry(new CatmullRomCurve3([new Vector3(0.3, PLINTH_TOP + 0.36, 0), new Vector3(0.38, PLINTH_TOP + 0.42, 0), new Vector3(outlet.x, PLINTH_TOP + 0.42, 0), new Vector3(outlet.x, outlet.y - 0.2, 0)]), 16, 0.045, 10, false));
    const pwr = local(12);
    const box = new Mesh(new RoundedBoxGeometry(0.26, 0.12, 0.24, 2, 0.02).translate(pwr.x, PLINTH_TOP + 0.06, pwr.z), mat.black());
    const lead = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(pwr.x, PLINTH_TOP + 0.08, pwr.z - 0.1), new Vector3(-0.05, PLINTH_TOP + 0.12, 0.22), new Vector3(-0.05, PLINTH_TOP + 0.2, 0.15)]), 10, 0.015, 6, false), mat.black());
    const led = ledLens(0x22c55e);
    led.mesh.position.set(pwr.x + 0.09, PLINTH_TOP + 0.122, pwr.z - 0.06);
    group.add(motor, new Mesh(mergeGeometries(fins)!, mat.pumpRed()), volute, foot, rotor, new Mesh(mergeGeometries(pipes)!, mat.grey()), box, lead, led.mesh);
    const sign = label("PUMP 12 V · 0.4 L/min", 0.6, 0.075, { color: "#fef2f2" });
    sign.position.set(-0.05, PLINTH_TOP + 0.2, 0.172);
    group.add(sign);
    visuals.rotor = rotor;
    visuals.led = led.material;
  } else if (id === "valve-manifold") {
    // A two-outlet manifold: inlet riser, a brass bar, two ball valves with lever handles and dials.
    const inlet = local(3);
    const a = local(4);
    const b = local(5);
    const bar = new Mesh(new CylinderGeometry(0.06, 0.06, 1.0, 20).rotateZ(Math.PI / 2).translate(0.1, PLINTH_TOP + 0.18, 0), mat.brass());
    const risers: BufferGeometry[] = [];
    for (const p of [inlet, a, b]) {
      risers.push(new CylinderGeometry(0.045, 0.045, p.y - 0.2 - PLINTH_TOP, 14).translate(p.x, PLINTH_TOP + (p.y - 0.2 - PLINTH_TOP) / 2, p.z));
      if (Math.abs(p.z) > 0.05) risers.push(new CylinderGeometry(0.04, 0.04, Math.abs(p.z), 12).rotateX(Math.PI / 2).translate(p.x, PLINTH_TOP + 0.18, p.z / 2));
    }
    risers.push(new CylinderGeometry(0.045, 0.045, 0.2, 14).rotateZ(Math.PI / 2).translate(inlet.x + 0.1, PLINTH_TOP + 0.18, 0));
    const feet = new Mesh(new BoxGeometry(1.1, 0.05, 0.22).translate(0.1, PLINTH_TOP + 0.025, 0), mat.black());
    group.add(bar, new Mesh(mergeGeometries(risers)!, mat.brass()), feet);
    const handles = {} as { valveA: Group; valveB: Group };
    for (const [key, p, tag] of [["valveA", a, "A"], ["valveB", b, "B"]] as const) {
      const body = new Mesh(new SphereGeometry(0.075, 18, 12).translate(p.x, PLINTH_TOP + 0.4, p.z), mat.brass());
      const handle = new Group();
      // The lever points to the front (towards the room) when open and turns a quarter towards
      // +x as it closes, clear of the hose fitting standing in the outlet above the valve.
      const lever = new Mesh(new BoxGeometry(0.05, 0.025, 0.34).translate(0, 0, 0.17), new MeshStandardMaterial({ name: "valve_lever_red", color: 0xc0392b, roughness: 0.5 }));
      const grip = new Mesh(new CylinderGeometry(0.032, 0.032, 0.09, 10).rotateX(Math.PI / 2).translate(0, 0, 0.34), mat.black());
      grip.name = "valve_grip";
      handle.add(lever, grip);
      handle.position.set(p.x, PLINTH_TOP + 0.48, p.z);
      handle.userData.ghControl = key;
      // The valve's ball body belongs to the same control (a click on the valve focuses its field).
      body.userData.ghControl = key;
      // The handle's letter on the valve body (the port label on the plinth names the outlet).
      const letter = label(tag, 0.08, 0.08, { color: "#fef2f2", background: "#7f1d1d" });
      letter.position.set(p.x, PLINTH_TOP + 0.4, p.z + 0.077);
      group.add(body, handle, letter);
      handles[key] = handle;
    }
    visuals.handles = handles;
  } else if (id === "farm-controller") {
    // The farm controller: an IP65 enclosure with a display, two threshold dials and channel LEDs.
    const box = new Mesh(new RoundedBoxGeometry(1.5, 0.62, 0.42, 3, 0.04).translate(0, PLINTH_TOP + 0.31, -0.05), mat.white());
    const lid = new Mesh(new RoundedBoxGeometry(1.42, 0.54, 0.02, 2, 0.01).translate(0, PLINTH_TOP + 0.32, 0.17), mat.grey());
    const display = readout(0.92, 0.2);
    display.mesh.position.set(-0.18, PLINTH_TOP + 0.46, 0.185);
    group.add(box, lid, display.mesh);
    const dials = {} as { pumpBelow: Group; fanAbove: Group };
    for (const [key, x, text] of [["pumpBelow", 0.42, "PUMP BELOW"], ["fanAbove", 0.62, "FAN ABOVE"]] as const) {
      const dial = new Group();
      const body = new Mesh(new CylinderGeometry(0.075, 0.08, 0.06, 24).rotateX(Math.PI / 2), mat.black());
      const pointer = new Mesh(new BoxGeometry(0.012, 0.06, 0.012).translate(0, 0.035, 0.032), mat.white());
      dial.add(body, pointer);
      dial.position.set(x, PLINTH_TOP + 0.47, 0.215);
      dial.userData.ghControl = key;
      group.add(dial);
      const caption = label(text, 0.26, 0.05, { color: "#0f172a" });
      caption.position.set(x, PLINTH_TOP + 0.36, 0.185);
      group.add(caption);
      dials[key] = dial;
    }
    const leds: Record<string, MeshStandardMaterial> = {};
    for (const [key, x, color] of [["ch1", -0.4, 0x22c55e], ["ch2", -0.2, 0x22c55e], ["solar", 0.0, 0xfacc15], ["battery", 0.2, 0x38bdf8]] as const) {
      const lens = ledLens(color);
      lens.mesh.rotation.x = Math.PI / 2;
      lens.mesh.position.set(x, PLINTH_TOP + 0.2, 0.19);
      group.add(lens.mesh);
      leds[key] = lens.material;
      const caption = label(key.toUpperCase(), 0.17, 0.045, { color: "#0f172a" });
      caption.position.set(x, PLINTH_TOP + 0.14, 0.185);
      group.add(caption);
    }
    const title = label("FARM CONTROLLER · 12 Wh", 0.9, 0.06, { color: "#0f172a" });
    title.position.set(-0.18, PLINTH_TOP + 0.58, 0.185);
    group.add(title);
    visuals.display = display;
    visuals.dials = dials;
    visuals.leds = leds;
  } else if (id === "vent-fan") {
    // A gable vent fan: square shroud in the right wall, guard, rotor (turns only when it runs).
    const shroud = new Mesh(new BoxGeometry(0.12, 0.72, 0.72).translate(0, 1.55, 0), mat.grey());
    const ring = new Mesh(new TorusGeometry(0.3, 0.03, 8, 36).rotateY(Math.PI / 2).translate(0.07, 1.55, 0), mat.black());
    const guard: BufferGeometry[] = [];
    for (let i = -2; i <= 2; i += 1) guard.push(new BoxGeometry(0.01, 0.6, 0.012).translate(0.09, 1.55, i * 0.12));
    const rotor = new Group();
    for (let i = 0; i < 5; i += 1) {
      const blade = new Mesh(new BoxGeometry(0.02, 0.24, 0.09).translate(0, 0.14, 0), mat.black());
      blade.rotation.x = (i / 5) * Math.PI * 2;
      blade.rotation.y = 0.3;
      rotor.add(blade);
    }
    rotor.add(new Mesh(new SphereGeometry(0.05, 12, 8), mat.steel()));
    rotor.position.set(0.04, 1.55, 0);
    group.add(shroud, ring, new Mesh(mergeGeometries(guard)!, mat.steel()), rotor);
    const sign = label("VENT FAN 8 W", 0.42, 0.075, { color: "#f8fafc", background: "#334155" });
    sign.position.set(0.065, 1.08, 0);
    sign.rotation.y = Math.PI / 2;
    group.add(sign);
    visuals.rotor = rotor;
  } else if (id === "solar-panel") {
    // An 18 W panel on an A-frame stand, tilted south (towards −z), with a junction box.
    const panel = new Group();
    const cells = new Mesh(new BoxGeometry(1.15, 0.03, 0.78), mat.cell());
    const frame = new Mesh(new BoxGeometry(1.2, 0.045, 0.83), mat.aluminium());
    frame.position.y = -0.008;
    const grid: BufferGeometry[] = [];
    for (let i = -2; i <= 2; i += 1) grid.push(new BoxGeometry(0.006, 0.002, 0.76).translate(i * 0.22, 0.017, 0));
    for (let i = -1; i <= 1; i += 1) grid.push(new BoxGeometry(1.13, 0.002, 0.006).translate(0, 0.017, i * 0.25));
    panel.add(frame, cells, new Mesh(mergeGeometries(grid)!, mat.aluminium()));
    panel.position.set(0, 1.1, -0.15);
    // Cells face the room (and the default camera); the high edge is on the back legs.
    panel.rotation.x = 0.6;
    const legs: BufferGeometry[] = [];
    for (const x of [-0.5, 0.5]) {
      legs.push(new BoxGeometry(0.05, 1.1, 0.05).translate(x, GH_FLOOR_Y + 0.55, -0.4));
      legs.push(new BoxGeometry(0.05, 0.95, 0.05).translate(x, GH_FLOOR_Y + 0.48, 0.15));
    }
    const out = local(8);
    const box = new Mesh(new RoundedBoxGeometry(0.3, 0.2, 0.22, 2, 0.02).translate(out.x, out.y - 0.12, out.z), mat.black());
    const post = new Mesh(new BoxGeometry(0.05, out.y - 0.22 - GH_FLOOR_Y, 0.05).translate(out.x, GH_FLOOR_Y + (out.y - 0.22 - GH_FLOOR_Y) / 2, out.z), mat.aluminium());
    const lead = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(out.x, out.y - 0.12, out.z - 0.1), new Vector3(0.2, 0.75, 0.0), new Vector3(0, 0.9, -0.05)]), 12, 0.015, 6, false), mat.black());
    group.add(panel, new Mesh(mergeGeometries(legs)!, mat.aluminium()), box, post, lead);
    const sign = label("SOLAR 18 W", 0.36, 0.07, { color: "#f8fafc", background: "#1e3a5f" });
    sign.position.set(out.x, out.y - 0.12, out.z + 0.111);
    group.add(sign);
  } else if (id === "temp-sensor" || id === "light-sensor") {
    // Sensors on stakes: a louvred radiation shield (air) or a light dome, with a live readout.
    const stake = new Mesh(new CylinderGeometry(0.02, 0.02, 1.1, 10).translate(0, GH_FLOOR_Y + 0.55, 0), mat.steel());
    group.add(stake);
    if (id === "temp-sensor") {
      const plates: BufferGeometry[] = [];
      for (let i = 0; i < 5; i += 1) plates.push(new CylinderGeometry(0.13 - i * 0.008, 0.13 - i * 0.008, 0.02, 20).translate(0, GH_FLOOR_Y + 1.12 + i * 0.045, 0));
      group.add(new Mesh(mergeGeometries(plates)!, mat.white()));
    } else {
      group.add(new Mesh(new SphereGeometry(0.08, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, GH_FLOOR_Y + 1.12, 0), new MeshPhysicalMaterial({ name: "light_dome", color: 0xffffff, transparent: true, opacity: 0.6, roughness: 0.1 })));
      group.add(new Mesh(new CylinderGeometry(0.09, 0.09, 0.04, 18).translate(0, GH_FLOOR_Y + 1.1, 0), mat.black()));
    }
    const display = readout(0.42, 0.14);
    display.mesh.position.set(0, GH_FLOOR_Y + 0.92, 0.03);
    group.add(display.mesh);
    visuals.display = display;
  }
  group.userData.ghVisuals = visuals;
  return group;
}

/**
 * The soil probe: a sensor head with a small display on two stainless prongs (pin spacing =
 * a slot's), origin at the slot's socket level; the prongs reach into the soil below it.
 */
export function createSoilProbe(): Group {
  const group = new Group();
  const prongs: BufferGeometry[] = [];
  for (const x of [-PROBE_PIN_SPACING / 2, PROBE_PIN_SPACING / 2]) {
    prongs.push(new CylinderGeometry(0.012, 0.012, 0.34, 10).translate(x, -0.15, 0));
    prongs.push(ConeGeometryLike(0.012, 0.03).translate(x, -0.335, 0));
  }
  const head = new Mesh(new RoundedBoxGeometry(0.34, 0.2, 0.09, 3, 0.03).translate(0, 0.16, 0), mat.black());
  const neck = new Mesh(new BoxGeometry(0.3, 0.06, 0.05).translate(0, 0.03, 0), mat.grey());
  const display = readout(0.26, 0.09);
  display.mesh.position.set(0, 0.18, 0.047);
  const sign = label("SOIL", 0.14, 0.04, { color: "#e2e8f0" });
  sign.position.set(0, 0.105, 0.047);
  group.add(new Mesh(mergeGeometries(prongs)!, mat.steel()), head, neck, display.mesh, sign);
  group.userData.ghVisuals = { display } satisfies FixtureVisuals;
  return group;
}
function ConeGeometryLike(radius: number, height: number): BufferGeometry {
  return new CylinderGeometry(0, radius, height, 10);
}

/** The holder block the probe stands in on the plinth when it is not in a bed. */
export function createProbeHolder(): Mesh {
  const holder = new Mesh(new RoundedBoxGeometry(0.42, 0.12, 0.2, 2, 0.02).translate(PROBE_HOME[0], PLINTH_TOP + 0.06, PROBE_HOME[2]), mat.grey());
  holder.userData.noPick = true;
  return holder;
}

/** The probe's own readout (the probed bed's soil θ, or dashes when it is not in a bed). */
export function showProbeReading(probe: Group, reading: number | null): void {
  const display = (probe.userData.ghVisuals as FixtureVisuals | undefined)?.display;
  display?.draw([reading === null ? "-- %" : `${Math.round(reading * 100)} %`], reading === null ? "off" : reading < 0.3 || reading > 0.9 ? "warn" : "ok");
}

/** Shows a fixture's knob values (valve handles, controller dials) from its props. */
export function showGhFixtureValues(component: Group, props: GhProps | undefined): void {
  const visuals = component.userData.ghVisuals as FixtureVisuals | undefined;
  if (!visuals) return;
  if (visuals.handles && props?.valveA !== undefined && props.valveB !== undefined) {
    // A ball valve: lever along the pipe when open (0°), across when closed (90°).
    visuals.handles.valveA.rotation.y = (1 - props.valveA / 100) * (Math.PI / 2);
    visuals.handles.valveB.rotation.y = (1 - props.valveB / 100) * (Math.PI / 2);
  }
  if (visuals.dials && props?.pumpBelow !== undefined && props.fanAbove !== undefined) {
    const t = (value: number, bound: { min: number; max: number }) => (value - bound.min) / (bound.max - bound.min);
    visuals.dials.pumpBelow.rotation.z = -(-2.4 + 4.8 * t(props.pumpBelow, GH_BOUNDS.pumpBelow));
    visuals.dials.fanAbove.rotation.z = -(-2.4 + 4.8 * t(props.fanAbove, GH_BOUNDS.fanAbove));
  }
}

// ── Hoses and cables ────────────────────────────────────────────────────────────────

/** End fittings along +Y from the port's socket point: sleeve (in the bore), body, strain relief. */
const FIT = { sleeveBottom: -0.11, sleeveTop: 0.01, bodyTop: 0.2, reliefTop: 0.3 };

function hoseFitting(): Group {
  const group = new Group();
  const sleeve = new Mesh(new CylinderGeometry(0.052, 0.052, FIT.sleeveTop - FIT.sleeveBottom, 18).translate(0, (FIT.sleeveTop + FIT.sleeveBottom) / 2, 0), mat.brass());
  const body = new Mesh(new LatheGeometry([new Vector2(0, FIT.sleeveTop), new Vector2(0.085, FIT.sleeveTop), new Vector2(0.095, FIT.sleeveTop + 0.03), new Vector2(0.095, FIT.bodyTop - 0.03), new Vector2(0.08, FIT.bodyTop), new Vector2(0.065, FIT.reliefTop), new Vector2(0, FIT.reliefTop)], 24), mat.brass());
  const grip: BufferGeometry[] = [];
  for (let i = 0; i < 3; i += 1) grip.push(new TorusGeometry(0.097, 0.007, 4, 24).rotateX(Math.PI / 2).translate(0, FIT.sleeveTop + 0.05 + i * 0.04, 0));
  group.add(sleeve, body, new Mesh(mergeGeometries(grip)!, mat.steel()));
  return group;
}
function powerPlug(): Group {
  const group = new Group();
  const pins: BufferGeometry[] = [];
  for (const dx of [-0.022, 0.022]) pins.push(new CylinderGeometry(0.009, 0.009, FIT.sleeveTop - FIT.sleeveBottom, 8).translate(dx, (FIT.sleeveTop + FIT.sleeveBottom) / 2, 0));
  const body = new Mesh(new LatheGeometry([new Vector2(0, FIT.sleeveTop), new Vector2(0.058, FIT.sleeveTop), new Vector2(0.075, FIT.sleeveTop + 0.02), new Vector2(0.078, FIT.bodyTop - 0.02), new Vector2(0.06, FIT.bodyTop), new Vector2(0.035, FIT.reliefTop), new Vector2(0, FIT.reliefTop)], 6), mat.black());
  body.rotation.y = Math.PI / 6;
  const band = new Mesh(new CylinderGeometry(0.08, 0.08, 0.03, 6).translate(0, FIT.bodyTop - 0.06, 0), new MeshStandardMaterial({ name: "plug_band_yellow", color: 0xe2b93b, roughness: 0.5 }));
  band.rotation.y = Math.PI / 6;
  group.add(new Mesh(mergeGeometries(pins)!, mat.brass()), body, band);
  return group;
}

function flowTexture(): CanvasTexture {
  return once("flowTexture", () => {
    const texture = canvasTexture(64, 8, (context, w, h) => {
      context.clearRect(0, 0, w, h);
      context.fillStyle = "rgba(125,211,252,0.95)";
      for (let i = 0; i < 2; i += 1) context.fillRect(i * 32 + 4, 1, 16, h - 2);
    });
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    return texture;
  });
}

export function buildGhLine(group: Group, spec: LineSpec): void {
  const hose = spec.kind === "ghhose";
  const half = LINE_HOME_SPAN / 2;
  group.userData.endpointPositions = [new Vector3(-half, 0, 0), new Vector3(half, 0, 0)];
  const material = hose
    ? new MeshStandardMaterial({ name: "hose_pvc_reinforced", color: spec.color, roughness: 0.42, metalness: 0 })
    : new MeshStandardMaterial({ name: "power_cable_rubber", color: spec.color, roughness: 0.62, metalness: 0 });
  const radius = hose ? 0.055 : 0.03;
  const body = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(-half, 0, 0), new Vector3(half, 0, 0)]), 8, radius, 10, false), material);
  body.userData.flexibleWireBody = true;
  group.userData.wireBody = body;
  group.add(body);
  if (hose) {
    // Water moving in the hose: a band of flow marks on a thin clear sleeve (shown only when the
    // model says water flowed through this hose in the current step).
    const flowMaterial = new MeshBasicMaterial({ name: "hose_flow_marks", map: flowTexture().clone(), transparent: true, depthWrite: false });
    (flowMaterial.map as CanvasTexture).needsUpdate = true;
    const flow = new Mesh(new TubeGeometry(new CatmullRomCurve3([new Vector3(-half, 0, 0), new Vector3(half, 0, 0)]), 8, radius + 0.006, 8, false), flowMaterial);
    flow.visible = false;
    flow.userData.noShadow = true;
    group.add(flow);
    group.userData.flowMesh = flow;
  }
  const fittings: Group[] = [];
  const indicators: Mesh[] = [];
  const hitTargets: Mesh[] = [];
  const faults: Mesh[] = [];
  for (const index of [0, 1] as const) {
    const fitting = hose ? hoseFitting() : powerPlug();
    group.add(fitting);
    fittings.push(fitting);
    const indicator = new Mesh(new RingGeometry(0.15, 0.19, 40).rotateX(-Math.PI / 2), new MeshBasicMaterial({ name: "line_end_selection_ring", color: 0xf59e0b, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
    indicator.visible = false;
    indicator.renderOrder = 3;
    indicator.userData.endpointIndex = index;
    indicator.userData.noShadow = true;
    group.add(indicator);
    indicators.push(indicator);
    const hit = new Mesh(new SphereGeometry(0.15, 14, 10), new MeshBasicMaterial({ transparent: true, opacity: 0.001, depthWrite: false }));
    hit.userData.endpointIndex = index;
    hit.userData.endpointHandle = true;
    hit.userData.noShadow = true;
    group.add(hit);
    hitTargets.push(hit);
    const fault = new Mesh(new TorusGeometry(0.11, 0.02, 8, 24).rotateX(Math.PI / 2), mat.fault());
    fault.visible = false;
    fault.userData.noShadow = true;
    group.add(fault);
    faults.push(fault);
  }
  group.userData.lineFittings = fittings;
  group.userData.endpointIndicators = indicators;
  group.userData.endpointHitTargets = hitTargets;
  group.userData.lineFaults = faults;
  group.userData.restLength = spec.rest;
  group.userData.lineRadius = radius;
  group.userData.wireTips = [];
  group.userData.wireCollars = [];
}

const UP = new Vector3(0, 1, 0);

/**
 * Lays out a hose or cable from its two end positions (line-local): a plugged end stands in its
 * port (sleeve in the bore, fitting upright); a carried end hangs below the hand; a free end lies
 * on the floor or plinth along the line. The body leaves each fitting along its axis and sags with
 * the line's slack.
 */
export function layoutGhLine(group: Group, seated: [boolean, boolean], sway = 0, motion = 0): void {
  group.updateMatrixWorld(true);
  const endpoints = group.userData.endpointPositions as [Vector3, Vector3];
  const fittings = group.userData.lineFittings as Group[];
  const body = group.userData.wireBody as Mesh<TubeGeometry>;
  const indicators = group.userData.endpointIndicators as Mesh[];
  const hits = group.userData.endpointHitTargets as Mesh[];
  const faults = group.userData.lineFaults as Mesh[];
  const rest = Number(group.userData.restLength ?? 2.4);
  const radius = Number(group.userData.lineRadius ?? 0.05);
  const axes: Vector3[] = [];
  const exits: Vector3[] = [];
  for (const index of [0, 1] as const) {
    const point = endpoints[index];
    const other = endpoints[index === 0 ? 1 : 0];
    const fitting = fittings[index];
    let axis: Vector3;
    const carried = !seated[index] && group.position.y + point.y > GH_DRAG_Y - 0.25;
    if (seated[index]) {
      axis = UP.clone();
      fitting.position.copy(point);
    } else if (carried) {
      axis = UP.clone();
      fitting.position.copy(point).addScaledVector(axis, -FIT.sleeveBottom);
    } else {
      axis = new Vector3(other.x - point.x, 0, other.z - point.z);
      if (axis.lengthSq() < 1e-6) axis.set(index === 0 ? 1 : -1, 0, 0);
      axis.normalize();
      fitting.position.copy(point).addScaledVector(axis, -FIT.sleeveBottom);
    }
    fitting.quaternion.copy(new Quaternion().setFromUnitVectors(UP, axis));
    axes.push(axis);
    exits.push(fitting.position.clone().addScaledVector(axis, FIT.reliefTop));
    indicators[index].position.set(point.x, seated[index] ? point.y + 0.03 : point.y - 0.05, point.z);
    hits[index].position.copy(fitting.position).addScaledVector(axis, (FIT.sleeveTop + FIT.bodyTop) / 2);
    faults[index].position.copy(fitting.position).addScaledVector(axis, FIT.bodyTop + 0.02);
    faults[index].quaternion.copy(fitting.quaternion);
  }
  const [a, b] = exits;
  const span = a.distanceTo(b);
  const slack = Math.max(rest - span - 2 * FIT.reliefTop, 0);
  const anySeated = seated[0] || seated[1] || axes.some((axis) => axis.y > 0.5);
  // A plugged line sags to the floor between its ends; a free one curls with its slack.
  const floor = GH_REST_Y - group.position.y;
  const across = new Vector3(b.x - a.x, 0, b.z - a.z);
  const side = new Vector3(-across.z, 0, across.x);
  if (side.lengthSq() > 1e-8) side.normalize();
  const lateral = sway * 0.4 + Math.min(0.55, slack * (anySeated ? 0.12 : 0.22));
  const lead = Math.min(0.32, 0.12 + span * 0.06);
  const sagY = (t: number): number => {
    const straight = a.y + (b.y - a.y) * t;
    if (!anySeated) return Math.max(straight, floor + radius);
    const dip = Math.min(1, slack / Math.max(rest, 0.5)) * 1.4 + 0.05 + motion * 0.06;
    return Math.max(floor + radius, straight - dip * Math.sin(Math.PI * t));
  };
  const mid = (t: number, offset: number): Vector3 => {
    const p = a.clone().lerp(b, t).addScaledVector(side, offset);
    p.y = sagY(t);
    return p;
  };
  const points = [
    a.clone(),
    a.clone().addScaledVector(axes[0], lead),
    mid(0.25, lateral * 0.6),
    mid(0.5, lateral),
    mid(0.75, lateral * 0.6),
    b.clone().addScaledVector(axes[1], lead),
    b.clone(),
  ];
  const curve = new CatmullRomCurve3(points, false, "centripetal");
  group.userData.wireCurve = curve;
  body.geometry.dispose();
  body.geometry = new TubeGeometry(curve, 72, radius, 10, false);
  const flow = group.userData.flowMesh as Mesh<TubeGeometry> | undefined;
  if (flow) {
    flow.geometry.dispose();
    flow.geometry = new TubeGeometry(curve, 72, radius + 0.006, 8, false);
    const map = (flow.material as MeshBasicMaterial).map;
    if (map) map.repeat.set(Math.max(1, Math.round(curve.getLength() * 3)), 1);
  }
}

// ── Showing the model state ─────────────────────────────────────────────────────────

const DRY = new Color(0x9a7b52);
const WET = new Color(0x3a2818);
const SOGGY = new Color(0x221812);
const LEAF_OK = new Color(0x4caf50);
const LEAF_DRY = new Color(0xa3a13a);
const LEAF_SEVERE = new Color(0x8c6a32);
const LEAF_WET = new Color(0x9fb84a);

export interface GhView {
  tank: number;
  tankCapacity: number;
  beds: { A: { theta: number; state: PlantState }; B: { theta: number; state: PlantState } };
  air: number;
  sun: number;
  reading: number | null;
  battery: number;
  pump: PumpState;
  fan: "off" | "running" | "starved";
  channels: { ch1: "pump" | "fan" | null; ch2: "pump" | "fan" | null };
  solarCharging: boolean;
  /** Lines that carried water this step; lines that are wrong (fault collars). */
  flowing: Set<string>;
  lineStatus: Map<string, GhLineStatus>;
  /** Port indices to mark as faulty (e.g. a coupler holding a wrong hose's end). */
  faultPorts: Set<number>;
  modelTime: string;
}

/** Applies a model state to the rig and its fixtures (called when the model time or rig changes). */
export function applyGhView(rig: Group, fixtures: Map<string, Group>, lines: Map<string, Group>, view: GhView): void {
  const visuals = rig.userData.ghVisuals as RigVisuals;
  const fraction = Math.max(0, Math.min(1, view.tank / view.tankCapacity));
  visuals.water.visible = fraction > 0.002;
  visuals.water.scale.y = Math.max(0.001, (TANK.h - 0.1) * fraction);
  visuals.needle.rotation.z = 2.2 - 4.4 * fraction;
  visuals.gauge.draw([`${view.tank.toFixed(1)} L`], fraction < 0.2 ? "warn" : "ok");
  for (const bed of ["A", "B"] as const) {
    const { theta, state } = view.beds[bed];
    const soil = visuals.soil[bed];
    const wet = Math.max(0, Math.min(1, (theta - 0.15) / 0.7));
    soil.color.copy(DRY).lerp(WET, wet);
    if (theta > 0.9) soil.color.lerp(SOGGY, 0.6);
    soil.roughness = theta > 0.9 ? 0.35 : 0.95 - wet * 0.25;
    visuals.puddles[bed].visible = theta > 0.9;
    const leaf = visuals.leafMaterials[bed];
    const target = state === "severe-wilt" ? LEAF_SEVERE : state === "wilting" ? LEAF_DRY : state === "waterlogged" ? LEAF_WET : LEAF_OK;
    leaf.color.copy(target);
    const droop = state === "severe-wilt" ? 1.1 : state === "wilting" ? 0.6 : state === "waterlogged" ? 0.3 : 0;
    const curl = state === "heat-stressed" ? 0.55 : 1;
    posePlants(visuals.plants[bed], droop, curl, state === "severe-wilt" ? 0.86 : 1);
  }
  for (const collar of visuals.faultCollars) collar.visible = false;
  for (const port of view.faultPorts) if (visuals.faultCollars[port]) visuals.faultCollars[port].visible = true;
  // Fixtures.
  const pump = fixtures.get("water-pump")?.userData.ghVisuals as FixtureVisuals | undefined;
  if (pump?.led) {
    const running = view.pump === "running" || view.pump === "tank-ran-out";
    const dry = view.pump === "dry-no-supply" || view.pump === "dry-tank-empty" || view.pump === "dead-headed";
    pump.led.emissive.setHex(dry ? 0xf59e0b : 0x22c55e);
    pump.led.emissiveIntensity = running || dry ? 2 : 0;
    pump.rotor!.userData.spinning = running || dry;
  }
  const fan = fixtures.get("vent-fan")?.userData.ghVisuals as FixtureVisuals | undefined;
  if (fan?.rotor) fan.rotor.userData.spinning = view.fan === "running";
  const controller = fixtures.get("farm-controller")?.userData.ghVisuals as FixtureVisuals | undefined;
  if (controller?.leds && controller.display) {
    for (const ch of ["ch1", "ch2"] as const) {
      const load = view.channels[ch];
      const state = load === "pump" ? (view.pump === "starved" ? "starved" : view.pump === "off" ? "off" : "on") : load === "fan" ? (view.fan === "starved" ? "starved" : view.fan === "off" ? "off" : "on") : "off";
      controller.leds[ch].emissive.setHex(state === "starved" ? 0xef4444 : 0x22c55e);
      controller.leds[ch].emissiveIntensity = state === "off" ? 0 : 2;
    }
    controller.leds.solar.emissiveIntensity = view.solarCharging ? 1.8 : 0;
    controller.leds.battery.emissiveIntensity = 0.4 + 1.6 * Math.min(1, view.battery / 12);
    controller.display.draw([
      `${view.modelTime}  AIR ${view.air.toFixed(1)}C`,
      `SOIL ${view.reading === null ? "--" : `${Math.round(view.reading * 100)}%`}  BAT ${view.battery.toFixed(1)}Wh`,
    ], view.pump === "starved" || view.fan === "starved" ? "warn" : "ok");
  }
  const temp = fixtures.get("temp-sensor")?.userData.ghVisuals as FixtureVisuals | undefined;
  temp?.display?.draw([`AIR ${view.air.toFixed(1)} C`], view.air > 35 ? "warn" : "ok");
  const light = fixtures.get("light-sensor")?.userData.ghVisuals as FixtureVisuals | undefined;
  light?.display?.draw([`SUN ${Math.round(view.sun * 100)} %`], view.sun > 0 ? "ok" : "off");
  // Lines: water moving, fault collars on wrong ones.
  for (const [id, line] of lines) {
    const flow = line.userData.flowMesh as Mesh | undefined;
    if (flow) flow.visible = view.flowing.has(id);
    const status = view.lineStatus.get(id);
    const wrong = status === "out-out" || status === "in-in" || status === "no-pump" || status === "loop" || status === "unregulated" || status === "wrong-type" || status === "shared-port";
    const loose = status === "loose";
    const sockets = line.userData.sockets as [number | null, number | null] | null;
    for (const index of [0, 1] as const) {
      const fault = (line.userData.lineFaults as Mesh[])[index];
      fault.visible = wrong || (loose && sockets?.[index] !== null && sockets?.[index] !== undefined);
    }
  }
}

/** Per-frame motion that follows the model: the fan and pump turn only while they run; water marks move. */
export function animateGh(fixtures: Map<string, Group>, lines: Map<string, Group>, delta: number): void {
  const fan = (fixtures.get("vent-fan")?.userData.ghVisuals as FixtureVisuals | undefined)?.rotor;
  if (fan?.userData.spinning) fan.rotation.x += delta * 14;
  const pump = (fixtures.get("water-pump")?.userData.ghVisuals as FixtureVisuals | undefined)?.rotor;
  if (pump?.userData.spinning) pump.rotation.x += delta * 20;
  for (const line of lines.values()) {
    const flow = line.userData.flowMesh as Mesh | undefined;
    if (!flow?.visible) continue;
    const map = (flow.material as MeshBasicMaterial).map;
    if (map) map.offset.x -= delta * 0.6;
  }
}

/** Which fixture control (valve handle, controller dial) a mesh belongs to, if any. */
export function ghControlOf(object: { userData: Record<string, unknown>; parent: unknown } | null): string | null {
  let node = object as { userData: Record<string, unknown>; parent: unknown } | null;
  while (node && node.userData.ghControl === undefined) node = node.parent as typeof node;
  return (node?.userData.ghControl as string | undefined) ?? null;
}

export type { Material };
