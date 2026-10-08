import { test, expect, _electron as electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { defaultPreferences } from "../../src/shared/defaults";

test("native capture survives preview teardown and saves the selected application pixels", async () => {
   test.skip(process.platform !== "win32" || process.env["ATTACLIP_NATIVE_UI"] !== "1", "Run explicitly on a Windows machine with a working recording driver.");
   test.setTimeout(120000);
   const profile = await mkdtemp(join(tmpdir(), "attaclip-preview-native-"));
   const collection = join(profile, "clips");
   await mkdir(collection, { recursive: true });
   await writeFile(
      join(profile, "preferences.json"),
      JSON.stringify({
         ...defaultPreferences,
         collection,
         setupComplete: true,
         sourceKind: "app",
         sourceId: "window:0:0",
         captureAudio: false,
         clipSeconds: 5,
         quality: "custom",
         customWidth: 640,
         customHeight: 360,
         customFPS: 15,
         allowSoftwareEncoder: true,
         shortcut: "Control+Alt+Shift+F11",
         notifications: "off",
         sound: false,
      })
   );
   const desktop = await electron.launch({
      args: [resolve("."), "--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile },
   });
   try {
      const page = await desktop.firstWindow();
      await desktop.evaluate(async ({ BrowserWindow }) => {
         const fixture = new BrowserWindow({
            title: "Native preview fixture",
            width: 800,
            height: 450,
            x: 100,
            y: 100,
            frame: false,
            backgroundColor: "#e44c66",
            webPreferences: { sandbox: true },
         });
         await fixture.loadURL(
            `data:text/html,${encodeURIComponent('<html><head><title>Native preview fixture</title></head><body style="margin:0;background:#e44c66;color:white;font:26px sans-serif"><div style="padding:25px">Native preview fixture<div id="counter"></div></div><script>let count=0;setInterval(()=>document.querySelector("#counter").textContent=++count,100)</script></body></html>')}`
         );
         fixture.showInactive();
      });
      const source = (await page.evaluate(() => window.attaClip.sources())).find((item) => item.name === "Native preview fixture");
      expect(source).toBeDefined();
      await page.evaluate(async (id) => {
         const state = await window.attaClip.state();
         await window.attaClip.savePreferences({ ...state.preferences, sourceKind: "app", sourceId: id });
      }, source!.id);
      await page.getByRole("button", { name: "Refresh sources", exact: true }).click();
      await expect(page.locator(".preview-note")).toHaveText("Live preview");
      await page.getByRole("button", { name: "Start recording", exact: true }).click();
      await expect.poll(() => page.evaluate(async () => (await window.attaClip.state()).recorder.state), { timeout: 30000 }).toBe("recording");
      await expect
         .poll(() => page.evaluate(async () => (await window.attaClip.state()).recorder.availableSeconds), { timeout: 30000 })
         .toBeGreaterThanOrEqual(3);
      const preview = page.locator(".preview-stream");
      const retain = () =>
         preview.evaluate((video: HTMLVideoElement) => {
            (window as unknown as { previousPreview: MediaStreamTrack[] }).previousPreview = (video.srcObject as MediaStream).getTracks();
         });
      const ended = () =>
         page.evaluate(() => (window as unknown as { previousPreview: MediaStreamTrack[] }).previousPreview.every((track) => track.readyState === "ended"));
      const sample = async () => {
         await desktop.evaluate(({ app }) => app.getAppMetrics());
         const result = [];
         for (let count = 0; count < 4; count++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            result.push(
               await desktop.evaluate(({ app }) =>
                  app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type, cpu: item.cpu.percentCPUUsage, memoryKB: item.memory.workingSetSize }))
               )
            );
         }
         return result;
      };
      const visibleMetrics = await sample();
      await retain();
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect.poll(ended).toBe(true);
      const hiddenMetrics = await sample();
      expect((await page.evaluate(() => window.attaClip.state())).recorder.state).toBe("recording");
      await page.getByRole("button", { name: "Recording", exact: true }).click();
      await expect(page.locator(".preview-note")).toHaveText("Live preview");
      await retain();
      await page.evaluate(() => window.attaClip.window("minimize"));
      await expect.poll(ended).toBe(true);
      expect((await page.evaluate(() => window.attaClip.state())).recorder.state).toBe("recording");
      await desktop.evaluate(({ BrowserWindow }) => {
         const main = BrowserWindow.getAllWindows().find((window) => window.getTitle() === "AttaClip");
         main?.restore();
         main?.show();
      });
      await expect(page.locator(".preview-note")).toHaveText("Live preview");
      await retain();
      await page.evaluate(() => window.attaClip.window("close"));
      await expect.poll(ended).toBe(true);
      expect((await page.evaluate(() => window.attaClip.state())).recorder.state).toBe("recording");
      await page.evaluate(() => window.attaClip.saveClip());
      await expect.poll(() => page.evaluate(async () => (await window.attaClip.state()).clips.length), { timeout: 30000 }).toBe(1);
      const clip = (await page.evaluate(() => window.attaClip.state())).clips[0]!;
      expect(clip.width).toBe(640);
      expect(clip.height).toBe(360);
      expect(clip.duration).toBeGreaterThanOrEqual(4.5);
      expect(clip.source).toBe("Native preview fixture");
      const ffmpeg = resolve("resources/media/ffmpeg.exe");
      await promisify(execFile)(ffmpeg, ["-v", "error", "-i", clip.path, "-f", "null", "-"], { windowsHide: true });
      const pixel = await promisify(execFile)(
         ffmpeg,
         ["-v", "error", "-ss", "1", "-i", clip.path, "-vf", "crop=2:2:iw/2:ih/2,scale=1:1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
         { windowsHide: true, encoding: "buffer" }
      );
      expect(pixel.stdout.length).toBe(3);
      for (const [index, expected] of [228, 76, 102].entries()) expect(Math.abs(pixel.stdout[index]! - expected)).toBeLessThan(15);
      const measurements = {
         visibleMetrics,
         hiddenMetrics,
         note: "Electron process metrics with native recording active in both states. Native helper CPU is excluded. One 15fps preview capped at960×540.",
      };
      await writeFile("test-results/preview-cost.json", JSON.stringify(measurements, null, 2));
      await test.info().attach("preview process cost", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
      await page.evaluate(() => window.attaClip.stopRecording());
   } finally {
      const page = await desktop.firstWindow();
      await page.evaluate(() => window.attaClip.stopRecording()).catch(() => undefined);
      await desktop.evaluate(({ BrowserWindow }) => {
         for (const window of BrowserWindow.getAllWindows()) {
            if (window.getTitle() !== "AttaClip") window.destroy();
            else {
               window.restore();
               window.show();
            }
         }
      });
      await desktop.close();
   }
});
