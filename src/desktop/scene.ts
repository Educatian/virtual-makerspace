import {
  AdditiveBlending,
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  BoxHelper,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Euler,
  Group,
  InstancedMesh,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PCFSoftShadowMap,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

import type { SharedTransform } from "./collaboration.js";

export type StudioKind = "circuit" | "greenhouse";
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
  | "solar";

export interface ComponentSpec {
  id: string;
  name: string;
  detail: string;
  kind: ComponentKind;
  color: number;
  leadSeparation: number;
  studio: StudioKind;
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
  onCircuitState: (powered: boolean) => void;
  onEnvironmentState: (state: EnvironmentState) => void;
}

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
const MAGNETIC_RADIUS = 0.72;

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

const COMPONENTS = [...CIRCUIT_COMPONENTS, ...GREENHOUSE_COMPONENTS];

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
  private readonly circuitSockets: Vector3[] = [];
  private readonly greenhouseSockets: Vector3[] = [];
  private sockets: Vector3[] = this.circuitSockets;
  private readonly remoteOwners = new Map<string, { id: string; name: string }>();
  private readonly previewMarkers: Mesh<RingGeometry, MeshBasicMaterial>[] = [];
  private readonly previewBeams: Mesh<CylinderGeometry, MeshBasicMaterial>[] = [];
  private readonly flexMotion = new Map<string, { previous: Vector3; sway: number; velocity: number }>();
  private readonly selectionBox = new BoxHelper(new Group(), COLORS.blue);
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

  constructor(host: HTMLElement, events: SceneEvents) {
    this.host = host;
    this.events = events;
    this.scene.background = new Color(0x0a0e18);

    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setAnimationLoop(this.render);
    this.renderer.domElement.className = "workbench-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Interactive 3D electronics workbench");
    this.host.append(this.renderer.domElement);

    this.camera.position.set(6.4, 6.1, 7.7);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0.1, 0.2, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 5.2;
    this.orbit.maxDistance = 14;
    this.orbit.minPolarAngle = MathUtils.degToRad(20);
    this.orbit.maxPolarAngle = MathUtils.degToRad(75);
    this.orbit.screenSpacePanning = false;
    this.orbit.update();

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setMode("rotate");
    this.transform.setSpace("world");
    this.transform.setRotationSnap(MathUtils.degToRad(15));
    this.transform.setSize(0.72);
    this.scene.add(this.transform.getHelper());

    this.scene.add(this.selectionBox);
    this.selectionBox.visible = false;

    this.setupLighting();
    this.setupTable();
    this.scene.add(this.circuitGroup, this.greenhouseGroup);
    this.setupBreadboard();
    this.setupGreenhouse();
    this.setupComponents();
    this.setupSnapMarkers();
    this.bindInteractions();

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
    this.activeStudio = studio;
    this.circuitGroup.visible = studio === "circuit";
    this.greenhouseGroup.visible = studio === "greenhouse";
    this.sockets = studio === "circuit" ? this.circuitSockets : this.greenhouseSockets;
    this.camera.position.set(studio === "circuit" ? 6.4 : 7.2, studio === "circuit" ? 6.1 : 5.8, studio === "circuit" ? 7.7 : 8.6);
    this.orbit.target.set(studio === "circuit" ? 0.1 : 0, studio === "circuit" ? 0.2 : 0.55, studio === "circuit" ? 0 : -0.1);
    this.orbit.update();
    if (studio === "greenhouse") this.evaluateGreenhouse();
    else this.evaluateCircuit();
    if (announce) {
      this.events.onStatus(
        studio === "greenhouse" ? "Greenhouse Studio ready · connect sensors, water, air, and power" : "Circuit Bench ready",
        "valid",
      );
    }
  }

  selectById(componentId: string): void {
    const component = this.components.get(componentId);
    if (!component) return;
    this.select(component);
  }

  focusSelected(): void {
    if (!this.selected) return;
    const target = this.selected.position.clone();
    const offset = this.camera.position.clone().sub(this.orbit.target).normalize().multiplyScalar(5.4);
    this.orbit.target.copy(target);
    this.camera.position.copy(target).add(offset);
    this.orbit.update();
  }

  resetView(): void {
    this.camera.position.set(this.activeStudio === "circuit" ? 6.4 : 7.2, this.activeStudio === "circuit" ? 6.1 : 5.8, this.activeStudio === "circuit" ? 7.7 : 8.6);
    this.orbit.target.set(this.activeStudio === "circuit" ? 0.1 : 0, this.activeStudio === "circuit" ? 0.2 : 0.55, this.activeStudio === "circuit" ? 0 : -0.1);
    this.orbit.update();
  }

  resetSelectedRotation(): void {
    if (!this.selected) return;
    this.selected.rotation.set(0, 0, 0);
    this.selected.updateMatrixWorld(true);
    this.emitTransform(this.selected, true);
    this.selectionBox.update();
    this.events.onStatus("Rotation reset", "neutral");
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

  applyRemoteTransform(componentId: string, transform: SharedTransform): void {
    const component = this.components.get(componentId);
    if (!component) return;
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
    if (component === this.dragging || component === this.transform.object) return;
    component.position.fromArray(transform.position);
    component.rotation.fromArray([...transform.rotation, "XYZ"]);
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

  setOwner(componentId: string, owner: { id: string; name: string } | null): void {
    if (owner) this.remoteOwners.set(componentId, owner);
    else this.remoteOwners.delete(componentId);
    const endpointMatch = componentId.match(/^(.*)::endpoint-([01])$/);
    const object = this.components.get(endpointMatch?.[1] ?? componentId);
    if (!object) return;
    if (endpointMatch) {
      const index = Number(endpointMatch[2]) as 0 | 1;
      const indicator = ((object.userData.endpointIndicators ?? []) as Mesh<TorusGeometry, MeshBasicMaterial>[])[index];
      if (indicator) indicator.material.color.setHex(owner ? 0x56c8ff : 0x39ff9a);
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
      this.applyRemoteTransform(id, transform);
    }
    this.events.onStatus("Shared circuit synchronized", "valid");
  }

  saveAttempt(summary = "Workbench state saved"): SceneSnapshot {
    const snapshot = this.captureAttempt(summary);
    this.events.onAttempt(snapshot);
    return snapshot;
  }

  restoreAttempt(snapshot: SceneSnapshot): void {
    for (const [id, transform] of Object.entries(snapshot.transforms)) {
      this.applyRemoteTransform(id, transform);
      this.events.onTransform(id, transform);
    }
    const restored = this.captureAttempt(`Restored from ${snapshot.id}`);
    this.events.onAttempt(restored);
    this.events.onStatus("Attempt restored as a new state", "valid");
  }

  checkCircuit(): boolean {
    return this.evaluateCurrentSystem(true);
  }

  loadCircuitDemo(): void {
    if (this.activeStudio !== "circuit") return;
    const layout: Record<string, [number, number]> = {
      "battery-9v": [21, 23],
      "resistor-220": [36, 39],
      "led-red": [52, 53],
    };
    for (const [id, pair] of Object.entries(layout)) {
      const component = this.components.get(id);
      if (!component) continue;
      const a = this.circuitSockets[pair[0]];
      const b = this.circuitSockets[pair[1]];
      const midpoint = a.clone().add(b).multiplyScalar(0.5);
      const direction = b.clone().sub(a);
      component.position.set(midpoint.x, DRAG_Y, midpoint.z);
      component.rotation.set(0, Math.atan2(-direction.z, direction.x), 0);
      component.userData.sockets = pair;
      component.updateMatrixWorld(true);
      this.emitTransform(component, true);
    }
    this.evaluateCircuit(true);
    this.events.onAttempt(this.captureAttempt("Diagnostic LED path connected"));
  }

  loadGreenhouseDemo(): void {
    if (this.activeStudio !== "greenhouse") return;
    const layout: Record<string, [number, number]> = {
      "soil-sensor": [0, 1],
      "temp-sensor": [2, 3],
      "light-sensor": [4, 5],
      "farm-controller": [6, 8],
      "solar-panel": [9, 11],
      "water-pump": [12, 14],
      "irrigation-hose": [15, 18],
      "vent-fan": [19, 21],
    };
    for (const [id, pair] of Object.entries(layout)) {
      const component = this.components.get(id);
      if (!component) continue;
      const a = this.greenhouseSockets[pair[0]];
      const b = this.greenhouseSockets[pair[1]];
      const midpoint = a.clone().add(b).multiplyScalar(0.5);
      component.position.set(midpoint.x, DRAG_Y, midpoint.z);
      component.rotation.set(0, Math.atan2(-(b.z - a.z), b.x - a.x), 0);
      component.userData.sockets = pair;
      component.updateMatrixWorld(true);
      const spec = component.userData.spec as ComponentSpec;
      if (spec.kind === "wire" || spec.kind === "hose") {
        const endpoints = this.getEndpointPositions(component);
        endpoints[0].copy(component.worldToLocal(a.clone()));
        endpoints[1].copy(component.worldToLocal(b.clone()));
        this.updateFlexibleWireGeometry(component, true);
      } else {
        this.updateFlexibleWire(component, a.distanceTo(b), true);
      }
      component.updateMatrixWorld(true);
      this.emitTransform(component, true);
    }
    this.evaluateGreenhouse(true);
    this.events.onAttempt(this.captureAttempt("Field test layout connected"));
  }

  dispose(): void {
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

  private setupLighting(): void {
    const ambient = new AmbientLight(0xc7d2e0, 1.8);
    this.scene.add(ambient);
    const key = new DirectionalLight(0xfff0d8, 3.1);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);
    const fill = new DirectionalLight(0x7aa2e8, 1.0);
    fill.position.set(-5, 4, -3);
    this.scene.add(fill);
  }

  private setupTable(): void {
    const tabletop = new Mesh(
      new BoxGeometry(11, 0.26, 7.8),
      new MeshStandardMaterial({ color: COLORS.wood, roughness: 0.78, metalness: 0.02 }),
    );
    tabletop.position.y = -0.13;
    tabletop.receiveShadow = true;
    this.scene.add(tabletop);

    const tray = new Mesh(
      new BoxGeometry(2.45, 0.12, 5.7),
      new MeshStandardMaterial({ color: COLORS.tray, roughness: 0.82 }),
    );
    tray.position.set(3.55, 0.06, 0);
    tray.receiveShadow = true;
    this.scene.add(tray);
  }

  private setupBreadboard(): void {
    const board = new Group();
    board.position.x = BOARD_X;
    const pcb = new Mesh(
      new RoundedBoxGeometry(4.82, 0.16, 4.28, 5, 0.14),
      new MeshPhysicalMaterial({ color: 0x173f38, roughness: 0.48, metalness: 0.18, clearcoat: 0.28 }),
    );
    pcb.position.y = 0.04;
    pcb.receiveShadow = true;
    board.add(pcb);
    const body = new Mesh(
      new RoundedBoxGeometry(4.25, 0.28, 3.7, 5, 0.11),
      new MeshPhysicalMaterial({
        color: COLORS.board,
        roughness: 0.72,
        metalness: 0,
        clearcoat: 0.08,
        clearcoatRoughness: 0.8,
      }),
    );
    body.position.y = 0.14;
    body.receiveShadow = true;
    board.add(body);

    const edge = new Mesh(
      new BoxGeometry(4.34, 0.13, 3.79),
      new MeshStandardMaterial({ color: COLORS.boardEdge, roughness: 0.82 }),
    );
    edge.position.y = 0.045;
    board.add(edge);

    const traceMaterial = new MeshStandardMaterial({ color: 0xc89d4d, roughness: 0.28, metalness: 0.82 });
    for (const [x, z, width, depth] of [
      [0, -2.02, 3.9, 0.025],
      [0, 2.02, 3.9, 0.025],
      [-2.25, 0, 0.025, 3.55],
      [2.25, 0, 0.025, 3.55],
      [1.92, 1.42, 0.62, 0.025],
      [-1.86, -1.4, 0.72, 0.025],
    ] as const) {
      const trace = new Mesh(new BoxGeometry(width, 0.014, depth), traceMaterial);
      trace.position.set(x, 0.135, z);
      board.add(trace);
    }

    const mountingMaterial = new MeshStandardMaterial({ color: 0xd6b56c, roughness: 0.24, metalness: 0.9 });
    for (const x of [-2.24, 2.24]) {
      for (const z of [-1.96, 1.96]) {
        const mount = new Mesh(new TorusGeometry(0.105, 0.028, 10, 24), mountingMaterial);
        mount.rotation.x = Math.PI / 2;
        mount.position.set(x, 0.15, z);
        board.add(mount);
      }
    }

    const channel = new Mesh(
      new BoxGeometry(3.85, 0.035, 0.18),
      new MeshStandardMaterial({ color: 0x37332d, roughness: 0.9 }),
    );
    channel.position.y = 0.295;
    board.add(channel);

    const stripeGeometry = new BoxGeometry(3.78, 0.012, 0.035);
    const red = new Mesh(stripeGeometry, new MeshStandardMaterial({ color: 0xcc4d4d, roughness: 0.65 }));
    red.position.set(0, 0.292, -1.73);
    board.add(red);
    const blue = new Mesh(stripeGeometry, new MeshStandardMaterial({ color: 0x3b6fb6, roughness: 0.65 }));
    blue.position.set(0, 0.292, 1.73);
    board.add(blue);
    const upperBlue = blue.clone();
    upperBlue.position.z = -1.62;
    board.add(upperBlue);
    const lowerRed = red.clone();
    lowerRed.position.z = 1.62;
    board.add(lowerRed);

    const controllerBody = new Mesh(
      new RoundedBoxGeometry(0.56, 0.16, 0.82, 4, 0.06),
      new MeshStandardMaterial({ color: 0x101820, roughness: 0.36, metalness: 0.24 }),
    );
    controllerBody.position.set(2.08, 0.24, 0.52);
    board.add(controllerBody);
    for (const z of [-0.28, -0.14, 0, 0.14, 0.28]) {
      for (const x of [1.76, 2.4]) {
        const pin = new Mesh(new BoxGeometry(0.12, 0.025, 0.035), mountingMaterial);
        pin.position.set(x, 0.23, 0.52 + z);
        board.add(pin);
      }
    }
    const powerJack = new Mesh(
      new RoundedBoxGeometry(0.5, 0.3, 0.42, 4, 0.055),
      new MeshStandardMaterial({ color: 0x9da8b4, roughness: 0.3, metalness: 0.78 }),
    );
    powerJack.position.set(-2.12, 0.24, -1.45);
    board.add(powerJack);
    for (const z of [-1.2, -0.98]) {
      const capacitor = new Mesh(
        new CylinderGeometry(0.095, 0.095, 0.32, 18),
        new MeshStandardMaterial({ color: 0x243d63, roughness: 0.36, metalness: 0.38 }),
      );
      capacitor.position.set(-2.12, 0.31, z);
      board.add(capacitor);
    }

    const holes = new InstancedMesh(
      new CylinderGeometry(0.035, 0.026, 0.04, 12),
      new MeshStandardMaterial({ color: 0x171717, roughness: 0.42, metalness: 0.45 }),
      COLS * ROWS,
    );
    const dummy = new Object3D();
    const rows = socketRows();
    let index = 0;
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const x = BOARD_X - ((COLS - 1) * PITCH) / 2 + col * PITCH;
        const z = rows[row];
        this.circuitSockets.push(new Vector3(x, BOARD_TOP + 0.015, z));
        dummy.position.set(x - BOARD_X, BOARD_TOP, z);
        dummy.rotation.x = Math.PI;
        dummy.updateMatrix();
        holes.setMatrixAt(index++, dummy.matrix);
      }
    }
    holes.instanceMatrix.needsUpdate = true;
    board.add(holes);
    this.circuitGroup.add(board);
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
    COMPONENTS.forEach((spec, index) => {
      const component = this.createComponent(spec);
      const positions = spec.studio === "circuit" ? circuitPositions : greenhousePositions;
      const localIndex = spec.studio === "circuit" ? index : index - CIRCUIT_COMPONENTS.length;
      component.position.set(...positions[localIndex]);
      component.userData.componentId = spec.id;
      component.userData.spec = spec;
      component.userData.sockets = null;
      component.traverse((child) => {
        child.userData.componentRoot = component;
        if (child instanceof Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      this.components.set(spec.id, component);
      (spec.studio === "circuit" ? this.circuitGroup : this.greenhouseGroup).add(component);
    });
  }

  private createComponent(spec: ComponentSpec): Group {
    const group = new Group();
    const metal = new MeshStandardMaterial({ color: COLORS.metal, roughness: 0.33, metalness: 0.82 });

    if (spec.kind === "led") {
      const bodyMaterial = new MeshStandardMaterial({
        color: spec.color,
        emissive: spec.color,
        emissiveIntensity: 0,
        roughness: 0.28,
        transparent: true,
        opacity: 0.92,
      });
      const dome = new Mesh(new SphereGeometry(0.19, 24, 18), bodyMaterial);
      dome.scale.y = 1.2;
      dome.position.y = 0.24;
      group.add(dome);
      const collar = new Mesh(new CylinderGeometry(0.19, 0.19, 0.1, 24), bodyMaterial);
      collar.position.y = 0.1;
      group.add(collar);
      for (const x of [-spec.leadSeparation / 2, spec.leadSeparation / 2]) {
        const lead = new Mesh(new CylinderGeometry(0.025, 0.025, 0.44, 10), metal);
        lead.position.set(x, -0.12, 0);
        group.add(lead);
      }
      group.userData.glowMaterials = [bodyMaterial];
    }

    if (spec.kind === "resistor") {
      const leadGeometry = new CylinderGeometry(0.025, 0.025, spec.leadSeparation, 10);
      const lead = new Mesh(leadGeometry, metal);
      lead.rotation.z = Math.PI / 2;
      group.add(lead);
      const body = new Mesh(
        new CylinderGeometry(0.12, 0.12, 0.5, 24),
        new MeshStandardMaterial({ color: spec.color, roughness: 0.58 }),
      );
      body.rotation.z = Math.PI / 2;
      body.position.y = 0.12;
      group.add(body);
      const bandColors = [0x6b2b1f, 0x191919, spec.id === "resistor-220" ? 0xa83232 : 0x9f6a1f];
      bandColors.forEach((color, index) => {
        const band = new Mesh(
          new TorusGeometry(0.123, 0.018, 8, 20),
          new MeshStandardMaterial({ color, roughness: 0.48 }),
        );
        band.rotation.y = Math.PI / 2;
        band.position.set((index - 1) * 0.12, 0.12, 0);
        group.add(band);
      });
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
      const body = new Mesh(
        new TubeGeometry(curve, 28, spec.kind === "hose" ? 0.075 : 0.045, 10, false),
        new MeshPhysicalMaterial({
          color: spec.color,
          roughness: spec.kind === "hose" ? 0.72 : 0.54,
          metalness: 0.02,
          clearcoat: spec.kind === "hose" ? 0.12 : 0.34,
          clearcoatRoughness: 0.62,
          sheen: spec.kind === "hose" ? 0.18 : 0.08,
          sheenRoughness: 0.74,
        }),
      );
      body.userData.flexibleWireBody = true;
      group.userData.wireBody = body;
      group.add(body);
      const wireTips: Mesh[] = [];
      const wireCollars: Mesh[] = [];
      const endpointIndicators: Mesh<TorusGeometry, MeshBasicMaterial>[] = [];
      const endpointHitTargets: Mesh<SphereGeometry, MeshBasicMaterial>[] = [];
      for (const [index, x] of [-half, half].entries()) {
        const tip = new Mesh(new CylinderGeometry(spec.kind === "hose" ? 0.055 : 0.024, spec.kind === "hose" ? 0.055 : 0.024, 0.34, 10), metal);
        tip.position.set(x, -0.14, 0);
        tip.userData.endpointIndex = index;
        group.add(tip);
        const collar = new Mesh(
          new CylinderGeometry(spec.kind === "hose" ? 0.105 : 0.052, spec.kind === "hose" ? 0.095 : 0.048, 0.13, 16),
          new MeshStandardMaterial({ color: spec.kind === "hose" ? 0xb88b3e : 0x1f2937, roughness: 0.34, metalness: spec.kind === "hose" ? 0.7 : 0.28 }),
        );
        collar.position.set(x, 0.015, 0);
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
      const body = new Mesh(
        new BoxGeometry(0.82, 0.76, 0.46),
        new MeshStandardMaterial({ color: 0x20242a, roughness: 0.68, metalness: 0.08 }),
      );
      body.position.y = 0.23;
      group.add(body);
      const top = new Mesh(
        new BoxGeometry(0.84, 0.17, 0.48),
        new MeshStandardMaterial({ color: 0xa9672c, roughness: 0.45, metalness: 0.35 }),
      );
      top.position.y = 0.69;
      group.add(top);
      for (const [x, color] of [[-spec.leadSeparation / 2, 0xd5a857], [spec.leadSeparation / 2, 0xc7cbd0]] as const) {
        const terminal = new Mesh(
          new CylinderGeometry(0.08, 0.08, 0.12, 16),
          new MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.75 }),
        );
        terminal.position.set(x, 0.84, 0);
        group.add(terminal);
        const lead = new Mesh(new CylinderGeometry(0.024, 0.024, 0.44, 10), metal);
        lead.position.set(x, -0.2, 0);
        group.add(lead);
      }
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
    return group;
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
    if (!this.dragging || this.dragPointerId !== event.pointerId) return;
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
    const curve = new CatmullRomCurve3([
      start.clone(),
      point(0.14, arch * 0.56, lateral * 0.28),
      point(0.31, arch * 0.92, lateral * 0.72),
      point(0.5, arch, lateral),
      point(0.69, arch * 0.88, lateral * 0.58),
      point(0.86, arch * 0.52, lateral * 0.18),
      end.clone(),
    ]);
    body.geometry.dispose();
    body.geometry = new TubeGeometry(curve, spec.kind === "hose" ? 52 : 44, spec.kind === "hose" ? 0.075 : 0.045, spec.kind === "hose" ? 14 : 12, false);
    tips[0].position.copy(start).add(new Vector3(0, -0.14, 0));
    tips[1].position.copy(end).add(new Vector3(0, -0.14, 0));
    collars?.[0]?.position.copy(start).add(new Vector3(0, 0.015, 0));
    collars?.[1]?.position.copy(end).add(new Vector3(0, 0.015, 0));
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
    return this.activeStudio === "greenhouse" ? this.evaluateGreenhouse(announce) : this.evaluateCircuit(announce);
  }

  private isFullyConnected(sockets: EndpointSockets | undefined): sockets is [number, number] {
    return Boolean(
      sockets &&
      Number.isInteger(sockets[0]) &&
      Number.isInteger(sockets[1]),
    );
  }

  private evaluateCircuit(announce = false): boolean {
    const parent = new Int16Array(2 + COLS * 2);
    for (let i = 0; i < parent.length; i += 1) parent[i] = i;
    const find = (value: number): number => {
      let current = value;
      while (parent[current] !== current) {
        parent[current] = parent[parent[current]];
        current = parent[current];
      }
      return current;
    };
    const union = (a: number, b: number): void => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootA] = rootB;
    };
    const socketToNet = (socketIndex: number): number => {
      const row = Math.floor(socketIndex / COLS);
      const col = socketIndex % COLS;
      if (row === 0) return 0;
      if (row === ROWS - 1) return 1;
      if (row <= 5) return 2 + col;
      return 2 + COLS + col;
    };

    for (const component of this.components.values()) {
      const spec = component.userData.spec as ComponentSpec;
      const sockets = component.userData.sockets as EndpointSockets;
      if (!this.isFullyConnected(sockets) || (spec.kind !== "wire" && spec.kind !== "resistor")) continue;
      union(socketToNet(sockets[0]), socketToNet(sockets[1]));
    }

    const battery = this.components.get("battery-9v");
    const batterySockets = battery?.userData.sockets as EndpointSockets | undefined;
    let powered = false;
    if (this.isFullyConnected(batterySockets)) {
      const sourceA = find(socketToNet(batterySockets[0]));
      const sourceB = find(socketToNet(batterySockets[1]));
      for (const id of ["led-red", "led-green"]) {
        const led = this.components.get(id)!;
        const ledSockets = led.userData.sockets as EndpointSockets;
        let lit = false;
        if (this.isFullyConnected(ledSockets)) {
          const ledA = find(socketToNet(ledSockets[0]));
          const ledB = find(socketToNet(ledSockets[1]));
          lit = (ledA === sourceA && ledB === sourceB) || (ledA === sourceB && ledB === sourceA);
        }
        for (const material of (led.userData.glowMaterials ?? []) as MeshStandardMaterial[]) {
          material.emissiveIntensity = lit ? 3.2 : 0;
        }
        powered ||= lit;
      }
    } else {
      for (const id of ["led-red", "led-green"]) {
        const led = this.components.get(id)!;
        for (const material of (led.userData.glowMaterials ?? []) as MeshStandardMaterial[]) {
          material.emissiveIntensity = 0;
        }
      }
    }
    this.events.onCircuitState(powered);
    if (announce) {
      this.events.onStatus(
        powered ? "Circuit powered · the current path is complete" : "Needs review · the current path is still open",
        powered ? "valid" : "warning",
      );
    }
    return powered;
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

  private emitTransform(component: Group, force: boolean, activeEndpoint?: 0 | 1): void {
    if (!force && performance.now() - this.transformBroadcastAt < 40) return;
    this.events.onTransform(
      component.userData.componentId as string,
      this.snapshotTransform(component, activeEndpoint),
    );
  }

  private snapshotTransform(component: Group, activeEndpoint?: 0 | 1): SharedTransform {
    const transform: SharedTransform = {
      position: component.position.toArray() as [number, number, number],
      rotation: [component.rotation.x, component.rotation.y, component.rotation.z],
      sockets: (component.userData.sockets as EndpointSockets) ?? null,
    };
    const spec = component.userData.spec as ComponentSpec;
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

  private readonly resize = (): void => {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly render = (): void => {
    this.orbit.update();
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
    this.renderer.render(this.scene, this.camera);
  };
}
