import {
  EnvironmentType,
  LocomotionEnvironment,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type World,
} from "@iwsdk/core";

/**
 * Shared base scene setup used by every module:
 * - Player camera at standing height
 * - Dark grey floor with LocomotionEnvironment so teleport works
 *
 * Modules add their own tables, props, panels, etc. on top.
 */
export function setupBaseScene(world: World): void {
  world.camera.position.set(0, 1.6, 0);
  world.camera.lookAt(0, 0.85, -1.2);

  const floor = new Mesh(
    new PlaneGeometry(12, 12),
    new MeshStandardMaterial({
      color: 0x4a4a4a,
      roughness: 0.95,
      metalness: 0.0,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  world
    .createTransformEntity(floor)
    .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });
}
