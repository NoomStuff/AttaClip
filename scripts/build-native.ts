import { copyFile, cp, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const version = "32.2.2";
const root = process.cwd();
const cache = path.join(root, ".cache");
const runtime = path.join(root, "resources", "recorder");
const source = path.join(cache, "obs-source");
const output = path.join(cache, "native-build");
const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const run = (command: string, args: string[]): string => {
   const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
   if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
   return result.stdout;
};
async function download(url: string, target: string): Promise<void> {
   const response = await fetch(url);
   if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
   await writeFile(target, Buffer.from(await response.arrayBuffer()));
}
if (process.platform === "linux") {
   await import("./build-native-linux");
   process.exit(0);
}
if (process.platform === "darwin") {
   await import("./build-recorder-macos");
   process.exit(0);
}
if (process.platform !== "win32") {
   await mkdir(runtime, { recursive: true });
   await writeFile(
      path.join(runtime, "UNAVAILABLE.txt"),
      "Native recording is currently validated on Windows with NVIDIA NVENC. Library, playback, and local sharing work on this platform; capture is unavailable.\n"
   );
   console.log("Native recording unavailable on this platform; no simulated backend will be shipped.");
   process.exit(0);
}
await mkdir(cache, { recursive: true });
await mkdir(path.join(root, "native", "generated"), { recursive: true });
await mkdir(path.join(root, "native", "vendor"), { recursive: true });
if (!existsSync(path.join(source, "libobs", "obs.h")))
   run("git", ["clone", "--depth", "1", "--branch", version, "https://github.com/obsproject/obs-studio.git", source]);
const tag = run("git", ["-C", source, "describe", "--tags", "--exact-match"]).trim();
if (tag !== version) throw new Error(`OBS headers must match ${version}, found ${tag}`);
if (run("git", ["-C", source, "rev-parse", "HEAD"]).trim() !== "ba2f32bdf791005443988a4955e963663e16b1ed")
   throw new Error("OBS source commit does not match the pinned release");
const jsonHeader = path.join(root, "native", "vendor", "json.hpp");
if (!existsSync(jsonHeader)) await download("https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp", jsonHeader);
if (
   createHash("sha256")
      .update(await readFile(jsonHeader))
      .digest("hex") !== "aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63"
)
   throw new Error("The JSON dependency did not match its pinned digest");
let obs = process.env["ATTACLIP_OBS_ROOT"] ?? path.join(cache, "obs-runtime");
if (!existsSync(path.join(obs, "bin", "64bit", "obs.dll"))) {
   obs = path.join(cache, "obs-runtime");
   const archive = path.join(cache, `OBS-Studio-${version}-Windows-x64.zip`);
   if (!existsSync(archive))
      await download(`https://github.com/obsproject/obs-studio/releases/download/${version}/OBS-Studio-${version}-Windows-x64.zip`, archive);
   if (
      createHash("sha256")
         .update(await readFile(archive))
         .digest("hex") !== "4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1"
   )
      throw new Error("The OBS runtime archive did not match its pinned official release digest");
   run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${psLiteral(archive)} -DestinationPath ${psLiteral(obs)} -Force`]);
}
const bin = path.join(obs, "bin", "64bit");
const installedVersion = run("powershell", [
   "-NoProfile",
   "-Command",
   `(Get-Item -LiteralPath ${psLiteral(path.join(bin, "obs64.exe"))}).VersionInfo.FileVersion`,
]).trim();
if (installedVersion !== version)
   throw new Error(`OBS runtime ${installedVersion} does not match pinned headers ${version}. Set ATTACLIP_OBS_ROOT to ${version}`);
const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
const installation = run(vswhere, [
   "-latest",
   "-products",
   "*",
   "-requires",
   "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
   "-property",
   "installationPath",
]).trim();
if (!installation) throw new Error("Install Visual Studio Build Tools with Desktop development with C++");
const versions = (await readdir(path.join(installation, "VC", "Tools", "MSVC"))).sort().reverse();
const tools = path.join(installation, "VC", "Tools", "MSVC", versions[0]!, "bin", "Hostx64", "x64");
const exports = run(path.join(tools, "dumpbin.exe"), ["/exports", path.join(bin, "obs.dll")])
   .split(/\r?\n/)
   .flatMap((line) => {
      const match = /^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)/.exec(line);
      return match?.[1] ? [match[1]] : [];
   });
const generated = path.join(root, "native", "generated");
await writeFile(path.join(generated, "obs.def"), `LIBRARY obs\nEXPORTS\n${exports.join("\n")}\n`);
run(path.join(tools, "lib.exe"), [`/def:${path.join(generated, "obs.def")}`, `/out:${path.join(generated, "obs.lib")}`, "/machine:x64"]);
await writeFile(path.join(generated, "obsconfig.h"), "#pragma once\n#define OBS_RELEASE_CANDIDATE 0\n#define OBS_BETA 0\n");
const visualStudioVersion = Number(
   run(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationVersion"])
      .trim()
      .split(".")[0]
);
const generator =
   visualStudioVersion === 16
      ? "Visual Studio 16 2019"
      : visualStudioVersion === 17
        ? "Visual Studio 17 2022"
        : visualStudioVersion === 18
          ? "Visual Studio 18 2026"
          : "";
if (!generator || !run("cmake", ["--help"]).includes(generator))
   throw new Error(`CMake does not support the installed Visual Studio ${visualStudioVersion}. Update CMake or use a supported C++ toolchain`);
run("cmake", [
   "-S",
   path.join(root, "native"),
   "-B",
   output,
   "-G",
   generator,
   "-A",
   "x64",
   `-DOBS_SOURCE_DIR=${source}`,
   `-DOBS_IMPORT_LIBRARY=${path.join(generated, "obs.lib")}`,
]);
run("cmake", ["--build", output, "--config", "Release"]);
// Only replace the generated runtime directory inside this workspace.
if (path.resolve(runtime) !== path.join(path.resolve(root), "resources", "recorder")) throw new Error("Unexpected staging directory");
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
await copyFile(path.join(output, "Release", "attaclip-recorder.exe"), path.join(runtime, "attaclip-recorder.exe"));
await copyFile(path.join(output, "notifications", "Release", "attaclip-notifier.exe"), path.join(runtime, "attaclip-notifier.exe"));
const binaries = [
   "obs.dll",
   "libobs-d3d11.dll",
   "libobs-winrt.dll",
   "w32-pthreads.dll",
   "zlib.dll",
   "libcurl.dll",
   "librist.dll",
   "srt.dll",
   "libx264-164.dll",
   "avcodec-62.dll",
   "avdevice-62.dll",
   "avformat-62.dll",
   "avfilter-11.dll",
   "avutil-60.dll",
   "swscale-9.dll",
   "swresample-6.dll",
   "obs-ffmpeg-mux.exe",
   "obs-nvenc-test.exe",
   "obs-amf-test.exe",
   "obs-qsv-test.exe",
];
for (const name of binaries) await copyFile(path.join(bin, name), path.join(runtime, name));
const modules = ["win-capture", "win-wasapi", "obs-ffmpeg", "obs-nvenc", "obs-qsv11", "obs-x264"];
await mkdir(path.join(runtime, "obs-plugins", "64bit"), { recursive: true });
for (const name of modules) {
   await copyFile(path.join(obs, "obs-plugins", "64bit", `${name}.dll`), path.join(runtime, "obs-plugins", "64bit", `${name}.dll`));
   const data = path.join(obs, "data", "obs-plugins", name);
   if (existsSync(data)) await cp(data, path.join(runtime, "data", "obs-plugins", name), { recursive: true, filter: (file) => !file.endsWith(".pdb") });
}
await cp(path.join(obs, "data", "libobs"), path.join(runtime, "data", "libobs"), { recursive: true });
await writeFile(
   path.join(runtime, "provenance.json"),
   JSON.stringify(
      {
         obsVersion: version,
         sourceCommit: run("git", ["-C", source, "rev-parse", "HEAD"]).trim(),
         source: `https://github.com/obsproject/obs-studio/tree/${version}`,
         build: "scripts/build-native.ts",
         modules,
         encoder: "Device-probed NVENC, AMD AMF or Intel QSV H.264; explicit x264 software fallback",
         format: "Matroska",
         platform: "Windows x64",
         runtimeArchive: process.env["ATTACLIP_OBS_ROOT"]
            ? null
            : {
                 url: `https://github.com/obsproject/obs-studio/releases/download/${version}/OBS-Studio-${version}-Windows-x64.zip`,
                 sha256: "4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1",
              },
         sourceHashes: Object.fromEntries(
            await Promise.all(
               [
                  "native/recorder.cpp",
                  "native/CMakeLists.txt",
                  "native/notifications/windows.cpp",
                  "native/notifications/CMakeLists.txt",
                  "scripts/build-native.ts",
               ].map(async (file) => [
                  file,
                  createHash("sha256")
                     .update(await readFile(path.join(root, file)))
                     .digest("hex"),
               ])
            )
         ),
         binaryHashes: Object.fromEntries(
            await Promise.all(
               ["attaclip-recorder.exe", "attaclip-notifier.exe", ...binaries].map(async (file) => [
                  file,
                  createHash("sha256")
                     .update(await readFile(path.join(runtime, file)))
                     .digest("hex"),
               ])
            )
         ),
         limitations: ["HDR capture is converted to SDR", "Overlap reduction preserves the preceding keyframe"],
      },
      null,
      2
   )
);
await cp(path.join(source, "COPYING"), path.join(runtime, "LICENSE-OBS"));
await download("https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT", path.join(runtime, "LICENSE-json"));
console.log(
   `Built real libOBS ${version} recorder and staged ${binaries.length} runtime files. Runtime ${await stat(path.join(runtime, "attaclip-recorder.exe")).then((s) => s.size)} bytes.`
);
