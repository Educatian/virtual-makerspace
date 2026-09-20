import type { ModuleId, VMModule } from "./modules/types.js";

const NUMERIC_TO_ID: Record<string, ModuleId> = {
  "1": "electronics",
  "2": "assembly",
  "3": "ai-training",
  "4": "capstone",
};

const VALID_IDS: ModuleId[] = [
  "electronics",
  "assembly",
  "ai-training",
  "capstone",
];

export function parseModuleId(): ModuleId {
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get("module") || "").toLowerCase();
  if (raw in NUMERIC_TO_ID) return NUMERIC_TO_ID[raw];
  if ((VALID_IDS as string[]).includes(raw)) return raw as ModuleId;
  return "electronics";
}

export async function loadModule(id: ModuleId): Promise<VMModule> {
  switch (id) {
    case "electronics":
      return (await import("./modules/electronics/index.js")).electronicsModule;
    case "assembly":
      return (await import("./modules/assembly/index.js")).assemblyModule;
    case "ai-training":
      return (await import("./modules/ai-training/index.js")).aiTrainingModule;
    case "capstone":
      return (await import("./modules/capstone/index.js")).capstoneModule;
  }
}
