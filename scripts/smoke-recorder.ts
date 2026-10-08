import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (process.platform !== "win32") throw new Error("This real capture smoke test requires Windows");
const software = Boolean(process.env["ATTACLIP_NATIVE_TEST_SOFTWARE"]);
const runtime = path.resolve("resources/recorder");
const folder = path.resolve(".cache", "native-smoke", randomUUID());
await mkdir(folder, { recursive: true });
const log: string[] = [];
interface Event {
   event: string;
   requestId?: string;
   path?: string;
   source?: string;
   message?: string;
   devices?: unknown[];
   id?: string;
   encoder?: string;
}
const events: Event[] = [];
const child = spawn(path.join(runtime, "attaclip-recorder.exe"), [runtime], { cwd: runtime, stdio: "pipe", windowsHide: true });
child.stderr.on("data", (data: Buffer) => log.push(data.toString()));
createInterface({ input: child.stdout }).on("line", (line) => events.push(JSON.parse(line) as Event));
const send = (value: Record<string, unknown>): void => {
   child.stdin.write(`${JSON.stringify(value)}\n`);
};
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function wait(predicate: (event: Event) => boolean): Promise<Event> {
   const deadline = Date.now() + 20_000;
   while (Date.now() < deadline) {
      const event = events.find(predicate);
      if (event) return event;
      if (child.exitCode !== null) throw new Error(`Native recorder exited with ${child.exitCode}`);
      await delay(20);
   }
   throw new Error(`Recorder timed out. Events: ${JSON.stringify(events)}`);
}
try {
   await wait((event) => event.event === "ready");
   send({ action: "audio-devices" });
   const devices = await wait((event) => event.event === "audio-devices");
   assert(Array.isArray(devices.devices));
   if (software) {
      send({
         action: "start",
         id: "software-denied",
         sourceKind: "screen",
         screenIndex: 0,
         quality: "low",
         clipSeconds: 2,
         captureAudio: false,
         microphone: false,
         allowSoftwareEncoder: false,
      });
      const denied = await wait((event) => event.id === "software-denied");
      assert.equal(denied.event, "error");
      assert(denied.message?.includes("Software"), denied.message ?? "The missing hardware encoder must require software opt-in");
      send({ action: "stop" });
   }
   send({
      action: "start",
      sourceKind: "screen",
      screenIndex: 0,
      sourceName: "Initial screen",
      clipSeconds: 2,
      quality: "low",
      microphone: false,
      captureAudio: true,
      allowSoftwareEncoder: software,
   });
   const recording = await wait((event) => event.event === "recording");
   assert(software ? recording.encoder === "obs_x264" : recording.encoder?.startsWith("obs_nvenc"), recording.encoder ?? "The actual encoder must be reported");
   await delay(4000);
   const first = path.join(folder, "first.mkv");
   const second = path.join(folder, "second.mkv");
   send({ action: "save", requestId: "first", path: first });
   send({ action: "save", requestId: "second", path: second });
   // Source switches and immediate Stop must not relabel or discard accepted saves.
   send({ action: "source", sourceKind: "screen", screenIndex: 0, sourceName: "Changed screen", captureAudio: true });
   send({ action: "stop" });
   const firstSaved = await wait((event) => event.event === "saved" && event.requestId === "first");
   const secondSaved = await wait((event) => event.event === "saved" && event.requestId === "second");
   assert.equal(firstSaved.source, "Initial screen");
   assert.equal(secondSaved.source, "Initial screen");
   for (const file of [first, second]) {
      const probe = spawnSync(
         path.resolve("resources/media/ffprobe.exe"),
         ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height:stream_tags=title", "-of", "json", file],
         { encoding: "utf8", windowsHide: true }
      );
      assert.equal(probe.status, 0, probe.stderr);
      const media = JSON.parse(probe.stdout) as {
         format: { duration: string };
         streams: Array<{ codec_name: string; width?: number; height?: number; tags?: { title?: string } }>;
      };
      assert.equal(media.streams[0]?.codec_name, "h264");
      assert.equal(media.streams[0]?.width, 1280);
      assert.equal(media.streams[0]?.height, 720);
      assert.deepEqual(
         media.streams.slice(1).map((stream) => stream.tags?.title),
         ["Master", "Capture audio"]
      );
      assert(Number(media.format.duration) > 1.5 && Number(media.format.duration) < 3.2, `Unexpected duration: ${media.format.duration}`);
      const decode = spawnSync(path.resolve("resources/media/ffmpeg.exe"), ["-v", "error", "-i", file, "-f", "null", "-"], {
         encoding: "utf8",
         windowsHide: true,
      });
      assert.equal(decode.status, 0, decode.stderr);
   }
   send({
      action: "start",
      id: "collision-start",
      sourceKind: "screen",
      screenIndex: 0,
      sourceName: "Initial screen",
      clipSeconds: 2,
      quality: "low",
      microphone: false,
      captureAudio: true,
      allowSoftwareEncoder: software,
   });
   assert.equal((await wait((event) => event.id === "collision-start")).event, "response");
   await delay(3000);
   const existing = path.join(folder, "must-not-overwrite.mkv");
   await writeFile(existing, "keep existing user file");
   send({ action: "save", requestId: "collision", path: existing });
   await wait((event) => event.event === "error" && event.requestId === "collision");
   assert.equal(await readFile(existing, "utf8"), "keep existing user file");
   send({ action: "stop" });
   send({ action: "exit" });
   await new Promise<void>((resolve) => child.once("exit", () => resolve()));
   assert.equal(child.exitCode, 0);
   console.log(
      "Native smoke passed: real desktop capture, two accepted queued saves followed by Stop, stable source labels, H.264/AAC tracks, full decoding, and no overwrite."
   );
   console.log(`Isolated footage and diagnostics remain in ${folder}`);
} finally {
   if (child.exitCode === null) child.kill();
   await writeFile(path.join(folder, "native.log"), log.join(""));
   await writeFile(path.join(folder, "events.json"), JSON.stringify(events, null, 2));
}
