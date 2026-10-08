import { _electron as electron, chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { defaultPreferences } from "../src/shared/defaults";

// This captures the selected screen. Windows uses the real desktop. The Linux
// runner supplies a private X11/PulseAudio fixture and explicit software opt-in.
if (process.platform !== "win32" && process.platform !== "linux") throw new Error("Packaged capture verification requires Windows or Linux X11");
const linux = process.platform === "linux";
if (linux && process.env["ATTACLIP_PACKAGED_PRIVATE_X11"] !== "1") throw new Error("Use scripts/test-linux-packaged.py for isolated Linux capture.");
const profile = await mkdtemp(join(tmpdir(), "attaclip-packaged-"));
const collection = join(profile, "clips");
const executable = resolve(process.env["ATTACLIP_PACKAGED_EXE"] ?? (linux ? "release/linux-unpacked/attaclip" : "release/win-unpacked/AttaClip.exe"));
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
      allowSoftwareEncoder: linux,
   })
);
const portable = process.env["ATTACLIP_PACKAGED_PORTABLE"] === "1";
let closeApplication: (() => Promise<void>) | undefined;
try {
   let page;
   if (portable) {
      const reservation = createServer();
      await new Promise<void>((resolve, reject) => {
         reservation.once("error", reject);
         reservation.listen(0, "127.0.0.1", resolve);
      });
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("Could not reserve a portable test port");
      await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
      const launcher = spawn(executable, [`--remote-debugging-port=${address.port}`, "--disable-gpu-sandbox"], {
         windowsHide: true,
         stdio: "ignore",
         env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile, ATTACLIP_COLLECTION: collection },
      });
      closeApplication = async () => {
         if (launcher.exitCode === null) launcher.kill();
      };
      const endpoint = `http://127.0.0.1:${address.port}`;
      const deadline = Date.now() + 60000;
      while (true) {
         try {
            if ((await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) break;
         } catch {
            /* The launcher is still extracting. */
         }
         if (Date.now() >= deadline) throw new Error("Portable application did not open its test connection");
         await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const browser = await chromium.connectOverCDP(endpoint);
      page = browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error("Portable application did not open its window");
      const portablePage = page;
      closeApplication = async () => {
         await portablePage.evaluate(() => window.attaClip.exit()).catch(() => undefined);
         await browser.close().catch(() => undefined);
         if (launcher.exitCode === null) launcher.kill();
      };
   } else {
      const application = await electron.launch({
         executablePath: executable,
         args: linux ? ["--no-sandbox", "--disable-gpu-sandbox"] : ["--disable-gpu-sandbox"],
         env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile, ATTACLIP_COLLECTION: collection },
      });
      closeApplication = async () => {
         await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
         await application.close().catch(() => undefined);
      };
      page = await application.firstWindow();
   }
   await page.waitForFunction(() => !!window.attaClip);
   const sources = await page.evaluate(() => window.attaClip.sources());
   const source = sources.find((item) => item.kind === "screen");
   assert(source, "A screen source must be available");
   await page.evaluate(async (id) => {
      const state = await window.attaClip.state();
      await window.attaClip.savePreferences({ ...state.preferences, sourceId: id, sourceKind: "screen" });
   }, source.id);
   await page.evaluate(async () => {
      const starting = window.attaClip.startRecording();
      const state = await window.attaClip.state();
      let blocked = false;
      try {
         await window.attaClip.savePreferences({ ...state.preferences, quality: "high" });
      } catch {
         blocked = true;
      }
      if (!blocked) throw new Error("Settings changed during capture startup");
      await starting;
   });
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
   for (const saved of state.clips) assert.equal(saved.source, source.name, "Each completed clip must register its actual capture source");
   const clip = state.clips[0]!;
   assert(clip.duration >= 4, "Queued capture must retain footage when stopped");
   assert(clip.tracks.length >= 2, "Master and capture audio must exist");
   const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
   const originalHash = hash(await readFile(clip.path));
   const ffmpeg = portable
      ? resolve("release/win-unpacked/resources/media/ffmpeg.exe")
      : join(dirname(executable), "resources/media", linux ? "ffmpeg" : "ffmpeg.exe");
   for (const saved of state.clips) await promisify(execFile)(ffmpeg, ["-v", "error", "-i", saved.path, "-f", "null", "-"], { windowsHide: true });
   if (linux) {
      const frame = await promisify(execFile)(
         ffmpeg,
         ["-v", "error", "-ss", "1", "-i", clip.path, "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"],
         { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }
      );
      assert(frame.stdout.length > 0, "The packaged capture must decode real pixels");
      const mean = frame.stdout.reduce((sum, value) => sum + value, 0) / frame.stdout.length;
      assert(mean > 10, "The packaged X11 fixture must appear in the captured frame");
      for (const track of [0, 1]) {
         const audio = await promisify(execFile)(ffmpeg, ["-hide_banner", "-i", clip.path, "-map", `0:a:${track}`, "-af", "volumedetect", "-f", "null", "-"]);
         const level = /mean_volume: (-?[\d.]+) dB/.exec(audio.stderr)?.[1];
         assert(level && Number(level) > -40 && Number(level) < -15, "The private tone must exist in both master and isolated capture audio");
      }
   }
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
   await closeApplication?.();
}
