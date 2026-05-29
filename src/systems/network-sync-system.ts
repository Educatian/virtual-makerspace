import {
  createSystem,
  Transform,
  Vector3,
  type Entity,
} from "@iwsdk/core";

import { getSocketLocalPosition } from "../breadboard.js";
import { Snappable, SnapTarget } from "../components/snap.js";
import { SocketGrid } from "../components/socket-grid.js";
import { realtime } from "../net/realtime-client.js";
import { telemetry } from "../telemetry.js";

/**
 * Mirrors server-authoritative part state into local ECS.
 * - On `partUpdate`: teleport part to server position + set Snappable sockets
 *   so local CircuitEvalSystem evaluates the joint topology correctly.
 * - Sends grab/release/snap from local SnapSystem hooks (wired via window.dispatchEvent).
 */
export class NetworkSyncSystem extends createSystem({
  snappables: { required: [Snappable] },
  snapTargets: { required: [SnapTarget, SocketGrid, Transform] },
}) {
  private partRegistry = new Map<string, Entity>();

  init() {
    if (!realtime.enabled) {
      console.info(
        `[VM-Net] mode=${telemetry.mode} — network sync disabled`,
      );
      return;
    }

    // Build partId → Entity registry
    this.queries.snappables.subscribe("qualify", (entity) => {
      const obj = entity.object3D;
      const partId = obj?.userData?.partId as string | undefined;
      if (partId) this.partRegistry.set(partId, entity);
    });
    this.queries.snappables.subscribe("disqualify", (entity) => {
      for (const [id, e] of this.partRegistry) {
        if (e === entity) this.partRegistry.delete(id);
      }
    });

    // Subscribe to server messages
    realtime.subscribe((msg) => {
      if (msg.t === "state") {
        for (const part of msg.parts) this.applyPart(part);
      } else if (msg.t === "partUpdate") {
        this.applyPart(msg.part);
      } else if (msg.t === "playerJoin") {
        telemetry.log("partner_join", {
          partner_pid: msg.player.pid,
          partner_role: msg.player.role,
          partner_nickname: msg.player.nickname,
        });
      } else if (msg.t === "playerLeave") {
        telemetry.log("partner_leave", { partner_pid: msg.pid });
      } else if (msg.t === "ledLit") {
        telemetry.log("server_led_state", { lit: msg.lit });
      }
    });

    // Local SnapSystem dispatches custom events; we relay to server
    window.addEventListener("vm:grab", (e: Event) => {
      const detail = (e as CustomEvent).detail as { partId: string };
      realtime.send({ t: "grab", partId: detail.partId });
    });
    window.addEventListener("vm:release", (e: Event) => {
      const detail = (e as CustomEvent).detail as { partId: string };
      realtime.send({ t: "release", partId: detail.partId });
    });
    window.addEventListener("vm:snap", (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        partId: string;
        socketA: number;
        socketB: number;
        position: [number, number, number];
        quaternion: [number, number, number, number];
      };
      realtime.send({
        t: "snap",
        partId: detail.partId,
        socketA: detail.socketA,
        socketB: detail.socketB,
        position: detail.position,
        quaternion: detail.quaternion,
      });
    });

    realtime.connect();
  }

  update(): void {}

  private applyPart(part: {
    id: string;
    ownerId: string;
    socketA: number;
    socketB: number;
    position: [number, number, number];
    quaternion: [number, number, number, number];
  }): void {
    const entity = this.partRegistry.get(part.id);
    if (!entity) return;
    const obj = entity.object3D;
    if (!obj) return;

    // Skip applying to ourselves (we are the source of truth for our own grabs)
    const myPid = telemetry.participantId;
    if (part.ownerId === myPid) return;

    // Update Snappable socket values so local circuit eval sees joint state
    const currentA = entity.getValue(Snappable, "leadASocket")!;
    const currentB = entity.getValue(Snappable, "leadBSocket")!;
    if (currentA !== part.socketA || currentB !== part.socketB) {
      entity.setValue(Snappable, "leadASocket", part.socketA);
      entity.setValue(Snappable, "leadBSocket", part.socketB);
    }

    // Teleport visually
    if (part.socketA >= 0 && part.socketB >= 0) {
      // Use snap-helpers logic to compute exact world position from sockets
      const result = this.computeSnapTransform(entity, part.socketA, part.socketB);
      if (result) {
        const { dirX, dirZ, socketAWorld } = result;
        const angleY = Math.atan2(dirZ, dirX);
        obj.rotation.set(0, angleY, 0);
        obj.updateMatrixWorld(true);
        const leadAOff = entity.getVectorView(Snappable, "leadAOffset");
        const tx = socketAWorld.x - leadAOff[0] * Math.cos(angleY);
        const tz = socketAWorld.z - leadAOff[0] * Math.sin(angleY);
        obj.position.set(tx, socketAWorld.y - leadAOff[1], tz);
      } else {
        obj.position.set(part.position[0], part.position[1], part.position[2]);
      }
    } else if (!part.ownerId) {
      // Released and not snapped: park hidden (partner-owned parts off-screen)
      obj.position.set(0, -10, 0);
    }
  }

  private computeSnapTransform(
    _entity: Entity,
    socketA: number,
    socketB: number,
  ): { dirX: number; dirZ: number; socketAWorld: Vector3 } | null {
    const targetIter = this.queries.snapTargets.entities.values().next();
    if (targetIter.done) return null;
    const board = targetIter.value as Entity;
    const boardObj = board.object3D;
    if (!boardObj) return null;
    const cols = board.getValue(SocketGrid, "cols")!;
    const rowsPerHalf = board.getValue(SocketGrid, "rowsPerHalf")!;
    const pitch = board.getValue(SocketGrid, "pitch")!;
    const channelGap = board.getValue(SocketGrid, "channelGap")!;

    const sA = new Vector3();
    const sB = new Vector3();
    getSocketLocalPosition(socketA, cols, rowsPerHalf, pitch, channelGap, sA);
    getSocketLocalPosition(socketB, cols, rowsPerHalf, pitch, channelGap, sB);
    boardObj.localToWorld(sA);
    boardObj.localToWorld(sB);

    return {
      dirX: sB.x - sA.x,
      dirZ: sB.z - sA.z,
      socketAWorld: sA,
    };
  }
}

// Helper to dispatch from SnapSystem
export function dispatchGrab(partId: string): void {
  window.dispatchEvent(new CustomEvent("vm:grab", { detail: { partId } }));
}
export function dispatchRelease(partId: string): void {
  window.dispatchEvent(new CustomEvent("vm:release", { detail: { partId } }));
}
export function dispatchSnap(
  partId: string,
  socketA: number,
  socketB: number,
  position: [number, number, number],
  quaternion: [number, number, number, number],
): void {
  window.dispatchEvent(
    new CustomEvent("vm:snap", {
      detail: { partId, socketA, socketB, position, quaternion },
    }),
  );
}
