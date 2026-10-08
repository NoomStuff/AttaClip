import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("onboarding UI persists choices without starting recording or OS startup", async () => {
   const profile = await mkdtemp(join(tmpdir(), "attaclip-setup-flow-"));
   const collection = join(profile, "clips");
   const desktop = await electron.launch({
      args: [resolve("."), "--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile, ATTACLIP_COLLECTION: collection },
   });
   try {
      const page = await desktop.firstWindow();
      await expect(page.getByRole("heading", { name: "What would you like to capture?" })).toBeVisible();
      await page.getByRole("button", { name: "Auto", exact: true }).last().click();
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
      await expect(page.locator(".onboarding")).toContainText("isn't available");
      await page.getByRole("button", { name: "Screen", exact: true }).last().click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Choose your sound" })).toBeVisible();
      await expect(page.locator(".onboarding").getByRole("checkbox", { name: /Microphone/ })).not.toBeChecked();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("spinbutton", { name: "Setup clip length in seconds" }).fill("45");
      await page.getByRole("button", { name: "Clip shortcut", exact: true }).click();
      await page.getByRole("button", { name: "Clip shortcut", exact: true }).press("Control+Shift+F9");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: /Custom.*Your settings/ }).click();
      await page.getByRole("combobox", { name: "Custom recording resolution" }).selectOption("720p");
      await page.getByRole("combobox", { name: "Custom recording frame rate" }).selectOption("30");
      await page.locator(".onboarding summary").click();
      await page.getByRole("slider", { name: "Custom recording compression" }).fill("19");
      await page.getByRole("spinbutton", { name: "Custom recording width" }).fill("1281");
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
      await page.getByRole("spinbutton", { name: "Custom recording width" }).fill("1280");
      await page.waitForTimeout(300);
      await page.screenshot({ path: "test-results/onboarding-quality.png" });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "10 MB", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: /Automatically create shareables/ })).not.toBeChecked();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: "Start with your computer", exact: true })).not.toBeChecked();
      await expect(page.getByRole("checkbox", { name: /Start recording when AttaClip opens/ })).not.toBeChecked();
      await page.waitForTimeout(300);
      await page.screenshot({ path: "test-results/onboarding-ready.png" });
      await page.getByRole("button", { name: "Open AttaClip", exact: true }).click();
      await expect(page.locator(".onboarding")).toHaveCount(0);
      const state = await page.evaluate(() => window.attaClip.state());
      expect(state.preferences).toMatchObject({
         collection,
         clipSeconds: 45,
         shortcut: "Control+Shift+F9",
         quality: "custom",
         customWidth: 1280,
         customHeight: 720,
         customFPS: 30,
         customCQ: 19,
         allowSoftwareEncoder: false,
         shareSizeMB: 10,
         setupComplete: true,
         microphone: false,
         autoRecord: false,
         startWithOS: false,
      });
      expect(state.preferences.sourceId).not.toBe("");
      expect(state.recorder.state).toBe("stopped");
      await page.getByRole("slider", { name: "Capture audio level", exact: true }).fill("0.5");
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).preferences.captureVolume).toBe(0.5);
      await page.getByRole("button", { name: "Mute capture audio", exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).preferences.captureMuted).toBe(true);
      await expect(page.getByRole("button", { name: "Unmute capture audio", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Custom recording resolution" })).toHaveValue("720p");
      await page.getByRole("combobox", { name: "Custom recording resolution" }).selectOption("1440p");
      await page.getByRole("combobox", { name: "Custom recording frame rate" }).selectOption("60");
      await page.locator(".settings-body summary").click();
      await page.getByRole("slider", { name: "Custom recording compression" }).fill("25");
      await page.getByRole("spinbutton", { name: "Custom recording width" }).fill("2561");
      await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
      await page.getByRole("spinbutton", { name: "Custom recording width" }).fill("2560");
      await expect(page.getByRole("checkbox", { name: /Allow software encoding/ })).not.toBeChecked();
      await page.getByRole("checkbox", { name: /Allow software encoding/ }).check();
      await page.waitForTimeout(300);
      await page.screenshot({ path: "test-results/settings-custom-quality.png" });
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await expect
         .poll(async () => (await page.evaluate(() => window.attaClip.state())).preferences)
         .toMatchObject({ customWidth: 2560, customHeight: 1440, customFPS: 60, customCQ: 25, allowSoftwareEncoder: true });
      await page.getByRole("button", { name: "Sharing", exact: true }).click();
      await expect(page.getByRole("spinbutton", { name: "Default shareable size in MB" })).toHaveValue("10");
      await page.getByRole("spinbutton", { name: "Default shareable size in MB" }).fill("50");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).preferences.shareSizeMB).toBe(50);
      await page.getByRole("button", { name: "Collection", exact: true }).click();
      await page.getByRole("combobox", { name: "Filename preset" }).selectOption("custom");
      const pattern = page.getByRole("textbox", { name: "Name pattern" });
      await pattern.fill("Moment ");
      await page.locator(".filename-tokens").getByTitle("{source}", { exact: true }).click();
      await expect(pattern).toHaveValue("Moment {source}");
      await pattern.press("Control+Z");
      await expect(pattern).toHaveValue("Moment ");
      await pattern.fill("{unknown}");
      await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
      await pattern.fill("../outside");
      await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
      await pattern.fill("Moment {source} {date} {time}");
      await expect(page.locator(".filename-preview")).toContainText("Moment Desktop 2026-10-08 19-42-10-a1b2c3d4.mkv");
      await page.waitForTimeout(300);
      await page.screenshot({ path: "test-results/settings-filename.png" });
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await expect
         .poll(async () => (await page.evaluate(() => window.attaClip.state())).preferences)
         .toMatchObject({ filenamePreset: "custom", filenameTemplate: "Moment {source} {date} {time}", folderLayout: "flat" });
   } finally {
      await desktop.close();
   }
});
