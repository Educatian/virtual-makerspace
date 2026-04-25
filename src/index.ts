import {
  AssetManager,
  AssetManifest,
  AssetType,
  Box3,
  BoxGeometry,
  EnvironmentType,
  FollowBehavior,
  Follower,
  Group,
  LocomotionEnvironment,
  Mesh,
  MeshStandardMaterial,
  PanelUI,
  PlaneGeometry,
  SessionMode,
  World,
} from "@iwsdk/core";

import { createBreadboard } from "./breadboard.js";
import {
  CircuitNode,
  LedState,
  PowerSource,
  WireEnds,
} from "./components/circuit.js";
import { Snappable, SnapTarget } from "./components/snap.js";
import { SocketGrid } from "./components/socket-grid.js";
import {
  spawnBattery,
  spawnLed,
  spawnResistor,
  spawnWire,
} from "./spawn-components.js";
import {
  createPlacementGuides,
  type Placement,
} from "./placement-guides.js";
import { IdleCharacter } from "./components/idle-character.js";
import { CircuitEvalSystem } from "./systems/circuit-eval-system.js";
import { HoverPreviewSystem } from "./systems/hover-preview-system.js";
import { HudSystem } from "./systems/hud-system.js";
import { IdleCharacterSystem } from "./systems/idle-character-system.js";
import { SnapSystem } from "./systems/snap-system.js";
import { telemetry } from "./telemetry.js";

const assets: AssetManifest = {
  robot: {
    url: "./gltf/robot/robot.gltf",
    type: AssetType.GLTF,
    priority: "critical",
  },
};

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets,
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: "always",
    features: { handTracking: true, layers: true },
  },
  features: {
    locomotion: { useWorker: true },
    grabbing: true,
    physics: true,
    sceneUnderstanding: false,
    environmentRaycast: false,
  },
}).then((world) => {
  world
    .registerComponent(SocketGrid)
    .registerComponent(Snappable)
    .registerComponent(SnapTarget)
    .registerComponent(CircuitNode)
    .registerComponent(WireEnds)
    .registerComponent(LedState)
    .registerComponent(PowerSource)
    .registerComponent(IdleCharacter);

  world
    .registerSystem(SnapSystem)
    .registerSystem(HoverPreviewSystem)
    .registerSystem(CircuitEvalSystem)
    .registerSystem(HudSystem)
    .registerSystem(IdleCharacterSystem);

  telemetry.log("session_start", {
    iwsdk_version: "0.3.1",
    user_agent: navigator.userAgent,
  });

  world.camera.position.set(0, 1.6, 0);
  world.camera.lookAt(0, 0.85, -1.2);

  const floor = new Mesh(
    new PlaneGeometry(12, 12),
    new MeshStandardMaterial({
      color: 0x4a4a4a,
      roughness: 0.95,
      metalness: 0.0,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  world
    .createTransformEntity(floor)
    .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });

  const tableTop = new Mesh(
    new BoxGeometry(1.6, 0.04, 0.8),
    new MeshStandardMaterial({
      color: 0x8b6f47,
      roughness: 0.7,
      metalness: 0.05,
    }),
  );
  tableTop.position.set(0, 0.83, -1.1);
  world.createTransformEntity(tableTop);

  const legGeo = new BoxGeometry(0.06, 0.83, 0.06);
  const legMat = new MeshStandardMaterial({
    color: 0x4a3826,
    roughness: 0.8,
  });
  const legOffsets: Array<[number, number]> = [
    [-0.75, -0.75],
    [0.75, -0.75],
    [-0.75, -1.45],
    [0.75, -1.45],
  ];
  for (const [x, z] of legOffsets) {
    const leg = new Mesh(legGeo, legMat);
    leg.position.set(x, 0.415, z);
    world.createTransformEntity(leg);
  }

  const board = createBreadboard(world, { position: [-0.2, 0.86, -1.05] });

  // Target circuit: battery → wire → LED → wire → battery (via top rail loopback)
  // Socket indexing for cols=16: row*16 + col. Top rail = row 0, row a = row 1.
  const placements: Placement[] = [
    { kind: "battery", socketA: 4, socketB: 20 },
    {
      kind: "wire",
      socketA: 20,
      socketB: 25,
      wireLength: 0.12,
      color: 0x1565c0,
    },
    { kind: "led", socketA: 25, socketB: 26, color: 0xff3030 },
    {
      kind: "wire",
      socketA: 26,
      socketB: 10,
      wireLength: 0.048,
      color: 0xc62828,
    },
  ];
  const guidesGroup = createPlacementGuides(board, placements);

  window.addEventListener("keydown", (e) => {
    if (e.key === "g" || e.key === "G") {
      guidesGroup.visible = !guidesGroup.visible;
      telemetry.log("ui_interaction", {
        element_id: "placement_guides",
        action: guidesGroup.visible ? "show" : "hide",
      });
    }
  });

  world
    .createTransformEntity()
    .addComponent(PanelUI, {
      config: "./ui/hud.json",
      maxHeight: 0.18,
      maxWidth: 0.5,
    })
    .addComponent(Follower, {
      target: world.player.head,
      offsetPosition: [0, -0.25, -0.7],
      behavior: FollowBehavior.PivotY,
      maxAngle: 25,
      tolerance: 0.3,
      speed: 1,
    });

  const tray = new Mesh(
    new BoxGeometry(0.7, 0.06, 0.45),
    new MeshStandardMaterial({
      color: 0x1a3a4a,
      roughness: 0.8,
      metalness: 0.0,
    }),
  );
  tray.position.set(0.4, 0.88, -1.1);
  world.createTransformEntity(tray);

  const Y = 0.94;
  spawnLed(world, [0.1, Y, -1.22], 0xff3030);
  spawnLed(world, [0.2, Y, -1.22], 0x30ff30);
  spawnResistor(world, [0.4, Y, -1.22], 0xc8a060);
  spawnBattery(world, [0.62, Y, -1.22]);
  spawnResistor(world, [0.1, Y, -1.05], 0xa07050);
  spawnWire(world, [0.3, Y, -1.05], 0.048, 0xc62828);
  spawnWire(world, [0.55, Y, -1.05], 0.12, 0x1565c0);
  spawnWire(world, [0.4, Y, -0.94], 0.24, 0xfdd835);

  const { scene: robotMesh } = AssetManager.getGLTF("robot")!;
  robotMesh.scale.setScalar(0.02);
  const bbox = new Box3().setFromObject(robotMesh);
  robotMesh.position.y -= bbox.min.y;
  const robotWrapper = new Group();
  robotWrapper.add(robotMesh);
  world.createTransformEntity(robotWrapper).addComponent(IdleCharacter, {
    centerX: -1.8,
    centerY: 0,
    centerZ: -1.0,
    radius: 0.4,
    walkSpeed: 0.25,
    bobAmplitude: 0.04,
  });
});
