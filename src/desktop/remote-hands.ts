/**
 * Translucent "virtual hands" for teammates' grabs on the desktop workbench.
 *
 * When another participant — a remote human or Bolt, the AI teammate — claims a part or a
 * cable end, a ghost hand in that participant's color reaches down onto it, rides along while
 * the part moves, and lifts away when they let go. The hands are presence cues only: they
 * never take input, cast shadows, or change what is connected.
 */
import {
  CanvasTexture,
  CapsuleGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Camera,
  type Object3D,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export interface HandOwner {
  id: string;
  name: string;
  kind?: "human" | "agent";
}

const AGENT_COLOR = 0xb98cff;
const HUMAN_COLOR = 0x56c8ff;
const HAND_OPACITY = 0.56;
/** The hand is modeled at ~1/2 scale; this sizes it against breadboard parts at table view. */
const HAND_SCALE = 2.1;
const HOVER_HEIGHT = 0.24;
const ENTER_MS = 240;
const EXIT_MS = 420;

interface HandState {
  group: Group;
  materials: MeshStandardMaterial[];
  label: Sprite;
  anchor: () => Vector3 | null;
  phase: "enter" | "hold" | "exit";
  startedAt: number;
}

export class RemoteHands {
  private readonly parent: Object3D;
  private readonly hands = new Map<string, HandState>();
  private readonly scratch = new Vector3();

  constructor(parent: Object3D) {
    this.parent = parent;
  }

  /** Show `owner`'s hand on the resource; `anchor` returns its world point each frame. */
  grab(resourceId: string, owner: HandOwner, anchor: () => Vector3 | null): void {
    const existing = this.hands.get(resourceId);
    if (existing && existing.phase !== "exit" && existing.group.userData.ownerId === owner.id) {
      existing.anchor = anchor;
      return;
    }
    if (existing) this.remove(resourceId);
    const color = owner.kind === "agent" ? AGENT_COLOR : HUMAN_COLOR;
    const { group, materials } = buildHand(color);
    const label = buildLabel(owner.kind === "agent" ? `${owner.name} · AI` : owner.name, color);
    label.position.set(0, 0.42, 0);
    group.add(label);
    group.userData.ownerId = owner.id;
    group.name = `remote-hand:${owner.name}`;
    group.renderOrder = 10;
    this.parent.add(group);
    this.hands.set(resourceId, { group, materials, label, anchor, phase: "enter", startedAt: performance.now() });
  }

  release(resourceId: string): void {
    const hand = this.hands.get(resourceId);
    if (!hand || hand.phase === "exit") return;
    hand.phase = "exit";
    hand.startedAt = performance.now();
  }

  update(camera: Camera): void {
    const now = performance.now();
    for (const [resourceId, hand] of this.hands) {
      const point = hand.anchor();
      const elapsed = now - hand.startedAt;
      let presence = 1;
      if (hand.phase === "enter") {
        presence = Math.min(1, elapsed / ENTER_MS);
        if (presence >= 1) hand.phase = "hold";
      } else if (hand.phase === "exit") {
        presence = Math.max(0, 1 - elapsed / EXIT_MS);
        if (presence <= 0) {
          this.remove(resourceId);
          continue;
        }
      }
      hand.group.visible = point !== null;
      if (!point) continue;
      const eased = presence * presence * (3 - 2 * presence);
      // Reaches down from above on grab, lifts up and away on release.
      hand.group.position.copy(point).add(this.scratch.set(0, HOVER_HEIGHT + (1 - eased) * 0.6, 0));
      hand.group.rotation.y = Math.atan2(camera.position.x - point.x, camera.position.z - point.z);
      // A small squeeze as the fingers close on the part.
      const grip = hand.phase === "enter" ? 1 + (1 - eased) * 0.12 : 1;
      hand.group.scale.setScalar(HAND_SCALE * grip);
      for (const material of hand.materials) material.opacity = HAND_OPACITY * eased;
      (hand.label.material as SpriteMaterial).opacity = eased;
    }
  }

  dispose(): void {
    for (const resourceId of [...this.hands.keys()]) this.remove(resourceId);
  }

  private remove(resourceId: string): void {
    const hand = this.hands.get(resourceId);
    if (!hand) return;
    this.hands.delete(resourceId);
    hand.group.removeFromParent();
    hand.group.traverse((child) => {
      if (child instanceof Mesh) child.geometry.dispose();
    });
    for (const material of hand.materials) material.dispose();
    const labelMaterial = hand.label.material as SpriteMaterial;
    labelMaterial.map?.dispose();
    labelMaterial.dispose();
  }
}

/** A stylized open-then-gripping hand: palm over the part, fingers and thumb hooked around it. */
function buildHand(color: number): { group: Group; materials: MeshStandardMaterial[] } {
  const group = new Group();
  const skin = new MeshStandardMaterial({
    color,
    emissive: new Color(color),
    emissiveIntensity: 0.6,
    roughness: 0.38,
    metalness: 0,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const add = (mesh: Mesh): void => {
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 10;
    group.add(mesh);
  };

  const palm = new Mesh(new RoundedBoxGeometry(0.3, 0.075, 0.27, 3, 0.034), skin);
  palm.position.set(0, 0.07, -0.02);
  add(palm);

  // Fingers: a knuckle segment angled forward and down from the palm, then a tip hooked
  // under it, so together they read as a hand closing around the part.
  const lengths = [0.08, 0.095, 0.09, 0.07];
  lengths.forEach((length, index) => {
    const x = -0.102 + index * 0.068;
    const knuckle = new Mesh(new CapsuleGeometry(0.033, length, 4, 12), skin);
    knuckle.rotation.x = Math.PI / 2 + 0.75;
    knuckle.position.set(x, 0.03, 0.135 + length * 0.28);
    add(knuckle);
    const tip = new Mesh(new CapsuleGeometry(0.03, length * 0.75, 4, 12), skin);
    tip.rotation.x = -0.25;
    tip.position.set(x, -0.045 - length * 0.25, 0.18 + length * 0.42);
    add(tip);
  });

  const thumb = new Mesh(new CapsuleGeometry(0.036, 0.11, 4, 12), skin);
  thumb.rotation.set(0.35, 0, -1.05);
  thumb.position.set(0.185, 0.0, 0.03);
  add(thumb);

  return { group, materials: [skin] };
}

function buildLabel(text: string, color: number): Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    const hex = `#${color.toString(16).padStart(6, "0")}`;
    context.font = "600 26px Inter, system-ui, sans-serif";
    const width = Math.min(240, context.measureText(text).width + 34);
    const x = (256 - width) / 2;
    context.fillStyle = "rgba(10, 14, 24, 0.82)";
    context.strokeStyle = hex;
    context.lineWidth = 3;
    context.beginPath();
    context.roundRect(x, 10, width, 44, 22);
    context.fill();
    context.stroke();
    context.fillStyle = "#f4f7fb";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 128, 33, 220);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new SpriteMaterial({ map: texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  const sprite = new Sprite(material);
  sprite.scale.set(0.5, 0.125, 1);
  sprite.renderOrder = 11;
  return sprite;
}
