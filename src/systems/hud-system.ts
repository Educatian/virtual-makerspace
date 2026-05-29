import {
  createSystem,
  eq,
  PanelDocument,
  PanelUI,
  UIKit,
  UIKitDocument,
  type Entity,
} from "@iwsdk/core";

import {
  CircuitNode,
  LedState,
  PowerSource,
  WireEnds,
} from "../components/circuit.js";
import { Snappable } from "../components/snap.js";
import { telemetry } from "../telemetry.js";

interface Step {
  text: string;
  check: (sys: HudSystem) => boolean;
}

function isSnappedToSockets(
  entities: Iterable<Entity>,
  sa: number,
  sb: number,
): boolean {
  for (const e of entities) {
    const a = e.getValue(Snappable, "leadASocket")!;
    const b = e.getValue(Snappable, "leadBSocket")!;
    if ((a === sa && b === sb) || (a === sb && b === sa)) return true;
  }
  return false;
}

export class HudSystem extends createSystem({
  hud: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/hud.json")],
  },
  batteries: { required: [Snappable, CircuitNode, PowerSource] },
  leds: { required: [Snappable, CircuitNode, LedState] },
  wires: { required: [Snappable, WireEnds] },
}) {
  // Step ownership for CPS jigsaw:
  //   A owns steps 0,1 (battery + medium wire)
  //   B owns steps 2,3 (LED + short wire)
  private readonly stepOwners = ["A", "A", "B", "B"];

  private buildSteps(): Step[] {
    const collab = telemetry.mode === "collab";
    const role = telemetry.role;
    const prefix = (i: number): string => {
      if (!collab) return "";
      return this.stepOwners[i] === role ? "(YOU) " : "(PARTNER) ";
    };
    return [
      {
        text: `1. ${prefix(0)}Plug the battery (black) into +rail and col 4`,
        check: (s) => isSnappedToSockets(s.queries.batteries.entities, 4, 20),
      },
      {
        text: `2. ${prefix(1)}Use the blue medium wire from col 4 to col 9`,
        check: (s) => isSnappedToSockets(s.queries.wires.entities, 20, 25),
      },
      {
        text: `3. ${prefix(2)}Plug the red LED between col 9 and col 10`,
        check: (s) => isSnappedToSockets(s.queries.leds.entities, 25, 26),
      },
      {
        text: `4. ${prefix(3)}Use the short red wire from col 10 back to +rail`,
        check: (s) => isSnappedToSockets(s.queries.wires.entities, 26, 10),
      },
    ];
  }

  private steps: Step[] = this.buildSteps();

  private currentStepIdx = -1;
  private stepEl: UIKit.Text | null = null;
  private progressEl: UIKit.Text | null = null;

  init() {
    this.queries.hud.subscribe("qualify", (entity) => {
      const doc = PanelDocument.data.document[entity.index] as UIKitDocument;
      if (!doc) return;
      this.stepEl = doc.getElementById("step") as UIKit.Text;
      this.progressEl = doc.getElementById("progress") as UIKit.Text;
    });
  }

  update(): void {
    if (!this.stepEl || !this.progressEl) return;
    const newStep = this.findCurrentStep();
    if (newStep !== this.currentStepIdx) {
      const total = this.steps.length;
      this.currentStepIdx = newStep;
      const roleTag =
        telemetry.mode === "collab" ? ` · Role ${telemetry.role}` : "";
      if (newStep >= total) {
        this.stepEl.setProperties({
          text: "Circuit complete! Is the LED lit?",
        });
        this.progressEl.setProperties({
          text: `Step ${total} / ${total}${roleTag}`,
        });
      } else {
        this.stepEl.setProperties({ text: this.steps[newStep].text });
        this.progressEl.setProperties({
          text: `Step ${newStep + 1} / ${total}${roleTag}`,
        });
      }
      telemetry.log("step_advance", {
        step: newStep,
        total,
        completed: newStep >= total,
      });
    }
  }

  private findCurrentStep(): number {
    for (let i = 0; i < this.steps.length; i++) {
      if (!this.steps[i].check(this)) return i;
    }
    return this.steps.length;
  }
}
