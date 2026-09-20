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
const _aWorld = new Vector3();
const _bWorld = new Vector3();
const _bestSocketAWorld = new Vector3();
const _bestSocketBWorld = new Vector3();
const _bestA1World = new Vector3();
const _bestA2World = new Vector3();
const _bestB1World = new Vector3();
const _bestB2World = new Vector3();
const _nearAWorld = new Vector3();
const _nearBWorld = new Vector3();

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
        _aWorld.copy(_socketWorld);
      }
      const dB = _leadBWorld.distanceTo(_socketWorld);
      if (dB < distB) {
        distB = dB;
        nearestB = i;
        _bWorld.copy(_socketWorld);
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
        _bestSocketAWorld.copy(_aWorld);
        _bestSocketBWorld.copy(_bWorld);
      }
    }
  }

  if (!bestTarget) return null;
  return {
    target: bestTarget,
    socketA: bestSocketA,
    socketB: bestSocketB,
    socketAWorld: _bestSocketAWorld,
    socketBWorld: _bestSocketBWorld,
  };
}

export interface NearestCandidate {
  socketA: number;
  socketB: number;
  distA: number;
  distB: number;
  threshold: number;
  socketAWorld: Vector3;
  socketBWorld: Vector3;
}

// Tracks top-2 nearest sockets per lead so that when both leads' nearest-1
// collide on the same socket, we can swap the worse fit to its second-best.
export function findNearestCandidate(
  entity: Entity,
  targets: Iterable<Entity>,
): NearestCandidate | null {
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

  let bestA1 = -1;
  let bestA1Dist = Infinity;
  let bestA2 = -1;
  let bestA2Dist = Infinity;
  let bestB1 = -1;
  let bestB1Dist = Infinity;
  let bestB2 = -1;
  let bestB2Dist = Infinity;
  let bestA1Target: Entity | null = null;
  let bestA2Target: Entity | null = null;
  let bestB1Target: Entity | null = null;
  let bestB2Target: Entity | null = null;

  for (const target of targets) {
    const tObj = target.object3D;
    if (!tObj) continue;
    tObj.updateWorldMatrix(true, false);
    const cols = target.getValue(SocketGrid, "cols")!;
    const rowsPerHalf = target.getValue(SocketGrid, "rowsPerHalf")!;
    const pitch = target.getValue(SocketGrid, "pitch")!;
    const channelGap = target.getValue(SocketGrid, "channelGap")!;
    const total = totalSockets(cols, rowsPerHalf);

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
      if (dA < bestA1Dist) {
        bestA2 = bestA1;
        bestA2Dist = bestA1Dist;
        bestA2Target = bestA1Target;
        _bestA2World.copy(_bestA1World);
        bestA1 = i;
        bestA1Dist = dA;
        bestA1Target = target;
        _bestA1World.copy(_socketWorld);
      } else if (dA < bestA2Dist) {
        bestA2 = i;
        bestA2Dist = dA;
        bestA2Target = target;
        _bestA2World.copy(_socketWorld);
      }

      const dB = _leadBWorld.distanceTo(_socketWorld);
      if (dB < bestB1Dist) {
        bestB2 = bestB1;
        bestB2Dist = bestB1Dist;
        bestB2Target = bestB1Target;
        _bestB2World.copy(_bestB1World);
        bestB1 = i;
        bestB1Dist = dB;
        bestB1Target = target;
        _bestB1World.copy(_socketWorld);
      } else if (dB < bestB2Dist) {
        bestB2 = i;
        bestB2Dist = dB;
        bestB2Target = target;
        _bestB2World.copy(_socketWorld);
      }
    }
  }

  if (bestA1 < 0 || bestB1 < 0 || !bestA1Target || !bestB1Target) return null;

  let socketA = bestA1;
  let distA = bestA1Dist;
  let targetA = bestA1Target;
  _nearAWorld.copy(_bestA1World);
  let socketB = bestB1;
  let distB = bestB1Dist;
  let targetB = bestB1Target;
  _nearBWorld.copy(_bestB1World);

  if (socketA === socketB && targetA === targetB) {
    const swapACost = (bestA2 >= 0 ? bestA2Dist : Infinity) + bestB1Dist;
    const swapBCost = bestA1Dist + (bestB2 >= 0 ? bestB2Dist : Infinity);
    if (swapACost <= swapBCost && bestA2 >= 0 && bestA2Target) {
      socketA = bestA2;
      distA = bestA2Dist;
      _nearAWorld.copy(_bestA2World);
    } else if (bestB2 >= 0 && bestB2Target) {
      socketB = bestB2;
      distB = bestB2Dist;
      _nearBWorld.copy(_bestB2World);
    } else {
      return null;
    }
  }

  return {
    socketA,
    socketB,
    distA,
    distB,
    threshold,
    socketAWorld: _nearAWorld,
    socketBWorld: _nearBWorld,
  };
}
