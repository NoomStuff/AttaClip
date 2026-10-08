import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, stat, copyFile } from "node:fs/promises";
import path from "node:path";
import { hashFile, type SourceKit } from "./release-sources";

type FileRecord = NonNullable<SourceKit["evidence"]>["components"][number]["sourceArchives"][number];
const pins = {
   electronVersion: "44.7.0",
   electron: "61f55c4ce540416b3e43f75f6c0f125d22e5e908",
   chromiumVersion: "152.0.7977.130",
   chromium: "2c592105bbcd9490a9894df48d0fe59b2c512651",
   ffmpeg: "2b68d2babae73714846961fb0ee47e3b3d2e39a9",
   opus: "55513e81d8f606bd75d0ff773d2144e5f2a732f5",
   nasm: "525a09a813be0f75b646ee93fc2a31c27b87d722",
};

export async function collectElectronFfmpeg(
   project: string,
   directory: string,
   options: { platform?: "win32" | "linux"; binaryArchive?: string; sourceCache?: string } = {}
): Promise<{
   id: string;
   version: string;
   license: string;
   sourceArchives: FileRecord[];
   licenseFiles: FileRecord[];
   buildInstructions: FileRecord[];
}> {
   const version = (JSON.parse(await readFile(path.join(project, "node_modules/electron/package.json"), "utf8")) as { version: string }).version;
   if (version !== pins.electronVersion) throw new Error("Electron changed. Review its Chromium FFmpeg source pins before release.");
   const platform = options.platform ?? "win32";
   const configPlatform = platform === "win32" ? "win" : "linux";
   const moduleName = platform === "win32" ? "ffmpeg.dll" : "libffmpeg.so";
   const folder = path.join(directory, "evidence", platform === "win32" ? "electron-ffmpeg" : "electron-ffmpeg-linux");
   await mkdir(folder, { recursive: true });
   const record = async (file: string): Promise<FileRecord> => ({
      path: path.relative(directory, file).replaceAll("\\", "/"),
      sha256: await hashFile(file),
      size: (await stat(file)).size,
   });
   const download = async (url: string, name: string): Promise<string> => {
      const file = path.join(folder, name);
      // Reuse pinned source responses only. Release archives still need their official checksum.
      if (!existsSync(file) && options.sourceCache && existsSync(path.join(options.sourceCache, name)))
         await copyFile(path.join(options.sourceCache, name), file);
      if (!existsSync(file)) {
         const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
         if (!response.ok) throw new Error(`Electron source download failed: ${url}: HTTP ${response.status}`);
         await writeFile(file, new Uint8Array(await response.arrayBuffer()));
      }
      return file;
   };
   const github = `https://raw.githubusercontent.com/electron/electron/${pins.electron}`;
   const chrome = `https://chromium.googlesource.com/chromium/src/+/${pins.chromium}`;
   const ffmpeg = `https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/${pins.ffmpeg}`;
   const electronDeps = await download(`${github}/DEPS`, "electron-DEPS.txt");
   const chromeDepsEncoded = await download(`${chrome}/DEPS?format=TEXT`, "chromium-DEPS.base64");
   const chromeDeps = Buffer.from(await readFile(chromeDepsEncoded, "utf8"), "base64").toString("utf8");
   if (!(await readFile(electronDeps, "utf8")).includes(`'${pins.chromiumVersion}'`) || !chromeDeps.includes(`'ffmpeg_revision': '${pins.ffmpeg}'`))
      throw new Error("Electron/Chromium dependency pins changed or source response is invalid.");
   const chromeDepsFile = path.join(folder, "chromium-DEPS.txt");
   await writeFile(chromeDepsFile, chromeDeps);
   for (const [name, url, commit] of [
      ["chromium-commit.json", `${chrome}?format=JSON`, pins.chromium],
      ["ffmpeg-commit.json", `${ffmpeg}?format=JSON`, pins.ffmpeg],
   ]) {
      const file = await download(url!, name!);
      const metadata = JSON.parse((await readFile(file, "utf8")).replace(/^\)\]\}'\s*/, "")) as { commit: string };
      if (metadata.commit !== commit) throw new Error("Chromium source metadata identifies a different commit.");
   }
   const sourceArchives: FileRecord[] = [];
   const licenseFiles: FileRecord[] = [];
   for (const [name, url] of [
      ["electron", `https://codeload.github.com/electron/electron/tar.gz/${pins.electron}`],
      ["chromium-ffmpeg", `https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/${pins.ffmpeg}.tar.gz`],
      ["chromium-build", `https://chromium.googlesource.com/chromium/src/+archive/${pins.chromium}/build.tar.gz`],
      ["chromium-opus", `https://chromium.googlesource.com/chromium/src/+archive/${pins.chromium}/third_party/opus.tar.gz`],
      ["chromium-nasm", "https://chromium.googlesource.com/chromium/deps/nasm/+archive/525a09a813be0f75b646ee93fc2a31c27b87d722.tar.gz"],
      ["chromium-generate-stubs", `https://chromium.googlesource.com/chromium/src/+archive/${pins.chromium}/tools/generate_stubs.tar.gz`],
      ["chromium-testing-build", `https://chromium.googlesource.com/chromium/src/+archive/${pins.chromium}/testing.tar.gz`],
   ]) {
      const file = await download(url!, `${name}.tar.gz`);
      const members = execFileSync("tar", ["-tf", file], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
         .trim()
         .split(/\r?\n/);
      for (const member of members.filter((member) => /(?:^|\/)(?:COPYING(?:\.[^/]*)?|LICEN[CS]E(?:\.[^/]*)?|NOTICE(?:\.[^/]*)?)$/i.test(member))) {
         const target = path.resolve(folder, "licenses", name!, member);
         if (!target.startsWith(`${path.resolve(folder)}${path.sep}`)) throw new Error("Unsafe Electron license path.");
         const text = execFileSync("tar", ["-xOf", file, member], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
         await mkdir(path.dirname(target), { recursive: true });
         await writeFile(target, text);
         licenseFiles.push(await record(target));
      }
      if (name === "chromium-ffmpeg") {
         const configName = members.find((member) => member === `chromium/config/Chrome/${configPlatform}/x64/config.h`);
         if (!configName) throw new Error(`Chromium ${platform} Chrome FFmpeg configuration is missing.`);
         const config = execFileSync("tar", ["-xOf", file, configName], { encoding: "utf8", windowsHide: true });
         if (!/^#define CONFIG_GPL 0$/m.test(config) || !/^#define CONFIG_NONFREE 0$/m.test(config))
            throw new Error("Chromium FFmpeg license configuration is unexpected.");
         await writeFile(path.join(folder, `ffmpeg-${configPlatform}-x64-config.h`), config);
      }
      sourceArchives.push(await record(file));
      console.log(`Captured Electron FFmpeg source input: ${name}`);
   }
   const sumsFile = await download(`https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`, "electron-SHASUMS256.txt");
   const zipName = `electron-v${version}-${platform}-x64.zip`;
   const expected = (await readFile(sumsFile, "utf8"))
      .split(/\r?\n/)
      .find((line) => line.endsWith(zipName) && /\s\*?electron-v/.test(line))
      ?.slice(0, 64);
   if (!expected || !/^[a-f\d]{64}$/.test(expected)) throw new Error("Electron official binary checksum is absent.");
   let binaryArchive: string | undefined = options.binaryArchive;
   const cache = path.join(process.env["LOCALAPPDATA"] || "", "electron/Cache");
   if (!binaryArchive && existsSync(cache))
      binaryArchive = (await readdir(cache, { recursive: true }))
         .filter((file) => path.basename(file) === zipName)
         .map((file) => path.join(cache, file))
         .find((file) => existsSync(file));
   binaryArchive ??= await download(`https://github.com/electron/electron/releases/download/v${version}/${zipName}`, zipName);
   if ((await hashFile(binaryArchive)) !== expected) throw new Error("Electron binary archive checksum mismatch.");
   const officialDll = execFileSync(
      process.platform === "linux" ? "unzip" : "tar",
      process.platform === "linux" ? ["-p", binaryArchive, moduleName] : ["-xOf", binaryArchive, moduleName],
      {
         windowsHide: true,
         maxBuffer: 16 * 1024 * 1024,
      }
   );
   const actualModule = path.join(project, "node_modules/electron/dist", moduleName);
   const actualDll = await readFile(actualModule);
   if (!actualDll.equals(officialDll)) throw new Error("Electron FFmpeg module differs from the official release archive.");
   const buildInstructions: FileRecord[] = [];
   for (const [name, url] of [
      ["electron-all.gn", `${github}/build/args/all.gn`],
      ["electron-release.gn", `${github}/build/args/release.gn`],
      ["electron-ffmpeg.patch", `${github}/patches/ffmpeg/link_with_loader_path.patch`],
      ["electron-ffmpeg-patches.txt", `${github}/patches/ffmpeg/.patches`],
   ])
      buildInstructions.push(await record(await download(url!, name!)));
   for (const [name, source] of [
      ["chromium-root.gn", ".gn"],
      ["chromium-root-BUILD.gn", "BUILD.gn"],
      ["chromium-LICENSE.txt", "LICENSE"],
   ]) {
      const encoded = await download(`${chrome}/${source}?format=TEXT`, `${name}.base64`);
      const file = path.join(folder, name!);
      await writeFile(file, Buffer.from(await readFile(encoded, "utf8"), "base64"));
      buildInstructions.push(await record(file));
      if (source === "LICENSE") licenseFiles.push(await record(file));
   }
   const metadataFile = path.join(folder, "correspondence.json");
   await writeFile(
      metadataFile,
      `${JSON.stringify({ ...pins, ...(platform === "linux" ? { platform, moduleName } : {}), officialArchive: { name: zipName, sha256: expected }, ffmpegDll: { sha256: await hashFile(actualModule), size: actualDll.length }, sourceArchives, licenseFiles, buildInstructions }, null, 2)}\n`
   );
   const instructionsFile = path.join(folder, "BUILD.txt");
   await writeFile(
      instructionsFile,
      `Electron ${version} FFmpeg module\n\nThe captured Electron DEPS pins Chromium ${pins.chromiumVersion}, commit ${pins.chromium}. Chromium DEPS pins FFmpeg ${pins.ffmpeg}. The bundled ${moduleName} was compared byte-for-byte with the checksum-verified official Electron zip.\n\nExtract chromium-ffmpeg.tar.gz as src/third_party/ffmpeg in a Chromium checkout at the captured commit. Extract the Electron source as src/electron and Chromium build scripts as src/build. Restore chromium-opus.tar.gz under src/third_party/opus, chromium-nasm.tar.gz under src/third_party/nasm, chromium-generate-stubs.tar.gz under src/tools/generate_stubs, and chromium-testing-build.tar.gz under src/testing. The captured Opus tree records upstream revision ${pins.opus}, with Chromium local changes. Restore chromium-root.gn as src/.gn and chromium-root-BUILD.gn as src/BUILD.gn. Follow Electron's captured docs/development/build-instructions-gn.md and platform instructions. Synchronize the pinned DEPS inputs with depot_tools, apply the captured Electron FFmpeg patch list, generate out/Release using electron/build/args/release.gn, and build the ffmpeg GN target. The release configuration uses Chrome branding, proprietary_codecs=true, and is_component_ffmpeg=true. The captured ${platform === "win32" ? "Windows" : "Linux"} x64 config has CONFIG_GPL=0 and CONFIG_NONFREE=0. The Electron FFmpeg patch only changes macOS install_name; its complete text is included. Generic compiler/toolchain downloads are not library source.\n\nElectron's MIT license does not replace this module's LGPL license. The module's complete source, generated configuration, license files, build scripts, patches, and immutable dependency records are included here.\n`
   );
   buildInstructions.push(
      await record(electronDeps),
      await record(chromeDepsFile),
      await record(path.join(folder, "chromium-commit.json")),
      await record(path.join(folder, "ffmpeg-commit.json")),
      await record(metadataFile),
      await record(instructionsFile),
      await record(path.join(folder, `ffmpeg-${configPlatform}-x64-config.h`)),
      await record(sumsFile)
   );
   return { id: "electron-ffmpeg-source", version, license: "LGPL-2.1-or-later", sourceArchives, licenseFiles, buildInstructions };
}

if (import.meta.main) await collectElectronFfmpeg(process.cwd(), path.join(process.cwd(), "work/release-sources"));
