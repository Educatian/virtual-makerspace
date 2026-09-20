export type Condition = "PF" | "DI";

const VALID: Condition[] = ["PF", "DI"];

function parseCondition(): Condition {
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get("condition") || "").toUpperCase();
  if ((VALID as string[]).includes(raw)) return raw as Condition;
  return "DI";
}

function parseParticipantId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("pid") || "";
}

export const condition: Condition = parseCondition();
export const participantId: string = parseParticipantId();
