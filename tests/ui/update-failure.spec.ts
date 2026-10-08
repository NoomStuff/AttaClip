import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultPreferences } from "../../src/shared/defaults";
import type * as ElectronUpdater from "electron-updater";

test("a failed update install leaves the app usable and the clip shortcut registered", async () => {
   const profile = await mkdtemp(join(tmpdir(), "attaclip-update-ui-"));
   const collection = join(profile, "clips");
   const shortcut = "Control+Alt+Shift+F12";
   await mkdir(collection, { recursive: true });
   await writeFile(
      join(profile, "preferences.json"),
      JSON.stringify({ ...defaultPreferences, collection, setupComplete: true, sourceKind: "app", sourceId: "window:0:0", shortcut })
   );
   const desktop = await electron.launch({
      args: [resolve("."), "--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile },
   });
   try {
      const page = await desktop.firstWindow();
      await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
      await expect.poll(() => desktop.evaluate(({ globalShortcut }, value) => globalShortcut.isRegistered(value), shortcut)).toBe(true);
      // Exercise the production Updates object and shutdown callback. Replace only
      // its external installer boundary, which can fail without quitting Electron.
      await desktop.evaluate(async ({ app }) => {
         Object.defineProperty(app, "isPackaged", { configurable: true, value: true });
         const module = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`)("electron-updater") as typeof ElectronUpdater;
         const updater = module.autoUpdater;
         updater.checkForUpdates = async () => null;
         updater.quitAndInstall = () => {
            updater.emit("error", new Error("The update installer could not start"));
         };
      });
      await page.evaluate(() => window.attaClip.checkUpdate());
      await desktop.evaluate(async ({ app }) => {
         const module = process.getBuiltinModule("module").createRequire(`${app.getAppPath()}/package.json`)("electron-updater") as typeof ElectronUpdater;
         module.autoUpdater.emit("update-downloaded", {
            version: "99.0.0",
            downloadedFile: "AttaClip-test-installer.exe",
            files: [],
            path: "AttaClip-test-installer.exe",
            sha512: "",
            releaseDate: "2026-10-08T12:00:00.000Z",
         });
      });
      await expect.poll(() => page.evaluate(async () => (await window.attaClip.state()).update.state)).toBe("ready");
      await page.evaluate(() => window.attaClip.installUpdate());
      await expect.poll(() => page.evaluate(async () => (await window.attaClip.state()).update.state)).toBe("error");
      await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
      await expect.poll(() => desktop.evaluate(({ globalShortcut }, value) => globalShortcut.isRegistered(value), shortcut)).toBe(true);
      await page.evaluate(async () => {
         const state = await window.attaClip.state();
         await window.attaClip.savePreferences({ ...state.preferences, shareSizeMB: 42 });
      });
      expect((await page.evaluate(() => window.attaClip.state())).preferences.shareSizeMB).toBe(42);
   } finally {
      await desktop.close();
   }
});
