import { createComponent, Types } from "@iwsdk/core";

export const SocketGrid = createComponent("SocketGrid", {
  cols: { type: Types.Int16, default: 16 },
  rowsPerHalf: { type: Types.Int8, default: 5 },
  pitch: { type: Types.Float32, default: 0.024 },
  channelGap: { type: Types.Float32, default: 0.048 },
});
