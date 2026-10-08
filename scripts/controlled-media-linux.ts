import { execFileSync } from "node:child_process";
import path from "node:path";
import { readFile, writeFile, readdir, stat, mkdir, copyFile } from "node:fs/promises";
import { hashFile, type SourceKit } from "./release-sources";
import { verifyControlledConfiguration } from "./controlled-media";
import { checkMediaBinary } from "./check-media-binary";

export interface ControlledLinuxMediaBuild {
   version: 1;
   producer: "attaclip-controlled-linux";
   target: "linux-x64";
   sourceCommits: { ffmpeg: string; x264: string; dav1d: string; zlib: string };
   sourceArchives: { path: string; sha256: string; size: number }[];
   recipe: { path: string; sha256: string };
   evidenceFiles: { path: string; sha256: string; size: number }[];
   binaries: Record<"ffmpeg" | "ffprobe", { sha256: string; size: number; version: string }>;
   systemDependencies: { binary: string; sonames: string[]; glibcVersions: string[] }[];
}

const commits = {
   ffmpeg: "29e619e767cde9045a75c29bc9a8278ae7b3a98b",
   x264: "0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee",
   dav1d: "9711965b60bb692ae24004659acf61f5c7d9ed61",
   zlib: "51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf",
};

export function linuxSystemRequirements(dynamic: string, symbols: string): { sonames: string[]; glibcVersions: string[] } {
   const sonames = [...dynamic.matchAll(/\(NEEDED\)[^\n]*\[([^\]]+)\]/g)].map((match) => match[1]!);
   const permitted = /^(?:lib(?:c|m|mvec|dl|rt|pthread|resolv|util)\.so\.\d+|libgcc_s\.so\.1|ld-linux(?:-x86-64|-aarch64)?\.so\.[12])$/;
   for (const name of sonames) if (!permitted.test(name)) throw new Error(`Unexpected shared media dependency: ${name}`);
   const glibcVersions = [...new Set([...symbols.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g)].map((match) => match[1]!))].sort((a, b) => {
      const left = a.split(".").map(Number);
      const right = b.split(".").map(Number);
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
         const difference = (left[index] ?? 0) - (right[index] ?? 0);
         if (difference) return difference;
      }
      return 0;
   });
   return { sonames, glibcVersions };
}

export async function recordControlledLinuxBuild(project: string): Promise<ControlledLinuxMediaBuild> {
   if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Record Linux x64 provenance on the matching Linux host.");
   const kit = JSON.parse(await readFile(path.join(project, "work", "release-sources", "manifest.json"), "utf8")) as SourceKit;
   const directory = path.join(project, "work", "controlled-media", "linux-x64");
   if (!(await readFile(path.join(directory, "build.log"), "utf8")).trimEnd().endsWith(`Controlled Linux media build completed: ${directory}`))
      throw new Error("Linux media build did not finish. Do not record old binaries after a failed rebuild.");
   const sourceArchives = [
      kit.sources.find((source) => source.repository === "FFmpeg/FFmpeg" && source.commit === commits.ffmpeg),
      kit.dependencySources?.find((source) => source.origin.endsWith("/x264.git") && source.resolvedRevision === commits.x264),
      kit.dependencySources?.find((source) => source.origin.endsWith("/dav1d.git") && source.resolvedRevision === commits.dav1d),
      kit.dependencySources?.find((source) => source.origin.endsWith("/zlib.git") && source.resolvedRevision === commits.zlib),
   ].map((source) => {
      if (!source) throw new Error("Controlled build source archive is missing.");
      return { path: source.path, sha256: source.sha256, size: source.size };
   });
   for (const source of sourceArchives) {
      if ((await hashFile(path.join(project, "work", "release-sources", source.path))) !== source.sha256) throw new Error("Controlled source archive changed.");
   }
   const recipePath = "scripts/build-media-linux.sh";
   const recipeSha = await hashFile(path.join(directory, "build-media-linux.sh"));
   if ((await hashFile(path.join(project, recipePath))) !== recipeSha)
      throw new Error("Build recipe changed after compiling. Rebuild before recording provenance.");
   const binaries = {} as ControlledLinuxMediaBuild["binaries"];
   const systemDependencies: ControlledLinuxMediaBuild["systemDependencies"] = [];
   const components = await readFile(path.join(directory, "config_components.h"), "utf8");
   for (const name of ["ffmpeg", "ffprobe"] as const) {
      const file = path.join(directory, name);
      const version = execFileSync(file, ["-version"], { windowsHide: true, encoding: "utf8" });
      verifyControlledConfiguration(version, components);
      checkMediaBinary(file);
      const dynamic = execFileSync("readelf", ["-d", file], { encoding: "utf8" });
      const symbols = execFileSync("readelf", ["--version-info", file], { encoding: "utf8" });
      systemDependencies.push({ binary: name, ...linuxSystemRequirements(dynamic, symbols) });
      binaries[name] = { sha256: await hashFile(file), size: (await stat(file)).size, version };
   }
   await writeFile(path.join(directory, "LICENSE"), await readFile(path.join(directory, "COPYING.GPLv2")));
   const gccRuntime = execFileSync("gcc", ["-print-libgcc-file-name"], { encoding: "utf8" }).trim();
   const gccOwner = execFileSync("dpkg-query", ["-S", gccRuntime], { encoding: "utf8" }).trim().split(": ")[0]!;
   const toolchainNotices = path.join(directory, "toolchain-notices");
   await mkdir(toolchainNotices, { recursive: true });
   await copyFile(path.join("/usr/share/doc", gccOwner.replace(/:[^:]+$/, ""), "copyright"), path.join(toolchainNotices, "GCC-runtime-copyright.txt"));
   await writeFile(
      path.join(toolchainNotices, "GCC-runtime.json"),
      `${JSON.stringify({ archive: gccRuntime, sha256: await hashFile(gccRuntime), package: execFileSync("dpkg-query", ["-W", "-f=${source:Package} ${source:Version}", gccOwner], { encoding: "utf8" }).trim(), license: "GPL-3.0-or-later WITH GCC-exception-3.1" }, null, 2)}\n`
   );
   const evidenceFiles: ControlledLinuxMediaBuild["evidenceFiles"] = [];
   const walk = async (folder: string, prefix = ""): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
         const relative = path.posix.join(prefix, entry.name);
         const file = path.join(folder, entry.name);
         if (entry.isSymbolicLink()) throw new Error("Symlink in controlled build evidence.");
         if (entry.isDirectory()) await walk(file, relative);
         else if (entry.isFile() && !/^(?:ffmpeg|ffprobe|build-manifest\.json)$/.test(relative))
            evidenceFiles.push({ path: relative, sha256: await hashFile(file), size: (await stat(file)).size });
      }
   };
   await walk(directory);
   const build: ControlledLinuxMediaBuild = {
      version: 1,
      producer: "attaclip-controlled-linux",
      target: "linux-x64",
      sourceCommits: commits,
      sourceArchives,
      recipe: { path: recipePath, sha256: recipeSha },
      evidenceFiles: evidenceFiles.sort((a, b) => a.path.localeCompare(b.path)),
      binaries,
      systemDependencies,
   };
   await writeFile(path.join(directory, "build-manifest.json"), `${JSON.stringify(build, null, 2)}\n`);
   console.log(`Recorded controlled binaries and ${evidenceFiles.length} build evidence files.`);
   return build;
}

export async function readControlledLinuxBuild(directory: string): Promise<ControlledLinuxMediaBuild> {
   const build = JSON.parse(await readFile(path.join(directory, "build-manifest.json"), "utf8")) as ControlledLinuxMediaBuild;
   if (build.version !== 1 || build.producer !== "attaclip-controlled-linux" || JSON.stringify(build.sourceCommits) !== JSON.stringify(commits))
      throw new Error("Unknown controlled build provenance.");
   for (const name of ["ffmpeg", "ffprobe"] as const) {
      if ((await hashFile(path.join(directory, name))) !== build.binaries[name].sha256)
         throw new Error(`Controlled ${name} binary changed after provenance was recorded.`);
   }
   for (const file of build.evidenceFiles) {
      const absolute = path.resolve(directory, file.path);
      if (!absolute.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error("Controlled evidence path escapes its directory.");
      if ((await hashFile(absolute)) !== file.sha256) throw new Error(`Controlled build evidence changed: ${file.path}`);
   }
   return build;
}

if (import.meta.main) await recordControlledLinuxBuild(process.cwd());
