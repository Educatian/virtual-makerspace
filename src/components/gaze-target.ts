import { createComponent, Types } from "@iwsdk/core";

export const GazeTarget = createComponent("GazeTarget", {
  name: { type: Types.String, default: "" },
});
