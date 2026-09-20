import {
  BoxGeometry,
  CylinderGeometry,
  DistanceGrabbable,
  Group,
  Mesh,
  MeshStandardMaterial,
  MovementMode,
  SphereGeometry,
  type World,
} from "@iwsdk/core";

import { GazeTarget } from "../../components/gaze-target.js";
import { CLASS_COLORS, CLASS_NAMES, type DataPointSeed } from "./dataset.js";
import { ClassBin, DataPoint } from "./components.js";

const POINT_OUTER_RADIUS = 0.018;
const POINT_INNER_SIZE = 0.008;

const outerGeo = new SphereGeometry(POINT_OUTER_RADIUS, 12, 8);
const innerGeo = new BoxGeometry(POINT_INNER_SIZE, POINT_INNER_SIZE, POINT_INNER_SIZE);

export const classOuterMaterials: MeshStandardMaterial[] = CLASS_COLORS.map(
  (color) =>
    new MeshStandardMaterial({
      color,
      roughness: 0.4,
      metalness: 0.05,
      emissive: color,
      emissiveIntensity: 0.25,
    }),
);

export const classInnerMaterials: MeshStandardMaterial[] = CLASS_COLORS.map(
  (color) =>
    new MeshStandardMaterial({
      color,
      roughness: 0.2,
      metalness: 0.0,
      emissive: color,
      emissiveIntensity: 0.6,
    }),
);

export interface SpawnedDataPoint {
  group: Group;
  outerMesh: Mesh;
}

export function spawnDataPoint(
  world: World,
  seed: DataPointSeed,
  origin: [number, number, number],
) {
  const group = new Group();

  const outer = new Mesh(outerGeo, classOuterMaterials[seed.currentClass]);
  outer.name = "data-point-outer";
  group.add(outer);

  const inner = new Mesh(innerGeo, classInnerMaterials[seed.trueClass]);
  inner.name = "data-point-inner";
  group.add(inner);

  group.position.set(
    origin[0] + seed.position[0],
    origin[1] + seed.position[1],
    origin[2] + seed.position[2],
  );

  return world
    .createTransformEntity(group)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveAtSource,
    })
    .addComponent(DataPoint, {
      pointId: seed.pointId,
      trueClass: seed.trueClass,
      currentClass: seed.currentClass,
      homeX: group.position.x,
      homeY: group.position.y,
      homeZ: group.position.z,
    })
    .addComponent(GazeTarget, { name: `data_point_${seed.pointId}` });
}

const BIN_RADIUS = 0.08;
const BIN_HEIGHT = 0.012;

export function spawnClassBin(
  world: World,
  classId: number,
  position: [number, number, number],
) {
  const group = new Group();

  const disk = new Mesh(
    new CylinderGeometry(BIN_RADIUS, BIN_RADIUS, BIN_HEIGHT, 32),
    new MeshStandardMaterial({
      color: CLASS_COLORS[classId],
      roughness: 0.5,
      metalness: 0.1,
      emissive: CLASS_COLORS[classId],
      emissiveIntensity: 0.15,
    }),
  );
  group.add(disk);

  const ring = new Mesh(
    new CylinderGeometry(BIN_RADIUS * 1.05, BIN_RADIUS * 1.05, BIN_HEIGHT * 0.5, 32),
    new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.6,
      metalness: 0.1,
      transparent: true,
      opacity: 0.25,
    }),
  );
  ring.position.y = BIN_HEIGHT * 0.4;
  group.add(ring);

  group.position.set(...position);
  group.name = `class-bin-${CLASS_NAMES[classId]}`;

  return world
    .createTransformEntity(group)
    .addComponent(ClassBin, { classId });
}

export const BIN_DETECT_RADIUS = 0.14;
