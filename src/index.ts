/// <reference types="vite/client" />
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
import { NetworkSyncSystem } from "./systems/network-sync-system.js";
import { RemoteAvatarSystem } from "./systems/remote-avatar-system.js";
import { SnapSystem } from "./systems/snap-system.js";
import { CpsSignalSystem } from "./systems/cps-signal-system.js";
import { telemetry } from "./telemetry.js";
import "./net/realtime-client.js";
import { voice } from "./net/livekit-client.js";

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
    // physics intentionally OFF: no entity uses PhysicsBody/PhysicsShape, and
    // enabling it eagerly downloads + compiles the ~2 MB Havok wasm at startup —
    // a needless memory/load cost that hurts Meta Quest 2 (6 GB, mobile XR2).
    // Grab uses @pmndrs/handle (not physics) and locomotion uses
    // LocomotionEnvironment (the floor), so neither needs physics.
    // Re-enable when Module 2 (mechanical assembly) adds rigid bodies.
    physics: false,
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
    .registerSystem(IdleCharacterSystem)
    .registerSystem(NetworkSyncSystem)
    .registerSystem(RemoteAvatarSystem)
    .registerSystem(CpsSignalSystem);

  if (telemetry.mode === "collab") {
    voice.connect();
  }

  telemetry.log("session_start", {
    iwsdk_version: "0.4.1",
    user_agent: navigator.userAgent,
    mode: telemetry.mode,
    role: telemetry.role,
    room: telemetry.room,
    condition: telemetry.condition,
  });
  if (telemetry.mode === "solo") {
    document.title = "Virtual Makerspace · Solo";
    console.info(
      `%c[VM] mode=SOLO pid=${telemetry.participantId} cond=${telemetry.condition}`,
      "background:#4caf50;color:#fff;padding:2px 6px;border-radius:3px",
    );
    console.info(
      "%c[VM] Collab mode: append ?mode=collab&role=A&room=<code>&pid=<id>",
      "color:#888",
    );
  } else {
    document.title = `VM · Collab · Role ${telemetry.role} · ${telemetry.room}`;
    console.info(
      `%c[VM] mode=COLLAB role=${telemetry.role} room=${telemetry.room} pid=${telemetry.participantId} nick=${telemetry.nickname}`,
      "background:#1565c0;color:#fff;padding:2px 6px;border-radius:3px",
    );
    console.info(
      `%c[VM] Partner URL: ?mode=collab&role=${telemetry.role === "A" ? "B" : "A"}&room=${telemetry.room}&pid=<partnerId>`,
      "color:#888",
    );
  }

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

  // Target circuit: battery → wire → LED → wire → battery.
  // SOLO mode  : show all 4 placement guides + all parts.
  // COLLAB mode: jigsaw split — A=power (battery+blue wire), B=load (LED+red wire).
  const PLACE_A: Placement[] = [
    { kind: "battery", socketA: 4, socketB: 20 },
    {
      kind: "wire",
      socketA: 20,
      socketB: 25,
      wireLength: 0.12,
      color: 0x1565c0,
    },
  ];
  const PLACE_B: Placement[] = [
    { kind: "led", socketA: 25, socketB: 26, color: 0xff3030 },
    {
      kind: "wire",
      socketA: 26,
      socketB: 10,
      wireLength: 0.048,
      color: 0xc62828,
    },
  ];
  const myPlacements: Placement[] =
    telemetry.mode === "solo"
      ? [...PLACE_A, ...PLACE_B]
      : telemetry.role === "A"
        ? PLACE_A
        : PLACE_B;
  const guidesGroup = createPlacementGuides(board, myPlacements);

  window.addEventListener("keydown", (e) => {
    if (e.key === "g" || e.key === "G") {
      guidesGroup.visible = !guidesGroup.visible;
      telemetry.log("ui_interaction", {
        element_id: "placement_guides",
        action: guidesGroup.visible ? "show" : "hide",
      });
    }
  });

  const hudEntity = world
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
  const HIDDEN: [number, number, number] = [0, -10, 0];

  if (telemetry.mode === "solo") {
    // SOLO: original task — all 4 target parts + 4 distractors.
    spawnBattery(world, [0.62, Y, -1.22], "battery");
    spawnWire(world, [0.55, Y, -1.05], 0.12, 0x1565c0, "wire-blue-med");
    spawnLed(world, [0.1, Y, -1.22], 0xff3030, "led-red");
    spawnWire(world, [0.3, Y, -1.05], 0.048, 0xc62828, "wire-red-short");
    // Distractors only in SOLO
    spawnLed(world, [0.2, Y, -1.22], 0x30ff30);
    spawnResistor(world, [0.4, Y, -1.22], 0xc8a060);
    spawnResistor(world, [0.1, Y, -1.05], 0xa07050);
    spawnWire(world, [0.4, Y, -0.94], 0.24, 0xfdd835);
  } else {
    // COLLAB jigsaw: own parts in tray; partner parts off-screen until
    // network-sync-system teleports them in on snap.
    const ownsA = telemetry.role === "A";
    const ownsB = telemetry.role === "B";
    spawnBattery(world, ownsA ? [0.62, Y, -1.22] : HIDDEN, "battery");
    spawnWire(
      world,
      ownsA ? [0.55, Y, -1.05] : HIDDEN,
      0.12,
      0x1565c0,
      "wire-blue-med",
    );
    spawnLed(world, ownsB ? [0.1, Y, -1.22] : HIDDEN, 0xff3030, "led-red");
    spawnWire(
      world,
      ownsB ? [0.3, Y, -1.05] : HIDDEN,
      0.048,
      0xc62828,
      "wire-red-short",
    );
  }

  const { scene: robotMesh } = AssetManager.getGLTF("robot")!;
  robotMesh.scale.setScalar(1.0);
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

  if (import.meta.env.DEV) {
    (window as Window & { __VM?: unknown }).__VM = {
      world,
      SnapSystem,
      HoverPreviewSystem,
      Follower,
      robot: robotWrapper,
      hud: hudEntity,
      components: {
        Snappable,
        SnapTarget,
        SocketGrid,
        CircuitNode,
        WireEnds,
        LedState,
        PowerSource,
      },
    };
  }
});
