import { createSystem, Vector3 } from "@iwsdk/core";

import { IdleCharacter } from "../components/idle-character.js";

export class IdleCharacterSystem extends createSystem({
  characters: { required: [IdleCharacter] },
}) {
  private tmpLook!: Vector3;

  init(): void {
    this.tmpLook = new Vector3();
  }

  update(_delta: number, time: number): void {
    for (const entity of this.queries.characters.entities) {
      const obj = entity.object3D;
      if (!obj) continue;
      const cx = entity.getValue(IdleCharacter, "centerX")!;
      const cy = entity.getValue(IdleCharacter, "centerY")!;
      const cz = entity.getValue(IdleCharacter, "centerZ")!;
      const r = entity.getValue(IdleCharacter, "radius")!;
      const spd = entity.getValue(IdleCharacter, "walkSpeed")!;
      const amp = entity.getValue(IdleCharacter, "bobAmplitude")!;
      const freq = entity.getValue(IdleCharacter, "bobFrequency")!;

      const angle = time * spd;
      obj.position.x = cx + Math.cos(angle) * r;
      obj.position.z = cz + Math.sin(angle) * r;
      obj.position.y = cy + Math.abs(Math.sin(time * freq)) * amp;

      const nextAngle = angle + 0.05;
      this.tmpLook.set(
        cx + Math.cos(nextAngle) * r,
        obj.position.y,
        cz + Math.sin(nextAngle) * r,
      );
      obj.lookAt(this.tmpLook);
    }
  }
}
