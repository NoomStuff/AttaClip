import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

if (process.platform !== "win32") throw new Error("This application-audio proof requires Windows");
const folder = path.resolve(".cache/native-extra-audio", randomUUID());
await mkdir(folder, { recursive: true });
const fixtures = [997, 577, 1234].map((frequency) => {
   const child = spawn(
      path.resolve(".cache/native-tests/Release/attaclip-d3d-fixture.exe"),
      [`AttaClip private tone ${frequency} ${randomUUID()}`, String(frequency)],
      { stdio: "pipe" }
   );
   const handle = new Promise<string>((resolve) => child.stdout.once("data", (value: Buffer) => resolve(value.toString().trim())));
   return { child, handle };
});
const runtime = path.resolve("resources/recorder");
const helper = spawn(path.join(runtime, "attaclip-recorder.exe"), [runtime], { cwd: runtime, windowsHide: true, stdio: "pipe" });
interface Event {
   event: string;
   id?: string;
   requestId?: string;
   message?: string;
   waiting?: boolean;
   additional?: Record<string, number>;
}
const events: Event[] = [],
   logs: string[] = [];
helper.stderr.on("data", (value: Buffer) => logs.push(value.toString()));
createInterface({ input: helper.stdout }).on("line", (line) => events.push(JSON.parse(line) as Event));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(predicate: (event: Event) => boolean): Promise<Event> {
   const deadline = Date.now() + 20_000;
   while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      if (helper.exitCode !== null) throw new Error(`Recorder exited ${helper.exitCode}`);
      await delay(20);
   }
   throw new Error(`Native response timed out ${JSON.stringify(events)}`);
}
async function command(value: Record<string, unknown>): Promise<void> {
   const id = randomUUID();
   helper.stdin.write(`${JSON.stringify({ ...value, id })}\n`);
   const result = await wait((event) => event.id === id);
   assert.equal(result.event, "response", result.message ?? "Native command failed");
}
const decoder = process.env["ATTACLIP_TEST_FFMPEG"] ?? "ffmpeg";
function levels(file: string, track: number): Record<string, number> {
   const result = spawnSync(decoder, ["-v", "error", "-i", file, "-map", `0:a:${track}`, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
   });
   assert.equal(result.status, 0, result.stderr.toString());
   const samples = new Float32Array(result.stdout.buffer.slice(result.stdout.byteOffset, result.stdout.byteOffset + result.stdout.byteLength)).slice(
      24000,
      72000
   );
   assert(samples.length > 20000, "Saved audio is too short to measure");
   return Object.fromEntries(
      [997, 577, 1234].map((frequency) => {
         let power = 0,
            blocks = 0;
         for (let offset = 0; offset + 4800 <= samples.length; offset += 4800) {
            let a = 0,
               b = 0;
            for (let i = 0; i < 4800; i++) {
               const sample = samples[offset + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 4799));
               a += sample * Math.cos((2 * Math.PI * frequency * i) / 48000);
               b += sample * Math.sin((2 * Math.PI * frequency * i) / 48000);
            }
            power += ((4 * Math.hypot(a, b)) / 4800) ** 2;
            blocks++;
         }
         return [String(frequency), 20 * Math.log10(Math.max(1e-10, Math.sqrt(power / blocks)))];
      })
   );
}
try {
   await wait((event) => event.event === "ready");
   const handles = await Promise.all(fixtures.map((value) => value.handle));
   await command({
      action: "start",
      sourceKind: "app",
      sourceId: `window:${handles[0]}:0`,
      pid: fixtures[0]!.child.pid,
      sourceName: "Private fixture",
      quality: "custom",
      customWidth: 640,
      customHeight: 360,
      customFPS: 24,
      customCQ: 28,
      clipSeconds: 2,
      captureAudio: false,
      microphone: false,
      audioSources: [
         {
            id: "tone-a",
            name: "Selected A",
            kind: "application",
            sourceId: `window:${handles[0]}:0`,
            pid: fixtures[0]!.child.pid,
            enabled: true,
            includeInMaster: false,
            volume: 1,
            muted: false,
         },
         {
            id: "tone-b",
            name: "Selected B",
            kind: "application",
            sourceId: `window:${handles[1]}:0`,
            pid: fixtures[1]!.child.pid,
            enabled: true,
            includeInMaster: true,
            volume: 1,
            muted: false,
         },
      ],
   });
   const measured: Record<string, Array<Record<string, number>>> = {};
   for (const phase of ["full", "half", "muted"] as const) {
      if (phase !== "full") await command({ action: "audio", source: "tone-a", volume: phase === "half" ? 0.5 : 1, muted: phase === "muted" });
      await delay(4000);
      const file = path.join(folder, `${phase}.mkv`);
      await command({ action: "save", path: file, requestId: phase, requestedAt: Date.now() });
      await wait((event) => event.event === "saved" && event.requestId === phase);
      measured[phase] = [0, 1, 2, 3].map((track) => levels(file, track));
   }
   const full = measured["full"]!;
   assert(full[0]!["577"]! > -45 && full[0]!["997"]! < -60, JSON.stringify(measured));
   assert(full[2]!["997"]! > -45 && full[2]!["577"]! < -60, JSON.stringify(measured));
   assert(full[3]!["577"]! > -45 && full[3]!["997"]! < -60, JSON.stringify(measured));
   assert(
      full.every((track) => track["1234"]! < -60),
      "Unrelated application audio leaked"
   );
   assert(Math.abs(full[2]!["997"]! - measured["half"]![2]!["997"]! - 6.02) < 1, JSON.stringify(measured));
   assert(measured["muted"]![2]!["997"]! < -70, JSON.stringify(measured));
   assert(
      events.some((event) => (event.additional?.["tone-a"] ?? 0) > 0.05),
      "Missing measured extra A levels"
   );
   assert(
      events.some((event) => (event.additional?.["tone-b"] ?? 0) > 0.05),
      "Missing measured extra B levels"
   );
   fixtures[1]!.child.kill();
   await delay(500);
   const before = events.length;
   await command({ action: "status" });
   assert(
      events.slice(before).some((event) => event.event === "status" && event.waiting && event.message?.includes("Selected B")),
      "Closed extra must invalidate recording"
   );
   await command({ action: "stop" });
   helper.stdin.write('{"action":"exit"}\n');
   await new Promise<void>((resolve) => helper.once("exit", () => resolve()));
   assert.equal(helper.exitCode, 0);
   await writeFile(path.join(folder, "measurements.json"), JSON.stringify(measured, null, 2));
   console.log("Actual Windows application audio, isolated tracks, master exclusion, gain/mute, meters and lost-source state passed", folder);
} finally {
   for (const fixture of fixtures) fixture.child.kill();
   if (helper.exitCode === null) helper.kill();
   await writeFile(path.join(folder, "native.log"), logs.join(""));
   await writeFile(path.join(folder, "events.json"), JSON.stringify(events, null, 2));
}
