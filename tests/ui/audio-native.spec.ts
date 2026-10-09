import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultPreferences } from "../../src/shared/defaults";

test("extra audio rows persist, obey recording boundaries and produce named isolated tracks", async () => {
   test.skip(process.platform !== "win32" || process.env["ATTACLIP_NATIVE_UI"] !== "1", "Requires actual Windows capture and devices");
   test.setTimeout(90_000);
   const profile = await mkdtemp(join(tmpdir(), "attaclip-extra-audio-"));
   const collection = join(profile, "clips");
   await mkdir(collection);
   await writeFile(
      join(profile, "preferences.json"),
      JSON.stringify({
         ...defaultPreferences,
         collection,
         setupComplete: true,
         quality: "custom",
         customWidth: 640,
         customHeight: 360,
         customFPS: 24,
         clipSeconds: 5,
         captureAudio: false,
         sound: false,
      })
   );
   const desktop = await electron.launch({
      args: [resolve("."), "--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile },
   });
   try {
      const page = await desktop.firstWindow();
      await page.getByRole("button", { name: "Add audio source", exact: true }).click();
      await page.getByRole("combobox", { name: "Audio source type", exact: true }).selectOption("output");
      await expect(page.getByRole("combobox", { name: "Audio source", exact: true })).toBeEnabled();
      const devices = await page.evaluate(() => window.attaClip.audioDevices("output"));
      expect(devices.length).toBeGreaterThan(0);
      await page.getByRole("combobox", { name: "Audio source", exact: true }).selectOption(devices[0]!.id);
      await page.getByRole("checkbox", { name: /Include in master mix/ }).uncheck();
      await page.getByRole("button", { name: "Add source", exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).preferences.audioSources.length).toBe(1);
      const source = (await page.evaluate(() => window.attaClip.state())).preferences.audioSources[0]!;
      expect(source).toMatchObject({ kind: "output", includeInMaster: false, enabled: true });
      await page.getByRole("button", { name: "Start recording", exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).recorder.availableSeconds, { timeout: 20_000 }).toBeGreaterThan(3);
      await expect(page.getByRole("button", { name: "Add audio source", exact: true })).toBeDisabled();
      await expect(page.getByRole("checkbox", { name: source.name, exact: true })).toBeDisabled();
      await page.getByRole("slider", { name: `${source.name} level`, exact: true }).fill("0.5");
      await page.getByRole("button", { name: `Mute ${source.name}`, exact: true }).click();
      await expect
         .poll(async () => (await page.evaluate(() => window.attaClip.state())).preferences.audioSources[0])
         .toMatchObject({ volume: 0.5, muted: true });
      await expect(page.locator(".extra-audio")).toContainText("Muted in all recorded tracks");
      await page.getByRole("button", { name: /^Clip it/ }).click();
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).clips.length, { timeout: 20_000 }).toBe(1);
      const saved = (await page.evaluate(() => window.attaClip.state())).clips[0]!;
      expect(saved.tracks.map((track) => track.title)).toEqual(["Master", "Capture audio", source.name]);
      await page.getByRole("button", { name: /^Stop recording/ }).click();
      await page.getByRole("button", { name: `${source.name} options`, exact: true }).click();
      await page.getByRole("button", { name: "Remove source", exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).preferences.audioSources).toEqual([]);
      expect((await page.evaluate(() => window.attaClip.state())).clips[0]?.tracks).toEqual(saved.tracks);
   } finally {
      const page = desktop.windows()[0];
      if (page && !page.isClosed()) await page.evaluate(() => window.attaClip.stopRecording()).catch(() => undefined);
      await desktop.close();
   }
});
