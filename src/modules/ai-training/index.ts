import {
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  type World,
} from "@iwsdk/core";

import { GazeTarget } from "../../components/gaze-target.js";
import { telemetry } from "../../telemetry.js";
import type { ModuleContext, VMModule } from "../types.js";
import { createAccuracyMeter } from "./accuracy-meter.js";
import { ClassBin, DataPoint } from "./components.js";
import { CLASS_NAMES, generateDataset } from "./dataset.js";
import { RelabelSystem } from "./relabel-system.js";
import { spawnClassBin, spawnDataPoint } from "./spawn.js";

const TABLE_TOP_Y = 0.83;
const TABLE_HEIGHT = 0.04;
const CUBE_CENTER: [number, number, number] = [0, 1.05, -1.1];
const BIN_Y = TABLE_TOP_Y + TABLE_HEIGHT / 2 + 0.001;

export const aiTrainingModule: VMModule = {
  id: "ai-training",
  name: "AI Training Studio",

  registerComponents(world) {
    world.registerComponent(DataPoint);
    world.registerComponent(ClassBin);
    world.registerComponent(GazeTarget);
  },

  registerSystems(world) {
    world.registerSystem(RelabelSystem);
  },

  setup({ world }: ModuleContext) {
    setupTable(world);

    const seeds = generateDataset(1);
    let initialCorrect = 0;
    for (const seed of seeds) {
      spawnDataPoint(world, seed, CUBE_CENTER);
      if (seed.currentClass === seed.trueClass) initialCorrect += 1;
    }

    // Bins arranged in front of the dataset cube on the table edge
    const binZ = -0.65;
    const binSpacing = 0.32;
    const binPositions: Array<[number, number, number]> = [
      [-binSpacing, BIN_Y, binZ],
      [0, BIN_Y, binZ],
      [binSpacing, BIN_Y, binZ],
    ];
    binPositions.forEach((pos, classId) => {
      spawnClassBin(world, classId, pos);
    });

    // Accuracy meter floats above the dataset cube
    const meter = createAccuracyMeter(world, [0, 1.55, -1.1]);
    meter.updateInitial(initialCorrect);

    telemetry.log("module_loaded", {
      module: "ai-training",
      total_points: seeds.length,
      initial_correct: initialCorrect,
      class_names: CLASS_NAMES,
    });

    if (import.meta.env.DEV) {
      (window as Window & { __VM?: unknown }).__VM = {
        world,
        module: "ai-training",
        components: { DataPoint, ClassBin },
      };
    }
  },
};

function setupTable(world: World): void {
  const tableTop = new Mesh(
    new BoxGeometry(1.6, TABLE_HEIGHT, 0.8),
    new MeshStandardMaterial({
      color: 0x2a3245,
      roughness: 0.6,
      metalness: 0.1,
    }),
  );
  tableTop.position.set(0, TABLE_TOP_Y, -1.1);
  world.createTransformEntity(tableTop);

  const legGeo = new BoxGeometry(0.06, 0.83, 0.06);
  const legMat = new MeshStandardMaterial({
    color: 0x141a26,
    roughness: 0.7,
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

  // Wireframe cube to define the dataset volume
  const cubeGeo = new BoxGeometry(0.6, 0.5, 0.6);
  const cubeMat = new MeshStandardMaterial({
    color: 0x4a90e2,
    transparent: true,
    opacity: 0.06,
    roughness: 0.5,
  });
  const cube = new Mesh(cubeGeo, cubeMat);
  cube.position.set(...CUBE_CENTER);
  world.createTransformEntity(cube);
}
