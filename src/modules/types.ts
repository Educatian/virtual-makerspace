import type { AssetManifest, World } from "@iwsdk/core";
import type { Condition } from "../experiment.js";

export type ModuleId = "electronics" | "assembly" | "ai-training" | "capstone";

export interface ModuleContext {
  world: World;
  condition: Condition;
  participantId: string;
}

export interface VMModule {
  id: ModuleId;
  name: string;
  assets?: AssetManifest;
  registerComponents?(world: World): void;
  registerSystems?(world: World): void;
  setup(ctx: ModuleContext): void | Promise<void>;
}
