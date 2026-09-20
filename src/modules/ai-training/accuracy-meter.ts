import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type World,
} from "@iwsdk/core";

import { telemetry } from "../../telemetry.js";
import { TOTAL_POINTS } from "./dataset.js";

const PANEL_WIDTH = 0.4;
const PANEL_HEIGHT = 0.18;
const CANVAS_W = 512;
const CANVAS_H = 230;

interface PointLabelEvent {
  point_id: number;
  old_class: number;
  new_class: number;
  true_class: number;
  was_correct: boolean;
}

export interface AccuracyMeterHandle {
  updateInitial(initialCorrect: number): void;
}

export function createAccuracyMeter(
  world: World,
  position: [number, number, number],
): AccuracyMeterHandle {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d")!;
  const texture = new CanvasTexture(canvas);

  const mesh = new Mesh(
    new PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
    new MeshBasicMaterial({ map: texture, transparent: true }),
  );
  mesh.position.set(...position);
  mesh.lookAt(0, 1.6, 0); // face the player at standing eye level
  world.createTransformEntity(mesh);

  let correct = 0;

  function render() {
    const acc = correct / TOTAL_POINTS;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Card background
    ctx.fillStyle = "rgba(20, 26, 38, 0.92)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = "#3a4a66";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, CANVAS_W - 4, CANVAS_H - 4);

    // Title
    ctx.fillStyle = "#9aa6bd";
    ctx.font = "20px system-ui, sans-serif";
    ctx.fillText("Model Accuracy", 28, 36);

    // Big accuracy number
    ctx.fillStyle = acc >= 0.95 ? "#2ecc71" : acc >= 0.8 ? "#f1c40f" : "#e8eef7";
    ctx.font = "bold 64px system-ui, sans-serif";
    ctx.fillText(`${Math.round(acc * 100)}%`, 28, 110);

    // Counts
    ctx.fillStyle = "#9aa6bd";
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText(`${correct} / ${TOTAL_POINTS} correctly labeled`, 28, 140);

    // Bar
    const barX = 28;
    const barY = 165;
    const barW = CANVAS_W - 56;
    const barH = 22;
    ctx.fillStyle = "#1f2735";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = acc >= 0.95 ? "#2ecc71" : "#3498db";
    ctx.fillRect(barX, barY, barW * acc, barH);

    texture.needsUpdate = true;
  }

  function emitTick() {
    const acc = correct / TOTAL_POINTS;
    telemetry.log("accuracy_tick", {
      correct,
      total: TOTAL_POINTS,
      accuracy: Math.round(acc * 10000) / 10000,
    });
  }

  window.addEventListener("vm:point_label_change", ((e: Event) => {
    const detail = (e as CustomEvent<PointLabelEvent>).detail;
    const wasCorrectBefore = detail.old_class === detail.true_class;
    const isCorrectNow = detail.was_correct;
    if (!wasCorrectBefore && isCorrectNow) correct += 1;
    else if (wasCorrectBefore && !isCorrectNow) correct -= 1;
    render();
    emitTick();
  }) as EventListener);

  render();

  return {
    updateInitial(initialCorrect: number) {
      correct = initialCorrect;
      render();
      emitTick();
    },
  };
}
