import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Recorder } from "../src/main/recorder";
import { defaultPreferences } from "../src/shared/defaults";
import { portalSources, sourceChoices } from "../src/shared/capture-policy";

const [runtime, evidence, targetId] = process.argv.slice(2);
assert(runtime && evidence && targetId, "Supply the recorder runtime, private evidence directory and live target ID");
assert.equal(process.platform, "linux");
const folder = path.resolve(evidence, "adapter");
await mkdir(folder, { recursive: true });
const catalog = path.join(folder, "catalog.json");
// A fresh isolated cache prevents this local capture proof from depending on a network refresh.
await writeFile(
   catalog,
   JSON.stringify({ updated: Date.now(), entries: [{ id: "unrelated", name: "Unrelated", executables: [{ name: "not-running", os: "linux" }] }] })
);
const saved: string[] = [];
const failures: string[] = [];
const recorder = new Recorder({
   nativePath: path.resolve(runtime, "attaclip-recorder"),
   gameCatalogPath: catalog,
   onState: () => undefined,
   onError: (message) => failures.push(message),
   onSaved: (file) => {
      saved.push(file);
   },
});
async function until(check: () => boolean, message: string) {
   const deadline = Date.now() + 20_000;
   while (!check()) {
      assert(Date.now() < deadline, `${message}. ${JSON.stringify(recorder.status)}. ${failures.join("; ")}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
   }
}
async function command(executable: string, args: string[]): Promise<string> {
   return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "",
         stderr = "";
      const timer = setTimeout(() => child.kill(), 30_000);
      child.stdout.on("data", (value: Buffer) => {
         stdout += value.toString();
      });
      child.stderr.on("data", (value: Buffer) => {
         stderr += value.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
         clearTimeout(timer);
         if (code !== 0) reject(new Error(`${executable} failed ${code}: ${stderr}`));
         else resolve(stdout);
      });
   });
}
try {
   const capabilities = await recorder.capabilities();
   assert.equal(capabilities.captureBackend, "wayland-portal");
   assert.equal(capabilities.applicationBackend, "xwayland");
   const candidates = await recorder.applicationCandidates();
   const target = candidates.find((candidate) => candidate.id === targetId);
   assert(target && target.pid > 0 && target.executable, "The exact live fixture candidate must be available");
   const sources = portalSources(capabilities, candidates)!;
   assert(sources.some((source) => source.id === targetId && source.kind === "app"));
   assert(sourceChoices(sources, capabilities).every((choice) => !choice.disabled));
   const preferences = {
      ...defaultPreferences,
      collection: folder,
      sourceKind: "auto" as const,
      sourceId: "",
      customGames: [{ name: "User-added XWayland game", executable: target.executable }],
      quality: "custom" as const,
      customWidth: 640,
      customHeight: 360,
      customFPS: 24,
      customCQ: 28,
      clipSeconds: 2,
      allowSoftwareEncoder: true,
      notifications: "off" as const,
      sound: false,
   };
   const matched = await recorder.games(preferences.customGames);
   assert.equal(matched.find((candidate) => candidate.id === targetId)?.gameName, "User-added XWayland game");
   await recorder.start(preferences, sources);
   await until(
      () => recorder.status.sourceId === targetId && recorder.status.state === "recording" && recorder.status.availableSeconds >= 1.8,
      "Auto did not record the user-added exact XWayland target"
   );
   const file = path.join(folder, "auto.mkv");
   await recorder.save(file);
   await until(() => saved.includes(file), "The adapter did not receive actual saved output");
   await recorder.stop();
   assert.equal(recorder.status.availableSeconds, 0);
   await command("ffmpeg", ["-v", "error", "-threads", "1", "-i", file, "-enc_time_base", "demux", "-f", "null", "-"]);
   const hashes = await command("ffmpeg", ["-v", "error", "-threads", "1", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
   const distinct = new Set(
      hashes
         .split("\n")
         .filter((line) => line && !line.startsWith("#"))
         .map((line) => line.split(",").at(-1)?.trim())
   );
   assert(distinct.size > 20, "Auto output must contain actual moving fixture frames");
   assert.deepEqual(failures, []);
   await writeFile(
      path.join(folder, "proof.json"),
      JSON.stringify(
         {
            capabilities,
            targetId,
            distinctFrames: distinct.size,
            checks: [
               "real-recorder-adapter",
               "local-custom-game",
               "exact-xwayland-source-list",
               "auto-target",
               "actual-save",
               "full-decode",
               "stop-clears-history",
            ],
         },
         null,
         2
      ) + "\n"
   );
   console.log("Actual XWayland Auto adapter passed", folder);
} finally {
   await recorder.close();
}
