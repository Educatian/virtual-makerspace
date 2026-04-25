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

import {
  CircuitNode,
  LedState,
  PowerSource,
  WireEnds,
} from "./components/circuit.js";
import { Snappable } from "./components/snap.js";

const LEAD_LEN = 0.036;
const SNAP_THRESHOLD = 0.027;

const leadGeo = new CylinderGeometry(0.0024, 0.0024, LEAD_LEN, 8);
const leadMat = new MeshStandardMaterial({
  color: 0xc0c0c0,
  roughness: 0.3,
  metalness: 0.9,
});

function makeLead(x: number): Mesh {
  const lead = new Mesh(leadGeo, leadMat);
  lead.position.set(x, -LEAD_LEN / 2, 0);
  return lead;
}

export function spawnLed(
  world: World,
  position: [number, number, number],
  color: number,
) {
  const group = new Group();

  const body = new Mesh(
    new SphereGeometry(0.015, 18, 14),
    new MeshStandardMaterial({
      color,
      roughness: 0.3,
      metalness: 0.0,
      emissive: color,
      emissiveIntensity: 0,
    }),
  );
  body.name = "led-body";
  body.position.y = 0.006;
  group.add(body);

  group.add(makeLead(-0.012));
  group.add(makeLead(0.012));

  group.position.set(...position);

  return world
    .createTransformEntity(group)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveAtSource,
    })
    .addComponent(Snappable, {
      leadAOffset: [-0.012, -LEAD_LEN, 0],
      leadBOffset: [0.012, -LEAD_LEN, 0],
      snapThreshold: SNAP_THRESHOLD,
      spawnPos: position,
    })
    .addComponent(CircuitNode)
    .addComponent(LedState);
}

export function spawnResistor(
  world: World,
  position: [number, number, number],
  bandColor = 0xc8a060,
) {
  const group = new Group();

  const body = new Mesh(
    new CylinderGeometry(0.0075, 0.0075, 0.048, 16),
    new MeshStandardMaterial({ color: bandColor, roughness: 0.6 }),
  );
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.009;
  group.add(body);

  const segGeo = new CylinderGeometry(0.0024, 0.0024, 0.012, 8);
  const segLeft = new Mesh(segGeo, leadMat);
  segLeft.rotation.z = Math.PI / 2;
  segLeft.position.set(-0.030, 0.009, 0);
  group.add(segLeft);
  const segRight = new Mesh(segGeo, leadMat);
  segRight.rotation.z = Math.PI / 2;
  segRight.position.set(0.030, 0.009, 0);
  group.add(segRight);

  group.add(makeLead(-0.036));
  group.add(makeLead(0.036));

  group.position.set(...position);

  return world
    .createTransformEntity(group)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveAtSource,
    })
    .addComponent(Snappable, {
      leadAOffset: [-0.036, -LEAD_LEN, 0],
      leadBOffset: [0.036, -LEAD_LEN, 0],
      snapThreshold: SNAP_THRESHOLD,
      spawnPos: position,
    })
    .addComponent(CircuitNode);
}

export function spawnWire(
  world: World,
  position: [number, number, number],
  length: number,
  color: number,
) {
  const group = new Group();

  const body = new Mesh(
    new CylinderGeometry(0.0036, 0.0036, length, 12),
    new MeshStandardMaterial({ color, roughness: 0.7 }),
  );
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.003;
  group.add(body);

  const tipGeo = new CylinderGeometry(0.0024, 0.0024, 0.006, 8);
  const tipL = new Mesh(tipGeo, leadMat);
  tipL.rotation.z = Math.PI / 2;
  tipL.position.set(-length / 2 - 0.003, 0.003, 0);
  group.add(tipL);
  const tipR = new Mesh(tipGeo, leadMat);
  tipR.rotation.z = Math.PI / 2;
  tipR.position.set(length / 2 + 0.003, 0.003, 0);
  group.add(tipR);

  group.add(makeLead(-length / 2));
  group.add(makeLead(length / 2));

  group.position.set(...position);

  return world
    .createTransformEntity(group)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveAtSource,
    })
    .addComponent(Snappable, {
      leadAOffset: [-length / 2, -LEAD_LEN, 0],
      leadBOffset: [length / 2, -LEAD_LEN, 0],
      snapThreshold: SNAP_THRESHOLD,
      spawnPos: position,
    })
    .addComponent(WireEnds);
}

export function spawnBattery(
  world: World,
  position: [number, number, number],
) {
  const group = new Group();

  const body = new Mesh(
    new BoxGeometry(0.060, 0.042, 0.036),
    new MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }),
  );
  body.position.y = 0.021;
  group.add(body);

  const posTerm = new Mesh(
    new CylinderGeometry(0.006, 0.006, 0.009, 14),
    new MeshStandardMaterial({ color: 0xc62828, roughness: 0.4 }),
  );
  posTerm.position.set(-0.012, 0.0465, 0);
  group.add(posTerm);

  const negTerm = new Mesh(
    new CylinderGeometry(0.006, 0.006, 0.009, 14),
    new MeshStandardMaterial({
      color: 0xc0c0c0,
      roughness: 0.4,
      metalness: 0.7,
    }),
  );
  negTerm.position.set(0.012, 0.0465, 0);
  group.add(negTerm);

  group.add(makeLead(-0.012));
  group.add(makeLead(0.012));

  group.position.set(...position);

  return world
    .createTransformEntity(group)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveAtSource,
    })
    .addComponent(Snappable, {
      leadAOffset: [-0.012, -LEAD_LEN, 0],
      leadBOffset: [0.012, -LEAD_LEN, 0],
      snapThreshold: SNAP_THRESHOLD,
      spawnPos: position,
    })
    .addComponent(CircuitNode)
    .addComponent(PowerSource);
}
