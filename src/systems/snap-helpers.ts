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
const _a2World = new Vector3();
const _b2World = new Vector3();
const _bestAWorld = new Vector3();
const _bestBWorld = new Vector3();
const _result: SnapResult = {
  target: null as unknown as Entity,
  socketA: -1,
  socketB: -1,
  socketAWorld: _bestAWorld,
  socketBWorld: _bestBWorld,
};

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

    // Track top-2 nearest for A and B independently. When the global best for
    // A and B collide on the same socket (common for short components), fall
    // back to the second-nearest of whichever has the larger gap to its #2 —
    // that pick maximizes the remaining distance margin.
    let nearestA = -1, secondA = -1, distA = Infinity, distA2 = Infinity;
    let nearestB = -1, secondB = -1, distB = Infinity, distB2 = Infinity;

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
        distA2 = distA; secondA = nearestA; _a2World.copy(_aWorld);
        distA = dA; nearestA = i; _aWorld.copy(_socketWorld);
      } else if (dA < distA2) {
        distA2 = dA; secondA = i; _a2World.copy(_socketWorld);
      }
      const dB = _leadBWorld.distanceTo(_socketWorld);
      if (dB < distB) {
        distB2 = distB; secondB = nearestB; _b2World.copy(_bWorld);
        distB = dB; nearestB = i; _bWorld.copy(_socketWorld);
      } else if (dB < distB2) {
        distB2 = dB; secondB = i; _b2World.copy(_socketWorld);
      }
    }

    let chosenA = nearestA, chosenB = nearestB;
    let chosenDistA = distA, chosenDistB = distB;
    let chosenAWorld = _aWorld, chosenBWorld = _bWorld;
    if (nearestA === nearestB && nearestA >= 0) {
      // Promote whichever lead's #2 is closer; that yields the smaller score.
      if (distA2 - distA < distB2 - distB && secondA >= 0) {
        chosenA = secondA; chosenDistA = distA2; chosenAWorld = _a2World;
      } else if (secondB >= 0) {
        chosenB = secondB; chosenDistB = distB2; chosenBWorld = _b2World;
      } else {
        chosenA = -1;
      }
    }

    if (
      chosenDistA < threshold &&
      chosenDistB < threshold &&
      chosenA !== chosenB &&
      chosenA >= 0
    ) {
      const score = chosenDistA + chosenDistB;
      if (score < bestScore) {
        bestScore = score;
        bestTarget = target;
        bestSocketA = chosenA;
        bestSocketB = chosenB;
        _bestAWorld.copy(chosenAWorld);
        _bestBWorld.copy(chosenBWorld);
      }
    }
  }

  if (!bestTarget) return null;
  _result.target = bestTarget;
  _result.socketA = bestSocketA;
  _result.socketB = bestSocketB;
  return _result;
}
