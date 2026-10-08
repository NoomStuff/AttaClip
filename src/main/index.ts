import {
   app,
   BrowserWindow,
   desktopCapturer,
   dialog,
   globalShortcut,
   ipcMain,
   Menu,
   nativeImage,
   protocol,
   shell,
   Tray,
   session,
   systemPreferences,
} from "electron";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { appendFile, mkdir, realpath, stat, rename as renameFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppEvent, AppState, CaptureSource, Preferences } from "../shared/types";
import { categoryRequest, idSchema, preferencesSchema } from "../shared/validation";
import { readPreferences, requiresCaptureRestart, writePreferences } from "./preferences";
import { CollectionService, withinRoot } from "./collection";
import { isValidShortcut, recordingDestination, recordingSourceLabel, samePath } from "./safety";
import { Recorder } from "./recorder";
import { serveMedia } from "./serve";
import { Updates } from "./updates";
import { linuxStartup } from "./startup";
import { pendingExitDecision } from "./lifecycle";

protocol.registerSchemesAsPrivileged([{ scheme: "attaclip-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const here = dirname(fileURLToPath(import.meta.url));
const testProfile = process.env["ATTACLIP_PROFILE"];
if (testProfile) app.setPath("userData", resolve(testProfile));
app.setName("AttaClip");
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let exiting: Promise<boolean> | null = null;
let preferences: Preferences;
let preferencePath = "";
let refreshBusy = false;
let closingRequested = false;
let cachedSources: CaptureSource[] = [];
let preferenceWrites: Promise<unknown> = Promise.resolve();
let collectionReady: Promise<void> = Promise.resolve();
let startingCapture: Promise<void> | null = null;
let previewSourceId: string | null = null;
const mediaFiles = new Map<string, string>();
const mediaKeys = new Map<string, string>();
const collections = new CollectionService({
   onChange: () => emitState(),
   onJob: (job) => {
      emitState();
      if (job.state === "failed") notice(job.message, true);
   },
   onWarning: (message) => notice(message, true),
   mediaUrl,
});
const updates = new Updates(() => emitState());
const recorder = new Recorder({
   gameCatalogPath: join(app.getPath("userData"), "game-catalog.json"),
   onAudioLevels: (levels) => {
      if (mainWindow?.isVisible() && !mainWindow.isMinimized())
         send({ type: "audio-levels", levels: { capture: levels.capture * 100, microphone: levels.microphone * 100 } });
   },
   nativePath: app.isPackaged
      ? join(process.resourcesPath, "recorder", process.platform === "win32" ? "attaclip-recorder.exe" : "attaclip-recorder")
      : resolve(here, "../../resources/recorder", process.platform === "win32" ? "attaclip-recorder.exe" : "attaclip-recorder"),
   onState: () => {
      emitState();
      updateTray();
   },
   onError: (message) => notice(message, true),
   onSaved: async (path, source, _requestId, capture) => {
      const clip = await collections.registerRecording(path, source);
      emitState();
      notice(capture.previousFootage ? "Saved last available footage" : "Clip saved");
      if (preferences.autoShare) {
         void collections.createShareable(clip.id, preferences.shareSizeMB).catch((e) => notice(errorMessage(e), true));
      }
   },
});
function errorMessage(error: unknown): string {
   return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
function state(): AppState {
   return {
      windowVisible: !!mainWindow?.isVisible() && !mainWindow.isMinimized(),
      preferences,
      clips: collections.clips,
      categories: collections.categories,
      jobs: collections.jobs,
      recorder:
         startingCapture && recorder.status.state === "stopped" ? { ...recorder.status, state: "starting", message: "Starting recording" } : recorder.status,
      update: updates.state,
      version: app.getVersion(),
      platform: process.platform,
   };
}
function send(event: AppEvent) {
   if (!mainWindow || mainWindow.isDestroyed()) return;
   if (event.type !== "visibility" && (!mainWindow.isVisible() || mainWindow.isMinimized())) return;
   mainWindow.webContents.send("app-event", event);
}
function emitState() {
   if (preferences) send({ type: "state", state: state() });
}
function mediaUrl(path: string): string {
   const full = resolve(path);
   let id = mediaKeys.get(full);
   if (!id) {
      id = randomUUID();
      mediaKeys.set(full, id);
      mediaFiles.set(id, full);
   }
   return `attaclip-media://local/${id}`;
}
async function log(message: string) {
   try {
      const directory = join(app.getPath("userData"), "logs");
      await mkdir(directory, { recursive: true });
      const file = join(directory, "app.log");
      if ((await stat(file).catch(() => null))?.size && (await stat(file)).size > 2 * 1024 * 1024) {
         await rm(`${file}.previous`, { force: true });
         await renameFile(file, `${file}.previous`);
      }
      await appendFile(file, `${new Date().toISOString()} ${message}\n`);
   } catch {
      /* Diagnostics must not break capture. */
   }
}
function notice(message: string, error = false) {
   send({ type: "notice", message, error });
   void log(message);
   if (preferences?.sound && process.env["ATTACLIP_TEST"] !== "1" && (error || message === "Clip saved")) shell.beep();
   if (preferences?.notifications !== "off") void showFeedback(message, error).catch(() => undefined);
}
let feedback: BrowserWindow | null = null;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
async function showFeedback(message: string, error: boolean) {
   // A lightweight, non-activating window. Exclusive fullscreen visibility depends
   // on the compositor; native overlays remain a separate platform integration.
   if (process.env["ATTACLIP_TEST"] === "1") return;
   if (preferences.notifications === "outside-fullscreen" && (await recorder.foregroundFullscreen())) return;
   const escaped = message.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
   if (feedback && !feedback.isDestroyed()) feedback.close();
   const display = mainWindow ? requireDisplay(mainWindow) : null;
   feedback = new BrowserWindow({
      width: 320,
      height: 78,
      ...(display ? { x: display.x + display.width - 340, y: display.y + 20 } : {}),
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
   });
   feedback.setContentProtection(true);
   const html = `<!doctype html><html><body style="margin:0;background:transparent;font:14px 'Segoe UI',sans-serif;color:#f5f2fa"><div style="display:flex;align-items:center;gap:12px;padding:19px;background:#211d28;border-radius:14px;animation:enter .2s ease-out"><span style="color:${error ? "#fb8b8b" : "#b197fc"};font-size:24px">${error ? "!" : "✓"}</span><span>${escaped}</span></div><style>@keyframes enter{from{transform:translateY(-8px);opacity:0}to{transform:none;opacity:1}}</style></body></html>`;
   const popup = feedback;
   void popup
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(() => {
         if (!popup.isDestroyed()) popup.showInactive();
      })
      .catch(() => undefined);
   clearTimeout(feedbackTimer);
   feedbackTimer = setTimeout(
      () => {
         if (!popup.isDestroyed()) popup.close();
      },
      error ? 6500 : 2300
   );
}
import { screen } from "electron";
function requireDisplay(window: BrowserWindow) {
   return screen.getDisplayMatching(window.getBounds()).workArea;
}
async function sources(): Promise<CaptureSource[]> {
   const list = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 640, height: 360 }, fetchWindowIcons: false });
   cachedSources = list
      .filter((s) => !s.name.startsWith("AttaClip"))
      .map((s) => {
         const display = screen.getAllDisplays().find((item) => String(item.id) === s.display_id);
         const bounds = display ? (process.platform === "win32" ? screen.dipToScreenRect(null, display.bounds) : display.bounds) : undefined;
         return {
            id: s.id,
            name: s.name,
            kind: s.id.startsWith("screen:") ? "screen" : "app",
            thumbnail: s.thumbnail.toDataURL(),
            ...(bounds ? { bounds } : {}),
            ...(s.display_id ? { displayId: s.display_id } : {}),
         };
      });
   return cachedSources;
}
function createWindow() {
   mainWindow = new BrowserWindow({
      width: 1380,
      height: 900,
      minWidth: 980,
      minHeight: 680,
      backgroundColor: "#0c0b0e",
      frame: process.platform === "darwin",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      title: "AttaClip",
      icon: iconPath(),
      show: false,
      webPreferences: { preload: join(here, "../preload/index.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false },
   });
   mainWindow.once("ready-to-show", () => mainWindow?.show());
   const visibilityChanged = () => {
      const visible = !!mainWindow?.isVisible() && !mainWindow.isMinimized();
      if (!visible) previewSourceId = null;
      send({ type: "visibility", visible });
      if (visible) emitState();
   };
   mainWindow.on("show", visibilityChanged);
   mainWindow.on("hide", visibilityChanged);
   mainWindow.on("minimize", visibilityChanged);
   mainWindow.on("restore", visibilityChanged);
   mainWindow.on("close", (event) => {
      if (!quitting) {
         event.preventDefault();
         mainWindow?.hide();
      }
   });
   mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
   mainWindow.webContents.on("will-navigate", (event, url) => {
      if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
   });
   const dev = process.env["ELECTRON_RENDERER_URL"];
   if (dev) void mainWindow.loadURL(dev);
   else void mainWindow.loadFile(join(here, "../renderer/index.html"));
}
function iconPath() {
   return app.isPackaged ? join(process.resourcesPath, "icons/icon.png") : resolve("build/icon.png");
}
function trayIcon() {
   const path = app.isPackaged ? join(process.resourcesPath, "icons/icon.png") : resolve("build/icon.png");
   return existsSync(path)
      ? nativeImage.createFromPath(path).resize({ width: 20, height: 20 })
      : nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
}
function updateTray() {
   if (!tray) return;
   const active = recorder.status.state === "recording" || recorder.status.state === "waiting";
   tray.setToolTip(`AttaClip${recorder.status.state === "waiting" ? " · Waiting for application" : active ? " · Recording" : ""}`);
   tray.setContextMenu(
      Menu.buildFromTemplate([
         {
            label: "Open AttaClip",
            click: () => {
               mainWindow?.show();
               mainWindow?.focus();
            },
         },
         {
            label: active ? "Stop recording" : "Start recording",
            enabled: !startingCapture,
            click: () => void (active ? recorder.stop() : startRecording()).catch((e) => notice(errorMessage(e), true)),
         },
         { label: "Save clip", enabled: active, click: () => void saveClip().catch((e) => notice(errorMessage(e), true)) },
         { type: "separator" },
         { label: "Exit", click: () => void requestExit() },
      ])
   );
}
async function startRecording() {
   if (closingRequested) throw new Error("AttaClip is preparing to exit. Keep the app open to record.");
   if (startingCapture || ["starting", "recording", "waiting"].includes(recorder.status.state)) throw new Error("Recording is already running.");
   startingCapture = (async () => {
      await preferenceWrites.catch(() => undefined);
      if (process.platform === "darwin" && preferences.microphone && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
         if (!(await systemPreferences.askForMediaAccess("microphone")))
            throw new Error("Allow microphone access in System Settings, or turn the microphone off.");
      }
      const available = await sources();
      if (closingRequested) throw new Error("AttaClip is preparing to exit. Keep the app open to record.");
      await recorder.start(preferences, available);
   })();
   emitState();
   updateTray();
   try {
      await startingCapture;
   } finally {
      startingCapture = null;
      emitState();
      updateTray();
   }
}
async function saveClip() {
   const requestedAt = Date.now();
   if (closingRequested) throw new Error("AttaClip is preparing to exit. Keep the app open to save another clip.");
   if (recorder.status.state !== "recording" && recorder.status.state !== "waiting") throw new Error("Start recording before saving a clip.");
   send({ type: "clip-action" });
   const destination = recordingDestination(
      { ...preferences, collection: collections.root },
      preferences.sourceKind === "auto" ? (recorder.status.sourceName ?? "Game") : recordingSourceLabel(preferences, cachedSources),
      randomUUID().slice(0, 8),
      new Date(requestedAt)
   );
   mkdirSync(dirname(destination), { recursive: true });
   if (!withinRoot(collections.root, realpathSync(dirname(destination))))
      throw new Error("The recording folder points outside this collection. Choose another folder.");
   await recorder.save(destination, requestedAt);
   notice("Saving clip…");
}
function pendingJobs() {
   return collections.jobs.filter((j) => j.state === "running" || j.state === "queued");
}
async function applyStartup(enabled: boolean) {
   if (process.env["ATTACLIP_TEST"] === "1") return;
   const executable = process.env["PORTABLE_EXECUTABLE_FILE"] ?? process.env["APPIMAGE"] ?? app.getPath("exe");
   const args = app.isPackaged ? [] : [app.getAppPath()];
   if (process.platform === "linux") await linuxStartup(enabled, process.env["XDG_CONFIG_HOME"] ?? join(app.getPath("home"), ".config"), executable, args);
   else app.setLoginItemSettings({ openAtLogin: enabled, path: executable, args });
}
async function prepareExit(): Promise<boolean> {
   if (exiting) return exiting;
   closingRequested = true;
   exiting = (async () => {
      await preferenceWrites.catch(() => undefined);
      await startingCapture?.catch(() => undefined);
      const saves = recorder.status.pendingSaves;
      if (saves || pendingJobs().length) {
         const decision = await pendingExitDecision(
            () => !!recorder.status.pendingSaves || pendingJobs().length > 0,
            async (signal) =>
               (
                  await dialog.showMessageBox({
                     type: "question",
                     title: "Work is still running",
                     message: "Finish before exiting?",
                     detail: `${saves ? `${saves} clip save${saves === 1 ? "" : "s"}` : ""}${saves && pendingJobs().length ? " and " : ""}${pendingJobs().length ? `${pendingJobs().length} shareable${pendingJobs().length === 1 ? "" : "s"}` : ""} still in progress.`,
                     buttons: ["Finish and exit", "Cancel work", "Keep open"],
                     defaultId: 0,
                     cancelId: 2,
                     signal,
                  })
               ).response
         );
         if (decision === 2) return false;
         if (decision === 1) {
            if (recorder.status.pendingSaves) {
               const confirm = await dialog.showMessageBox({
                  type: "warning",
                  message: "Discard pending clips?",
                  detail: "These moments have not finished saving and may be lost.",
                  buttons: ["Keep saving", "Discard and exit"],
                  defaultId: 0,
                  cancelId: 0,
               });
               if (confirm.response !== 1) return false;
            }
            await Promise.all(pendingJobs().map((j) => collections.cancelJob(j.id)));
            await recorder.close({ cancel: true });
            while (pendingJobs().length) await new Promise((r) => setTimeout(r, 100));
         } else {
            await recorder.stop();
            await recorder.close();
            while (pendingJobs().length) await new Promise((r) => setTimeout(r, 150));
         }
      } else {
         if (["recording", "waiting"].includes(recorder.status.state)) {
            const result = await dialog.showMessageBox({
               type: "question",
               message: "Stop recording and exit?",
               detail: "Unsaved recent footage will be cleared.",
               buttons: ["Exit", "Keep recording"],
               defaultId: 1,
               cancelId: 1,
            });
            if (result.response !== 0) return false;
         }
         await recorder.close();
      }
      return true;
   })();
   try {
      return await exiting;
   } finally {
      exiting = null;
      if (!quitting) closingRequested = false;
   }
}
async function requestExit() {
   try {
      if (await prepareExit()) {
         quitting = true;
         globalShortcut.unregisterAll();
         app.quit();
      }
   } catch (error) {
      notice(`AttaClip could not finish exiting: ${errorMessage(error)}`, true);
   }
}
function trustedPath(path: unknown): string {
   const candidate = z.string().max(4096).parse(path);
   const full = resolve(candidate);
   const known = [collections.root, ...collections.clips.flatMap((c) => [c.path, ...c.shareables.map((s) => s.path)])].some((p) => samePath(resolve(p), full));
   if (!known) throw new Error("This file is not part of the open collection.");
   const actual = realpathSync(full);
   if (!withinRoot(collections.root, actual)) throw new Error("This file moved outside the collection.");
   return actual;
}
function handle(channel: string, fn: (...args: unknown[]) => unknown) {
   ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== mainWindow?.webContents) throw new Error("Unknown window");
      try {
         if (!["state", "sources", "choose-folder", "update-check", "exit"].includes(channel)) await collectionReady;
         if (closingRequested && ["preferences", "share", "rename", "delete", "category", "record-start", "record-save"].includes(channel))
            throw new Error("AttaClip is preparing to exit. Keep the app open to make changes.");
         return await fn(...args);
      } catch (e) {
         notice(errorMessage(e), true);
         throw e;
      }
   });
}
function registerIPC() {
   handle("state", () => state());
   handle("sources", () => sources());
   handle("games", () => recorder.games(preferences.customGames));
   handle("preview-source", (id) => {
      const requested = z.string().max(200).nullable().parse(id);
      if (requested === null) {
         previewSourceId = null;
         return;
      }
      if (!mainWindow?.isVisible() || mainWindow.isMinimized() || !preferences.setupComplete) throw new Error("Open Recording to preview the capture source.");
      const selected =
         preferences.sourceKind === "auto"
            ? cachedSources.find((source) => source.id === recorder.status.sourceId)
            : (cachedSources.find((source) => source.id === preferences.sourceId && source.kind === preferences.sourceKind) ??
              (!preferences.sourceId && preferences.sourceKind === "screen" ? cachedSources.find((source) => source.kind === "screen") : undefined));
      if (!selected || selected.id !== requested) throw new Error("The selected preview source is unavailable.");
      previewSourceId = requested;
   });
   handle("audio-devices", () => recorder.audioDevices());
   handle("choose-folder", async () => {
      const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], defaultPath: preferences.collection });
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
   });
   handle("preferences", async (value) => {
      const operation = preferenceWrites
         .catch(() => undefined)
         .then(async () => {
            if (startingCapture) throw new Error("Recording is starting. Wait before applying settings.");
            const next = preferencesSchema.parse(value);
            if (!next.collection.trim()) throw new Error("Choose a collection folder.");
            if (!isValidShortcut(next.shortcut)) throw new Error("That key combination is not supported. Try a letter, number, or function key.");
            if (recorder.status.state !== "stopped" && recorder.status.state !== "error" && requiresCaptureRestart(preferences, next))
               throw new Error("Stop recording before applying recording or audio changes. Unsaved history will clear.");
            if (next.collection !== preferences.collection && (recorder.status.state !== "stopped" || recorder.status.pendingSaves || pendingJobs().length))
               throw new Error("Stop recording and finish shareables before changing the collection folder.");
            if (
               !globalShortcut.isRegistered(next.shortcut) &&
               !globalShortcut.register(next.shortcut, () => void saveClip().catch((e) => notice(errorMessage(e), true)))
            )
               throw new Error("That shortcut isn't available. Choose another key combination.");
            try {
               if (next.collection !== preferences.collection) await collections.open(next.collection);
               if (
                  ["recording", "waiting"].includes(recorder.status.state) &&
                  (next.sourceId !== preferences.sourceId ||
                     next.sourceKind !== preferences.sourceKind ||
                     next.desktopFallback !== preferences.desktopFallback ||
                     JSON.stringify(next.customGames) !== JSON.stringify(preferences.customGames))
               )
                  await recorder.switchSource(next, await sources());
               if (next.startWithOS !== preferences.startWithOS) await applyStartup(next.startWithOS);
               if (["recording", "waiting"].includes(recorder.status.state)) {
                  await recorder.setAudio({ source: "capture", volume: next.captureVolume, muted: next.captureMuted });
                  await recorder.setAudio({ source: "microphone", volume: next.microphoneVolume, muted: next.microphoneMuted });
               }
               await writePreferences(preferencePath, next);
            } catch (e) {
               if (next.shortcut !== preferences.shortcut) globalShortcut.unregister(next.shortcut);
               if (next.collection !== preferences.collection && collections.root !== resolve(preferences.collection))
                  await collections.open(preferences.collection).catch((error: unknown) => notice(errorMessage(error), true));
               if (
                  ["recording", "waiting"].includes(recorder.status.state) &&
                  (next.sourceId !== preferences.sourceId ||
                     next.sourceKind !== preferences.sourceKind ||
                     next.desktopFallback !== preferences.desktopFallback ||
                     JSON.stringify(next.customGames) !== JSON.stringify(preferences.customGames))
               )
                  await recorder.switchSource(preferences, cachedSources).catch((error: unknown) => notice(errorMessage(error), true));
               if (next.startWithOS !== preferences.startWithOS)
                  await applyStartup(preferences.startWithOS).catch((error: unknown) => notice(errorMessage(error), true));
               if (["recording", "waiting"].includes(recorder.status.state)) {
                  await recorder.setAudio({ source: "capture", volume: preferences.captureVolume, muted: preferences.captureMuted }).catch(() => undefined);
                  await recorder
                     .setAudio({ source: "microphone", volume: preferences.microphoneVolume, muted: preferences.microphoneMuted })
                     .catch(() => undefined);
               }
               throw e;
            }
            if (next.shortcut !== preferences.shortcut) globalShortcut.unregister(preferences.shortcut);
            if (next.sourceId !== preferences.sourceId || next.sourceKind !== preferences.sourceKind) previewSourceId = null;
            preferences = next;
            recorder.updatePreferences(next);
            emitState();
            return state();
         });
      preferenceWrites = operation;
      return operation;
   });
   handle("record-start", () => startRecording());
   handle("record-stop", async () => {
      await startingCapture?.catch(() => undefined);
      await recorder.stop();
   });
   handle("record-save", () => saveClip());
   handle("share", (id, target) =>
      collections.createShareable(idSchema.parse(id), target === undefined ? preferences.shareSizeMB : z.number().min(1).max(2000).parse(target))
   );
   handle("cancel-job", (id) => collections.cancelJob(idSchema.parse(id)));
   handle("rename", (id, name) => collections.rename(idSchema.parse(id), z.string().trim().min(1).max(150).parse(name)));
   handle("delete", async (id, shareId) => {
      const clipId = idSchema.parse(id);
      const shareableId = shareId === undefined ? undefined : idSchema.parse(shareId);
      if (pendingJobs().some((j) => j.clipId === clipId)) throw new Error("Cancel the shareable export before removing this clip.");
      const result = await dialog.showMessageBox({
         type: "warning",
         message: shareableId ? "Move this shareable to the trash?" : "Move this clip and its shareables to the trash?",
         buttons: ["Cancel", "Move to trash"],
         defaultId: 0,
         cancelId: 0,
      });
      if (result.response !== 1) return;
      const deleted: string[] = [];
      try {
         for (const path of await collections.filesForDeletion(clipId, shareableId)) {
            await shell.trashItem(path);
            deleted.push(path);
         }
      } finally {
         await collections.removeDeleted(clipId, deleted);
      }
   });
   handle("category", async (action, value) => {
      const request = categoryRequest.parse(value);
      switch (z.enum(["create", "delete", "assign"]).parse(action)) {
         case "create":
            return collections.createCategory(request.name ?? "New category", request.color ?? "#b197fc");
         case "delete":
            return collections.deleteCategory(idSchema.parse(request.id));
         case "assign":
            return collections.assignCategories(idSchema.parse(request.clipId), request.categoryIds ?? []);
      }
   });
   handle("reveal", (path) => {
      const selected = trustedPath(path);
      if (samePath(selected, collections.root)) void shell.openPath(selected);
      else shell.showItemInFolder(selected);
   });
   handle("attacut", async (id) => {
      const clip = collections.clips.find((c) => c.id === idSchema.parse(id));
      if (!clip) throw new Error("Clip not found");
      const candidates =
         process.platform === "win32"
            ? [join(app.getPath("appData"), "../Local/Programs/AttaCut/AttaCut.exe"), "D:/Coding/AttaCut/release/win-unpacked/AttaCut.exe"]
            : process.platform === "darwin"
              ? ["/Applications/AttaCut.app/Contents/MacOS/AttaCut"]
              : [];
      const executable = candidates.find(existsSync);
      if (executable) {
         const { spawn } = await import("node:child_process");
         const child = spawn(executable, [clip.path], { detached: true, stdio: "ignore", windowsHide: true });
         child.once("error", () => notice("AttaCut could not open. Show the clip in your file manager and open it there.", true));
         child.unref();
      } else {
         await dialog.showMessageBox({
            type: "info",
            message: "Open this clip in AttaCut",
            detail: "AttaCut wasn't found automatically. The clip will be shown in your file manager.",
            buttons: ["Show clip"],
         });
         shell.showItemInFolder(clip.path);
      }
   });
   handle("playback", (path, track) => collections.playback(trustedPath(path), track === undefined ? undefined : z.number().int().min(0).max(63).parse(track)));
   handle("refresh", async () => {
      await collections.scan();
      emitState();
   });
   handle("update-check", () => updates.check());
   handle("update-install", () => updates.install(prepareExit));
   handle("exit", () => requestExit());
   ipcMain.on("window", (event, action) => {
      if (event.sender !== mainWindow?.webContents) return;
      switch (action) {
         case "minimize":
            mainWindow.minimize();
            break;
         case "maximize":
            if (mainWindow.isMaximized()) mainWindow.unmaximize();
            else mainWindow.maximize();
            break;
         case "close":
            mainWindow.close();
            break;
      }
   });
   ipcMain.on("drag", (event, path) => {
      if (event.sender !== mainWindow?.webContents) return;
      try {
         event.sender.startDrag({ file: trustedPath(path), icon: trayIcon() });
      } catch (e) {
         notice(errorMessage(e), true);
      }
   });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
   app.on("second-instance", () => {
      mainWindow?.show();
      mainWindow?.focus();
   });
   app.on("before-quit", (event) => {
      if (!quitting) {
         event.preventDefault();
         void requestExit();
      }
   });
   app.on("window-all-closed", () => {
      /* The recorder and tray own the app lifecycle. */
   });
   app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else mainWindow.show();
   });
   void app
      .whenReady()
      .then(async () => {
         preferencePath = join(app.getPath("userData"), "preferences.json");
         preferences = await readPreferences(preferencePath, process.env["ATTACLIP_COLLECTION"] ?? join(app.getPath("videos"), "AttaClip"));
         collectionReady = collections.open(preferences.collection);
         const previewAllowed = () => !!previewSourceId && !!mainWindow?.isVisible() && !mainWindow.isMinimized() && !closingRequested;
         session.defaultSession.setDisplayMediaRequestHandler(
            (request, callback) => {
               if (request.frame !== mainWindow?.webContents.mainFrame || !request.videoRequested || request.audioRequested || !previewAllowed()) {
                  callback(null);
                  return;
               }
               const requested = previewSourceId;
               const sourceKind = preferences.sourceKind;
               const sourceId = preferences.sourceId;
               void desktopCapturer
                  .getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
                  .then((available) => {
                     if (
                        !previewAllowed() ||
                        previewSourceId !== requested ||
                        preferences.sourceKind !== sourceKind ||
                        preferences.sourceId !== sourceId ||
                        (sourceKind === "auto" && recorder.status.sourceId !== requested)
                     ) {
                        callback(null);
                        return;
                     }
                     const selected = available.find((source) => source.id === requested);
                     callback(selected ? { video: selected } : null);
                  })
                  .catch(() => callback(null));
            },
            { useSystemPicker: false }
         );
         session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) =>
            callback(
               webContents === mainWindow?.webContents &&
                  ((permission === "display-capture" && previewAllowed()) ||
                     (permission === "media" && details.isMainFrame && "mediaTypes" in details && details.mediaTypes?.length === 0 && previewAllowed()) ||
                     (permission === "media" && "mediaTypes" in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio"))
            )
         );
         session.defaultSession.setPermissionCheckHandler(
            (webContents, permission, _origin, details) =>
               webContents === mainWindow?.webContents &&
               ((permission === "display-capture" && details.isMainFrame && previewAllowed()) || (permission === "media" && details.mediaType === "audio"))
         );
         protocol.handle("attaclip-media", async (request) => {
            const url = new URL(request.url);
            const path = mediaFiles.get(url.pathname.slice(1));
            if (url.hostname !== "local" || !path) return new Response(null, { status: 403 });
            try {
               const actual = await realpath(path);
               if (!withinRoot(collections.root, actual)) return new Response(null, { status: 403 });
               return await serveMedia(actual, request);
            } catch {
               return new Response(null, { status: 404 });
            }
         });
         registerIPC();
         createWindow();
         tray = new Tray(trayIcon());
         tray.on("double-click", () => mainWindow?.show());
         updateTray();
         await collectionReady;
         if (!globalShortcut.register(preferences.shortcut, () => void saveClip().catch((e) => notice(errorMessage(e), true))))
            notice("Clip shortcut is unavailable. Choose another in Settings.", true);
         setInterval(() => {
            emitState();
            if (!refreshBusy && !pendingJobs().length) {
               refreshBusy = true;
               void collections
                  .scan()
                  .catch((e) => void log(errorMessage(e)))
                  .finally(() => {
                     refreshBusy = false;
                  });
            }
         }, 5000).unref();
         if (preferences.autoRecord && preferences.setupComplete && process.env["ATTACLIP_TEST"] !== "1")
            void startRecording().catch((e) => notice(errorMessage(e), true));
         if (app.isPackaged && process.env["ATTACLIP_TEST"] !== "1") {
            setTimeout(() => void updates.check(), 10000).unref();
            setInterval(() => void updates.check(), 6 * 60 * 60 * 1000).unref();
         }
      })
      .catch((e) => {
         void log(errorMessage(e));
         void dialog.showMessageBox({ type: "error", message: "AttaClip couldn't start", detail: errorMessage(e) }).then(() => {
            quitting = true;
            app.quit();
         });
      });
}
