import { app, shell } from "electron";
import type { UpdateState } from "../shared/types";
import type { AppUpdater } from "electron-updater";
import { releaseIsNewer } from "./safety";
// Adapted from AttaCut's explicit-install update flow. Unsigned macOS and portable
// Windows distributions open the release instead of promising an unsupported install.
export class Updates {
   state: UpdateState = { state: "idle", version: "", progress: 0, message: "" };
   private updater: AppUpdater | null = null;
   private readonly changed: () => void;
   constructor(changed: () => void) {
      this.changed = changed;
   }
   private set(value: UpdateState) {
      this.state = value;
      this.changed();
   }
   async check(): Promise<void> {
      if (this.state.state === "checking" || this.state.state === "downloading") return;
      this.set({ ...this.state, state: "checking", message: "Checking for updates" });
      const automatic =
         app.isPackaged &&
         ((process.platform === "win32" && !process.env["PORTABLE_EXECUTABLE_FILE"]) || (process.platform === "linux" && !!process.env["APPIMAGE"]));
      try {
         if (!automatic) {
            const response = await fetch("https://api.github.com/repos/NoomStuff/AttaClip/releases/latest", { signal: AbortSignal.timeout(15000) });
            if (response.status === 404) {
               this.set({ state: "idle", version: "", progress: 0, message: "You're up to date" });
               return;
            }
            if (!response.ok) throw new Error("Unable to reach releases");
            const result: unknown = await response.json();
            const tag =
               typeof result === "object" && result !== null && "tag_name" in result && typeof result.tag_name === "string"
                  ? result.tag_name.replace(/^v/, "")
                  : "";
            const newer = releaseIsNewer(tag, app.getVersion());
            this.set({ state: newer ? "available" : "idle", version: tag, progress: 0, message: newer ? "An update is available" : "You're up to date" });
            return;
         }
         if (!this.updater) {
            const module = await import("electron-updater");
            this.updater = module.autoUpdater ?? module.default.autoUpdater;
            this.updater.autoInstallOnAppQuit = false;
            this.updater.autoDownload = true;
            this.updater.disableDifferentialDownload = true;
            this.updater.on("download-progress", (p) =>
               this.set({ state: "downloading", version: this.state.version, progress: p.percent, message: "Downloading update" })
            );
            this.updater.on("update-available", (p) => this.set({ state: "downloading", version: p.version, progress: 0, message: "Downloading update" }));
            this.updater.on("update-downloaded", (p) => this.set({ state: "ready", version: p.version, progress: 100, message: "Ready to restart" }));
            this.updater.on("update-not-available", () => this.set({ state: "idle", version: "", progress: 0, message: "You're up to date" }));
            this.updater.on("error", () =>
               this.set({
                  state: "error",
                  version: "",
                  progress: 0,
                  message:
                     this.state.state === "ready" ? "Couldn't install the update. Try again later." : "Couldn't check or download updates. Try again later.",
               })
            );
         }
         await this.updater.checkForUpdates();
      } catch {
         this.set({ state: "error", version: "", progress: 0, message: "Couldn't check for updates. Try again later." });
      }
   }
   async install(before: () => Promise<boolean>) {
      if (this.state.state === "ready" && this.updater) {
         if (await before()) this.updater.quitAndInstall();
      } else if (this.state.state === "available") await shell.openExternal("https://github.com/NoomStuff/AttaClip/releases/latest");
   }
}
