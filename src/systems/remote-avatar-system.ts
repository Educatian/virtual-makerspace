import {
  BoxGeometry,
  createSystem,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "@iwsdk/core";

import { realtime, type PlayerState } from "../net/realtime-client.js";
import { telemetry } from "../telemetry.js";

const POSE_TX_HZ = 15;
const POSE_TX_INTERVAL_MS = 1000 / POSE_TX_HZ;
const LERP_FACTOR = 0.25;

const ROLE_COLORS: Record<string, number> = {
  A: 0x1565c0, // blue (Power)
  B: 0xc62828, // red (Load)
  SOLO: 0x4caf50,
  OBSERVER: 0xffd54f,
};

interface AvatarMeshes {
  group: Object3D;
  entity: { dispose(): void } | null;
  head: Mesh;
  left: Mesh;
  right: Mesh;
  targetHeadPos: Vector3;
  targetHeadQuat: Quaternion;
  targetLeftPos: Vector3;
  targetLeftQuat: Quaternion;
  targetRightPos: Vector3;
  targetRightQuat: Quaternion;
}

function buildAvatar(role: string): AvatarMeshes {
  const color = ROLE_COLORS[role] ?? 0x9e9e9e;
  const mat = new MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.1,
    transparent: true,
    opacity: 0.85,
  });

  const group = new Object3D();
  group.name = `remote-avatar-${role}`;

  const head = new Mesh(new SphereGeometry(0.11, 18, 14), mat);
  head.name = "head";
  group.add(head);

  // Forehead "eye" cue so the user can tell which way partner is facing
  const eye = new Mesh(
    new SphereGeometry(0.018, 10, 8),
    new MeshStandardMaterial({ color: 0xffffff }),
  );
  eye.position.set(0, 0.02, -0.1);
  head.add(eye);

  const handGeo = new BoxGeometry(0.06, 0.04, 0.09);
  const left = new Mesh(handGeo, mat);
  left.name = "left-hand";
  group.add(left);

  const right = new Mesh(handGeo, mat);
  right.name = "right-hand";
  group.add(right);

  return {
    group,
    entity: null,
    head,
    left,
    right,
    targetHeadPos: new Vector3(),
    targetHeadQuat: new Quaternion(),
    targetLeftPos: new Vector3(),
    targetLeftQuat: new Quaternion(),
    targetRightPos: new Vector3(),
    targetRightQuat: new Quaternion(),
  };
}

export class RemoteAvatarSystem extends createSystem({}) {
  private avatars = new Map<string, AvatarMeshes>();
  private lastTxMs = 0;
  private tmpPos = new Vector3();
  private tmpQuat = new Quaternion();

  init() {
    if (!realtime.enabled) return;

    realtime.subscribe((msg) => {
      if (msg.t === "state") {
        for (const player of msg.players) this.ensureAvatar(player);
      } else if (msg.t === "playerJoin") {
        this.ensureAvatar(msg.player);
      } else if (msg.t === "playerLeave") {
        this.removeAvatar(msg.pid);
      } else if (msg.t === "pose") {
        const av = this.avatars.get(msg.pid);
        if (!av) return;
        av.targetHeadPos.set(msg.head.p[0], msg.head.p[1], msg.head.p[2]);
        av.targetHeadQuat.set(
          msg.head.q[0],
          msg.head.q[1],
          msg.head.q[2],
          msg.head.q[3],
        );
        av.targetLeftPos.set(msg.left.p[0], msg.left.p[1], msg.left.p[2]);
        av.targetLeftQuat.set(
          msg.left.q[0],
          msg.left.q[1],
          msg.left.q[2],
          msg.left.q[3],
        );
        av.targetRightPos.set(msg.right.p[0], msg.right.p[1], msg.right.p[2]);
        av.targetRightQuat.set(
          msg.right.q[0],
          msg.right.q[1],
          msg.right.q[2],
          msg.right.q[3],
        );
      }
    });
  }

  private ensureAvatar(player: PlayerState): void {
    if (player.pid === telemetry.participantId) return; // skip self
    if (this.avatars.has(player.pid)) return;
    const av = buildAvatar(player.role);
    av.group.position.set(0, -5, 0);
    av.entity = this.world.createTransformEntity(av.group);
    this.avatars.set(player.pid, av);
    telemetry.log("avatar_spawn", {
      partner_pid: player.pid,
      partner_role: player.role,
    });
  }

  private removeAvatar(pid: string): void {
    const av = this.avatars.get(pid);
    if (!av) return;
    av.entity?.dispose();
    this.avatars.delete(pid);
    telemetry.log("avatar_despawn", { partner_pid: pid });
  }

  update(_delta: number): void {
    if (!realtime.enabled) return;

    // Tx local pose at fixed rate
    const now = performance.now();
    if (now - this.lastTxMs >= POSE_TX_INTERVAL_MS) {
      this.lastTxMs = now;
      this.broadcastLocalPose();
    }

    // Lerp remote avatars toward target
    for (const av of this.avatars.values()) {
      av.head.position.lerp(av.targetHeadPos, LERP_FACTOR);
      av.head.quaternion.slerp(av.targetHeadQuat, LERP_FACTOR);
      av.left.position.lerp(av.targetLeftPos, LERP_FACTOR);
      av.left.quaternion.slerp(av.targetLeftQuat, LERP_FACTOR);
      av.right.position.lerp(av.targetRightPos, LERP_FACTOR);
      av.right.quaternion.slerp(av.targetRightQuat, LERP_FACTOR);
    }
  }

  private broadcastLocalPose(): void {
    const head = this.player?.head;
    const left = this.player?.raySpaces?.left ?? this.player?.gripSpaces?.left;
    const right =
      this.player?.raySpaces?.right ?? this.player?.gripSpaces?.right;
    if (!head) return;

    head.getWorldPosition(this.tmpPos);
    head.getWorldQuaternion(this.tmpQuat);
    const headData = {
      p: [this.tmpPos.x, this.tmpPos.y, this.tmpPos.z] as [
        number,
        number,
        number,
      ],
      q: [this.tmpQuat.x, this.tmpQuat.y, this.tmpQuat.z, this.tmpQuat.w] as [
        number,
        number,
        number,
        number,
      ],
    };

    const leftData = this.poseFromObj(left);
    const rightData = this.poseFromObj(right);

    realtime.send({
      t: "pose",
      head: headData,
      left: leftData,
      right: rightData,
    });
  }

  private poseFromObj(obj: Object3D | undefined): {
    p: [number, number, number];
    q: [number, number, number, number];
  } {
    if (!obj) {
      return { p: [0, -5, 0], q: [0, 0, 0, 1] };
    }
    obj.getWorldPosition(this.tmpPos);
    obj.getWorldQuaternion(this.tmpQuat);
    return {
      p: [this.tmpPos.x, this.tmpPos.y, this.tmpPos.z],
      q: [this.tmpQuat.x, this.tmpQuat.y, this.tmpQuat.z, this.tmpQuat.w],
    };
  }
}
