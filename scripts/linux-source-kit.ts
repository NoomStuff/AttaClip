import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { hashFile, inventory } from "./release-sources";
import { readControlledLinuxBuild } from "./controlled-media-linux";

const fileSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f\d]{64}$/), size: z.number().int().nonnegative() });
type FileRecord = z.infer<typeof fileSchema>;
const sourceSchema = fileSchema.extend({ url: z.string().optional() });
const packageSchema = z.object({
   binaryPackage: z.string(),
   binaryVersion: z.string(),
   sourcePackage: z.string(),
   sourceVersion: z.string(),
   binaryArchive: z.object({ path: z.string(), sha256: z.string() }).optional(),
   sourceArchives: z.array(sourceSchema).min(1),
   copyright: z.object({ path: z.string(), sha256: z.string() }).optional(),
});
const nativeSchema = z.object({
   packages: z.array(packageSchema).min(1),
   blockers: z.array(z.string()),
   commonLicenses: z.array(z.object({ path: z.string(), sha256: z.string() })).min(1),
});
const staticSchema = z.object({
   packages: z.array(packageSchema).min(1),
   blockers: z.array(z.string()),
   buildinfo: z.object({ path: z.string(), sha256: z.string() }),
});
const electronSchema = z.object({
   id: z.literal("electron-ffmpeg-source"),
   version: z.string(),
   sourceArchives: z.array(fileSchema).min(1),
   licenseFiles: z.array(fileSchema).min(1),
   buildInstructions: z.array(fileSchema).min(1),
});
const toolsetSchema = z.object({
   toolset: fileSchema,
   runtime: fileSchema,
   packages: z.array(z.object({ binaryArchive: fileSchema, sourceArchives: z.array(sourceSchema).min(1), copyright: fileSchema, file: fileSchema })).length(6),
   sources: z.array(sourceSchema).min(4),
   licenseFiles: z.array(fileSchema).min(1),
   buildInstructions: z.array(fileSchema).min(1),
   blockers: z.array(z.string()),
});

export interface LinuxSourceKit {
   version: 1;
   platform: "linux-x64";
   appCommit: string;
   staged: FileRecord[];
   files: FileRecord[];
   applicationSource: FileRecord;
   sourcePackageCounts: { native: number; static: number };
   nativeElfPaths: string[];
   appimage: { runtime: FileRecord; libraries: FileRecord[] };
}

const kitSchema = z.object({
   version: z.literal(1),
   platform: z.literal("linux-x64"),
   appCommit: z.string().regex(/^[a-f\d]{40}$/),
   staged: z.array(fileSchema).min(1),
   files: z.array(fileSchema).min(1),
   applicationSource: fileSchema,
   sourcePackageCounts: z.object({ native: z.number().int().positive(), static: z.number().int().positive() }),
   nativeElfPaths: z.array(z.string()).min(1),
   appimage: z.object({ runtime: fileSchema, libraries: z.array(fileSchema).length(6) }),
});

export async function verifyPacketFiles(directory: string, files: FileRecord[]): Promise<void> {
   const seen = new Set<string>();
   const root = await realpath(directory);
   for (const file of files) {
      const absolute = packetPath(directory, file.path);
      if (seen.has(file.path)) throw new Error(`Duplicate source packet path: ${file.path}`);
      seen.add(file.path);
      const attributes = await lstat(absolute);
      if (!attributes.isFile() || !(await realpath(absolute)).startsWith(root + path.sep)) throw new Error(`Unsafe source packet file: ${file.path}`);
      if (attributes.size !== file.size || (await hashFile(absolute)) !== file.sha256) throw new Error(`Source packet file changed: ${file.path}`);
   }
}

export function packetPath(directory: string, relative: string): string {
   if (
      !relative ||
      relative.includes("\\") ||
      path.posix.isAbsolute(relative) ||
      relative.includes(":") ||
      relative.split("/").some((part) => part === ".." || part === "." || !part)
   )
      throw new Error(`Unsafe source packet path: ${relative}`);
   const absolute = path.resolve(directory, relative);
   if (!absolute.startsWith(path.resolve(directory) + path.sep)) throw new Error("Source path escapes packet directory");
   return absolute;
}

export function linuxPath(file: string): string {
   return process.platform === "win32"
      ? execFileSync("wsl", ["-d", "Ubuntu", "--exec", "wslpath", "-u", path.resolve(file)], { encoding: "utf8", windowsHide: true }).trim()
      : path.resolve(file);
}

export function linuxPython(project: string, script: string, args: string[]): void {
   const command = process.platform === "win32" ? "wsl" : "python3";
   const parameters =
      process.platform === "win32"
         ? ["-d", "Ubuntu", "--exec", "python3", linuxPath(path.join(project, script)), ...args]
         : [path.join(project, script), ...args];
   execFileSync(command, parameters, { stdio: "pipe", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

export async function collectLinuxSourceFiles(
   project: string,
   stage: string,
   directory: string
): Promise<{ files: FileRecord[]; nativeCount: number; staticCount: number; appimage: LinuxSourceKit["appimage"] }> {
   linuxPython(project, "scripts/collect-linux-sources.py", [
      "--stage",
      linuxPath(path.join(stage, "resources/recorder")),
      "--output",
      linuxPath(directory),
      "--check",
   ]);
   linuxPython(project, "scripts/linux-source-inputs.py", ["--sources", linuxPath(directory)]);
   linuxPython(project, "scripts/collect-appimage-sources.py", ["--output", linuxPath(path.join(directory, "toolset")), "--check"]);
   const files = new Map<string, FileRecord>();
   const record = async (relative: string, expected?: string): Promise<void> => {
      const absolute = packetPath(directory, relative);
      if (!(await lstat(absolute)).isFile() || !(await realpath(absolute)).startsWith((await realpath(directory)) + path.sep))
         throw new Error(`Unsafe source evidence file: ${relative}`);
      const sha256 = await hashFile(absolute);
      if (expected && sha256 !== expected) throw new Error(`Source input changed: ${relative}`);
      const value = { path: relative, sha256, size: (await stat(absolute)).size };
      const previous = files.get(relative);
      if (previous && previous.sha256 !== sha256) throw new Error("Conflicting source file records");
      files.set(relative, value);
   };
   await record("manifest.json");
   await record("static-input-verification.json");
   const native = nativeSchema.parse(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")));
   if (native.blockers.length) throw new Error("Ubuntu source collection has blockers");
   for (const component of native.packages) {
      if (!component.binaryArchive) throw new Error("Official Ubuntu binary archive proof missing");
      await record(component.binaryArchive.path, component.binaryArchive.sha256);
      for (const file of component.sourceArchives) await record(file.path, file.sha256);
      if (component.copyright) await record(component.copyright.path, component.copyright.sha256);
   }
   for (const file of native.commonLicenses) await record(file.path, file.sha256);
   // Preserve the exact public build/publication records, including historical package inputs.
   for (const file of await inventory(path.join(directory, "history"), "history")) await record(file.path, file.sha256);
   const review = JSON.parse(await readFile(path.join(directory, "static-input-verification.json"), "utf8")) as {
      staticInputs: { path: string; sha256: string }[];
   };
   let staticCount = 0;
   for (const item of review.staticInputs) {
      await record(item.path, item.sha256);
      const component = staticSchema.parse(JSON.parse(await readFile(packetPath(directory, item.path), "utf8")));
      if (component.blockers.length) throw new Error("Static source collection has blockers");
      await record(component.buildinfo.path, component.buildinfo.sha256);
      staticCount += component.packages.length;
      for (const dependency of component.packages) for (const file of dependency.sourceArchives) await record(file.path, file.sha256);
   }
   const electron = electronSchema.parse(JSON.parse(await readFile(path.join(directory, "electron-component.json"), "utf8")));
   await record("electron-component.json");
   for (const file of [...electron.sourceArchives, ...electron.licenseFiles, ...electron.buildInstructions]) await record(file.path, file.sha256);
   const correspondence = JSON.parse(await readFile(path.join(directory, "evidence/electron-ffmpeg-linux/correspondence.json"), "utf8")) as {
      platform: string;
      arch: string;
      ffmpegDll: { sha256: string };
   };
   if (
      correspondence.platform !== "linux" ||
      correspondence.arch !== "x64" ||
      (await hashFile(path.join(stage, "node_modules/electron/dist/libffmpeg.so"))) !== correspondence.ffmpegDll.sha256
   )
      throw new Error("Linux Electron source evidence does not match staged module");
   const buildDirectory = path.join(project, "work/controlled-media/linux-x64");
   const controlled = await readControlledLinuxBuild(buildDirectory);
   for (const name of ["ffmpeg", "ffprobe"] as const)
      if ((await hashFile(path.join(stage, "resources/media", name))) !== controlled.binaries[name].sha256)
         throw new Error("Staged media differs from checked Linux build");
   for (const file of controlled.sourceArchives) {
      const source = packetPath(path.join(project, "work/release-sources"), file.path);
      const relative = `controlled-cli/sources/${file.path}`;
      const destination = packetPath(directory, relative);
      if ((await hashFile(source)) !== file.sha256) throw new Error("Controlled CLI source changed");
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await record(relative, file.sha256);
   }
   for (const file of [
      ...controlled.evidenceFiles,
      { path: "build-manifest.json", sha256: await hashFile(path.join(buildDirectory, "build-manifest.json")) },
   ]) {
      const relative = `controlled-cli/build/${file.path}`;
      const destination = packetPath(directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(packetPath(buildDirectory, file.path), destination);
      await record(relative, file.sha256);
   }
   // Runtime notices are a separate inventory. Keep complete texts in the source asset too.
   const notices = path.join(project, "work/linux-release-notices");
   for (const file of await inventory(notices)) {
      const relative = `runtime-notices/${file.path}`;
      const destination = packetPath(directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(packetPath(notices, file.path), destination);
      await record(relative, file.sha256);
   }
   if (!files.has("runtime-notices/manifest.json")) throw new Error("Generate full Linux dependency notices before collecting its source packet");
   const nativeRecord = "evidence/native-provenance.json";
   await mkdir(path.join(directory, "evidence"), { recursive: true });
   await copyFile(path.join(stage, "resources/recorder/provenance.json"), packetPath(directory, nativeRecord));
   await record(nativeRecord);
   const toolset = toolsetSchema.parse(JSON.parse(await readFile(path.join(directory, "toolset/manifest.json"), "utf8")));
   if (toolset.blockers.length) throw new Error("AppImage launcher/library source evidence is incomplete");
   await record("toolset/manifest.json");
   for (const file of [
      toolset.toolset,
      toolset.runtime,
      ...toolset.sources,
      ...toolset.licenseFiles,
      ...toolset.buildInstructions,
      ...toolset.packages.flatMap((component) => [component.binaryArchive, component.copyright, ...component.sourceArchives]),
   ])
      await record(`toolset/${file.path}`, file.sha256);
   for (const file of await inventory(path.join(directory, "toolset/history"), "toolset/history")) await record(file.path, file.sha256);
   return {
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
      nativeCount: native.packages.length,
      staticCount,
      appimage: { runtime: toolset.runtime, libraries: toolset.packages.map((component) => component.file) },
   };
}

export async function stageLinuxSourceNotices(project: string, stage: string): Promise<number> {
   const root = path.join(project, "work/linux-release-notices");
   const manifest = z.object({ licenses: z.array(fileSchema).min(1) }).parse(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")));
   const unique = [...new Map(manifest.licenses.map((file) => [file.path, file])).values()];
   await verifyPacketFiles(root, unique);
   const destination = path.join(stage, "resources/notices/ubuntu");
   for (const file of [
      ...unique,
      { path: "manifest.json", sha256: await hashFile(path.join(root, "manifest.json")), size: (await stat(path.join(root, "manifest.json"))).size },
   ]) {
      const target = packetPath(destination, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(packetPath(root, file.path), target);
   }
   const toolsetRoot = path.join(project, "work/linux-release-sources/toolset");
   const toolset = toolsetSchema.parse(JSON.parse(await readFile(path.join(toolsetRoot, "manifest.json"), "utf8")));
   const packagerNotices = [...new Map(toolset.licenseFiles.map((file) => [file.path, file])).values()];
   await verifyPacketFiles(toolsetRoot, packagerNotices);
   const targetRoot = path.join(stage, "resources/notices/appimage");
   for (const file of packagerNotices) {
      const target = packetPath(targetRoot, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(packetPath(toolsetRoot, file.path), target);
   }
   await writeFile(path.join(targetRoot, "manifest.json"), `${JSON.stringify({ licenses: toolset.licenseFiles }, null, 2)}\n`);
   return unique.length + packagerNotices.length;
}

export async function assembleLinuxSourceKit(project: string, stage: string, directory: string): Promise<LinuxSourceKit> {
   if (execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8", windowsHide: true }).trim())
      throw new Error("Commit the final source before assembling its Linux packet");
   const appCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8", windowsHide: true }).trim();
   const { files, nativeCount, staticCount, appimage } = await collectLinuxSourceFiles(project, stage, directory);
   const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: project, encoding: "utf8", windowsHide: true }).split("\0").filter(Boolean);
   for (const relative of tracked.filter(
      (file) => file.startsWith("src/") || ["package.json", "bun.lock", "electron.vite.config.ts", "tsconfig.json"].includes(file)
   )) {
      const committed = execFileSync("git", ["show", `${appCommit}:${relative}`], { cwd: project, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (!committed.equals(await readFile(packetPath(stage, relative)))) throw new Error(`Linux application staging came from different source: ${relative}`);
   }
   const provenance = JSON.parse(await readFile(path.join(stage, "resources/recorder/provenance.json"), "utf8")) as { sourceHashes: Record<string, string> };
   if (!provenance.sourceHashes || !Object.keys(provenance.sourceHashes).length) throw new Error("Native helper source fingerprint missing");
   for (const [relative, expected] of Object.entries(provenance.sourceHashes)) {
      const committed = execFileSync("git", ["show", `${appCommit}:${relative}`], { cwd: project, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      if (createHash("sha256").update(committed).digest("hex") !== expected) throw new Error(`Staged native helper came from different source: ${relative}`);
   }
   const archiveRelative = `application/attaclip-${appCommit}.tar`;
   const archive = packetPath(directory, archiveRelative);
   await mkdir(path.dirname(archive), { recursive: true });
   execFileSync("git", ["archive", "--format=tar", "--prefix=attaclip/", "--output", archive, appCommit], { cwd: project, windowsHide: true });
   const applicationSource = { path: archiveRelative, sha256: await hashFile(archive), size: (await stat(archive)).size };
   const staged = [
      ...(await inventory(path.join(stage, "resources"), "resources")),
      ...(await inventory(path.join(stage, "node_modules/electron/dist"), "electron")),
      ...(await inventory(path.join(stage, "out"), "out")),
   ];
   const nativeElfPaths: string[] = [];
   for (const file of staged.filter((file) => file.path.startsWith("resources/recorder/"))) {
      const handle = await open(packetPath(stage, file.path), "r");
      try {
         const bytes = Buffer.alloc(4);
         await handle.read(bytes, 0, 4, 0);
         if (bytes.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) nativeElfPaths.push(file.path);
      } finally {
         await handle.close();
      }
   }
   const kit: LinuxSourceKit = {
      version: 1,
      platform: "linux-x64",
      appCommit,
      staged,
      files: [...files, applicationSource],
      applicationSource,
      sourcePackageCounts: { native: nativeCount, static: staticCount },
      nativeElfPaths,
      appimage,
   };
   await writeFile(path.join(directory, "linux-kit.json"), `${JSON.stringify(kit, null, 2)}\n`);
   return kit;
}

export async function validateLinuxSourceKit(project: string, directory: string): Promise<LinuxSourceKit> {
   const kit = kitSchema.parse(JSON.parse(await readFile(path.join(directory, "linux-kit.json"), "utf8")));
   await verifyPacketFiles(directory, kit.files);
   const files = new Map(kit.files.map((file) => [file.path, file]));
   if (new Set(kit.staged.map((file) => file.path)).size !== kit.staged.length || new Set(kit.nativeElfPaths).size !== kit.nativeElfPaths.length)
      throw new Error("Duplicate staging or ELF inventory paths");
   for (const file of kit.staged) packetPath(directory, file.path);
   for (const file of kit.nativeElfPaths) {
      if (!file.startsWith("resources/recorder/") || !kit.staged.some((record) => record.path === file))
         throw new Error("Native ELF inventory names an unstaged file");
   }
   const requireFile = (file: { path: string; sha256: string; size?: number }): void => {
      const recorded = files.get(file.path);
      if (!recorded || recorded.sha256 !== file.sha256 || (file.size !== undefined && recorded.size !== file.size))
         throw new Error(`Source packet omits required evidence: ${file.path}`);
   };
   requireFile(kit.applicationSource);
   const toolset = toolsetSchema.parse(JSON.parse(await readFile(path.join(directory, "toolset/manifest.json"), "utf8")));
   if (toolset.blockers.length) throw new Error("AppImage toolset source has unresolved components");
   for (const file of [
      toolset.toolset,
      toolset.runtime,
      ...toolset.sources,
      ...toolset.licenseFiles,
      ...toolset.buildInstructions,
      ...toolset.packages.flatMap((component) => [component.binaryArchive, component.copyright, ...component.sourceArchives]),
   ])
      requireFile({ ...file, path: `toolset/${file.path}` });
   if (JSON.stringify(kit.appimage) !== JSON.stringify({ runtime: toolset.runtime, libraries: toolset.packages.map((component) => component.file) }))
      throw new Error("AppImage packaging inventory differs from its checked exact source toolset");
   for (const notice of toolset.licenseFiles) {
      const staged = kit.staged.find((file) => file.path === `resources/notices/appimage/${notice.path}`);
      if (!staged || staged.sha256 !== notice.sha256 || staged.size !== notice.size)
         throw new Error("Packaged launcher or injected library is missing its full notice");
   }
   for (const name of [
      "manifest.json",
      "static-input-verification.json",
      "electron-component.json",
      "controlled-cli/build/build-manifest.json",
      "runtime-notices/manifest.json",
   ])
      if (!files.has(name)) throw new Error(`Source packet lacks component manifest: ${name}`);
   const native = nativeSchema.parse(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")));
   const nativeProvenanceRecord = files.get("evidence/native-provenance.json");
   const stagedNativeProvenance = kit.staged.find((file) => file.path === "resources/recorder/provenance.json");
   if (!nativeProvenanceRecord || nativeProvenanceRecord.sha256 !== stagedNativeProvenance?.sha256)
      throw new Error("Native source fingerprint differs from the staged build record");
   const provenance = z
      .object({ sourceHashes: z.record(z.string(), z.string().regex(/^[a-f\d]{64}$/)), recorder: z.object({ sha256: z.string(), size: z.number() }) })
      .parse(JSON.parse(await readFile(packetPath(directory, "evidence/native-provenance.json"), "utf8")));
   const helper = kit.staged.find((file) => file.path === "resources/recorder/attaclip-recorder");
   if (!helper || helper.sha256 !== provenance.recorder.sha256 || helper.size !== provenance.recorder.size)
      throw new Error("Native helper differs from the compiled source fingerprint record");
   for (const required of ["native/recorder.cpp", "native/CMakeLists.txt", "scripts/build-native-linux.ts"])
      if (!provenance.sourceHashes[required]) throw new Error(`Native helper source fingerprint omits ${required}`);
   for (const [relative, expected] of Object.entries(provenance.sourceHashes)) {
      packetPath(directory, relative);
      const bytes = execFileSync("tar", ["-xOf", packetPath(directory, kit.applicationSource.path), `attaclip/${relative}`], {
         maxBuffer: 32 * 1024 * 1024,
         windowsHide: true,
      });
      if (createHash("sha256").update(bytes).digest("hex") !== expected)
         throw new Error(`Archived application source differs from the compiled native helper: ${relative}`);
   }
   for (const component of native.packages) {
      if (!component.binaryArchive || !component.copyright) throw new Error("Official native dependency evidence is incomplete");
      requireFile(component.binaryArchive);
      requireFile(component.copyright);
      component.sourceArchives.forEach(requireFile);
   }
   native.commonLicenses.forEach(requireFile);
   const review = z
      .object({ staticInputs: z.array(fileSchema.omit({ size: true })).min(1) })
      .parse(JSON.parse(await readFile(path.join(directory, "static-input-verification.json"), "utf8")));
   let staticCount = 0;
   for (const item of review.staticInputs) {
      requireFile(item);
      const source = staticSchema.parse(JSON.parse(await readFile(packetPath(directory, item.path), "utf8")));
      requireFile(source.buildinfo);
      source.packages.forEach((component) => component.sourceArchives.forEach(requireFile));
      staticCount += source.packages.length;
   }
   if (native.packages.length !== kit.sourcePackageCounts.native || staticCount !== kit.sourcePackageCounts.static)
      throw new Error("Source packet component counts differ from actual evidence");
   const electron = electronSchema.parse(JSON.parse(await readFile(path.join(directory, "electron-component.json"), "utf8")));
   [...electron.sourceArchives, ...electron.licenseFiles, ...electron.buildInstructions].forEach(requireFile);
   const correspondence = z
      .object({ platform: z.literal("linux"), arch: z.literal("x64"), ffmpegDll: fileSchema.omit({ path: true }) })
      .parse(JSON.parse(await readFile(path.join(directory, "evidence/electron-ffmpeg-linux/correspondence.json"), "utf8")));
   const module = kit.staged.find((file) => file.path === "electron/libffmpeg.so");
   if (!module || module.sha256 !== correspondence.ffmpegDll.sha256 || module.size !== correspondence.ffmpegDll.size)
      throw new Error("Source packet does not cover the staged Electron FFmpeg module");
   const build = JSON.parse(await readFile(path.join(directory, "controlled-cli/build/build-manifest.json"), "utf8")) as Awaited<
      ReturnType<typeof readControlledLinuxBuild>
   >;
   if (build.producer !== "attaclip-controlled-linux" || build.target !== "linux-x64") throw new Error("Source packet CLI build identity is wrong");
   for (const file of build.sourceArchives) requireFile({ ...file, path: `controlled-cli/sources/${file.path}` });
   for (const file of build.evidenceFiles) requireFile({ ...file, path: `controlled-cli/build/${file.path}` });
   for (const name of ["ffmpeg", "ffprobe"] as const) {
      const binary = kit.staged.find((file) => file.path === `resources/media/${name}`);
      if (!binary || binary.sha256 !== build.binaries[name].sha256 || binary.size !== build.binaries[name].size)
         throw new Error("Source packet does not cover staged controlled CLI bytes");
   }
   const notices = z
      .object({ licenses: z.array(fileSchema).min(1) })
      .parse(JSON.parse(await readFile(path.join(directory, "runtime-notices/manifest.json"), "utf8")));
   for (const file of notices.licenses) {
      requireFile({ ...file, path: `runtime-notices/${file.path}` });
      const runtime = kit.staged.find((record) => record.path === `resources/notices/ubuntu/${file.path}`);
      if (!runtime || runtime.sha256 !== file.sha256 || runtime.size !== file.size) throw new Error("Staged runtime omits full Linux dependency notice");
   }
   linuxPython(project, "scripts/collect-linux-sources.py", [
      "--output",
      linuxPath(directory),
      "--inventory",
      linuxPath(path.join(directory, "linux-kit.json")),
      "--check",
   ]);
   linuxPython(project, "scripts/linux-source-inputs.py", ["--sources", linuxPath(directory), "--no-write"]);
   linuxPython(project, "scripts/collect-appimage-sources.py", ["--output", linuxPath(path.join(directory, "toolset")), "--check"]);
   return kit;
}

if (import.meta.main) {
   const project = process.cwd();
   const stage = path.resolve(process.argv[2] ?? ".cache/linux-app");
   const directoryOption = process.argv.indexOf("--directory");
   const directory = path.resolve(directoryOption < 0 ? "work/linux-release-sources" : (process.argv[directoryOption + 1] ?? "work/linux-release-sources"));
   if (process.argv.includes("--stage-notices")) {
      console.log(JSON.stringify({ noticeTexts: await stageLinuxSourceNotices(project, stage) }));
      process.exit(0);
   }
   const result = process.argv.includes("--check")
      ? await validateLinuxSourceKit(project, directory)
      : process.argv.includes("--inputs-only")
        ? await collectLinuxSourceFiles(project, stage, directory)
        : await assembleLinuxSourceKit(project, stage, directory);
   if (process.argv.includes("--inputs-only")) await writeFile(path.join(directory, "linux-inputs.json"), `${JSON.stringify(result, null, 2)}\n`);
   console.log(
      JSON.stringify(
         "nativeCount" in result
            ? { files: result.files.length, native: result.nativeCount, static: result.staticCount }
            : { files: result.files.length, appCommit: result.appCommit }
      )
   );
}
