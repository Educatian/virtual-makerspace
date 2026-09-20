import {
  BoxGeometry,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type World,
} from "@iwsdk/core";

import { telemetry } from "../../telemetry.js";
import type { ModuleContext, VMModule } from "../types.js";

export const capstoneModule: VMModule = {
  id: "capstone",
  name: "Capstone: Light-Following Robot",

  setup({ world }: ModuleContext) {
    setupTable(world);
    showStubPanel(world, "Capstone: Integration Project", [
      "Anchor task: build a light-following robot.",
      "",
      "• Module 1 → power circuit + photoresistor sensor",
      "• Module 2 → chassis + servo gear train",
      "• Module 3 → tiny classifier for sensor → motor mapping",
      "",
      "Unlocks after any two of M1–M3 are completed.",
    ]);
    telemetry.log("module_loaded", { module: "capstone", status: "stub" });

    if (import.meta.env.DEV) {
      (window as Window & { __VM?: unknown }).__VM = {
        world,
        module: "capstone",
      };
    }
  },
};

function setupTable(world: World): void {
  const tableTop = new Mesh(
    new BoxGeometry(1.6, 0.04, 0.8),
    new MeshStandardMaterial({
      color: 0x3a3a3a,
      roughness: 0.7,
      metalness: 0.05,
    }),
  );
  tableTop.position.set(0, 0.83, -1.1);
  world.createTransformEntity(tableTop);
}

function showStubPanel(
  world: World,
  title: string,
  body: string[],
): void {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(20, 26, 38, 0.94)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#6c5ce7";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);

  ctx.fillStyle = "#e8eef7";
  ctx.font = "bold 52px system-ui, sans-serif";
  ctx.fillText(title, 48, 88);

  ctx.fillStyle = "#9aa6bd";
  ctx.font = "30px system-ui, sans-serif";
  body.forEach((line, i) => {
    ctx.fillText(line, 48, 160 + i * 48);
  });

  const tex = new CanvasTexture(canvas);
  const mesh = new Mesh(
    new PlaneGeometry(0.8, 0.4),
    new MeshBasicMaterial({ map: tex, transparent: true }),
  );
  mesh.position.set(0, 1.5, -1.1);
  mesh.lookAt(0, 1.6, 0);
  world.createTransformEntity(mesh);
}
