/**
 * Voice client for CPS dyadic audio (LiveKit).
 *
 * Gated on realtime.enabled (collab + room). Fetches a short-lived JWT from the
 * vm-realtime worker (/token/:code), connects to LiveKit, publishes the mic, and
 * derives PISA "establishing shared understanding" telemetry from speaking state:
 *   - voice_speaking_state { peer_id, speaking } on each per-peer on/off edge
 *   - turn_take { previous_speaker, new_speaker, gap_ms, overlap_ms } on dominant-
 *     speaker transitions (gap_ms and overlap_ms are mutually exclusive; whichever
 *     is >0 carries signal, the other is 0).
 *
 * NEVER throws: a missing/failed/unconfigured LiveKit (503) degrades to a clean
 * no-op, exactly like realtime gating. Room audio is NOT recorded client-side;
 * the raw artifact comes from LiveKit Egress (deploy/ops). The client-captured
 * speaking timeline is the primary analyzable signal for CPS coding.
 */
import { Room, RoomEvent, type Participant } from "livekit-client";
import { telemetry } from "../telemetry.js";
import { realtime } from "./realtime-client.js";

// Token endpoint shares the worker base with realtime, but over https (not wss).
const TOKEN_BASE =
  (import.meta.env.VITE_REALTIME_URL as string | undefined)
    ?.replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:") ?? "https://vm-realtime.jewoong-moon.workers.dev";

class VoiceClient {
  private room: Room | null = null;
  public readonly enabled: boolean;

  // Per-peer speaking membership (identities currently above the audio threshold).
  private speakingNow = new Set<string>();

  // turn_take derivation state.
  private lastSpeaker: string | null = null;
  private lastSpeakerEndMs: number | null = null;
  private currentSpeakerStartMs: number | null = null;

  constructor() {
    // Reuse the same collab+room decision realtime made — do not recompute.
    this.enabled = realtime.enabled;
    window.addEventListener("beforeunload", () => this.disconnect());
  }

  async connect(): Promise<void> {
    if (!this.enabled) return;
    const tokenUrl =
      `${TOKEN_BASE}/token/${realtime.roomCode}` +
      `?identity=${encodeURIComponent(telemetry.participantId)}` +
      `&name=${encodeURIComponent(telemetry.nickname)}`;
    try {
      const res = await fetch(tokenUrl);
      if (!res.ok) {
        // 503 voice-not-configured (or any non-200) => skip voice cleanly.
        telemetry.log("voice_unavailable", { status: res.status });
        console.info("[VM-Voice] voice unavailable, skipping", res.status);
        return;
      }
      const { token, url } = (await res.json()) as {
        token: string;
        url: string;
      };
      this.room = new Room({ adaptiveStream: false, dynacast: false });
      // Wire listeners BEFORE connect so no early events are missed.
      this.wireListeners(this.room);
      await this.room.connect(url, token);
      await this.room.localParticipant.setMicrophoneEnabled(true);
      telemetry.log("voice_connected", { room: realtime.roomCode });
    } catch (e) {
      // Missing/failed LiveKit must be a no-op, like the 503 path.
      telemetry.log("voice_error", { message: (e as Error).message });
      console.info("[VM-Voice] connect failed, voice disabled", e);
    }
  }

  private wireListeners(room: Room): void {
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.onActiveSpeakers(speakers);
    });
    room.on(RoomEvent.Disconnected, () => {
      telemetry.log("voice_disconnected", {});
      this.speakingNow.clear();
    });
  }

  private onActiveSpeakers(speakers: Participant[]): void {
    // Shared, clock-synced timebase across machines (NOT wall-clock Date.now()).
    const nowMs = realtime.serverTimeNow;
    const newSet = new Set(speakers.map((s) => s.identity));

    // --- voice_speaking_state: emit on each per-peer on/off edge ---
    for (const id of newSet) {
      if (!this.speakingNow.has(id)) {
        telemetry.log("voice_speaking_state", {
          peer_id: id,
          speaking: true,
          server_time_ms: nowMs,
        });
      }
    }
    for (const id of this.speakingNow) {
      if (!newSet.has(id)) {
        // This speaker just stopped — record when, for the next turn's gap calc.
        this.lastSpeakerEndMs = nowMs;
        telemetry.log("voice_speaking_state", {
          peer_id: id,
          speaking: false,
          server_time_ms: nowMs,
        });
      }
    }

    // --- turn_take: transitions of the dominant speaker ---
    // speakers[0] is the loudest/dominant participant per LiveKit ordering.
    const newSpeaker = speakers.length > 0 ? speakers[0].identity : null;
    if (newSpeaker !== null) {
      // Mark this identity's start if it just entered the active set.
      if (!this.speakingNow.has(newSpeaker)) {
        this.currentSpeakerStartMs = nowMs;
      }
      if (newSpeaker !== this.lastSpeaker) {
        // Was the previous speaker still talking when the new one started?
        const prevStillActive =
          this.lastSpeaker !== null && newSet.has(this.lastSpeaker);
        const newSpeakerStartMs = this.currentSpeakerStartMs ?? nowMs;
        // gap and overlap are mutually exclusive: a turn has a silence gap OR an
        // overlap, never both. Emit whichever is >0, 0 for the other.
        let gapMs = 0;
        let overlapMs = 0;
        if (prevStillActive) {
          overlapMs = Math.max(0, nowMs - newSpeakerStartMs);
        } else {
          gapMs = Math.max(0, nowMs - (this.lastSpeakerEndMs ?? nowMs));
        }
        telemetry.log("turn_take", {
          previous_speaker: this.lastSpeaker,
          new_speaker: newSpeaker,
          gap_ms: gapMs,
          overlap_ms: overlapMs,
          server_time_ms: nowMs,
        });
        this.lastSpeaker = newSpeaker;
      }
    }

    this.speakingNow = newSet;
  }

  /** True if the given peer identity is currently speaking. */
  isSpeaking(peerId: string): boolean {
    return this.speakingNow.has(peerId);
  }

  get connected(): boolean {
    return this.room?.state === "connected";
  }

  disconnect(): void {
    try {
      this.room?.disconnect();
    } catch (_) {
      // already closing
    }
  }
}

export const voice = new VoiceClient();

declare global {
  interface Window {
    voice: VoiceClient;
  }
}
window.voice = voice;
