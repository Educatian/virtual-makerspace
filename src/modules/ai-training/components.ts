import { createComponent, Types } from "@iwsdk/core";

export const DataPoint = createComponent("DataPoint", {
  pointId: { type: Types.Int32, default: 0 },
  trueClass: { type: Types.Int32, default: 0 },
  currentClass: { type: Types.Int32, default: 0 },
  homeX: { type: Types.Float32, default: 0 },
  homeY: { type: Types.Float32, default: 0 },
  homeZ: { type: Types.Float32, default: 0 },
});

export const ClassBin = createComponent("ClassBin", {
  classId: { type: Types.Int32, default: 0 },
});
