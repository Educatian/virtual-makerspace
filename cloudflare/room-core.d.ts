export interface RoomParticipant {
  id: string;
  name: string;
}
export interface RoomEntry {
  transform: Record<string, unknown>;
  rev: number;
}
export interface HandleResult {
  sender: Array<Record<string, unknown>>;
  others: Array<Record<string, unknown>>;
  persist: { state?: Array<[string, RoomEntry]>; program?: Record<string, unknown> };
}
export class RoomCore {
  constructor(initial?: { entries?: Array<[string, RoomEntry]>; programRev?: number; program?: { program: unknown[]; running: boolean } | null });
  claims: Map<string, { participantId: string; participantName: string }>;
  state: Map<string, RoomEntry>;
  programRev: number;
  rev(componentId: string): number;
  conflict(resourceId: string, participantId: string): { resourceId: string; participantId: string; participantName: string } | null;
  join(): Array<Record<string, unknown>>;
  handle(participant: RoomParticipant, message: Record<string, unknown>, options?: { maxClaims?: number }): HandleResult;
  leave(participant: RoomParticipant): Array<Record<string, unknown>>;
  reset(): void;
}
