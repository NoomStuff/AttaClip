import { copyFile, cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const version = "32.2.0";
const packageVersion = "32.2.0-0obsproject1~noble";
const root = process.cwd();
const runtime = path.resolve(process.env["ATTACLIP_RECORDER_STAGE"] ?? "resources/recorder");
if (runtime !== path.join(root, "resources", "recorder") && !runtime.startsWith(path.join(root, ".cache") + path.sep))
   throw new Error("Linux recorder staging must remain inside resources/recorder or the workspace .cache directory");
const run = (command: string, args: string[]): string => {
   const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
   if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
   return result.stdout;
};
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("This backend currently supports Linux x64");
if (run("pkg-config", ["--modversion", "libobs"]).trim() !== version || run("dpkg-query", ["-W", "-f=${Version}", "obs-studio"]).trim() !== packageVersion)
   throw new Error(`Install the official OBS PPA package obs-studio=${packageVersion}. Headers and runtime must match ${version}`);
const output = path.join(root, ".cache", "native-linux-build");
run("cmake", ["-S", path.join(root, "native"), "-B", output, "-DCMAKE_BUILD_TYPE=Release"]);
run("cmake", ["--build", output, "-j2"]);
await rm(runtime, { recursive: true, force: true });
await mkdir(path.join(runtime, "lib"), { recursive: true });
await mkdir(path.join(runtime, "obs-plugins"), { recursive: true });
await copyFile(path.join(output, "attaclip-recorder"), path.join(runtime, "attaclip-recorder"));
await copyFile("/usr/bin/obs-ffmpeg-mux", path.join(runtime, "obs-ffmpeg-mux"));
const libraryRoot = "/usr/lib/x86_64-linux-gnu";
const modules = ["linux-capture", "linux-pulseaudio", "obs-ffmpeg", "obs-nvenc", "obs-x264"];
const initialFiles = [path.join(runtime, "attaclip-recorder"), "/usr/bin/obs-ffmpeg-mux", path.join(libraryRoot, "libobs-opengl.so")];
await copyFile(path.join(libraryRoot, "libobs-opengl.so"), path.join(runtime, "lib", "libobs-opengl.so"));
for (const name of modules) {
   const module = path.join(libraryRoot, "obs-plugins", `${name}.so`);
   await copyFile(module, path.join(runtime, "obs-plugins", `${name}.so`));
   initialFiles.push(module);
   const data = path.join("/usr/share/obs/obs-plugins", name);
   if (existsSync(data)) await cp(data, path.join(runtime, "data/obs-plugins", name), { recursive: true });
}
await cp("/usr/share/obs/libobs", path.join(runtime, "data/libobs"), { recursive: true });
const recorded: Array<{ path: string; sha256: string; package: string }> = [];
const libraries = new Set<string>();
for (const input of initialFiles) {
   const result = run("ldd", [input]);
   if (result.includes("not found")) throw new Error(`Missing ELF dependency for ${input}\n${result}`);
   for (const line of result.split("\n")) {
      const match = /^\s*(\S+) => (\/\S+)/.exec(line);
      if (!match?.[1] || !match[2]) continue;
      // The loader, C runtime, and host GPU drivers belong to the target OS.
      if (/^(?:libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so|libGL|libEGL|libOpenGL|libcuda|libnvidia)/.test(match[1])) continue;
      if (libraries.has(match[1])) continue;
      libraries.add(match[1]);
      await copyFile(match[2], path.join(runtime, "lib", match[1]));
      const actual = await realpath(match[2]);
      const owner = run("dpkg-query", ["-S", actual]).trim().split(": ")[0]!;
      const sourcePackage = run("dpkg-query", ["-W", "-f=${source:Package} ${source:Version}", owner]).trim();
      recorded.push({
         path: `lib/${match[1]}`,
         sha256: createHash("sha256")
            .update(await readFile(actual))
            .digest("hex"),
         package: sourcePackage,
      });
   }
}
const sourceFiles = [
   "native/recorder.cpp",
   "native/x11-compat.cpp",
   "native/x11-compat.hpp",
   "native/linux-app-audio.cpp",
   "native/linux-app-audio.hpp",
   "native/CMakeLists.txt",
   "scripts/build-native-linux.ts",
];
await writeFile(
   path.join(runtime, "provenance.json"),
   JSON.stringify(
      {
         obsVersion: version,
         packageVersion,
         sourceCommit: "7546be7266dde276d82d4681fe1ab4fd8e32cf2b",
         source: "https://github.com/obsproject/obs-studio/tree/32.2.0",
         repository: "https://ppa.launchpadcontent.net/obsproject/obs-studio/ubuntu/",
         platform: "Ubuntu 24.04 x64, X11",
         modules,
         build: "scripts/build-native-linux.ts",
         recorder: {
            path: "attaclip-recorder",
            sha256: createHash("sha256")
               .update(await readFile(path.join(runtime, "attaclip-recorder")))
               .digest("hex"),
            size: (await stat(path.join(runtime, "attaclip-recorder"))).size,
         },
         libraries: recorded,
         sourceHashes: Object.fromEntries(
            await Promise.all(
               sourceFiles.map(async (file) => [
                  file,
                  createHash("sha256")
                     .update(await readFile(path.join(root, file)))
                     .digest("hex"),
               ])
            )
         ),
         limitations: [
            "Wayland capture unavailable",
            "Exact-window CPU compatibility capture can increase recording cost",
            "Corresponding Ubuntu dependency sources must be collected before public binary distribution",
         ],
      },
      null,
      2
   )
);
await cp("/usr/share/doc/obs-studio/copyright", path.join(runtime, "LICENSE-OBS"));
const license = await fetch("https://raw.githubusercontent.com/obsproject/obs-studio/7546be7266dde276d82d4681fe1ab4fd8e32cf2b/COPYING");
if (!license.ok) throw new Error("The pinned OBS license could not be retrieved");
await writeFile(path.join(runtime, "COPYING-OBS"), await license.text());
console.log(`Built Linux X11/PulseAudio recorder against exact OBS ${version}, staged ${libraries.size} ELF dependencies. ${runtime}`);
