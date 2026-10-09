import { execFileSync } from "node:child_process";
import path from "node:path";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { hashFile, type SourceKit } from "./release-sources";
import { verifyControlledConfiguration } from "./controlled-media";
import { checkMediaBinary } from "./check-media-binary";

export interface ControlledMacMediaBuild {
   version: 1;
   producer: "attaclip-controlled-macos";
   target: "macos-arm64";
   sourceCommits: { ffmpeg: string; x264: string; dav1d: string; zlib: string };
   sourceArchives: { path: string; sha256: string; size: number }[];
   recipe: { path: string; sha256: string };
   evidenceFiles: { path: string; sha256: string; size: number }[];
   binaries: Record<"ffmpeg" | "ffprobe", { sha256: string; size: number; version: string }>;
   systemDependencies: { binary: string; paths: string[] }[];
}

const commits = {
   ffmpeg: "29e619e767cde9045a75c29bc9a8278ae7b3a98b",
   x264: "0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee",
   dav1d: "9711965b60bb692ae24004659acf61f5c7d9ed61",
   zlib: "51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf",
};

export function macSystemRequirements(imports: string): string[] {
   const paths = imports
      .split(/\r?\n/)
      .filter((line) => /^\s+\S/.test(line))
      .map((line) => line.trim().split(/\s+/)[0]!);
   if (!paths.length) throw new Error("Missing Mach-O dependency evidence.");
   for (const file of paths) if (!/^\/(?:usr\/lib|System\/Library)\//.test(file)) throw new Error(`Unexpected shared media dependency: ${file}`);
   return [...new Set(paths)].sort();
}

export async function recordControlledMacBuild(project: string): Promise<ControlledMacMediaBuild> {
   if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Record macOS arm64 provenance on the matching Mac host.");
   const kit = JSON.parse(await readFile(path.join(project, "work", "release-sources", "manifest.json"), "utf8")) as SourceKit;
   const directory = path.join(project, "work", "controlled-media", "macos-arm64");
   if (!(await readFile(path.join(directory, "build.log"), "utf8")).trimEnd().endsWith(`Controlled macOS media build completed: ${directory}`))
      throw new Error("macOS media build did not finish. Do not record old binaries after a failed rebuild.");
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
   const recipePath = "scripts/build-media-macos.sh";
   const recipeSha = await hashFile(path.join(directory, "build-media-macos.sh"));
   if ((await hashFile(path.join(project, recipePath))) !== recipeSha)
      throw new Error("Build recipe changed after compiling. Rebuild before recording provenance.");
   const binaries = {} as ControlledMacMediaBuild["binaries"];
   const systemDependencies: ControlledMacMediaBuild["systemDependencies"] = [];
   const components = await readFile(path.join(directory, "config_components.h"), "utf8");
   for (const name of ["ffmpeg", "ffprobe"] as const) {
      const file = path.join(directory, name);
      const version = execFileSync(file, ["-version"], { windowsHide: true, encoding: "utf8" });
      verifyControlledConfiguration(version, components);
      for (const encoder of ["RAWVIDEO", "PCM_F32LE"])
         if (!new RegExp(`^#define CONFIG_${encoder}_ENCODER 1$`, "m").test(components))
            throw new Error(`Mac capture verification requires ${encoder} output.`);
      checkMediaBinary(file);
      const imports = execFileSync("otool", ["-L", file], { encoding: "utf8" });
      systemDependencies.push({ binary: name, paths: macSystemRequirements(imports) });
      binaries[name] = { sha256: await hashFile(file), size: (await stat(file)).size, version };
   }
   await writeFile(path.join(directory, "LICENSE"), await readFile(path.join(directory, "COPYING.GPLv2")));
   const evidenceFiles: ControlledMacMediaBuild["evidenceFiles"] = [];
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
   const build: ControlledMacMediaBuild = {
      version: 1,
      producer: "attaclip-controlled-macos",
      target: "macos-arm64",
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

export async function readControlledMacBuild(directory: string): Promise<ControlledMacMediaBuild> {
   const build = JSON.parse(await readFile(path.join(directory, "build-manifest.json"), "utf8")) as ControlledMacMediaBuild;
   if (
      build.version !== 1 ||
      build.producer !== "attaclip-controlled-macos" ||
      build.target !== "macos-arm64" ||
      JSON.stringify(build.sourceCommits) !== JSON.stringify(commits)
   )
      throw new Error("Unknown controlled build provenance.");
   for (const required of [
      "build-media-macos.sh",
      "config_components.h",
      "config.h",
      "config.mak",
      "config.log",
      "toolchain.txt",
      "LICENSE-x264",
      "LICENSE-dav1d",
      "LICENSE-zlib",
      "COPYING.GPLv2",
      "verification/codecs.json",
   ])
      if (!build.evidenceFiles.some((file) => file.path === required)) throw new Error(`Missing controlled build evidence: ${required}`);
   if (build.sourceArchives.length !== 4) throw new Error("Controlled macOS source inputs are incomplete.");
   for (const name of ["ffmpeg", "ffprobe"] as const) {
      if (
         (await hashFile(path.join(directory, name))) !== build.binaries[name].sha256 ||
         (await stat(path.join(directory, name))).size !== build.binaries[name].size
      )
         throw new Error(`Controlled ${name} binary changed after provenance was recorded.`);
   }
   for (const file of build.evidenceFiles) {
      const absolute = path.resolve(directory, file.path);
      if (!absolute.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error("Controlled evidence path escapes its directory.");
      if ((await hashFile(absolute)) !== file.sha256) throw new Error(`Controlled build evidence changed: ${file.path}`);
   }
   const fixtures = JSON.parse(await readFile(path.join(directory, "verification/codecs.json"), "utf8")) as {
      controlledSha256: string;
      referenceSha256: string;
      results: { format: string; fullDecode: boolean; firstFrameMatches: boolean }[];
   };
   if (
      fixtures.controlledSha256 !== build.binaries.ffmpeg.sha256 ||
      fixtures.referenceSha256 === fixtures.controlledSha256 ||
      fixtures.results.length !== 8 ||
      fixtures.results.some((result) => !result.fullDecode || !result.firstFrameMatches)
   )
      throw new Error("Controlled codec proof does not cover these binaries.");
   return build;
}

if (import.meta.main) await recordControlledMacBuild(process.cwd());
