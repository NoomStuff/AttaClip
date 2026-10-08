import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

if (process.platform !== "win32") throw new Error("This capture proof requires Windows");
const runtime = path.resolve("resources/recorder");
const folder = path.resolve(".cache/native-overlap", randomUUID());
await mkdir(folder, { recursive: true });
const gate = path.join(folder, "writer-gate");
interface Event {
   event: string;
   id?: string;
   requestId?: string;
   message?: string;
   overlapSeconds?: number;
   sourceKind?: string;
   sourceId?: string;
   windows?: Array<{ id: string; executable: string; pid: number; foreground: boolean; fullscreen: boolean }>;
}
const events: Event[] = [];
const logs: string[] = [];
const child = spawn(path.join(runtime, "attaclip-recorder.exe"), [runtime], {
   cwd: runtime,
   stdio: "pipe",
   windowsHide: true,
   env: { ...process.env, ATTACLIP_NATIVE_TEST_WRITER_GATE: gate },
});
child.stderr.on("data", (value: Buffer) => logs.push(value.toString()));
createInterface({ input: child.stdout }).on("line", (value) => events.push(JSON.parse(value) as Event));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const send = (value: Record<string, unknown>): void => {
   child.stdin.write(`${JSON.stringify(value)}\n`);
};
async function wait(predicate: (value: Event) => boolean): Promise<Event> {
   const deadline = Date.now() + 20_000;
   while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`Recorder exited ${child.exitCode}`);
      await delay(20);
   }
   throw new Error(`Timed out: ${JSON.stringify(events)}`);
}
function duration(file: string): number {
   const probe = spawnSync(
      path.resolve("resources/media/ffprobe.exe"),
      ["-v", "error", "-show_entries", "format=duration:stream_tags=DURATION", "-of", "json", file],
      {
         encoding: "utf8",
         windowsHide: true,
      }
   );
   assert.equal(probe.status, 0, probe.stderr);
   const media = JSON.parse(probe.stdout) as { format: { duration: string }; streams: Array<{ tags?: { DURATION?: string } }> };
   const endpoint = (text: string): number => {
      const [hours, minutes, seconds] = text.split(":").map(Number);
      return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
   };
   const video = endpoint(media.streams[0]?.tags?.DURATION ?? "0");
   for (const audio of media.streams.slice(1))
      assert(Math.abs(video - endpoint(audio.tags?.DURATION ?? "0")) < 0.15, "Reduced clip audio and video endpoints must stay synchronized");
   const decode = spawnSync(path.resolve("resources/media/ffmpeg.exe"), ["-v", "error", "-i", file, "-f", "null", "-"], {
      encoding: "utf8",
      windowsHide: true,
   });
   assert.equal(decode.status, 0, decode.stderr);
   return Number(media.format.duration);
}
try {
   await wait((value) => value.event === "ready");
   send({ action: "candidates" });
   const candidates = await wait((value) => value.event === "candidates");
   assert(Array.isArray(candidates.windows));
   for (const candidate of candidates.windows) {
      assert.match(candidate.id, /^window:\d+:0$/);
      assert(path.isAbsolute(candidate.executable));
      assert(candidate.pid > 0);
      assert.equal(typeof candidate.foreground, "boolean");
   }
   for (const mode of ["default", "reduced", "failed"] as const) {
      send({
         action: "start",
         id: `${mode}-start`,
         sourceKind: "auto",
         resolvedKind: "waiting",
         sourceName: "Waiting for game",
         clipSeconds: 4,
         avoidOverlap: mode !== "default",
         quality: "custom",
         customWidth: 640,
         customHeight: 360,
         customFPS: 24,
         customCQ: 23,
         captureAudio: true,
         microphone: false,
      });
      assert.equal((await wait((value) => value.id === `${mode}-start`)).event, "response");
      send({ action: "status", id: `${mode}-waiting` });
      await wait((value) => value.id === `${mode}-waiting`);
      const statuses = events.filter((value) => value.event === "status");
      assert.equal(statuses.at(-1)?.sourceKind, "waiting");
      send({
         action: "source",
         sourceKind: "auto",
         resolvedKind: "screen",
         screenIndex: 0,
         sourceId: "screen:0:0",
         sourceName: "Explicit fallback",
         captureAudio: true,
      });
      await delay(5300);
      await writeFile(gate, "hold writer until both requests have captured their windows");
      const first = path.join(folder, `${mode}-first.mkv`);
      const second = path.join(folder, `${mode}-second.mkv`);
      if (mode === "failed") await writeFile(first, "preserve existing file");
      send({ action: "save", requestId: `${mode}-first`, path: first, requestedAt: Date.now() });
      await delay(1400);
      send({ action: "save", requestId: `${mode}-second`, path: second, requestedAt: Date.now() });
      send({ action: "stop", id: `${mode}-stop` });
      await wait((value) => value.id === `${mode}-stop`);
      await unlink(gate);
      const firstEvent = await wait((value) => value.requestId === `${mode}-first` && ["saved", "error"].includes(value.event));
      const secondEvent = await wait((value) => value.requestId === `${mode}-second` && ["saved", "error"].includes(value.event));
      assert.equal(secondEvent.event, "saved", secondEvent.message ?? "Second save failed");
      const seconds = duration(second);
      if (mode === "reduced") {
         assert.equal(firstEvent.event, "saved", firstEvent.message ?? "First save failed");
         assert(seconds > 1 && seconds < 2.6, `Queued reduced clip duration ${seconds}`);
         assert((secondEvent.overlapSeconds ?? -1) >= 0 && (secondEvent.overlapSeconds ?? 2) <= 1.05, `Overlap ${secondEvent.overlapSeconds}`);
         duration(first);
      } else {
         assert(seconds >= 3.9 && seconds < 5.1, `Full history should remain, got ${seconds}`);
         assert.equal(secondEvent.overlapSeconds, 0);
         if (mode === "failed") {
            assert.equal(firstEvent.event, "error");
            assert.equal(await readFile(first, "utf8"), "preserve existing file");
         } else duration(first);
      }
      console.log(`${mode}: second clip ${seconds.toFixed(3)} s, overlap ${(secondEvent.overlapSeconds ?? 0).toFixed(3)} s`);
   }
   send({ action: "exit" });
   await new Promise<void>((resolve) => child.once("exit", () => resolve()));
   assert.equal(child.exitCode, 0);
   console.log(`Queued overlap, default windows, failed predecessor, Auto waiting and exact candidates passed. Proof: ${folder}`);
} finally {
   if (child.exitCode === null) child.kill();
   await writeFile(path.join(folder, "events.json"), JSON.stringify(events, null, 2));
   await writeFile(path.join(folder, "native.log"), logs.join(""));
}
