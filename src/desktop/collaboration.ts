export type Vec3Tuple = [number, number, number];

export interface SharedTransform {
  position: Vec3Tuple;
  rotation: Vec3Tuple;
  sockets?: [number | null, number | null] | null;
  endpoints?: [Vec3Tuple, Vec3Tuple];
  activeEndpoint?: 0 | 1;
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
}

export type CollaborationRole = "builder" | "verifier";
export type CollaborationPhase = "frame" | "build" | "test" | "reflect";
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
  | "reflect";

export interface ActivityTrace {
  id: string;
  participantId: string;
  participantName: string;
  createdAt: number;
  action: TraceAction;
  phase: CollaborationPhase;
  studio: "circuit" | "greenhouse";
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
  | {
      kind: "attention";
      participantId: string;
      participantName: string;
      componentId: string;
      componentName: string;
    }
  | { kind: "state-request"; participantId: string }
  | {
      kind: "state-response";
      participantId: string;
      targetId: string;
      transforms: Record<string, SharedTransform>;
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
  onState: (transforms: Record<string, SharedTransform>) => void;
  onPhase: (phase: CollaborationPhase, participantId: string) => void;
  onTrace: (trace: ActivityTrace) => void;
  onAttention: (
    componentId: string,
    componentName: string,
    participant: { id: string; name: string },
  ) => void;
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
  onTrace: () => undefined,
  onAttention: () => undefined,
};

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

  constructor(
    roomCode: string,
    name: string,
    events: Partial<RoomEvents> = {},
    authenticatedId?: string,
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
    this.socketUrl = roomSocketUrl;
    this.channel = !this.socketUrl && "BroadcastChannel" in window
      ? new BroadcastChannel(`virtual-makerspace:${this.roomCode}`)
      : null;
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
    const transform = this.pendingTransforms.get(componentId);
    if (!transform) return;
    this.pendingTransforms.delete(componentId);
    const sequence = (this.outboundSequences.get(componentId) ?? 0) + 1;
    this.outboundSequences.set(componentId, sequence);
    this.post({
      kind: "transform",
      participantId: this.participant.id,
      componentId,
      transform,
      sequence,
    });
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
    studio: "circuit" | "greenhouse",
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
  ): void {
    this.post({
      kind: "state-response",
      participantId: this.participant.id,
      targetId,
      transforms,
    });
  }

  claim(componentId: string): void {
    this.claims.set(componentId, this.participant.id);
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
  }

  release(componentId: string): void {
    const timer = this.transformTimers.get(componentId);
    if (timer) window.clearTimeout(timer);
    this.transformTimers.delete(componentId);
    this.flushTransform(componentId);
    this.claims.delete(componentId);
    this.events.onClaim(componentId, null);
    this.post({
      kind: "release",
      participantId: this.participant.id,
      participantName: this.participant.name,
      componentId,
    });
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
    if (!message || ("participantId" in message && message.participantId === this.participant.id)) {
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
        this.events.onTransform(
          message.componentId,
          message.transform,
          message.participantId,
        );
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
      case "attention":
        this.events.onAttention(
          message.componentId,
          message.componentName,
          { id: message.participantId, name: message.participantName },
        );
        break;
      case "state-request":
        if (this.isStateCoordinator(message.participantId)) {
          this.events.onStateRequest(message.participantId);
        }
        break;
      case "state-response":
        if (message.targetId === this.participant.id && this.awaitingState) {
          this.awaitingState = false;
          this.events.onState(message.transforms);
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
    const [firstParticipant] = [...this.participants.values()]
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
    const [coordinator] = [...this.participants.values()]
      .filter((participant) => participant.id !== requesterId)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    return coordinator?.id === this.participant.id;
  }

  private post(message: RoomMessage): void {
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
      socket.send(JSON.stringify({
        kind: "state-request",
        participantId: this.participant.id,
      } satisfies RoomMessage));
      this.events.onVoiceStatus("Realtime room connected");
    });
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed) return;
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
    if (["hello", "goodbye", "state-request", "state-response", "signal", "attention"].includes(message.kind)) {
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
