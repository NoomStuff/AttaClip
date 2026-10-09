import { _electron as electron, expect } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { defaultPreferences } from "../src/shared/defaults";
import type { AdditionalAudioSource } from "../src/shared/types";

if (process.platform !== "darwin") throw new Error("Packaged Mac recording requires an actual macOS host.");
const run = promisify(execFile);
const folder = await mkdtemp(path.join(tmpdir(), "attaclip-mac-packaged-"));
const collection = path.join(folder, "clips");
await mkdir(collection);
const evidence = path.resolve(".cache/macos-packaged");
await mkdir(evidence, { recursive: true });
const fixtureContents = path.join(folder, "Fixture.app", "Contents");
await mkdir(path.join(fixtureContents, "MacOS"), { recursive: true });
await copyFile(path.resolve("native/macos/fixture-Info.plist"), path.join(fixtureContents, "Info.plist"));
const binary = path.join(fixtureContents, "MacOS", "fixture");
await run("swiftc", [path.resolve("native/macos/fixture.swift"), "-o", binary]);
const fixtureOutput = path.join(folder, "fixture-output.jsonl");
const fixture = spawn("open", ["-n", "-W", path.dirname(fixtureContents), "--args", fixtureOutput], { stdio: ["ignore", "pipe", "pipe"] });
const fixtureErrors: string[] = [];
const fixtureHealth: Array<{ engineRunning: boolean; renderedFrames: number }> = [];
fixture.stderr.on("data", (data: Buffer) => fixtureErrors.push(data.toString()));
async function waitForFixture(outputPath = fixtureOutput) {
   const deadline = Date.now() + 20000;
   while (Date.now() < deadline) {
      const output = await readFile(outputPath, "utf8").catch(() => "");
      if (output.includes("\n")) {
         return z
            .object({ pid: z.number().int().positive(), windowId: z.number().int().positive(), audioStarted: z.boolean() })
            .parse(JSON.parse(output.split("\n")[0]!));
      }
      await delay(50);
   }
   throw new Error("The synthetic Mac fixture did not start");
}
const identity = await waitForFixture().catch(async (error: unknown) => {
   await writeFile(`${fixtureOutput}.stop`, "");
   fixture.kill();
   throw error;
});
if (!identity.audioStarted) {
   await writeFile(`${fixtureOutput}.stop`, "");
   fixture.kill();
   throw new Error("The runner could not play the generated tone, so packaged audio capture cannot be proven");
}
const decoyContents = path.join(folder, "Decoy.app", "Contents");
await mkdir(path.join(decoyContents, "MacOS"), { recursive: true });
await writeFile(
   path.join(decoyContents, "Info.plist"),
   (await readFile(path.resolve("native/macos/fixture-Info.plist"), "utf8")).replace("dev.attaclip.capture-fixture", "dev.attaclip.capture-decoy")
);
await copyFile(binary, path.join(decoyContents, "MacOS", "fixture"));
const decoyOutput = path.join(folder, "decoy-output.jsonl");
const decoy = spawn("open", ["-n", "-W", path.dirname(decoyContents), "--args", decoyOutput, "1613", "compact"], { stdio: ["ignore", "ignore", "pipe"] });
decoy.stderr.on("data", (data: Buffer) => fixtureErrors.push(data.toString()));
const decoyIdentity = await waitForFixture(decoyOutput).catch(async (error: unknown) => {
   await writeFile(`${fixtureOutput}.stop`, "");
   await writeFile(`${decoyOutput}.stop`, "");
   fixture.kill();
   decoy.kill();
   throw error;
});
if (!decoyIdentity.audioStarted) {
   await writeFile(`${fixtureOutput}.stop`, "");
   await writeFile(`${decoyOutput}.stop`, "");
   fixture.kill();
   decoy.kill();
   throw new Error("The independent decoy tone did not start");
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
const ffmpeg = path.resolve("resources/media/ffmpeg");
const ffprobe = path.resolve("resources/media/ffprobe");
async function tones(file: string, track: number) {
   const { stdout } = await run(ffmpeg, ["-v", "error", "-i", file, "-map", `0:a:${track}`, "-ac", "1", "-ar", "48000", "-t", "1", "-f", "f32le", "-"], {
      encoding: "buffer",
   });
   const count = stdout.length / 4;
   expect(count).toBeGreaterThanOrEqual(24000);
   return [997, 1613].map((frequency) => {
      let sine = 0;
      let cosine = 0;
      for (let index = 0; index < count; index++) {
         const sample = stdout.readFloatLE(index * 4);
         const phase = (2 * Math.PI * frequency * index) / 48000;
         sine += sample * Math.sin(phase);
         cosine += sample * Math.cos(phase);
      }
      return (2 * Math.hypot(sine, cosine)) / count;
   });
}
function onlySelected(tone: number[]) {
   expect(tone[0]).toBeGreaterThan(0.03);
   expect(tone[1]).toBeLessThan(tone[0]! / 8);
}
try {
   desktop = await electron.launch({
      executablePath: executable,
      args: ["--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: folder },
      timeout: 60000,
   });
   const page = await desktop.firstWindow();
   await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
   const selected = (await page.evaluate(() => window.attaClip.games())).find((candidate) => candidate.pid === identity.pid);
   expect(selected).toBeDefined();
   const audioSources: AdditionalAudioSource[] = [
      {
         id: "selected",
         name: "Selected app",
         kind: "application",
         sourceId: selected!.id,
         executable: selected!.executable,
         deviceId: "",
         enabled: true,
         volume: 1,
         muted: false,
         includeInMaster: false,
      },
      {
         id: "system",
         name: "System audio",
         kind: "output",
         sourceId: "",
         executable: "",
         deviceId: "system",
         enabled: true,
         volume: 1,
         muted: false,
         includeInMaster: false,
      },
   ];
   await page.evaluate(async (sources) => {
      const current = await window.attaClip.state();
      await window.attaClip.savePreferences({ ...current.preferences, audioSources: sources });
   }, audioSources);
   expect(await page.evaluate(() => window.attaClip.audioDevices("output"))).toEqual([{ id: "system", name: "System audio" }]);
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
   const audioEvidence: Array<{ clip: string; tones: number[][] }> = [];
   for (const clip of state.clips) {
      await run(ffmpeg, ["-v", "error", "-i", clip.path, "-map", "0", "-f", "null", "-"]);
      const { stdout: metadata } = await run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", clip.path]);
      const audio = z
         .object({ streams: z.array(z.object({ codec_type: z.string(), tags: z.object({ title: z.string().optional() }).optional() })) })
         .parse(JSON.parse(metadata)).streams;
      expect(audio.filter((stream) => stream.codec_type === "audio").map((stream) => stream.tags?.title)).toEqual([
         "Master",
         "Capture audio",
         "Selected app",
         "System audio",
      ]);
      for (const track of [0, 1, 2, 3]) {
         const { stderr } = await run(ffmpeg, ["-hide_banner", "-i", clip.path, "-map", `0:a:${track}`, "-af", "volumedetect", "-f", "null", "-"]);
         const mean = stderr.match(/mean_volume: (-?[\d.]+) dB/);
         expect(mean).not.toBeNull();
         expect(Number(mean![1])).toBeGreaterThan(-55);
      }
      const measured = await Promise.all([0, 1, 2, 3].map((track) => tones(clip.path, track)));
      for (const tone of measured.slice(0, 3)) onlySelected(tone);
      expect(Math.min(...measured[3]!)).toBeGreaterThan(0.03);
      expect(measured[0]![0]! / measured[1]![0]!).toBeGreaterThan(0.8);
      expect(measured[0]![0]! / measured[1]![0]!).toBeLessThan(1.2);
      audioEvidence.push({ clip: clip.id, tones: measured });
      const { stdout } = await run(
         ffmpeg,
         ["-v", "error", "-i", clip.path, "-vf", "crop=2:2:iw/2:ih/2,scale=1:1", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
         { encoding: "buffer" }
      );
      expect(stdout.length).toBeGreaterThanOrEqual(6);
      expect(stdout.length % 3).toBe(0);
      const classes = new Set<number>();
      for (let offset = 0; offset < stdout.length; offset += 3) {
         const color = [
            [228, 76, 102],
            [65, 184, 170],
         ].findIndex((fixtureColor) => fixtureColor.every((channel, index) => Math.abs(channel - stdout[offset + index]!) <= 22));
         expect(color).toBeGreaterThanOrEqual(0);
         classes.add(color);
      }
      expect([...classes].sort()).toEqual([0, 1]);
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
            everyDecodedFrameMatchedFixture: true,
            changingFixtureColorsTested: true,
            originalPreserved: true,
            oneMBShareableTested: true,
            fixtureAudioStarted: identity.audioStarted,
            generatedApplicationAudioTested: true,
            selectedApplicationAudioIsolationTested: true,
            systemMixTested: true,
            masterExclusionTested: true,
            audioEvidence,
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
   await writeFile(`${fixtureOutput}.stop`, "");
   await writeFile(`${decoyOutput}.stop`, "");
   for (const line of (await readFile(fixtureOutput, "utf8").catch(() => "")).split("\n").slice(1)) {
      if (!line) continue;
      try {
         const value = z.object({ event: z.literal("audio-health"), engineRunning: z.boolean(), renderedFrames: z.number() }).safeParse(JSON.parse(line));
         if (value.success) fixtureHealth.push(value.data);
      } catch {
         // A final partial diagnostic line must not block process cleanup.
      }
   }
   await writeFile(path.join(evidence, "fixture.log"), fixtureErrors.join(""));
   await writeFile(path.join(evidence, "fixture-health.json"), JSON.stringify(fixtureHealth, null, 2));
   if (desktop) await desktop.close();
   fixture.kill();
   decoy.kill();
}
