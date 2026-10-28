import type { SnapinoStatement } from "./snapino.js";
import {
  SyncReplica,
  type EditChange,
  type EditProgramRequest,
  type EditResult,
  type Stamp,
  type SyncEffect,
  type SyncMode,
} from "./sync-replica.ts";

export type { EditResult } from "./sync-replica.ts";

/** How long an edit waits for the room's answer before it counts as failed. */
const EDIT_TIMEOUT_MS = 8_000;

export type Vec3Tuple = [number, number, number];

export interface SharedTransform {
  position: Vec3Tuple;
  rotation: Vec3Tuple;
  sockets?: [number | null, number | null] | null;
  endpoints?: [Vec3Tuple, Vec3Tuple];
  activeEndpoint?: 0 | 1;
  /** Slide-switch state for Snap Lab S1. */
  on?: boolean;
  /**
   * Edited electrical values for Circuit Bench parts (resistor ohms, battery volts). Absent
   * means "unchanged" (older clients never send it); every snapshot includes it explicitly.
   * Validated with the same bounds by the Worker relay (cloudflare/worker.js sanitizeProps).
   */
  props?: { ohms?: number; volts?: number };
}

export interface Participant {
  id: string;
  name: string;
  joinedAt: number;
  voiceReady: boolean;
  muted: boolean;
  role: CollaborationRole;
  ready: boolean;
  activity: ParticipantActivity;
  activityDetail?: string;
  lastActiveAt: number;
  /** "agent" marks an AI teammate hosted by a human participant's browser. */
  kind?: "human" | "agent";
}

export type CollaborationRole = "builder" | "verifier";
export type CollaborationPhase = "frame" | "build" | "test" | "reflect";
export type StudioChoice = "circuit" | "greenhouse" | "snap" | "snapino";
export type ParticipantActivity =
  | "available"
  | "inspecting"
  | "moving"
  | "discussing"
  | "testing"
  | "reflecting";

export type TraceAction =
  | "inspect"
  | "claim"
  | "move"
  | "discuss"
  | "test"
  | "snapshot"
  | "role"
  | "phase"
  | "ready"
  | "reflect"
  /** An AI teammate's belief changed because a teammate taught it (no message body). */
  | "teach"
  /**
   * A non-spatial edit: an electrical value change, undo/redo, project import or reset. Kept
   * apart from "claim"/"move" so existing claim/move research metrics do not count them.
   */
  | "edit";

export interface ActivityTrace {
  id: string;
  participantId: string;
  participantName: string;
  createdAt: number;
  action: TraceAction;
  phase: CollaborationPhase;
  studio: "circuit" | "greenhouse" | "snap" | "snapino";
  objectId?: string;
  objectName?: string;
  detail?: string;
}

export interface RoomChatMessage {
  id: string;
  participantId: string;
  author: string;
  body: string;
  createdAt: number;
  context?: string;
}

type SignalPayload =
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

type RoomMessage =
  | { kind: "hello" | "presence"; participant: Participant }
  | { kind: "goodbye"; participantId: string }
  | { kind: "chat"; message: RoomChatMessage }
  | {
      kind: "transform";
      participantId: string;
      componentId: string;
      transform: SharedTransform;
      sequence: number;
      /** Peer mode only: Lamport stamp, so same-device tabs converge on concurrent moves. */
      stamp?: Stamp;
    }
  | {
      kind: "claim" | "release";
      participantId: string;
      componentId: string;
      participantName: string;
    }
  | {
      kind: "voice-state";
      participantId: string;
      voiceReady: boolean;
      muted: boolean;
    }
  | {
      kind: "phase";
      participantId: string;
      phase: CollaborationPhase;
    }
  | { kind: "trace"; participantId: string; trace: ActivityTrace }
  | { kind: "studio"; participantId: string; studio: StudioChoice }
  | { kind: "program"; participantId: string; program: SnapinoStatement[]; running: boolean }
  | {
      kind: "attention";
      participantId: string;
      participantName: string;
      componentId: string;
      componentName: string;
    }
  | { kind: "state-request"; participantId: string }
  | { kind: "room-state-request"; participantId: string }
  | ({ kind: "edit"; participantId: string; opId: string } & Record<string, unknown>)
  | {
      kind: "state-response";
      participantId: string;
      targetId: string;
      transforms: Record<string, SharedTransform>;
      /** Peer mode: the sender's Lamport clock, so the joiner's first change outranks older ones. */
      clock?: number;
      /** Peer mode: the Snapino program the tabs run. */
      program?: { program: SnapinoStatement[]; running: boolean };
    }
  | {
      kind: "signal";
      participantId: string;
      targetId: string;
      payload: SignalPayload;
    };

export interface RoomEvents {
  onParticipants: (participants: Participant[]) => void;
  onChat: (message: RoomChatMessage) => void;
  onTransform: (
    componentId: string,
    transform: SharedTransform,
    participantId: string,
  ) => void;
  onClaim: (
    componentId: string,
    owner: { id: string; name: string } | null,
  ) => void;
  onVoiceStatus: (status: string) => void;
  onRemoteAudio: (participantId: string, stream: MediaStream) => void;
  onStateRequest: (targetId: string) => void;
  onState: (transforms: Record<string, SharedTransform>, program?: { program: SnapinoStatement[]; running: boolean }) => void;
  onPhase: (phase: CollaborationPhase, participantId: string) => void;
  onStudio: (studio: StudioChoice, participantId: string) => void;
  onProgram: (program: SnapinoStatement[], running: boolean, participantId: string) => void;
  onTrace: (trace: ActivityTrace) => void;
  onAttention: (
    componentId: string,
    componentName: string,
    participant: { id: string; name: string },
  ) => void;
  /**
   * A part state to show: a teammate's move (`force` false) or an accepted edit / the room's
   * authoritative state (`force` true). `propsOnly`: own later moves are still in flight.
   */
  onApply: (componentId: string, transform: SharedTransform, options: { force: boolean; propsOnly: boolean; participantId: string }) => void;
  /** The room refused this participant's move or claim; `transform` null = the part's default. */
  onRevert: (componentId: string, transform: SharedTransform | null, options: { superseded: boolean; holderName?: string }) => void;
  onClaimDenied: (resourceId: string, holderName: string) => void;
  /**
   * The room's full state arrived (server mode, on every (re)join). Parts not in
   * `componentIds` are at their defaults, except `ownMovesInFlight`. `fresh`: the room has no
   * bench state at all — a returning bench may seed it.
   */
  onRoomState: (state: { fresh: boolean; componentIds: string[]; ownMovesInFlight: string[] }) => void;
}

const noOpEvents: RoomEvents = {
  onParticipants: () => undefined,
  onChat: () => undefined,
  onTransform: () => undefined,
  onClaim: () => undefined,
  onVoiceStatus: () => undefined,
  onRemoteAudio: () => undefined,
  onStateRequest: () => undefined,
  onState: () => undefined,
  onPhase: () => undefined,
  onStudio: () => undefined,
  onProgram: () => undefined,
  onTrace: () => undefined,
  onAttention: () => undefined,
  onApply: () => undefined,
  onRevert: () => undefined,
  onClaimDenied: () => undefined,
  onRoomState: () => undefined,
};

/** Messages from the room itself (server mode) that the sync rules interpret. */
const SERVER_REPLY_KINDS = new Set([
  "rev-ack",
  "transform-rejected",
  "claim-granted",
  "claim-denied",
  "edit",
  "edit-result",
  "room-state",
  "program",
  "program-ack",
]);

export class DesktopRoom {
  readonly participant: Participant;
  readonly roomCode: string;

  private readonly events: RoomEvents;
  private readonly channel: BroadcastChannel | null;
  private readonly socketUrl: URL | null;
  private socket: WebSocket | null = null;
  private readonly participants = new Map<string, Participant>();
  private readonly claims = new Map<string, string>();
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly outboundSequences = new Map<string, number>();
  private readonly inboundSequences = new Map<string, number>();
  private readonly pendingTransforms = new Map<string, SharedTransform>();
  private readonly transformTimers = new Map<string, number>();
  private readonly socketOutbox: RoomMessage[] = [];
  private sharedPhase: CollaborationPhase = "frame";
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private awaitingState = true;
  private closed = false;
  private roleCustomized = false;
  private localStream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  /** Revisions, acknowledgements and refusals (server mode) or Lamport order (peer mode). */
  readonly sync: SyncReplica;
  private readonly editWaiters = new Map<string, { resolve: (result: EditResult) => void; timer: number }>();
  private readonly claimWaiters = new Map<string, Array<(granted: boolean) => void>>();
  private readonly settleWaiters = new Map<string, Array<(ok: boolean) => void>>();

  constructor(
    roomCode: string,
    name: string,
    events: Partial<RoomEvents> = {},
    authenticatedId?: string,
    options: { agent?: boolean } = {},
  ) {
    this.roomCode = roomCode.toUpperCase();
    this.events = { ...noOpEvents, ...events };
    this.participant = {
      id: authenticatedId
        ? `${authenticatedId}:${crypto.randomUUID()}`
        : crypto.randomUUID(),
      name,
      joinedAt: Date.now(),
      voiceReady: false,
      muted: true,
      role: "builder",
      ready: false,
      activity: "available",
      lastActiveAt: Date.now(),
      kind: options.agent ? "agent" : "human",
    };
    this.participants.set(this.participant.id, this.participant);

    const configuredSocketUrl = String(import.meta.env.VITE_COLLAB_WS_URL ?? "").trim();
    const hostedSocketUrl = location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? ""
      : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/room`;
    const socketUrl = configuredSocketUrl || hostedSocketUrl;
    const roomSocketUrl = socketUrl ? new URL(socketUrl, location.href) : null;
    roomSocketUrl?.searchParams.set("room", this.roomCode);
    roomSocketUrl?.searchParams.set("participant", this.participant.id);
    if (options.agent) roomSocketUrl?.searchParams.set("agent", "1");
    this.socketUrl = roomSocketUrl;
    this.channel = !this.socketUrl && "BroadcastChannel" in window
      ? new BroadcastChannel(`virtual-makerspace:${this.roomCode}`)
      : null;
    this.sync = new SyncReplica(this.participant.id, this.socketUrl ? "server" : "peer");
    if (this.socketUrl) {
      window.addEventListener("online", this.handleOnline);
      this.connectSocket();
    }
    if (this.channel) {
      this.channel.addEventListener("message", this.handleMessage);
      this.post({ kind: "hello", participant: this.participant });
      this.post({ kind: "state-request", participantId: this.participant.id });
    }
    this.emitParticipants();
  }

  sendChat(body: string, context?: string): RoomChatMessage {
    const message: RoomChatMessage = {
      id: crypto.randomUUID(),
      participantId: this.participant.id,
      author: this.participant.name,
      body,
      createdAt: Date.now(),
      context,
    };
    this.events.onChat(message);
    this.post({ kind: "chat", message });
    return message;
  }

  get mode(): SyncMode {
    return this.sync.mode;
  }

  /** Server mode without an open socket: nothing can change until the room is back. */
  get offline(): boolean {
    return this.sync.mode === "server" && this.socket?.readyState !== WebSocket.OPEN;
  }

  /**
   * Submits an atomic batch of whole-part changes (and optionally the Snapino program). In
   * server mode nothing changes locally until the room accepts it; the accepted state then
   * arrives through `onApply`/`onProgram` before this resolves. In peer mode it applies now.
   */
  submitEdit(changes: Array<{ id: string; transform: SharedTransform }>, program?: EditProgramRequest): Promise<EditResult> {
    if (this.closed) return Promise.resolve({ ok: false, reason: "disconnected" });
    if (this.offline) return Promise.resolve({ ok: false, reason: "offline" });
    const opId = crypto.randomUUID();
    const clean: EditChange[] = changes.map(({ id, transform }) => {
      const copy = { ...transform };
      delete copy.activeEndpoint;
      return { componentId: id, transform: copy };
    });
    const { message, immediate } = this.sync.createEdit(opId, clean, program);
    return new Promise((resolve) => {
      const timer = this.sync.mode === "server"
        ? window.setTimeout(() => this.runEffects(this.sync.expire(opId)), EDIT_TIMEOUT_MS)
        : 0;
      this.editWaiters.set(opId, { resolve, timer });
      this.post(message as RoomMessage);
      this.runEffects(immediate);
    });
  }

  /** Asks the room for its full state again (e.g. after a refused seed). */
  requestRoomState(): void {
    if (this.sync.mode === "server") this.post({ kind: "room-state-request", participantId: this.participant.id });
  }

  sendTransform(componentId: string, transform: SharedTransform): void {
    this.pendingTransforms.set(componentId, transform);
    if (this.transformTimers.has(componentId)) return;
    const timer = window.setTimeout(() => {
      this.transformTimers.delete(componentId);
      this.flushTransform(componentId);
    }, 40);
    this.transformTimers.set(componentId, timer);
  }

  private flushTransform(componentId: string): void {
    const pending = this.pendingTransforms.get(componentId);
    if (!pending) return;
    this.pendingTransforms.delete(componentId);
    // Values and the switch state change only through accepted edits; the room keeps its own
    // when storing a move.
    const transform = { ...pending };
    delete transform.props;
    delete transform.on;
    const sequence = (this.outboundSequences.get(componentId) ?? 0) + 1;
    this.outboundSequences.set(componentId, sequence);
    if (this.sync.mode === "server") {
      // A move that cannot reach the room is dropped, not queued: the room's state on
      // reconnect replaces it.
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this.sync.noteOwnTransform(componentId);
      this.post({ kind: "transform", participantId: this.participant.id, componentId, transform, sequence });
      return;
    }
    const stamp = this.sync.stampTransform(componentId);
    this.post({ kind: "transform", participantId: this.participant.id, componentId, transform, sequence, stamp });
  }

  setActivity(activity: ParticipantActivity, activityDetail?: string): void {
    this.participant.activity = activity;
    this.participant.activityDetail = activityDetail?.slice(0, 120);
    this.participant.lastActiveAt = Date.now();
    this.post({ kind: "presence", participant: this.participant });
    this.emitParticipants();
  }

  setRole(role: CollaborationRole): void {
    this.roleCustomized = true;
    this.participant.role = role;
    this.participant.lastActiveAt = Date.now();
    this.post({ kind: "presence", participant: this.participant });
    this.emitParticipants();
  }

  setReady(ready: boolean): void {
    this.participant.ready = ready;
    this.participant.lastActiveAt = Date.now();
    this.post({ kind: "presence", participant: this.participant });
    this.emitParticipants();
  }

  setPhase(phase: CollaborationPhase): void {
    this.sharedPhase = phase;
    this.participant.ready = false;
    this.participant.lastActiveAt = Date.now();
    this.post({ kind: "presence", participant: this.participant });
    this.post({ kind: "phase", participantId: this.participant.id, phase });
    this.events.onPhase(phase, this.participant.id);
    this.emitParticipants();
  }

  /** Host-only on the server: moves every participant in the room to one studio. */
  setStudio(studio: StudioChoice): void {
    this.post({ kind: "studio", participantId: this.participant.id, studio });
  }

  // Program uploads/stops go through submitEdit (program-only, unconditional): the room orders
  // them and everyone, the uploader included, applies them in that order.

  sendAttention(componentId: string, componentName: string): void {
    this.post({
      kind: "attention",
      participantId: this.participant.id,
      participantName: this.participant.name,
      componentId,
      componentName,
    });
  }

  recordTrace(
    action: TraceAction,
    phase: CollaborationPhase,
    studio: StudioChoice,
    details: Pick<ActivityTrace, "objectId" | "objectName" | "detail"> = {},
  ): ActivityTrace {
    const trace: ActivityTrace = {
      id: crypto.randomUUID(),
      participantId: this.participant.id,
      participantName: this.participant.name,
      createdAt: Date.now(),
      action,
      phase,
      studio,
      ...details,
    };
    this.events.onTrace(trace);
    this.post({ kind: "trace", participantId: this.participant.id, trace });
    return trace;
  }

  sendState(
    targetId: string,
    transforms: Record<string, SharedTransform>,
    program?: { program: SnapinoStatement[]; running: boolean },
  ): void {
    this.post({
      kind: "state-response",
      participantId: this.participant.id,
      targetId,
      transforms,
      clock: this.sync.clock,
      ...(program ? { program } : {}),
    });
  }

  /**
   * Claims a part or a cable end. Resolves true once the room grants it (immediately in peer
   * mode), false if it is refused — the room then also sends its state of the part.
   */
  claim(componentId: string): Promise<boolean> {
    this.claims.set(componentId, this.participant.id);
    this.sync.beginHold(componentId);
    this.events.onClaim(componentId, {
      id: this.participant.id,
      name: this.participant.name,
    });
    this.post({
      kind: "claim",
      participantId: this.participant.id,
      participantName: this.participant.name,
      componentId,
    });
    if (this.sync.mode === "peer") return Promise.resolve(true);
    if (this.offline) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiting = this.claimWaiters.get(componentId) ?? [];
      waiting.push(resolve);
      this.claimWaiters.set(componentId, waiting);
    });
  }

  /**
   * Lets go of a part after sending its final move. Resolves true once every move of this hold
   * was accepted (so it may be recorded as a move), false if any was refused.
   */
  release(componentId: string): Promise<boolean> {
    // Moves are queued per part (a cable end's moves too), so the final one goes out now —
    // before the release, while the claim still stands.
    const partId = componentId.split("::")[0];
    const timer = this.transformTimers.get(partId);
    if (timer) window.clearTimeout(timer);
    this.transformTimers.delete(partId);
    this.flushTransform(partId);
    this.dropClaim(componentId);
    const settled = this.sync.settleRelease(partId);
    if (settled !== null) return Promise.resolve(settled && !(this.sync.mode === "server" && this.offline));
    return new Promise((resolve) => {
      const waiting = this.settleWaiters.get(partId) ?? [];
      waiting.push(resolve);
      this.settleWaiters.set(partId, waiting);
    });
  }

  /** Gives up a hold the room ended (refused claim or authoritative change): no final move. */
  abandon(componentId: string): void {
    const partId = componentId.split("::")[0];
    const timer = this.transformTimers.get(partId);
    if (timer) window.clearTimeout(timer);
    this.transformTimers.delete(partId);
    this.pendingTransforms.delete(partId);
    // Anyone still waiting on this claim (e.g. Bolt after its timeout) gets a refusal now, so a
    // later claim of the same part is not answered with this one's result.
    // The room still answers that claim (in order), so its slot stays, answered by a no-op.
    const waiting = this.claimWaiters.get(componentId) ?? [];
    for (let index = 0; index < waiting.length; index += 1) {
      waiting[index](false);
      waiting[index] = () => undefined;
    }
    if (this.claims.get(componentId) === this.participant.id) this.dropClaim(componentId);
  }

  private dropClaim(componentId: string): void {
    if (this.claims.get(componentId) === this.participant.id) {
      this.claims.delete(componentId);
      this.events.onClaim(componentId, null);
    }
    this.post({
      kind: "release",
      participantId: this.participant.id,
      participantName: this.participant.name,
      componentId,
    });
  }

  private runEffects(effects: SyncEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case "apply":
          this.events.onApply(effect.componentId, effect.transform, { force: effect.force, propsOnly: Boolean(effect.propsOnly), participantId: "" });
          break;
        case "program":
          this.events.onProgram(effect.program, effect.running, effect.participantId);
          break;
        case "resolve": {
          const waiter = this.editWaiters.get(effect.opId);
          if (!waiter) break;
          this.editWaiters.delete(effect.opId);
          window.clearTimeout(waiter.timer);
          waiter.resolve(effect.result);
          break;
        }
        case "revert":
          this.events.onRevert(effect.componentId, effect.transform, { superseded: Boolean(effect.superseded), holderName: effect.holderName });
          break;
        case "claim-denied":
          if (this.claims.get(effect.componentId) === this.participant.id) {
            this.claims.delete(effect.componentId);
            this.events.onClaim(effect.componentId, null);
          }
          this.events.onClaimDenied(effect.componentId, effect.holderName);
          break;
        case "claim-result": {
          const waiting = this.claimWaiters.get(effect.resourceId);
          const resolve = waiting?.shift();
          if (waiting && !waiting.length) this.claimWaiters.delete(effect.resourceId);
          resolve?.(effect.granted);
          break;
        }
        case "settled": {
          const waiting = this.settleWaiters.get(effect.componentId) ?? [];
          this.settleWaiters.delete(effect.componentId);
          for (const resolve of waiting) resolve(effect.ok);
          break;
        }
        case "claims":
          for (const claim of effect.claims) {
            if (claim.participantId === this.participant.id) continue;
            this.claims.set(claim.componentId, claim.participantId);
            this.events.onClaim(claim.componentId, { id: claim.participantId, name: claim.participantName });
          }
          break;
        case "room-state":
          this.events.onRoomState({ fresh: effect.fresh, componentIds: effect.componentIds, ownMovesInFlight: effect.ownMovesInFlight });
          break;
      }
    }
  }

  async enableVoice(): Promise<MediaStream> {
    if (this.localStream) return this.localStream;
    this.events.onVoiceStatus("Connecting to microphone…");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    this.localStream = stream;
    for (const track of stream.getAudioTracks()) track.enabled = false;

    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);

    this.participant.voiceReady = true;
    this.participant.muted = true;
    this.postVoiceState();
    this.events.onVoiceStatus("Voice connected · muted");

    for (const peer of this.participants.values()) {
      if (peer.id !== this.participant.id && peer.voiceReady) {
        await this.maybeStartPeer(peer.id);
      }
    }
    return stream;
  }

  setMuted(muted: boolean): void {
    this.participant.muted = muted;
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
    this.postVoiceState();
    this.emitParticipants();
    this.events.onVoiceStatus(muted ? "Voice connected · muted" : "Voice connected · speaking");
  }

  isMuted(): boolean {
    return this.participant.muted;
  }

  hasVoice(): boolean {
    return this.localStream !== null;
  }

  getAudioLevel(): number {
    if (!this.analyser || this.participant.muted) return 0;
    const values = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(values);
    let sum = 0;
    for (const value of values) sum += value;
    return sum / values.length / 255;
  }

  close(): void {
    for (const waiter of this.editWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, reason: "disconnected" });
    }
    this.editWaiters.clear();
    for (const timer of this.transformTimers.values()) window.clearTimeout(timer);
    this.transformTimers.clear();
    this.pendingTransforms.clear();
    const goodbye: RoomMessage = { kind: "goodbye", participantId: this.participant.id };
    if (this.channel) this.channel.postMessage(goodbye);
    else if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(goodbye));
    }
    this.closed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    window.removeEventListener("online", this.handleOnline);
    this.channel?.removeEventListener("message", this.handleMessage);
    this.channel?.close();
    this.socket?.removeEventListener("message", this.handleMessage);
    this.socket?.close();
    this.socket = null;
    this.socketOutbox.length = 0;
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.pendingIceCandidates.clear();
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    void this.audioContext?.close();
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    let message: RoomMessage;
    try {
      message = (typeof event.data === "string" ? JSON.parse(event.data) : event.data) as RoomMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const kind = (message as { kind?: unknown }).kind;
    // Room replies addressed to this participant (server mode): acks, refusals, edits, state.
    if (this.sync.mode === "server" && typeof kind === "string" && SERVER_REPLY_KINDS.has(kind)) {
      if (kind === "edit" && (message as { participantId?: unknown }).participantId === this.participant.id) return;
      this.runEffects(this.sync.receive(message as unknown as Record<string, unknown>));
      return;
    }
    if ("participantId" in message && message.participantId === this.participant.id) {
      return;
    }

    switch (message.kind) {
      case "hello":
        this.participants.set(message.participant.id, message.participant);
        this.ensureTeamRole();
        this.post({ kind: "presence", participant: this.participant });
        if (this.isStateCoordinator(message.participant.id)) {
          this.post({ kind: "phase", participantId: this.participant.id, phase: this.sharedPhase });
        }
        this.emitParticipants();
        break;
      case "presence":
        this.participants.set(message.participant.id, message.participant);
        if (this.ensureTeamRole()) {
          this.post({ kind: "presence", participant: this.participant });
        }
        this.emitParticipants();
        break;
      case "goodbye":
        this.participants.delete(message.participantId);
        for (const [resourceId, ownerId] of this.claims) {
          if (ownerId !== message.participantId) continue;
          this.claims.delete(resourceId);
          this.events.onClaim(resourceId, null);
        }
        this.peers.get(message.participantId)?.close();
        this.peers.delete(message.participantId);
        this.emitParticipants();
        break;
      case "chat":
        this.events.onChat(message.message);
        break;
      case "transform":
        {
          const sequenceKey = `${message.participantId}:${message.componentId}`;
          const previous = this.inboundSequences.get(sequenceKey) ?? -1;
          if (message.sequence <= previous) break;
          this.inboundSequences.set(sequenceKey, message.sequence);
        }
        if (this.sync.mode === "server") {
          for (const effect of this.sync.receive(message as unknown as Record<string, unknown>)) {
            if (effect.type === "apply") {
              this.events.onApply(effect.componentId, effect.transform, { force: false, propsOnly: Boolean(effect.propsOnly), participantId: message.participantId });
            }
          }
        } else {
          if (!this.sync.acceptTransform(message.componentId, message.stamp)) break;
          this.events.onApply(message.componentId, message.transform, { force: false, propsOnly: false, participantId: message.participantId });
        }
        this.events.onTransform(
          message.componentId,
          message.transform,
          message.participantId,
        );
        break;
      case "edit":
        // Peer mode: a same-device tab's edit, applied by Lamport order.
        this.runEffects(this.sync.receive(message as unknown as Record<string, unknown>));
        break;
      case "claim":
        this.claims.set(message.componentId, message.participantId);
        this.events.onClaim(message.componentId, {
          id: message.participantId,
          name: message.participantName,
        });
        break;
      case "release":
        this.claims.delete(message.componentId);
        this.events.onClaim(message.componentId, null);
        break;
      case "voice-state": {
        const participant = this.participants.get(message.participantId);
        if (participant) {
          participant.voiceReady = message.voiceReady;
          participant.muted = message.muted;
          this.emitParticipants();
        }
        if (message.voiceReady && this.localStream) {
          void this.maybeStartPeer(message.participantId);
        }
        break;
      }
      case "phase":
        this.sharedPhase = message.phase;
        if (this.participant.ready) {
          this.participant.ready = false;
          this.post({ kind: "presence", participant: this.participant });
          this.emitParticipants();
        }
        this.events.onPhase(message.phase, message.participantId);
        break;
      case "trace":
        this.events.onTrace(message.trace);
        break;
      case "studio":
        this.events.onStudio(message.studio, message.participantId);
        break;
      case "program":
        // Legacy direct upload from an older peer tab.
        this.events.onProgram(message.program, message.running, message.participantId);
        break;
      case "attention":
        this.events.onAttention(
          message.componentId,
          message.componentName,
          { id: message.participantId, name: message.participantName },
        );
        break;
      case "state-request":
        if (this.sync.mode === "peer" && this.isStateCoordinator(message.participantId)) {
          this.events.onStateRequest(message.participantId);
        }
        break;
      case "state-response":
        // Server mode: the room's own state (room-state) is authoritative, never a peer's copy.
        if (this.sync.mode === "server") break;
        if (message.targetId === this.participant.id && this.awaitingState) {
          this.awaitingState = false;
          this.sync.observeClock(message.clock);
          this.events.onState(message.transforms, message.program);
        }
        break;
      case "signal":
        if (message.targetId === this.participant.id) {
          void this.handleSignal(message.participantId, message.payload);
        }
        break;
    }
  };

  private emitParticipants(): void {
    this.events.onParticipants(
      [...this.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt),
    );
  }

  private ensureTeamRole(): boolean {
    if (this.roleCustomized) return false;
    // AI teammates never decide who the human builder is.
    const [firstParticipant] = [...this.participants.values()]
      .filter((participant) => participant.kind !== "agent")
      .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    const nextRole: CollaborationRole = firstParticipant?.id === this.participant.id
      ? "builder"
      : "verifier";
    if (this.participant.role !== nextRole) {
      this.participant.role = nextRole;
      this.participant.lastActiveAt = Date.now();
      return true;
    }
    return false;
  }

  private isStateCoordinator(requesterId: string): boolean {
    // AI teammates do not answer state requests, so they never coordinate.
    const [coordinator] = [...this.participants.values()]
      .filter((participant) => participant.id !== requesterId && participant.kind !== "agent")
      .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    return coordinator?.id === this.participant.id;
  }

  private post(message: RoomMessage): void {
    // A closed BroadcastChannel throws on postMessage; late async callers just stop here.
    if (this.closed) return;
    this.channel?.postMessage(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else if (this.socketUrl && !this.closed) {
      this.queueSocketMessage(message);
    }
  }

  private connectSocket(): void {
    if (
      !this.socketUrl ||
      this.closed ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) return;

    const socket = new WebSocket(this.socketUrl.toString());
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closed) return;
      this.reconnectAttempt = 0;
      this.awaitingState = true;
      socket.send(JSON.stringify({ kind: "hello", participant: this.participant } satisfies RoomMessage));
      this.flushSocketOutbox(socket);
      // The room answers hello with its authoritative state (room-state): no peer copy needed.
      this.events.onVoiceStatus("Realtime room connected");
    });
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed) return;
      // Pending edits and drags fail; the room-state on reconnect is authoritative again.
      this.sync.resetForReconnect();
      this.runEffects(this.sync.failPending("disconnected"));
      for (const [resourceId, waiting] of this.claimWaiters) {
        this.claimWaiters.delete(resourceId);
        for (const resolve of waiting) resolve(false);
      }
      this.resetRemoteSessionState();
      this.events.onVoiceStatus("Realtime room disconnected · reconnecting");
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket && !this.closed) {
        this.events.onVoiceStatus("Realtime room unavailable · reconnecting");
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.socketUrl || this.reconnectTimer !== null) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, 15_000) + Math.random() * 250;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, delay);
  }

  private readonly handleOnline = (): void => {
    if (this.closed || !this.socketUrl || this.socket?.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connectSocket();
  };

  private resetRemoteSessionState(): void {
    for (const participantId of this.participants.keys()) {
      if (participantId !== this.participant.id) this.participants.delete(participantId);
    }
    for (const resourceId of this.claims.keys()) this.events.onClaim(resourceId, null);
    this.claims.clear();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.pendingIceCandidates.clear();
    this.emitParticipants();
  }

  private queueSocketMessage(message: RoomMessage): void {
    // Bench changes are never queued while offline: edits fail at once, moves are dropped, and
    // the room's state decides on reconnect.
    if (["hello", "goodbye", "state-request", "state-response", "signal", "attention", "claim", "release", "transform", "edit", "program", "room-state-request"].includes(message.kind)) {
      return;
    }

    const replaceIndex = this.socketOutbox.findIndex((queued) => {
      if (queued.kind === "transform" && message.kind === "transform") {
        return queued.componentId === message.componentId;
      }
      if (
        (queued.kind === "claim" || queued.kind === "release") &&
        (message.kind === "claim" || message.kind === "release")
      ) return queued.componentId === message.componentId;
      return queued.kind === message.kind && ["presence", "voice-state", "phase"].includes(message.kind);
    });
    if (replaceIndex >= 0) this.socketOutbox[replaceIndex] = message;
    else this.socketOutbox.push(message);
    if (this.socketOutbox.length > 100) this.socketOutbox.shift();
  }

  private flushSocketOutbox(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    for (const message of this.socketOutbox.splice(0)) {
      socket.send(JSON.stringify(message));
    }
  }

  private postVoiceState(): void {
    this.post({
      kind: "voice-state",
      participantId: this.participant.id,
      voiceReady: this.participant.voiceReady,
      muted: this.participant.muted,
    });
  }

  private getOrCreatePeer(remoteId: string): RTCPeerConnection {
    const existing = this.peers.get(remoteId);
    if (existing) return existing;

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    for (const track of this.localStream?.getTracks() ?? []) {
      peer.addTrack(track, this.localStream!);
    }
    peer.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.sendSignal(remoteId, {
        type: "candidate",
        candidate: event.candidate.toJSON(),
      });
    });
    peer.addEventListener("track", (event) => {
      const [stream] = event.streams;
      if (stream) this.events.onRemoteAudio(remoteId, stream);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed") {
        this.events.onVoiceStatus("Voice is reconnecting — 3D work is still available");
        peer.restartIce();
      }
    });
    this.peers.set(remoteId, peer);
    return peer;
  }

  private async maybeStartPeer(remoteId: string): Promise<void> {
    if (!this.localStream || this.participant.id > remoteId) return;
    const peer = this.getOrCreatePeer(remoteId);
    if (peer.signalingState !== "stable") return;
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    this.sendSignal(remoteId, { type: "offer", sdp: offer });
  }

  private async handleSignal(
    remoteId: string,
    payload: SignalPayload,
  ): Promise<void> {
    if (!this.localStream) return;
    const peer = this.getOrCreatePeer(remoteId);
    try {
      if (payload.type === "offer") {
        await peer.setRemoteDescription(payload.sdp);
        await this.flushIceCandidates(remoteId, peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.sendSignal(remoteId, { type: "answer", sdp: answer });
        return;
      }
      if (payload.type === "answer") {
        await peer.setRemoteDescription(payload.sdp);
        await this.flushIceCandidates(remoteId, peer);
        return;
      }
      if (!peer.remoteDescription) {
        const queued = this.pendingIceCandidates.get(remoteId) ?? [];
        if (queued.length < 32) queued.push(payload.candidate);
        this.pendingIceCandidates.set(remoteId, queued);
        return;
      }
      await peer.addIceCandidate(payload.candidate);
    } catch {
      peer.close();
      this.peers.delete(remoteId);
      this.pendingIceCandidates.delete(remoteId);
      this.events.onVoiceStatus("Voice connection needs another attempt · 3D work is still available");
    }
  }

  private async flushIceCandidates(remoteId: string, peer: RTCPeerConnection): Promise<void> {
    const queued = this.pendingIceCandidates.get(remoteId) ?? [];
    this.pendingIceCandidates.delete(remoteId);
    for (const candidate of queued) await peer.addIceCandidate(candidate);
  }

  private sendSignal(targetId: string, payload: SignalPayload): void {
    this.post({
      kind: "signal",
      participantId: this.participant.id,
      targetId,
      payload,
    });
  }
}
