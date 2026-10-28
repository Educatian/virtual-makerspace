/**
 * Procedural, original 3D models for the Circuit Bench (no external assets).
 *
 * Scale: the breadboard pitch is 0.24 scene units = 2.54 mm, so 1 unit ≈ 10.6 mm. LEDs, the
 * resistor, jumper wires, holes and contacts are modeled at that scale (a 5 mm LED is 0.47
 * units across). The 9 V battery is the one deliberate exception: drawn at 25 % so it does not
 * bury a 16-column mini breadboard; it stands in a slim vertical PCB-mount clip (one row deep)
 * whose pins are the battery's two sockets, with its shell above resistor height.
 *
 * Geometry and materials are shared between instances; the 192 holes, their walls and their
 * contact springs are three instanced meshes. Every visible lead, pin and hole is placed from
 * the same socket coordinates the scene uses for picking and snapping.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CurvePath,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LatheGeometry,
  LineCurve3,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  QuadraticBezierCurve3,
  RepeatWrapping,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  TubeGeometry,
  Vector2,
  Vector3,
  AdditiveBlending,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { resistorBands, type BandColor, type PartProps } from "../circuit/part-props.ts";

/** Board top surface (world y). Sockets sit 0.015 above it, at BOARD_TOP + 0.015. */
export const BOARD_SURFACE = 0.302;
/** Floor of each hole (world y): leads and wire tips stop here. */
export const HOLE_FLOOR = 0.236;
const HOLE = 0.078;

const cache = new Map<string, unknown>();
function once<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

// ── Shared PBR palette ───────────────────────────────────────────────────────────────

export const palette = {
  tinnedLead: () => once("m:lead", () => new MeshStandardMaterial({ name: "tinned_lead", color: 0xd4d8de, metalness: 1, roughness: 0.3 })),
  nickel: () => once("m:nickel", () => new MeshStandardMaterial({ name: "nickel_contact", color: 0xa9aeb4, metalness: 1, roughness: 0.42 })),
  darkPlastic: () => once("m:dark", () => new MeshStandardMaterial({ name: "plastic_dark", color: 0x1b1d21, metalness: 0, roughness: 0.62 })),
  cavity: () => once("m:cavity", () => new MeshStandardMaterial({ name: "hole_cavity", color: 0x24242a, metalness: 0, roughness: 0.9 })),
  holeWall: () => once("m:wall", () => new MeshStandardMaterial({ name: "hole_wall", color: 0x4d4a45, metalness: 0, roughness: 0.9, side: DoubleSide })),
  boardPlastic: () => once("m:board", () => new MeshStandardMaterial({ name: "breadboard_abs", color: 0xe9e4d8, metalness: 0, roughness: 0.66 })),
  trench: () => once("m:trench", () => new MeshStandardMaterial({ name: "breadboard_trench", color: 0xcfc8b9, metalness: 0, roughness: 0.75, side: DoubleSide })),
};

// ── Canvas textures ──────────────────────────────────────────────────────────────────

function canvasTexture(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) draw(context);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Soft radial falloff used for contact shadows under parts. */
export function contactShadowTexture(): Texture {
  return once("t:contact", () =>
    canvasTexture(128, 128, (context) => {
      const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 62);
      gradient.addColorStop(0, "rgba(0,0,0,0.85)");
      gradient.addColorStop(0.45, "rgba(0,0,0,0.42)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 128, 128);
    }),
  );
}

/** A soft, darkening ellipse just above the board under a part (follows it, hidden off-board). */
export function createContactShadow(width: number, depth: number, localY: number, strength = 0.42): Mesh {
  const material = new MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, opacity: strength, depthWrite: false, color: 0x000000 });
  material.name = "contact_shadow";
  const mesh = new Mesh(once("g:shadowPlane", () => new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), material);
  mesh.scale.set(width, 1, depth);
  mesh.position.y = localY;
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.contactShadow = true;
  mesh.userData.noPick = true;
  return mesh;
}

// ── Breadboard ───────────────────────────────────────────────────────────────────────

export interface BreadboardLayout {
  /** Board center x (world). */
  centerX: number;
  /** Socket x offsets from the board center, one per column. */
  columns: number[];
  /** Socket z per row (row 0 = + rail, last = − rail). */
  rows: number[];
}

const BOARD_W = 4.25;
const BOARD_D = 3.7;
const OPEN_X = 2.0;
const OPEN_Z = 1.74;
const TRENCH_HALF = 0.075;

export function createBreadboard(layout: BreadboardLayout): Group {
  const board = new Group();
  board.name = "breadboard";
  board.position.x = layout.centerX;

  // Body: a rounded frame (sides + bevelled rim) around the open hole field.
  const outline = roundedRect(BOARD_W / 2 - 0.03, BOARD_D / 2 - 0.03, 0.09);
  const opening = new Shape();
  opening.moveTo(-OPEN_X, -OPEN_Z);
  opening.lineTo(OPEN_X, -OPEN_Z);
  opening.lineTo(OPEN_X, OPEN_Z);
  opening.lineTo(-OPEN_X, OPEN_Z);
  opening.lineTo(-OPEN_X, -OPEN_Z);
  outline.holes.push(opening);
  const frameGeometry = new ExtrudeGeometry(outline, { depth: BOARD_SURFACE - 0.06, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 3, curveSegments: 8 });
  frameGeometry.rotateX(-Math.PI / 2);
  frameGeometry.translate(0, 0.03, 0);
  const frame = new Mesh(frameGeometry, palette.boardPlastic());
  frame.name = "breadboard_frame";
  frame.castShadow = true;
  frame.receiveShadow = true;
  board.add(frame);

  // Printed top skin with real cut-outs for the holes and trench.
  const skinTexture = breadboardSkin(layout);
  const skin = new Mesh(
    new PlaneGeometry(BOARD_W - 0.06, BOARD_D - 0.06).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ name: "breadboard_print", map: skinTexture, alphaTest: 0.5, roughness: 0.64, metalness: 0 }),
  );
  skin.position.y = BOARD_SURFACE;
  skin.receiveShadow = true;
  skin.name = "breadboard_skin";
  board.add(skin);

  // What you see through a hole: dark cavity floor, the hole's walls, and the spring contact.
  for (const [zMin, zMax] of [[-OPEN_Z, -TRENCH_HALF], [TRENCH_HALF, OPEN_Z]] as const) {
    const floor = new Mesh(new PlaneGeometry(OPEN_X * 2, zMax - zMin).rotateX(-Math.PI / 2), palette.cavity());
    floor.position.set(0, HOLE_FLOOR, (zMin + zMax) / 2);
    floor.receiveShadow = false;
    board.add(floor);
  }
  const count = layout.columns.length * layout.rows.length;
  const walls = new InstancedMesh(holeWallGeometry(), palette.holeWall(), count);
  const contacts = new InstancedMesh(contactGeometry(), palette.nickel(), count);
  walls.name = "breadboard_hole_walls";
  contacts.name = "breadboard_contacts";
  const dummy = new Object3D();
  let index = 0;
  for (const z of layout.rows) {
    for (const x of layout.columns) {
      dummy.position.set(x, 0, z);
      dummy.updateMatrix();
      walls.setMatrixAt(index, dummy.matrix);
      contacts.setMatrixAt(index, dummy.matrix);
      index += 1;
    }
  }
  walls.instanceMatrix.needsUpdate = true;
  contacts.instanceMatrix.needsUpdate = true;
  board.add(walls, contacts);

  // Center trench: a real groove, same plastic as the board.
  const trenchFloor = new PlaneGeometry(OPEN_X * 2 - 0.1, TRENCH_HALF * 2).rotateX(-Math.PI / 2).translate(0, 0.17, 0);
  const wallA = new PlaneGeometry(OPEN_X * 2 - 0.1, BOARD_SURFACE - 0.17).translate(0, (BOARD_SURFACE + 0.17) / 2, -TRENCH_HALF);
  const wallB = wallA.clone().translate(0, 0, TRENCH_HALF * 2);
  const endA = new PlaneGeometry(TRENCH_HALF * 2, BOARD_SURFACE - 0.17).rotateY(Math.PI / 2).translate(-(OPEN_X - 0.05), (BOARD_SURFACE + 0.17) / 2, 0);
  const endB = endA.clone().translate((OPEN_X - 0.05) * 2, 0, 0);
  const trench = new Mesh(mergeGeometries([trenchFloor, wallA, wallB, endA, endB]), palette.trench());
  trench.name = "breadboard_trench";
  board.add(trench);
  return board;
}

function roundedRect(halfW: number, halfH: number, radius: number): Shape {
  const shape = new Shape();
  shape.moveTo(-halfW + radius, -halfH);
  shape.lineTo(halfW - radius, -halfH);
  shape.quadraticCurveTo(halfW, -halfH, halfW, -halfH + radius);
  shape.lineTo(halfW, halfH - radius);
  shape.quadraticCurveTo(halfW, halfH, halfW - radius, halfH);
  shape.lineTo(-halfW + radius, halfH);
  shape.quadraticCurveTo(-halfW, halfH, -halfW, halfH - radius);
  shape.lineTo(-halfW, -halfH + radius);
  shape.quadraticCurveTo(-halfW, -halfH, -halfW + radius, -halfH);
  return shape;
}

/** Four inward-facing walls of a square hole, from the floor to the surface. */
function holeWallGeometry(): BufferGeometry {
  return once("g:holeWall", () => {
    const h = HOLE / 2;
    const top = BOARD_SURFACE - 0.001;
    const bottom = HOLE_FLOOR;
    const quads = [
      [[-h, -h], [h, -h]],
      [[h, -h], [h, h]],
      [[h, h], [-h, h]],
      [[-h, h], [-h, -h]],
    ];
    const positions: number[] = [];
    for (const [[x1, z1], [x2, z2]] of quads) {
      positions.push(x1, bottom, z1, x2, bottom, z2, x2, top, z2, x1, bottom, z1, x2, top, z2, x1, top, z1);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
  });
}

/** Two nickel spring leaves on either side of a hole, as a breadboard clip shows from above. */
function contactGeometry(): BufferGeometry {
  return once("g:contact", () => {
    const leafA = new BoxGeometry(0.012, 0.05, HOLE * 0.8).translate(-0.024, HOLE_FLOOR + 0.03, 0);
    const leafB = new BoxGeometry(0.012, 0.05, HOLE * 0.8).translate(0.024, HOLE_FLOOR + 0.03, 0);
    return mergeGeometries([leafA, leafB]);
  });
}

function breadboardSkin(layout: BreadboardLayout): CanvasTexture {
  const width = 2048;
  const height = Math.round((width * (BOARD_D - 0.06)) / (BOARD_W - 0.06));
  const scale = width / (BOARD_W - 0.06);
  const px = (x: number): number => (x + (BOARD_W - 0.06) / 2) * scale;
  const pz = (z: number): number => (z + (BOARD_D - 0.06) / 2) * scale;
  return canvasTexture(width, height, (context) => {
    const base = context.createLinearGradient(0, 0, 0, height);
    base.addColorStop(0, "#f1ede4");
    base.addColorStop(1, "#e7e2d6");
    context.fillStyle = base;
    context.fillRect(0, 0, width, height);
    // Faint moulding texture so the plastic is not a flat sheet.
    for (let i = 0; i < 2400; i += 1) {
      context.fillStyle = `rgba(120, 110, 90, ${Math.random() * 0.025})`;
      context.fillRect(Math.random() * width, Math.random() * height, 2, 2);
    }
    const rows = layout.rows;
    const top = rows[0];
    const bottom = rows[rows.length - 1];
    const firstMain = rows[1];
    const lastMain = rows[rows.length - 2];
    const xMin = layout.columns[0] - 0.12;
    const xMax = layout.columns[layout.columns.length - 1] + 0.12;
    // Rail polarity stripes and marks (top rail +, bottom rail −).
    const stripe = (z: number, color: string): void => {
      context.fillStyle = color;
      context.fillRect(px(xMin), pz(z) - 3, px(xMax) - px(xMin), 6);
    };
    stripe((top + firstMain) / 2 - 0.07, "#d6453d");
    stripe((bottom + lastMain) / 2 + 0.07, "#2f6fd0");
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `700 ${Math.round(0.15 * scale)}px Inter, system-ui, sans-serif`;
    for (const x of [xMin - 0.1, xMax + 0.1]) {
      context.fillStyle = "#d6453d";
      context.fillText("+", px(x), pz(top));
      context.fillStyle = "#2f6fd0";
      context.fillText("−", px(x), pz(bottom));
    }
    // Column numbers above row a and below row j; row letters at both ends.
    context.fillStyle = "#6c6a66";
    context.font = `600 ${Math.round(0.085 * scale)}px Inter, system-ui, sans-serif`;
    layout.columns.forEach((x, index) => {
      if ((index + 1) % 1 !== 0) return;
      context.fillText(String(index + 1), px(x), pz(firstMain - 0.17));
      context.fillText(String(index + 1), px(x), pz(lastMain + 0.17));
    });
    const letters = "abcdefghij";
    rows.slice(1, -1).forEach((z, index) => {
      context.fillText(letters[index], px(xMin - 0.1), pz(z));
      context.fillText(letters[index], px(xMax + 0.1), pz(z));
    });
    // Holes: chamfer ring, then a true cut-out (alpha 0).
    const half = (HOLE / 2) * scale;
    for (const z of rows) {
      for (const x of layout.columns) {
        const cx = px(x);
        const cz = pz(z);
        context.fillStyle = "rgba(90, 80, 64, 0.28)";
        roundedSquare(context, cx, cz, half + 5, 5);
        context.fill();
        context.fillStyle = "rgba(255, 255, 255, 0.5)";
        context.fillRect(cx - half - 4, cz + half + 2, (half + 4) * 2, 2);
        context.save();
        context.globalCompositeOperation = "destination-out";
        roundedSquare(context, cx, cz, half, 3);
        context.fill();
        context.restore();
      }
    }
    // Trench cut-out.
    context.save();
    context.globalCompositeOperation = "destination-out";
    context.fillRect(px(-OPEN_X + 0.05), pz(-TRENCH_HALF), px(OPEN_X - 0.05) - px(-OPEN_X + 0.05), TRENCH_HALF * 2 * scale);
    context.restore();
  });
}

function roundedSquare(context: CanvasRenderingContext2D, cx: number, cy: number, half: number, radius: number): void {
  context.beginPath();
  context.roundRect(cx - half, cy - half, half * 2, half * 2, radius);
}

// ── Leads ────────────────────────────────────────────────────────────────────────────

/** A straight vertical lead from `top` down to `bottom` (component-local y), at x/z. */
function straightLead(x: number, top: number, bottom: number, radius = 0.022, z = 0): Mesh {
  const geometry = once(`g:lead:${radius}`, () => new CylinderGeometry(radius, radius, 1, 10));
  const lead = new Mesh(geometry, palette.tinnedLead());
  lead.scale.y = top - bottom;
  lead.position.set(x, (top + bottom) / 2, z);
  return lead;
}

/** Axial lead: out of the body end, a rounded 90° bend, then straight down into the hole. */
function axialLead(fromX: number, toX: number, y: number, bottom: number, radius = 0.022): Mesh {
  const direction = Math.sign(toX - fromX);
  const bend = 0.05;
  const path = new CurvePath<Vector3>();
  path.add(new LineCurve3(new Vector3(fromX, y, 0), new Vector3(toX - direction * bend, y, 0)));
  path.add(new QuadraticBezierCurve3(new Vector3(toX - direction * bend, y, 0), new Vector3(toX, y, 0), new Vector3(toX, y - bend, 0)));
  path.add(new LineCurve3(new Vector3(toX, y - bend, 0), new Vector3(toX, bottom, 0)));
  return new Mesh(new TubeGeometry(path, 40, radius, 8, false), palette.tinnedLead());
}

// ── LED (5 mm through-hole) ─────────────────────────────────────────────────────────────

export interface LedModelOptions {
  /** Resin tint. */
  color: number;
  /** Distance between the two leads (one pitch). */
  leadSeparation: number;
  /** Board surface in component-local y when seated. */
  surfaceY: number;
}

export function createLedModel(options: LedModelOptions): Group {
  const group = new Group();
  group.name = "led_5mm";
  const { color, leadSeparation, surfaceY } = options;
  const r = 0.236;
  const flangeR = 0.274;
  const base = surfaceY + 0.1; // ~1 mm standoff above the board
  const flangeTop = base + 0.095;
  const bodyTop = flangeTop + 0.4;
  const leadBottom = HOLE_FLOOR - 0.48 + 0.004; // component sits at DRAG_Y 0.48

  // Resin: cylinder + hemispherical dome as one smooth lathe.
  const profile: Vector2[] = [new Vector2(0.0001, flangeTop)];
  profile.push(new Vector2(r * 0.985, flangeTop), new Vector2(r, flangeTop + 0.01), new Vector2(r, bodyTop));
  for (let i = 1; i <= 14; i += 1) {
    const angle = (i / 14) * (Math.PI / 2);
    profile.push(new Vector2(Math.max(0.0001, Math.cos(angle) * r), bodyTop + Math.sin(angle) * r));
  }
  const tint = new Color(color);
  // Saturated, slightly dark resin so the tint survives tone mapping lit or unlit.
  const resinColor = tint.clone().multiplyScalar(0.62);
  const resin = new MeshPhysicalMaterial({
    name: "led_resin",
    color: resinColor,
    emissive: tint.clone().multiplyScalar(0.85),
    emissiveIntensity: 0,
    transparent: true,
    opacity: 0.6,
    roughness: 0.1,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    ior: 1.5,
    depthWrite: false,
  });
  const dome = new Mesh(new LatheGeometry(profile, 40), resin);
  dome.name = "led_resin";
  dome.renderOrder = 2;
  dome.castShadow = true;
  group.add(dome);

  // Flange with the cathode flat on lead B's side (+x).
  const flangeGeometry = once("g:ledFlange", () => {
    const geometry = new CylinderGeometry(flangeR, flangeR, 0.095, 40, 1);
    const position = geometry.getAttribute("position");
    const flatX = flangeR * 0.82;
    for (let i = 0; i < position.count; i += 1) {
      if (position.getX(i) > flatX) position.setX(i, flatX);
    }
    geometry.computeVertexNormals();
    return geometry;
  });
  const flangeMaterial = resin.clone();
  flangeMaterial.opacity = 0.72;
  const flange = new Mesh(flangeGeometry, flangeMaterial);
  flange.position.y = base + 0.0475;
  flange.name = "led_flange";
  group.add(flange);

  // Internal frame: thin anode post (lead A, −x) and the wider cathode anvil with its cup (+x).
  const half = leadSeparation / 2;
  const internals = palette.tinnedLead();
  const post = new Mesh(new BoxGeometry(0.03, 0.36, 0.022), internals);
  post.position.set(-half * 0.55, flangeTop + 0.17, 0);
  group.add(post);
  const anvil = new Mesh(new BoxGeometry(0.08, 0.3, 0.025), internals);
  anvil.position.set(half * 0.5, flangeTop + 0.14, 0);
  group.add(anvil);
  const cup = new Mesh(new CylinderGeometry(0.045, 0.03, 0.04, 16), internals);
  cup.position.set(half * 0.42, flangeTop + 0.31, 0);
  group.add(cup);
  const wire = new Mesh(new CylinderGeometry(0.004, 0.004, 0.13, 6), internals);
  wire.rotation.z = Math.PI / 2.6;
  wire.position.set(-half * 0.05, flangeTop + 0.36, 0);
  group.add(wire);

  // The die: a small core that glows with the computed current (additive, no bloom).
  const core = new Mesh(
    new SphereGeometry(0.028, 16, 12),
    new MeshBasicMaterial({ color: tint.clone().lerp(new Color(0xffffff), 0.12), transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }),
  );
  core.position.set(half * 0.42, flangeTop + 0.34, 0);
  core.visible = false;
  core.renderOrder = 3;
  group.add(core);

  // Leads: anode (A) at −x, cathode (B) at +x; seated, both stop at the hole floor.
  group.add(straightLead(-half, base, leadBottom), straightLead(half, base, leadBottom));

  // Burnt-out look: a dark, smoky inner haze.
  const scorchMaterial = new MeshStandardMaterial({ color: 0x1a0f0a, transparent: true, opacity: 0, roughness: 1, depthWrite: false });
  const scorch = new Mesh(new SphereGeometry(r * 0.8, 20, 14), scorchMaterial);
  scorch.position.y = bodyTop - 0.05;
  scorch.scale.y = 1.5;
  scorch.renderOrder = 1;
  group.add(scorch);

  const glow = new PointLight(color, 0, 2.6, 1.8);
  glow.position.set(0, bodyTop, 0);
  glow.castShadow = false;
  group.add(glow);

  group.add(createContactShadow(0.85, 0.75, surfaceY + 0.004, 0.38));
  group.userData.glowMaterials = [resin, flangeMaterial];
  group.userData.ledCore = core;
  group.userData.glowLight = glow;
  group.userData.scorchMaterial = scorchMaterial;
  return group;
}

// ── Resistor (¼ W axial) ─────────────────────────────────────────────────────────────────

const BAND_HEX: Record<BandColor, string> = {
  black: "#141414",
  brown: "#6b3a1f",
  red: "#c4231b",
  orange: "#e3701a",
  yellow: "#f1c91c",
  green: "#2e8b3a",
  blue: "#2457c5",
  violet: "#7b3fb5",
  grey: "#8b8b8b",
  white: "#f2f2f2",
  gold: "#c9a246",
  silver: "#c0c4c8",
};
const DIGITS: BandColor[] = ["black", "brown", "red", "orange", "yellow", "green", "blue", "violet", "grey", "white"];

/**
 * Bands for a value: four bands (carbon film, beige) when two digits express it exactly,
 * otherwise five bands (metal film, blue: three digits, multiplier, 1 % brown tolerance).
 */
export function bandsFor(ohms: number): { bands: BandColor[]; film: "carbon" | "metal" } {
  const four = resistorBands(ohms);
  if (four) return { bands: four, film: "carbon" };
  const exponent = Math.floor(Math.log10(ohms)) - 2;
  const digits = Math.round(ohms / 10 ** exponent);
  const multiplier: BandColor = exponent === -1 ? "gold" : exponent === -2 ? "silver" : DIGITS[Math.max(0, Math.min(9, exponent))];
  return {
    bands: [DIGITS[Math.floor(digits / 100) % 10], DIGITS[Math.floor(digits / 10) % 10], DIGITS[digits % 10], multiplier, "brown"],
    film: "metal",
  };
}

function resistorTexture(ohms: number): CanvasTexture {
  const { bands, film } = bandsFor(ohms);
  // v runs along the body from lead A (bottom of the canvas) to lead B (top).
  return canvasTexture(32, 512, (context) => {
    const body = film === "carbon" ? ["#c9a87a", "#d8bf95", "#c9a87a"] : ["#4f7fc0", "#6f9bd6", "#4f7fc0"];
    const gradient = context.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, body[0]);
    gradient.addColorStop(0.5, body[1]);
    gradient.addColorStop(1, body[2]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 512);
    const positions = bands.length === 4 ? [0.27, 0.37, 0.47, 0.76] : [0.24, 0.33, 0.42, 0.51, 0.77];
    const width = 0.055;
    bands.forEach((band, index) => {
      const v = positions[index];
      context.fillStyle = BAND_HEX[band];
      context.fillRect(0, (1 - v - width / 2) * 512, 32, width * 512);
    });
  });
}

export interface ResistorModelOptions {
  ohms: number;
  leadSeparation: number;
  surfaceY: number;
}

export function createResistorModel(options: ResistorModelOptions): Group {
  const group = new Group();
  group.name = "resistor_axial";
  const { leadSeparation, surfaceY } = options;
  const length = 0.6;
  const capR = 0.118;
  const midR = 0.103;
  const axisY = surfaceY + 0.07 + capR;
  const leadBottom = HOLE_FLOOR - 0.48 + 0.004;

  // Body profile along y (later turned to lie along x): bulged end caps, slimmer middle.
  const profile = once("g:resistorProfile", () => {
    const points: Vector2[] = [];
    const half = length / 2;
    const steps = 48;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const y = -half + t * length;
      const edge = Math.min(t, 1 - t) * length; // distance from nearest end
      let radius: number;
      if (edge < 0.035) radius = capR * Math.sqrt(Math.max(0, 1 - ((0.035 - edge) / 0.035) ** 2)) * 0.92 + capR * 0.08;
      else if (edge < 0.13) radius = capR;
      else if (edge < 0.17) radius = capR - (capR - midR) * ((edge - 0.13) / 0.04);
      else radius = midR;
      points.push(new Vector2(Math.max(0.012, radius), y));
    }
    return new LatheGeometry(points, 36);
  });
  const material = new MeshStandardMaterial({ name: "resistor_body", map: resistorTexture(options.ohms), roughness: 0.5, metalness: 0 });
  material.map!.wrapS = RepeatWrapping;
  const body = new Mesh(profile, material);
  body.rotation.z = -Math.PI / 2; // lathe +y → +x, so the texture's v runs from lead A (−x) to lead B
  body.position.y = axisY;
  body.name = "resistor_body";
  body.castShadow = true;
  group.add(body);

  const half = leadSeparation / 2;
  group.add(axialLead(-length / 2 + 0.01, -half, axisY, leadBottom), axialLead(length / 2 - 0.01, half, axisY, leadBottom));
  group.add(createContactShadow(0.9, 0.42, surfaceY + 0.004, 0.36));
  group.userData.refreshAppearance = (props: PartProps) => {
    if (!props.ohms || props.ohms === group.userData.shownOhms) return;
    group.userData.shownOhms = props.ohms;
    const previous = material.map;
    material.map = resistorTexture(props.ohms);
    material.map.wrapS = RepeatWrapping;
    material.needsUpdate = true;
    previous?.dispose();
  };
  group.userData.shownOhms = options.ohms;
  return group;
}

// ── 9 V battery in a PCB-mount holder ─────────────────────────────────────────────────────

function batteryLabel(volts: number): CanvasTexture {
  // Canvas matches the shell's front face (0.663 × 1.213), so the print is not stretched.
  return canvasTexture(512, 936, (context) => {
    const gradient = context.createLinearGradient(0, 0, 512, 0);
    gradient.addColorStop(0, "#1c1f24");
    gradient.addColorStop(0.5, "#2b2f37");
    gradient.addColorStop(1, "#1c1f24");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 512, 936);
    context.fillStyle = "#c3cad3";
    context.fillRect(0, 96, 512, 14);
    context.fillRect(0, 830, 512, 6);
    context.textAlign = "center";
    context.textBaseline = "middle";
    // Polarity marks under each terminal (+ over lead A, on the left seen from the front).
    context.font = "800 96px Inter, system-ui, sans-serif";
    context.fillStyle = "#ff6b5e";
    context.fillText("+", 133, 200);
    context.fillStyle = "#8db7ff";
    context.fillText("−", 379, 200);
    context.fillStyle = "#e9eef5";
    context.font = "800 200px Inter, system-ui, sans-serif";
    context.fillText(`${Number.isInteger(volts) ? volts : volts.toFixed(1)}V`, 256, 470);
    context.font = "600 38px Inter, system-ui, sans-serif";
    context.fillStyle = "#9aa4b1";
    context.fillText("ALKALINE", 256, 640);
    context.fillText("6LR61 TYPE", 256, 692);
  });
}

export interface BatteryModelOptions {
  volts: number;
  leadSeparation: number;
  surfaceY: number;
}

export function createBatteryModel(options: BatteryModelOptions): Group {
  const group = new Group();
  group.name = "battery_9v";
  const { leadSeparation, surfaceY } = options;
  const half = leadSeparation / 2;
  // 26.5 × 17.5 × 48.5 mm at 25 % scale. The battery stands in a vertical PCB-mount clip whose
  // footprint is one row deep, and its shell starts above resistor height, so parts in the
  // neighbouring rows stay clear of it.
  const width = 0.663;
  const depth = 0.438;
  const height = 1.213;
  const holderBase = surfaceY + 0.03;
  const holderHeight = 0.3;
  const holderDepth = 0.2;
  const bottom = holderBase + holderHeight;
  const leadBottom = HOLE_FLOOR - 0.48 + 0.004;
  const terminalX = width * 0.24;

  // Clip: a slim dark base on the two pins, with nickel spring arms that hold the shell.
  const holder = new Mesh(new RoundedBoxGeometry(leadSeparation + 0.2, holderHeight, holderDepth, 3, 0.03), palette.darkPlastic());
  holder.position.y = holderBase + holderHeight / 2;
  holder.castShadow = true;
  group.add(holder);
  for (const x of [-(width / 2 + 0.012), width / 2 + 0.012]) {
    const arm = new Mesh(new BoxGeometry(0.018, 0.34, 0.14), palette.nickel());
    arm.position.set(x, bottom + 0.1, 0);
    group.add(arm);
  }
  group.add(straightLead(-half, holderBase + 0.02, leadBottom, 0.026), straightLead(half, holderBase + 0.02, leadBottom, 0.026));

  // Shell: label on the front, graphite sides, metal top.
  const label = batteryLabel(options.volts);
  const front = new MeshPhysicalMaterial({ name: "battery_label", map: label, roughness: 0.42, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.35 });
  const side = new MeshPhysicalMaterial({ name: "battery_shell", color: 0x23272d, roughness: 0.48, metalness: 0.15, clearcoat: 0.5, clearcoatRoughness: 0.4 });
  const topMetal = new MeshStandardMaterial({ name: "battery_top", color: 0xb9bec5, roughness: 0.34, metalness: 1 });
  const shell = new Mesh(new RoundedBoxGeometry(width, height, depth, 4, 0.05), [side, side, topMetal, side, front, side]);
  shell.position.y = bottom + height / 2;
  shell.castShadow = true;
  shell.name = "battery_shell";
  group.add(shell);

  // Snap terminals: round male + over lead A, hexagonal female − over lead B.
  const top = bottom + height;
  const positive = new Group();
  const stud = new Mesh(new CylinderGeometry(0.055, 0.055, 0.05, 28), palette.nickel());
  stud.position.y = 0.025;
  const neck = new Mesh(new CylinderGeometry(0.042, 0.05, 0.025, 28), palette.nickel());
  neck.position.y = 0.062;
  const crown = new Mesh(new SphereGeometry(0.055, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), palette.nickel());
  crown.position.y = 0.074;
  crown.scale.y = 0.5;
  positive.add(stud, neck, crown);
  positive.position.set(-terminalX, top, 0);
  const negative = new Group();
  const hex = new Mesh(new CylinderGeometry(0.085, 0.085, 0.065, 6), palette.nickel());
  hex.position.y = 0.0325;
  const socket = new Mesh(new CylinderGeometry(0.045, 0.045, 0.012, 24), palette.darkPlastic());
  socket.position.y = 0.066;
  negative.add(hex, socket);
  negative.position.set(terminalX, top, 0);
  group.add(positive, negative);

  group.add(createContactShadow(1.05, 0.55, surfaceY + 0.004, 0.5));
  group.userData.refreshAppearance = (props: PartProps) => {
    if (!props.volts || props.volts === group.userData.shownVolts) return;
    group.userData.shownVolts = props.volts;
    const previous = front.map;
    front.map = batteryLabel(props.volts);
    front.needsUpdate = true;
    previous?.dispose();
  };
  group.userData.shownVolts = options.volts;
  return group;
}

// ── Snapino silkscreen ────────────────────────────────────────────────────────────────

/**
 * Silkscreen for the Nano-style module on the Snapino carrier: pin names and an explicit note
 * that the bench runs block programs only — it does not emulate the AVR microcontroller.
 */
export function createSnapinoSilkscreen(width: number, depth: number): Mesh {
  const texture = canvasTexture(1024, Math.round((1024 * depth) / width), (context) => {
    const w = context.canvas.width;
    const h = context.canvas.height;
    context.clearRect(0, 0, w, h);
    context.fillStyle = "rgba(244, 247, 250, 0.95)";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const pins = ["D12", "D11", "D10", "D9", "D8", "D7", "D6", "D5", "D4", "D3", "D2", "GND", "RST", "RX0", "TX1"];
    const pins2 = ["D13", "3V3", "REF", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "5V", "RST", "GND", "VIN"];
    context.font = `600 ${Math.round(h * 0.075)}px Inter, system-ui, sans-serif`;
    pins.forEach((pin, index) => context.fillText(pin, w * (0.08 + index * 0.06), h * 0.2));
    pins2.forEach((pin, index) => context.fillText(pin, w * (0.08 + index * 0.06), h * 0.8));
    // Title and honesty note sit in the free area past the microcontroller, clear of the chips.
    context.textAlign = "left";
    context.font = `800 ${Math.round(h * 0.11)}px Inter, system-ui, sans-serif`;
    context.fillText("SNAPINO", w * 0.69, h * 0.42);
    context.font = `600 ${Math.round(h * 0.055)}px Inter, system-ui, sans-serif`;
    context.fillText("BLOCK RUNNER ONLY", w * 0.69, h * 0.55);
    context.fillText("NOT AN AVR EMULATOR", w * 0.69, h * 0.63);
    context.strokeStyle = "rgba(244, 247, 250, 0.8)";
    context.lineWidth = 3;
    context.strokeRect(w * 0.015, h * 0.06, w * 0.97, h * 0.88);
  });
  const material = new MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.6, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  material.name = "silkscreen";
  const mesh = new Mesh(new PlaneGeometry(width, depth).rotateX(-Math.PI / 2), material);
  mesh.name = "snapino_silkscreen";
  mesh.renderOrder = 2;
  return mesh;
}

/** Two rows of black header strips with gold pins along a module's long edges. */
export function createHeaderRows(length: number, rowOffset: number, pins: number): Group {
  const group = new Group();
  const pitch = length / pins;
  const housing = new BoxGeometry(length, 0.06, pitch * 0.95);
  const pinGeometry = new BoxGeometry(pitch * 0.25, 0.1, pitch * 0.25);
  const gold = once("m:gold", () => new MeshStandardMaterial({ name: "gold_plating", color: 0xd8b25a, metalness: 1, roughness: 0.28 }));
  for (const z of [-rowOffset, rowOffset]) {
    const strip = new Mesh(housing, palette.darkPlastic());
    strip.position.set(0, 0.03, z);
    group.add(strip);
    const pinMesh = new InstancedMesh(pinGeometry, gold, pins);
    const dummy = new Object3D();
    for (let i = 0; i < pins; i += 1) {
      dummy.position.set(-length / 2 + pitch * (i + 0.5), 0.07, z);
      dummy.updateMatrix();
      pinMesh.setMatrixAt(i, dummy.matrix);
    }
    pinMesh.instanceMatrix.needsUpdate = true;
    group.add(pinMesh);
  }
  return group;
}
