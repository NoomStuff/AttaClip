import { execFileSync } from "node:child_process";
import { readFile, mkdir, copyFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { hashFile, type SourceKit } from "./release-sources";
import { macRecipe } from "./macos-obs-sources";

interface LibraryProbe {
   file: string;
   version: number;
   configuration: string;
}
interface RuntimeProbe {
   version: number;
   officialArchive: { name: string; sha256: string };
   sourceCommit: string;
   provenanceSha256: string;
   providerFiles: { path: string; sha256: string; size: number; imports: string }[];
   ffmpegConfigurations: LibraryProbe[];
}

export function ffmpegHeaderVersion(headers: string, prefix: string): number {
   const values = ["MAJOR", "MINOR", "MICRO"].map((suffix) => {
      const value = new RegExp(`^#define ${prefix}_VERSION_${suffix}\\s+(\\d+)\\s*$`, "m").exec(headers)?.[1];
      if (!value) throw new Error(`Missing exact source version: ${prefix}_${suffix}`);
      return Number(value);
   });
   return values[0]! * 65536 + values[1]! * 256 + values[2]!;
}

export function checkMacFfmpegSources(libraries: LibraryProbe[], headers: Record<string, string>): void {
   const expected = ["avcodec", "avformat", "avutil", "avdevice", "avfilter", "swscale", "swresample"];
   if (libraries.length !== expected.length || new Set(libraries.map((library) => library.file)).size !== expected.length)
      throw new Error("Missing or duplicate FFmpeg library proof.");
   const configuration = libraries[0]!.configuration;
   if (!configuration.includes("--enable-gpl") || !configuration.includes("--enable-version3")) throw new Error("Unexpected OBS FFmpeg license configuration.");
   const permitted = new Set(["libaom", "libtheora", "libmp3lame", "libx264", "libopus", "libvorbis", "libvpx", "librist", "libsrt"]);
   for (const flag of configuration.match(/--enable-lib[\w-]+/g) ?? [])
      if (!permitted.has(flag.slice("--enable-".length))) throw new Error(`No captured Mac source for enabled dependency: ${flag}`);
   for (const library of expected) {
      const file = `Frameworks/lib${library}.dylib`;
      const probe = libraries.find((entry) => entry.file === file);
      if (!probe || probe.configuration !== configuration) throw new Error(`FFmpeg libraries were built with different configurations: ${file}`);
      const source = headers[library];
      if (!source || probe.version !== ffmpegHeaderVersion(source, `LIB${library.toUpperCase()}`))
         throw new Error(`Actual FFmpeg version differs from the captured source: ${file}`);
   }
}

export async function verifyMacObsSourceInputs(project: string, directory: string, proofFile: string): Promise<void> {
   const kit = JSON.parse(await readFile(path.join(directory, "obs-inputs.json"), "utf8")) as SourceKit;
   if (kit.platform !== "darwin-arm64" || kit.sources.length !== 3 || kit.dependencySources?.length !== 17 || kit.dependencyFailures?.length)
      throw new Error("Mac OBS source input collection is incomplete.");
   const proof = JSON.parse(await readFile(proofFile, "utf8")) as RuntimeProbe;
   if (
      proof.version !== 1 ||
      proof.sourceCommit !== "ba2f32bdf791005443988a4955e963663e16b1ed" ||
      proof.officialArchive.sha256 !== "920d6f26703d2df6e4085bd3c1cbed30488325084136c7a6e9e37021fbd6aaf7"
   )
      throw new Error("Runtime proof refers to another official OBS release.");
   const sources = [...kit.sources, ...kit.dependencySources];
   const recipes = kit.sources.find((source) => source.repository === "obsproject/obs-deps" && source.commit === "8683107a02300923abe4f293920f4b5edc8cb624");
   if (!recipes) throw new Error("The exact Mac recipe archive is missing.");
   const readRecipe = (member: string) => execFileSync("tar", ["-xOf", path.join(directory, recipes.path), member], { encoding: "utf8", windowsHide: true });
   if (new Set(kit.dependencySources.map((source) => source.recipe)).size !== 17) throw new Error("Duplicate Mac dependency source records.");
   for (const dependency of kit.dependencySources) {
      const ref = macRecipe(readRecipe(dependency.recipe), dependency.recipe);
      const checksum = ref.revision.startsWith("${PSScriptRoot}/")
         ? /[a-f\d]{64}/i.exec(readRecipe(path.posix.join(path.posix.dirname(dependency.recipe), ref.revision.slice("${PSScriptRoot}/".length))))?.[0]
         : undefined;
      if (dependency.origin !== ref.uri || dependency.resolvedRevision !== (checksum ?? ref.revision) || (checksum && checksum !== dependency.sha256))
         throw new Error(`Source input differs from the immutable Mac recipe: ${dependency.recipe}`);
   }
   const records = sources.flatMap((source) => [source, ...source.licenses]);
   for (const record of records) {
      const absolute = path.resolve(directory, record.path);
      if (!absolute.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error("Mac source input escapes its packet.");
      if ((await hashFile(absolute)) !== record.sha256 || (await stat(absolute)).size !== record.size)
         throw new Error(`Mac source input changed: ${record.path}`);
   }
   const ffmpeg = kit.dependencySources.find((source) => source.recipe.endsWith("/99-ffmpeg.zsh"));
   if (ffmpeg?.resolvedRevision !== "38b88335f99e76ed89ff3c93f877fdefce736c13") throw new Error("OBS Mac FFmpeg source pin changed.");
   const archive = path.join(directory, ffmpeg.path);
   const members = execFileSync("tar", ["-tf", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).split(/\r?\n/);
   const headers: Record<string, string> = {};
   for (const library of ["avcodec", "avformat", "avutil", "avdevice", "avfilter", "swscale", "swresample"]) {
      headers[library] = members
         .filter((member) => new RegExp(`(?:^|/)lib${library}/version(?:_major)?\\.h$`).test(member))
         .map((member) => execFileSync("tar", ["-xOf", archive, member], { encoding: "utf8", windowsHide: true }))
         .join("\n");
   }
   checkMacFfmpegSources(proof.ffmpegConfigurations, headers);
   // Only stage notices on the actual Mac host whose files were compared.
   if (process.platform === "darwin") {
      const runtime = path.join(project, "resources/recorder");
      if ((await hashFile(path.join(runtime, "provenance.json"))) !== proof.provenanceSha256) throw new Error("Recorder changed after source comparison.");
      for (const file of proof.providerFiles) {
         const absolute = path.resolve(runtime, file.path);
         if (!absolute.startsWith(`${runtime}${path.sep}`) || (await hashFile(absolute)) !== file.sha256)
            throw new Error(`Mac provider file changed: ${file.path}`);
      }
      for (const license of sources.flatMap((source) => source.licenses)) {
         const target = path.resolve(project, "resources/notices/native-macos", license.path);
         if (!target.startsWith(`${path.resolve(project, "resources/notices/native-macos")}${path.sep}`))
            throw new Error("Native notice path escapes its folder.");
         await mkdir(path.dirname(target), { recursive: true });
         await copyFile(path.join(directory, license.path), target);
      }
   }
   await writeFile(
      path.join(directory, "obs-source-validation.json"),
      `${JSON.stringify({ version: 1, appCommit: kit.appCommit, runtimeProofSha256: await hashFile(proofFile), sourceRecords: records, ffmpegLibraries: proof.ffmpegConfigurations, providerFiles: proof.providerFiles, fullNoticeCount: sources.flatMap((source) => source.licenses).length, publicInstallerReady: false, remaining: "Frozen application archive and final packaged-container/updater proof are required." }, null, 2)}\n`
   );
   console.log("Mac OBS source versions/configuration verified. Final packaged release proof remains required.");
}

if (import.meta.main)
   await verifyMacObsSourceInputs(
      process.cwd(),
      path.join(process.cwd(), "work/macos-release-sources"),
      path.join(process.cwd(), ".cache/macos-source/runtime-proof.json")
   );
