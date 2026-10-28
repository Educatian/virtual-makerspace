export type SoundModuleId = "snd-source" | "snd-filter" | "snd-drive" | "snd-speaker";
export type SoundCableId = "snd-cable-a" | "snd-cable-b" | "snd-cable-c";
export type SoundWave = "sine" | "square" | "sawtooth";
export type SoundPropKind = "source" | "filter" | "drive";
export interface SoundJack { index: number; module: SoundModuleId; port: "in" | "out" }
export interface SoundProps { hz?: number; wave?: SoundWave; cutoff?: number; gain?: number }
type Sockets = [number | null, number | null] | null | undefined;

export const SOUND_MODULE_IDS: SoundModuleId[];
export const SOUND_CABLE_IDS: SoundCableId[];
export const SOUND_IDS: string[];
export const SOUND_JACKS: SoundJack[];
export const SOUND_WAVES: SoundWave[];
export const SOUND_BOUNDS: { hz: { min: number; max: number }; cutoff: { min: number; max: number }; gain: { min: number; max: number } };
export const SOUND_DEFAULT_PROPS: { "snd-source": { hz: number; wave: SoundWave }; "snd-filter": { cutoff: number }; "snd-drive": { gain: number } };
export const SOUND_SPEAKER_DEFAULT_ON: boolean;
export const SOUND_MODULE_POSES: Record<SoundModuleId, [number, number, number]>;
export function isSoundId(componentId: string): boolean;
export function isSoundModule(componentId: string): componentId is SoundModuleId;
export function isSoundCable(componentId: string): componentId is SoundCableId;
export function soundPropKind(componentId: string): SoundPropKind | null;
export function sanitizeSoundProps(kind: SoundPropKind | string | null | undefined, raw: unknown): SoundProps | null;
export function sanitizeSoundTransform<T>(componentId: string, raw: Record<string, unknown>, clean: T): T | null;
export function nextCableSockets(previous: { sockets?: Sockets; endpoints?: unknown } | null | undefined, transform: { sockets?: Sockets; endpoints?: unknown; activeEndpoint?: 0 | 1 }): [number | null, number | null];
export function soundJackConflict(componentId: string, sockets: [number | null, number | null] | null, socketsOf: (id: string) => Sockets): { jack: number; cable: string } | null;
