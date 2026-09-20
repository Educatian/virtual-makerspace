import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@phosphor-icons/web/regular";
import "./styles.css";

import {
  DesktopRoom,
  type ActivityTrace,
  type CollaborationPhase,
  type CollaborationRole,
  type Participant,
  type RoomChatMessage,
} from "./collaboration.js";
import {
  DesktopWorkbenchScene,
  type ComponentSpec,
  type EnvironmentState,
  type SceneSnapshot,
  type StudioKind,
} from "./scene.js";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("Missing #app root");
const app: HTMLDivElement = appElement;

const params = new URLSearchParams(window.location.search);
const initialRoomCode = (params.get("room") || "7K3M").toUpperCase();
const initialName = params.get("name") || "Alex Chen";

interface AuthProfile {
  id: string;
  name: string;
  email?: string;
  role: "admin" | "member";
  provider: "cloudflare-access" | "local-preview" | "access-required";
}

let authProfile: AuthProfile = {
  id: `local:${crypto.randomUUID()}`,
  name: initialName,
  role: params.get("role") === "member" ? "member" : "admin",
  provider: "local-preview",
};

let room: DesktopRoom | null = null;
let workbench: DesktopWorkbenchScene | null = null;
let participants: Participant[] = [];
let selectedComponent: ComponentSpec | null = null;
let currentRoomCode = initialRoomCode;
let currentName = initialName;
let powered = false;
let activeStudio: StudioKind = params.get("studio") === "greenhouse" ? "greenhouse" : "circuit";
let environmentState: EnvironmentState = {
  moisture: 34,
  temperature: 28.6,
  light: 58,
  flow: 0,
  irrigation: false,
  ventilation: false,
  systemReady: false,
};
let voiceFrame = 0;
let attempts: SceneSnapshot[] = [];
let queuedSharedState: Record<string, import("./collaboration.js").SharedTransform> | null = null;
const owners = new Map<string, { id: string; name: string }>();
const chatMessageIds = new Set<string>();
const activityTraceIds = new Set<string>();
let activityTraces: ActivityTrace[] = [];
let collaborationPhase: CollaborationPhase = "frame";
let activityTimer = 0;

const collaborationPhases: Array<{
  id: CollaborationPhase;
  label: string;
  icon: string;
}> = [
  { id: "frame", label: "Frame", icon: "ph-target" },
  { id: "build", label: "Build", icon: "ph-wrench" },
  { id: "test", label: "Test", icon: "ph-flask" },
  { id: "reflect", label: "Reflect", icon: "ph-chat-centered-text" },
];

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#039;",
      '"': "&quot;",
    };
    return entities[character];
  });

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

const timeLabel = (timestamp: number): string =>
  new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(
    timestamp,
  );

const collaborationDisplayName = (): string =>
  authProfile.provider === "cloudflare-access" && authProfile.role === "admin"
    ? "Host"
    : authProfile.name || "Maker";

function renderLobby(): void {
  const signedIn = authProfile.provider === "cloudflare-access";
  const accessRequired = authProfile.provider === "access-required";
  const isAdmin = authProfile.role === "admin";
  const displayName = signedIn && isAdmin
    ? "Host"
    : authProfile.name || (accessRequired ? "Google account" : "Local maker");
  const profileDetail = signedIn
    ? isAdmin
      ? "Administrator · Room creator"
      : "Member · Existing rooms"
    : accessRequired
      ? "Sign in to enter a shared room"
      : "Cloudflare Access appears after deployment";
  app.innerHTML = `
    <main class="lobby-shell">
      <header class="brand-header">
        <a class="brand-lockup" href="/" aria-label="Virtual Makerspace home">
          <span class="brand-mark"><i class="ph ph-circuitry"></i></span>
          <span><strong>Virtual Makerspace</strong><small>Build together. Learn together.</small></span>
        </a>
        <div class="brand-meta"><span>Circuits</span><span>Collaboration</span><span>Real understanding</span></div>
      </header>

      <section class="lobby-grid">
        <article class="lobby-card">
          <div class="section-label">Desktop 3D collaboration</div>
          <h1>Welcome to your shared workbench.</h1>
          <p class="lobby-lede">Build and inspect a real 3D circuit together. Each person controls their own view while every component stays in sync.</p>

          <div class="auth-identity ${signedIn ? "is-authenticated" : "is-preview"} ${accessRequired ? "is-required" : ""}">
            <span class="auth-avatar">${escapeHtml(initials(displayName) || "G")}</span>
            <span class="auth-copy">
              <small>${signedIn ? "Signed in with Google" : accessRequired ? "Google sign-in required" : "Local preview"}</small>
              <strong>${escapeHtml(displayName)}</strong>
              <span>${escapeHtml(profileDetail)}</span>
            </span>
            ${signedIn ? '<a class="auth-signout" href="/cdn-cgi/access/logout" data-tooltip="Sign out" aria-label="Sign out"><i class="ph ph-sign-out"></i></a>' : accessRequired ? '<i class="ph ph-lock-key auth-cloud" aria-hidden="true"></i>' : '<i class="ph ph-cloud-check auth-cloud" aria-hidden="true"></i>'}
          </div>

          <label class="field-label" for="room-code">Room code</label>
          <div class="room-code-row">
            <div class="input-shell room-code-input"><i class="ph ph-hash"></i><input id="room-code" maxlength="6" value="${escapeHtml(initialRoomCode)}" aria-describedby="room-help"></div>
            <button class="icon-button" id="copy-room" type="button" aria-label="Copy room code"><i class="ph ph-copy"></i></button>
          </div>
          <p class="field-help" id="room-help">${isAdmin ? "Enter an existing code or generate a new room." : "Enter a room code provided by the administrator."}</p>

          <div class="audio-check" id="audio-check">
            <span class="audio-check-icon"><i class="ph ph-microphone"></i></span>
            <span><strong>Microphone is optional</strong><small>You can join muted and use text chat at any time.</small></span>
            <button class="secondary-button compact" id="test-mic" type="button">Test microphone</button>
          </div>

          <div class="lobby-actions ${isAdmin ? "" : "is-single"}">
            <button class="primary-button" id="enter-room" type="button"><i class="ph ${accessRequired ? "ph-google-logo" : "ph-door-open"}"></i> ${accessRequired ? "Continue with Google" : "Enter Room"}</button>
            ${isAdmin ? '<button class="secondary-button" id="new-room" type="button"><i class="ph ph-plus"></i> New Room</button>' : '<span class="member-access-note"><i class="ph ph-lock-key"></i> Existing rooms only</span>'}
          </div>
          <p class="lobby-note"><i class="ph ph-shield-check"></i> Voice media is not recorded or transcribed.</p>
        </article>

        <aside class="lobby-preview" aria-label="Workbench preview">
          <div class="preview-topline"><span class="status-dot"></span><span>Shared workbench ready</span><span>WebGL 3D</span></div>
          <div class="preview-stage">
            <div class="preview-orbit"><i class="ph ph-arrows-clockwise"></i></div>
            <div class="preview-copy">
              <span class="section-label">Inspect from every angle</span>
              <h2>One circuit.<br>Independent views.</h2>
              <p>Orbit, zoom, move, rotate, discuss, and compare attempts without leaving the workspace.</p>
            </div>
            <div class="preview-features">
              <span><i class="ph ph-cube"></i> True 3D</span>
              <span><i class="ph ph-cursor-click"></i> Mouse controls</span>
              <span><i class="ph ph-chats-circle"></i> Chat + voice</span>
            </div>
          </div>
        </aside>
      </section>
    </main>
  `;

  document.querySelector<HTMLButtonElement>("#copy-room")?.addEventListener("click", async () => {
    const input = document.querySelector<HTMLInputElement>("#room-code")!;
    await navigator.clipboard.writeText(input.value.toUpperCase());
    input.select();
  });

  document.querySelector<HTMLButtonElement>("#new-room")?.addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("#room-code")!;
    input.value = createRoomCode();
  });

  document.querySelector<HTMLButtonElement>("#test-mic")?.addEventListener("click", testMicrophone);
  document.querySelector<HTMLButtonElement>("#enter-room")?.addEventListener("click", async () => {
    if (authProfile.provider === "access-required") {
      window.location.href = `/cdn-cgi/access/login?redirect_url=${encodeURIComponent(location.href)}`;
      return;
    }
    const button = document.querySelector<HTMLButtonElement>("#enter-room");
    const code = document.querySelector<HTMLInputElement>("#room-code")!.value
      .trim()
      .toUpperCase();
    const help = document.querySelector<HTMLElement>("#room-help");
    if (!code || !ROOM_CODE_PATTERN.test(code)) {
      if (help) {
        help.textContent = "Enter a valid 4–6 character room code.";
        help.classList.add("is-error");
      }
      return;
    }
    currentName = collaborationDisplayName();
    currentRoomCode = code;
    if (button) {
      button.disabled = true;
      button.innerHTML = '<i class="ph ph-circle-notch"></i> Entering…';
    }
    const joined = await registerRoomMembership(currentRoomCode);
    if (!joined.ok) {
      if (button) {
        button.disabled = false;
        button.innerHTML = '<i class="ph ph-door-open"></i> Enter Room';
      }
      if (help) {
        help.textContent = joined.error || "This room is unavailable.";
        help.classList.add("is-error");
      }
      return;
    }
    enterWorkspace();
  });
}

async function loadAuthProfile(): Promise<void> {
  try {
    const response = await fetch("/api/me", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
        authProfile = { id: "", name: "", role: "member", provider: "access-required" };
      }
      return;
    }
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return;
    const profile = await response.json() as Partial<AuthProfile>;
    if (!profile.id || !profile.name) return;
    authProfile = {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      role: profile.role === "admin" ? "admin" : "member",
      provider: "cloudflare-access",
    };
    currentName = collaborationDisplayName();
  } catch {
    // Vite's local preview has no Cloudflare Access endpoint.
  }
}

async function registerRoomMembership(roomCode: string): Promise<{ ok: boolean; error?: string }> {
  if (authProfile.provider !== "cloudflare-access") return { ok: true };
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Room access denied" })) as { error?: string };
      return { ok: false, error: payload.error || `Room access denied (${response.status})` };
    }
    return { ok: true };
  } catch (error) {
    console.warn("Room membership could not be verified.", error);
    return { ok: false, error: "The room service is temporarily unavailable." };
  }
}

const ROOM_CODE_PATTERN = /^[A-Z2-9]{4,6}$/;

function createRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 4; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function testMicrophone(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#test-mic");
  const check = document.querySelector<HTMLElement>("#audio-check");
  if (!button || !check) return;
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    for (const track of stream.getTracks()) track.stop();
    check.classList.add("is-ready");
    button.innerHTML = '<i class="ph ph-check"></i> Microphone ready';
  } catch {
    check.classList.add("is-warning");
    button.textContent = "Join with text only";
  }
}

function enterWorkspace(): void {
  params.set("room", currentRoomCode);
  params.delete("name");
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  renderWorkspace();

  const sceneHost = document.querySelector<HTMLElement>("#scene-host");
  if (!sceneHost) throw new Error("Missing scene host");

  room = new DesktopRoom(currentRoomCode, currentName, {
    onParticipants: (next) => {
      participants = next;
      renderParticipants();
      renderTeamPanel();
    },
    onChat: appendChatMessage,
    onTransform: (componentId, transform) => {
      workbench?.applyRemoteTransform(componentId, transform);
    },
    onClaim: (componentId, owner) => {
      if (owner) owners.set(componentId, owner);
      else owners.delete(componentId);
      workbench?.setOwner(
        componentId,
        owner && owner.id !== room?.participant.id ? owner : null,
      );
      renderSelection();
    },
    onVoiceStatus: updateVoiceStatus,
    onRemoteAudio: attachRemoteAudio,
    onStateRequest: (targetId) => {
      if (workbench && room) room.sendState(targetId, workbench.getSharedTransforms());
    },
    onState: (transforms) => {
      if (workbench) workbench.applySharedState(transforms);
      else queuedSharedState = transforms;
    },
    onPhase: (phase, participantId) => {
      collaborationPhase = phase;
      renderTeamPanel();
      const actor = participants.find((participant) => participant.id === participantId);
      if (participantId !== room?.participant.id) {
        showSceneStatus(`${actor?.name ?? "Your partner"} moved the team to ${phase}`, "neutral");
      }
    },
    onTrace: addActivityTrace,
    onAttention: (_componentId, componentName, participant) => {
      showSceneStatus(`${participant.name} is pointing to ${componentName}`, "neutral");
    },
  }, authProfile.id);

  workbench = new DesktopWorkbenchScene(sceneHost, {
    onSelection: (component) => {
      selectedComponent = component;
      if (component) room?.setActivity("inspecting", component.name);
      else room?.setActivity("available");
      renderSelection();
    },
    onStatus: showSceneStatus,
    onTransform: (componentId, transform) => room?.sendTransform(componentId, transform),
    onClaim: (componentId) => {
      const owner = owners.get(componentId);
      if (owner && owner.id !== room?.participant.id) {
        showSceneStatus(`${owner.name} is already moving this component`, "warning");
        return false;
      }
      room?.claim(componentId);
      const componentName = componentNameForResource(componentId);
      room?.setActivity("moving", componentName);
      room?.recordTrace("claim", collaborationPhase, activeStudio, {
        objectId: componentId,
        objectName: componentName,
      });
      return true;
    },
    onRelease: (componentId) => {
      const componentName = componentNameForResource(componentId);
      room?.release(componentId);
      room?.recordTrace("move", collaborationPhase, activeStudio, {
        objectId: componentId,
        objectName: componentName,
      });
      setTransientActivity("available");
    },
    onAttempt: addAttempt,
    onCircuitState: (isPowered) => {
      powered = isPowered;
      renderCircuitState();
    },
    onEnvironmentState: (state) => {
      environmentState = state;
      renderEnvironmentState();
    },
  });
  if (queuedSharedState) {
    workbench.applySharedState(queuedSharedState);
    queuedSharedState = null;
  }

  workbench.switchStudio(activeStudio, false);

  loadActivityTraces();
  renderComponentPalette();
  bindWorkspaceEvents();
  updateStudioUi();
  installNativeTooltips();
  loadChatHistory();
  renderTeamPanel();
  addAttempt(workbench.captureAttempt(activeStudio === "greenhouse" ? "Greenhouse opened" : "Room opened"));
}

function renderWorkspace(): void {
  app.innerHTML = `
    <main class="workspace-shell">
      <header class="workspace-header">
        <div class="workspace-brand" data-tooltip="Virtual Makerspace"><span class="brand-mark small"><i class="ph ph-circuitry"></i></span><span class="sr-only"><strong>Virtual Makerspace</strong><small id="studio-subtitle">Simple LED Circuit</small></span></div>
        <div class="room-pill" data-tooltip="Shared room code"><span class="status-dot"></span><strong>${escapeHtml(currentRoomCode)}</strong><button id="copy-link" class="bare-button" type="button" aria-label="Copy room link" data-tooltip="Copy room link"><i class="ph ph-link"></i></button></div>
        <div class="header-presence" id="header-presence"></div>
        <div class="header-actions">
          <button class="header-button icon-only" id="header-mute" type="button" aria-label="Join voice" data-tooltip="Join voice"><i class="ph ph-microphone-slash"></i><span class="sr-only">Join voice</span></button>
          <span class="connection-state" data-tooltip="Connected"><span class="status-dot"></span><span class="sr-only">Connected</span></span>
          <button class="leave-button icon-only" id="leave-room" type="button" aria-label="Leave room" data-tooltip="Leave room"><i class="ph ph-sign-out"></i></button>
        </div>
      </header>

      <div class="workspace-grid">
        <aside class="component-rail" aria-label="Components">
          <div class="studio-switch" role="tablist" aria-label="Choose studio">
            <button class="studio-tab is-active" data-studio="circuit" data-tooltip="Circuit Bench" type="button" role="tab" aria-label="Circuit Bench" aria-selected="true"><i class="ph ph-circuitry"></i><span class="sr-only">Circuit</span></button>
            <button class="studio-tab" data-studio="greenhouse" data-tooltip="Greenhouse Studio" type="button" role="tab" aria-label="Greenhouse Studio" aria-selected="false"><i class="ph ph-plant"></i><span class="sr-only">Greenhouse</span></button>
          </div>
          <div class="rail-heading" data-tooltip="Drag components into 3D"><span><i class="ph ph-circles-three"></i><span class="sr-only">Components</span></span><small class="sr-only">Drag into 3D</small></div>
          <div class="component-list" id="component-list"></div>
          <button class="rail-footer-button icon-only" id="save-attempt" type="button" aria-label="Save attempt" data-tooltip="Save this attempt"><i class="ph ph-camera"></i></button>
        </aside>

        <section class="viewport-column">
          <div class="viewport-toolbar">
            <div class="viewport-title" data-tooltip="Shared 3D workspace"><i class="ph ph-cube"></i><strong id="viewport-heading">Workbench</strong><span class="sr-only" id="viewport-caption">Camera is local · components are shared</span></div>
            <div class="toolbar-actions">
              <button class="tool-button icon-only is-valid" id="toggle-magnet" type="button" aria-label="Toggle magnetic guidance" data-tooltip="Magnetic guidance on"><i class="ph ph-magnet"></i><span class="sr-only">Magnetism on</span></button>
              <button class="tool-button icon-only" id="reset-view" type="button" aria-label="Reset view" data-tooltip="Reset camera"><i class="ph ph-crosshair"></i><span class="sr-only">Reset view</span></button>
              <button class="tool-button icon-only" id="check-circuit" type="button" aria-label="Test the current system" data-tooltip="Test system"><i class="ph ph-lightning"></i><span class="sr-only">Check circuit</span></button>
              <button class="tool-button icon-only" id="toggle-help" type="button" aria-label="Show controls" data-tooltip="Show controls"><i class="ph ph-question"></i></button>
            </div>
          </div>

          <div class="scene-frame" id="scene-frame">
            <div id="scene-host"></div>
            <div class="scene-status" id="scene-status" data-tone="neutral" role="status" aria-live="polite" aria-atomic="true"><span class="scene-status-dot"></span><span id="scene-status-copy">Drag empty space to orbit the workbench</span></div>
            <div class="control-help is-hidden" id="control-help">
              <div><i class="ph ph-mouse-left-click"></i><span><strong>Orbit</strong>Drag empty space</span></div>
              <div><i class="ph ph-mouse-scroll"></i><span><strong>Zoom</strong>Scroll</span></div>
              <div><i class="ph ph-cursor-click"></i><span><strong>Move</strong>Drag a component or cable end</span></div>
              <div><i class="ph ph-arrows-clockwise"></i><span><strong>Rotate</strong>Drag the selected ring</span></div>
              <div><i class="ph ph-magnet"></i><span><strong>Magnetism</strong>Guides both leads</span></div>
            </div>
            <section class="environment-hud" id="environment-hud" hidden aria-label="Greenhouse live conditions">
              <div class="environment-heading"><span data-tooltip="Live greenhouse conditions"><i class="ph ph-waveform"></i><span class="sr-only">Live conditions</span></span><small id="greenhouse-status" data-tooltip="Connect every subsystem">Incomplete</small></div>
              <div class="environment-metrics">
                <article data-tooltip="Soil moisture"><i class="ph ph-drop"></i><span><small class="sr-only">Soil moisture</small><strong id="metric-moisture">34%</strong></span></article>
                <article data-tooltip="Air temperature"><i class="ph ph-thermometer"></i><span><small class="sr-only">Temperature</small><strong id="metric-temperature">28.6°C</strong></span></article>
                <article data-tooltip="Available grow light"><i class="ph ph-sun"></i><span><small class="sr-only">Grow light</small><strong id="metric-light">58%</strong></span></article>
                <article data-tooltip="Irrigation flow"><i class="ph ph-waves"></i><span><small class="sr-only">Water flow</small><strong id="metric-flow">0.0 L/m</strong></span></article>
              </div>
              <div class="system-lines">
                <span id="irrigation-line" data-tooltip="Irrigation offline"><i class="ph ph-circle"></i><span class="sr-only">Irrigation offline</span></span>
                <span id="ventilation-line" data-tooltip="Ventilation offline"><i class="ph ph-circle"></i><span class="sr-only">Ventilation offline</span></span>
              </div>
            </section>
            <aside class="challenge-card" id="challenge-card" hidden aria-label="Community challenge tools">
              <button class="challenge-orb" type="button" aria-label="Community challenge" data-tooltip="Protect seedlings: moisture >65%, temperature <25°C"><i class="ph ph-flag-banner"></i></button>
              <button class="challenge-action" id="load-field-test" type="button" aria-label="Load field-test layout" data-tooltip="Load a connected field-test layout"><i class="ph ph-play"></i></button>
            </aside>
            <div class="selection-toolbar" id="selection-toolbar" hidden></div>
            <div class="drop-callout" id="drop-callout"><i class="ph ph-cube"></i> Drop into the 3D workspace</div>
          </div>

          <section class="attempt-drawer">
            <div class="attempt-heading"><span><i class="ph ph-clock-counter-clockwise"></i> Attempt history</span><small>Restores create a new state</small></div>
            <div class="attempt-list" id="attempt-list"></div>
          </section>
        </section>

        <aside class="discussion-dock" aria-label="Discussion">
          <div class="discussion-tabs" role="tablist">
            <button class="discussion-tab is-active" data-tab="chat" data-tooltip="Text chat" aria-label="Text chat" type="button"><i class="ph ph-chat-circle-text"></i><span class="sr-only">Chat</span></button>
            <button class="discussion-tab" data-tab="voice" data-tooltip="Voice chat" aria-label="Voice chat" type="button"><i class="ph ph-waveform"></i><span class="sr-only">Voice</span></button>
            <button class="discussion-tab" data-tab="team" data-tooltip="Shared activity" aria-label="Shared activity" type="button"><i class="ph ph-users-three"></i><span class="sr-only">Shared activity</span></button>
            <button class="discussion-tab" data-tab="notes" data-tooltip="Notes and reflection" aria-label="Notes and reflection" type="button"><i class="ph ph-note-pencil"></i><span class="sr-only">Notes</span></button>
          </div>

          <div class="discussion-panel is-active" data-panel="chat">
            <div class="context-banner" id="chat-context"><i class="ph ph-chat-centered-dots"></i><span>General discussion</span><button class="bare-button" id="clear-context" type="button" aria-label="Clear discussion context"><i class="ph ph-x"></i></button></div>
            <div class="chat-list" id="chat-list" aria-live="polite"></div>
            <form class="chat-composer" id="chat-form">
              <label class="sr-only" for="chat-input">Discuss your circuit</label>
              <textarea id="chat-input" rows="2" maxlength="500" placeholder="Discuss your circuit…"></textarea>
              <button class="send-button" type="submit" aria-label="Send message"><i class="ph ph-paper-plane-tilt"></i></button>
            </form>
          </div>

          <div class="discussion-panel" data-panel="voice">
            <div class="voice-hero">
              <span class="voice-icon"><i class="ph ph-waveform"></i></span>
              <span class="section-label">Live discussion</span>
              <h2 id="voice-status">Voice is off</h2>
              <p>Talk while you build. 3D controls and text chat stay available during reconnects.</p>
              <progress id="voice-level" max="1" value="0" aria-label="Microphone level"></progress>
              <button class="primary-button" id="enable-voice" type="button"><i class="ph ph-microphone"></i> Enable voice</button>
              <button class="secondary-button" id="panel-mute" type="button" disabled><i class="ph ph-microphone-slash"></i> Muted</button>
            </div>
            <div class="participant-list" id="participant-list"></div>
            <p class="privacy-note"><i class="ph ph-shield-check"></i> Audio is peer-to-peer and is not recorded.</p>
          </div>

          <div class="discussion-panel" data-panel="team">
            <div class="team-panel" id="team-panel-content"></div>
          </div>

          <div class="discussion-panel" data-panel="notes">
            <div class="notes-stack">
              <label for="hypothesis"><span class="section-label">Pinned hypothesis</span><strong>What do you think will happen?</strong></label>
              <textarea id="hypothesis" rows="5">A resistor in series with the LED will limit current and allow the LED to light safely.</textarea>
              <label for="evidence"><span class="section-label">Evidence</span><strong>What changed after discussion?</strong></label>
              <textarea id="evidence" rows="5" placeholder="Record evidence from the circuit and conversation."></textarea>
              <button class="primary-button" id="open-reflection" type="button"><i class="ph ph-notebook"></i> Open reflection</button>
            </div>
          </div>
        </aside>
      </div>
    </main>

    <dialog class="reflection-dialog" id="reflection-dialog">
      <form method="dialog" id="reflection-form">
        <div class="dialog-heading"><span><span class="section-label">Session reflection</span><h2>Capture what your team learned.</h2></span><button class="icon-button" value="cancel" aria-label="Close reflection"><i class="ph ph-x"></i></button></div>
        <label for="reflection-path">Explain the current path</label>
        <textarea id="reflection-path" rows="4" placeholder="Current flows from…"></textarea>
        <label for="reflection-change">What changed after discussion?</label>
        <textarea id="reflection-change" rows="4" placeholder="We moved…"></textarea>
        <label for="reflection-rule">One rule you would share</label>
        <textarea id="reflection-rule" rows="3" placeholder="Make sure…"></textarea>
        <div class="dialog-actions"><button class="secondary-button" value="cancel">Keep building</button><button class="primary-button" id="save-reflection" value="default"><i class="ph ph-check"></i> Save reflection</button></div>
      </form>
    </dialog>

    <div id="remote-audio" hidden></div>
  `;
}

function renderComponentPalette(): void {
  if (!workbench) return;
  const list = document.querySelector<HTMLElement>("#component-list");
  if (!list) return;
  list.innerHTML = "";
  for (const component of workbench.componentSpecs) {
    const card = document.createElement("button");
    card.className = "component-card";
    card.type = "button";
    card.draggable = true;
    card.dataset.componentId = component.id;
    card.dataset.tooltip = `${component.name} · ${component.detail}`;
    card.title = card.dataset.tooltip;
    card.setAttribute("aria-label", `${component.name}, ${component.detail}`);
    card.innerHTML = `
      <span class="component-symbol" style="--component-color:#${component.color.toString(16).padStart(6, "0")}"><i class="ph ${componentIcon(component)}"></i></span>
      <span class="component-copy sr-only"><strong>${escapeHtml(component.name)}</strong><small>${escapeHtml(component.detail)}</small></span>
    `;
    card.addEventListener("click", () => workbench?.selectById(component.id));
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/x-component-id", component.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      document.querySelector("#scene-frame")?.classList.add("is-drop-target");
    });
    card.addEventListener("dragend", () =>
      document.querySelector("#scene-frame")?.classList.remove("is-drop-target"),
    );
    list.append(card);
  }
}

function componentIcon(component: ComponentSpec): string {
  if (component.kind === "battery") return "ph-battery-high";
  if (component.kind === "wire") return "ph-path";
  if (component.kind === "hose") return "ph-waves";
  if (component.kind === "resistor") return "ph-wave-sine";
  if (component.kind === "sensor") return component.id === "soil-sensor" ? "ph-plant" : component.id === "light-sensor" ? "ph-sun" : "ph-thermometer";
  if (component.kind === "controller") return "ph-cpu";
  if (component.kind === "pump") return "ph-drop";
  if (component.kind === "fan") return "ph-fan";
  if (component.kind === "solar") return "ph-solar-panel";
  return "ph-lightbulb-filament";
}

function bindWorkspaceEvents(): void {
  document.querySelectorAll<HTMLButtonElement>(".studio-tab").forEach((button) => {
    button.addEventListener("click", () => switchStudio(button.dataset.studio === "greenhouse" ? "greenhouse" : "circuit"));
  });
  document.querySelectorAll<HTMLButtonElement>(".discussion-tab").forEach((button) => {
    button.addEventListener("click", () => switchDiscussionTab(button.dataset.tab || "chat"));
  });

  document.querySelector<HTMLFormElement>("#chat-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
    if (!input || !input.value.trim()) return;
    room?.sendChat(input.value.trim(), selectedComponent?.name);
    room?.recordTrace("discuss", collaborationPhase, activeStudio, {
      objectId: selectedComponent?.id,
      objectName: selectedComponent?.name,
      detail: selectedComponent ? "Contextual message" : "Room discussion",
    });
    setTransientActivity("discussing", selectedComponent?.name ?? "Shared plan");
    input.value = "";
  });

  const sceneFrame = document.querySelector<HTMLElement>("#scene-frame");
  sceneFrame?.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    sceneFrame.classList.add("is-drop-target");
  });
  sceneFrame?.addEventListener("dragleave", () => sceneFrame.classList.remove("is-drop-target"));
  sceneFrame?.addEventListener("drop", (event) => {
    event.preventDefault();
    sceneFrame.classList.remove("is-drop-target");
    const componentId = event.dataTransfer?.getData("text/x-component-id");
    if (componentId) workbench?.placeFromScreen(componentId, event.clientX, event.clientY);
  });

  document.querySelector("#reset-view")?.addEventListener("click", () => workbench?.resetView());
  document.querySelector("#toggle-magnet")?.addEventListener("click", () => {
    const enabled = workbench?.toggleMagnetism() ?? false;
    const button = document.querySelector<HTMLButtonElement>("#toggle-magnet");
    if (!button) return;
    button.classList.toggle("is-valid", enabled);
    button.dataset.tooltip = enabled ? "Magnetic guidance on" : "Magnetic guidance off";
    button.setAttribute("aria-label", button.dataset.tooltip);
    button.innerHTML = enabled
      ? '<i class="ph ph-magnet"></i><span class="sr-only">Magnetism on</span>'
      : '<i class="ph ph-magnet-straight"></i><span class="sr-only">Magnetism off</span>';
  });
  document.querySelector("#check-circuit")?.addEventListener("click", runSharedTest);
  document.querySelector("#load-field-test")?.addEventListener("click", () => {
    if (activeStudio === "greenhouse") workbench?.loadGreenhouseDemo();
    else workbench?.loadCircuitDemo();
  });
  document.querySelector("#toggle-help")?.addEventListener("click", () =>
    document.querySelector("#control-help")?.classList.toggle("is-hidden"),
  );
  document.querySelector("#save-attempt")?.addEventListener("click", () => {
    workbench?.saveAttempt("Saved by the team");
    room?.recordTrace("snapshot", collaborationPhase, activeStudio, {
      detail: "Saved a shared 3D state",
    });
  });
  document.querySelector("#copy-link")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(location.href);
    showSceneStatus("Room link copied", "valid");
  });
  document.querySelector("#leave-room")?.addEventListener("click", leaveRoom);
  document.querySelector("#enable-voice")?.addEventListener("click", enableVoice);
  document.querySelector("#header-mute")?.addEventListener("click", toggleMute);
  document.querySelector("#panel-mute")?.addEventListener("click", toggleMute);
  document.querySelector("#open-reflection")?.addEventListener("click", () =>
    document.querySelector<HTMLDialogElement>("#reflection-dialog")?.showModal(),
  );
  document.querySelector("#save-reflection")?.addEventListener("click", saveReflection);
  document.querySelector("#clear-context")?.addEventListener("click", () => {
    selectedComponent = null;
    renderSelection();
  });

  document.addEventListener("keydown", onKeyboardShortcut);
  window.addEventListener("beforeunload", disposeWorkspace, { once: true });
}

function switchStudio(studio: StudioKind): void {
  if (!workbench || studio === activeStudio) return;
  activeStudio = studio;
  selectedComponent = null;
  powered = false;
  params.set("studio", studio);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  workbench.switchStudio(studio);
  room?.setPhase("frame");
  room?.recordTrace("phase", "frame", activeStudio, { detail: `Opened ${studio} studio` });
  renderComponentPalette();
  renderSelection();
  updateStudioUi();
  loadChatHistory();
  workbench.saveAttempt(studio === "greenhouse" ? "Greenhouse Studio opened" : "Circuit Bench opened");
}

function installNativeTooltips(): void {
  document.querySelectorAll<HTMLElement>("[data-tooltip]").forEach((element) => {
    if (element.dataset.tooltip) element.title = element.dataset.tooltip;
  });
}

function updateStudioUi(): void {
  document.querySelectorAll<HTMLButtonElement>(".studio-tab").forEach((button) => {
    const active = button.dataset.studio === activeStudio;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  const subtitle = document.querySelector<HTMLElement>("#studio-subtitle");
  const heading = document.querySelector<HTMLElement>("#viewport-heading");
  const caption = document.querySelector<HTMLElement>("#viewport-caption");
  const hud = document.querySelector<HTMLElement>("#environment-hud");
  const challenge = document.querySelector<HTMLElement>("#challenge-card");
  const checkButton = document.querySelector<HTMLButtonElement>("#check-circuit");
  const challengeOrb = challenge?.querySelector<HTMLButtonElement>(".challenge-orb");
  const challengeAction = challenge?.querySelector<HTMLButtonElement>("#load-field-test");
  const hypothesis = document.querySelector<HTMLTextAreaElement>("#hypothesis");
  const chatInput = document.querySelector<HTMLTextAreaElement>("#chat-input");
  if (subtitle) subtitle.textContent = activeStudio === "greenhouse" ? "Smart Greenhouse" : "Motherboard Circuit Lab";
  if (heading) heading.textContent = activeStudio === "greenhouse" ? "Greenhouse" : "Motherboard";
  if (caption) caption.textContent = activeStudio === "greenhouse" ? "Route sensors, water, air, and power" : "Diagnose and rebuild the LED power path";
  if (hud) hud.hidden = activeStudio !== "greenhouse";
  if (checkButton) {
    checkButton.dataset.tooltip = activeStudio === "greenhouse" ? "Test greenhouse system" : "Test motherboard power path";
    checkButton.title = checkButton.dataset.tooltip;
    checkButton.setAttribute("aria-label", checkButton.dataset.tooltip);
  }
  if (challenge) challenge.hidden = false;
  if (challengeOrb) {
    challengeOrb.dataset.tooltip = activeStudio === "greenhouse"
      ? "Protect seedlings: moisture >65%, temperature <25°C"
      : "Restore power: battery → resistor → LED";
    challengeOrb.title = challengeOrb.dataset.tooltip;
  }
  if (challengeAction) {
    challengeAction.dataset.tooltip = activeStudio === "greenhouse"
      ? "Load a connected field-test layout"
      : "Load a diagnostic reference circuit";
    challengeAction.title = challengeAction.dataset.tooltip;
    challengeAction.setAttribute("aria-label", activeStudio === "greenhouse" ? "Load field-test layout" : "Load diagnostic circuit");
  }
  if (hypothesis) {
    hypothesis.value = activeStudio === "greenhouse"
      ? "If the soil and climate sensors control the pump and fan, the seedlings should remain in the safe growing range."
      : "A resistor in series with the LED will limit current and allow the LED to light safely.";
  }
  if (chatInput) chatInput.placeholder = activeStudio === "greenhouse" ? "Discuss this system…" : "Discuss your circuit…";
  renderCircuitState();
  renderEnvironmentState();
  renderTeamPanel();
}

function switchDiscussionTab(tab: string): void {
  document.querySelectorAll<HTMLElement>(".discussion-tab").forEach((element) =>
    element.classList.toggle("is-active", element.dataset.tab === tab),
  );
  document.querySelectorAll<HTMLElement>(".discussion-panel").forEach((element) =>
    element.classList.toggle("is-active", element.dataset.panel === tab),
  );
}

function renderSelection(): void {
  const toolbar = document.querySelector<HTMLElement>("#selection-toolbar");
  const context = document.querySelector<HTMLElement>("#chat-context span");
  if (!toolbar || !context) return;
  if (!selectedComponent) {
    toolbar.hidden = true;
    context.textContent = "General discussion";
    return;
  }
  const owner = owners.get(selectedComponent.id);
  const flexible = selectedComponent.kind === "wire" || selectedComponent.kind === "hose";
  const endpointOwners = flexible
    ? ([0, 1] as const)
        .map((index) => ({ index, owner: owners.get(`${selectedComponent!.id}::endpoint-${index}`) }))
        .filter((entry) => entry.owner && entry.owner.id !== room?.participant.id)
    : [];
  toolbar.hidden = false;
  toolbar.innerHTML = `
    <span class="selection-name"><i class="ph ${componentIcon(selectedComponent)}"></i><span><small>${flexible ? "Drag either glowing end" : "Selected"}</small><strong>${escapeHtml(selectedComponent.name)}</strong></span></span>
    ${owner && owner.id !== room?.participant.id ? `<span class="owner-chip"><i class="ph ph-hand"></i>${escapeHtml(owner.name)} is moving</span>` : ""}
    ${endpointOwners.map(({ index, owner: endpointOwner }) => `<span class="owner-chip"><i class="ph ph-hand"></i>${escapeHtml(endpointOwner!.name)} · ${index === 0 ? "A" : "B"}</span>`).join("")}
    <button class="tool-button icon-only" id="focus-selected" type="button" aria-label="Focus selected component" data-tooltip="Focus"><i class="ph ph-crosshair-simple"></i></button>
    ${flexible ? "" : `<button class="tool-button icon-only" id="reset-rotation" type="button" aria-label="Reset selected rotation" data-tooltip="Reset rotation"><i class="ph ph-arrow-counter-clockwise"></i></button>`}
    <button class="tool-button icon-only" id="discuss-selected" type="button" aria-label="Discuss selected component" data-tooltip="Discuss"><i class="ph ph-chat-circle-dots"></i></button>
  `;
  context.textContent = `Discussing: ${selectedComponent.name}`;
  installNativeTooltips();
  toolbar.querySelector("#focus-selected")?.addEventListener("click", () => {
    workbench?.focusSelected();
    if (!selectedComponent) return;
    room?.sendAttention(selectedComponent.id, selectedComponent.name);
    room?.recordTrace("inspect", collaborationPhase, activeStudio, {
      objectId: selectedComponent.id,
      objectName: selectedComponent.name,
      detail: "Directed joint attention",
    });
  });
  toolbar.querySelector("#reset-rotation")?.addEventListener("click", () => workbench?.resetSelectedRotation());
  toolbar.querySelector("#discuss-selected")?.addEventListener("click", () => {
    room?.setActivity("discussing", selectedComponent?.name);
    switchDiscussionTab("chat");
    document.querySelector<HTMLTextAreaElement>("#chat-input")?.focus();
  });
}

function appendSeedMessages(): void {
  const now = Date.now();
  appendChatMessage({
    id: "seed-1",
    participantId: "guide",
    author: "Workshop Guide",
    body: activeStudio === "greenhouse"
      ? "Inspect the growing system from two angles. Agree on which subsystem—sensing, water, air, or power—to connect first."
      : "Trace the motherboard power path from battery to resistor to LED. Compare both sides of the center channel before connecting each lead.",
    createdAt: now,
    context: "Room guidance",
  });
}

function loadChatHistory(): void {
  chatMessageIds.clear();
  const raw = localStorage.getItem(`vm-chat:${currentRoomCode}`);
  if (raw) {
    try {
      const history = (JSON.parse(raw) as RoomChatMessage[]).map((message) =>
        message.id === "seed-1"
          ? {
              ...message,
              body: activeStudio === "greenhouse"
                ? "Inspect the growing system from two angles. Agree on which subsystem—sensing, water, air, or power—to connect first."
                : "Trace the motherboard power path from battery to resistor to LED. Compare both sides of the center channel before connecting each lead.",
            }
          : message,
      );
      history.slice(-40).forEach(appendChatMessage);
      if (history.length > 0) return;
    } catch {
      localStorage.removeItem(`vm-chat:${currentRoomCode}`);
    }
  }
  appendSeedMessages();
}

function appendChatMessage(message: RoomChatMessage): void {
  const list = document.querySelector<HTMLElement>("#chat-list");
  if (!list || chatMessageIds.has(message.id)) return;
  chatMessageIds.add(message.id);
  const row = document.createElement("article");
  row.className = "chat-message";
  row.dataset.messageId = message.id;
  row.innerHTML = `
    <span class="avatar ${message.participantId === room?.participant.id ? "is-local" : ""}">${escapeHtml(initials(message.author))}</span>
    <span class="chat-message-copy">
      <span class="chat-meta"><strong>${escapeHtml(message.author)}</strong><time>${timeLabel(message.createdAt)}</time></span>
      ${message.context ? `<span class="message-context"><i class="ph ph-link-simple"></i>${escapeHtml(message.context)}</span>` : ""}
      <p>${escapeHtml(message.body)}</p>
    </span>
  `;
  list.append(row);
  list.scrollTop = list.scrollHeight;
  const stored = [...list.querySelectorAll<HTMLElement>(".chat-message")]
    .slice(-40)
    .map((element) => {
      const id = element.dataset.messageId ?? crypto.randomUUID();
      const author = element.querySelector<HTMLElement>(".chat-meta strong")?.textContent ?? "Maker";
      const body = element.querySelector<HTMLElement>(".chat-message-copy p")?.textContent ?? "";
      const context = element.querySelector<HTMLElement>(".message-context")?.textContent?.trim();
      return { id, participantId: id.startsWith("seed-") ? "guide" : "history", author, body, createdAt: Date.now(), context } satisfies RoomChatMessage;
    });
  localStorage.setItem(`vm-chat:${currentRoomCode}`, JSON.stringify(stored));
}

function renderParticipants(): void {
  const header = document.querySelector<HTMLElement>("#header-presence");
  const list = document.querySelector<HTMLElement>("#participant-list");
  if (header) {
    header.innerHTML = participants
      .slice(0, 4)
      .map(
        (participant) => `
          <span class="presence-avatar ${participant.id === room?.participant.id ? "is-local" : ""}" data-tooltip="${escapeHtml(`${participant.name} · ${participant.activityDetail || activityLabel(participant.activity)} · ${roleLabel(participant.role)}`)}" aria-label="${escapeHtml(participant.name)}">
            ${escapeHtml(initials(participant.name))}
            ${participant.voiceReady && !participant.muted ? '<i class="ph ph-waveform"></i>' : ""}
          </span>`,
      )
      .join("");
  }
  if (list) {
    list.innerHTML = participants
      .map(
        (participant) => `
          <article class="participant-row">
            <span class="avatar ${participant.id === room?.participant.id ? "is-local" : ""}">${escapeHtml(initials(participant.name))}</span>
            <span><strong>${escapeHtml(participant.name)}${participant.id === room?.participant.id ? " · You" : ""}</strong><small>${escapeHtml(participant.activityDetail || activityLabel(participant.activity))} · ${escapeHtml(roleLabel(participant.role))}</small></span>
            <i class="ph ${participant.voiceReady ? (participant.muted ? "ph-microphone-slash" : "ph-waveform") : "ph-chat-circle-text"}"></i>
          </article>`,
      )
      .join("");
  }
  installNativeTooltips();
}

function roleLabel(role?: CollaborationRole): string {
  return role === "verifier" ? "Verifier" : "Builder";
}

function activityLabel(activity?: Participant["activity"]): string {
  const labels: Record<NonNullable<Participant["activity"]>, string> = {
    available: "Available",
    inspecting: "Inspecting",
    moving: "Moving an object",
    discussing: "Discussing",
    testing: "Testing",
    reflecting: "Reflecting",
  };
  return labels[activity ?? "available"];
}

function componentNameForResource(resourceId: string): string {
  const componentId = resourceId.split("::")[0];
  return workbench?.componentSpecs.find((component) => component.id === componentId)?.name ?? componentId;
}

function phasePrompt(phase: CollaborationPhase): string {
  const prompts: Record<StudioKind, Record<CollaborationPhase, string>> = {
    circuit: {
      frame: "One maker proposes the current path. Reviewers identify polarity and resistance risks.",
      build: "One maker places each part while the team checks every lead before the next move.",
      test: "The team inspects the full path and everyone marks ready before applying power.",
      reflect: "Compare the attempt with the evidence and state one transferable circuit rule.",
    },
    greenhouse: {
      frame: "One maker proposes a sensing-to-action chain. Reviewers identify crop and safety risks.",
      build: "One maker connects a subsystem while the team checks power, signal, and physical routing.",
      test: "The team inspects water, air, sensing, and power, then everyone marks ready for the field test.",
      reflect: "Use the live readings to explain what changed and name one rule for the next design.",
    },
  };
  return prompts[activeStudio][phase];
}

function sharedGoal(): string {
  return activeStudio === "greenhouse"
    ? "Co-design a stable growing system that senses soil and climate, then controls water and airflow."
    : "Co-diagnose and rebuild a safe LED power path on the shared motherboard.";
}

function traceIcon(action: ActivityTrace["action"]): string {
  const icons: Record<ActivityTrace["action"], string> = {
    inspect: "ph-eye",
    claim: "ph-hand-grabbing",
    move: "ph-arrows-out-cardinal",
    discuss: "ph-chat-circle-text",
    test: "ph-flask",
    snapshot: "ph-camera",
    role: "ph-arrows-left-right",
    phase: "ph-signpost",
    ready: "ph-check-circle",
    reflect: "ph-notebook",
  };
  return icons[action];
}

function traceLabel(trace: ActivityTrace): string {
  if (trace.detail) return trace.detail;
  if (trace.objectName) return `${trace.action} · ${trace.objectName}`;
  return trace.action;
}

function renderTeamPanel(): void {
  const panel = document.querySelector<HTMLElement>("#team-panel-content");
  if (!panel) return;
  const local = participants.find((participant) => participant.id === room?.participant.id) ?? room?.participant;
  const contributionActions = new Set<ActivityTrace["action"]>(["move", "discuss", "test", "snapshot", "reflect"]);
  const scoredParticipants = participants.map((participant) => ({
    participant,
    score: activityTraces.filter(
      (trace) => trace.participantId === participant.id && contributionActions.has(trace.action),
    ).length,
  }));
  const totalScore = scoredParticipants.reduce((sum, item) => sum + item.score, 0);
  const equalShare = scoredParticipants.length > 0 ? 100 / scoredParticipants.length : 100;
  const participationShares = scoredParticipants.map((item) => ({
    ...item,
    share: totalScore === 0 ? equalShare : (item.score / totalScore) * 100,
  }));
  const participationColors = ["#53a4ff", "#55d98b", "#fbbf24", "#c084fc", "#fb7185", "#22d3ee"];
  const allReady = participants.length > 1 && participants.every((participant) => participant.ready);
  const phaseIndex = collaborationPhases.findIndex((phase) => phase.id === collaborationPhase);
  const partnerLabel = participants.length > 1
    ? participants.map((participant) => participant.name).join(" + ")
    : `${currentName} · waiting for partner`;

  panel.innerHTML = `
    <section class="team-summary">
      <span class="section-label">Team protocol</span>
      <div class="team-title-row"><h2>${escapeHtml(partnerLabel)}</h2><span class="team-sync ${participants.length > 1 ? "is-live" : ""}" data-tooltip="${participants.length > 1 ? `${participants.length} collaborators connected` : "Share the room link"}"><i class="ph ${participants.length > 1 ? "ph-link" : "ph-link-break"}"></i></span></div>
      <p>${escapeHtml(sharedGoal())}</p>
    </section>

    <section class="phase-stepper" aria-label="Shared activity phase">
      ${collaborationPhases.map((phase, index) => `
        <button class="phase-step ${phase.id === collaborationPhase ? "is-active" : ""} ${index < phaseIndex ? "is-complete" : ""}" data-phase="${phase.id}" type="button" data-tooltip="${escapeHtml(phase.label)}" aria-label="Move team to ${escapeHtml(phase.label)}">
          <i class="ph ${index < phaseIndex ? "ph-check" : phase.icon}"></i><span>${escapeHtml(phase.label)}</span>
        </button>`).join("")}
    </section>

    <section class="protocol-prompt"><i class="ph ph-compass-tool"></i><p>${escapeHtml(phasePrompt(collaborationPhase))}</p></section>

    <section class="team-members" aria-label="Collaborator roles and activity">
      ${participants.map((participant) => `
        <article class="team-member ${participant.ready ? "is-ready" : ""}">
          <span class="avatar ${participant.id === room?.participant.id ? "is-local" : ""}">${escapeHtml(initials(participant.name))}</span>
          <span class="team-member-copy"><strong>${escapeHtml(participant.name)}${participant.id === room?.participant.id ? " · You" : ""}</strong><small>${escapeHtml(roleLabel(participant.role))} · ${escapeHtml(participant.activityDetail || activityLabel(participant.activity))}</small></span>
          <i class="ph ${participant.ready ? "ph-check-circle" : "ph-circle-dashed"}" data-tooltip="${participant.ready ? "Ready to test" : "Not ready"}"></i>
        </article>`).join("")}
    </section>

    <section class="coordination-controls">
      <button class="secondary-button compact" id="switch-role" type="button"><i class="ph ph-arrows-left-right"></i> ${local?.role === "verifier" ? "Become builder" : "Become verifier"}</button>
      <button class="primary-button compact ${local?.ready ? "is-ready" : ""}" id="toggle-ready" type="button"><i class="ph ${local?.ready ? "ph-check-circle" : "ph-circle"}"></i> ${local?.ready ? "Ready" : "Mark ready"}</button>
    </section>

    <section class="participation-card">
      <div class="participation-heading"><span><i class="ph ph-scales"></i> Participation</span><small>${scoredParticipants.length > 1 ? `${scoredParticipants.length} collaborators` : "Collaborator needed"}</small></div>
      <div class="participation-bar" aria-label="Participation by collaborator">
        ${participationShares.map((item, index) => `<span style="width:${item.share.toFixed(2)}%;--participant-color:${participationColors[index % participationColors.length]}" title="${escapeHtml(item.participant.name)} · ${Math.round(item.share)}%"></span>`).join("")}
      </div>
      <div class="participation-legend">
        ${participationShares.map((item, index) => `<span><i style="--participant-color:${participationColors[index % participationColors.length]}"></i>${escapeHtml(item.participant.name)} ${Math.round(item.share)}%</span>`).join("")}
      </div>
      <p>Based on moves, discussion, tests, snapshots, and reflection—not speaking time.</p>
    </section>

    <section class="activity-trace">
      <div class="trace-heading"><span><i class="ph ph-path"></i> Shared trace</span><button class="bare-button" id="export-trace" type="button" data-tooltip="Export privacy-safe research log" aria-label="Export research log"><i class="ph ph-download-simple"></i></button></div>
      <div class="trace-list" aria-live="polite">
        ${activityTraces.length === 0 ? '<p class="trace-empty">Actions will appear here as the team builds.</p>' : activityTraces.slice(-7).reverse().map((trace) => `
          <article class="trace-row"><i class="ph ${traceIcon(trace.action)}"></i><span><strong>${escapeHtml(trace.participantName)}</strong><small>${escapeHtml(traceLabel(trace))}</small></span><time>${timeLabel(trace.createdAt)}</time></article>`).join("")}
      </div>
      <p class="trace-privacy"><i class="ph ph-shield-check"></i> No audio, transcript, or message body is logged.</p>
    </section>
  `;

  panel.querySelectorAll<HTMLButtonElement>("[data-phase]").forEach((button) => {
    button.addEventListener("click", () => {
      const phase = button.dataset.phase as CollaborationPhase;
      if (phase === collaborationPhase) return;
      room?.setPhase(phase);
      room?.recordTrace("phase", phase, activeStudio, { detail: `Moved team to ${phase}` });
    });
  });
  panel.querySelector<HTMLButtonElement>("#switch-role")?.addEventListener("click", () => {
    if (!room) return;
    const role: CollaborationRole = room.participant.role === "builder" ? "verifier" : "builder";
    room.setRole(role);
    room.recordTrace("role", collaborationPhase, activeStudio, { detail: `Became ${role}` });
  });
  panel.querySelector<HTMLButtonElement>("#toggle-ready")?.addEventListener("click", () => {
    if (!room) return;
    const ready = !room.participant.ready;
    room.setReady(ready);
    room.recordTrace("ready", collaborationPhase, activeStudio, { detail: ready ? "Marked ready to test" : "Withdrew readiness" });
    if (ready && participants.length > 1 && participants.filter((participant) => participant.id !== room?.participant.id).every((participant) => participant.ready)) {
      showSceneStatus("Everyone is ready to test", "valid");
    }
  });
  panel.querySelector<HTMLButtonElement>("#export-trace")?.addEventListener("click", exportActivityTrace);
  panel.classList.toggle("is-ready", allReady);
  installNativeTooltips();
}

function addActivityTrace(trace: ActivityTrace): void {
  if (activityTraceIds.has(trace.id)) return;
  activityTraceIds.add(trace.id);
  activityTraces.push(trace);
  activityTraces = activityTraces.slice(-250);
  localStorage.setItem(`vm-trace:${currentRoomCode}`, JSON.stringify(activityTraces));
  renderTeamPanel();
}

function loadActivityTraces(): void {
  activityTraceIds.clear();
  activityTraces = [];
  const raw = localStorage.getItem(`vm-trace:${currentRoomCode}`);
  if (!raw) return;
  try {
    const stored = JSON.parse(raw) as ActivityTrace[];
    for (const trace of stored.slice(-250)) {
      if (!trace?.id || activityTraceIds.has(trace.id)) continue;
      activityTraceIds.add(trace.id);
      activityTraces.push(trace);
    }
  } catch {
    localStorage.removeItem(`vm-trace:${currentRoomCode}`);
  }
}

function exportActivityTrace(): void {
  const payload = {
    schemaVersion: "1.0",
    exportedAt: new Date().toISOString(),
    roomCode: currentRoomCode,
    studio: activeStudio,
    phase: collaborationPhase,
    privacy: "Interaction metadata only. Audio, transcripts, message bodies, and email addresses are excluded.",
    participants: participants.map(({ id, name, role }) => ({ id, name, role })),
    events: activityTraces,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `makerspace-${currentRoomCode}-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showSceneStatus("Privacy-safe session trace exported", "valid");
}

function setTransientActivity(activity: Participant["activity"], detail?: string, duration = 6000): void {
  window.clearTimeout(activityTimer);
  room?.setActivity(activity, detail);
  if (activity === "available") return;
  activityTimer = window.setTimeout(() => room?.setActivity("available"), duration);
}

function runSharedTest(): void {
  if (!workbench || !room) return;
  const missingReady = participants.filter((participant) => !participant.ready);
  if (participants.length > 1 && missingReady.length > 0) {
    switchDiscussionTab("team");
    showSceneStatus(`${missingReady.map((participant) => participant.name).join(" + ")} must mark ready before testing`, "warning");
    return;
  }
  room.setActivity("testing", activeStudio === "greenhouse" ? "Field test" : "Power-path test");
  room.recordTrace("test", collaborationPhase, activeStudio, {
    detail: activeStudio === "greenhouse" ? "Ran greenhouse field test" : "Ran motherboard power-path test",
  });
  workbench.checkCircuit();
  window.setTimeout(() => {
    room?.setReady(false);
    setTransientActivity("available");
  }, 900);
}

async function enableVoice(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#enable-voice");
  if (!room || !button) return;
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    await room.enableVoice();
    room.setMuted(false);
    button.innerHTML = '<i class="ph ph-check"></i> Voice connected';
    updateMuteButtons();
    animateVoiceLevel();
  } catch {
    updateVoiceStatus("Microphone unavailable · text chat is still ready");
    button.disabled = false;
    button.textContent = "Try microphone again";
  }
}

function toggleMute(): void {
  if (!room) return;
  if (!room.hasVoice()) {
    switchDiscussionTab("voice");
    void enableVoice();
    return;
  }
  room.setMuted(!room.isMuted());
  updateMuteButtons();
}

function updateMuteButtons(): void {
  if (!room) return;
  const muted = room.isMuted();
  const header = document.querySelector<HTMLButtonElement>("#header-mute");
  const panel = document.querySelector<HTMLButtonElement>("#panel-mute");
  if (header) {
    header.innerHTML = muted
      ? '<i class="ph ph-microphone-slash"></i><span class="sr-only">Muted</span>'
      : '<i class="ph ph-microphone"></i><span class="sr-only">Speaking</span>';
    header.dataset.tooltip = muted ? "Voice muted" : "Voice live";
    header.setAttribute("aria-label", header.dataset.tooltip);
    header.classList.toggle("is-live", !muted);
  }
  if (panel) {
    panel.disabled = false;
    panel.innerHTML = muted
      ? '<i class="ph ph-microphone-slash"></i> Muted'
      : '<i class="ph ph-microphone"></i> Mute';
  }
}

function updateVoiceStatus(status: string): void {
  const label = document.querySelector<HTMLElement>("#voice-status");
  if (label) label.textContent = status;
}

function animateVoiceLevel(): void {
  cancelAnimationFrame(voiceFrame);
  const tick = (): void => {
    const meter = document.querySelector<HTMLProgressElement>("#voice-level");
    if (meter && room) meter.value = room.getAudioLevel();
    voiceFrame = requestAnimationFrame(tick);
  };
  tick();
}

function attachRemoteAudio(participantId: string, stream: MediaStream): void {
  const host = document.querySelector<HTMLElement>("#remote-audio");
  if (!host) return;
  let audio = host.querySelector<HTMLAudioElement>(`audio[data-participant-id="${participantId}"]`);
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.dataset.participantId = participantId;
    host.append(audio);
  }
  audio.srcObject = stream;
  void audio.play().catch(() => undefined);
}

function addAttempt(snapshot: SceneSnapshot): void {
  const latest = attempts[attempts.length - 1];
  const tooSoon = latest && snapshot.createdAt - latest.createdAt < 350;
  if (tooSoon && snapshot.summary !== "Room opened") attempts[attempts.length - 1] = snapshot;
  else attempts.push(snapshot);
  attempts = attempts.slice(-8);
  renderAttempts();
}

function renderAttempts(): void {
  const list = document.querySelector<HTMLElement>("#attempt-list");
  if (!list) return;
  list.innerHTML = "";
  attempts.forEach((attempt, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "attempt-card";
    button.dataset.tooltip = `${attempt.summary} · ${timeLabel(attempt.createdAt)}`;
    button.setAttribute("aria-label", `Restore ${attempt.summary}`);
    button.innerHTML = `<span class="attempt-index">${String(index + 1).padStart(2, "0")}</span><span class="sr-only"><strong>${escapeHtml(attempt.summary)}</strong><small>${timeLabel(attempt.createdAt)}</small></span><i class="ph ph-arrow-u-up-left"></i>`;
    button.addEventListener("click", () => workbench?.restoreAttempt(attempt));
    list.append(button);
  });
  list.scrollLeft = list.scrollWidth;
}

function renderCircuitState(): void {
  const button = document.querySelector<HTMLButtonElement>("#check-circuit");
  if (!button) return;
  button.classList.toggle("is-valid", powered);
  if (activeStudio === "greenhouse") {
    button.innerHTML = powered
      ? '<i class="ph ph-check-circle"></i><span class="sr-only">Climate balanced</span>'
      : '<i class="ph ph-gauge"></i><span class="sr-only">Test system</span>';
    button.dataset.tooltip = powered ? "Climate balanced" : "Test greenhouse system";
  } else {
    button.innerHTML = powered
      ? '<i class="ph ph-check-circle"></i><span class="sr-only">Circuit powered</span>'
      : '<i class="ph ph-lightning"></i><span class="sr-only">Check circuit</span>';
    button.dataset.tooltip = powered ? "Circuit powered" : "Check circuit";
  }
}

function renderEnvironmentState(): void {
  if (activeStudio !== "greenhouse") return;
  const moisture = document.querySelector<HTMLElement>("#metric-moisture");
  const temperature = document.querySelector<HTMLElement>("#metric-temperature");
  const light = document.querySelector<HTMLElement>("#metric-light");
  const flow = document.querySelector<HTMLElement>("#metric-flow");
  const status = document.querySelector<HTMLElement>("#greenhouse-status");
  const irrigation = document.querySelector<HTMLElement>("#irrigation-line");
  const ventilation = document.querySelector<HTMLElement>("#ventilation-line");
  if (moisture) moisture.textContent = `${Math.round(environmentState.moisture)}%`;
  if (temperature) temperature.textContent = `${environmentState.temperature.toFixed(1)}°C`;
  if (light) light.textContent = `${Math.round(environmentState.light)}%`;
  if (flow) flow.textContent = `${environmentState.flow.toFixed(1)} L/m`;
  if (status) {
    status.textContent = environmentState.systemReady ? "Stable" : "Incomplete";
    status.dataset.tooltip = environmentState.systemReady ? "Growing range stable" : "Connect every subsystem";
    status.classList.toggle("is-ready", environmentState.systemReady);
  }
  if (irrigation) {
    irrigation.classList.toggle("is-live", environmentState.irrigation);
    irrigation.dataset.tooltip = `Irrigation ${environmentState.irrigation ? "running" : "offline"}`;
    irrigation.innerHTML = `<i class="ph ${environmentState.irrigation ? "ph-check-circle" : "ph-circle"}"></i><span class="sr-only">Irrigation ${environmentState.irrigation ? "running" : "offline"}</span>`;
  }
  if (ventilation) {
    ventilation.classList.toggle("is-live", environmentState.ventilation);
    ventilation.dataset.tooltip = `Ventilation ${environmentState.ventilation ? "running" : "offline"}`;
    ventilation.innerHTML = `<i class="ph ${environmentState.ventilation ? "ph-check-circle" : "ph-circle"}"></i><span class="sr-only">Ventilation ${environmentState.ventilation ? "running" : "offline"}</span>`;
  }
}

let statusTimer = 0;
function showSceneStatus(message: string, tone: "neutral" | "valid" | "warning"): void {
  const status = document.querySelector<HTMLElement>("#scene-status");
  const copy = document.querySelector<HTMLElement>("#scene-status-copy");
  if (!status || !copy) return;
  copy.textContent = message;
  status.dataset.tone = tone;
  status.classList.add("is-visible");
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => status.classList.remove("is-visible"), 3200);
}

function onKeyboardShortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, [contenteditable='true']")) return;
  if (event.key.toLowerCase() === "r") workbench?.resetSelectedRotation();
  if (event.key.toLowerCase() === "f") workbench?.focusSelected();
  if (event.key === "Escape") document.querySelector<HTMLDialogElement>("#reflection-dialog")?.close();
}

function saveReflection(): void {
  const data = {
    path: document.querySelector<HTMLTextAreaElement>("#reflection-path")?.value ?? "",
    change: document.querySelector<HTMLTextAreaElement>("#reflection-change")?.value ?? "",
    rule: document.querySelector<HTMLTextAreaElement>("#reflection-rule")?.value ?? "",
    room: currentRoomCode,
    savedAt: Date.now(),
  };
  localStorage.setItem(`vm-reflection:${currentRoomCode}`, JSON.stringify(data));
  room?.setActivity("reflecting", "Session reflection");
  room?.recordTrace("reflect", collaborationPhase, activeStudio, {
    detail: "Saved a team reflection",
  });
  showSceneStatus("Reflection saved · thanks for building together", "valid");
}

function leaveRoom(): void {
  disposeWorkspace();
  history.replaceState(null, "", location.pathname);
  renderLobby();
}

function disposeWorkspace(): void {
  cancelAnimationFrame(voiceFrame);
  window.clearTimeout(activityTimer);
  document.removeEventListener("keydown", onKeyboardShortcut);
  workbench?.dispose();
  room?.close();
  workbench = null;
  room = null;
  participants = [];
  attempts = [];
  owners.clear();
  queuedSharedState = null;
  chatMessageIds.clear();
  activityTraceIds.clear();
  activityTraces = [];
  collaborationPhase = "frame";
}

async function initialize(): Promise<void> {
  await loadAuthProfile();
  renderLobby();
}

void initialize();
