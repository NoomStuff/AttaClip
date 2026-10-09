export type SourceKind = "screen" | "app" | "auto";
export interface CaptureSource {
   id: string;
   name: string;
   kind: "screen" | "app";
   thumbnail: string;
   displayId?: string;
   bounds?: { x: number; y: number; width: number; height: number };
}
export interface GameCandidate {
   id: string;
   name: string;
   executable: string;
   pid: number;
   foreground: boolean;
   fullscreen: boolean;
   arguments?: string;
   gameName?: string;
}
export interface CustomGame {
   name: string;
   executable: string;
}
export interface RecordingCapabilities {
   supported: boolean;
   hardwareEncoders: string[];
   recommended: "low" | "standard";
   message: string;
}
export interface Preferences {
   collection: string;
   clipSeconds: number;
   shortcut: string;
   quality: "low" | "standard" | "high" | "custom";
   customWidth: number;
   customHeight: number;
   customFPS: number;
   customCQ: number;
   allowSoftwareEncoder: boolean;
   sourceKind: SourceKind;
   sourceId: string;
   microphone: boolean;
   microphoneDevice: string;
   captureAudio: boolean;
   captureVolume: number;
   captureMuted: boolean;
   microphoneVolume: number;
   microphoneMuted: boolean;
   desktopFallback: boolean;
   customGames: CustomGame[];
   shareSizeMB: number;
   autoShare: boolean;
   startWithOS: boolean;
   autoRecord: boolean;
   notifications: "everywhere" | "outside-fullscreen" | "off";
   sound: boolean;
   avoidOverlap: boolean;
   folderLayout: "flat" | "application";
   filenamePreset: "source-date" | "date-source" | "custom";
   filenameTemplate: string;
   setupComplete: boolean;
}
export interface AudioTrack {
   index: number;
   title: string;
   codec: string;
}
export interface Shareable {
   id: string;
   path: string;
   relativePath: string;
   size: number;
   targetMB: number;
   createdAt: number;
}
export interface Clip {
   id: string;
   path: string;
   relativePath: string;
   name: string;
   source: string;
   size: number;
   duration: number;
   width: number;
   height: number;
   createdAt: number;
   thumbnail: string;
   playbackUrl: string;
   tracks: AudioTrack[];
   categories: string[];
   shareables: Shareable[];
}
export interface Category {
   id: string;
   name: string;
   color: string;
}
export interface Job {
   id: string;
   clipId: string;
   kind: "shareable" | "save";
   state: "queued" | "running" | "complete" | "failed" | "cancelled";
   progress: number;
   message: string;
}
export interface RecorderState {
   state: "stopped" | "starting" | "recording" | "waiting" | "error";
   startedAt: number | null;
   availableSeconds: number;
   message: string;
   backend: string;
   supported: boolean;
   pendingSaves: number;
   sourceId?: string;
   sourceName?: string;
   sourceKind?: "screen" | "app" | "waiting";
}
export interface UpdateState {
   state: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
   version: string;
   progress: number;
   message: string;
}
export interface AppState {
   windowVisible: boolean;
   preferences: Preferences;
   clips: Clip[];
   categories: Category[];
   jobs: Job[];
   recorder: RecorderState;
   update: UpdateState;
   version: string;
   platform: string;
}
export interface AppEvent {
   type: "state" | "notice" | "clip-action" | "audio-levels" | "visibility";
   state?: AppState;
   message?: string;
   error?: boolean;
   levels?: { capture: number; microphone: number };
   visible?: boolean;
}
export interface DesktopAPI {
   state(): Promise<AppState>;
   sources(): Promise<CaptureSource[]>;
   games(): Promise<GameCandidate[]>;
   recordingCapabilities(): Promise<RecordingCapabilities>;
   previewSource(sourceId: string | null): Promise<void>;
   audioDevices(): Promise<{ id: string; name: string }[]>;
   savePreferences(value: Preferences): Promise<AppState>;
   chooseFolder(): Promise<string | null>;
   startRecording(): Promise<void>;
   stopRecording(): Promise<void>;
   saveClip(): Promise<void>;
   createShareable(clipId: string, targetMB?: number): Promise<void>;
   cancelJob(id: string): Promise<void>;
   renameClip(id: string, name: string): Promise<void>;
   deleteClip(id: string, shareableId?: string): Promise<void>;
   category(
      action: "create" | "delete" | "assign",
      value: { id?: string; name?: string; color?: string; clipId?: string; categoryIds?: string[] }
   ): Promise<void>;
   reveal(path: string): Promise<void>;
   openInAttaCut(id: string): Promise<void>;
   dragFile(path: string): void;
   playback(path: string, track?: number): Promise<string>;
   refresh(): Promise<void>;
   checkUpdate(): Promise<void>;
   installUpdate(): Promise<void>;
   window(action: "minimize" | "maximize" | "close"): void;
   exit(): Promise<void>;
   onEvent(listener: (event: AppEvent) => void): () => void;
}
