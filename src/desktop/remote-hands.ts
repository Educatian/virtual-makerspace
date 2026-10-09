/**
 * Translucent hands for teammates' grabs on the desktop workbench.
 *
 * When another participant — a remote human or Bolt, the AI teammate — claims a part or a
 * cable end, a glassy hand in that participant's color reaches down, closes its fingers on
 * the part, rides along while it moves, then opens and lifts away on release. The hands are
 * presence cues only: they never take input, cast shadows, or change what is connected.
 *
 * The mesh is the MIT-licensed WebXR generic hand (public/models/hand), posed by curling its
 * finger joints. Until it loads (or if it can't), only the name tag is shown.
 */
import {
  Bone,
  CanvasTexture,
  Color,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Camera,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

export interface HandOwner {
  id: string;
  name: string;
  kind?: "human" | "agent";
}

/** Writes the world point the hand should hold into `out`; false hides the hand. */
export type HandAnchor = (out: Vector3) => boolean;

const AGENT_COLOR = 0xb794ff;
const HUMAN_COLOR = 0x5cc8ff;
/** World units per model meter: the hand reads at about 1.1 units, a little larger than a part. */
const HAND_SCALE = 6.2;
const HOVER = 0.1;
const DROP = 0.7;
const ENTER_MS = 520;
const EXIT_MS = 460;
const OPACITY = 0.62;

const FINGERS = ["index", "middle", "ring", "pinky"] as const;
/** How far each joint bends at a full grip, in radians (proximal, intermediate, distal). */
const FINGER_CURL = [0.95, 1.05, 0.7];
const THUMB_CURL = [0.25, 0.55, 0.5];
/** Which way around the knuckle axis closes the hand. */
const GRIP_SIGN = 1;

interface PosedBone {
  bone: Bone;
  rest: Quaternion;
  /** Bend axis in the bone's own frame: across the knuckles, so fingers close toward the palm. */
  axis: Vector3;
  curl: number;
}

interface HandState {
  root: Group;
  model: Group | null;
  material: MeshStandardMaterial;
  label: Sprite;
  bones: PosedBone[];
  anchor: HandAnchor;
  ownerId: string;
  phase: "enter" | "hold" | "exit";
  startedAt: number;
}

let template: Promise<Group | null> | null = null;

function loadTemplate(): Promise<Group | null> {
  template ??= new GLTFLoader()
    .loadAsync(`${import.meta.env.BASE_URL}models/hand/right.glb`)
    .then((gltf) => gltf.scene)
    .catch(() => null);
  return template;
}

export class RemoteHands {
  private readonly parent: Object3D;
  private readonly hands = new Map<string, HandState>();
  private readonly point = new Vector3();
  private readonly bend = new Quaternion();
  private model: Group | null = null;
  private disposed = false;

  constructor(parent: Object3D) {
    this.parent = parent;
    void loadTemplate().then((scene) => {
      if (this.disposed || !scene) return;
      this.model = scene;
      for (const hand of this.hands.values()) this.attachModel(hand);
    });
  }

  /** Show `owner`'s hand holding the resource at the point `anchor` reports each frame. */
  grab(resourceId: string, owner: HandOwner, anchor: HandAnchor): void {
    const existing = this.hands.get(resourceId);
    if (existing && existing.ownerId === owner.id) {
      existing.anchor = anchor;
      if (existing.phase === "exit") {
        existing.phase = "hold";
        existing.startedAt = performance.now();
      }
      return;
    }
    if (existing) this.remove(resourceId);

    const color = owner.kind === "agent" ? AGENT_COLOR : HUMAN_COLOR;
    const root = new Group();
    root.name = `remote-hand:${owner.name}`;
    const material = createGlassMaterial(color);
    const label = createNameTag(owner.kind === "agent" ? `${owner.name} · AI` : owner.name, color);
    label.position.set(0, 1.25, 0);
    root.add(label);
    this.parent.add(root);
    const hand: HandState = {
      root,
      model: null,
      material,
      label,
      bones: [],
      anchor,
      ownerId: owner.id,
      phase: "enter",
      startedAt: performance.now(),
    };
    this.hands.set(resourceId, hand);
    this.attachModel(hand);
  }

  release(resourceId: string): void {
    const hand = this.hands.get(resourceId);
    if (!hand || hand.phase === "exit") return;
    hand.phase = "exit";
    hand.startedAt = performance.now();
  }

  /** Drop every hand at once, e.g. when the studio changes. */
  clear(): void {
    for (const resourceId of [...this.hands.keys()]) this.remove(resourceId);
  }

  update(camera: Camera): void {
    if (this.hands.size === 0) return;
    const now = performance.now();
    this.hands.forEach((hand, resourceId) => this.step(hand, resourceId, now, camera));
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private step(hand: HandState, resourceId: string, now: number, camera: Camera): void {
    const elapsed = now - hand.startedAt;
    // reach: 0 = away and invisible, 1 = at the part. grip: 0 = open, 1 = closed.
    let reach = 1;
    let grip = 1;
    if (hand.phase === "enter") {
      const t = Math.min(1, elapsed / ENTER_MS);
      reach = easeOut(Math.min(1, t / 0.7));
      grip = MathUtils.smoothstep(t, 0.55, 1);
      if (t >= 1) hand.phase = "hold";
    } else if (hand.phase === "exit") {
      const t = Math.min(1, elapsed / EXIT_MS);
      grip = 1 - MathUtils.smoothstep(t, 0, 0.4);
      reach = 1 - easeIn(MathUtils.smoothstep(t, 0.2, 1));
      if (t >= 1) {
        this.remove(resourceId);
        return;
      }
    }

    const visible = hand.anchor(this.point);
    hand.root.visible = visible;
    if (!visible) return;
    hand.root.position.set(this.point.x, this.point.y + HOVER + (1 - reach) * DROP, this.point.z);
    // Turn toward the viewer; the model's own yaw gives the three-quarter palm view.
    hand.root.rotation.y = Math.atan2(camera.position.x - this.point.x, camera.position.z - this.point.z);
    hand.material.opacity = OPACITY * reach;
    (hand.label.material as SpriteMaterial).opacity = reach;
    for (const posed of hand.bones) {
      this.bend.setFromAxisAngle(posed.axis, posed.curl * GRIP_SIGN * (0.12 + 0.88 * grip));
      posed.bone.quaternion.copy(posed.rest).multiply(this.bend);
    }
  }

  private attachModel(hand: HandState): void {
    if (!this.model || hand.model) return;
    const model = cloneSkinned(this.model) as Group;
    model.traverse((child) => {
      if (child instanceof SkinnedMesh || child instanceof Mesh) {
        child.material = hand.material;
        child.castShadow = false;
        child.receiveShadow = false;
        child.frustumCulled = false;
        child.renderOrder = 10;
      }
    });
    hand.bones = poseBones(model);
    // Model space: fingers hang along -Y from the wrist, thumb toward -Z. Put the grip point
    // (between thumb tip and fingertips) at the root, so the root sits on the held part.
    const wrapper = new Group();
    wrapper.add(model);
    wrapper.scale.setScalar(HAND_SCALE);
    model.position.set(-0.02, 0.105, 0.012);
    // Three-quarter view of the palm, so the closing fingers read, leaning toward the viewer.
    wrapper.rotation.set(0.3, 0.8, 0);
    // In that view the curled fingertips sit right of the wrist; center them on the part.
    wrapper.position.set(-0.22, 0, 0);
    hand.root.add(wrapper);
    hand.model = wrapper;
  }

  private remove(resourceId: string): void {
    const hand = this.hands.get(resourceId);
    if (!hand) return;
    this.hands.delete(resourceId);
    hand.root.removeFromParent();
    // Each cloned skinned hand owns a bone texture on the GPU; free it with the hand.
    hand.root.traverse((child) => {
      if (child instanceof SkinnedMesh) child.skeleton.dispose();
    });
    hand.material.dispose();
    const labelMaterial = hand.label.material as SpriteMaterial;
    labelMaterial.map?.dispose();
    labelMaterial.dispose();
  }
}

function poseBones(model: Object3D): PosedBone[] {
  model.updateMatrixWorld(true);
  const knuckles = (name: string): Vector3 => model.getObjectByName(name)?.getWorldPosition(new Vector3()) ?? new Vector3();
  // The line across the knuckles, index to pinky, in model space.
  const across = knuckles("pinky-finger-phalanx-proximal").sub(knuckles("index-finger-phalanx-proximal")).normalize();
  const inverse = new Quaternion();
  const posed: PosedBone[] = [];
  const add = (name: string, curl: number): void => {
    const bone = model.getObjectByName(name);
    if (!(bone instanceof Bone)) return;
    bone.getWorldQuaternion(inverse).invert();
    posed.push({ bone, rest: bone.quaternion.clone(), axis: across.clone().applyQuaternion(inverse).normalize(), curl });
  };
  for (const finger of FINGERS) {
    add(`${finger}-finger-phalanx-proximal`, FINGER_CURL[0]);
    add(`${finger}-finger-phalanx-intermediate`, FINGER_CURL[1]);
    add(`${finger}-finger-phalanx-distal`, FINGER_CURL[2]);
  }
  add("thumb-metacarpal", THUMB_CURL[0]);
  add("thumb-phalanx-proximal", THUMB_CURL[1]);
  add("thumb-phalanx-distal", THUMB_CURL[2]);
  return posed;
}

/** Tinted glass: faint in the middle, bright along the silhouette. */
function createGlassMaterial(color: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color,
    emissive: new Color(color).multiplyScalar(0.35),
    roughness: 0.25,
    metalness: 0,
    transparent: true,
    opacity: 0,
    depthWrite: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: new Color(color) };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 rimColor;")
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        float rim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.2);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, rimColor * 1.35, rim * 0.75);
        gl_FragColor.a *= mix(0.32, 1.0, rim);`,
      );
  };
  material.customProgramCacheKey = () => "remote-hand-glass";
  return material;
}

function createNameTag(text: string, color: number): Sprite {
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = 320 * scale;
  canvas.height = 64 * scale;
  const context = canvas.getContext("2d");
  if (context) {
    context.scale(scale, scale);
    context.font = "600 22px Inter, system-ui, sans-serif";
    const textWidth = Math.min(260, context.measureText(text).width);
    const width = textWidth + 40;
    const x = (320 - width) / 2;
    context.fillStyle = "rgba(12, 16, 26, 0.88)";
    context.beginPath();
    context.roundRect(x, 12, width, 40, 20);
    context.fill();
    context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    context.beginPath();
    context.arc(x + 17, 32, 5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#eef3fb";
    context.textBaseline = "middle";
    context.fillText(text, x + 29, 33, 260);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new SpriteMaterial({ map: texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  const sprite = new Sprite(material);
  sprite.scale.set(1.25, 0.25, 1);
  sprite.renderOrder = 11;
  return sprite;
}

const easeOut = (t: number): number => 1 - (1 - t) ** 3;
const easeIn = (t: number): number => t * t * t;
