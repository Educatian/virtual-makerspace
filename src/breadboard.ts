import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type World,
} from "@iwsdk/core";

import { SnapTarget } from "./components/snap.js";
import { SocketGrid } from "./components/socket-grid.js";

export const BREADBOARD_THICKNESS = 0.027;

export interface BreadboardOptions {
  cols?: number;
  rowsPerHalf?: number;
  pitch?: number;
  channelGap?: number;
  position?: [number, number, number];
}

export function totalSockets(cols: number, rowsPerHalf: number): number {
  return cols * (2 + 2 * rowsPerHalf);
}

export function getSocketLocalPosition(
  socketIndex: number,
  cols: number,
  rowsPerHalf: number,
  pitch: number,
  channelGap: number,
  out: Vector3 = new Vector3(),
): Vector3 {
  const totalRows = 2 + 2 * rowsPerHalf;
  const row = Math.floor(socketIndex / cols);
  const col = socketIndex % cols;

  const xStart = -((cols - 1) * pitch) / 2;
  const halfHeight = (rowsPerHalf - 0.5) * pitch + channelGap / 2;
  const railOffset = halfHeight + 1.5 * pitch;

  const x = xStart + col * pitch;
  let z: number;
  if (row === 0) {
    z = -railOffset;
  } else if (row === totalRows - 1) {
    z = railOffset;
  } else if (row <= rowsPerHalf) {
    const r = row - 1;
    z = -(channelGap / 2 + (rowsPerHalf - 0.5 - r) * pitch);
  } else {
    const r = row - rowsPerHalf - 1;
    z = channelGap / 2 + (r + 0.5) * pitch;
  }

  out.set(x, BREADBOARD_THICKNESS / 2 + 0.0001, z);
  return out;
}

export function createBreadboard(world: World, opts: BreadboardOptions = {}) {
  const cols = opts.cols ?? 16;
  const rowsPerHalf = opts.rowsPerHalf ?? 5;
  const pitch = opts.pitch ?? 0.024;
  const channelGap = opts.channelGap ?? 0.048;
  const margin = 0.024;

  const halfHeight = (rowsPerHalf - 0.5) * pitch + channelGap / 2;
  const railOffset = halfHeight + pitch * 1.5;
  const xExtent = (cols - 1) * pitch;
  const width = xExtent + margin * 2;
  const depth = railOffset * 2 + margin * 2;

  const group = new Group();

  const body = new Mesh(
    new BoxGeometry(width, BREADBOARD_THICKNESS, depth),
    new MeshStandardMaterial({
      color: 0xefe9d9,
      roughness: 0.7,
      metalness: 0.0,
    }),
  );
  group.add(body);

  const channel = new Mesh(
    new BoxGeometry(width - margin, 0.004, channelGap * 0.7),
    new MeshStandardMaterial({
      color: 0x2a2622,
      roughness: 0.9,
      metalness: 0.0,
    }),
  );
  channel.position.set(0, BREADBOARD_THICKNESS / 2 - 0.0015, 0);
  group.add(channel);

  const stripeY = BREADBOARD_THICKNESS / 2 + 0.0008;
  const stripeWidth = width - margin * 1.5;
  const stripeThickness = 0.005;

  const redStripe = new Mesh(
    new BoxGeometry(stripeWidth, 0.0015, stripeThickness),
    new MeshStandardMaterial({ color: 0xc62828, roughness: 0.5 }),
  );
  redStripe.position.set(0, stripeY, -railOffset - pitch * 0.6);
  group.add(redStripe);

  const blueStripe = new Mesh(
    new BoxGeometry(stripeWidth, 0.0015, stripeThickness),
    new MeshStandardMaterial({ color: 0x1565c0, roughness: 0.5 }),
  );
  blueStripe.position.set(0, stripeY, railOffset + pitch * 0.6);
  group.add(blueStripe);

  const total = totalSockets(cols, rowsPerHalf);
  const holes = new InstancedMesh(
    new CylinderGeometry(0.005, 0.005, 0.003, 14),
    new MeshStandardMaterial({
      color: 0x111111,
      roughness: 0.4,
      metalness: 0.6,
    }),
    total,
  );
  const dummy = new Object3D();
  const tmp = new Vector3();
  for (let i = 0; i < total; i++) {
    getSocketLocalPosition(i, cols, rowsPerHalf, pitch, channelGap, tmp);
    dummy.position.copy(tmp);
    dummy.updateMatrix();
    holes.setMatrixAt(i, dummy.matrix);
  }
  holes.instanceMatrix.needsUpdate = true;
  group.add(holes);

  if (opts.position) {
    group.position.set(...opts.position);
  }

  return world
    .createTransformEntity(group)
    .addComponent(SocketGrid, { cols, rowsPerHalf, pitch, channelGap })
    .addComponent(SnapTarget);
}
