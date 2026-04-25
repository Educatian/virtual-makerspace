import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
  type Entity,
} from "@iwsdk/core";

import { getSocketLocalPosition } from "./breadboard.js";
import { SocketGrid } from "./components/socket-grid.js";

export type GhostKind = "led" | "resistor" | "wire" | "battery";

export interface Placement {
  kind: GhostKind;
  socketA: number;
  socketB: number;
  color?: number;
  wireLength?: number;
}

const GHOST_OPACITY = 0.28;
const LEAD_LEN = 0.036;

function ghostMat(color: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    transparent: true,
    opacity: GHOST_OPACITY,
    depthWrite: false,
    roughness: 0.5,
    metalness: 0.0,
  });
}

function buildLedGhost(color: number): Group {
  const g = new Group();
  const body = new Mesh(new SphereGeometry(0.015, 14, 10), ghostMat(color));
  body.position.y = 0.006;
  g.add(body);
  return g;
}

function buildResistorGhost(color: number): Group {
  const g = new Group();
  const body = new Mesh(
    new CylinderGeometry(0.0075, 0.0075, 0.048, 12),
    ghostMat(color),
  );
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.009;
  g.add(body);
  return g;
}

function buildWireGhost(length: number, color: number): Group {
  const g = new Group();
  const body = new Mesh(
    new CylinderGeometry(0.0036, 0.0036, length, 10),
    ghostMat(color),
  );
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.003;
  g.add(body);
  return g;
}

function buildBatteryGhost(): Group {
  const g = new Group();
  const body = new Mesh(
    new BoxGeometry(0.06, 0.042, 0.036),
    ghostMat(0x222222),
  );
  body.position.y = 0.021;
  g.add(body);
  return g;
}

export function createPlacementGuides(
  board: Entity,
  placements: Placement[],
): Group {
  const guidesRoot = new Group();
  guidesRoot.name = "placement-guides";

  const cols = board.getValue(SocketGrid, "cols")!;
  const rowsPerHalf = board.getValue(SocketGrid, "rowsPerHalf")!;
  const pitch = board.getValue(SocketGrid, "pitch")!;
  const channelGap = board.getValue(SocketGrid, "channelGap")!;
  const boardObj = board.object3D;
  if (!boardObj) return guidesRoot;

  const sA = new Vector3();
  const sB = new Vector3();

  for (const p of placements) {
    let ghost: Group;
    if (p.kind === "led") {
      ghost = buildLedGhost(p.color ?? 0xff3030);
    } else if (p.kind === "resistor") {
      ghost = buildResistorGhost(p.color ?? 0xc8a060);
    } else if (p.kind === "wire") {
      ghost = buildWireGhost(p.wireLength ?? 0.048, p.color ?? 0xc62828);
    } else {
      ghost = buildBatteryGhost();
    }

    getSocketLocalPosition(p.socketA, cols, rowsPerHalf, pitch, channelGap, sA);
    getSocketLocalPosition(p.socketB, cols, rowsPerHalf, pitch, channelGap, sB);

    const dx = sB.x - sA.x;
    const dz = sB.z - sA.z;
    const angleY = Math.atan2(dz, dx);
    const midX = (sA.x + sB.x) / 2;
    const midZ = (sA.z + sB.z) / 2;
    const ghostY = sA.y + LEAD_LEN;

    ghost.position.set(midX, ghostY, midZ);
    ghost.rotation.y = angleY;

    guidesRoot.add(ghost);
  }

  boardObj.add(guidesRoot);
  return guidesRoot;
}
