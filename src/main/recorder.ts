import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stoppedRecorder } from "../shared/defaults";
import type { CaptureSource, CustomGame, GameCandidate, Preferences, RecorderState, RecordingCapabilities } from "../shared/types";
import { GameCatalog, selectGame } from "./games";

interface RecorderOptions {
   nativePath?: string;
   gameCatalogPath?: string;
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
   candidates?: GameCandidate[];
   sourceId?: string;
   sourceKind?: "screen" | "app" | "waiting";
   encoders?: string[];
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
   private readonly catalog: GameCatalog;
   private candidatesPending: Promise<GameCandidate[]> | null = null;
   private candidatesResolve: ((items: GameCandidate[]) => void) | null = null;
   private autoPreferences: Preferences | null = null;
   private autoSources: CaptureSource[] = [];
   private autoKey = "";
   private autoBusy = false;
   private autoGeneration = 0;
   private focused = new Map<string, number>();
   private encoders: string[] = [];
   constructor(options: RecorderOptions) {
      this.options = options;
      this.catalog = new GameCatalog(options.gameCatalogPath ?? path.join(process.cwd(), ".cache", "game-catalog.json"));
      this.current.supported =
         (process.platform === "win32" || process.platform === "linux" || process.platform === "darwin") &&
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
   updatePreferences(preferences: Preferences): void {
      if (this.autoPreferences && preferences.sourceKind === "auto") this.autoPreferences = preferences;
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
   async capabilities(): Promise<RecordingCapabilities> {
      if (!this.current.supported)
         return { supported: false, hardwareEncoders: [], recommended: "standard", message: "The recorder is missing from this build." };
      try {
         await this.initialize();
         const hardwareEncoders = [...this.encoders];
         return {
            supported: true,
            hardwareEncoders,
            recommended: hardwareEncoders.length ? "standard" : "low",
            message: hardwareEncoders.length ? "" : "No supported hardware encoder was found. Software encoding uses your CPU.",
         };
      } catch (failure) {
         return {
            supported: false,
            hardwareEncoders: [],
            recommended: "standard",
            message: failure instanceof Error ? failure.message : "The recorder could not initialize.",
         };
      }
   }
   async games(additions: CustomGame[] = []): Promise<GameCandidate[]> {
      if (!this.current.supported) return [];
      await this.initialize();
      await this.catalog.load();
      void this.catalog.refresh();
      const candidates = (await this.candidates()).filter((candidate) => candidate.pid !== process.pid);
      const games = this.catalog.match(candidates, additions);
      return candidates.map((candidate) => {
         const gameName = games.find((game) => game.id === candidate.id)?.gameName;
         return { ...candidate, ...(gameName ? { gameName } : {}) };
      });
   }
   private candidates(): Promise<GameCandidate[]> {
      if (this.candidatesPending) return this.candidatesPending;
      this.candidatesPending = new Promise<GameCandidate[]>((resolve) => {
         const timeout = setTimeout(() => {
            this.candidatesResolve = null;
            resolve([]);
         }, 3000);
         this.candidatesResolve = (items) => {
            clearTimeout(timeout);
            resolve(items);
         };
         this.send({ action: "candidates" });
      }).finally(() => {
         this.candidatesPending = null;
      });
      return this.candidatesPending;
   }
   private async autoConfiguration(preferences: Preferences, sources: CaptureSource[]): Promise<Record<string, unknown>> {
      await this.catalog.load();
      void this.catalog.refresh();
      const candidates = (await this.candidates()).filter((candidate) => candidate.pid !== process.pid);
      const games = this.catalog.match(candidates, preferences.customGames);
      for (const game of games) if (game.foreground) this.focused.set(game.id, Date.now());
      const selected = selectGame(games, this.current.sourceKind === "app" ? (this.current.sourceId ?? null) : null, this.focused);
      if (selected)
         return { ...preferences, resolvedKind: "app", sourceId: selected.id, sourceName: selected.gameName, pid: selected.pid, preferGameCapture: true };
      if (preferences.desktopFallback) {
         const screen =
            sources.find((item) => item.kind === "screen" && item.id === preferences.sourceId) ??
            (!preferences.sourceId ? sources.find((item) => item.kind === "screen") : undefined);
         if (screen)
            return {
               ...preferences,
               resolvedKind: "screen",
               sourceId: screen.id,
               sourceName: screen.name,
               bounds: screen.bounds,
               displayId: screen.displayId,
               screenIndex: sources.filter((item) => item.kind === "screen").findIndex((item) => item.id === screen.id),
            };
      }
      return { ...preferences, resolvedKind: "waiting", sourceId: "", sourceName: "Waiting for game" };
   }
   private async followGame(): Promise<void> {
      if (this.autoBusy || !this.autoPreferences || !["recording", "waiting"].includes(this.current.state)) return;
      const generation = this.autoGeneration;
      this.autoBusy = true;
      try {
         const configuration = await this.autoConfiguration(this.autoPreferences, this.autoSources);
         if (generation !== this.autoGeneration) return;
         const key = this.configurationKey(configuration);
         if (key !== this.autoKey) {
            await this.command({ action: "source", ...configuration });
            if (generation === this.autoGeneration) this.autoKey = key;
         }
      } catch (error) {
         this.update({ state: "waiting", message: error instanceof Error ? error.message : "Waiting for game" });
      } finally {
         this.autoBusy = false;
      }
   }
   private configurationKey(configuration: Record<string, unknown>): string {
      return `${configuration["resolvedKind"]}:${configuration["sourceId"]}:${configuration["pid"] ?? ""}`;
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
      if ((process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin") || !existsSync(executable))
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
         this.autoPreferences = null;
         this.autoGeneration++;
         this.candidatesResolve?.([]);
         this.candidatesResolve = null;
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
         void this.followGame();
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
         this.encoders = Array.isArray(value.encoders) ? value.encoders.filter((value) => typeof value === "string" && value.length < 200) : [];
         this.readyResolve?.();
         this.readyResolve = null;
         this.readyReject = null;
      }
      if (value.event === "windows" && Array.isArray(value.windows)) {
         this.windows = value.windows;
         this.windowsResolve?.();
         this.windowsResolve = null;
      }
      const candidates: unknown = value.candidates ?? value.windows;
      if (value.event === "candidates" && Array.isArray(candidates)) {
         this.candidatesResolve?.(
            candidates.filter(
               (item: unknown): item is GameCandidate =>
                  !!item &&
                  typeof item === "object" &&
                  "id" in item &&
                  typeof item.id === "string" &&
                  "name" in item &&
                  typeof item.name === "string" &&
                  "executable" in item &&
                  typeof item.executable === "string" &&
                  "pid" in item &&
                  Number.isSafeInteger(item.pid) &&
                  "foreground" in item &&
                  typeof item.foreground === "boolean" &&
                  "fullscreen" in item &&
                  typeof item.fullscreen === "boolean"
            )
         );
         this.candidatesResolve = null;
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
               ? {
                    state: value.waiting ? ("waiting" as const) : ("recording" as const),
                    message: value.waiting
                       ? value.message || (this.autoPreferences ? "Waiting for game" : "Waiting for application")
                       : value.sourceKind === "screen" && this.autoPreferences
                         ? "Recording screen fallback"
                         : "",
                 }
               : {}),
            availableSeconds: Number.isFinite(value.availableSeconds) ? value.availableSeconds! : 0,
            pendingSaves: this.requests.size,
            ...(value.sourceId !== undefined ? { sourceId: value.sourceId } : {}),
            ...(value.source !== undefined ? { sourceName: value.source } : {}),
            ...(value.sourceKind !== undefined ? { sourceKind: value.sourceKind } : {}),
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
   private async configuration(preferences: Preferences, sources: CaptureSource[]): Promise<Record<string, unknown>> {
      if (preferences.sourceKind === "auto") return this.autoConfiguration(preferences, sources);
      const selected =
         sources.find((s) => s.id === preferences.sourceId && s.kind === preferences.sourceKind) ??
         (!preferences.sourceId && preferences.sourceKind === "screen" ? sources.find((s) => s.kind === "screen") : undefined);
      if (!selected) throw new Error("The selected capture source is unavailable");
      this.source = selected.name;
      const screenIndex = sources.filter((s) => s.kind === "screen").findIndex((s) => s.id === selected.id);
      // Match OBS's available window list rather than inventing an executable identity.
      const window = this.windows.find((w) => w.value.split(":")[0] === selected.name || w.name.endsWith(`: ${selected.name}`));
      if (preferences.sourceKind === "app" && !selected.id.startsWith("window:"))
         throw new Error("This application does not have a supported capture identity");
      return {
         ...preferences,
         sourceName: selected.name,
         displayId: selected.displayId,
         screenIndex: Math.max(0, screenIndex),
         bounds: selected.bounds,
         window: window?.value ?? "",
      };
   }
   async start(preferences: Preferences, sources: CaptureSource[] = []): Promise<void> {
      this.update({ state: "starting", message: "Starting recording" });
      try {
         await this.initialize();
         const configuration = await this.configuration(preferences, sources);
         await this.command({ action: "start", ...configuration });
         this.autoGeneration++;
         this.autoPreferences = preferences.sourceKind === "auto" ? preferences : null;
         this.autoSources = sources;
         this.autoKey = this.configurationKey(configuration);
      } catch (error) {
         this.update({ state: "error", message: error instanceof Error ? error.message : "Recording could not start" });
         throw error;
      }
   }
   async stop(): Promise<void> {
      this.autoPreferences = null;
      this.autoGeneration++;
      if (this.process) await this.command({ action: "stop" });
   }
   async setAudio(value: { source: "capture" | "microphone"; volume: number; muted: boolean }): Promise<void> {
      if (!Number.isFinite(value.volume) || value.volume < 0 || value.volume > 2) throw new Error("Audio volume must be between 0 and 200 percent");
      if (this.process) await this.command({ action: "audio", ...value });
   }
   async switchSource(preferences: Preferences, sources: CaptureSource[] = []): Promise<void> {
      if (this.process) {
         this.autoPreferences = null;
         this.autoGeneration++;
         await this.refreshWindows();
         const configuration = await this.configuration(preferences, sources);
         await this.command({ action: "source", ...configuration });
         this.autoPreferences = preferences.sourceKind === "auto" ? preferences : null;
         this.autoSources = sources;
         this.autoKey = this.configurationKey(configuration);
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
      this.autoPreferences = null;
      this.autoGeneration++;
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
