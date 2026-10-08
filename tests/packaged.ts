import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { defaultPreferences } from "../src/shared/defaults";

// This captures the selected screen. Run manually on a supported Windows/NVIDIA
// machine, against the unpacked application rather than the development runtime.
if (process.platform !== "win32") throw new Error("Packaged capture verification requires Windows");
const profile = await mkdtemp(join(tmpdir(), "attaclip-packaged-"));
const collection = join(profile, "clips");
await mkdir(collection);
await writeFile(
   join(profile, "preferences.json"),
   JSON.stringify({
      ...defaultPreferences,
      collection,
      setupComplete: true,
      clipSeconds: 10,
      quality: "low",
      shortcut: "Control+Alt+Shift+F12",
      notifications: "off",
      sound: false,
   })
);
const application = await electron.launch({
   executablePath: resolve("release/win-unpacked/AttaClip.exe"),
   args: ["--disable-gpu-sandbox"],
   env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile, ATTACLIP_COLLECTION: collection },
});
try {
   const page = await application.firstWindow();
   await page.waitForFunction(() => !!window.attaClip);
   const sources = await page.evaluate(() => window.attaClip.sources());
   const source = sources.find((item) => item.kind === "screen");
   assert(source, "A screen source must be available");
   await page.evaluate(async (id) => {
      const state = await window.attaClip.state();
      await window.attaClip.savePreferences({ ...state.preferences, sourceId: id, sourceKind: "screen" });
      await window.attaClip.startRecording();
   }, source.id);
   await expect.poll(() => page.evaluate(async () => (await window.attaClip.state()).recorder.state), { timeout: 30000 }).toBe("recording");
   await expect.poll(() => page.evaluate(async () => (await window.attaClip.state()).recorder.availableSeconds), { timeout: 30000 }).toBeGreaterThanOrEqual(5);
   await page.evaluate(() => window.attaClip.saveClip());
   await page.waitForTimeout(1000);
   await page.evaluate(async () => {
      await window.attaClip.saveClip();
      await window.attaClip.stopRecording();
   });
   await expect
      .poll(
         () =>
            page.evaluate(async () => {
               const state = await window.attaClip.state();
               return state.clips.length === 2 && state.recorder.pendingSaves === 0;
            }),
         { timeout: 60000 }
      )
      .toBe(true);
   const state = await page.evaluate(() => window.attaClip.state());
   assert.equal(state.recorder.state, "stopped");
   assert.equal(state.recorder.availableSeconds, 0);
   const clip = state.clips[0]!;
   assert(clip.duration >= 4, "Queued capture must retain footage when stopped");
   assert(clip.tracks.length >= 2, "Master and capture audio must exist");
   const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
   const originalHash = hash(await readFile(clip.path));
   const ffmpeg = resolve("release/win-unpacked/resources/media/ffmpeg.exe");
   for (const saved of state.clips) await promisify(execFile)(ffmpeg, ["-v", "error", "-i", saved.path, "-f", "null", "-"], { windowsHide: true });
   await page.evaluate((id) => window.attaClip.createShareable(id, 1), clip.id);
   await expect
      .poll(() => page.evaluate(async (id) => (await window.attaClip.state()).clips.find((item) => item.id === id)?.shareables.length, clip.id), {
         timeout: 120000,
      })
      .toBe(1);
   const updated = await page.evaluate(() => window.attaClip.state());
   const shareable = updated.clips.find((item) => item.id === clip.id)!.shareables[0]!;
   assert((await stat(shareable.path)).size <= 1_000_000);
   assert.equal(hash(await readFile(clip.path)), originalHash);
   await promisify(execFile)(ffmpeg, ["-v", "error", "-i", shareable.path, "-f", "null", "-"], { windowsHide: true });
   const url = await page.evaluate((file) => window.attaClip.playback(file), clip.path);
   await page.evaluate(async (url) => {
      const video = document.createElement("video");
      video.muted = true;
      document.body.appendChild(video);
      await new Promise<void>((resolve, reject) => {
         video.onloadeddata = () => resolve();
         video.onerror = () => reject(new Error("Packaged original playback failed"));
         video.src = url;
      });
      if (video.videoWidth === 0) throw new Error("Playback did not decode a video frame");
      video.remove();
   }, url);
   console.log(
      `Packaged capture, repeated saves followed by stop, separate audio, full decoding, playback, and size-limited sharing passed. Isolated files: ${profile}`
   );
} finally {
   await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
   await application.close().catch(() => undefined);
}
