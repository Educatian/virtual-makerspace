/// <reference types="vite/client" />
import { SessionMode, World, type AssetManifest } from "@iwsdk/core";

import { condition, participantId } from "./experiment.js";
import { loadModule, parseModuleId } from "./module-selector.js";
import { setupBaseScene } from "./modules/base.js";
import { runPostProbe, runPreProbe } from "./probes/probe-overlay.js";
import { telemetry } from "./telemetry.js";

const moduleId = parseModuleId();

runPreProbe();

(async () => {
  const module = await loadModule(moduleId);
  const assets: AssetManifest = module.assets ?? {};

  const world = await World.create(
    document.getElementById("scene-container") as HTMLDivElement,
    {
      assets,
      xr: {
        sessionMode: SessionMode.ImmersiveVR,
        offer: "always",
        features: { handTracking: true, layers: true },
      },
      features: {
        locomotion: { useWorker: true },
        grabbing: true,
        physics: true,
        sceneUnderstanding: false,
        environmentRaycast: false,
      },
    },
  );

  module.registerComponents?.(world);
  module.registerSystems?.(world);

  setupBaseScene(world);

  await module.setup({ world, condition, participantId });

  telemetry.log("session_start", {
    iwsdk_version: "0.3.1",
    user_agent: navigator.userAgent,
    module: module.id,
    condition,
    participant_id: participantId,
  });

  window.addEventListener("vm:task_complete", () => {
    runPostProbe();
  });
})();
