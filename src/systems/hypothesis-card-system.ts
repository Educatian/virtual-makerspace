import {
  createSystem,
  eq,
  PanelDocument,
  PanelUI,
  UIKit,
  UIKitDocument,
  type Object3D,
} from "@iwsdk/core";

import { telemetry } from "../telemetry.js";

interface STTResultAlternative {
  transcript: string;
}
interface STTResult {
  isFinal: boolean;
  [index: number]: STTResultAlternative;
}
interface STTEvent {
  resultIndex: number;
  results: ArrayLike<STTResult>;
}
interface STTInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: STTEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type STTConstructor = new () => STTInstance;

interface ComponentLike {
  setProperties(props: Record<string, unknown>): void;
}
function setProps(
  el: UIKit.Component | null,
  props: Record<string, unknown>,
): void {
  if (!el) return;
  (el as unknown as ComponentLike).setProperties(props);
}

const AUTO_DISMISS_MS = 30_000;
const STT_LISTEN_MAX_MS = 8_000;
const TEXT_DISPLAY_MAX_CHARS = 80;

const COLOR_TEXT_PRIMARY = "#e8eef7";
const COLOR_TEXT_MUTED = "#9aa6bd";
const COLOR_ACCENT_ACTION = "#3b82f6";
const COLOR_BORDER_SUBTLE = "#3a4258";
const COLOR_BG_NEAR_BLACK = "#1f2738";
const COLOR_BG_BUTTON_DISABLED = "#1f2738";
const COLOR_TEXT_BUTTON_DISABLED = "#9aa6bd";
const COLOR_TEXT_BUTTON_ENABLED = "#ffffff";

let cardShownThisSession = false;
let cardLockedTerminal = false;

let sttAvailable = false;
let sttPermission: "granted" | "denied" | "unknown" = "unknown";
let sttPermissionRequested = false;
const SpeechRecognitionCtor: STTConstructor | undefined =
  typeof window !== "undefined"
    ? ((window as unknown as {
        SpeechRecognition?: STTConstructor;
        webkitSpeechRecognition?: STTConstructor;
      }).SpeechRecognition ??
        (window as unknown as {
          webkitSpeechRecognition?: STTConstructor;
        }).webkitSpeechRecognition)
    : undefined;
sttAvailable = !!SpeechRecognitionCtor;

async function ensureMicPermission(): Promise<void> {
  if (sttPermissionRequested) return;
  sttPermissionRequested = true;
  if (!sttAvailable) {
    sttPermission = "denied";
    return;
  }
  if (
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    sttPermission = "denied";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    sttPermission = "granted";
  } catch {
    sttPermission = "denied";
  }
}

interface ChipDef {
  id: string;
  value: string;
}

const CHIPS: ChipDef[] = [
  { id: "chip-position", value: "different position" },
  { id: "chip-orientation", value: "different orientation" },
  { id: "chip-other", value: "something else" },
];

type CardState =
  | "dormant"
  | "idle_voice"
  | "idle_chips"
  | "listening"
  | "voice_captured"
  | "chip_selected";

export class HypothesisCardSystem extends createSystem({
  card: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/hypothesis-card.json")],
  },
}) {
  private cardObject: Object3D | null = null;
  private doc: UIKitDocument | null = null;
  private state: CardState = "dormant";
  private dismissAtMs = 0;
  private listeningUntilMs = 0;
  private shownAtMs = 0;
  private triggerEntityId: number | null = null;
  private capturedText: string | null = null;
  private selectedChipValue: string | null = null;
  private recognition: STTInstance | null = null;
  private regrabHandler = (e: Event) => this.onRegrab(e as CustomEvent);
  private taskStartHandler = () => {
    cardShownThisSession = false;
    cardLockedTerminal = false;
    void ensureMicPermission();
  };
  private taskCompleteHandler = () => {
    cardLockedTerminal = true;
    if (this.state !== "dormant") {
      this.recordDismissed("timeout_ignored");
      this.hideCard();
    }
  };

  init() {
    this.queries.card.subscribe("qualify", (entity) => {
      const doc = PanelDocument.data.document[entity.index] as UIKitDocument;
      if (!doc) return;
      this.cardObject = entity.object3D ?? null;
      this.doc = doc;
      if (this.cardObject) this.cardObject.visible = false;
      this.bindHandlers(doc);
      this.applyState("dormant");
    });

    window.addEventListener("vm:regrab_detected", this.regrabHandler);
    window.addEventListener("vm:task_start", this.taskStartHandler);
    window.addEventListener("vm:task_complete", this.taskCompleteHandler);
    this.cleanupFuncs.push(() => {
      window.removeEventListener("vm:regrab_detected", this.regrabHandler);
      window.removeEventListener("vm:task_start", this.taskStartHandler);
      window.removeEventListener("vm:task_complete", this.taskCompleteHandler);
      this.stopRecognition();
    });
  }

  update(): void {
    if (this.state === "dormant") return;
    const now = performance.now();
    if (this.state === "listening" && now >= this.listeningUntilMs) {
      this.stopRecognition();
      if (this.capturedText && this.capturedText.length > 0) {
        this.applyState("voice_captured");
      } else {
        this.applyState("idle_voice");
      }
    }
    if (now >= this.dismissAtMs) {
      this.recordDismissed("timeout_ignored");
      this.hideCard();
    }
  }

  private bindHandlers(doc: UIKitDocument): void {
    const mic = doc.getElementById("mic-button");
    if (mic) {
      (mic as UIKit.Component).addEventListener("click", () => {
        if (this.state === "idle_voice") this.startListening();
        else if (this.state === "listening") this.stopRecognition();
      });
    }
    const useChips = doc.getElementById("use-chips");
    if (useChips) {
      (useChips as UIKit.Component).addEventListener("click", () => {
        if (this.state === "idle_voice") this.applyState("idle_chips");
      });
    }
    const editBtn = doc.getElementById("edit-btn");
    if (editBtn) {
      (editBtn as UIKit.Component).addEventListener("click", () => {
        if (this.state === "voice_captured") {
          this.capturedText = null;
          this.applyState("idle_voice");
        }
      });
    }
    for (const chip of CHIPS) {
      const el = doc.getElementById(chip.id);
      if (!el) continue;
      (el as UIKit.Component).addEventListener("click", () => {
        if (this.state !== "idle_chips" && this.state !== "chip_selected")
          return;
        if (this.selectedChipValue === chip.value) {
          this.selectedChipValue = null;
          this.applyState("idle_chips");
        } else {
          this.selectedChipValue = chip.value;
          this.applyState("chip_selected");
        }
      });
    }
    const submit = doc.getElementById("submit");
    if (submit) {
      (submit as UIKit.Component).addEventListener("click", () => {
        if (this.state === "voice_captured" && this.capturedText) {
          this.recordLogged("voice", this.capturedText);
          this.hideCard();
        } else if (this.state === "chip_selected" && this.selectedChipValue) {
          this.recordLogged("chip", this.selectedChipValue);
          this.hideCard();
        }
      });
    }
    const skip = doc.getElementById("skip");
    if (skip) {
      (skip as UIKit.Component).addEventListener("click", () => {
        if (this.state === "dormant") return;
        this.recordDismissed("skip");
        this.hideCard();
      });
    }
  }

  private onRegrab(e: CustomEvent): void {
    if (cardShownThisSession || cardLockedTerminal) return;
    if (!this.cardObject || !this.doc) return;
    cardShownThisSession = true;
    this.triggerEntityId =
      (e.detail as { entity_id?: number } | null)?.entity_id ?? null;
    this.shownAtMs = performance.now();
    this.dismissAtMs = this.shownAtMs + AUTO_DISMISS_MS;
    this.capturedText = null;
    this.selectedChipValue = null;
    const useVoice = sttAvailable && sttPermission === "granted";
    this.applyState(useVoice ? "idle_voice" : "idle_chips");
    this.cardObject.visible = true;
    telemetry.log("hypothesis_card_shown", {
      entity_id: this.triggerEntityId,
      trigger_reason: "regrab_after_disconnect",
      stt_available: sttAvailable,
      stt_permission: sttPermission,
    });
  }

  private hideCard(): void {
    this.stopRecognition();
    this.state = "dormant";
    if (this.cardObject) this.cardObject.visible = false;
  }

  private startListening(): void {
    if (!sttAvailable || !SpeechRecognitionCtor) {
      this.applyState("idle_chips");
      return;
    }
    try {
      const rec = new SpeechRecognitionCtor();
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = "en-US";
      let finalText = "";
      rec.onresult = (event: STTEvent) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        const display = (finalText + interim).trim();
        if (display.length > 0) this.capturedText = display;
        this.refreshVoiceLabel();
      };
      rec.onerror = () => {
        this.stopRecognition();
        this.applyState("idle_chips");
      };
      rec.onend = () => {
        if (this.state !== "listening") return;
        if (this.capturedText && this.capturedText.length > 0) {
          this.applyState("voice_captured");
        } else {
          this.applyState("idle_voice");
        }
      };
      this.recognition = rec;
      rec.start();
      this.listeningUntilMs = performance.now() + STT_LISTEN_MAX_MS;
      this.applyState("listening");
    } catch {
      this.recognition = null;
      this.applyState("idle_chips");
    }
  }

  private stopRecognition(): void {
    if (!this.recognition) return;
    try {
      this.recognition.stop();
    } catch {
      // noop
    }
    this.recognition = null;
  }

  private applyState(next: CardState): void {
    this.state = next;
    if (!this.doc) return;
    const showVoiceRow = next === "idle_voice" || next === "listening";
    const showCapturedRow = next === "voice_captured";
    const showUseChips = next === "idle_voice";
    const showChipRow = next === "idle_chips" || next === "chip_selected";

    this.setDisplay("voice-row", showVoiceRow);
    this.setDisplay("voice-captured-row", showCapturedRow);
    this.setDisplay("use-chips", showUseChips);
    this.setDisplay("chip-row", showChipRow);

    const mic = this.doc.getElementById("mic-button");
    if (mic) {
      (mic as UIKit.Component).setProperties({
        color: next === "listening" ? COLOR_ACCENT_ACTION : COLOR_TEXT_MUTED,
      });
    }
    this.refreshVoiceLabel();

    for (const chip of CHIPS) {
      const el = this.doc.getElementById(chip.id);
      if (!el) continue;
      const selected =
        next === "chip_selected" && this.selectedChipValue === chip.value;
      (el as UIKit.Component).setProperties({
        borderColor: selected ? COLOR_ACCENT_ACTION : COLOR_BORDER_SUBTLE,
        backgroundColor: selected ? "#2a3550" : COLOR_BG_NEAR_BLACK,
      });
    }

    const submitEnabled =
      next === "voice_captured" || next === "chip_selected";
    const submit = this.doc.getElementById("submit");
    if (submit) {
      (submit as UIKit.Component).setProperties({
        backgroundColor: submitEnabled
          ? COLOR_ACCENT_ACTION
          : COLOR_BG_BUTTON_DISABLED,
        color: submitEnabled
          ? COLOR_TEXT_BUTTON_ENABLED
          : COLOR_TEXT_BUTTON_DISABLED,
      });
    }
  }

  private refreshVoiceLabel(): void {
    if (!this.doc) return;
    const label = this.doc.getElementById("voice-label");
    if (label) {
      let text = "Tap mic to speak";
      if (this.state === "listening") text = "Listening...";
      setProps(label, { text });
    }
    const recognized = this.doc.getElementById("voice-recognized");
    if (recognized) {
      const raw = this.capturedText ?? "";
      const display =
        raw.length > TEXT_DISPLAY_MAX_CHARS
          ? raw.slice(0, TEXT_DISPLAY_MAX_CHARS - 1) + "…"
          : raw;
      setProps(recognized, { text: display });
    }
  }

  private setDisplay(id: string, show: boolean): void {
    if (!this.doc) return;
    const el = this.doc.getElementById(id);
    setProps(el, { display: show ? "flex" : "none" });
  }

  private recordLogged(inputMode: "voice" | "chip", text: string): void {
    const durationMs = Math.round(performance.now() - this.shownAtMs);
    telemetry.log("hypothesis_logged", {
      entity_id: this.triggerEntityId,
      input_mode: inputMode,
      text,
      char_count: text.length,
      duration_ms: durationMs,
    });
  }

  private recordDismissed(reason: "skip" | "timeout_ignored"): void {
    const durationMs = Math.round(performance.now() - this.shownAtMs);
    telemetry.log("hypothesis_card_dismissed", {
      entity_id: this.triggerEntityId,
      reason,
      duration_ms: durationMs,
    });
  }
}
