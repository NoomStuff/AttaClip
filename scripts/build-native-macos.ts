import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./release-sources";

// Investigation only. Do not stage this probe as a production recorder.
if (process.platform !== "darwin") throw new Error("The macOS probe requires an actual macOS host.");
const pin =
   process.arch === "arm64"
      ? {
           name: "OBS-Studio-32.2.2-macOS-Apple.dmg",
           sha256: "920d6f26703d2df6e4085bd3c1cbed30488325084136c7a6e9e37021fbd6aaf7",
        }
      : process.arch === "x64"
        ? {
             name: "OBS-Studio-32.2.2-macOS-Intel.dmg",
             sha256: "f8d8afe3dffdc86efa0698c02ff0c997866bac3e6208ddaf56d37108baacf197",
          }
        : undefined;
if (!pin) throw new Error("Unsupported macOS probe architecture.");
const commit = "ba2f32bdf791005443988a4955e963663e16b1ed";
const root = process.cwd();
const folder = path.join(root, ".cache/macos-probe");
const source = path.join(folder, "obs-source");
const mount = path.join(folder, "mounted-obs");
const build = path.join(folder, "build");
const run = (command: string, args: string[]) => {
   const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
   if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
   return result.stdout;
};
await mkdir(folder, { recursive: true });
if (!existsSync(path.join(source, "libobs/obs.h")))
   run("git", ["clone", "--depth", "1", "--branch", "32.2.2", "https://github.com/obsproject/obs-studio.git", source]);
if (run("git", ["-C", source, "rev-parse", "HEAD"]).trim() !== commit) throw new Error("OBS headers differ from the pinned source commit.");
const archive = path.join(folder, pin.name);
if (!existsSync(archive)) {
   const response = await fetch(`https://github.com/obsproject/obs-studio/releases/download/32.2.2/${pin.name}`, { signal: AbortSignal.timeout(120000) });
   if (!response.ok) throw new Error(`Official OBS download failed: HTTP ${response.status}`);
   await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
}
if ((await hashFile(archive)) !== pin.sha256) throw new Error("Official macOS OBS archive checksum mismatch.");
const json = await readFile(path.join(root, "native/vendor/json.hpp"));
if (createHash("sha256").update(json).digest("hex") !== "aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63")
   throw new Error("Vendored JSON header checksum mismatch.");
await mkdir(mount, { recursive: true });
run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, archive]);
try {
   const app = path.join(mount, "OBS.app");
   run("cmake", ["-S", path.join(root, "native/macos-probe"), "-B", build, `-DOBS_APP=${app}`, `-DOBS_SOURCE_DIR=${source}`, "-DCMAKE_BUILD_TYPE=Release"]);
   run("cmake", ["--build", build, "--parallel", "2"]);
   await mkdir(path.join(folder, "config"), { recursive: true });
   const report = JSON.parse(run(path.join(build, "attaclip-macos-probe"), [app, path.join(folder, "config")])) as Record<string, unknown>;
   await writeFile(
      path.join(folder, "module-proof.json"),
      `${JSON.stringify({ ...report, platform: `${process.platform}-${process.arch}`, runtimeArchive: pin, sourceCommit: commit }, null, 2)}\n`
   );
   await writeFile(path.join(folder, "link-proof.txt"), run("otool", ["-L", path.join(build, "attaclip-macos-probe")]));
   console.log("Actual Mac module probe passed. Capture, microphone audio and permissions were not tested. Production recording remains unavailable.");
} finally {
   run("hdiutil", ["detach", mount]);
}
