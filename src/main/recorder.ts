import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stoppedRecorder } from "../shared/defaults";
import type { CaptureSource, Preferences, RecorderState } from "../shared/types";

interface RecorderOptions {
   nativePath?: string;
   onState: (state: RecorderState) => void;
   onSaved: (file: string, source: string, requestId: string, capture: { previousFootage: boolean; secondsSinceCapture: number }) => void | Promise<void>;
   onError: (message: string) => void;
   onAudioLevels?: (levels: { capture: number; microphone: number }) => void;
}
interface NativeMessage {
   event: string;
   id?: string;
   message?: string;
   path?: string;
   source?: string;
   requestId?: string;
   active?: boolean;
   availableSeconds?: number;
   pendingSaves?: number;
   windows?: Array<{ name: string; value: string }>;
   fullscreen?: boolean;
   waiting?: boolean;
   action?: string;
   devices?: Array<{ id: string; name: string }>;
   capture?: number;
   microphone?: number;
   previousFootage?: boolean;
   secondsSinceCapture?: number;
}

export class Recorder {
   private readonly options: RecorderOptions;
   private process: ChildProcessWithoutNullStreams | null = null;
   private timer: ReturnType<typeof setInterval> | null = null;
   private current: RecorderState = { ...stoppedRecorder };
   private windows: Array<{ name: string; value: string }> = [];
   private ready: Promise<void> | null = null;
   private readyResolve: (() => void) | null = null;
   private readyReject: ((reason: Error) => void) | null = null;
   private source = "Screen";
   private requests = new Set<string>();
   private fullscreen = false;
   private windowsResolve: (() => void) | null = null;
   private devicesResolve: ((devices: Array<{ id: string; name: string }>) => void) | null = null;
   private commands = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
   constructor(options: RecorderOptions) {
      this.options = options;
      this.current.supported =
         (process.platform === "win32" || process.platform === "linux") &&
         (existsSync(this.executable) || (!options.nativePath && existsSync(this.developmentExecutable)));
      if (!this.current.supported) this.current.message = "The native recorder is not available in this build";
   }
   private get executable(): string {
      const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      return (
         this.options.nativePath ??
         path.join(resources ?? process.cwd(), "recorder", process.platform === "win32" ? "attaclip-recorder.exe" : "attaclip-recorder")
      );
   }
   private get developmentExecutable(): string {
      return path.join(process.cwd(), "resources", "recorder", process.platform === "win32" ? "attaclip-recorder.exe" : "attaclip-recorder");
   }
   get status(): RecorderState {
      return { ...this.current };
   }
   async foregroundFullscreen(): Promise<boolean> {
      if (this.process) this.send({ action: "status" });
      return this.fullscreen;
   }
   async audioDevices(): Promise<Array<{ id: string; name: string }>> {
      if (!this.current.supported) return [];
      await this.initialize();
      return new Promise((resolve) => {
         const timeout = setTimeout(() => {
            this.devicesResolve = null;
            resolve([]);
         }, 3000);
         this.devicesResolve = (devices) => {
            clearTimeout(timeout);
            resolve(devices);
         };
         this.send({ action: "audio-devices" });
      });
   }
   private update(value: Partial<RecorderState>): void {
      this.current = { ...this.current, ...value };
      this.options.onState(this.status);
   }
   private error(message: string): void {
      this.options.onError(message);
   }
   private send(value: Record<string, unknown>): void {
      if (!this.process?.stdin.writable) throw new Error("The recording helper is not running");
      this.process.stdin.write(`${JSON.stringify(value)}\n`);
   }
   private command(value: Record<string, unknown>): Promise<void> {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
         const timeout = setTimeout(() => {
            this.commands.delete(id);
            reject(new Error("The recording helper did not finish the requested action"));
         }, 20_000);
         this.commands.set(id, { resolve, reject, timeout });
         try {
            this.send({ ...value, id });
         } catch (error) {
            clearTimeout(timeout);
            this.commands.delete(id);
            reject(error instanceof Error ? error : new Error("The recording action failed"));
         }
      });
   }
   private async initialize(): Promise<void> {
      if (this.ready) return this.ready;
      let executable = this.executable;
      // Unpackaged development uses the same staged runtime as packaged builds.
      if (!existsSync(executable) && !this.options.nativePath) executable = this.developmentExecutable;
      if ((process.platform !== "win32" && process.platform !== "linux") || !existsSync(executable))
         throw new Error("Native recording is not available on this platform yet");
      this.ready = new Promise<void>((resolve, reject) => {
         this.readyResolve = resolve;
         this.readyReject = reject;
      });
      const root = path.dirname(executable);
      this.process = spawn(executable, [root], {
         cwd: root,
         windowsHide: true,
         stdio: "pipe",
         env: {
            ...process.env,
            ...(process.platform === "linux" ? { LD_LIBRARY_PATH: [path.join(root, "lib"), process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":") } : {}),
         },
      });
      this.process.stdin.on("error", (error: Error) => {
         this.readyReject?.(error);
         for (const command of this.commands.values()) {
            clearTimeout(command.timeout);
            command.reject(new Error("The recording helper connection closed"));
         }
         this.commands.clear();
         this.error("The recording helper connection closed");
      });
      createInterface({ input: this.process.stdout }).on("line", (line: string) => {
         try {
            const value: unknown = JSON.parse(line);
            if (value && typeof value === "object" && "event" in value && typeof value.event === "string") this.message(value as NativeMessage);
         } catch {
            this.error("The recording helper returned an unreadable response");
         }
      });
      // Diagnostic text remains local and is never forwarded as user-facing errors.
      this.process.stderr.on("data", () => undefined);
      this.process.on("error", (error) => {
         this.readyReject?.(error);
         this.error(error.message);
      });
      this.process.on("exit", (code) => {
         this.readyReject?.(new Error("The recording helper exited before becoming ready"));
         this.process = null;
         this.ready = null;
         if (this.timer) clearInterval(this.timer);
         this.timer = null;
         if (this.current.state !== "stopped" || this.requests.size) this.error(`Recording stopped unexpectedly${code ? ` with exit code ${code}` : ""}`);
         this.requests.clear();
         for (const command of this.commands.values()) {
            clearTimeout(command.timeout);
            command.reject(new Error("The recording helper exited during this action"));
         }
         this.commands.clear();
         this.update({ state: "stopped", availableSeconds: 0, startedAt: null, pendingSaves: 0 });
      });
      const timeout = setTimeout(() => {
         this.readyReject?.(new Error("The recording helper took too long to start"));
         this.process?.kill();
      }, 20_000);
      try {
         await this.ready;
      } finally {
         clearTimeout(timeout);
      }
      await this.refreshWindows();
      this.timer = setInterval(() => {
         if (this.process) this.send({ action: "status" });
      }, 1000);
   }
   private message(value: NativeMessage): void {
      if (value.id && (value.event === "response" || value.event === "error")) {
         const command = this.commands.get(value.id);
         if (command) {
            clearTimeout(command.timeout);
            this.commands.delete(value.id);
            if (value.event === "error") command.reject(new Error(value.message ?? "Recording action failed"));
            else command.resolve();
         }
      }
      if (value.event === "ready") {
         this.current.supported = true;
         this.readyResolve?.();
         this.readyResolve = null;
         this.readyReject = null;
      }
      if (value.event === "windows" && Array.isArray(value.windows)) {
         this.windows = value.windows;
         this.windowsResolve?.();
         this.windowsResolve = null;
      }
      if (value.event === "audio-devices" && Array.isArray(value.devices)) {
         this.devicesResolve?.(value.devices.filter((device) => typeof device.id === "string" && typeof device.name === "string"));
         this.devicesResolve = null;
      }
      if (value.event === "audio-levels")
         this.options.onAudioLevels?.({
            capture: Number.isFinite(value.capture) ? Math.max(0, Math.min(1, value.capture!)) : 0,
            microphone: Number.isFinite(value.microphone) ? Math.max(0, Math.min(1, value.microphone!)) : 0,
         });
      if (value.event === "recording") this.update({ state: "recording", startedAt: Date.now(), availableSeconds: 0, message: "", supported: true });
      if (value.event === "stopped") this.update({ state: "stopped", startedAt: null, availableSeconds: 0, message: "" });
      if (value.event === "status") {
         this.fullscreen = value.fullscreen === true;
         this.update({
            ...(value.active
               ? { state: value.waiting ? ("waiting" as const) : ("recording" as const), message: value.waiting ? "Waiting for application" : "" }
               : {}),
            availableSeconds: Number.isFinite(value.availableSeconds) ? value.availableSeconds! : 0,
            pendingSaves: this.requests.size,
         });
      }
      if (value.event === "saved" && value.path) {
         Promise.resolve(
            this.options.onSaved(value.path, value.source ?? this.source, value.requestId ?? "", {
               previousFootage: value.previousFootage ?? false,
               secondsSinceCapture: value.secondsSinceCapture ?? 0,
            })
         )
            .catch((error: unknown) => this.error(error instanceof Error ? error.message : "The saved clip could not be added to the library"))
            .finally(() => {
               if (value.requestId) this.requests.delete(value.requestId);
               this.update({ pendingSaves: this.requests.size });
            });
      }
      if (value.event === "error") {
         if (value.requestId) this.requests.delete(value.requestId);
         else if (this.current.state === "starting") this.update({ state: "error", startedAt: null, message: value.message ?? "Recording could not start" });
         this.update({ pendingSaves: this.requests.size });
         this.error(value.message ?? "Recording failed");
      }
      if (value.event === "fatal") {
         this.update({ state: "error", message: value.message ?? "Recording stopped unexpectedly" });
         this.error(this.current.message);
      }
   }
   private async refreshWindows(): Promise<void> {
      await new Promise<void>((resolve) => {
         const timeout = setTimeout(() => {
            this.windowsResolve = null;
            resolve();
         }, 2000);
         this.windowsResolve = () => {
            clearTimeout(timeout);
            resolve();
         };
         this.send({ action: "windows" });
      });
   }
   private configuration(preferences: Preferences, sources: CaptureSource[]): Record<string, unknown> {
      const selected =
         sources.find((s) => s.id === preferences.sourceId && s.kind === preferences.sourceKind) ??
         (!preferences.sourceId && preferences.sourceKind === "screen" ? sources.find((s) => s.kind === "screen") : undefined);
      if (preferences.sourceKind === "auto") throw new Error("Automatic game detection is not available yet. Choose a screen or application");
      if (!selected) throw new Error("The selected capture source is unavailable");
      this.source = selected.name;
      const screenIndex = sources.filter((s) => s.kind === "screen").findIndex((s) => s.id === selected.id);
      // Match OBS's available window list rather than inventing an executable identity.
      const window = this.windows.find((w) => w.value.split(":")[0] === selected.name || w.name.endsWith(`: ${selected.name}`));
      if (preferences.sourceKind === "app" && !selected.id.startsWith("window:"))
         throw new Error("This application does not have a supported capture identity");
      return { ...preferences, sourceName: selected.name, screenIndex: Math.max(0, screenIndex), bounds: selected.bounds, window: window?.value ?? "" };
   }
   async start(preferences: Preferences, sources: CaptureSource[] = []): Promise<void> {
      this.update({ state: "starting", message: "Starting recording" });
      try {
         await this.initialize();
         await this.command({ action: "start", ...this.configuration(preferences, sources) });
      } catch (error) {
         this.update({ state: "error", message: error instanceof Error ? error.message : "Recording could not start" });
         throw error;
      }
   }
   async stop(): Promise<void> {
      if (this.process) await this.command({ action: "stop" });
   }
   async setAudio(value: { source: "capture" | "microphone"; volume: number; muted: boolean }): Promise<void> {
      if (!Number.isFinite(value.volume) || value.volume < 0 || value.volume > 2) throw new Error("Audio volume must be between 0 and 200 percent");
      if (this.process) await this.command({ action: "audio", ...value });
   }
   async switchSource(preferences: Preferences, sources: CaptureSource[] = []): Promise<void> {
      if (this.process) {
         await this.refreshWindows();
         await this.command({ action: "source", ...this.configuration(preferences, sources) });
      }
   }
   async save(file?: string, requestedAt = Date.now()): Promise<void> {
      if (this.current.state !== "recording" && this.current.state !== "waiting") throw new Error("Start recording before saving a clip");
      if (!file) throw new Error("A destination path is required for the clip");
      const requestId = randomUUID();
      this.requests.add(requestId);
      this.update({ pendingSaves: this.requests.size });
      await this.command({ action: "save", path: file, requestId, requestedAt, requestAgeMs: Math.max(0, Date.now() - requestedAt) });
   }
   async close(options: { cancel?: boolean } = {}): Promise<void> {
      if (!this.process) return;
      const child = this.process;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      if (options.cancel) {
         this.current.state = "stopped";
         child.kill();
         await exited;
         return;
      }
      this.send({ action: "stop" });
      while (this.requests.size && this.process) await new Promise<void>((resolve) => setTimeout(resolve, 100));
      if (this.process) this.send({ action: "exit" });
      await exited;
   }
}
