import { Vector3, type Entity } from "@iwsdk/core";

import { getSocketLocalPosition, totalSockets } from "../breadboard.js";
import { SocketGrid } from "../components/socket-grid.js";
import { Snappable } from "../components/snap.js";

export interface SnapResult {
  target: Entity;
  socketA: number;
  socketB: number;
  socketAWorld: Vector3;
  socketBWorld: Vector3;
}

const _socketLocal = new Vector3();
const _socketWorld = new Vector3();
const _leadAWorld = new Vector3();
const _leadBWorld = new Vector3();

export function findBestSnap(
  entity: Entity,
  targets: Iterable<Entity>,
): SnapResult | null {
  const obj = entity.object3D;
  if (!obj) return null;

  const leadAOff = entity.getVectorView(Snappable, "leadAOffset");
  const leadBOff = entity.getVectorView(Snappable, "leadBOffset");
  const threshold = entity.getValue(Snappable, "snapThreshold")!;

  obj.updateWorldMatrix(true, false);
  _leadAWorld
    .set(leadAOff[0], leadAOff[1], leadAOff[2])
    .applyMatrix4(obj.matrixWorld);
  _leadBWorld
    .set(leadBOff[0], leadBOff[1], leadBOff[2])
    .applyMatrix4(obj.matrixWorld);

  let bestTarget: Entity | null = null;
  let bestSocketA = -1;
  let bestSocketB = -1;
  let bestSocketAWorld = new Vector3();
  let bestSocketBWorld = new Vector3();
  let bestScore = Infinity;

  for (const target of targets) {
    const tObj = target.object3D;
    if (!tObj) continue;
    tObj.updateWorldMatrix(true, false);
    const cols = target.getValue(SocketGrid, "cols")!;
    const rowsPerHalf = target.getValue(SocketGrid, "rowsPerHalf")!;
    const pitch = target.getValue(SocketGrid, "pitch")!;
    const channelGap = target.getValue(SocketGrid, "channelGap")!;
    const total = totalSockets(cols, rowsPerHalf);

    let nearestA = -1;
    let nearestB = -1;
    let distA = Infinity;
    let distB = Infinity;
    const aWorld = new Vector3();
    const bWorld = new Vector3();

    for (let i = 0; i < total; i++) {
      getSocketLocalPosition(
        i,
        cols,
        rowsPerHalf,
        pitch,
        channelGap,
        _socketLocal,
      );
      _socketWorld.copy(_socketLocal).applyMatrix4(tObj.matrixWorld);
      const dA = _leadAWorld.distanceTo(_socketWorld);
      if (dA < distA) {
        distA = dA;
        nearestA = i;
        aWorld.copy(_socketWorld);
      }
      const dB = _leadBWorld.distanceTo(_socketWorld);
      if (dB < distB) {
        distB = dB;
        nearestB = i;
        bWorld.copy(_socketWorld);
      }
    }

    if (
      distA < threshold &&
      distB < threshold &&
      nearestA !== nearestB &&
      nearestA >= 0
    ) {
      const score = distA + distB;
      if (score < bestScore) {
        bestScore = score;
        bestTarget = target;
        bestSocketA = nearestA;
        bestSocketB = nearestB;
        bestSocketAWorld.copy(aWorld);
        bestSocketBWorld.copy(bWorld);
      }
    }
  }

  if (!bestTarget) return null;
  return {
    target: bestTarget,
    socketA: bestSocketA,
    socketB: bestSocketB,
    socketAWorld: bestSocketAWorld,
    socketBWorld: bestSocketBWorld,
  };
}
