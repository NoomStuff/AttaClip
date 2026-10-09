import { _electron as electron, expect } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { z } from "zod";
import { defaultPreferences } from "../src/shared/defaults";

if (process.platform !== "darwin") throw new Error("Packaged Mac recording requires an actual macOS host.");
const run = promisify(execFile);
const folder = await mkdtemp(path.join(tmpdir(), "attaclip-mac-packaged-"));
const collection = path.join(folder, "clips");
await mkdir(collection);
const evidence = path.resolve(".cache/macos-packaged");
await mkdir(evidence, { recursive: true });
const binary = path.join(folder, "fixture");
await run("swiftc", [path.resolve("native/macos/fixture.swift"), "-o", binary]);
const fixture = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
const fixtureErrors: string[] = [];
const fixtureHealth: Array<{ engineRunning: boolean; renderedFrames: number }> = [];
fixture.stderr.on("data", (data: Buffer) => fixtureErrors.push(data.toString()));
const identity = await new Promise<{ windowId: number; audioStarted: boolean }>((resolve, reject) => {
   const input = createInterface({ input: fixture.stdout });
   input.on("line", (line) => {
      try {
         const value = z.object({ event: z.literal("audio-health"), engineRunning: z.boolean(), renderedFrames: z.number() }).safeParse(JSON.parse(line));
         if (value.success) fixtureHealth.push(value.data);
      } catch {
         // Initial identity is handled separately; fixture diagnostics cannot alter capture.
      }
   });
   const timeout = setTimeout(() => {
      fixture.kill();
      reject(new Error("The synthetic Mac fixture did not start"));
   }, 20000);
   input.once("line", (line) => {
      clearTimeout(timeout);
      try {
         resolve(z.object({ windowId: z.number().int().positive(), audioStarted: z.boolean() }).parse(JSON.parse(line)));
      } catch (error) {
         fixture.kill();
         reject(error);
      }
   });
   fixture.once("error", reject);
});
if (!identity.audioStarted) {
   fixture.kill();
   throw new Error("The runner could not play the generated tone, so packaged audio capture cannot be proven");
}
await writeFile(
   path.join(folder, "preferences.json"),
   JSON.stringify({
      ...defaultPreferences,
      collection,
      setupComplete: true,
      sourceKind: "app",
      sourceId: `window:${identity.windowId}:0`,
      quality: "custom",
      customWidth: 640,
      customHeight: 360,
      customFPS: 15,
      customCQ: 28,
      clipSeconds: 5,
      allowSoftwareEncoder: true,
      microphone: false,
      captureAudio: true,
      notifications: "off",
      sound: false,
      shortcut: "Control+Alt+Shift+F12",
   })
);
const executable =
   process.env["ATTACLIP_MAC_PACKAGED_EXE"] ?? path.resolve(`release/mac${process.arch === "arm64" ? "-arm64" : ""}/AttaClip.app/Contents/MacOS/AttaClip`);
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
   desktop = await electron.launch({
      executablePath: executable,
      args: ["--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: folder },
      timeout: 60000,
   });
   const page = await desktop.firstWindow();
   await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
   await page.getByRole("button", { name: "Start recording", exact: true }).click();
   await expect.poll(() => page.evaluate(async () => (await window.attaClip.state()).recorder.state), { timeout: 30000 }).toBe("recording");
   await expect
      .poll(() => page.evaluate(async () => (await window.attaClip.state()).recorder.availableSeconds), { timeout: 30000 })
      .toBeGreaterThanOrEqual(4.9);
   await page.getByRole("button", { name: "Library", exact: true }).click();
   expect((await page.evaluate(() => window.attaClip.state())).recorder.state).toBe("recording");
   await page.evaluate(() => window.attaClip.window("minimize"));
   expect((await page.evaluate(() => window.attaClip.state())).recorder.state).toBe("recording");
   await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.restore();
      window?.show();
   });
   await page.evaluate(() => window.attaClip.window("close"));
   expect((await page.evaluate(() => window.attaClip.state())).recorder.state).toBe("recording");
   await page.evaluate(() => window.attaClip.saveClip());
   await page.waitForTimeout(100);
   await page.evaluate(() => window.attaClip.saveClip());
   await page.evaluate(() => window.attaClip.stopRecording());
   await expect.poll(() => page.evaluate(async () => (await window.attaClip.state()).clips.length), { timeout: 60000 }).toBe(2);
   const state = await page.evaluate(() => window.attaClip.state());
   const original = state.clips[0]!;
   expect(original.width).toBe(640);
   expect(original.height).toBe(360);
   expect(original.duration).toBeGreaterThanOrEqual(4.5);
   expect(original.source).toContain("Mac capture fixture");
   const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
   const hash = digest(await readFile(original.path));
   const ffmpeg = path.resolve("resources/media/ffmpeg");
   const ffprobe = path.resolve("resources/media/ffprobe");
   for (const clip of state.clips) {
      await run(ffmpeg, ["-v", "error", "-i", clip.path, "-map", "0", "-f", "null", "-"]);
      const { stdout: metadata } = await run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", clip.path]);
      const audio = z.object({ streams: z.array(z.object({ codec_type: z.string() })) }).parse(JSON.parse(metadata)).streams;
      expect(audio.filter((stream) => stream.codec_type === "audio")).toHaveLength(2);
      for (const track of [0, 1]) {
         const { stderr } = await run(ffmpeg, ["-hide_banner", "-i", clip.path, "-map", `0:a:${track}`, "-af", "volumedetect", "-f", "null", "-"]);
         const mean = stderr.match(/mean_volume: (-?[\d.]+) dB/);
         expect(mean).not.toBeNull();
         expect(Number(mean![1])).toBeGreaterThan(-55);
      }
      const { stdout } = await run(
         ffmpeg,
         ["-v", "error", "-ss", "1", "-i", clip.path, "-vf", "crop=2:2:iw/2:ih/2,scale=1:1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
         { encoding: "buffer" }
      );
      expect(stdout.length).toBe(3);
      expect(
         [
            [228, 76, 102],
            [65, 184, 170],
         ].some((color) => color.every((channel, index) => Math.abs(channel - stdout[index]!) <= 22))
      ).toBe(true);
   }
   await page.evaluate((id) => window.attaClip.createShareable(id, 1), original.id);
   await expect.poll(() => page.evaluate(async () => (await window.attaClip.state()).clips[0]?.shareables.length), { timeout: 90000 }).toBe(1);
   expect(digest(await readFile(original.path))).toBe(hash);
   const copy = (await page.evaluate(() => window.attaClip.state())).clips[0]!.shareables[0]!;
   expect((await stat(copy.path)).size).toBeLessThanOrEqual(1000000);
   await run(ffmpeg, ["-v", "error", "-i", copy.path, "-map", "0", "-f", "null", "-"]);
   await writeFile(
      path.join(evidence, "proof.json"),
      JSON.stringify(
         {
            schema: 1,
            actualPackagedApp: true,
            windowCaptureTested: true,
            hiddenRecordingTested: true,
            repeatedSavesThroughStopTested: true,
            originalPreserved: true,
            oneMBShareableTested: true,
            fixtureAudioStarted: identity.audioStarted,
            generatedApplicationAudioTested: true,
            original: { duration: original.duration, width: original.width, height: original.height, source: original.source, sha256: hash },
            shareableBytes: (await stat(copy.path)).size,
            physicalMicrophoneTested: false,
            permissionPromptsTested: false,
         },
         null,
         2
      )
   );
   console.log("Actual packaged macOS application capture, hidden saves, full decoding, and 1 MB sharing passed.");
} finally {
   await writeFile(path.join(evidence, "fixture.log"), fixtureErrors.join(""));
   await writeFile(path.join(evidence, "fixture-health.json"), JSON.stringify(fixtureHealth, null, 2));
   if (desktop) await desktop.close();
   fixture.kill();
}
