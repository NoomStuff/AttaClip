import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultPreferences } from "../../src/shared/defaults";

test("first-run setup persists choices and ends ready without recording", async () => {
   const profile = await mkdtemp(join(tmpdir(), "attaclip-onboarding-"));
   const collection = join(profile, "clips");
   const desktop = await electron.launch({
      args: [resolve("."), "--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile, ATTACLIP_COLLECTION: collection },
   });
   try {
      const page = await desktop.firstWindow();
      await expect(page.locator("body")).toContainText(/capture|record|welcome/i);
      await page.screenshot({ path: "test-results/onboarding.png" });
      const api = await page.evaluate(async () => window.attaClip.state());
      expect(api.preferences.setupComplete).toBe(false);
      expect(api.recorder.state).toBe("stopped");
      expect(api.preferences.autoRecord).toBe(false);
      await page.evaluate(async () => {
         const state = await window.attaClip.state();
         await window.attaClip.savePreferences({ ...state.preferences, setupComplete: true });
      });
      await expect(page.getByRole("button", { name: /start recording/i })).toBeVisible();
      await page.screenshot({ path: "test-results/recording.png" });
   } finally {
      await desktop.close();
   }
});

test("library navigation and preferences use the isolated collection", async () => {
   const profile = await mkdtemp(join(tmpdir(), "attaclip-ui-"));
   const collection = join(profile, "clips");
   await mkdir(collection, { recursive: true });
   await writeFile(join(profile, "preferences.json"), JSON.stringify({ ...defaultPreferences, collection, setupComplete: true }));
   const desktop = await electron.launch({
      args: [resolve("."), "--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile },
   });
   try {
      const page = await desktop.firstWindow();
      await expect(page.getByRole("button", { name: /start recording/i })).toBeVisible();
      const state = await page.evaluate(() => window.attaClip.state());
      expect(state.preferences.collection).toBe(collection);
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect(page.locator("body")).toContainText(/no clips|first clip|empty|collection/i);
      await page.screenshot({ path: "test-results/library-empty.png" });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.locator("body")).toContainText(/sharing|general|recording/i);
      await page.screenshot({ path: "test-results/settings.png" });
   } finally {
      await desktop.close();
   }
});
