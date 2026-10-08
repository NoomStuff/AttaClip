import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

if (process.platform !== "win32") throw new Error("This real game-hook proof requires Windows");
const folder = path.resolve(".cache/native-game", randomUUID());
await mkdir(folder, { recursive: true });
const runtime = path.resolve("resources/recorder");
const fixture = spawn(path.resolve(".cache/native-tests/Release/attaclip-d3d-fixture.exe"), [], { stdio: "pipe" });
let handle = "";
fixture.stdout.once("data", (value: Buffer) => {
   handle = value.toString().trim();
});
interface Event {
   event: string;
   message?: string;
   captureMethod?: string;
   availableSeconds?: number;
   waiting?: boolean;
   requestId?: string;
   id?: string;
   windows?: Array<{ id: string; executable: string; pid: number }>;
}
const events: Event[] = [];
const logs: string[] = [];
const helper = spawn(path.join(runtime, "attaclip-recorder.exe"), [runtime], { cwd: runtime, stdio: "pipe", windowsHide: true });
helper.stderr.on("data", (value: Buffer) => logs.push(value.toString()));
createInterface({ input: helper.stdout }).on("line", (value) => events.push(JSON.parse(value) as Event));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const send = (value: Record<string, unknown>): void => {
   helper.stdin.write(`${JSON.stringify(value)}\n`);
};
async function wait(predicate: (value: Event) => boolean): Promise<Event> {
   const deadline = Date.now() + 20_000;
   while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      if (helper.exitCode !== null) throw new Error(`Recorder exited ${helper.exitCode}`);
      await delay(20);
   }
   throw new Error(`Timed out: ${JSON.stringify(events)}`);
}
try {
   await wait((value) => value.event === "ready");
   assert(handle);
   send({ action: "candidates" });
   const candidates = await wait((value) => value.event === "candidates");
   const candidate = candidates.windows?.find((value) => value.id === `window:${handle}:0`);
   assert(candidate, "Exact fixture HWND absent from candidates");
   assert.equal(candidate.pid, fixture.pid);
   send({
      action: "start",
      id: "start",
      sourceKind: "auto",
      resolvedKind: "app",
      sourceId: candidate.id,
      sourceName: "D3D fixture",
      pid: candidate.pid,
      clipSeconds: 2,
      quality: "custom",
      customWidth: 640,
      customHeight: 360,
      customFPS: 30,
      customCQ: 23,
      captureAudio: true,
      microphone: false,
   });
   const start = await wait((value) => value.id === "start");
   assert.equal(start.event, "response", start.message ?? "Could not start game capture");
   let active: Event | undefined;
   for (let i = 0; i < 24; i++) {
      const before = events.length;
      send({ action: "status", id: `status-${i}` });
      await wait((value) => value.id === `status-${i}`);
      active = events.slice(before).find((value) => value.event === "status");
      if ((active?.availableSeconds ?? 0) >= 2) break;
      await delay(250);
   }
   assert.equal(active?.waiting, false);
   assert.equal(active?.captureMethod, "game", "The Direct3D fixture must prove a real hook, not window fallback");
   const file = path.join(folder, "game.mkv");
   send({ action: "save", requestId: "game", requestedAt: Date.now(), path: file });
   const saved = await wait((value) => value.requestId === "game" && ["saved", "error"].includes(value.event));
   assert.equal(saved.event, "saved", saved.message ?? "Could not save game capture");
   const decode = spawnSync(path.resolve("resources/media/ffmpeg.exe"), ["-v", "error", "-i", file, "-f", "null", "-"], {
      encoding: "utf8",
      windowsHide: true,
   });
   assert.equal(decode.status, 0, decode.stderr);
   const pixel = spawnSync(
      path.resolve("resources/media/ffmpeg.exe"),
      ["-v", "error", "-ss", "0.4", "-i", file, "-vf", "crop=2:2:iw/2:ih/2,signalstats,metadata=print:file=-", "-frames:v", "1", "-an", "-f", "null", "-"],
      { encoding: "utf8", windowsHide: true }
   );
   assert.equal(pixel.status, 0, pixel.stderr);
   const u = Number(/lavfi.signalstats.UAVG=([\d.]+)/.exec(pixel.stdout)?.[1]);
   const y = Number(/lavfi.signalstats.YAVG=([\d.]+)/.exec(pixel.stdout)?.[1]);
   assert(y > 35 && y < 160 && u > 140, `Expected actual blue D3D image, got Y/U ${y}/${u}`);
   send({ action: "stop" });
   send({ action: "exit" });
   await new Promise<void>((resolve) => helper.once("exit", () => resolve()));
   assert.equal(helper.exitCode, 0);
   console.log(`Exact HWND/PID game hook, animated D3D pixels and full decoding passed. Proof: ${folder}`);
} finally {
   if (helper.exitCode === null) helper.kill();
   fixture.kill();
   await writeFile(path.join(folder, "events.json"), JSON.stringify(events, null, 2));
   await writeFile(path.join(folder, "native.log"), logs.join(""));
}
