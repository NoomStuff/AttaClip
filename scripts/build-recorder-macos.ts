import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./release-sources";

if (process.platform !== "darwin") throw new Error("The macOS recorder must build on macOS.");
// Reuse the pinned download/header/module verification before staging a recorder.
await import("./build-native-macos");
const root = process.cwd();
const cache = path.join(root, ".cache/macos-probe");
const source = path.join(cache, "obs-source");
const simde = path.join(cache, "simde-source");
const mount = path.join(cache, "mounted-obs");
const build = path.join(root, ".cache/macos-native/build");
const archiveName = process.arch === "arm64" ? "OBS-Studio-32.2.2-macOS-Apple.dmg" : "OBS-Studio-32.2.2-macOS-Intel.dmg";
const runtime = path.resolve(process.env["ATTACLIP_RECORDER_STAGE"] ?? "resources/recorder");
if (runtime !== path.join(root, "resources/recorder") && !runtime.startsWith(path.join(root, ".cache") + path.sep))
   throw new Error("Recorder staging must remain inside resources/recorder or the workspace .cache directory.");
const run = (command: string, args: string[]) => {
   const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 240000 });
   if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
   return result.stdout;
};
async function files(directory: string): Promise<string[]> {
   const result: string[] = [];
   for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) result.push(...(await files(file)));
      else if (item.isFile()) result.push(file);
   }
   return result;
}
run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, path.join(cache, archiveName)]);
try {
   const app = path.join(mount, "OBS.app");
   const contents = path.join(app, "Contents");
   const frameworks = path.join(contents, "Frameworks");
   run("cmake", [
      "-S",
      path.join(root, "native"),
      "-B",
      build,
      `-DOBS_APP=${app}`,
      `-DOBS_SOURCE_DIR=${source}`,
      `-DSIMDE_SOURCE_DIR=${simde}`,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
   ]);
   run("cmake", ["--build", build, "--parallel", "2"]);
   await rm(runtime, { recursive: true, force: true });
   await mkdir(path.join(runtime, "Frameworks"), { recursive: true });
   await mkdir(path.join(runtime, "PlugIns"), { recursive: true });
   const copied = new Set<string>();
   const inspected = new Set<string>();
   const providerFiles: Array<{ path: string; sha256: string }> = [];
   async function dependencyClosure(binary: string): Promise<void> {
      const actual = await realpath(binary);
      if (inspected.has(actual)) return;
      inspected.add(actual);
      const dependencies = run("otool", ["-arch", process.arch === "arm64" ? "arm64" : "x86_64", "-L", binary])
         .split("\n")
         .filter((line) => line.includes(" (compatibility version "))
         .map((line) => line.trim().split(" (compatibility")[0]!)
         .filter(Boolean);
      for (const dependency of dependencies) {
         if (dependency.startsWith("/System/") || dependency.startsWith("/usr/lib/")) continue;
         const resolved = dependency.startsWith("@rpath/")
            ? path.join(frameworks, dependency.slice(7))
            : dependency.startsWith("@loader_path/")
              ? path.resolve(path.dirname(binary), dependency.slice(13))
              : dependency.startsWith("@executable_path/")
                ? path.resolve(contents, "MacOS", dependency.slice(17))
                : dependency;
         if (!existsSync(resolved)) throw new Error(`Unresolved macOS recorder dependency: ${dependency} from ${binary}`);
         const relative = path.relative(frameworks, resolved);
         if (relative.startsWith("..") || path.isAbsolute(relative))
            throw new Error(`Unexpected macOS runtime dependency outside official Frameworks: ${resolved}`);
         const component = relative.split(path.sep)[0]!;
         if (!copied.has(component)) {
            copied.add(component);
            await cp(path.join(frameworks, component), path.join(runtime, "Frameworks", component), { recursive: true, verbatimSymlinks: true });
         }
         await dependencyClosure(resolved);
      }
   }
   const executable = path.join(runtime, "attaclip-recorder");
   await copyFile(path.join(build, "attaclip-recorder"), executable);
   await dependencyClosure(path.join(build, "attaclip-recorder"));
   const allFiles = await files(contents);
   const mux = allFiles.find((file) => path.basename(file) === "obs-ffmpeg-mux");
   if (!mux) throw new Error("The official macOS mux helper is missing.");
   await copyFile(mux, path.join(runtime, "obs-ffmpeg-mux"));
   await dependencyClosure(mux);
   const graphics = ["libobs-metal.dylib", "libobs-opengl.dylib"].filter((name) => existsSync(path.join(frameworks, name)));
   if (!graphics.length) throw new Error("The official macOS graphics modules are missing.");
   for (const name of graphics) {
      if (!copied.has(name)) await cp(path.join(frameworks, name), path.join(runtime, "Frameworks", name), { dereference: true });
      await dependencyClosure(path.join(frameworks, name));
   }
   for (const name of ["mac-capture", "mac-videotoolbox", "obs-ffmpeg", "obs-x264"]) {
      const bundle = path.join(contents, "PlugIns", `${name}.plugin`);
      await cp(bundle, path.join(runtime, "PlugIns", `${name}.plugin`), { recursive: true, verbatimSymlinks: true });
      await dependencyClosure(path.join(bundle, "Contents/MacOS", name));
   }
   const effect = allFiles.find((file) => path.basename(file) === "default.effect" && file.includes("libobs"));
   if (!effect) throw new Error("The official libOBS effect resources are missing.");
   await cp(path.dirname(effect), path.join(runtime, "data/libobs"), { recursive: true });
   await chmod(executable, 0o755);
   await chmod(path.join(runtime, "obs-ffmpeg-mux"), 0o755);
   if (!run("otool", ["-l", path.join(runtime, "obs-ffmpeg-mux")]).includes("path @executable_path/Frameworks (offset"))
      run("install_name_tool", ["-add_rpath", "@executable_path/Frameworks", path.join(runtime, "obs-ffmpeg-mux")]);
   run("codesign", ["--force", "--sign", "-", path.join(runtime, "obs-ffmpeg-mux")]);
   run("codesign", ["--force", "--sign", "-", executable]);
   await copyFile(path.join(source, "COPYING"), path.join(runtime, "COPYING-OBS"));
   for (const file of await files(runtime)) providerFiles.push({ path: path.relative(runtime, file), sha256: await hashFile(file) });
   const sourceFiles = [
      "native/recorder.cpp",
      "native/CMakeLists.txt",
      "native/macos/platform.hpp",
      "native/macos/platform.mm",
      "native/macos/main.mm",
      "native/macos/Info.plist",
      "scripts/build-recorder-macos.ts",
   ];
   await writeFile(
      path.join(runtime, "provenance.json"),
      `${JSON.stringify(
         {
            obsVersion: "32.2.2",
            sourceCommit: "ba2f32bdf791005443988a4955e963663e16b1ed",
            simdeCommit: "71fd833d9666141edcd1d3c109a80e228303d8d7",
            platform: `macOS 13+, ${process.arch}`,
            runtimeArchive: { name: archiveName, sha256: await hashFile(path.join(cache, archiveName)) },
            build: "scripts/build-recorder-macos.ts",
            providerFiles,
            sourceHashes: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, await hashFile(path.join(root, file))]))),
            limitations: [
               "Corresponding dependency sources must be collected before public binary distribution",
               "Physical microphone, permission prompts and loaded-game performance require actual device testing",
            ],
         },
         null,
         2
      )}\n`
   );
   await writeFile(path.join(root, ".cache/macos-native/link-proof.txt"), run("otool", ["-L", executable]));
   console.log(`Built and staged the macOS ScreenCaptureKit/VideoToolbox recorder for ${process.arch}. Capture requires actual media verification.`);
} finally {
   run("hdiutil", ["detach", mount]);
}
