import {
  AdditiveBlending,
  ACESFilmicToneMapping,
  Box3,
  BoxGeometry,
  BoxHelper,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  ConeGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  Euler,
  Group,
  HemisphereLight,
  InstancedMesh,
  Material,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PCFSoftShadowMap,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  SpotLight,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { formatAmps, formatVolts } from "../circuit/dc-engine.ts";
import { sanitizeProps, type PartProps } from "../circuit/part-props.ts";
import { analyzeCircuit, type CircuitAnalysis, type CircuitPlacements, type CircuitProps } from "./circuit-topology.js";
import type { SharedTransform } from "./collaboration.js";
import {
  BOARD_SURFACE,
  HOLE_FLOOR,
  createBatteryModel,
  createBreadboard,
  createHeaderRows,
  createLedModel,
  createResistorModel,
  createSnapinoSilkscreen,
  palette,
} from "./bench-models.js";
import { RemoteHands, type HandOwner } from "./remote-hands.js";
import { NET_TONES, type NetTone, type NetToneStyle } from "./selection-style.ts";
import { LOW_PINS, OUTPUT_PINS, type PinStates } from "./snapino.js";
import { analyzeSnapino, SNAPINO_LOADS, SNAPINO_PADS, type SnapinoBench } from "../circuit/snapino-circuit.ts";

export type StudioKind = "circuit" | "greenhouse" | "snap" | "snapino";
export type ComponentKind =
  | "led"
  | "resistor"
  | "wire"
  | "battery"
  | "sensor"
  | "controller"
  | "pump"
  | "fan"
  | "hose"
  | "solar"
  | "snapwire"
  | "snapbattery"
  | "snapswitch"
  | "snaplamp"
  | "snapmotor"
  | "snapled";

export interface ComponentSpec {
  id: string;
  name: string;
  detail: string;
  kind: ComponentKind;
  color: number;
  leadSeparation: number;
  studio: StudioKind;
  /** GLB part to render when it differs from the id (Snapino reuses the Snap kit). */
  model?: string;
}

export interface EnvironmentState {
  moisture: number;
  temperature: number;
  light: number;
  flow: number;
  irrigation: boolean;
  ventilation: boolean;
  systemReady: boolean;
}

export interface SceneSnapshot {
  id: string;
  createdAt: number;
  transforms: Record<string, SharedTransform>;
  summary: string;
}

export interface SceneEvents {
  onSelection: (component: ComponentSpec | null) => void;
  onStatus: (message: string, tone: "neutral" | "valid" | "warning") => void;
  onTransform: (componentId: string, transform: SharedTransform) => void;
  onClaim: (componentId: string) => boolean;
  onRelease: (componentId: string) => void;
  onAttempt: (snapshot: SceneSnapshot) => void;
  /**
   * The room ended this participant's drag (claim refused, or an accepted change the room
   * ordered first): nothing was moved, so there is no move to record or release to trace.
   */
  onDragAborted?: (resourceId: string) => void;
  /**
   * A whole-part change made here (demo layout, slide switch, rotation reset, restoring an
   * attempt) to submit to the room as one atomic edit; it shows when the room accepts it.
   */
  onEdit?: (changes: Array<{ id: string; transform: SharedTransform }>, label: string) => void;
  onCircuitState: (powered: boolean) => void;
  /** The Circuit Bench's latest engine analysis (every re-evaluation, not only on change). */
  onCircuitAnalysis?: (analysis: CircuitAnalysis) => void;
  onEnvironmentState: (state: EnvironmentState) => void;
  /** The Snapino bench re-evaluated (placements, switch or pin levels may have changed). */
  onSnapinoChange?: () => void;
}

/** A stud the Snapino inspector highlights: tone "a"/"b" for a part's two nets, "fault" for a bypass. */
export interface StudHighlight {
  socket: number;
  tone: NetTone;
  /** One of the selected part's own two studs (drawn larger). */
  terminal: boolean;
}

export type CameraPreset = "bench" | "top" | "table" | "receiver";

/** Ring geometry per tone pattern: a solid ring, eight dashes, or two concentric rings. */
function ringPattern(pattern: NetToneStyle["pattern"]): BufferGeometry {
  if (pattern === "solid") return new RingGeometry(0.068, 0.104, 32, 1);
  if (pattern === "dashed") {
    const dashes = Array.from({ length: 8 }, (_, index) => new RingGeometry(0.068, 0.104, 6, 1, (index * Math.PI) / 4, Math.PI / 6.5));
    return mergeGeometries(dashes, false) ?? new RingGeometry(0.068, 0.104, 32, 1);
  }
  return mergeGeometries([new RingGeometry(0.06, 0.078, 32, 1), new RingGeometry(0.092, 0.11, 32, 1)], false) ?? new RingGeometry(0.068, 0.104, 32, 1);
}
/** Top of the snap base plate (procedural and GLB alike), where stud collars and rings sit. */
const SNAP_PLATE_TOP = 0.26;

const COLORS = {
  wood: 0x8b6f47,
  board: 0xeee8d9,
  boardEdge: 0xd7cfbd,
  dark: 0x0f1520,
  tray: 0x142d3b,
  metal: 0xb8c0c9,
  blue: 0x3b82f6,
  green: 0x00ff66,
};

const COLS = 16;
const ROWS = 12;
const PITCH = 0.24;
const BOARD_X = -0.75;
const BOARD_TOP = 0.31;
const DRAG_Y = BOARD_TOP + 0.17;
const SNAP_THRESHOLD = 0.34;
const SNAP_PITCH = 0.48;
const SNAP_COLS = 9;
const SNAP_ROWS = 7;
const SNAP_STUD_Y = DRAG_Y - 0.1;
const MAGNETIC_RADIUS = 0.72;
/** Jumper wire: insulation radius (≈1 mm OD), where the insulation ends above the socket point, and the bare tip that reaches the hole floor. */
const WIRE_RADIUS = 0.048;
const WIRE_INSULATION_END = 0.04;
const WIRE_TIP_BOTTOM = HOLE_FLOOR - (BOARD_TOP + 0.015) + 0.004;
const WIRE_TIP_LENGTH = WIRE_INSULATION_END + 0.01 - WIRE_TIP_BOTTOM;
const WIRE_TIP_CENTER = WIRE_TIP_BOTTOM + WIRE_TIP_LENGTH / 2;
/** Board surface in a seated part's local frame (parts sit at DRAG_Y). */
const SURFACE_LOCAL_Y = BOARD_SURFACE - DRAG_Y;

export type RenderQuality = "low" | "medium" | "high";
const QUALITY: Record<RenderQuality, { maxPixelRatio: number; minPixelRatio: number; shadowMap: number; shadows: boolean; glowLights: boolean }> = {
  low: { maxPixelRatio: 1, minPixelRatio: 0.7, shadowMap: 0, shadows: false, glowLights: false },
  medium: { maxPixelRatio: 1.5, minPixelRatio: 0.85, shadowMap: 1024, shadows: true, glowLights: true },
  high: { maxPixelRatio: 2, minPixelRatio: 1, shadowMap: 2048, shadows: true, glowLights: true },
};

type EndpointSockets = [number | null, number | null] | null;
type EndpointPair = [Vector3, Vector3];

interface EndpointDragState {
  component: Group;
  index: 0 | 1;
  resourceId: string;
  startEndpoints: EndpointPair;
  startSockets: EndpointSockets;
  previousWorld: Vector3;
  startClient: Vector2;
  moved: boolean;
  sway: number;
  velocity: number;
}

const CIRCUIT_COMPONENTS: ComponentSpec[] = [
  { id: "led-red", name: "LED (Red)", detail: "x1", kind: "led", color: 0xff3030, leadSeparation: PITCH, studio: "circuit" },
  { id: "led-green", name: "LED (Green)", detail: "x1", kind: "led", color: 0x32f06a, leadSeparation: PITCH, studio: "circuit" },
  { id: "resistor-220", name: "Resistor", detail: "220 Ω", kind: "resistor", color: 0xd6b77a, leadSeparation: PITCH * 3, studio: "circuit" },
  { id: "resistor-1k", name: "Resistor", detail: "1 kΩ", kind: "resistor", color: 0xb58458, leadSeparation: PITCH * 3, studio: "circuit" },
  { id: "wire-red", name: "Wire (Red)", detail: "Short", kind: "wire", color: 0xd63c3c, leadSeparation: PITCH * 2, studio: "circuit" },
  { id: "wire-blue", name: "Wire (Blue)", detail: "Medium", kind: "wire", color: 0x2563eb, leadSeparation: PITCH * 4, studio: "circuit" },
  { id: "wire-yellow", name: "Wire (Yellow)", detail: "Long", kind: "wire", color: 0xfacc15, leadSeparation: PITCH * 6, studio: "circuit" },
  { id: "battery-9v", name: "9V Battery", detail: "Power", kind: "battery", color: 0x222222, leadSeparation: PITCH * 2, studio: "circuit" },
];

const GREENHOUSE_COMPONENTS: ComponentSpec[] = [
  { id: "soil-sensor", name: "Soil Sensor", detail: "Moisture", kind: "sensor", color: 0x22c55e, leadSeparation: PITCH * 2, studio: "greenhouse" },
  { id: "temp-sensor", name: "Climate Sensor", detail: "Temp + humidity", kind: "sensor", color: 0x38bdf8, leadSeparation: PITCH * 2, studio: "greenhouse" },
  { id: "light-sensor", name: "Light Sensor", detail: "PAR level", kind: "sensor", color: 0xfacc15, leadSeparation: PITCH * 2, studio: "greenhouse" },
  { id: "farm-controller", name: "Farm Controller", detail: "Rules + relay", kind: "controller", color: 0x2563eb, leadSeparation: PITCH * 4, studio: "greenhouse" },
  { id: "water-pump", name: "Water Pump", detail: "12 V DC", kind: "pump", color: 0x0ea5e9, leadSeparation: PITCH * 3, studio: "greenhouse" },
  { id: "irrigation-hose", name: "Irrigation Hose", detail: "Flexible line", kind: "hose", color: 0x16a34a, leadSeparation: PITCH * 7, studio: "greenhouse" },
  { id: "vent-fan", name: "Vent Fan", detail: "Airflow", kind: "fan", color: 0x94a3b8, leadSeparation: PITCH * 3, studio: "greenhouse" },
  { id: "solar-panel", name: "Solar Panel", detail: "18 W source", kind: "solar", color: 0x1d4ed8, leadSeparation: PITCH * 4, studio: "greenhouse" },
];

// Snap Circuits-style accessible kit (Jung & Chang, ISLS 2024 symposium; Seo et al. BLV maker curriculum).
const SNAP_COMPONENTS: ComponentSpec[] = [
  { id: "snap-b1", name: "Battery Holder B1", detail: "2 × AA · 3 V", kind: "snapbattery", color: 0x1f2937, leadSeparation: SNAP_PITCH * 3, studio: "snap" },
  { id: "snap-s1", name: "Slide Switch S1", detail: "Double-click to slide", kind: "snapswitch", color: 0xe5e7eb, leadSeparation: SNAP_PITCH * 2, studio: "snap" },
  { id: "snap-l1", name: "Lamp L1", detail: "2.5 V bulb", kind: "snaplamp", color: 0xfde68a, leadSeparation: SNAP_PITCH * 2, studio: "snap" },
  { id: "snap-m1", name: "Motor M1", detail: "With fan", kind: "snapmotor", color: 0xdc2626, leadSeparation: SNAP_PITCH * 2, studio: "snap" },
  { id: "snap-w2", name: "Snap Wire 2", detail: "Conductor", kind: "snapwire", color: 0x1d4ed8, leadSeparation: SNAP_PITCH * 2, studio: "snap" },
  { id: "snap-w3a", name: "Snap Wire 3", detail: "Conductor", kind: "snapwire", color: 0x1d4ed8, leadSeparation: SNAP_PITCH * 3, studio: "snap" },
  { id: "snap-w3b", name: "Snap Wire 3", detail: "Conductor", kind: "snapwire", color: 0x1d4ed8, leadSeparation: SNAP_PITCH * 3, studio: "snap" },
  { id: "snap-w4", name: "Snap Wire 4", detail: "Conductor", kind: "snapwire", color: 0x1d4ed8, leadSeparation: SNAP_PITCH * 4, studio: "snap" },
];

// Snapino Bridge: the same kit wired to an Arduino Nano's pads instead of B1.
const SNAPINO_COMPONENTS: ComponentSpec[] = [
  { id: "sno-l1", model: "snap-l1", name: "Lamp L1", detail: "Output load", kind: "snaplamp", color: 0xfde68a, leadSeparation: SNAP_PITCH * 2, studio: "snapino" },
  { id: "sno-d1", model: "snap-d1", name: "LED D1", detail: "Red · output", kind: "snapled", color: 0xff3b30, leadSeparation: SNAP_PITCH * 2, studio: "snapino" },
  { id: "sno-m1", model: "snap-m1", name: "Motor M1", detail: "Output load", kind: "snapmotor", color: 0xdc2626, leadSeparation: SNAP_PITCH * 2, studio: "snapino" },
  { id: "sno-s1", model: "snap-s1", name: "Slide Switch S1", detail: "Input to D2", kind: "snapswitch", color: 0xe5e7eb, leadSeparation: SNAP_PITCH * 2, studio: "snapino" },
  { id: "sno-w2a", model: "snap-w2", name: "Snap Wire 2", detail: "Conductor", kind: "snapwire", color: 0x1d4ed8, leadSeparation: SNAP_PITCH * 2, studio: "snapino" },
  { id: "sno-w2b", model: "snap-w2", name: "Snap Wire 2", detail: "Conductor", kind: "snapwire", color: 0x1d4ed8, leadSeparation: SNAP_PITCH * 2, studio: "snapino" },
  { id: "sno-w3", model: "snap-w3a", name: "Snap Wire 3", detail: "Conductor", kind: "snapwire", color: 0x1d4ed8, leadSeparation: SNAP_PITCH * 3, studio: "snapino" },
  { id: "sno-w4a", model: "snap-w4", name: "Snap Wire 4", detail: "Conductor", kind: "snapwire", color: 0x1d4ed8, leadSeparation: SNAP_PITCH * 4, studio: "snapino" },
  { id: "sno-w4b", model: "snap-w4", name: "Snap Wire 4", detail: "Conductor", kind: "snapwire", color: 0x1d4ed8, leadSeparation: SNAP_PITCH * 4, studio: "snapino" },
];
/** Base-grid stud index (row * 9 + col) under each Snapino pad — row B, columns 2–7. */

const COMPONENTS = [...CIRCUIT_COMPONENTS, ...GREENHOUSE_COMPONENTS, ...SNAP_COMPONENTS, ...SNAPINO_COMPONENTS];

const socketRows = (): number[] => [
  -1.58,
  -1.14,
  -0.9,
  -0.66,
  -0.42,
  -0.18,
  0.18,
  0.42,
  0.66,
  0.9,
  1.14,
  1.58,
];

export class DesktopWorkbenchScene {
  private activeStudio: StudioKind = "circuit";

  private readonly host: HTMLElement;
  private readonly events: SceneEvents;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.05, 80);
  private readonly renderer: WebGLRenderer;
  private readonly orbit: OrbitControls;
  private readonly transform: TransformControls;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly dragPlane = new Plane(new Vector3(0, 1, 0), -DRAG_Y);
  private readonly dragPoint = new Vector3();
  private readonly dragOffset = new Vector3();
  private readonly components = new Map<string, Group>();
  private readonly circuitGroup = new Group();
  private readonly greenhouseGroup = new Group();
  private readonly snapGroup = new Group();
  private readonly snapinoGroup = new Group();
  private readonly snapBaseGroup = new Group();
  private snapinoPins: PinStates = { ...LOW_PINS };
  private snapinoInputHigh = false;
  private snapinoRunningLoads: string[] = [];
  private readonly circuitSockets: Vector3[] = [];
  private readonly greenhouseSockets: Vector3[] = [];
  private readonly snapSockets: Vector3[] = [];
  private sockets: Vector3[] = this.circuitSockets;
  private readonly remoteOwners = new Map<string, { id: string; name: string }>();
  /** Ghost hands showing which teammate (human or AI) is holding what. */
  private readonly remoteHands = new RemoteHands(this.scene);
  /** Remote moves glide (with a small carry lift) instead of teleporting. */
  private readonly remoteTweens = new Map<string, { base: Vector3; target: Vector3; rotation: Euler }>();
  private lastFrameAt = performance.now();
  private readonly viewInsets = { left: 0, right: 0 };
  private readonly previewMarkers: Mesh<RingGeometry, MeshBasicMaterial>[] = [];
  private readonly previewBeams: Mesh<CylinderGeometry, MeshBasicMaterial>[] = [];
  private readonly flexMotion = new Map<string, { previous: Vector3; sway: number; velocity: number }>();
  private readonly selectionBox = new BoxHelper(new Group(), COLORS.blue);
  /** Snapino inspector: rings on the selected part's terminals and on every stud of its nets. */
  /** One instanced mesh per tone (each with its own ring pattern), see selection-style.ts. */
  private studHighlights: Record<NetTone, InstancedMesh> | null = null;
  private lastStudHighlights: StudHighlight[] = [];
  /**
   * Circuit Bench "current flow" view: arrowheads along each jumper wire in the direction of the
   * solved conventional current (dc-engine element reading: positive = endpoint A → B). Shown
   * only for a valid solve (no short, open, missing supply or unsolvable circuit).
   */
  private flowEnabled = false;
  private flowMarkers: InstancedMesh | null = null;
  private flowWires: Array<{ id: string; amps: number; direction: 1 | -1; speed: number }> = [];
  private flowReason = "off";
  private flowPhase = 0;
  private readonly flowTemp = { point: new Vector3(), tangent: new Vector3(), up: new Vector3(0, 1, 0), quaternion: new Quaternion(), worldQuaternion: new Quaternion(), dummy: new Object3D() };
  /** Smooth camera moves for the view presets (instant with reduced motion). */
  private cameraTween: { fromPosition: Vector3; fromTarget: Vector3; toPosition: Vector3; toTarget: Vector3; start: number; duration: number } | null = null;
  private readonly hoverBox = new BoxHelper(new Group(), 0xe2e8f0);
  private readonly proceduralTable: Mesh[] = [];
  private hovered: Group | null = null;
  private snapShortActive = false;
  private circuitAnalysis: CircuitAnalysis | null = null;
  /** LEDs mid "burn-out" flash: id → time the flash started. */
  private readonly ledFlashes = new Map<string, number>();
  private readonly burntLeds = new Set<string>();
  private readonly quality: RenderQuality;
  /** Adaptive resolution: current pixel ratio and a rolling frame-time sample. */
  private pixelRatio = 1;
  private readonly frameTimes: number[] = [];
  private adaptations = 0;
  /** Shadow maps re-render only for a few frames after something moves (not every frame). */
  private shadowDirtyFrames = 4;
  private keyLight: DirectionalLight | null = null;
  private snapinoWarning = "";
  private readonly resizeObserver: ResizeObserver;

  private selected: Group | null = null;
  private dragging: Group | null = null;
  private draggingEndpoint: EndpointDragState | null = null;
  private dragOriginPosition = new Vector3();
  private dragOriginRotation = new Euler();
  private dragPointerId: number | null = null;
  private transformBroadcastAt = 0;
  private attemptNumber = 0;
  private magnetismEnabled = true;
  private environmentState: EnvironmentState = {
    moisture: 34,
    temperature: 28.6,
    light: 58,
    flow: 0,
    irrigation: false,
    ventilation: false,
    systemReady: false,
  };
  private environmentTarget = { moisture: 34, temperature: 28.6, light: 58, flow: 0 };
  private environmentEmitAt = 0;

  constructor(host: HTMLElement, events: SceneEvents, quality: RenderQuality = defaultQuality()) {
    this.host = host;
    this.events = events;
    this.quality = quality;
    this.scene.background = new Color(0x1a1d22);

    const tier = QUALITY[quality];
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = tier.shadows;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setAnimationLoop(this.render);
    this.renderer.domElement.className = "workbench-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Interactive 3D electronics workbench");
    this.host.append(this.renderer.domElement);

    this.camera.position.set(6.4, 6.1, 7.7);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0.1, 0.2, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    // Close enough to read hole labels and LED polarity; far enough to see the whole bench.
    this.orbit.minDistance = 1.6;
    this.orbit.maxDistance = 14;
    this.orbit.minPolarAngle = MathUtils.degToRad(12);
    this.orbit.maxPolarAngle = MathUtils.degToRad(80);
    this.orbit.screenSpacePanning = false;
    // A learner's own orbit/zoom always wins over a view preset's glide.
    this.orbit.addEventListener("start", () => {
      this.cameraTween = null;
    });
    this.orbit.update();

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setMode("rotate");
    this.transform.setSpace("world");
    this.transform.setRotationSnap(MathUtils.degToRad(15));
    this.transform.setSize(0.72);
    this.scene.add(this.transform.getHelper());

    this.scene.add(this.selectionBox);
    this.selectionBox.visible = false;
    const hoverMaterial = this.hoverBox.material as { transparent: boolean; opacity: number };
    hoverMaterial.transparent = true;
    hoverMaterial.opacity = 0.45;
    this.hoverBox.visible = false;
    this.scene.add(this.hoverBox);

    this.setupLighting();
    this.setupTable();
    this.scene.add(this.circuitGroup, this.greenhouseGroup, this.snapGroup, this.snapinoGroup, this.snapBaseGroup);
    this.setupBreadboard();
    this.setupGreenhouse();
    this.setupSnapBase();
    this.setupComponents();
    this.setupSnapMarkers();
    this.bindInteractions();
    void this.loadDetailedModels();

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.host);
    this.resize();
    this.switchStudio("circuit", false);
  }

  get componentSpecs(): ComponentSpec[] {
    return COMPONENTS.filter((component) => component.studio === this.activeStudio);
  }

  get studio(): StudioKind {
    return this.activeStudio;
  }

  switchStudio(studio: StudioKind, announce = true): void {
    this.clearSelection();
    // Teammates' hands stay (their anchors hide them while the studio is hidden); just
    // finish any glide so no part is left mid-air in the studio being hidden.
    for (const id of [...this.remoteTweens.keys()]) {
      const component = this.components.get(id);
      if (component) this.cancelRemoteTween(component, true);
    }
    this.activeStudio = studio;
    this.circuitGroup.visible = studio === "circuit";
    this.greenhouseGroup.visible = studio === "greenhouse";
    this.snapGroup.visible = studio === "snap";
    this.snapinoGroup.visible = studio === "snapino";
    this.snapBaseGroup.visible = studio === "snap" || studio === "snapino";
    this.sockets = studio === "greenhouse"
      ? this.greenhouseSockets
      : studio === "snap" || studio === "snapino"
        ? this.snapSockets
        : this.circuitSockets;
    this.camera.position.set(studio === "circuit" ? 6.4 : 7.2, studio === "circuit" ? 6.1 : 5.8, studio === "circuit" ? 7.7 : 8.6);
    this.orbit.target.set(studio === "circuit" ? 0.1 : 0, studio === "circuit" ? 0.2 : 0.55, studio === "circuit" ? 0 : -0.1);
    this.orbit.update();
    this.cameraTween = null;
    if (this.studHighlights) for (const mesh of Object.values(this.studHighlights)) mesh.visible = false;
    if (this.flowMarkers) this.flowMarkers.visible = this.flowEnabled && this.flowWires.length > 0 && studio === "circuit";
    // The Snapino bench fills the free view (the panels' insets are applied by then).
    if (studio === "snapino") requestAnimationFrame(() => this.activeStudio === "snapino" && this.viewPreset("bench"));
    this.evaluateCurrentSystem();
    if (announce) {
      this.events.onStatus(
        studio === "greenhouse"
          ? "Greenhouse Studio ready · connect sensors, water, air, and power"
          : studio === "snap"
            ? "Snap Lab ready · snap a battery, switch, lamp, and motor onto the base grid"
            : studio === "snapino"
              ? "Snapino Bridge ready · wire a load from a D pin to GND, then upload code"
              : "Circuit Bench ready",
        "valid",
      );
    }
  }

  selectById(componentId: string): void {
    const component = this.components.get(componentId);
    if (!component) return;
    this.select(component);
  }

  /** Frame the selected part: fit its bounds in the free view, keeping the viewing direction. */
  focusSelected(): void {
    if (!this.selected) return;
    const box = new Box3().setFromObject(this.selected);
    // Never closer than a comfortable look at one part, so its studs stay in frame.
    box.expandByScalar(0.18);
    const direction = this.camera.position.clone().sub(this.orbit.target).normalize();
    const fit = this.fitBox(box, direction, 0.7);
    this.moveCamera(fit.position, fit.target);
  }

  /**
   * Camera presets: the bench (snap base and Snapino carrier filling the free view), a top view
   * (rows A–G top to bottom, columns 1–9 left to right, as the diagram names studs), the whole
   * table with the parts tray, and the receiver's view of the lamp.
   */
  viewPreset(preset: CameraPreset): void {
    if (preset === "receiver") {
      const from = { position: this.camera.position.clone(), target: this.orbit.target.clone() };
      this.viewForReceiver();
      const to = { position: this.camera.position.clone(), target: this.orbit.target.clone() };
      this.camera.position.copy(from.position);
      this.orbit.target.copy(from.target);
      this.moveCamera(to.position, to.target);
      return;
    }
    const snap = this.activeStudio === "snap" || this.activeStudio === "snapino";
    if (!snap) {
      this.resetView();
      return;
    }
    const bench = new Box3(new Vector3(BOARD_X - 2.31, 0, -1.95), new Vector3(BOARD_X + 2.31, 0.75, 2.01));
    if (preset === "table") bench.union(new Box3(new Vector3(2.33, 0, -2.85), new Vector3(4.78, 0.5, 2.85)));
    const direction = preset === "top"
      ? new Vector3(0, Math.cos(MathUtils.degToRad(13)), Math.sin(MathUtils.degToRad(13)))
      : new Vector3(0.52, 0.62, 0.79).normalize();
    const fit = this.fitBox(bench, direction, preset === "top" ? 0.9 : 0.92);
    this.moveCamera(fit.position, fit.target);
  }

  /**
   * The camera position (along `direction` from the box centre) at which every corner of `box`
   * projects inside the part of the canvas the panels leave free, with `fill` of that space.
   */
  private fitBox(box: Box3, direction: Vector3, fill: number): { position: Vector3; target: Vector3 } {
    const target = box.getCenter(new Vector3());
    const savedPosition = this.camera.position.clone();
    const savedQuaternion = this.camera.quaternion.clone();
    const width = Math.max(this.host.clientWidth, 1);
    const xMin = -1 + (2 * this.viewInsets.left) / width;
    const xMax = 1 - (2 * this.viewInsets.right) / width;
    const xMid = (xMin + xMax) / 2;
    const xHalf = ((xMax - xMin) / 2) * fill;
    const yHalf = fill;
    const corner = new Vector3();
    const fits = (distance: number): boolean => {
      this.camera.position.copy(target).addScaledVector(direction, distance);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld(true);
      for (let index = 0; index < 8; index += 1) {
        corner.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z).project(this.camera);
        if (Math.abs(corner.x - xMid) > xHalf || Math.abs(corner.y) > yHalf || corner.z > 1) return false;
      }
      return true;
    };
    let low = this.orbit.minDistance;
    let high = this.orbit.maxDistance;
    if (!fits(high)) low = high;
    for (let step = 0; step < 22 && high - low > 0.01; step += 1) {
      const middle = (low + high) / 2;
      if (fits(middle)) high = middle;
      else low = middle;
    }
    this.camera.position.copy(savedPosition);
    this.camera.quaternion.copy(savedQuaternion);
    this.camera.updateMatrixWorld(true);
    return { position: target.clone().addScaledVector(direction, high), target };
  }

  private moveCamera(position: Vector3, target: Vector3): void {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) {
      this.cameraTween = null;
      this.camera.position.copy(position);
      this.orbit.target.copy(target);
      this.orbit.update();
      return;
    }
    this.cameraTween = { fromPosition: this.camera.position.clone(), fromTarget: this.orbit.target.clone(), toPosition: position.clone(), toTarget: target.clone(), start: performance.now(), duration: 420 };
  }

  private stepCameraTween(now: number): void {
    const tween = this.cameraTween;
    if (!tween) return;
    const t = Math.min(1, (now - tween.start) / tween.duration);
    const eased = 1 - Math.pow(1 - t, 3);
    this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
    this.orbit.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    if (t >= 1) this.cameraTween = null;
  }

  /**
   * QA composition metric: where the snap base and carrier appear on screen (client px), and the
   * free view left between the panels. Corners of the bench box projected with the live camera.
   */
  benchScreenRect(): { bench: { x: number; y: number; width: number; height: number }; free: { x: number; width: number; height: number } } {
    const box = new Box3(new Vector3(BOARD_X - 2.31, 0, -1.95), new Vector3(BOARD_X + 2.31, 0.3, 2.01));
    const canvas = this.renderer.domElement.getBoundingClientRect();
    this.camera.updateMatrixWorld(true);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const corner = new Vector3();
    for (let index = 0; index < 8; index += 1) {
      corner.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z).project(this.camera);
      const x = canvas.left + ((corner.x + 1) / 2) * canvas.width;
      const y = canvas.top + ((1 - corner.y) / 2) * canvas.height;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return {
      bench: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      free: { x: canvas.left + this.viewInsets.left, width: canvas.width - this.viewInsets.left - this.viewInsets.right, height: canvas.height },
    };
  }

  /** Where the camera is looking from and at (QA: preset framing checks). */
  cameraState(): { position: [number, number, number]; target: [number, number, number]; moving: boolean } {
    const position = this.cameraTween?.toPosition ?? this.camera.position;
    const target = this.cameraTween?.toTarget ?? this.orbit.target;
    return { position: [position.x, position.y, position.z], target: [target.x, target.y, target.z], moving: Boolean(this.cameraTween) };
  }

  /**
   * Snapino inspector cross-link: rings around the given studs (both nets of the selected part,
   * its own two studs larger). Plain printed-style rings, depth-tested, no additive glow.
   */
  /** QA: a jumper's two ends in world space (end A = the element's lead a). */
  wireEnds(id: string): [[number, number, number], [number, number, number]] | null {
    const component = this.components.get(id);
    const spec = component?.userData.spec as ComponentSpec | undefined;
    if (!component || spec?.kind !== "wire") return null;
    const [a, b] = this.getEndpointWorldPositions(component);
    return [[a.x, a.y, a.z], [b.x, b.y, b.z]];
  }

  /** Circuit Bench: show or hide the solved-current arrows on the jumper wires. */
  setCurrentFlow(enabled: boolean): void {
    this.flowEnabled = enabled;
    if (enabled && !this.flowMarkers) {
      const geometry = new ConeGeometry(0.034, 0.1, 12);
      const material = new MeshBasicMaterial({ name: "current_flow_arrow", color: 0xfbbf24, depthWrite: true });
      this.flowMarkers = new InstancedMesh(geometry, material, 12);
      this.flowMarkers.name = "current_flow_arrows";
      this.flowMarkers.count = 0;
      this.flowMarkers.userData.noPick = true;
      this.flowMarkers.frustumCulled = false;
      this.circuitGroup.add(this.flowMarkers);
    }
    if (!enabled && this.flowMarkers) {
      this.flowMarkers.count = 0;
      this.flowMarkers.visible = false;
    }
    this.flowPhase = 0;
    this.recomputeFlow();
  }

  /** What the flow view shows (inspector note and QA). */
  currentFlowState(): { enabled: boolean; reason: string; wires: Array<{ id: string; amps: number; direction: 1 | -1 }>; arrows: number; moving: boolean; first: [number, number, number] | null; firstPointsTo: [number, number, number] | null } {
    let first: [number, number, number] | null = null;
    let firstPointsTo: [number, number, number] | null = null;
    if (this.flowMarkers?.visible && this.flowMarkers.count > 0) {
      const matrix = new Matrix4();
      this.flowMarkers.getMatrixAt(0, matrix);
      const position = new Vector3().setFromMatrixPosition(matrix);
      const axis = new Vector3(0, 1, 0).applyQuaternion(new Quaternion().setFromRotationMatrix(matrix));
      first = [position.x, position.y, position.z];
      firstPointsTo = [axis.x, axis.y, axis.z];
    }
    return {
      first,
      firstPointsTo,
      enabled: this.flowEnabled,
      reason: this.flowReason,
      wires: this.flowWires.map(({ id, amps, direction }) => ({ id, amps, direction })),
      arrows: this.flowMarkers?.visible ? this.flowMarkers.count : 0,
      moving: this.flowEnabled && this.flowWires.length > 0 && !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
    };
  }

  private recomputeFlow(): void {
    this.flowWires = [];
    const analysis = this.circuitAnalysis;
    if (!this.flowEnabled) this.flowReason = "off";
    else if (!analysis) this.flowReason = "not solved yet";
    else {
      const status = analysis.board.result.status;
      if (analysis.short || status === "short-circuit") this.flowReason = "short circuit";
      else if (status === "open-circuit") this.flowReason = "open circuit";
      else if (status === "no-source") this.flowReason = "no supply in the circuit";
      else if (status !== "ok" && status !== "unsafe") this.flowReason = "the circuit could not be solved";
      else {
        for (const id of ["wire-red", "wire-blue", "wire-yellow"]) {
          const reading = analysis.board.result.elements[id];
          if (!reading?.connected || Math.abs(reading.amps) < 1e-4) continue;
          const speed = MathUtils.clamp(0.12 + 0.1 * Math.log10(Math.abs(reading.amps) / 1e-4), 0.12, 0.5);
          this.flowWires.push({ id, amps: reading.amps, direction: reading.amps > 0 ? 1 : -1, speed });
        }
        this.flowReason = this.flowWires.length ? "solved" : "no current through any jumper wire";
      }
    }
    if (this.flowMarkers) {
      this.flowMarkers.count = this.flowWires.length * 4;
      this.flowMarkers.visible = this.flowEnabled && this.flowWires.length > 0 && this.activeStudio === "circuit";
      this.placeFlowMarkers(0);
    }
  }

  /** Arrowheads along each wire's curve, pointing with the current; they glide unless reduced motion. */
  private placeFlowMarkers(seconds: number): void {
    const markers = this.flowMarkers;
    if (!markers || !markers.visible) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!reduced) this.flowPhase = (this.flowPhase + seconds) % 1000;
    const { point, tangent, up, quaternion, worldQuaternion, dummy } = this.flowTemp;
    let index = 0;
    for (const wire of this.flowWires) {
      const component = this.components.get(wire.id);
      const curve = component?.userData.wireCurve as CatmullRomCurve3 | undefined;
      if (!component || !curve) continue;
      component.updateMatrixWorld();
      component.getWorldQuaternion(worldQuaternion);
      for (let k = 0; k < 4; k += 1) {
        const along = (k / 4 + (reduced ? 0.125 : this.flowPhase * wire.speed)) % 1;
        const t = 0.08 + 0.84 * (wire.direction === 1 ? along : 1 - along);
        curve.getPointAt(t, point);
        curve.getTangentAt(t, tangent).multiplyScalar(wire.direction);
        component.localToWorld(point);
        tangent.applyQuaternion(worldQuaternion).normalize();
        quaternion.setFromUnitVectors(up, tangent);
        // Lift the arrow just outside the insulation so it reads against the wire.
        dummy.position.copy(point).addScaledVector(up, 0.045);
        dummy.quaternion.copy(quaternion);
        dummy.updateMatrix();
        markers.setMatrixAt(index, dummy.matrix);
        index += 1;
      }
    }
    markers.count = index;
    markers.instanceMatrix.needsUpdate = true;
  }

  /** QA: the studs highlighted right now. */
  studHighlightState(): StudHighlight[] {
    const shown = this.studHighlights && Object.values(this.studHighlights).some((mesh) => mesh.visible);
    return shown ? this.lastStudHighlights.map((entry) => ({ ...entry })) : [];
  }

  setStudHighlights(highlights: StudHighlight[]): void {
    this.lastStudHighlights = highlights.filter((entry) => this.snapSockets[entry.socket]).map((entry) => ({ ...entry }));
    const meshes = this.studHighlights;
    if (!meshes) return;
    const dummy = new Object3D();
    for (const tone of Object.keys(meshes) as NetTone[]) {
      const mesh = meshes[tone];
      let count = 0;
      for (const highlight of highlights) {
        const socket = this.snapSockets[highlight.socket];
        if (!socket || highlight.tone !== tone) continue;
        dummy.position.set(socket.x, SNAP_PLATE_TOP + 0.012, socket.z);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.scale.setScalar(highlight.terminal ? 1.3 : 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(count, dummy.matrix);
        count += 1;
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = count > 0 && this.activeStudio === "snapino";
    }
  }

  /**
   * Rescue Signal receiver's view: from across the table, framed on the Snapino lamp (or LED)
   * that is seated, at a distance where the light is the thing to watch.
   */
  viewForReceiver(): void {
    const target = new Vector3(0, BOARD_SURFACE + 0.25, -0.1);
    for (const id of ["sno-l1", "sno-d1"]) {
      const component = this.components.get(id);
      const sockets = component?.userData.sockets as EndpointSockets | undefined;
      if (component && this.isFullyConnected(sockets)) {
        component.getWorldPosition(target);
        target.y = Math.max(target.y, BOARD_SURFACE + 0.2);
        break;
      }
    }
    this.orbit.target.copy(target);
    this.camera.position.set(target.x - 2.2, target.y + 1.5, target.z - 3.4);
    this.orbit.update();
  }

  /** World position of a part's group (visual QA framing), or null if it isn't on this bench. */
  partWorldPosition(id: string): [number, number, number] | null {
    const component = this.components.get(id);
    if (!component) return null;
    const position = component.getWorldPosition(new Vector3());
    return [position.x, position.y, position.z];
  }

  /**
   * Visual QA: where a part's glowing surfaces (the lamp's bulb, the LED's dome) — or the whole
   * part — appear on screen, in client CSS pixels. Used to crop screenshots for pixel checks.
   */
  partScreenRect(id: string): { x: number; y: number; width: number; height: number } | null {
    const component = this.components.get(id);
    if (!component) return null;
    const glowing = new Set((component.userData.glowMaterials ?? []) as MeshStandardMaterial[]);
    const box = new Box3();
    component.updateMatrixWorld(true);
    component.traverse((child) => {
      if (child instanceof Mesh && (!glowing.size || glowing.has(child.material as MeshStandardMaterial))) box.expandByObject(child);
    });
    if (box.isEmpty()) box.setFromObject(component);
    const canvas = this.renderer.domElement.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const corner = new Vector3();
    for (let index = 0; index < 8; index += 1) {
      corner.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z).project(this.camera);
      const x = canvas.left + ((corner.x + 1) / 2) * canvas.width;
      const y = canvas.top + ((1 - corner.y) / 2) * canvas.height;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  resetView(): void {
    if (this.activeStudio === "snapino") {
      this.viewPreset("bench");
      return;
    }
    this.cameraTween = null;
    this.camera.position.set(this.activeStudio === "circuit" ? 6.4 : 7.2, this.activeStudio === "circuit" ? 6.1 : 5.8, this.activeStudio === "circuit" ? 7.7 : 8.6);
    this.orbit.target.set(this.activeStudio === "circuit" ? 0.1 : 0, this.activeStudio === "circuit" ? 0.2 : 0.55, this.activeStudio === "circuit" ? 0 : -0.1);
    this.orbit.update();
  }

  /** QA/close-up helper: place the orbit camera explicitly (clamped by the orbit limits on the next update). */
  setCameraView(position: [number, number, number], target: [number, number, number], unclamped = false): void {
    if (unclamped) {
      this.orbit.minDistance = 0.6;
      this.orbit.maxPolarAngle = MathUtils.degToRad(88);
    }
    this.camera.position.set(...position);
    this.orbit.target.set(...target);
    this.orbit.update();
  }

  /** Renderer counters for the last frame (draw calls, triangles), for QA budgets. */
  renderStats(): { calls: number; triangles: number; geometries: number; textures: number; pixelRatio: number } {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      pixelRatio: this.renderer.getPixelRatio(),
    };
  }

  resetSelectedRotation(): void {
    if (!this.selected) return;
    const id = this.selected.userData.componentId as string;
    const transform = this.snapshotTransform(this.selected);
    transform.rotation = [0, 0, 0];
    this.events.onEdit?.([{ id, transform }], "Rotation reset");
  }

  toggleMagnetism(): boolean {
    this.magnetismEnabled = !this.magnetismEnabled;
    this.events.onStatus(
      this.magnetismEnabled
        ? "Magnetic socket guidance enabled"
        : "Magnetic guidance off · release snapping remains available",
      this.magnetismEnabled ? "valid" : "neutral",
    );
    return this.magnetismEnabled;
  }

  isMagnetismEnabled(): boolean {
    return this.magnetismEnabled;
  }

  placeFromScreen(componentId: string, clientX: number, clientY: number): void {
    const component = this.components.get(componentId);
    const spec = component?.userData.spec as ComponentSpec | undefined;
    if (!component || spec?.studio !== this.activeStudio || !this.events.onClaim(componentId)) return;
    this.select(component);
    this.updatePointer(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)) {
      component.position.copy(this.dragPoint);
      component.position.y = DRAG_Y;
      component.updateMatrixWorld(true);
      this.finishPlacement(component);
      this.events.onRelease(componentId);
    }
  }

  /**
   * Applies a part state from the room. `force`: an accepted edit or the room's authoritative
   * state — it ends a local drag of the part. `propsOnly`: this participant's own later moves
   * of the part are still in flight, so only values and the switch state apply.
   */
  applyRemoteTransform(componentId: string, transform: SharedTransform, animate = true, options: { force?: boolean; propsOnly?: boolean } = {}): void {
    const component = this.components.get(componentId);
    if (!component) return;
    if (options.propsOnly) {
      this.applyPartValues(component, transform);
      this.evaluateCurrentSystem();
      return;
    }
    if (options.force) this.abortDrag(component);
    if (transform.activeEndpoint !== undefined && transform.endpoints) {
      const remoteIndex = transform.activeEndpoint;
      if (this.draggingEndpoint?.component === component && this.draggingEndpoint.index === remoteIndex) return;
      const endpoints = this.getEndpointPositions(component);
      endpoints[remoteIndex].fromArray(transform.endpoints[remoteIndex]);
      const sockets = this.cloneEndpointSockets(component.userData.sockets as EndpointSockets) ?? [null, null];
      sockets[remoteIndex] = transform.sockets?.[remoteIndex] ?? null;
      component.userData.sockets = sockets.some((socket) => socket !== null) ? sockets : null;
      this.updateFlexibleWireGeometry(component, sockets.some((socket) => socket !== null));
      component.updateMatrixWorld(true);
      if (component === this.selected) this.selectionBox.update();
      this.evaluateCurrentSystem();
      return;
    }
    this.applyPartValues(component, transform);
    // Only an active local drag outranks a teammate's move; a merely selected part follows it.
    if (component === this.dragging || (component === this.transform.object && this.transform.dragging)) {
      this.evaluateCurrentSystem();
      return;
    }
    const target = new Vector3().fromArray(transform.position);
    const rotation = new Euler(...transform.rotation, "XYZ");
    const tween = this.remoteTweens.get(componentId);
    const from = tween?.base ?? component.position;
    if (animate && component.parent?.visible && from.distanceToSquared(target) > 1e-6) {
      this.remoteTweens.set(componentId, { base: from.clone(), target, rotation });
      if (tween) component.position.copy(tween.base);
    } else {
      this.remoteTweens.delete(componentId);
      component.position.copy(target);
      component.rotation.copy(rotation);
    }
    component.userData.sockets = transform.sockets ?? null;
    if (transform.endpoints) {
      component.userData.endpointPositions = [
        new Vector3().fromArray(transform.endpoints[0]),
        new Vector3().fromArray(transform.endpoints[1]),
      ] as EndpointPair;
    }
    this.updateFlexibleWireFromSockets(component);
    component.updateMatrixWorld(true);
    if (component === this.selected) this.selectionBox.update();
    this.evaluateCurrentSystem();
  }

  private applyPartValues(component: Group, transform: SharedTransform): void {
    if (typeof transform.on === "boolean") this.setSwitch(component, transform.on);
    if (transform.props) {
      const spec = component.userData.spec as ComponentSpec;
      const kind = propKind(spec);
      const clean = kind ? sanitizeProps(kind, transform.props) : null;
      if (clean) {
        component.userData.props = clean;
        this.refreshPartAppearance(component);
      }
    }
  }

  /**
   * The room refused this participant's move or claim: its state replaces the local guess
   * (null = the part was never changed through the room, i.e. its default). `superseded`: a
   * newer move of ours is still in flight and decides, so keep the position for now.
   */
  revertPart(componentId: string, transform: SharedTransform | null, superseded = false): void {
    const component = this.components.get(componentId);
    if (!component) return;
    const target = transform ?? this.defaultTransform(componentId);
    if (!target) return;
    if (superseded) {
      this.applyPartValues(component, target);
      this.evaluateCurrentSystem();
      return;
    }
    this.applyRemoteTransform(componentId, target, true, { force: true });
  }

  /**
   * QA only (`?qa`): drops one cable end into a socket through the same path as a pointer drag —
   * claim, snapped move, release in the same task — so tests exercise the real room ordering.
   */
  qaDropEndpoint(componentId: string, index: 0 | 1, socketIndex: number): boolean {
    const component = this.components.get(componentId);
    const socket = this.sockets[socketIndex];
    const spec = component?.userData.spec as ComponentSpec | undefined;
    if (!component || !socket || (spec?.kind !== "wire" && spec?.kind !== "hose")) return false;
    const resourceId = this.endpointResourceId(componentId, index);
    if (!this.events.onClaim(resourceId)) return false;
    this.getEndpointPositions(component)[index].copy(component.worldToLocal(socket.clone()));
    const sockets = this.cloneEndpointSockets(component.userData.sockets as EndpointSockets) ?? [null, null];
    sockets[index] = socketIndex;
    component.userData.sockets = sockets;
    this.updateFlexibleWireGeometry(component, true);
    component.updateMatrixWorld(true);
    this.emitTransform(component, true, index);
    this.evaluateCurrentSystem();
    this.events.onRelease(resourceId);
    return true;
  }

  /** Ends a local drag of the part, if any (the room refused the claim). */
  abortDragOf(componentId: string): void {
    const component = this.components.get(componentId);
    if (component) this.abortDrag(component);
  }

  private abortDrag(component: Group): void {
    const id = component.userData.componentId as string;
    if (this.dragging === component) {
      const resourceId = this.draggingEndpoint?.resourceId ?? id;
      if (this.dragPointerId !== null && this.renderer.domElement.hasPointerCapture(this.dragPointerId)) {
        this.renderer.domElement.releasePointerCapture(this.dragPointerId);
      }
      this.dragging = null;
      this.draggingEndpoint = null;
      this.dragPointerId = null;
      this.orbit.enabled = true;
      this.hideSnapPreview();
      this.flexMotion.delete(id);
      this.events.onDragAborted?.(resourceId);
    } else if (this.transform.object === component && this.transform.dragging) {
      // Detaching mid-drag drops the gizmo's mouseUp, so no final move is sent.
      this.transform.detach();
      this.orbit.enabled = true;
      this.events.onDragAborted?.(id);
    }
  }

  /** A part's state when nobody has changed it: in its tray slot, default values, switch off. */
  defaultTransform(componentId: string): SharedTransform | null {
    const transform = this.homeTransform(componentId);
    const spec = this.components.get(componentId)?.userData.spec as ComponentSpec | undefined;
    if (!transform || !spec) return null;
    const props = defaultProps(spec);
    if (props) transform.props = props;
    else delete transform.props;
    if (spec.kind === "snapswitch") transform.on = false;
    return transform;
  }

  setOwner(componentId: string, owner: HandOwner | null): void {
    if (owner) this.remoteOwners.set(componentId, owner);
    else this.remoteOwners.delete(componentId);
    const endpointMatch = componentId.match(/^(.*)::endpoint-([01])$/);
    const object = this.components.get(endpointMatch?.[1] ?? componentId);
    if (!object) return;
    if (owner) {
      const endpointIndex = endpointMatch ? (Number(endpointMatch[2]) as 0 | 1) : null;
      this.remoteHands.grab(componentId, owner, (out) => {
        if (!object.visible || !object.parent?.visible) return false;
        if (endpointIndex === null) object.getWorldPosition(out);
        else object.localToWorld(out.copy(this.getEndpointPositions(object)[endpointIndex]));
        return true;
      });
    } else {
      this.remoteHands.release(componentId);
    }
    if (endpointMatch) {
      const index = Number(endpointMatch[2]) as 0 | 1;
      const indicator = ((object.userData.endpointIndicators ?? []) as Mesh<TorusGeometry, MeshBasicMaterial>[])[index];
      if (indicator) indicator.material.color.setHex(owner ? (owner.kind === "agent" ? 0xb794ff : 0x5cc8ff) : 0x39ff9a);
      return;
    }
    object.userData.owner = owner;
  }

  captureAttempt(summary = "Workbench state saved"): SceneSnapshot {
    const transforms = this.getSharedTransforms();
    return {
      id: `attempt-${++this.attemptNumber}`,
      createdAt: Date.now(),
      transforms,
      summary,
    };
  }

  getSharedTransforms(): Record<string, SharedTransform> {
    const transforms: Record<string, SharedTransform> = {};
    for (const [id, component] of this.components) {
      transforms[id] = this.snapshotTransform(component);
    }
    return transforms;
  }

  applySharedState(transforms: Record<string, SharedTransform>): void {
    for (const [id, transform] of Object.entries(transforms)) {
      this.applyRemoteTransform(id, transform, false);
    }
    this.events.onStatus("Shared circuit synchronized", "valid");
  }

  saveAttempt(summary = "Workbench state saved"): SceneSnapshot {
    const snapshot = this.captureAttempt(summary);
    this.events.onAttempt(snapshot);
    return snapshot;
  }

  /** Restoring a saved attempt is one atomic shared edit (it shows once the room accepts it). */
  restoreAttempt(snapshot: SceneSnapshot): void {
    const changes = Object.entries(snapshot.transforms).map(([id, transform]) => {
      const clean = { ...transform };
      delete clean.activeEndpoint;
      return { id, transform: clean };
    });
    this.events.onEdit?.(changes, `Restored ${snapshot.id}`);
  }

  /** Re-run the active studio's evaluation quietly (refreshes listeners such as the meter). */
  reevaluate(): void {
    this.evaluateCurrentSystem(false);
  }

  checkCircuit(): boolean {
    return this.evaluateCurrentSystem(true);
  }

  loadCircuitDemo(): void {
    if (this.activeStudio !== "circuit") return;
    // Battery + at r1c5, − at r1c7. The 1 kΩ resistor (r2c4→c7) limits the red LED (anode
    // r3c5 on +, cathode r3c4) to about 7 mA at 9 V, inside its 20 mA rating.
    this.submitLayout({
      "battery-9v": [21, 23],
      "resistor-1k": [36, 39],
      "led-red": [53, 52],
    }, "Diagnostic LED path connected");
  }

  /**
   * A demo layout as one atomic shared edit: seats each part exactly as a snapped move would,
   * keeps everything else on the bench as it is, and shows once the room accepts it.
   */
  private submitLayout(layout: Record<string, [number, number]>, label: string, overrides: Record<string, Partial<SharedTransform>> = {}): void {
    const changes: Array<{ id: string; transform: SharedTransform }> = [];
    for (const [id, pair] of Object.entries(layout)) {
      const transform = this.placementTransform(id, pair);
      if (transform) changes.push({ id, transform: { ...transform, ...overrides[id] } });
    }
    if (changes.length) this.events.onEdit?.(changes, label);
  }

  /**
   * The shared transform that seats a Circuit Bench part's leads in two breadboard sockets,
   * exactly as a teammate's snapped move would. Pure: nothing in this scene changes until the
   * transform comes back through the room. Used by the AI teammate to act like a participant.
   */
  placementTransform(componentId: string, sockets: [number, number]): SharedTransform | null {
    const component = this.components.get(componentId);
    const spec = component?.userData.spec as ComponentSpec | undefined;
    if (!component || !spec) return null;
    const grid = this.socketsForStudio(spec.studio);
    const a = grid[sockets[0]];
    const b = grid[sockets[1]];
    if (!a || !b || sockets[0] === sockets[1]) return null;
    const midpoint = a.clone().add(b).multiplyScalar(0.5);
    const direction = b.clone().sub(a);
    const rotationY = Math.atan2(-direction.z, direction.x);
    const transform: SharedTransform = {
      position: [midpoint.x, DRAG_Y, midpoint.z],
      rotation: [0, rotationY, 0],
      sockets: [sockets[0], sockets[1]],
    };
    const props = this.getPartProps(componentId);
    if (props) transform.props = props;
    if (spec.kind === "snapswitch") transform.on = Boolean(component.userData.switchOn);
    if (spec.kind === "wire" || spec.kind === "hose") {
      const frame = new Object3D();
      frame.position.set(midpoint.x, DRAG_Y, midpoint.z);
      frame.rotation.set(0, rotationY, 0);
      frame.updateMatrixWorld(true);
      transform.endpoints = [
        frame.worldToLocal(a.clone()).toArray() as [number, number, number],
        frame.worldToLocal(b.clone()).toArray() as [number, number, number],
      ];
    }
    return transform;
  }

  /** The shared transform that returns a part to its tray slot, off the board. */
  homeTransform(componentId: string): SharedTransform | null {
    const component = this.components.get(componentId);
    const home = component?.userData.home as Vector3 | undefined;
    if (!component || !home) return null;
    const spec = component.userData.spec as ComponentSpec;
    const transform: SharedTransform = {
      position: home.toArray() as [number, number, number],
      rotation: [0, 0, 0],
      sockets: null,
    };
    const props = this.getPartProps(componentId);
    if (props) transform.props = props;
    if (spec.kind === "wire" || spec.kind === "hose") {
      const half = spec.leadSeparation / 2;
      transform.endpoints = [[-half, 0, 0], [half, 0, 0]];
    }
    return transform;
  }

  private socketsForStudio(studio: StudioKind): Vector3[] {
    if (studio === "greenhouse") return this.greenhouseSockets;
    if (studio === "snap" || studio === "snapino") return this.snapSockets;
    return this.circuitSockets;
  }

  /** What a project file may contain for `studio`: its part ids, value kinds and socket range. */
  studioCatalog(studio: StudioKind): { studio: StudioKind; parts: Record<string, "resistor" | "battery" | null>; socketCount: number; switches: string[]; sharedSockets: boolean } {
    const parts: Record<string, "resistor" | "battery" | null> = {};
    for (const spec of COMPONENTS) if (spec.studio === studio) parts[spec.id] = propKind(spec);
    return {
      studio,
      parts,
      socketCount: this.socketsForStudio(studio).length,
      switches: COMPONENTS.filter((spec) => spec.studio === studio && spec.kind === "snapswitch").map((spec) => spec.id),
      // Snap Lab and Snapino parts stack on shared studs; breadboard and greenhouse holes do not.
      sharedSockets: studio === "snap" || studio === "snapino",
    };
  }

  /** The values a part starts with (used by reset). */
  defaultPartProps(componentId: string): PartProps | null {
    const spec = this.components.get(componentId)?.userData.spec as ComponentSpec | undefined;
    return spec ? defaultProps(spec) : null;
  }

  /** Current electrical values of a resistor or battery; null for parts without any. */
  getPartProps(componentId: string): PartProps | null {
    const props = this.components.get(componentId)?.userData.props as PartProps | undefined;
    return props ? { ...props } : null;
  }

  /** The latest Circuit Bench analysis from the shared DC engine. */
  getCircuitAnalysis(): CircuitAnalysis | null {
    return this.circuitAnalysis;
  }

  /** Projects a part's anchor to client coordinates (for measurement tags); null if hidden. */
  projectComponent(componentId: string): { x: number; y: number } | null {
    const component = this.components.get(componentId);
    if (!component || !component.visible || !component.parent?.visible) return null;
    const point = component.getWorldPosition(new Vector3());
    point.y += 0.55;
    point.project(this.camera);
    if (point.z > 1 || point.z < -1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((point.x + 1) / 2) * rect.width, y: rect.top + ((1 - point.y) / 2) * rect.height };
  }

  /** Lets go of a locally selected part so a teammate's move is not masked by the gizmo. */
  yieldComponent(componentId: string): void {
    if (this.selected?.userData.componentId === componentId) this.clearSelection();
  }

  loadSnapDemo(): void {
    if (this.activeStudio !== "snap") return;
    // studs are row * 9 + col: B1+ (r1c0) → W4 → W3 → M1 → L1 → S1 → W2 → B1− (r1c3)
    this.submitLayout({
      "snap-b1": [9, 12],
      "snap-w4": [9, 45],
      "snap-w3a": [45, 48],
      "snap-m1": [48, 50],
      "snap-l1": [50, 32],
      "snap-s1": [32, 14],
      "snap-w2": [14, 12],
    }, "Series lamp + motor loop connected", { "snap-s1": { on: true } });
  }

  /** Keyboard/assistive path to operate the selected slide switch. */
  toggleSelectedSwitch(): boolean {
    if (!this.selected || (this.selected.userData.spec as ComponentSpec).kind !== "snapswitch") return false;
    this.toggleSwitch(this.selected);
    return true;
  }

  private toggleSwitch(component: Group): void {
    const id = component.userData.componentId as string;
    const owner = this.remoteOwners.get(id);
    if (owner) {
      this.events.onStatus(`${owner.name} is holding S1`, "warning");
      return;
    }
    // A switch flip is a shared edit: it shows (here and for everyone) once the room accepts it.
    const transform = this.snapshotTransform(component);
    transform.on = !component.userData.switchOn;
    this.events.onEdit?.([{ id, transform }], `S1 switched ${transform.on ? "on" : "off"}`);
  }

  private setSwitch(component: Group, on: boolean): void {
    component.userData.switchOn = on;
    const knob = component.getObjectByName("switch_knob");
    if (knob) knob.position.x = on ? 0.1 : -0.1;
  }

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const component = this.pickComponent(event.clientX, event.clientY);
    if (component && (component.userData.spec as ComponentSpec).kind === "snapswitch") this.toggleSwitch(component);
  };

  loadGreenhouseDemo(): void {
    if (this.activeStudio !== "greenhouse") return;
    this.submitLayout({
      "soil-sensor": [0, 1],
      "temp-sensor": [2, 3],
      "light-sensor": [4, 5],
      "farm-controller": [6, 8],
      "solar-panel": [9, 11],
      "water-pump": [12, 14],
      "irrigation-hose": [15, 18],
      "vent-fan": [19, 21],
    }, "Field test layout connected");
  }

  dispose(): void {
    this.remoteHands.dispose();
    this.remoteTweens.clear();
    if (this.flowMarkers) {
      this.flowMarkers.geometry.dispose();
      (this.flowMarkers.material as Material).dispose();
      this.flowMarkers.removeFromParent();
      this.flowMarkers = null;
    }
    this.resizeObserver.disconnect();
    this.renderer.setAnimationLoop(null);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown, true);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove, true);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp, true);
    this.renderer.domElement.removeEventListener("pointercancel", this.onPointerCancel, true);
    window.removeEventListener("blur", this.onWindowBlur);
    this.orbit.dispose();
    this.transform.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /**
   * Studio lighting for a bench: soft sky/ground fill, one shadow-casting key over the board,
   * a warm pendant pool, a cool rim, and a dim room environment for metal reflections. No
   * bloom or post-processing (labels and lead details stay crisp).
   */
  private setupLighting(): void {
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();
    const sky = new HemisphereLight(0xe6edf7, 0x4a3f33, 0.55);
    this.scene.add(sky);
    const tier = QUALITY[this.quality];
    const key = new DirectionalLight(0xfff4e6, 2.1);
    key.position.set(3.2, 8.5, 4.4);
    key.target.position.set(-0.4, 0, 0);
    key.castShadow = tier.shadows;
    if (tier.shadows) {
      key.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
      key.shadow.camera.left = -5.5;
      key.shadow.camera.right = 5.5;
      key.shadow.camera.top = 4.5;
      key.shadow.camera.bottom = -4.5;
      key.shadow.camera.near = 2;
      key.shadow.camera.far = 20;
      key.shadow.bias = -0.0003;
      key.shadow.normalBias = 0.015;
      key.shadow.radius = 4;
    }
    this.keyLight = key;
    this.scene.add(key, key.target);
    const pendant = new SpotLight(0xffe6c4, 42, 22, MathUtils.degToRad(40), 0.75, 1.6);
    pendant.position.set(-0.4, 9.2, 0.6);
    pendant.target.position.set(-0.6, 0, 0);
    this.scene.add(pendant, pendant.target);
    const rim = new DirectionalLight(0x9ab8ef, 0.55);
    rim.position.set(-5, 4, -4);
    this.scene.add(rim);
  }

  private setupTable(): void {
    const tabletop = new Mesh(
      new BoxGeometry(11, 0.26, 7.8),
      new MeshStandardMaterial({ color: COLORS.wood, roughness: 0.78, metalness: 0.02 }),
    );
    tabletop.position.y = -0.13;
    tabletop.receiveShadow = true;
    this.scene.add(tabletop);
    this.proceduralTable.push(tabletop);

    const tray = new Mesh(
      new BoxGeometry(2.45, 0.12, 5.7),
      new MeshStandardMaterial({ color: COLORS.tray, roughness: 0.82 }),
    );
    tray.position.set(3.55, 0.06, 0);
    tray.receiveShadow = true;
    this.scene.add(tray);
  }

  private setupBreadboard(): void {
    const rows = socketRows();
    const columns: number[] = [];
    for (let col = 0; col < COLS; col += 1) columns.push(-((COLS - 1) * PITCH) / 2 + col * PITCH);
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        // Picking, snapping and the rendered holes all come from these same coordinates.
        this.circuitSockets.push(new Vector3(BOARD_X + columns[col], BOARD_TOP + 0.015, rows[row]));
      }
    }
    this.circuitGroup.add(createBreadboard({ centerX: BOARD_X, columns, rows }));
  }

  private setupGreenhouse(): void {
    const floor = new Mesh(
      new BoxGeometry(8.6, 0.18, 5.9),
      new MeshStandardMaterial({ color: 0x5d4934, roughness: 0.9 }),
    );
    floor.position.y = 0.02;
    floor.receiveShadow = true;
    this.greenhouseGroup.add(floor);

    const soilMaterial = new MeshStandardMaterial({ color: 0x503621, roughness: 1 });
    this.greenhouseGroup.userData.soilMaterial = soilMaterial;
    const bed = new Mesh(new BoxGeometry(4.1, 0.45, 2.35), soilMaterial);
    bed.position.set(-1.35, 0.34, -0.55);
    bed.receiveShadow = true;
    this.greenhouseGroup.add(bed);
    const bedFrameMaterial = new MeshStandardMaterial({ color: 0x9b6a3d, roughness: 0.82 });
    for (const z of [-1.77, 0.67]) {
      const rail = new Mesh(new BoxGeometry(4.35, 0.42, 0.16), bedFrameMaterial);
      rail.position.set(-1.35, 0.48, z);
      this.greenhouseGroup.add(rail);
    }
    for (const x of [-3.45, 0.75]) {
      const rail = new Mesh(new BoxGeometry(0.16, 0.42, 2.35), bedFrameMaterial);
      rail.position.set(x, 0.48, -0.55);
      this.greenhouseGroup.add(rail);
    }

    const stemMaterial = new MeshStandardMaterial({ color: 0x2f7d3f, roughness: 0.72 });
    const leafMaterial = new MeshStandardMaterial({ color: 0x48b95b, roughness: 0.68 });
    const plantRoots: Group[] = [];
    for (const x of [-2.75, -1.7, -0.65, 0.3]) {
      for (const z of [-1.22, 0.1]) {
        const plant = new Group();
        const stem = new Mesh(new CylinderGeometry(0.035, 0.05, 0.72, 8), stemMaterial);
        stem.position.y = 0.7;
        plant.add(stem);
        for (const [dx, dy, rotation] of [[-0.16, 0.84, -0.52], [0.16, 1.02, 0.52], [-0.14, 1.17, -0.42]] as const) {
          const leaf = new Mesh(new SphereGeometry(0.16, 12, 8), leafMaterial);
          leaf.scale.set(1.45, 0.34, 0.68);
          leaf.position.set(dx, dy, 0);
          leaf.rotation.z = rotation;
          plant.add(leaf);
        }
        plant.position.set(x, 0, z);
        plantRoots.push(plant);
        this.greenhouseGroup.add(plant);
      }
    }
    this.greenhouseGroup.userData.plants = plantRoots;

    const frameMaterial = new MeshStandardMaterial({ color: 0xd7e2e4, roughness: 0.32, metalness: 0.72 });
    for (const x of [-3.65, 0.95]) {
      for (const z of [-1.95, 0.9]) {
        const post = new Mesh(new BoxGeometry(0.08, 2.85, 0.08), frameMaterial);
        post.position.set(x, 1.45, z);
        this.greenhouseGroup.add(post);
      }
    }
    for (const z of [-1.95, 0.9]) {
      const beam = new Mesh(new BoxGeometry(4.68, 0.08, 0.08), frameMaterial);
      beam.position.set(-1.35, 2.88, z);
      this.greenhouseGroup.add(beam);
    }
    const ridge = new Mesh(new BoxGeometry(4.68, 0.08, 0.08), frameMaterial);
    ridge.position.set(-1.35, 3.5, -0.52);
    this.greenhouseGroup.add(ridge);
    const glazingMaterial = new MeshPhysicalMaterial({ color: 0xbde9dd, transparent: true, opacity: 0.2, roughness: 0.12, transmission: 0.42, clearcoat: 0.48 });
    for (const [z, tilt] of [[-1.25, -0.42], [0.2, 0.42]] as const) {
      const canopy = new Mesh(new BoxGeometry(4.72, 0.035, 1.58), glazingMaterial);
      canopy.position.set(-1.35, 3.19, z);
      canopy.rotation.x = tilt;
      this.greenhouseGroup.add(canopy);
    }

    const tank = new Mesh(
      new CylinderGeometry(0.66, 0.66, 1.72, 32),
      new MeshPhysicalMaterial({ color: 0x237aa1, roughness: 0.25, metalness: 0.12, transparent: true, opacity: 0.82 }),
    );
    tank.position.set(2.85, 0.92, -1.15);
    this.greenhouseGroup.add(tank);
    const water = new Mesh(
      new CylinderGeometry(0.6, 0.6, 1.08, 32),
      new MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0c4a6e, emissiveIntensity: 0.45, transparent: true, opacity: 0.72 }),
    );
    water.position.set(2.85, 0.68, -1.15);
    this.greenhouseGroup.add(water);
    this.greenhouseGroup.userData.water = water;
    const tankMetal = new MeshStandardMaterial({ color: 0xb8c6cc, roughness: 0.28, metalness: 0.76 });
    for (const y of [0.35, 1.5]) {
      const band = new Mesh(new TorusGeometry(0.665, 0.035, 10, 36), tankMetal);
      band.rotation.x = Math.PI / 2;
      band.position.set(2.85, y, -1.15);
      this.greenhouseGroup.add(band);
    }
    const lid = new Mesh(new CylinderGeometry(0.7, 0.66, 0.12, 32), tankMetal);
    lid.position.set(2.85, 1.82, -1.15);
    this.greenhouseGroup.add(lid);
    const cap = new Mesh(new CylinderGeometry(0.16, 0.16, 0.14, 24), new MeshStandardMaterial({ color: 0x1f3642, roughness: 0.55 }));
    cap.position.set(2.85, 1.94, -1.15);
    this.greenhouseGroup.add(cap);
    const gauge = new Mesh(new CircleGeometry(0.16, 24), new MeshStandardMaterial({ color: 0xe7f2f4, roughness: 0.42 }));
    gauge.position.set(2.85, 1.2, -0.48);
    this.greenhouseGroup.add(gauge);
    const needle = new Mesh(new BoxGeometry(0.018, 0.12, 0.014), new MeshBasicMaterial({ color: 0xef4444 }));
    needle.position.set(2.89, 1.23, -0.465);
    needle.rotation.z = -0.65;
    this.greenhouseGroup.add(needle);
    const supplyCurve = new CatmullRomCurve3([
      new Vector3(2.85, 0.34, -1.15),
      new Vector3(2.2, 0.2, -1.05),
      new Vector3(1.55, 0.22, -0.25),
      new Vector3(0.65, 0.24, -0.35),
    ]);
    const supplyPipe = new Mesh(
      new TubeGeometry(supplyCurve, 42, 0.055, 12, false),
      new MeshPhysicalMaterial({ color: 0x2ea663, roughness: 0.68, clearcoat: 0.16 }),
    );
    this.greenhouseGroup.add(supplyPipe);

    const panel = new Mesh(
      new BoxGeometry(5.8, 0.26, 1.05),
      new MeshStandardMaterial({ color: 0x17293a, roughness: 0.6, metalness: 0.22 }),
    );
    panel.position.set(0.1, 0.34, 2.05);
    this.greenhouseGroup.add(panel);
    const socketMaterial = new MeshStandardMaterial({ color: 0x0a1018, roughness: 0.38, metalness: 0.65 });
    const ringMaterial = new MeshStandardMaterial({ color: 0x57d68d, emissive: 0x0b4f2b, emissiveIntensity: 0.7, roughness: 0.4 });
    const terminalXs = [-2.55, -2.07, -1.59, -1.11, -0.63, -0.15, 0.33, 0.81, 1.29, 1.77, 2.25, 2.73];
    for (const z of [1.85, 2.22]) {
      for (const x of terminalXs) {
        this.greenhouseSockets.push(new Vector3(x, BOARD_TOP + 0.05, z));
        const ring = new Mesh(new RingGeometry(0.062, 0.095, 18), ringMaterial);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x, BOARD_TOP + 0.07, z);
        this.greenhouseGroup.add(ring);
        const port = new Mesh(new CylinderGeometry(0.03, 0.025, 0.05, 10), socketMaterial);
        port.rotation.x = Math.PI;
        port.position.set(x, BOARD_TOP + 0.045, z);
        this.greenhouseGroup.add(port);
      }
    }
  }

  private setupComponents(): void {
    const circuitPositions: Array<[number, number, number]> = [
      [3.15, DRAG_Y, -2.2],
      [3.95, DRAG_Y, -2.2],
      [3.15, DRAG_Y, -1.1],
      [3.95, DRAG_Y, -1.1],
      [3.15, DRAG_Y, 0.1],
      [3.95, DRAG_Y, 0.55],
      [3.55, DRAG_Y, 1.55],
      [3.55, DRAG_Y, 2.45],
    ];
    const greenhousePositions: Array<[number, number, number]> = [
      [2.2, DRAG_Y, 0.15],
      [3.05, DRAG_Y, 0.15],
      [3.85, DRAG_Y, 0.15],
      [2.35, DRAG_Y, 0.95],
      [3.55, DRAG_Y, 0.95],
      [2.9, DRAG_Y, 1.65],
      [4.0, DRAG_Y, 1.75],
      [3.15, DRAG_Y, 2.5],
    ];
    const snapPositions = [-2.45, -1.75, -1.05, -0.35, 0.35, 1.05, 1.75, 2.45]
      .map((z): [number, number, number] => [3.55, DRAG_Y, z]);
    const layouts: Record<StudioKind, { positions: Array<[number, number, number]>; specs: ComponentSpec[]; group: Group }> = {
      circuit: { positions: circuitPositions, specs: CIRCUIT_COMPONENTS, group: this.circuitGroup },
      greenhouse: { positions: greenhousePositions, specs: GREENHOUSE_COMPONENTS, group: this.greenhouseGroup },
      snap: { positions: snapPositions, specs: SNAP_COMPONENTS, group: this.snapGroup },
      snapino: {
        positions: [-2.6, -1.95, -1.3, -0.65, 0, 0.65, 1.3, 1.95, 2.6].map((z): [number, number, number] => [3.55, DRAG_Y, z]),
        specs: SNAPINO_COMPONENTS,
        group: this.snapinoGroup,
      },
    };
    COMPONENTS.forEach((spec) => {
      const component = this.createComponent(spec);
      const layout = layouts[spec.studio];
      component.position.set(...layout.positions[layout.specs.indexOf(spec)]);
      component.userData.componentId = spec.id;
      component.userData.spec = spec;
      component.userData.sockets = null;
      component.userData.home = component.position.clone();
      const kind = propKind(spec);
      if (kind) component.userData.props = defaultProps(spec);
      component.traverse((child) => {
        child.userData.componentRoot = component;
        if (child instanceof Mesh) {
          // Decals, glows, hit targets and indicators (unlit materials) never cast shadows.
          const unlit = child.material instanceof MeshBasicMaterial || child.userData.contactShadow;
          child.castShadow = !unlit;
          child.receiveShadow = !unlit;
        }
      });
      this.components.set(spec.id, component);
      layout.group.add(component);
    });
  }

  private createComponent(spec: ComponentSpec): Group {
    const group = new Group();
    const metal = new MeshStandardMaterial({ color: COLORS.metal, roughness: 0.33, metalness: 0.82 });

    if (spec.kind === "led") {
      group.add(createLedModel({ color: spec.color, leadSeparation: spec.leadSeparation, surfaceY: SURFACE_LOCAL_Y }));
      const model = group.children[group.children.length - 1];
      Object.assign(group.userData, {
        glowMaterials: model.userData.glowMaterials,
        ledCore: model.userData.ledCore,
        glowLight: model.userData.glowLight,
        scorchMaterial: model.userData.scorchMaterial,
      });
    }

    if (spec.kind === "resistor") {
      const model = createResistorModel({ ohms: defaultProps(spec)?.ohms ?? 1000, leadSeparation: spec.leadSeparation, surfaceY: SURFACE_LOCAL_Y });
      group.add(model);
      group.userData.refreshAppearance = model.userData.refreshAppearance;
    }

    if (spec.kind === "wire" || spec.kind === "hose") {
      const half = spec.leadSeparation / 2;
      group.userData.endpointPositions = [
        new Vector3(-half, 0, 0),
        new Vector3(half, 0, 0),
      ] as EndpointPair;
      const curve = new CatmullRomCurve3([
        new Vector3(-half, 0, 0),
        new Vector3(-half * 0.5, 0.34, -0.04),
        new Vector3(half * 0.5, 0.34, 0.04),
        new Vector3(half, 0, 0),
      ]);
      const insulation = new MeshPhysicalMaterial({
        name: spec.kind === "hose" ? "hose_pvc" : "wire_insulation_pvc",
        color: spec.color,
        roughness: spec.kind === "hose" ? 0.72 : 0.42,
        metalness: 0,
        clearcoat: spec.kind === "hose" ? 0.12 : 0.45,
        clearcoatRoughness: 0.3,
      });
      const body = new Mesh(new TubeGeometry(curve, 28, spec.kind === "hose" ? 0.075 : WIRE_RADIUS, 10, false), insulation);
      body.userData.flexibleWireBody = true;
      group.userData.wireBody = body;
      group.add(body);
      const wireTips: Mesh[] = [];
      const wireCollars: Mesh[] = [];
      const endpointIndicators: Mesh<TorusGeometry, MeshBasicMaterial>[] = [];
      const endpointHitTargets: Mesh<SphereGeometry, MeshBasicMaterial>[] = [];
      for (const [index, x] of [-half, half].entries()) {
        // Jumper: a bare tinned conductor that enters the hole; hose: a brass barb.
        const tip = spec.kind === "hose"
          ? new Mesh(new CylinderGeometry(0.055, 0.055, 0.34, 10), metal)
          : new Mesh(new CylinderGeometry(0.021, 0.021, WIRE_TIP_LENGTH, 10), palette.tinnedLead());
        tip.position.set(x, spec.kind === "hose" ? -0.14 : WIRE_TIP_CENTER, 0);
        tip.userData.endpointIndex = index;
        group.add(tip);
        // Jumper: the insulation's cut end, a short sleeve in the wire's own color.
        const collar = spec.kind === "hose"
          ? new Mesh(new CylinderGeometry(0.105, 0.095, 0.13, 16), new MeshStandardMaterial({ color: 0xb88b3e, roughness: 0.34, metalness: 0.7 }))
          : new Mesh(new CylinderGeometry(WIRE_RADIUS, WIRE_RADIUS, 0.02, 12), insulation);
        collar.position.set(x, spec.kind === "hose" ? 0.015 : WIRE_INSULATION_END + 0.01, 0);
        collar.userData.endpointIndex = index;
        group.add(collar);
        wireTips.push(tip);
        wireCollars.push(collar);

        const indicator = new Mesh(
          new TorusGeometry(spec.kind === "hose" ? 0.215 : 0.14, spec.kind === "hose" ? 0.036 : 0.028, 10, 28),
          new MeshBasicMaterial({
            color: 0x39ff9a,
            transparent: true,
            opacity: 1,
            depthWrite: false,
            depthTest: false,
            blending: AdditiveBlending,
          }),
        );
        indicator.rotation.x = Math.PI / 2;
        indicator.position.set(x, 0.025, 0);
        indicator.visible = false;
        indicator.renderOrder = 12;
        indicator.userData.baseScale = 1;
        indicator.userData.endpointIndex = index;
        group.add(indicator);
        endpointIndicators.push(indicator);

        const hitTarget = new Mesh(
          new SphereGeometry(spec.kind === "hose" ? 0.2 : 0.145, 16, 10),
          new MeshBasicMaterial({ transparent: true, opacity: 0.001, depthWrite: false }),
        );
        hitTarget.position.set(x, 0, 0);
        hitTarget.userData.endpointIndex = index;
        hitTarget.userData.endpointHandle = true;
        group.add(hitTarget);
        endpointHitTargets.push(hitTarget);
      }
      group.userData.wireCollars = wireCollars;
      group.userData.wireTips = wireTips;
      group.userData.endpointIndicators = endpointIndicators;
      group.userData.endpointHitTargets = endpointHitTargets;
      group.userData.restLength = spec.leadSeparation;
    }

    if (spec.kind === "battery") {
      const model = createBatteryModel({ volts: defaultProps(spec)?.volts ?? 9, leadSeparation: spec.leadSeparation, surfaceY: SURFACE_LOCAL_Y });
      group.add(model);
      group.userData.refreshAppearance = model.userData.refreshAppearance;
    }

    if (spec.kind === "sensor") {
      const sensorMaterial = new MeshStandardMaterial({ color: spec.color, roughness: 0.42, metalness: 0.12 });
      const head = new Mesh(new RoundedBoxGeometry(0.48, 0.3, 0.34, 4, 0.055), sensorMaterial);
      head.position.y = 0.32;
      group.add(head);
      const lens = new Mesh(
        new SphereGeometry(0.075, 16, 10),
        new MeshStandardMaterial({ color: 0xe8fff4, emissive: spec.color, emissiveIntensity: 1.4, roughness: 0.18 }),
      );
      lens.position.set(0, 0.34, 0.18);
      group.add(lens);
      for (const x of [-0.12, 0, 0.12]) {
        const vent = new Mesh(new BoxGeometry(0.055, 0.018, 0.018), new MeshStandardMaterial({ color: 0x0d1721, roughness: 0.75 }));
        vent.position.set(x, 0.25, -0.177);
        group.add(vent);
      }
      for (const x of [-spec.leadSeparation / 2, spec.leadSeparation / 2]) {
        const probe = new Mesh(new CylinderGeometry(0.022, 0.028, 0.48, 10), metal);
        probe.position.set(x, -0.12, 0);
        group.add(probe);
      }
    }

    if (spec.kind === "controller") {
      const pcb = new Mesh(
        new RoundedBoxGeometry(1.18, 0.18, 0.7, 4, 0.055),
        new MeshStandardMaterial({ color: 0x184d37, roughness: 0.6, metalness: 0.08 }),
      );
      pcb.position.y = 0.18;
      group.add(pcb);
      const relay = new Mesh(
        new BoxGeometry(0.42, 0.34, 0.42),
        new MeshStandardMaterial({ color: spec.color, roughness: 0.42 }),
      );
      relay.position.set(0.24, 0.42, 0);
      group.add(relay);
      for (const x of [-0.38, -0.12, 0.48]) {
        const chip = new Mesh(new BoxGeometry(0.16, 0.12, 0.18), new MeshStandardMaterial({ color: 0x101820, roughness: 0.46, metalness: 0.2 }));
        chip.position.set(x, 0.34, 0.18);
        group.add(chip);
      }
      for (const z of [-0.2, 0, 0.2]) {
        const trace = new Mesh(new BoxGeometry(0.72, 0.012, 0.018), new MeshStandardMaterial({ color: 0xd2ad4e, roughness: 0.3, metalness: 0.82 }));
        trace.position.set(-0.05, 0.29, z);
        group.add(trace);
      }
      for (const x of [-spec.leadSeparation / 2, spec.leadSeparation / 2]) {
        const lead = new Mesh(new CylinderGeometry(0.025, 0.025, 0.38, 10), metal);
        lead.position.set(x, -0.12, 0);
        group.add(lead);
      }
    }

    if (spec.kind === "pump") {
      const body = new Mesh(
        new CylinderGeometry(0.27, 0.27, 0.72, 24),
        new MeshStandardMaterial({ color: spec.color, roughness: 0.44, metalness: 0.32 }),
      );
      body.rotation.z = Math.PI / 2;
      body.position.y = 0.25;
      group.add(body);
      const cap = new Mesh(new CylinderGeometry(0.31, 0.31, 0.14, 24), new MeshStandardMaterial({ color: 0x172433, roughness: 0.58 }));
      cap.rotation.z = Math.PI / 2;
      cap.position.set(0.39, 0.25, 0);
      group.add(cap);
      for (const [x, z, rotation] of [[-0.42, 0, Math.PI / 2], [0.48, -0.28, 0]] as const) {
        const port = new Mesh(new CylinderGeometry(0.11, 0.11, 0.26, 18), new MeshStandardMaterial({ color: 0x6f8493, roughness: 0.32, metalness: 0.62 }));
        port.position.set(x, 0.25, z);
        port.rotation.z = rotation;
        group.add(port);
      }
      for (const x of [-0.28, 0.28]) {
        const foot = new Mesh(new RoundedBoxGeometry(0.22, 0.08, 0.42, 3, 0.025), new MeshStandardMaterial({ color: 0x172433, roughness: 0.72 }));
        foot.position.set(x, -0.03, 0);
        group.add(foot);
      }
      for (const x of [-spec.leadSeparation / 2, spec.leadSeparation / 2]) {
        const lead = new Mesh(new CylinderGeometry(0.026, 0.026, 0.36, 10), metal);
        lead.position.set(x, -0.12, 0);
        group.add(lead);
      }
      group.userData.rotor = body;
    }

    if (spec.kind === "fan") {
      const guard = new Mesh(new TorusGeometry(0.38, 0.045, 10, 32), metal);
      guard.rotation.x = Math.PI / 2;
      guard.position.y = 0.38;
      group.add(guard);
      const rotor = new Group();
      rotor.position.y = 0.38;
      for (let index = 0; index < 4; index += 1) {
        const blade = new Mesh(
          new BoxGeometry(0.1, 0.05, 0.34),
          new MeshStandardMaterial({ color: 0xb9d9e8, roughness: 0.36, metalness: 0.22 }),
        );
        blade.position.z = 0.17;
        blade.rotation.y = index * Math.PI / 2;
        rotor.add(blade);
      }
      const hub = new Mesh(new CylinderGeometry(0.09, 0.09, 0.12, 18), new MeshStandardMaterial({ color: 0x31465a, roughness: 0.42 }));
      hub.rotation.x = Math.PI / 2;
      rotor.add(hub);
      group.add(rotor);
      group.userData.rotor = rotor;
      for (const x of [-spec.leadSeparation / 2, spec.leadSeparation / 2]) {
        const lead = new Mesh(new CylinderGeometry(0.024, 0.024, 0.36, 10), metal);
        lead.position.set(x, -0.12, 0);
        group.add(lead);
      }
    }

    if (spec.kind === "solar") {
      const frame = new Mesh(new BoxGeometry(1.25, 0.12, 0.76), new MeshStandardMaterial({ color: 0x9aa7b2, roughness: 0.3, metalness: 0.72 }));
      frame.position.y = 0.3;
      group.add(frame);
      const panel = new Mesh(new BoxGeometry(1.14, 0.035, 0.65), new MeshStandardMaterial({ color: spec.color, roughness: 0.2, metalness: 0.38, emissive: 0x071b48, emissiveIntensity: 0.45 }));
      panel.position.y = 0.37;
      group.add(panel);
      for (const x of [-0.36, 0, 0.36]) {
        const grid = new Mesh(new BoxGeometry(0.012, 0.016, 0.62), metal);
        grid.position.set(x, 0.395, 0);
        group.add(grid);
      }
      for (const z of [-0.21, 0, 0.21]) {
        const grid = new Mesh(new BoxGeometry(1.1, 0.016, 0.01), metal);
        grid.position.set(0, 0.395, z);
        group.add(grid);
      }
      for (const x of [-spec.leadSeparation / 2, spec.leadSeparation / 2]) {
        const lead = new Mesh(new CylinderGeometry(0.024, 0.024, 0.36, 10), metal);
        lead.position.set(x, -0.12, 0);
        group.add(lead);
      }
    }
    if (spec.kind.startsWith("snap")) this.buildSnapPart(group, spec, metal);
    return group;
  }

  /** Procedural fallback for the Snap Lab kit; replaced by makerspace_parts.glb when it loads. */
  private buildSnapPart(group: Group, spec: ComponentSpec, metal: MeshStandardMaterial): void {
    const strip = new Mesh(
      new RoundedBoxGeometry(spec.leadSeparation + 0.3, 0.08, 0.34, 3, 0.03),
      new MeshStandardMaterial({ color: 0x0b3a9e, roughness: 0.35 }),
    );
    strip.position.y = 0.04;
    group.add(strip);
    for (const x of [-spec.leadSeparation / 2, spec.leadSeparation / 2]) {
      const rivet = new Mesh(new CylinderGeometry(0.11, 0.1, 0.2, 20), metal);
      rivet.position.set(x, 0, 0);
      group.add(rivet);
    }
    const dark = new MeshStandardMaterial({ color: 0x111111, roughness: 0.4 });
    if (spec.kind === "snapbattery") {
      const holder = new Mesh(new RoundedBoxGeometry(1.2, 0.42, 0.5, 3, 0.04), dark);
      holder.position.y = 0.3;
      group.add(holder);
    }
    if (spec.kind === "snapswitch") {
      const body = new Mesh(new RoundedBoxGeometry(0.62, 0.22, 0.26, 3, 0.02), dark);
      body.position.set(0, 0.2, -0.05);
      group.add(body);
      const knob = new Mesh(new RoundedBoxGeometry(0.12, 0.12, 0.1, 2, 0.015), new MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.4 }));
      knob.name = "switch_knob";
      knob.position.set(-0.1, 0.36, -0.05);
      group.add(knob);
      group.userData.switchOn = false;
    }
    if (spec.kind === "snapled") {
      const dome = new Mesh(
        new SphereGeometry(0.11, 20, 14),
        new MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0, roughness: 0.15, transparent: true, opacity: 0.9 }),
      );
      dome.scale.y = 1.6;
      dome.position.set(0, 0.32, -0.02);
      group.add(dome);
      group.userData.glowMaterials = [dome.material];
      const glow = new PointLight(spec.color, 0, 2.4, 1.6);
      glow.position.y = 0.45;
      group.add(glow);
      group.userData.glowLight = glow;
    }
    if (spec.kind === "snaplamp") {
      const bulb = new Mesh(
        new SphereGeometry(0.17, 24, 16),
        new MeshStandardMaterial({ color: 0xfff3c4, emissive: spec.color, emissiveIntensity: 0, roughness: 0.1, transparent: true, opacity: 0.85 }),
      );
      bulb.position.set(0, 0.5, -0.02);
      group.add(bulb);
      group.userData.glowMaterials = [bulb.material];
      const glow = new PointLight(0xffd27a, 0, 3.6, 1.6);
      glow.position.y = 0.55;
      group.add(glow);
      group.userData.glowLight = glow;
    }
    if (spec.kind === "snapmotor") {
      const can = new Mesh(new CylinderGeometry(0.23, 0.23, 0.46, 28), new MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.3, metalness: 0.9 }));
      can.position.set(0, 0.32, -0.03);
      group.add(can);
      const rotor = new Group();
      rotor.name = "rotor";
      rotor.position.set(0, 0.7, -0.03);
      for (let index = 0; index < 3; index += 1) {
        const blade = new Mesh(new BoxGeometry(0.42, 0.012, 0.12), new MeshStandardMaterial({ color: 0xcc1a10, roughness: 0.4 }));
        blade.position.set(Math.cos(index * 2.094) * 0.22, 0, Math.sin(index * 2.094) * 0.22);
        blade.rotation.y = -index * 2.094;
        rotor.add(blade);
      }
      group.add(rotor);
      group.userData.rotor = rotor;
    }
  }

  private setupSnapBase(): void {
    const base = new Group();
    base.position.x = BOARD_X;
    const plate = new Mesh(
      new RoundedBoxGeometry(SNAP_COLS * SNAP_PITCH + 0.3, 0.26, SNAP_ROWS * SNAP_PITCH + 0.5, 4, 0.04),
      new MeshPhysicalMaterial({ color: 0xc7d6e0, roughness: 0.15, transmission: 0.4, thickness: 0.2 }),
    );
    plate.position.set(0, 0.13, 0.08);
    plate.receiveShadow = true;
    base.add(plate);
    const studs = new InstancedMesh(
      new CylinderGeometry(0.05, 0.05, 0.1, 16),
      new MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.2 }),
      SNAP_COLS * SNAP_ROWS,
    );
    const dummy = new Object3D();
    let index = 0;
    for (let row = 0; row < SNAP_ROWS; row += 1) {
      for (let col = 0; col < SNAP_COLS; col += 1) {
        const x = -((SNAP_COLS - 1) * SNAP_PITCH) / 2 + col * SNAP_PITCH;
        const z = -((SNAP_ROWS - 1) * SNAP_PITCH) / 2 + row * SNAP_PITCH;
        this.snapSockets.push(new Vector3(BOARD_X + x, SNAP_STUD_Y, z));
        dummy.position.set(x, 0.31, z);
        dummy.updateMatrix();
        studs.setMatrixAt(index++, dummy.matrix);
      }
    }
    studs.instanceMatrix.needsUpdate = true;
    base.add(studs);
    this.snapBaseGroup.userData.proceduralBase = base;
    this.snapBaseGroup.add(base);
    this.addStudCollars();
    // Snapino board (procedural stand-in until the Blender model loads): carrier + pads on row B
    const board = new Group();
    board.position.x = BOARD_X;
    const carrier = new Mesh(
      new RoundedBoxGeometry(3.9, 0.06, 1.0, 3, 0.03),
      new MeshStandardMaterial({ color: 0x0b2f8f, roughness: 0.35 }),
    );
    carrier.position.set(-0.24, 0.29, -1.22);
    board.add(carrier);
    const nano = new Mesh(new BoxGeometry(1.9, 0.04, 0.72), new MeshStandardMaterial({ color: 0x0a2a6e, roughness: 0.4 }));
    nano.position.set(-0.48, 0.36, -1.44);
    board.add(nano);
    this.snapinoGroup.userData.proceduralBoard = board;
    this.snapinoGroup.add(board);
  }

  /**
   * Socket depth: a shaded collar where each stud leaves the plate (dark at the stud, fading to
   * the plate's tone), so studs read as seated in the base rather than floating on it. One
   * instanced draw call for all 63. Also creates the (hidden) inspector highlight rings.
   */
  private addStudCollars(): void {
    const collarGeometry = new RingGeometry(0.05, 0.088, 32, 1);
    const colors: number[] = [];
    const position = collarGeometry.getAttribute("position");
    const inner = new Color(0x5d6875);
    const outer = new Color(0xc9d4dc);
    for (let index = 0; index < position.count; index += 1) {
      const radius = Math.hypot(position.getX(index), position.getY(index));
      const mix = MathUtils.clamp((radius - 0.05) / 0.038, 0, 1);
      const color = inner.clone().lerp(outer, mix);
      colors.push(color.r, color.g, color.b);
    }
    collarGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    const collars = new InstancedMesh(
      collarGeometry,
      new MeshStandardMaterial({ name: "stud_collar", vertexColors: true, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      SNAP_COLS * SNAP_ROWS,
    );
    collars.name = "stud_collars";
    const dummy = new Object3D();
    this.snapSockets.forEach((socket, index) => {
      dummy.position.set(socket.x, SNAP_PLATE_TOP + 0.0015, socket.z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.updateMatrix();
      collars.setMatrixAt(index, dummy.matrix);
    });
    collars.instanceMatrix.needsUpdate = true;
    collars.receiveShadow = true;
    collars.userData.noPick = true;
    this.snapBaseGroup.add(collars);

    const ring = (tone: NetTone): InstancedMesh => {
      const style = NET_TONES[tone];
      const mesh = new InstancedMesh(
        ringPattern(style.pattern),
        new MeshBasicMaterial({ name: `stud_highlight_${tone}`, color: style.hex, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
        SNAP_COLS * SNAP_ROWS,
      );
      mesh.name = `stud_highlights_${tone}`;
      mesh.count = 0;
      mesh.visible = false;
      mesh.renderOrder = 3;
      mesh.userData.noPick = true;
      this.snapBaseGroup.add(mesh);
      return mesh;
    };
    this.studHighlights = { a: ring("a"), b: ring("b"), fault: ring("fault") };
  }

  /**
   * The GLB base prints its row letters and column numbers at 0.09 units, too small to read
   * from the default camera. Enlarge them in their margins and print them darker than the grid
   * lines, so the stud names the inspector uses (B-4, D-7…) can be found on the board.
   */
  private enlargeGridLabels(base: Object3D): void {
    const label = new MeshStandardMaterial({ name: "grid_label", color: 0x334155, roughness: 0.7, metalness: 0 });
    base.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      if (/^snap_row\d+_text$/.test(child.name)) {
        child.scale.multiplyScalar(1.9);
        child.position.x = -2.13;
        child.material = label;
      } else if (/^snap_col\d+_text$/.test(child.name)) {
        child.scale.multiplyScalar(2.0);
        child.position.z = 1.76;
        child.material = label;
      }
    });
  }

  private setupSnapMarkers(): void {
    for (let i = 0; i < 2; i += 1) {
      const material = new MeshBasicMaterial({
        color: COLORS.green,
        side: DoubleSide,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const marker = new Mesh(new RingGeometry(0.075, 0.11, 24), material);
      marker.rotation.x = -Math.PI / 2;
      marker.visible = false;
      this.previewMarkers.push(marker);
      this.scene.add(marker);

      const beamMaterial = new MeshBasicMaterial({
        color: 0x4cff9a,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const beam = new Mesh(new CylinderGeometry(0.012, 0.028, 1, 10, 1, true), beamMaterial);
      beam.visible = false;
      this.previewBeams.push(beam);
      this.scene.add(beam);
    }
  }

  private bindInteractions(): void {
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove, { capture: true });
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp, { capture: true });
    this.renderer.domElement.addEventListener("pointercancel", this.onPointerCancel, { capture: true });
    this.renderer.domElement.addEventListener("dblclick", this.onDoubleClick);
    window.addEventListener("blur", this.onWindowBlur);

    this.transform.addEventListener("dragging-changed", (event) => {
      const dragging = Boolean((event as unknown as { value: boolean }).value);
      this.orbit.enabled = !dragging;
      if (dragging && this.selected) {
        const id = this.selected.userData.componentId as string;
        if (!this.events.onClaim(id)) {
          this.transform.detach();
          this.events.onStatus("This component is being moved by someone else", "warning");
        }
      }
    });
    this.transform.addEventListener("objectChange", () => {
      if (!this.selected) return;
      this.selectionBox.update();
      const now = performance.now();
      if (now - this.transformBroadcastAt > 45) {
        this.emitTransform(this.selected, false);
        this.transformBroadcastAt = now;
      }
    });
    this.transform.addEventListener("mouseUp", () => {
      if (!this.selected) return;
      this.finishPlacement(this.selected);
      this.events.onRelease(this.selected.userData.componentId as string);
    });
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.transform.axis) return;
    const endpointHit = this.pickEndpoint(event.clientX, event.clientY);
    const component = endpointHit?.component ?? this.pickComponent(event.clientX, event.clientY);
    if (!component) {
      this.clearSelection();
      return;
    }

    const id = component.userData.componentId as string;
    const resourceId = endpointHit ? this.endpointResourceId(id, endpointHit.index) : id;
    const endpointOwner = endpointHit
      ? this.remoteOwners.get(resourceId)
      : this.remoteOwners.get(this.endpointResourceId(id, 0)) ?? this.remoteOwners.get(this.endpointResourceId(id, 1));
    const owner = this.remoteOwners.get(id) ?? endpointOwner;
    if (owner) {
      this.select(component);
      this.events.onStatus(`${owner.name} is moving ${component.userData.spec.name}`, "warning");
      return;
    }
    if (!this.events.onClaim(resourceId)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    this.select(component);
    this.dragging = component;
    this.dragPointerId = event.pointerId;
    this.dragOriginPosition.copy(component.position);
    this.dragOriginRotation.copy(component.rotation);
    const spec = component.userData.spec as ComponentSpec;
    if (endpointHit) {
      const endpoints = this.getEndpointPositions(component);
      const sockets = this.cloneEndpointSockets(component.userData.sockets as EndpointSockets);
      const activeWorld = component.localToWorld(endpoints[endpointHit.index].clone());
      this.draggingEndpoint = {
        component,
        index: endpointHit.index,
        resourceId,
        startEndpoints: [endpoints[0].clone(), endpoints[1].clone()],
        startSockets: sockets,
        previousWorld: activeWorld,
        startClient: new Vector2(event.clientX, event.clientY),
        moved: false,
        sway: 0,
        velocity: 0,
      };
      const nextSockets: [number | null, number | null] = sockets ? [...sockets] : [null, null];
      nextSockets[endpointHit.index] = null;
      component.userData.sockets = nextSockets;
      this.orbit.enabled = false;
      this.renderer.domElement.setPointerCapture(event.pointerId);
      this.events.onStatus(
        `Drag ${spec.name} end ${endpointHit.index === 0 ? "A" : "B"} · release near a glowing socket`,
        "neutral",
      );
      return;
    }

    component.userData.sockets = null;
    if (spec.kind === "wire" || spec.kind === "hose") {
      this.flexMotion.set(id, { previous: component.position.clone(), sway: 0, velocity: 0 });
      this.updateFlexibleWireGeometry(component, false);
    } else {
      this.updateFlexibleWire(component, spec.leadSeparation, false);
    }
    this.updatePointer(event.clientX, event.clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)) {
      this.dragOffset.copy(component.position).sub(this.dragPoint);
    } else {
      this.dragOffset.set(0, 0, 0);
    }
    this.orbit.enabled = false;
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.events.onStatus(`Moving ${component.userData.spec.name}`, "neutral");
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) {
      if (event.buttons) this.setHover(null);
      else this.updateHover(event.clientX, event.clientY);
      return;
    }
    if (this.dragPointerId !== event.pointerId) return;
    this.setHover(null);
    if (this.draggingEndpoint) {
      this.moveEndpoint(event);
      return;
    }
    this.updatePointer(event.clientX, event.clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)) return;
    this.dragging.position.copy(this.dragPoint).add(this.dragOffset);
    this.dragging.position.x = MathUtils.clamp(this.dragging.position.x, -4.7, 4.6);
    this.dragging.position.z = MathUtils.clamp(this.dragging.position.z, -3.25, 3.25);
    this.dragging.position.y = DRAG_Y;
    if (this.magnetismEnabled) this.applyMagneticAssist(this.dragging);
    this.updateFlexibleMotion(this.dragging);
    this.dragging.updateMatrixWorld(true);
    this.selectionBox.update();
    this.updateSnapPreview(this.dragging);
    const now = performance.now();
    if (now - this.transformBroadcastAt > 45) {
      this.emitTransform(this.dragging, false);
      this.transformBroadcastAt = now;
    }
  };

  private updateHover(clientX: number, clientY: number): void {
    const endpoint = this.pickEndpoint(clientX, clientY);
    this.setHover(endpoint?.component ?? this.pickComponent(clientX, clientY));
  }

  private setHover(component: Group | null): void {
    if (this.hovered === component) return;
    this.hovered = component;
    const visible = Boolean(component && component !== this.selected);
    this.hoverBox.visible = visible;
    if (component && visible) this.hoverBox.setFromObject(component);
    this.renderer.domElement.style.cursor = component ? (this.remoteOwners.has(component.userData.componentId as string) ? "not-allowed" : "grab") : "";
  }

  /** Swap procedural meshes for the Blender-built room + detailed parts (blender/build_makerspace.py). */
  private async loadDetailedModels(): Promise<void> {
    const loader = new GLTFLoader();
    const base = import.meta.env.BASE_URL;
    try {
      const [room, parts] = await Promise.all([
        loader.loadAsync(`${base}models/makerspace_room.glb`),
        loader.loadAsync(`${base}models/makerspace_parts.glb`),
      ]);
      room.scene.traverse((child) => {
        if (child instanceof Mesh) child.receiveShadow = true;
      });
      this.scene.add(room.scene);
      this.scene.background = new Color(0x161a21);
      // atmospheric depth: the far walls soften while the bench stays crisp
      this.scene.fog = new Fog(0x161a21, 16, 52);
      for (const mesh of this.proceduralTable) mesh.visible = false;

      for (const [id, component] of this.components) {
        const spec = component.userData.spec as ComponentSpec;
        // Circuit Bench parts use the procedural bench models (bench-models.ts): exact scale,
        // polarity cues and value-driven bands that the baked GLB parts cannot show.
        if (spec.kind === "wire" || spec.kind === "hose" || spec.studio === "circuit") continue;
        const source = parts.scene.getObjectByName(`part_${spec.model ?? id}`);
        if (!source) continue;
        const detailed = source.clone(true);
        detailed.position.set(0, 0, 0);
        for (const child of [...component.children]) {
          if (!(child instanceof PointLight)) component.remove(child);
        }
        component.add(detailed);
        const glowMaterials: MeshStandardMaterial[] = [];
        detailed.traverse((child) => {
          child.userData.componentRoot = component;
          if (!(child instanceof Mesh)) return;
          child.castShadow = true;
          child.receiveShadow = true;
          const material = child.material as MeshStandardMaterial;
          if (material.name.startsWith("LED_glow")) {
            child.material = material.clone();
            (child.material as MeshStandardMaterial).emissive.setHex(spec.color);
            (child.material as MeshStandardMaterial).emissiveIntensity = 0;
            glowMaterials.push(child.material as MeshStandardMaterial);
          }
        });
        if (spec.kind === "led" || spec.kind === "snaplamp" || spec.kind === "snapled") component.userData.glowMaterials = glowMaterials;
        if (spec.kind === "snapswitch") this.setSwitch(component, Boolean(component.userData.switchOn));
        const rotor = detailed.getObjectByProperty("name", "rotor") ?? detailed.children
          .flatMap((child) => [child, ...child.children])
          .find((child) => child.name.startsWith("rotor"));
        if (rotor) component.userData.rotor = rotor;
      }
      for (const [name, group, key] of [
        ["snap_base", this.snapBaseGroup, "proceduralBase"],
        ["snapino_board", this.snapinoGroup, "proceduralBoard"],
      ] as const) {
        const source = parts.scene.getObjectByName(name);
        const procedural = group.userData[key] as Group | undefined;
        if (!source || !procedural) continue;
        const detailed = source.clone(true);
        detailed.position.set(BOARD_X, 0, 0);
        detailed.traverse((child) => {
          if (child instanceof Mesh) child.receiveShadow = true;
        });
        procedural.visible = false;
        group.add(detailed);
        if (name === "snap_base") this.enlargeGridLabels(detailed);
        if (name === "snapino_board") this.addSnapinoSilkscreen(detailed);
        // The base and carrier never move: one draw call per material instead of one per mesh.
        mergeStaticMeshes(detailed);
      }
      this.evaluateCurrentSystem();
      if (this.selected) this.selectionBox.setFromObject(this.selected);
    } catch (error) {
      console.warn("Detailed makerspace models unavailable; using procedural meshes.", error);
    }
  }

  /** Readable pin names, headers and an honest "not an AVR emulator" note on the Nano module. */
  private addSnapinoSilkscreen(board: Object3D): void {
    const pcb = board.getObjectByName("snapino_nano_pcb");
    if (!pcb) return;
    board.updateMatrixWorld(true);
    const box = new Box3().setFromObject(pcb);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const long = Math.max(size.x, size.z);
    const short = Math.min(size.x, size.z);
    const silkscreen = createSnapinoSilkscreen(long * 0.98, short * 0.94);
    silkscreen.position.set(center.x, box.max.y + 0.002, center.z);
    if (size.z > size.x) silkscreen.rotation.y = Math.PI / 2;
    const headers = createHeaderRows(long * 0.9, short * 0.42, 15);
    headers.position.set(center.x, box.max.y, center.z);
    if (size.z > size.x) headers.rotation.y = Math.PI / 2;
    this.snapinoGroup.add(silkscreen, headers);
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging || this.dragPointerId !== event.pointerId) return;
    const component = this.dragging;
    const endpointDrag = this.draggingEndpoint;
    const releaseId = endpointDrag?.resourceId ?? (component.userData.componentId as string);
    this.dragging = null;
    this.draggingEndpoint = null;
    this.dragPointerId = null;
    this.orbit.enabled = true;
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    if (endpointDrag && !endpointDrag.moved) {
      component.userData.endpointPositions = [
        endpointDrag.startEndpoints[0].clone(),
        endpointDrag.startEndpoints[1].clone(),
      ] as EndpointPair;
      component.userData.sockets = this.cloneEndpointSockets(endpointDrag.startSockets);
      this.updateFlexibleWireGeometry(component, Boolean(component.userData.sockets));
      this.hideSnapPreview();
      this.events.onStatus(`Selected ${component.userData.spec.name} · drag either glowing end`, "neutral");
    } else if (endpointDrag) this.finishEndpointPlacement(endpointDrag);
    else this.finishPlacement(component);
    this.flexMotion.delete(component.userData.componentId as string);
    this.events.onRelease(releaseId);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (!this.dragging || this.dragPointerId !== event.pointerId) return;
    const component = this.dragging;
    const releaseId = this.draggingEndpoint?.resourceId ?? (component.userData.componentId as string);
    const endpointIndex = this.draggingEndpoint?.index;
    if (this.draggingEndpoint) {
      component.userData.endpointPositions = [
        this.draggingEndpoint.startEndpoints[0].clone(),
        this.draggingEndpoint.startEndpoints[1].clone(),
      ] as EndpointPair;
      component.userData.sockets = this.cloneEndpointSockets(this.draggingEndpoint.startSockets);
      this.updateFlexibleWireGeometry(component, Boolean(component.userData.sockets));
    }
    component.position.copy(this.dragOriginPosition);
    component.rotation.copy(this.dragOriginRotation);
    component.updateMatrixWorld(true);
    this.dragging = null;
    this.draggingEndpoint = null;
    this.dragPointerId = null;
    this.orbit.enabled = true;
    this.hideSnapPreview();
    this.flexMotion.delete(component.userData.componentId as string);
    this.emitTransform(component, true, endpointIndex);
    this.events.onRelease(releaseId);
    this.events.onStatus("Move canceled · previous position restored", "neutral");
  };

  private readonly onWindowBlur = (): void => {
    if (!this.dragging) return;
    const component = this.dragging;
    const releaseId = this.draggingEndpoint?.resourceId ?? (component.userData.componentId as string);
    const endpointIndex = this.draggingEndpoint?.index;
    if (this.draggingEndpoint) {
      component.userData.endpointPositions = [
        this.draggingEndpoint.startEndpoints[0].clone(),
        this.draggingEndpoint.startEndpoints[1].clone(),
      ] as EndpointPair;
      component.userData.sockets = this.cloneEndpointSockets(this.draggingEndpoint.startSockets);
    }
    component.position.copy(this.dragOriginPosition);
    component.rotation.copy(this.dragOriginRotation);
    component.updateMatrixWorld(true);
    this.dragging = null;
    this.draggingEndpoint = null;
    this.dragPointerId = null;
    this.orbit.enabled = true;
    this.hideSnapPreview();
    this.flexMotion.delete(component.userData.componentId as string);
    this.updateFlexibleWireFromSockets(component);
    this.emitTransform(component, true, endpointIndex);
    this.events.onRelease(releaseId);
    this.events.onStatus("Window focus changed · previous position restored", "neutral");
  };

  private moveEndpoint(event: PointerEvent): void {
    const state = this.draggingEndpoint;
    if (!state) return;
    const { component, index } = state;
    if (!state.moved) {
      const pointerTravel = state.startClient.distanceTo(new Vector2(event.clientX, event.clientY));
      if (pointerTravel < 4) return;
      state.moved = true;
    }
    this.updatePointer(event.clientX, event.clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint)) return;

    const desired = this.dragPoint.clone();
    desired.x = MathUtils.clamp(desired.x, -4.7, 4.6);
    desired.z = MathUtils.clamp(desired.z, -3.25, 3.25);
    desired.y = DRAG_Y;

    const endpoints = this.getEndpointPositions(component);
    const fixedWorld = component.localToWorld(endpoints[index === 0 ? 1 : 0].clone());
    const restLength = Number(component.userData.restLength ?? 1);
    const offset = desired.clone().sub(fixedWorld);
    const maxReach = restLength * 1.85;
    if (offset.length() > maxReach) desired.copy(fixedWorld).add(offset.setLength(maxReach));

    const nearest = this.nearestSocket(desired);
    const sockets = this.cloneEndpointSockets(component.userData.sockets as EndpointSockets) ?? [null, null];
    const otherSocket = sockets[index === 0 ? 1 : 0];
    if (this.magnetismEnabled && nearest.index !== otherSocket && nearest.distance < MAGNETIC_RADIUS) {
      const field = MathUtils.clamp(1 - nearest.distance / MAGNETIC_RADIUS, 0, 1);
      desired.lerp(this.sockets[nearest.index], field * field * 0.46);
    }

    const delta = desired.clone().sub(state.previousWorld);
    state.velocity = MathUtils.lerp(state.velocity, MathUtils.clamp(delta.length() * 10, 0, 1), 0.48);
    state.sway = MathUtils.lerp(state.sway, MathUtils.clamp((delta.x - delta.z) * 2.8, -0.5, 0.5), 0.4);
    state.previousWorld.copy(desired);

    endpoints[index].copy(component.worldToLocal(desired.clone()));
    this.updateFlexibleWireGeometry(component, sockets.some((socket) => socket !== null), state.sway, state.velocity);
    component.updateMatrixWorld(true);
    this.selectionBox.update();
    this.updateSnapPreview(component, index);
    const now = performance.now();
    if (now - this.transformBroadcastAt > 45) {
      this.emitTransform(component, false, index);
      this.transformBroadcastAt = now;
    }
  }

  private finishEndpointPlacement(state: EndpointDragState): void {
    const { component, index } = state;
    const endpoints = this.getEndpointWorldPositions(component);
    const nearest = this.nearestSocket(endpoints[index]);
    const sockets = this.cloneEndpointSockets(component.userData.sockets as EndpointSockets) ?? [null, null];
    const otherSocket = sockets[index === 0 ? 1 : 0];
    const snapped = nearest.distance <= SNAP_THRESHOLD && nearest.index !== otherSocket;
    if (snapped) {
      const socket = this.sockets[nearest.index];
      this.getEndpointPositions(component)[index].copy(component.worldToLocal(socket.clone()));
      sockets[index] = nearest.index;
      component.userData.sockets = sockets;
      this.updateFlexibleWireGeometry(component, true);
      this.flashMagneticEndpoint(socket, index);
      this.events.onStatus(
        `${component.userData.spec.name} end ${index === 0 ? "A" : "B"} magnetically connected`,
        "valid",
      );
    } else {
      sockets[index] = null;
      component.userData.sockets = sockets.some((socket) => socket !== null) ? sockets : null;
      this.updateFlexibleWireGeometry(component, sockets.some((socket) => socket !== null));
      this.hideSnapPreview();
      this.events.onStatus(
        `${component.userData.spec.name} end ${index === 0 ? "A" : "B"} remains free`,
        "neutral",
      );
    }
    component.updateMatrixWorld(true);
    this.selectionBox.update();
    this.emitTransform(component, true, index);
    const powered = this.evaluateCurrentSystem();
    this.events.onAttempt(
      this.captureAttempt(powered ? "Circuit powered" : `${component.userData.spec.name} endpoint moved`),
    );
  }

  private cloneEndpointSockets(sockets: EndpointSockets): EndpointSockets {
    return sockets ? [sockets[0], sockets[1]] : null;
  }

  private endpointResourceId(componentId: string, index: 0 | 1): string {
    return `${componentId}::endpoint-${index}`;
  }

  private pickComponent(clientX: number, clientY: number): Group | null {
    this.updatePointer(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.components.values()], true);
    for (const hit of hits) {
      // Contact shadows and other decals are never grab handles.
      if (hit.object.userData.noPick) continue;
      const root = hit.object.userData.componentRoot as Group | undefined;
      const spec = root?.userData.spec as ComponentSpec | undefined;
      if (root && root.visible !== false && spec?.studio === this.activeStudio) return root;
    }
    return null;
  }

  private pickEndpoint(clientX: number, clientY: number): { component: Group; index: 0 | 1 } | null {
    this.updatePointer(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets: Mesh[] = [];
    for (const component of this.components.values()) {
      const spec = component.userData.spec as ComponentSpec;
      if (spec.studio !== this.activeStudio || (spec.kind !== "wire" && spec.kind !== "hose")) continue;
      targets.push(...((component.userData.endpointHitTargets ?? []) as Mesh[]));
    }
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const component = hit.object.userData.componentRoot as Group | undefined;
    const index = hit.object.userData.endpointIndex as 0 | 1 | undefined;
    return component && (index === 0 || index === 1) ? { component, index } : null;
  }

  private select(component: Group): void {
    this.cancelRemoteTween(component, true);
    if (this.selected && this.selected !== component) this.setEndpointIndicators(this.selected, false);
    this.selected = component;
    this.selectionBox.setFromObject(component);
    this.selectionBox.visible = true;
    const spec = component.userData.spec as ComponentSpec;
    const flexible = spec.kind === "wire" || spec.kind === "hose";
    this.setEndpointIndicators(component, flexible);
    if (flexible) this.transform.detach();
    else this.transform.attach(component);
    this.events.onSelection(spec);
  }

  private clearSelection(): void {
    if (this.selected) this.setEndpointIndicators(this.selected, false);
    this.selected = null;
    this.selectionBox.visible = false;
    this.transform.detach();
    this.events.onSelection(null);
  }

  private setEndpointIndicators(component: Group, visible: boolean): void {
    const indicators = (component.userData.endpointIndicators ?? []) as Mesh[];
    indicators.forEach((indicator) => {
      indicator.visible = visible;
    });
  }

  private finishPlacement(component: Group): void {
    const spec = component.userData.spec as ComponentSpec;
    const flexible = spec.kind === "wire" || spec.kind === "hose";
    const snap = this.findSnap(component);
    if (snap) {
      const [socketA, socketB] = snap;
      const a = this.sockets[socketA];
      const b = this.sockets[socketB];
      component.userData.sockets = [socketA, socketB] as [number, number];
      if (flexible) {
        const endpoints = this.getEndpointPositions(component);
        endpoints[0].copy(component.worldToLocal(a.clone()));
        endpoints[1].copy(component.worldToLocal(b.clone()));
        this.updateFlexibleWireGeometry(component, true);
      } else {
        const midpoint = a.clone().add(b).multiplyScalar(0.5);
        const direction = b.clone().sub(a);
        component.position.set(midpoint.x, DRAG_Y, midpoint.z);
        component.rotation.set(0, Math.atan2(-direction.z, direction.x), 0);
        this.updateFlexibleWire(component, a.distanceTo(b), true);
      }
      component.updateMatrixWorld(true);
      this.flashMagneticConnection(a, b);
      this.events.onStatus(
        this.activeStudio === "greenhouse"
          ? `${component.userData.spec.name} magnetically connected to the farm terminal`
          : this.activeStudio === "snap" || this.activeStudio === "snapino"
            ? `${component.userData.spec.name} snapped onto the base grid`
            : `${component.userData.spec.name} connected to the breadboard`,
        "valid",
      );
    } else {
      component.userData.sockets = null;
      if (flexible) this.updateFlexibleWireGeometry(component, false);
      else this.updateFlexibleWire(component, spec.leadSeparation, false);
      this.events.onStatus("Placement remains free · move both leads closer to sockets", "neutral");
      this.hideSnapPreview();
    }
    this.selectionBox.update();
    this.emitTransform(component, true);
    const powered = this.evaluateCurrentSystem();
    this.events.onAttempt(
      this.captureAttempt(powered ? "Circuit powered" : `${component.userData.spec.name} moved`),
    );
  }

  private findSnap(component: Group): [number, number] | null {
    return this.findSocketPair(component, SNAP_THRESHOLD);
  }

  private findSocketPair(component: Group, threshold: number): [number, number] | null {
    const spec = component.userData.spec as ComponentSpec;
    const [leadA, leadB] = this.getEndpointWorldPositions(component);
    const nearestA = this.nearestSocket(leadA);
    const nearestB = this.nearestSocket(leadB);
    if (
      nearestA.index === nearestB.index ||
      nearestA.distance > threshold ||
      nearestB.distance > threshold
    ) {
      return null;
    }
    if (spec.kind === "wire" || spec.kind === "hose") {
      const span = this.sockets[nearestA.index].distanceTo(this.sockets[nearestB.index]);
      if (span > spec.leadSeparation * 1.86) return null;
    }
    return [nearestA.index, nearestB.index];
  }

  private applyMagneticAssist(component: Group): void {
    const pair = this.findSocketPair(component, MAGNETIC_RADIUS);
    if (!pair) {
      component.userData.magneticPair = null;
      component.userData.magneticField = 0;
      return;
    }
    const a = this.sockets[pair[0]];
    const b = this.sockets[pair[1]];
    const spec = component.userData.spec as ComponentSpec;
    const [leadA, leadB] = this.getEndpointWorldPositions(component);
    const distance = Math.max(leadA.distanceTo(a), leadB.distanceTo(b));
    const field = MathUtils.clamp(1 - distance / MAGNETIC_RADIUS, 0, 1);
    const strength = field * field * 0.34;
    if (strength <= 0) return;

    const target = a.clone().add(b).multiplyScalar(0.5);
    target.y = DRAG_Y;
    if (spec.kind === "wire" || spec.kind === "hose") {
      const current = leadA.clone().add(leadB).multiplyScalar(0.5);
      component.position.addScaledVector(target.sub(current), strength);
    } else {
      component.position.lerp(target, strength);
      const targetAngle = Math.atan2(-(b.z - a.z), b.x - a.x);
      component.rotation.y = this.lerpAngle(component.rotation.y, targetAngle, strength * 0.82);
    }
    component.userData.magneticPair = pair;
    component.userData.magneticField = field;
  }

  private lerpAngle(from: number, to: number, amount: number): number {
    const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
    return from + delta * amount;
  }

  private nearestSocket(point: Vector3): { index: number; distance: number } {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.sockets.length; index += 1) {
      const socket = this.sockets[index];
      const dx = point.x - socket.x;
      const dz = point.z - socket.z;
      const distance = Math.hypot(dx, dz);
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    return { index: bestIndex, distance: bestDistance };
  }

  private updateSnapPreview(component: Group, onlyIndex?: 0 | 1): void {
    const leads = this.getEndpointWorldPositions(component);
    leads.forEach((lead, index) => {
      const nearest = this.nearestSocket(lead);
      const marker = this.previewMarkers[index];
      const beam = this.previewBeams[index];
      const radius = this.magnetismEnabled ? MAGNETIC_RADIUS : SNAP_THRESHOLD;
      const field = MathUtils.clamp(1 - nearest.distance / radius, 0, 1);
      marker.visible = (onlyIndex === undefined || onlyIndex === index) && nearest.index >= 0 && field > 0;
      if (marker.visible) {
        const socket = this.sockets[nearest.index];
        marker.position.copy(socket);
        marker.position.y += 0.03;
        marker.userData.baseScale = 0.8 + field * 1.45;
        marker.userData.field = field;
        marker.scale.setScalar(marker.userData.baseScale);
        marker.material.opacity = 0.14 + field * 0.8;
        marker.material.color.setRGB(0.18 * (1 - field), 0.58 + field * 0.42, 1 - field * 0.62);

        const delta = socket.clone().sub(lead);
        const length = delta.length();
        beam.visible = length > 0.01;
        beam.position.copy(lead).add(socket).multiplyScalar(0.5);
        beam.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), delta.normalize());
        beam.scale.set(0.65 + field * 0.8, length, 0.65 + field * 0.8);
        beam.material.opacity = 0.08 + field * 0.62;
        beam.material.color.copy(marker.material.color);
      } else {
        beam.visible = false;
        beam.material.opacity = 0;
      }
    });
  }

  private hideSnapPreview(): void {
    for (const marker of this.previewMarkers) {
      marker.visible = false;
      marker.material.opacity = 0;
      marker.scale.setScalar(1);
    }
    for (const beam of this.previewBeams) {
      beam.visible = false;
      beam.material.opacity = 0;
    }
  }

  private flashMagneticConnection(a: Vector3, b: Vector3): void {
    [a, b].forEach((socket, index) => {
      const marker = this.previewMarkers[index];
      marker.visible = true;
      marker.position.copy(socket);
      marker.position.y += 0.035;
      marker.userData.baseScale = 2.35;
      marker.userData.field = 1;
      marker.scale.setScalar(2.35);
      marker.material.opacity = 0.96;
      marker.material.color.setHex(COLORS.green);
    });
    window.setTimeout(() => {
      if (!this.dragging) this.hideSnapPreview();
    }, 720);
  }

  private flashMagneticEndpoint(socket: Vector3, index: 0 | 1): void {
    this.hideSnapPreview();
    const marker = this.previewMarkers[index];
    marker.visible = true;
    marker.position.copy(socket);
    marker.position.y += 0.035;
    marker.userData.baseScale = 2.5;
    marker.userData.field = 1;
    marker.scale.setScalar(2.5);
    marker.material.opacity = 1;
    marker.material.color.setHex(COLORS.green);
    window.setTimeout(() => {
      if (!this.dragging) this.hideSnapPreview();
    }, 720);
  }

  private getEndpointPositions(component: Group): EndpointPair {
    const spec = component.userData.spec as ComponentSpec;
    const existing = component.userData.endpointPositions as EndpointPair | undefined;
    if (existing) return existing;
    const half = spec.leadSeparation / 2;
    const endpoints = [new Vector3(-half, 0, 0), new Vector3(half, 0, 0)] as EndpointPair;
    component.userData.endpointPositions = endpoints;
    return endpoints;
  }

  private getEndpointWorldPositions(component: Group): EndpointPair {
    const spec = component.userData.spec as ComponentSpec;
    if (spec.kind === "wire" || spec.kind === "hose") {
      const endpoints = this.getEndpointPositions(component);
      return [
        component.localToWorld(endpoints[0].clone()),
        component.localToWorld(endpoints[1].clone()),
      ];
    }
    const direction = new Vector3(1, 0, 0).applyQuaternion(component.quaternion).normalize();
    const half = spec.leadSeparation / 2;
    return [
      component.position.clone().addScaledVector(direction, -half),
      component.position.clone().addScaledVector(direction, half),
    ];
  }

  private updateFlexibleWireFromSockets(component: Group): void {
    const spec = component.userData.spec as ComponentSpec;
    if (spec.kind !== "wire" && spec.kind !== "hose") return;
    this.updateFlexibleWireGeometry(component, Boolean(component.userData.sockets));
  }

  private updateFlexibleMotion(component: Group): void {
    const spec = component.userData.spec as ComponentSpec;
    if (spec.kind !== "wire" && spec.kind !== "hose") return;
    const id = component.userData.componentId as string;
    const state = this.flexMotion.get(id) ?? { previous: component.position.clone(), sway: 0, velocity: 0 };
    const delta = component.position.clone().sub(state.previous);
    const speed = MathUtils.clamp(delta.length() * 9, 0, 1);
    const directionalImpulse = MathUtils.clamp((delta.x - delta.z) * 2.6, -0.42, 0.42);
    state.velocity = MathUtils.lerp(state.velocity, speed, 0.46);
    state.sway = MathUtils.lerp(state.sway, directionalImpulse, 0.38);
    this.updateFlexibleWireGeometry(component, false, state.sway, state.velocity);
    state.previous.copy(component.position);
    this.flexMotion.set(id, state);
  }

  private updateFlexibleWire(
    component: Group,
    span: number,
    supportedByBoard: boolean,
    sway = 0,
    motion = 0,
  ): void {
    const spec = component.userData.spec as ComponentSpec;
    if (spec.kind !== "wire" && spec.kind !== "hose") return;
    const safeSpan = Math.min(span, spec.leadSeparation * 1.85);
    const half = safeSpan / 2;
    const endpoints = this.getEndpointPositions(component);
    endpoints[0].set(-half, 0, 0);
    endpoints[1].set(half, 0, 0);
    this.updateFlexibleWireGeometry(component, supportedByBoard, sway, motion);
  }

  private updateFlexibleWireGeometry(
    component: Group,
    supportedByBoard: boolean,
    sway = 0,
    motion = 0,
  ): void {
    const spec = component.userData.spec as ComponentSpec;
    if (spec.kind !== "wire" && spec.kind !== "hose") return;
    const body = component.userData.wireBody as Mesh<TubeGeometry, MeshStandardMaterial> | undefined;
    const tips = component.userData.wireTips as Mesh[] | undefined;
    const collars = component.userData.wireCollars as Mesh[] | undefined;
    const indicators = component.userData.endpointIndicators as Mesh[] | undefined;
    const hitTargets = component.userData.endpointHitTargets as Mesh[] | undefined;
    if (!body || !tips) return;
    const endpoints = this.getEndpointPositions(component);
    const start = endpoints[0];
    const end = endpoints[1];
    const span = start.distanceTo(end);
    const restLength = Number(component.userData.restLength ?? spec.leadSeparation);
    const slack = Math.max(restLength - span, 0);
    const tension = Math.max(span / Math.max(restLength, 0.001) - 1, 0);
    const supportLift = supportedByBoard ? 0.12 : 0.24;
    const arch = Math.max(0.055, supportLift + slack * 0.62 + motion * 0.12 - tension * 0.08);
    const lateral = sway * (spec.kind === "hose" ? 0.75 : 0.46);
    const tangent = end.clone().sub(start);
    const perpendicular = new Vector3(-tangent.z, 0, tangent.x).normalize();
    const point = (amount: number, lift: number, side: number): Vector3 =>
      start.clone().lerp(end, amount).add(new Vector3(0, lift, 0)).addScaledVector(perpendicular, side);
    let curve: CatmullRomCurve3;
    if (spec.kind === "wire") {
      // A jumper leaves each hole vertically (insulation stops just above the board, the bare
      // conductor goes in), then arches over in one smooth, gently sagging span.
      const rise = Math.min(0.16, 0.08 + span * 0.05);
      const up = (from: Vector3, height: number): Vector3 => from.clone().add(new Vector3(0, height, 0));
      curve = new CatmullRomCurve3([
        up(start, WIRE_INSULATION_END),
        up(start, WIRE_INSULATION_END + rise * 0.55),
        point(0.12, rise + arch * 0.45, lateral * 0.2),
        point(0.5, rise + arch * 0.82, lateral),
        point(0.88, rise + arch * 0.45, lateral * 0.2),
        up(end, WIRE_INSULATION_END + rise * 0.55),
        up(end, WIRE_INSULATION_END),
      ], false, "centripetal");
    } else {
      curve = new CatmullRomCurve3([
        start.clone(),
        point(0.14, arch * 0.56, lateral * 0.28),
        point(0.31, arch * 0.92, lateral * 0.72),
        point(0.5, arch, lateral),
        point(0.69, arch * 0.88, lateral * 0.58),
        point(0.86, arch * 0.52, lateral * 0.18),
        end.clone(),
      ]);
    }
    component.userData.wireCurve = curve;
    body.geometry.dispose();
    body.geometry = new TubeGeometry(curve, spec.kind === "hose" ? 52 : 64, spec.kind === "hose" ? 0.075 : WIRE_RADIUS, spec.kind === "hose" ? 14 : 12, false);
    const tipOffset = spec.kind === "hose" ? -0.14 : WIRE_TIP_CENTER;
    tips[0].position.copy(start).add(new Vector3(0, tipOffset, 0));
    tips[1].position.copy(end).add(new Vector3(0, tipOffset, 0));
    // Jumper: a flush cap of the insulation's own color closes the tube's cut end.
    const collarOffset = spec.kind === "hose" ? 0.015 : WIRE_INSULATION_END + 0.01;
    collars?.[0]?.position.copy(start).add(new Vector3(0, collarOffset, 0));
    collars?.[1]?.position.copy(end).add(new Vector3(0, collarOffset, 0));
    indicators?.[0]?.position.copy(start).add(new Vector3(0, 0.025, 0));
    indicators?.[1]?.position.copy(end).add(new Vector3(0, 0.025, 0));
    hitTargets?.[0]?.position.copy(start);
    hitTargets?.[1]?.position.copy(end);
  }

  private socketsFor(component: Group): Vector3[] {
    const spec = component.userData.spec as ComponentSpec;
    return spec.studio === "greenhouse" ? this.greenhouseSockets : this.circuitSockets;
  }

  private evaluateCurrentSystem(announce = false): boolean {
    this.shadowDirtyFrames = Math.max(this.shadowDirtyFrames, 3);
    this.syncContactShadows();
    if (this.activeStudio === "greenhouse") return this.evaluateGreenhouse(announce);
    if (this.activeStudio === "snap") return this.evaluateSnap(announce);
    if (this.activeStudio === "snapino") return this.evaluateSnapino(announce);
    return this.evaluateCircuit(announce);
  }

  private isFullyConnected(sockets: EndpointSockets | undefined): sockets is [number, number] {
    return Boolean(
      sockets &&
      Number.isInteger(sockets[0]) &&
      Number.isInteger(sockets[1]),
    );
  }

  /**
   * Circuit Bench: one electrical truth. Placements and edited values go through the shared
   * DC engine (src/circuit); LED glow follows the computed current, and only a safely lit
   * LED (no short, no overdriven or burnt LED) counts as powered.
   */
  private evaluateCircuit(announce = false): boolean {
    const placements: CircuitPlacements = {};
    const props: CircuitProps = {};
    for (const [id, component] of this.components) {
      const spec = component.userData.spec as ComponentSpec;
      if (spec.studio !== "circuit") continue;
      const sockets = component.userData.sockets as EndpointSockets;
      placements[id] = this.isFullyConnected(sockets) ? [sockets[0], sockets[1]] : null;
      props[id] = (component.userData.props as PartProps | undefined) ?? null;
    }
    const analysis = analyzeCircuit(placements, props);
    this.circuitAnalysis = analysis;
    const readings = analysis.board.result.elements;
    for (const id of ["led-red", "led-green"]) {
      const led = this.components.get(id);
      if (!led) continue;
      const reading = readings[id]?.led;
      const brightness = reading?.on ? Math.max(0.12, reading.brightness) : 0;
      const burnt = reading?.state === "burnout";
      if (burnt && !this.burntLeds.has(id)) this.ledFlashes.set(id, performance.now());
      if (burnt) this.burntLeds.add(id);
      else {
        this.burntLeds.delete(id);
        this.ledFlashes.delete(id);
      }
      led.userData.ledBrightness = brightness;
      led.userData.ledBurnt = burnt;
      this.applyLedGlow(led, brightness, burnt ? 0 : 1);
    }
    const powered = analysis.powered;
    this.recomputeFlow();
    this.events.onCircuitState(powered);
    this.events.onCircuitAnalysis?.(analysis);
    if (announce) {
      const { message, tone } = describeCircuit(analysis);
      this.events.onStatus(message, tone);
    }
    return powered;
  }

  /** Contact shadows sit on the board surface, so they show only while a part is seated. */
  private syncContactShadows(): void {
    for (const component of this.components.values()) {
      const shadow = component.userData.contactShadowMesh as Object3D | null | undefined;
      if (shadow === undefined) {
        let found: Object3D | null = null;
        component.traverse((child) => {
          if (child.userData.contactShadow) found = child;
        });
        component.userData.contactShadowMesh = found;
        continue;
      }
      if (shadow) shadow.visible = this.isFullyConnected(component.userData.sockets as EndpointSockets) && !this.remoteTweens.has(component.userData.componentId as string) && component !== this.dragging;
    }
  }

  /** Resin emission, glow light and burnt tint for one LED; `health` 0 = burnt (darkened). */
  private applyLedGlow(led: Group, brightness: number, health: number): void {
    for (const material of (led.userData.glowMaterials ?? []) as MeshStandardMaterial[]) {
      // Moderate emission keeps the resin's tint saturated under ACES tone mapping (no white-out).
      material.emissiveIntensity = brightness > 0 ? 0.35 + Math.sqrt(brightness) * 1.05 : 0;
    }
    const core = led.userData.ledCore as Mesh<SphereGeometry, MeshBasicMaterial> | undefined;
    if (core) {
      core.visible = brightness > 0;
      core.material.opacity = Math.min(1, 0.45 + Math.sqrt(brightness) * 0.55);
    }
    const glowLight = led.userData.glowLight as PointLight | undefined;
    if (glowLight) {
      glowLight.visible = QUALITY[this.quality].glowLights;
      glowLight.intensity = brightness * 1.1;
    }
    const scorch = led.userData.scorchMaterial as MeshStandardMaterial | undefined;
    if (scorch) scorch.opacity = (1 - health) * 0.55;
  }

  /** Reflects edited values on the model (resistor bands / label). */
  private refreshPartAppearance(component: Group): void {
    const refresh = component.userData.refreshAppearance as ((props: PartProps) => void) | undefined;
    const props = component.userData.props as PartProps | undefined;
    if (refresh && props) refresh(props);
  }

  /**
   * Snap Lab: every stud is a node. Snap wires and a closed S1 join nodes; a load (L1, M1)
   * runs when it sits on a path from B1+ to B1− through loads. A bare conductor path
   * between B1's terminals is a short circuit — the productive-failure moment of the kit.
   */
  private evaluateSnap(announce = false): boolean {
    const parent = Array.from(this.snapSockets, (_, index) => index);
    const find = (value: number): number => {
      while (parent[value] !== value) {
        parent[value] = parent[parent[value]];
        value = parent[value];
      }
      return value;
    };
    const part = (id: string): Group => this.components.get(id)!;
    const socketsOf = (id: string): EndpointSockets => part(id).userData.sockets as EndpointSockets;
    for (const spec of SNAP_COMPONENTS) {
      const sockets = socketsOf(spec.id);
      if (!this.isFullyConnected(sockets)) continue;
      if (spec.kind === "snapwire" || (spec.kind === "snapswitch" && part(spec.id).userData.switchOn)) {
        parent[find(sockets[0])] = find(sockets[1]);
      }
    }

    const battery = socketsOf("snap-b1");
    const lit = new Set<string>();
    let short = false;
    if (this.isFullyConnected(battery)) {
      const plus = find(battery[0]);
      const minus = find(battery[1]);
      short = plus === minus;
      const loads = ["snap-l1", "snap-m1"]
        .filter((id) => this.isFullyConnected(socketsOf(id)))
        .map((id) => {
          const sockets = socketsOf(id) as [number, number];
          return { id, a: find(sockets[0]), b: find(sockets[1]) };
        });
      const reaches = (from: number, to: number, skip: string): boolean => {
        const seen = new Set([from]);
        const queue = [from];
        while (queue.length) {
          const net = queue.shift()!;
          if (net === to) return true;
          for (const load of loads) {
            if (load.id === skip) continue;
            const next = load.a === net ? load.b : load.b === net ? load.a : null;
            if (next !== null && !seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
          }
        }
        return false;
      };
      if (!short) {
        for (const load of loads) {
          if (load.a === load.b) continue;
          const forward = reaches(plus, load.a, load.id) && reaches(load.b, minus, load.id);
          const backward = reaches(plus, load.b, load.id) && reaches(load.a, minus, load.id);
          if (forward || backward) lit.add(load.id);
        }
      }
    }

    const lamp = part("snap-l1");
    for (const material of (lamp.userData.glowMaterials ?? []) as MeshStandardMaterial[]) {
      material.emissiveIntensity = lit.has("snap-l1") ? 2.6 : 0;
    }
    const lampLight = lamp.userData.glowLight as PointLight | undefined;
    if (lampLight) lampLight.intensity = lit.has("snap-l1") ? 3 : 0;
    part("snap-m1").userData.motorOn = lit.has("snap-m1");
    const powered = lit.size > 0;
    this.events.onCircuitState(powered);

    if (short && !this.snapShortActive) {
      this.events.onStatus("Short circuit · B1's terminals are joined with no lamp or motor — remove a snap wire", "warning");
    }
    this.snapShortActive = short;
    if (announce && !short) {
      const switchPart = part("snap-s1");
      const switchPlaced = this.isFullyConnected(socketsOf("snap-s1"));
      const message = powered
        ? `${[lit.has("snap-l1") && "Lamp L1 is lit", lit.has("snap-m1") && "motor M1 is spinning"].filter(Boolean).join(" · ")}`
        : !this.isFullyConnected(battery)
          ? "Snap battery holder B1 onto the base grid first"
          : switchPlaced && !switchPart.userData.switchOn
            ? "Slide switch S1 is OFF · double-click it (or press Space) to close the loop"
            : "The loop is still open · trace from B1 + back to B1 − through every snap";
      this.events.onStatus(message, powered ? "valid" : "warning");
    }
    return powered;
  }

  /** The Snapino parts' placements and switch state, as the shared circuit model reads them. */
  snapinoBench(): SnapinoBench {
    const bench: SnapinoBench = {};
    for (const spec of SNAPINO_COMPONENTS) {
      const component = this.components.get(spec.id);
      if (!component) continue;
      const sockets = component.userData.sockets as EndpointSockets;
      bench[spec.id] = { sockets: this.isFullyConnected(sockets) ? [sockets[0], sockets[1]] : null, ...(spec.kind === "snapswitch" ? { on: Boolean(component.userData.switchOn) } : {}) };
    }
    return bench;
  }

  /** Pin levels come from the running program (main.ts drives a SnapinoRunner) or a transmission. */
  setSnapinoPins(pins: PinStates): void {
    this.snapinoPins = { ...pins };
    if (this.activeStudio === "snapino") this.evaluateSnapino();
  }

  /** Snapino loads the scene is showing as running right now (lit lamp/LED, spinning motor). */
  snapinoRunning(): string[] {
    return [...this.snapinoRunningLoads];
  }

  /** D2 reads HIGH when S1 (or a wire) bridges it to the 5V pad. */
  readSnapinoInput(): boolean {
    return this.snapinoInputHigh;
  }

  /**
   * Snapino: a load runs when one end sits on a net driven HIGH (5V, or a D pin the
   * program set HIGH) and the other end reaches GND. 5V straight to GND is a short.
   */
  private evaluateSnapino(announce = false): boolean {
    const part = (id: string): Group => this.components.get(id)!;
    const socketsOf = (id: string): EndpointSockets => part(id).userData.sockets as EndpointSockets;
    // One model for the lamp the learner sees and for the episode's signal (snapino-circuit.ts).
    const { short, inputHigh, pinShort, running } = analyzeSnapino(this.snapinoBench(), this.snapinoPins);
    this.snapinoInputHigh = inputHigh;
    this.snapinoRunningLoads = [...running];
    for (const id of ["sno-l1", "sno-d1"]) {
      const load = part(id);
      for (const material of (load.userData.glowMaterials ?? []) as MeshStandardMaterial[]) {
        material.emissiveIntensity = running.has(id) ? 2.6 : 0;
      }
      const light = load.userData.glowLight as PointLight | undefined;
      if (light) light.intensity = running.has(id) ? 2.6 : 0;
    }
    part("sno-m1").userData.motorOn = running.has("sno-m1");
    const powered = running.size > 0;
    this.events.onCircuitState(powered);

    const warning = short
      ? "Short circuit · 5V is joined straight to GND — remove a snap wire"
      : pinShort
        ? `${pinShort} is HIGH but wired straight to GND — put a load between them`
        : "";
    if (warning && warning !== this.snapinoWarning) this.events.onStatus(warning, "warning");
    this.snapinoWarning = warning;
    if (announce && !warning) {
      const wired = SNAPINO_LOADS.filter((id) => this.isFullyConnected(socketsOf(id)));
      const names = [...running].map((id) => part(id).userData.spec.name as string);
      const message = powered
        ? `${names.join(" · ")} running`
        : wired.length === 0
          ? "Snap a lamp, LED, or motor from a D pin to GND"
          : OUTPUT_PINS.every((pin) => !this.snapinoPins[pin])
            ? "Loads are wired · open the Code tab and upload a program"
            : "Program is running · check that each load's other end reaches GND";
      this.events.onStatus(message, powered ? "valid" : "warning");
    }
    this.events.onSnapinoChange?.();
    return powered;
  }

  loadSnapinoDemo(): void {
    if (this.activeStudio !== "snapino") return;
    // L1 from D5 down to row D and back to GND. Wiring S1 (D2 → 5V) is left to
    // the team: that path must cross this loop, the design problem of the task.
    this.submitLayout({
      "sno-l1": [SNAPINO_PADS.D5, 30],
      "sno-w3": [30, 33],
      "sno-w2a": [33, SNAPINO_PADS.GND],
    }, "Snapino lamp wired to D5");
  }

  private evaluateGreenhouse(announce = false): boolean {
    const connected = (id: string): boolean => {
      const component = this.components.get(id);
      return this.isFullyConnected(component?.userData.sockets as EndpointSockets | undefined);
    };
    const controller = connected("farm-controller");
    const soil = connected("soil-sensor");
    const pump = connected("water-pump");
    const hose = connected("irrigation-hose");
    const climate = connected("temp-sensor");
    const lightSensor = connected("light-sensor");
    const fan = connected("vent-fan");
    const solar = connected("solar-panel");
    const irrigation = controller && soil && pump && hose;
    const ventilation = controller && climate && fan;
    const systemReady = irrigation && ventilation && solar && lightSensor;

    this.environmentState.irrigation = irrigation;
    this.environmentState.ventilation = ventilation;
    this.environmentState.systemReady = systemReady;
    this.environmentTarget.moisture = irrigation ? 72 : 34;
    this.environmentTarget.temperature = ventilation ? 23.8 : 28.6;
    this.environmentTarget.light = solar && lightSensor ? 84 : lightSensor ? 66 : 58;
    this.environmentTarget.flow = irrigation ? 1.8 : 0;
    this.events.onCircuitState(systemReady);

    if (announce) {
      const missing = [
        !soil && "soil sensor",
        !controller && "controller",
        !pump && "pump",
        !hose && "irrigation hose",
        !climate && "climate sensor",
        !fan && "vent fan",
        !solar && "solar panel",
        !lightSensor && "light sensor",
      ].filter(Boolean) as string[];
      this.events.onStatus(
        systemReady
          ? "Greenhouse balanced · irrigation, ventilation, and solar monitoring are live"
          : `System check · connect ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` +${missing.length - 3} more` : ""}`,
        systemReady ? "valid" : "warning",
      );
    }
    return systemReady;
  }

  /**
   * A local edit takes over from a remote glide. With `settle`, the part first jumps to where
   * the glide was headed (used before a local grab, so it never starts from the lifted pose).
   */
  private cancelRemoteTween(component: Group, settle: boolean): void {
    const id = component.userData.componentId as string;
    const tween = this.remoteTweens.get(id);
    if (!tween) return;
    this.remoteTweens.delete(id);
    if (!settle) return;
    component.position.copy(tween.target);
    component.rotation.copy(tween.rotation);
    this.flexMotion.delete(id);
    this.updateFlexibleWireFromSockets(component);
    component.updateMatrixWorld(true);
  }

  private emitTransform(component: Group, force: boolean, activeEndpoint?: 0 | 1): void {
    this.cancelRemoteTween(component, false);
    if (!force && performance.now() - this.transformBroadcastAt < 40) return;
    // Live moves never carry electrical values: those change only through accepted edits, and
    // the room keeps its accepted values when it stores a move.
    const transform = this.snapshotTransform(component, activeEndpoint);
    delete transform.props;
    this.events.onTransform(component.userData.componentId as string, transform);
  }

  private snapshotTransform(component: Group, activeEndpoint?: 0 | 1): SharedTransform {
    // Mid-glide, report where a remote move is headed, not the in-between pose.
    const tween = this.remoteTweens.get(component.userData.componentId as string);
    const position = tween?.target ?? component.position;
    const rotation = tween?.rotation ?? component.rotation;
    const transform: SharedTransform = {
      position: position.toArray() as [number, number, number],
      rotation: [rotation.x, rotation.y, rotation.z],
      sockets: (component.userData.sockets as EndpointSockets) ?? null,
    };
    const spec = component.userData.spec as ComponentSpec;
    if (spec.kind === "snapswitch") transform.on = Boolean(component.userData.switchOn);
    if (component.userData.props) transform.props = { ...(component.userData.props as PartProps) };
    if (spec.kind === "wire" || spec.kind === "hose") {
      const endpoints = this.getEndpointPositions(component);
      transform.endpoints = [
        endpoints[0].toArray() as [number, number, number],
        endpoints[1].toArray() as [number, number, number],
      ];
      if (activeEndpoint !== undefined) transform.activeEndpoint = activeEndpoint;
    }
    return transform;
  }

  private updatePointer(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * Panels floating over the left and right of the scene: shift the projection so the bench
   * is centered in the open space between them. Picking uses the same projection, so it stays exact.
   */
  setViewInsets(left: number, right: number): void {
    this.viewInsets.left = left;
    this.viewInsets.right = right;
    this.applyViewOffset();
  }

  private applyViewOffset(): void {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    const shift = (this.viewInsets.right - this.viewInsets.left) / 2;
    if (Math.abs(shift) < 1) this.camera.clearViewOffset();
    else this.camera.setViewOffset(width, height, shift, 0, width, height);
    // Pull back a little when panels take a large share, so the parts tray stays in view.
    const open = width - this.viewInsets.left - this.viewInsets.right;
    this.camera.zoom = MathUtils.clamp(open / (width * 0.82), 0.74, 1);
    this.camera.updateProjectionMatrix();
  }

  private readonly resize = (): void => {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.renderer.setSize(width, height, false);
    this.applyViewOffset();
  };

  /** An LED that burns out pops bright for a moment, then goes dark with a scorched tint. */
  private stepLedFlashes(now: number): void {
    for (const [id, startedAt] of this.ledFlashes) {
      const led = this.components.get(id);
      const t = (now - startedAt) / 650;
      if (!led || t >= 1) {
        this.ledFlashes.delete(id);
        if (led) this.applyLedGlow(led, 0, 0);
        continue;
      }
      this.applyLedGlow(led, t < 0.25 ? 1 : (1 - t) * 1.2, Math.min(1, 1 - t));
    }
  }

  /** Glides remotely moved parts toward their target, lifted slightly while carried. */
  private stepRemoteTweens(seconds: number): void {
    const blend = 1 - Math.exp(-seconds * 9);
    for (const [id, tween] of this.remoteTweens) {
      const component = this.components.get(id);
      if (!component || component === this.dragging) {
        this.remoteTweens.delete(id);
        continue;
      }
      tween.base.lerp(tween.target, blend);
      component.rotation.set(
        this.lerpAngle(component.rotation.x, tween.rotation.x, blend),
        this.lerpAngle(component.rotation.y, tween.rotation.y, blend),
        this.lerpAngle(component.rotation.z, tween.rotation.z, blend),
      );
      const remaining = tween.base.distanceTo(tween.target);
      if (remaining < 0.003) {
        component.position.copy(tween.target);
        component.rotation.copy(tween.rotation);
        this.remoteTweens.delete(id);
        this.flexMotion.delete(id);
        this.updateFlexibleWireFromSockets(component);
      } else {
        component.position.copy(tween.base);
        component.position.y += Math.min(0.42, remaining * 0.3);
        this.updateFlexibleMotion(component);
      }
      component.updateMatrixWorld(true);
      if (component === this.selected) this.selectionBox.update();
    }
  }

  /** Runs first in every frame (the Rescue Signal transmission drives the bench pins here). */
  beforeFrame: (() => void) | null = null;

  private readonly render = (): void => {
    this.beforeFrame?.();
    if (this.cameraTween) this.stepCameraTween(performance.now());
    this.orbit.update();
    const now = performance.now();
    const frameSeconds = Math.min(0.05, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    if (this.remoteTweens.size) this.stepRemoteTweens(frameSeconds);
    this.remoteHands.update(this.camera);
    if (this.ledFlashes.size) this.stepLedFlashes(now);
    if (this.flowEnabled && this.flowWires.length && this.activeStudio === "circuit") this.placeFlowMarkers(frameSeconds);
    if (this.selected) {
      const indicators = (this.selected.userData.endpointIndicators ?? []) as Mesh[];
      const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.09;
      indicators.forEach((indicator, index) => {
        const activeBoost = this.draggingEndpoint?.component === this.selected && this.draggingEndpoint.index === index ? 1.18 : 1;
        indicator.scale.setScalar(pulse * activeBoost);
      });
    }
    if (this.dragging) {
      const pulse = Math.sin(performance.now() * 0.012) * 0.08;
      for (const marker of this.previewMarkers) {
        if (!marker.visible) continue;
        const baseScale = Number(marker.userData.baseScale ?? 1);
        const field = Number(marker.userData.field ?? 0);
        marker.scale.setScalar(baseScale * (1 + pulse * (0.3 + field)));
      }
    }
    if (this.activeStudio === "snap" || this.activeStudio === "snapino") {
      const motor = this.components.get(this.activeStudio === "snap" ? "snap-m1" : "sno-m1");
      const rotor = motor?.userData.rotor as Object3D | undefined;
      if (rotor && motor?.userData.motorOn) rotor.rotation.y += 0.42;
    }
    if (this.activeStudio === "greenhouse") {
      const delta = 0.018;
      this.environmentState.moisture = MathUtils.lerp(this.environmentState.moisture, this.environmentTarget.moisture, delta);
      this.environmentState.temperature = MathUtils.lerp(this.environmentState.temperature, this.environmentTarget.temperature, delta);
      this.environmentState.light = MathUtils.lerp(this.environmentState.light, this.environmentTarget.light, delta);
      this.environmentState.flow = MathUtils.lerp(this.environmentState.flow, this.environmentTarget.flow, delta * 1.8);
      const fanRotor = this.components.get("vent-fan")?.userData.rotor as Group | undefined;
      if (fanRotor && this.environmentState.ventilation) fanRotor.rotation.y += 0.22;
      const pumpRotor = this.components.get("water-pump")?.userData.rotor as Mesh | undefined;
      if (pumpRotor && this.environmentState.irrigation) pumpRotor.rotation.x += 0.15;
      const soilMaterial = this.greenhouseGroup.userData.soilMaterial as MeshStandardMaterial | undefined;
      soilMaterial?.color.lerp(new Color(this.environmentState.irrigation ? 0x35271d : 0x624329), 0.02);
      const plants = (this.greenhouseGroup.userData.plants ?? []) as Group[];
      const now = performance.now() * 0.001;
      plants.forEach((plant, index) => {
        plant.rotation.z = Math.sin(now * 1.2 + index) * (this.environmentState.ventilation ? 0.025 : 0.006);
      });
      if (performance.now() - this.environmentEmitAt > 180) {
        this.events.onEnvironmentState({ ...this.environmentState });
        this.environmentEmitAt = performance.now();
      }
    }
    if (this.renderer.shadowMap.enabled && (this.dragging || this.remoteTweens.size || this.shadowDirtyFrames > 0)) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirtyFrames = Math.max(0, this.shadowDirtyFrames - 1);
    }
    this.renderer.render(this.scene, this.camera);
    this.adaptResolution(now);
  };

  /**
   * Adaptive resolution: if frames run slow (> 33 ms average over ~2 s), step the pixel ratio
   * down within the quality tier; if they run comfortably fast, step back up. Bounded so it
   * never oscillates for long.
   */
  private adaptResolution(now: number): void {
    if (document.hidden) return;
    const sample = this.frameTimes;
    sample.push(now);
    if (sample.length < 120) return;
    const average = (sample[sample.length - 1] - sample[0]) / (sample.length - 1);
    sample.length = 0;
    const tier = QUALITY[this.quality];
    const ceiling = Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio);
    let next = this.pixelRatio;
    if (average > 33 && this.pixelRatio > tier.minPixelRatio) next = Math.max(tier.minPixelRatio, this.pixelRatio - 0.25);
    else if (average < 14 && this.pixelRatio < ceiling && this.adaptations < 6) next = Math.min(ceiling, this.pixelRatio + 0.25);
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.adaptations += 1;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  get renderQuality(): RenderQuality {
    return this.quality;
  }
}

function propKind(spec: ComponentSpec): "resistor" | "battery" | null {
  if (spec.studio !== "circuit") return null;
  if (spec.kind === "resistor") return "resistor";
  if (spec.kind === "battery") return "battery";
  return null;
}

function defaultProps(spec: ComponentSpec): PartProps | null {
  if (spec.id === "resistor-220") return { ohms: 220 };
  if (spec.id === "resistor-1k") return { ohms: 1000 };
  if (spec.id === "battery-9v") return { volts: 9 };
  return null;
}

/** One status line for the engine result: what happened, with the numbers that explain it. */
export function describeCircuit(analysis: CircuitAnalysis): { message: string; tone: "neutral" | "valid" | "warning" } {
  const board = analysis.board;
  const reading = (id: string | undefined) => (id ? board.result.elements[id] : undefined);
  const source = board.result.elements["battery-9v"];
  if (board.result.status === "invalid" || board.result.status === "singular" || board.result.status === "non-convergence") {
    return { message: `Simulation stopped · ${board.diagnostics.find((d) => d.severity === "error")?.message ?? "the circuit could not be solved"}`, tone: "warning" };
  }
  if (analysis.short) {
    return { message: `Short circuit · the battery's terminals are bridged (${formatAmps(Math.abs(source?.amps ?? 0))}); nothing is powered safely`, tone: "warning" };
  }
  if (analysis.unprotectedLeds.length) {
    const led = reading(analysis.unprotectedLeds[0]);
    return { message: `LED would burn out · ${formatAmps(led?.amps ?? 0)} with nothing limiting the current (rating 20 mA)`, tone: "warning" };
  }
  if (analysis.overdrivenLeds.length) {
    const led = reading(analysis.overdrivenLeds[0]);
    return { message: `LED overdriven · ${formatAmps(led?.amps ?? 0)} exceeds its 20 mA rating; use a larger resistor`, tone: "warning" };
  }
  if (analysis.reverseStressedLeds.length) {
    const led = reading(analysis.reverseStressedLeds[0]);
    return { message: `LED backwards at ${formatVolts(Math.abs(led?.volts ?? 0))} · more than the ~5 V an LED tolerates in reverse; turn it around`, tone: "warning" };
  }
  if (analysis.powered) {
    const id = board.safeLitLeds[0];
    const led = reading(id);
    return { message: `Circuit powered · LED at ${formatAmps(led?.amps ?? 0)}, ${formatVolts(led?.volts)} across it (within its 20 mA rating)`, tone: "valid" };
  }
  if (analysis.reversedLeds.length) {
    return { message: "LED is backwards · its anode (long lead, lead A) must face the battery's + side", tone: "warning" };
  }
  if (!analysis.batteryPlaced) return { message: "Needs review · place the battery so current has a source", tone: "warning" };
  if (board.result.status === "open-circuit") return { message: "Open circuit · the path does not return to the battery, so no current flows", tone: "warning" };
  return { message: "Needs review · no LED is lit yet", tone: "warning" };
}


/**
 * Render tier from `?quality=low|medium|high`; otherwise a guess from the device (small touch
 * screens and low core counts start on low). The frame-time monitor adjusts resolution further.
 */
export function defaultQuality(): RenderQuality {
  const requested = new URLSearchParams(location.search).get("quality");
  if (requested === "low" || requested === "medium" || requested === "high") return requested;
  const cores = navigator.hardwareConcurrency ?? 4;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  if (coarse || cores <= 2) return "low";
  return "medium";
}


/**
 * Merges a static model's meshes that share a material (and attribute layout) into one mesh
 * each, baking their transforms relative to `root`. Used for the Snap/Snapino base and carrier
 * GLBs, which are hundreds of separate meshes but never move or get picked individually.
 */
function mergeStaticMeshes(root: Object3D): void {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  type Bucket = { material: Material; geometries: BufferGeometry[]; meshes: Mesh[] };
  const buckets = new Map<string, Bucket>();
  root.traverse((child) => {
    if (!(child instanceof Mesh) || Array.isArray(child.material) || child instanceof InstancedMesh) return;
    const geometry = child.geometry as BufferGeometry;
    const key = `${child.material.uuid}|${Object.keys(geometry.attributes).sort().join(",")}|${geometry.index ? "i" : "n"}`;
    const bucket: Bucket = buckets.get(key) ?? { material: child.material as Material, geometries: [], meshes: [] };
    const baked = geometry.clone();
    baked.applyMatrix4(child.matrixWorld.clone().premultiply(inverse));
    bucket.geometries.push(baked);
    bucket.meshes.push(child);
    buckets.set(key, bucket);
  });
  for (const bucket of buckets.values()) {
    if (bucket.meshes.length < 2) continue;
    const merged = mergeGeometries(bucket.geometries, false);
    if (!merged) continue;
    for (const mesh of bucket.meshes) mesh.removeFromParent();
    const mesh = new Mesh(merged, bucket.material);
    mesh.receiveShadow = true;
    mesh.name = `merged_${bucket.material.name || "static"}`;
    root.add(mesh);
  }
}
