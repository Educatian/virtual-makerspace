import { telemetry } from "../telemetry.js";
import {
  PROBE_ITEMS,
  type ProbeItem,
  type ReflectionPrompt,
} from "./items.js";

type Phase = "pre" | "post";

function makeFieldset(legendText: string): HTMLFieldSetElement {
  const fs = document.createElement("fieldset");
  Object.assign(fs.style, {
    border: "1px solid #2a3245",
    borderRadius: "8px",
    padding: "14px 18px",
    margin: "0 0 14px",
  });
  const lg = document.createElement("legend");
  lg.textContent = legendText;
  Object.assign(lg.style, {
    padding: "0 8px",
    fontSize: "15px",
    fontWeight: "500",
  });
  fs.appendChild(lg);
  return fs;
}

function buildOverlay(
  phase: Phase,
  items: ProbeItem[],
  reflections: ReflectionPrompt[],
  onSubmit: (
    responses: Record<string, number>,
    reflectionTexts: Record<string, string>,
  ) => void,
): HTMLDivElement {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(10, 14, 24, 0.96)",
    color: "#e8eef7",
    zIndex: "10000",
    overflowY: "auto",
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    padding: "32px 16px",
  });

  const card = document.createElement("div");
  Object.assign(card.style, {
    maxWidth: "720px",
    margin: "0 auto",
    background: "#141a26",
    border: "1px solid #2a3245",
    borderRadius: "12px",
    padding: "28px 32px",
  });
  overlay.appendChild(card);

  const title = document.createElement("h2");
  title.textContent =
    phase === "pre" ? "Before you begin" : "After your activity";
  Object.assign(title.style, {
    margin: "0 0 8px",
    fontSize: "20px",
    fontWeight: "600",
  });
  card.appendChild(title);

  const sub = document.createElement("p");
  sub.textContent =
    phase === "pre"
      ? "Please answer these short questions about circuits. Best guess is fine — there is no time limit."
      : "A few short questions about what you just did.";
  Object.assign(sub.style, {
    margin: "0 0 20px",
    color: "#9aa6bd",
    fontSize: "14px",
  });
  card.appendChild(sub);

  const responses: Record<string, number> = {};
  const reflectionTexts: Record<string, string> = {};

  for (const item of items) {
    const fs = makeFieldset(item.stem);

    item.options.forEach((opt, idx) => {
      const row = document.createElement("label");
      Object.assign(row.style, {
        display: "block",
        padding: "6px 4px",
        cursor: "pointer",
        fontSize: "14px",
      });
      const input = document.createElement("input");
      input.type = "radio";
      input.name = item.id;
      input.value = String(idx);
      input.style.marginRight = "10px";
      input.addEventListener("change", () => {
        responses[item.id] = idx;
      });
      row.appendChild(input);
      row.appendChild(document.createTextNode(opt));
      fs.appendChild(row);
    });

    card.appendChild(fs);
  }

  for (const refl of reflections) {
    const fs = makeFieldset(refl.prompt);

    const ta = document.createElement("textarea");
    ta.rows = 4;
    if (refl.placeholder) ta.placeholder = refl.placeholder;
    Object.assign(ta.style, {
      width: "100%",
      boxSizing: "border-box",
      background: "#0d1320",
      color: "#e8eef7",
      border: "1px solid #2a3245",
      borderRadius: "6px",
      padding: "10px 12px",
      fontSize: "14px",
      fontFamily: "inherit",
      resize: "vertical",
    });
    ta.addEventListener("input", () => {
      reflectionTexts[refl.id] = ta.value;
    });
    fs.appendChild(ta);
    card.appendChild(fs);
  }

  const err = document.createElement("div");
  Object.assign(err.style, {
    color: "#ff7b7b",
    fontSize: "13px",
    minHeight: "18px",
    margin: "4px 0 8px",
  });
  card.appendChild(err);

  const btn = document.createElement("button");
  btn.textContent = "Submit";
  Object.assign(btn.style, {
    background: "#3b82f6",
    color: "white",
    border: "none",
    borderRadius: "8px",
    padding: "10px 22px",
    fontSize: "15px",
    cursor: "pointer",
  });
  btn.addEventListener("click", () => {
    const missing = items.filter((it) => !(it.id in responses));
    if (missing.length > 0) {
      err.textContent = `Please answer all ${items.length} questions (${missing.length} remaining).`;
      return;
    }
    onSubmit(responses, reflectionTexts);
  });
  card.appendChild(btn);

  return overlay;
}

function runProbe(
  phase: Phase,
  items: ProbeItem[],
  reflections: ReflectionPrompt[],
): Promise<void> {
  return new Promise((resolve) => {
    const startMs = performance.now();
    telemetry.log("probe_start", {
      phase,
      item_count: items.length,
      reflection_count: reflections.length,
    });
    const overlay = buildOverlay(
      phase,
      items,
      reflections,
      (responses, reflectionTexts) => {
        const durationMs = Math.round(performance.now() - startMs);
        let correctCount = 0;
        let scorable = 0;
        for (const item of items) {
          const chosen = responses[item.id];
          const isCorrect = item.correct >= 0 && chosen === item.correct;
          if (item.correct >= 0) {
            scorable += 1;
            if (isCorrect) correctCount += 1;
          }
          telemetry.log("probe_response", {
            phase,
            item_id: item.id,
            chosen,
            correct_index: item.correct,
            is_correct: item.correct >= 0 ? isCorrect : null,
          });
        }
        for (const refl of reflections) {
          const text = (reflectionTexts[refl.id] ?? "").trim();
          telemetry.log("reflection_response", {
            phase,
            item_id: refl.id,
            text,
            char_count: text.length,
          });
        }
        telemetry.log("probe_complete", {
          phase,
          duration_ms: durationMs,
          correct_count: correctCount,
          scorable_count: scorable,
        });
        overlay.remove();
        resolve();
      },
    );
    document.body.appendChild(overlay);
  });
}

function screenshotMode(): boolean {
  return new URLSearchParams(window.location.search).get("screenshot") === "1";
}

export function runPreProbe(): Promise<void> {
  if (screenshotMode()) return Promise.resolve();
  return runProbe("pre", PROBE_ITEMS.pre, []);
}

export function runPostProbe(): Promise<void> {
  if (screenshotMode()) return Promise.resolve();
  return runProbe("post", PROBE_ITEMS.post, PROBE_ITEMS.reflection);
}
