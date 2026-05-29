/**
 * CpsSignalSystem — CPS social-signal telemetry layer for the Virtual Makerspace.
 *
 * Computes dyadic Collaborative Problem-Solving (CPS) social signals purely
 * client-side from data already on the wire (local head/hands via this.player,
 * partner head/hands via the realtime 'pose' message, part ownership via
 * 'partUpdate'). Emits four telemetry families, each gated by dwell + hysteresis
 * so the NDJSON log carries STATE TRANSITIONS (not per-frame spam), plus a
 * periodic continuous sample for downstream integration.
 *
 * ── DOWNSTREAM ANALYST NOTE (verbatim) ──────────────────────────────────────
 * joint_gaze_* evidences PISA cell (Establishing & maintaining shared
 * understanding). joint_attention_sample density per problem-solving stage
 * indexes the same dimension continuously. partner_orient_* evidences
 * (Establishing/maintaining team organization) — monitoring partner
 * availability/turn signals. handoff with from_pid=Role-A→to_pid=Role-B
 * (power→load assembly) evidences (Taking appropriate action to solve the
 * problem) AND (Establishing/maintaining shared understanding) when paired with
 * a preceding joint_gaze. The 4 PISA problem-solving STAGES
 * (exploring/understanding, representing/formulating, planning/executing,
 * monitoring/reflecting) are assigned downstream by binning event server_ts
 * against task-phase markers, NOT in this system — this system only timestamps
 * with realtime.serverTimeNow so all dyad events share one clock.
 *
 * ── PISA 2015 12-CELL MAP (Graesser/Foltz/Rosen/Andrews-Todd) ───────────────
 *   event_type                 | PISA dimension
 *   ---------------------------+--------------------------------------------------
 *   joint_gaze_start/end       | Dim1 Establishing/maintaining shared understanding
 *   joint_attention_sample     | Dim1 (continuous proxy)
 *   partner_orient_start/end   | Dim3 Establishing/maintaining team organization
 *   handoff                    | Dim2 Taking appropriate action (primary)
 *                              | + Dim1 (secondary, when co-occurring w/ joint_gaze)
 *   (the 4 STAGES are columns assigned downstream by binning server_ts)
 *
 * ── CLOCK ───────────────────────────────────────────────────────────────────
 * Every payload includes server_ts: realtime.serverTimeNow (clock-synced ms,
 * shared across the dyad) — the cross-participant join key. telemetry.log also
 * stamps timestamp_ms (Date.now, local) and frame_time_ms automatically.
 *
 * ── COORDINATE FRAME ASSUMPTION ─────────────────────────────────────────────
 * Partner 'pose' p/q is WORLD space (RemoteAvatarSystem applies it directly to
 * avatar meshes). Local head world pose is read via getWorldPosition/Quaternion.
 * Validate once in-headset: gazeAngle should drop near 0 when both look at board.
 *
 * One system per file per CLAUDE.md. createSystem({}) — no queries; reads
 * this.player and the realtime singleton only.
 */
import { createSystem, Vector3, Quaternion } from "@iwsdk/core";

import { realtime } from "../net/realtime-client.js";
import { telemetry } from "../telemetry.js";

// ── Tuning constants (first-pass; NOT empirically calibrated — tune vs pilot) ─
const JG_ENTER_DEG = 25; // both heads within this of board → candidate
const JG_EXIT_DEG = 32; // both heads beyond this → release (hysteresis margin)
const JG_DWELL_MS = 800; // continuous hold before joint_gaze_start
const JG_EXIT_MS = 300; // continuous release before joint_gaze_end

const ORIENT_ENTER_DEG = 20; // local head within this of partner head → candidate
const ORIENT_EXIT_DEG = 28; // beyond this → release (hysteresis margin)
const ORIENT_DWELL_MS = 600; // continuous hold before partner_orient_start
const ORIENT_EXIT_MS = 250; // continuous release before partner_orient_end
const ORIENT_MAX_DIST_M = 3.0; // ignore "staring across empty room"

const PARTNER_STALE_MS = 1500; // pose older than this → partner ABSENT
const HANDOFF_WINDOW_MS = 4000; // grab/release-to-acquire gap that counts as handoff
const JAI_SAMPLE_MS = 5000; // joint_attention_sample cadence

const RAD2DEG = 180 / Math.PI;

function clamp1(x: number): number {
  // inline acos clamp; no allocation
  return Math.max(-1, Math.min(1, x));
}

export class CpsSignalSystem extends createSystem({}) {
  // ── Preallocated scratch (init() only; NEVER allocate in update()) ──────────
  private localHeadPos!: Vector3;
  private partnerHeadPos!: Vector3;
  private localFwd!: Vector3;
  private partnerFwd!: Vector3;
  private toTargetFromLocal!: Vector3;
  private toTargetFromPartner!: Vector3;
  private toPartnerFromLocal!: Vector3;
  private boardCenter!: Vector3;
  private localHeadQuat!: Quaternion;
  private partnerHeadQuat!: Quaternion;
  private FORWARD!: Vector3;

  // ── Latest partner pose (mutated in place; never reassigned) ────────────────
  private partnerHeadP: [number, number, number] = [0, 0, 0];
  private partnerHeadQ: [number, number, number, number] = [0, 0, 0, 1];
  private partnerSeen = false;
  private lastPartnerPoseMs = 0;
  private partnerPid = "";

  // ── joint_gaze state ────────────────────────────────────────────────────────
  private jointGazeActive = false;
  private jointGazeCandidateSinceMs = 0;
  private jointGazeStartServerTs = 0;
  private jointGazeExitSinceMs = 0;

  // ── partner_orient state ─────────────────────────────────────────────────────
  private orientActive = false;
  private orientCandidateSinceMs = 0;
  private orientStartServerTs = 0;
  private orientExitSinceMs = 0;

  // ── joint_attention_sample cadence ───────────────────────────────────────────
  private lastJaiSampleMs = 0;

  // ── handoff bookkeeping ──────────────────────────────────────────────────────
  private partOwners = new Map<string, { owner: string; ts: number }>();
  private lastReleaseTsByPart = new Map<string, number>();

  // ── last-computed angles cached for the JAI sample (no recompute) ────────────
  private lastJgAngleLocalDeg = 180;
  private lastJgAnglePartnerDeg = 180;
  private lastOrientAngleDeg = 180;
  private lastPartnerDistanceM = 999;

  // ── bound window handlers (stored so removeEventListener works in cleanup) ───
  private onVmGrab: ((e: Event) => void) | null = null;
  private onVmRelease: ((e: Event) => void) | null = null;

  init() {
    // Allocate ALL scratch here, never in update().
    this.localHeadPos = new Vector3();
    this.partnerHeadPos = new Vector3();
    this.localFwd = new Vector3();
    this.partnerFwd = new Vector3();
    this.toTargetFromLocal = new Vector3();
    this.toTargetFromPartner = new Vector3();
    this.toPartnerFromLocal = new Vector3();
    this.localHeadQuat = new Quaternion();
    this.partnerHeadQuat = new Quaternion();
    this.FORWARD = new Vector3(0, 0, -1);

    // Shared breadboard center. Board spawns at [-0.2, 0.86, -1.05]
    // (src/index.ts line 167). Raise Y by BREADBOARD_THICKNESS/2 = 0.027/2 =
    // 0.0135 → 0.8735 to hit the board TOP surface (where parts sit / heads
    // converge). Hardcoded per spec (do NOT import breadboard.ts).
    this.boardCenter = new Vector3(-0.2, 0.8735, -1.05);

    // Solo mode: no partner, no CPS signals. Bail before wiring anything.
    if (!realtime.enabled) return;

    // ── realtime subscription: partner pose + part ownership + leave ──────────
    this.cleanupFuncs.push(
      realtime.subscribe((msg) => {
        if (msg.t === "pose") {
          // Only the partner streams pose back to us; self pose is not echoed.
          // Guard defensively against any self-echo.
          if (msg.pid === telemetry.participantId) return;
          // Mutate in place — do not reassign the arrays.
          this.partnerHeadP[0] = msg.head.p[0];
          this.partnerHeadP[1] = msg.head.p[1];
          this.partnerHeadP[2] = msg.head.p[2];
          this.partnerHeadQ[0] = msg.head.q[0];
          this.partnerHeadQ[1] = msg.head.q[1];
          this.partnerHeadQ[2] = msg.head.q[2];
          this.partnerHeadQ[3] = msg.head.q[3];
          this.partnerSeen = true;
          this.lastPartnerPoseMs = performance.now();
          if (this.partnerPid === "") this.partnerPid = msg.pid;
        } else if (msg.t === "playerJoin") {
          if (
            msg.player.pid !== telemetry.participantId &&
            this.partnerPid === ""
          ) {
            this.partnerPid = msg.player.pid;
          }
        } else if (msg.t === "playerLeave") {
          if (msg.pid === this.partnerPid || msg.pid === "") {
            // Partner gone — close any open dwell on next update via staleness.
            this.partnerSeen = false;
          }
        } else if (msg.t === "partUpdate") {
          this.handlePartUpdate(msg.part.id, msg.part.ownerId);
        }
      }),
    );

    // ── window CustomEvents for LOCAL grab/release boundaries (handoff timing) ─
    // network-sync-system dispatches these with detail.partId.
    this.onVmGrab = (e: Event) => {
      const detail = (e as CustomEvent).detail as { partId: string };
      if (detail?.partId) {
        this.lastReleaseTsByPart.set(detail.partId, realtime.serverTimeNow);
      }
    };
    this.onVmRelease = (e: Event) => {
      const detail = (e as CustomEvent).detail as { partId: string };
      if (detail?.partId) {
        this.lastReleaseTsByPart.set(detail.partId, realtime.serverTimeNow);
      }
    };
    window.addEventListener("vm:grab", this.onVmGrab);
    window.addEventListener("vm:release", this.onVmRelease);
    this.cleanupFuncs.push(() => {
      if (this.onVmGrab) window.removeEventListener("vm:grab", this.onVmGrab);
      if (this.onVmRelease)
        window.removeEventListener("vm:release", this.onVmRelease);
    });
  }

  /**
   * Detect a handoff when ownership crosses the me/partner boundary within a
   * short release-to-acquire window. Always updates partOwners.
   */
  private handlePartUpdate(partId: string, newOwner: string): void {
    const prev = this.partOwners.get(partId);
    const prevOwner = prev?.owner ?? "";
    const me = telemetry.participantId;
    const nowTs = realtime.serverTimeNow;

    // A real acquisition (not a release-to-unowned) that crosses the me/partner
    // boundary: exactly one side of the transition is me (XOR).
    const crossesBoundary =
      (prevOwner === me) !== (newOwner === me); // XOR
    if (newOwner !== prevOwner && newOwner !== "" && crossesBoundary) {
      // gap_ms = newOwner acquisition time minus the most recent recorded
      // release/grab boundary for this part. For partner→me handoffs the prior
      // owner's release isn't observable as a window event, so fall back to the
      // partner's prior partOwners ts (server-stamped). For me→partner we have
      // the local vm:release/vm:grab boundary.
      const localBoundaryTs = this.lastReleaseTsByPart.get(partId);
      const priorOwnerTs = prev?.ts;
      let boundaryTs: number | undefined;
      if (localBoundaryTs !== undefined && priorOwnerTs !== undefined) {
        boundaryTs = Math.max(localBoundaryTs, priorOwnerTs);
      } else {
        boundaryTs = localBoundaryTs ?? priorOwnerTs;
      }
      if (boundaryTs !== undefined) {
        const gapMs = nowTs - boundaryTs;
        if (gapMs >= 0 && gapMs <= HANDOFF_WINDOW_MS) {
          telemetry.log("handoff", {
            // CpsSignalSystem has no part-entity registry; rely on the stable
            // string part_id. Direction is implicit in from_pid/to_pid.
            entity_id: null,
            part_id: partId,
            from_pid: prevOwner,
            to_pid: newOwner,
            gap_ms: gapMs,
            server_ts: nowTs,
          });
        }
      }
    }

    this.partOwners.set(partId, { owner: newOwner, ts: nowTs });
  }

  update(_delta: number): void {
    if (!realtime.enabled) return;
    if (!this.player?.head) return; // base-class may not have populated player

    const nowMs = performance.now();

    // ── Partner staleness → treat as ABSENT, force-close open dwells ──────────
    const partnerStale =
      !this.partnerSeen || nowMs - this.lastPartnerPoseMs > PARTNER_STALE_MS;
    if (partnerStale) {
      if (this.jointGazeActive) {
        this.jointGazeActive = false;
        this.jointGazeCandidateSinceMs = 0;
        this.jointGazeExitSinceMs = 0;
        telemetry.log("joint_gaze_end", {
          target: "breadboard",
          duration_ms: realtime.serverTimeNow - this.jointGazeStartServerTs,
          reason: "partner_lost",
          server_ts: realtime.serverTimeNow,
        });
      }
      if (this.orientActive) {
        this.orientActive = false;
        this.orientCandidateSinceMs = 0;
        this.orientExitSinceMs = 0;
        telemetry.log("partner_orient_end", {
          partner_pid: this.partnerPid,
          duration_ms: realtime.serverTimeNow - this.orientStartServerTs,
          reason: "partner_lost",
          server_ts: realtime.serverTimeNow,
        });
      }
      this.lastPartnerDistanceM = 999;
      this.maybeSampleJai(nowMs, false);
      return; // skip all geometry while partner absent
    }

    // ── Read local head world pose into preallocated temps ───────────────────
    this.player.head.getWorldPosition(this.localHeadPos);
    this.player.head.getWorldQuaternion(this.localHeadQuat);

    // ── Partner head world pose into temps ───────────────────────────────────
    this.partnerHeadPos.set(
      this.partnerHeadP[0],
      this.partnerHeadP[1],
      this.partnerHeadP[2],
    );
    this.partnerHeadQuat.set(
      this.partnerHeadQ[0],
      this.partnerHeadQ[1],
      this.partnerHeadQ[2],
      this.partnerHeadQ[3],
    );

    // ── Head-forward vectors = quat applied to (0,0,-1) ──────────────────────
    this.localFwd.copy(this.FORWARD).applyQuaternion(this.localHeadQuat);
    this.partnerFwd.copy(this.FORWARD).applyQuaternion(this.partnerHeadQuat);

    // ── joint_gaze: both heads converging on the shared breadboard ───────────
    // (Single target = breadboard only for Phase 2. A part-target loop would
    // require a per-part Vector3 pool to stay allocation-free; not implemented.)
    this.toTargetFromLocal
      .copy(this.boardCenter)
      .sub(this.localHeadPos)
      .normalize();
    this.toTargetFromPartner
      .copy(this.boardCenter)
      .sub(this.partnerHeadPos)
      .normalize();
    const gazeAngleLocalDeg =
      Math.acos(clamp1(this.localFwd.dot(this.toTargetFromLocal))) * RAD2DEG;
    const gazeAnglePartnerDeg =
      Math.acos(clamp1(this.partnerFwd.dot(this.toTargetFromPartner))) *
      RAD2DEG;
    this.lastJgAngleLocalDeg = gazeAngleLocalDeg;
    this.lastJgAnglePartnerDeg = gazeAnglePartnerDeg;

    const jgConverged =
      gazeAngleLocalDeg < JG_ENTER_DEG && gazeAnglePartnerDeg < JG_ENTER_DEG;

    if (!this.jointGazeActive) {
      if (jgConverged) {
        if (this.jointGazeCandidateSinceMs === 0) {
          this.jointGazeCandidateSinceMs = nowMs;
        } else if (nowMs - this.jointGazeCandidateSinceMs >= JG_DWELL_MS) {
          this.jointGazeActive = true;
          this.jointGazeStartServerTs = realtime.serverTimeNow;
          this.jointGazeExitSinceMs = 0;
          telemetry.log("joint_gaze_start", {
            target: "breadboard",
            local_angle_deg: gazeAngleLocalDeg,
            partner_angle_deg: gazeAnglePartnerDeg,
            server_ts: this.jointGazeStartServerTs,
          });
        }
      } else {
        this.jointGazeCandidateSinceMs = 0;
      }
    } else {
      // Active: release only when BOTH exceed exit threshold continuously.
      const jgReleased =
        gazeAngleLocalDeg > JG_EXIT_DEG && gazeAnglePartnerDeg > JG_EXIT_DEG;
      if (jgReleased) {
        if (this.jointGazeExitSinceMs === 0) {
          this.jointGazeExitSinceMs = nowMs;
        } else if (nowMs - this.jointGazeExitSinceMs >= JG_EXIT_MS) {
          this.jointGazeActive = false;
          this.jointGazeCandidateSinceMs = 0;
          this.jointGazeExitSinceMs = 0;
          telemetry.log("joint_gaze_end", {
            target: "breadboard",
            duration_ms:
              realtime.serverTimeNow - this.jointGazeStartServerTs,
            server_ts: realtime.serverTimeNow,
          });
        }
      } else {
        this.jointGazeExitSinceMs = 0; // re-converged within margin
      }
    }

    // ── partner_orient: LOCAL head looking at PARTNER head (one-sided) ────────
    const partnerDistanceM = this.localHeadPos.distanceTo(this.partnerHeadPos);
    this.lastPartnerDistanceM = partnerDistanceM;
    this.toPartnerFromLocal
      .copy(this.partnerHeadPos)
      .sub(this.localHeadPos)
      .normalize();
    const orientAngleDeg =
      Math.acos(clamp1(this.localFwd.dot(this.toPartnerFromLocal))) * RAD2DEG;
    this.lastOrientAngleDeg = orientAngleDeg;

    const orientInRange = partnerDistanceM < ORIENT_MAX_DIST_M;
    const orientTriggered = orientInRange && orientAngleDeg < ORIENT_ENTER_DEG;

    if (!this.orientActive) {
      if (orientTriggered) {
        if (this.orientCandidateSinceMs === 0) {
          this.orientCandidateSinceMs = nowMs;
        } else if (nowMs - this.orientCandidateSinceMs >= ORIENT_DWELL_MS) {
          this.orientActive = true;
          this.orientStartServerTs = realtime.serverTimeNow;
          this.orientExitSinceMs = 0;
          telemetry.log("partner_orient_start", {
            partner_pid: this.partnerPid,
            angle_deg: orientAngleDeg,
            distance_m: partnerDistanceM,
            server_ts: this.orientStartServerTs,
          });
        }
      } else {
        this.orientCandidateSinceMs = 0;
      }
    } else {
      // Active: release when out of cone OR out of range, held continuously.
      const orientReleased =
        orientAngleDeg > ORIENT_EXIT_DEG || !orientInRange;
      if (orientReleased) {
        if (this.orientExitSinceMs === 0) {
          this.orientExitSinceMs = nowMs;
        } else if (nowMs - this.orientExitSinceMs >= ORIENT_EXIT_MS) {
          this.orientActive = false;
          this.orientCandidateSinceMs = 0;
          this.orientExitSinceMs = 0;
          telemetry.log("partner_orient_end", {
            partner_pid: this.partnerPid,
            duration_ms: realtime.serverTimeNow - this.orientStartServerTs,
            server_ts: realtime.serverTimeNow,
          });
        }
      } else {
        this.orientExitSinceMs = 0;
      }
    }

    // ── periodic continuous JAI sample ───────────────────────────────────────
    this.maybeSampleJai(nowMs, true);
  }

  /** Emit a regularly-sampled continuous trace for downstream integration. */
  private maybeSampleJai(nowMs: number, partnerPresent: boolean): void {
    if (nowMs - this.lastJaiSampleMs < JAI_SAMPLE_MS) return;
    this.lastJaiSampleMs = nowMs;
    telemetry.log("joint_attention_sample", {
      jg_active: this.jointGazeActive,
      jg_angle_local_deg: this.lastJgAngleLocalDeg,
      jg_angle_partner_deg: this.lastJgAnglePartnerDeg,
      orient_active: this.orientActive,
      orient_angle_deg: this.lastOrientAngleDeg,
      partner_distance_m: this.lastPartnerDistanceM,
      partner_present: partnerPresent,
      window_ms: JAI_SAMPLE_MS,
      server_ts: realtime.serverTimeNow,
    });
  }
}
