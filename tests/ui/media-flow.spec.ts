import { test, expect, _electron as electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { defaultPreferences } from "../../src/shared/defaults";

test("real media plays, creates a verified shareable, and supports overlapping categories", async () => {
   test.setTimeout(120000);
   const profile = await mkdtemp(join(tmpdir(), "attaclip-media-ui-"));
   const collection = join(profile, "clips");
   await mkdir(collection, { recursive: true });
   const source = join(collection, "Desktop moment.mp4");
   await promisify(execFile)(
      resolve("resources/media/ffmpeg.exe"),
      [
         "-hide_banner",
         "-loglevel",
         "error",
         "-f",
         "lavfi",
         "-i",
         "testsrc2=size=960x540:rate=30",
         "-f",
         "lavfi",
         "-i",
         "sine=frequency=440:sample_rate=48000",
         "-f",
         "lavfi",
         "-i",
         "sine=frequency=880:sample_rate=48000",
         "-t",
         "6",
         "-map",
         "0:v",
         "-map",
         "1:a",
         "-map",
         "2:a",
         "-c:v",
         "libx264",
         "-preset",
         "ultrafast",
         "-crf",
         "18",
         "-c:a",
         "aac",
         "-metadata:s:a:0",
         "title=Master",
         "-metadata:s:a:1",
         "title=Microphone",
         source,
      ],
      { windowsHide: true }
   );
   const originalHash = createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
   await writeFile(join(profile, "preferences.json"), JSON.stringify({ ...defaultPreferences, collection, setupComplete: true, shareSizeMB: 1 }));
   const desktop = await electron.launch({
      args: [resolve("."), "--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile },
   });
   try {
      const page = await desktop.firstWindow();
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect(page.getByRole("button", { name: "Open Desktop moment", exact: true })).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(350);
      await page.screenshot({ path: "test-results/library-populated.png" });
      await page.getByRole("button", { name: "New category", exact: true }).first().click();
      await page.getByRole("textbox", { name: "New category", exact: true }).fill("Best moments");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByRole("button", { name: /Best moments/ }).first()).toBeVisible();
      await page.getByRole("button", { name: "New category", exact: true }).first().click();
      await page.getByRole("textbox", { name: "New category", exact: true }).fill("Funny");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await page.locator(".clip-card").hover();
      await page.getByRole("button", { name: "Actions for Desktop moment", exact: true }).click();
      await page.getByRole("menuitem", { name: "Categories", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Clip categories" });
      await dialog.getByRole("button", { name: "Best moments", exact: true }).click();
      await dialog.getByRole("button", { name: "Funny", exact: true }).click();
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).clips[0]?.categories.length).toBe(2);
      await page.getByRole("button", { name: "Open Desktop moment", exact: true }).click();
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.readyState), { timeout: 30000 }).toBeGreaterThanOrEqual(2);
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(0.2);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.getByRole("slider", { name: "Playback position", exact: true }).fill("2");
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThanOrEqual(1.9);
      await page.getByRole("combobox", { name: "Audio track", exact: true }).selectOption("2");
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.readyState), { timeout: 30000 }).toBeGreaterThanOrEqual(2);
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThanOrEqual(1.9);
      await page.waitForTimeout(350);
      await page.screenshot({ path: "test-results/viewer-original.png" });
      await page.getByRole("button", { name: "Create shareable", exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).clips[0]?.shareables.length, { timeout: 90000 }).toBe(1);
      const result = await page.evaluate(() => window.attaClip.state());
      expect(result.clips[0]?.shareables[0]?.size).toBeLessThanOrEqual(1000000);
      expect(
         createHash("sha256")
            .update(await readFile(source))
            .digest("hex")
      ).toBe(originalHash);
      await page.getByRole("button", { name: "Shareable", exact: true }).click();
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.readyState), { timeout: 30000 }).toBeGreaterThanOrEqual(2);
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThanOrEqual(1.9);
      await page.waitForTimeout(350);
      await page.screenshot({ path: "test-results/viewer-shareable.png" });
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
      await page.evaluate(() => window.attaClip.window("minimize"));
      await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(true);
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
      await desktop.evaluate(({ BrowserWindow }) => {
         const window = BrowserWindow.getAllWindows()[0];
         window?.restore();
         window?.show();
      });
      await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(false);
      await expect.poll(() => page.locator("video").evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
      await page.getByRole("button", { name: "Library", exact: true }).first().click();
      await page
         .getByRole("button", { name: /Best moments/ })
         .first()
         .click();
      await expect(page.getByRole("button", { name: "Open Desktop moment", exact: true })).toBeVisible();
      await page
         .getByRole("button", { name: /^Funny/ })
         .first()
         .click();
      await expect(page.getByRole("button", { name: "Open Desktop moment", exact: true })).toBeVisible();
   } finally {
      await desktop.close();
   }
});
