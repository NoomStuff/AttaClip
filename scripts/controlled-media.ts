import { execFileSync } from "node:child_process";
import path from "node:path";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { hashFile, type SourceKit } from "./release-sources";

export interface ControlledMediaBuild {
   version: 1;
   producer: "attaclip-controlled-windows";
   target: "windows-x64";
   sourceCommits: { ffmpeg: string; x264: string; dav1d: string; zlib: string };
   sourceArchives: { path: string; sha256: string; size: number }[];
   recipe: { path: string; sha256: string };
   evidenceFiles: { path: string; sha256: string; size: number }[];
   binaries: Record<"ffmpeg" | "ffprobe", { sha256: string; size: number; version: string }>;
}

const commits = {
   ffmpeg: "29e619e767cde9045a75c29bc9a8278ae7b3a98b",
   x264: "0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee",
   dav1d: "9711965b60bb692ae24004659acf61f5c7d9ed61",
   zlib: "51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf",
};

export function verifyControlledConfiguration(version: string, components: string): void {
   for (const flag of ["8.1.3-attaclip-local", "--disable-autodetect", "--enable-libx264", "--enable-libdav1d", "--enable-zlib", "--disable-network"])
      if (!version.includes(flag)) throw new Error(`Controlled executable configuration is missing ${flag}.`);
   for (const component of [
      "PNG_ENCODER",
      "MJPEG_ENCODER",
      "LIBX264_ENCODER",
      "AAC_ENCODER",
      "LIBDAV1D_DECODER",
      "HEVC_DECODER",
      "H264_DECODER",
      "VP8_DECODER",
      "VP9_DECODER",
      "OPUS_DECODER",
      "VORBIS_DECODER",
      "FLAC_DECODER",
      "MP3_DECODER",
      "LAVFI_INDEV",
      "SCALE_FILTER",
      "ARESAMPLE_FILTER",
      "FILE_PROTOCOL",
      "PIPE_PROTOCOL",
      "MOV_DEMUXER",
      "MATROSKA_DEMUXER",
      "MP4_MUXER",
   ])
      if (!new RegExp(`^#define CONFIG_${component} 1$`, "m").test(components)) throw new Error(`Controlled media is missing ${component}.`);
}

export async function recordControlledBuild(project: string): Promise<ControlledMediaBuild> {
   const kit = JSON.parse(await readFile(path.join(project, "work", "release-sources", "manifest.json"), "utf8")) as SourceKit;
   const directory = path.join(project, "work", "controlled-media", "windows-x64");
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
   const recipePath = "scripts/build-media-windows.sh";
   const recipeSha = await hashFile(path.join(directory, "build-media-windows.sh"));
   if ((await hashFile(path.join(project, recipePath))) !== recipeSha)
      throw new Error("Build recipe changed after compiling. Rebuild before recording provenance.");
   const binaries = {} as ControlledMediaBuild["binaries"];
   const components = await readFile(path.join(directory, "config_components.h"), "utf8");
   for (const name of ["ffmpeg", "ffprobe"] as const) {
      const file = path.join(directory, `${name}.exe`);
      const version = execFileSync(file, ["-version"], { windowsHide: true, encoding: "utf8" });
      verifyControlledConfiguration(version, components);
      const imports = await readFile(path.join(directory, `${name}-imports.txt`), "utf8");
      const permitted = new Set(["bcrypt.dll", "kernel32.dll", "msvcrt.dll", "shell32.dll"]);
      for (const match of imports.matchAll(/DLL Name:\s*(\S+)/g))
         if (!permitted.has(match[1]!.toLowerCase())) throw new Error(`Unexpected binary dependency: ${match[1]}`);
      binaries[name] = { sha256: await hashFile(file), size: (await stat(file)).size, version };
   }
   const evidenceFiles: ControlledMediaBuild["evidenceFiles"] = [];
   const walk = async (folder: string, prefix = ""): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
         const relative = path.posix.join(prefix, entry.name);
         const file = path.join(folder, entry.name);
         if (entry.isSymbolicLink()) throw new Error("Symlink in controlled build evidence.");
         if (entry.isDirectory()) await walk(file, relative);
         else if (entry.isFile() && !/\.exe$|^build-manifest\.json$/.test(relative))
            evidenceFiles.push({ path: relative, sha256: await hashFile(file), size: (await stat(file)).size });
      }
   };
   await walk(directory);
   const build: ControlledMediaBuild = {
      version: 1,
      producer: "attaclip-controlled-windows",
      target: "windows-x64",
      sourceCommits: commits,
      sourceArchives,
      recipe: { path: recipePath, sha256: recipeSha },
      evidenceFiles: evidenceFiles.sort((a, b) => a.path.localeCompare(b.path)),
      binaries,
   };
   await writeFile(path.join(directory, "build-manifest.json"), `${JSON.stringify(build, null, 2)}\n`);
   await writeFile(path.join(directory, "LICENSE"), await readFile(path.join(directory, "COPYING.GPLv2")));
   console.log(`Recorded controlled binaries and ${evidenceFiles.length} build evidence files.`);
   return build;
}

export async function readControlledBuild(directory: string): Promise<ControlledMediaBuild> {
   const build = JSON.parse(await readFile(path.join(directory, "build-manifest.json"), "utf8")) as ControlledMediaBuild;
   if (build.version !== 1 || build.producer !== "attaclip-controlled-windows" || JSON.stringify(build.sourceCommits) !== JSON.stringify(commits))
      throw new Error("Unknown controlled build provenance.");
   for (const name of ["ffmpeg", "ffprobe"] as const) {
      if ((await hashFile(path.join(directory, `${name}.exe`))) !== build.binaries[name].sha256)
         throw new Error(`Controlled ${name} binary changed after provenance was recorded.`);
   }
   for (const file of build.evidenceFiles) {
      const absolute = path.resolve(directory, file.path);
      if (!absolute.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error("Controlled evidence path escapes its directory.");
      if ((await hashFile(absolute)) !== file.sha256) throw new Error(`Controlled build evidence changed: ${file.path}`);
   }
   return build;
}

if (import.meta.main) await recordControlledBuild(process.cwd());
