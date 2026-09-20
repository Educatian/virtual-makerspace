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

export const assemblyModule: VMModule = {
  id: "assembly",
  name: "Mechanical Assembly Studio",

  setup({ world }: ModuleContext) {
    setupTable(world);
    showStubPanel(world, "Mechanical Assembly Studio", [
      "Coming soon:",
      "• Gear train assembly (transmission ratios)",
      "• Bridge engineering (truss / suspension / arch)",
      "• Vehicle suspension (damping, frequency response)",
      "",
      "Try ?module=1 (electronics) or ?module=3 (AI training).",
    ]);
    telemetry.log("module_loaded", { module: "assembly", status: "stub" });

    if (import.meta.env.DEV) {
      (window as Window & { __VM?: unknown }).__VM = {
        world,
        module: "assembly",
      };
    }
  },
};

function setupTable(world: World): void {
  const tableTop = new Mesh(
    new BoxGeometry(1.6, 0.04, 0.8),
    new MeshStandardMaterial({
      color: 0x5a4a3a,
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
  ctx.strokeStyle = "#3a4a66";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);

  ctx.fillStyle = "#e8eef7";
  ctx.font = "bold 56px system-ui, sans-serif";
  ctx.fillText(title, 48, 88);

  ctx.fillStyle = "#9aa6bd";
  ctx.font = "32px system-ui, sans-serif";
  body.forEach((line, i) => {
    ctx.fillText(line, 48, 168 + i * 50);
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
