import { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, writeFile, copyFile, stat, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { collectKit, collectDependency, hashFile, releaseInventory, type SourceKit } from "./release-sources";
import type { ControlledMediaBuild } from "./controlled-media";
import { collectElectronFfmpeg } from "./electron-source-evidence";

type Evidence = NonNullable<SourceKit["evidence"]>;
type FileRecord = Evidence["components"][number]["sourceArchives"][number];
type Source = SourceKit["sources"][number];
type Dependency = NonNullable<SourceKit["dependencySources"]>[number];

export async function copyNativeLicenses(project: string, directory: string, licenses: FileRecord[]): Promise<void> {
   const nativeNotices = path.join(project, "resources/notices/native");
   for (const license of licenses) {
      const source = path.resolve(directory, license.path);
      const target = path.resolve(nativeNotices, license.path);
      if (!source.startsWith(`${path.resolve(directory)}${path.sep}`) || !target.startsWith(`${path.resolve(nativeNotices)}${path.sep}`))
         throw new Error("Native license path escapes its source or notices folder.");
      if ((await hashFile(source)) !== license.sha256) throw new Error(`Native license changed: ${license.path}`);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
   }
}

interface ObsRuntimeProbe {
   file: string;
   sha256: string;
   configuration: string;
   version: number;
   libraries: { file: string; sha256: string; version?: string; commitPrefix?: string }[];
}

export function checkRuntimeVersions(
   probe: ObsRuntimeProbe,
   staged: { path: string; sha256: string }[],
   inputs: { file: string; version: string; commit: string }[]
): void {
   for (const library of probe.libraries) {
      if (library.sha256 !== staged.find((file) => file.path === `recorder/${library.file}`)?.sha256)
         throw new Error(`Runtime probe loaded a different library: ${library.file}`);
   }
   for (const input of inputs) {
      const library = probe.libraries.find((library) => library.file === input.file);
      if (!library?.version) throw new Error(`Runtime version probe is missing: ${input.file}`);
      const version = library.version.replace(/^[vn](?=\d)/, "");
      const declaredVersion = input.file === "libcurl.dll" ? /^libcurl\/(\S+)/.exec(version)?.[1]?.split("-")[0] : version.split("-")[0];
      if (declaredVersion !== input.version) throw new Error(`Runtime version differs from the source recipe: ${input.file}`);
      const embeddedCommit = library.commitPrefix ?? /-g([a-f\d]{7,40})\b/.exec(version)?.[1];
      if (embeddedCommit && !input.commit.startsWith(embeddedCommit)) throw new Error(`Runtime source commit differs: ${input.file}`);
   }
}

const obsLibraryRecipes: Record<string, string> = {
   libaom: "40-aom.ps1",
   libsvtav1: "30-svt-av1.ps1",
   libtheora: "50-libtheora.ps1",
   libmp3lame: "60-lame.ps1",
   libx264: "40-x264.ps1",
   libopus: "20-opus.ps1",
   libvorbis: "30-libvorbis.ps1",
   libvpx: "30-libvpx.ps1",
   librist: "70-librist.ps1",
   libsrt: "60-srt.ps1",
   zlib: "10-zlib.ps1",
};

export async function collectObsStaticInputs(kit: SourceKit, directory: string): Promise<void> {
   kit.dependencySources ??= [];
   for (const recipe of ["30-jansson.ps1", "60-simde.ps1", "60-uthash.ps1", "40-detours.ps1"]) {
      const ref = kit.dependencyRecipeRefs?.find((ref) => ref.recipe.startsWith("obs-deps-") && ref.recipe.endsWith(`/${recipe}`));
      if (!ref) throw new Error(`OBS static dependency recipe is missing: ${recipe}`);
      if (kit.dependencySources.some((source) => source.recipe === ref.recipe)) continue;
      let revision = ref.revision;
      if (recipe === "40-detours.ps1") {
         const recipes = kit.sources.find((source) => source.repository === "obsproject/obs-deps");
         if (!recipes) throw new Error("OBS recipes source archive is missing.");
         const text = execFileSync("tar", ["-xOf", path.join(directory, recipes.path), ref.recipe], { encoding: "utf8", windowsHide: true });
         const x86 = /x86\s*=\s*'([a-f\d]{40})'/i.exec(text)?.[1];
         const x64 = /x64\s*=\s*'([a-f\d]{40})'/i.exec(text)?.[1];
         if (!x64 || x86 !== x64) throw new Error("OBS graphics hooks need separately captured Detours architecture inputs.");
         revision = x64;
      }
      const source = await collectDependency({ ...ref, revision }, kit, directory);
      if (!source.licenses.length) throw new Error(`OBS static dependency license is missing: ${recipe}`);
      kit.dependencySources.push(source);
      console.log(`Captured statically linked OBS source: ${recipe}`);
   }
   await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(kit, null, 2)}\n`);
}

export async function assembleSourceEvidence(project: string): Promise<SourceKit> {
   const directory = path.join(project, "work", "release-sources");
   const kit = await collectKit(project, directory, true);
   if (kit.appDirty) throw new Error("Commit the release source before assembling installer evidence.");
   await collectObsStaticInputs(kit, directory);
   const electronFfmpeg = await collectElectronFfmpeg(project, directory);
   const media = JSON.parse(await readFile(path.join(project, "resources", "media", "provenance.json"), "utf8")) as { controlledBuild?: ControlledMediaBuild };
   const controlled = media.controlledBuild;
   if (!controlled) throw new Error("Automatic evidence assembly supports the captured controlled FFmpeg build only.");
   const folder = path.join(directory, "evidence");
   await mkdir(folder, { recursive: true });
   const fileRecord = async (file: string): Promise<FileRecord> => ({
      path: path.relative(directory, file).replaceAll("\\", "/"),
      sha256: await hashFile(file),
      size: (await stat(file)).size,
   });
   const copyEvidence = async (source: string, name: string): Promise<FileRecord> => {
      const target = path.join(folder, name);
      await copyFile(source, target);
      return fileRecord(target);
   };
   const source = (repository: string): Source => {
      const value = kit.sources.find((candidate) => candidate.repository === repository);
      if (!value) throw new Error(`Missing pinned source: ${repository}`);
      return value;
   };
   const dependency = (recipe: string): Dependency => {
      const value = kit.dependencySources?.find((candidate) => candidate.recipe.startsWith("obs-deps-") && candidate.recipe.endsWith(`/${recipe}`));
      if (!value) throw new Error(`Missing OBS dependency source: ${recipe}`);
      return value;
   };
   const components: Evidence["components"] = [];
   components.push(electronFfmpeg);
   const add = (id: string, version: string, license: string, archives: FileRecord[], licenses: FileRecord[], instructions: FileRecord[]) => {
      if (!licenses.length) throw new Error(`Component has no retained license: ${id}`);
      components.push({ id, version, license, sourceArchives: archives, licenseFiles: licenses, buildInstructions: instructions });
   };
   const appSourcePath = path.join(folder, `attaclip-${kit.appCommit}.tar.gz`);
   execFileSync("git", ["archive", "--format=tar.gz", `--prefix=attaclip-${kit.appCommit}/`, `--output=${appSourcePath}`, kit.appCommit], {
      cwd: project,
      windowsHide: true,
   });
   const appSource = await fileRecord(appSourcePath);
   const appLicense = await copyEvidence(path.join(project, "LICENSE"), "LICENSE-AttaClip");
   const appBuild = await copyEvidence(path.join(project, "README.md"), "attaclip-build.md");
   add("attaclip-source", kit.appCommit, "GPL-3.0-or-later", [appSource], [appLicense], [appSource, appBuild]);
   const electronLicense = await copyEvidence(path.join(project, "node_modules/electron/dist/LICENSE"), "LICENSE-Electron");
   const chromiumNotices = await copyEvidence(path.join(project, "node_modules/electron/dist/LICENSES.chromium.html"), "LICENSES.chromium.html");
   const npmNotices = await copyEvidence(path.join(project, "resources/notices/javascript.txt"), "LICENSES-JavaScript.txt");
   const npmVersions = await copyEvidence(path.join(project, "resources/notices/javascript.json"), "javascript-packages.json");
   const electronVersion = (JSON.parse(await readFile(path.join(project, "node_modules/electron/package.json"), "utf8")) as { version: string }).version;
   add("electron-notices", electronVersion, "MIT", [], [electronLicense, chromiumNotices, npmNotices], [npmVersions]);

   const obs = source("obsproject/obs-studio");
   const recipes = source("obsproject/obs-deps");
   const nativeBuild = await copyEvidence(path.join(project, "resources/recorder/provenance.json"), "recorder-build-provenance.json");
   const obsConfigText = execFileSync(
      "powershell.exe",
      [
         "-NoProfile",
         "-ExecutionPolicy",
         "Bypass",
         "-File",
         path.join(project, "scripts/probe-obs-runtime.ps1"),
         "-RuntimeDirectory",
         path.join(project, "resources/recorder"),
      ],
      { windowsHide: true, encoding: "utf8" }
   );
   const obsConfig = JSON.parse(obsConfigText) as ObsRuntimeProbe;
   if (obsConfig.sha256 !== kit.staged.find((file) => file.path === `recorder/${obsConfig.file}`)?.sha256)
      throw new Error("OBS configuration probe loaded a different library.");
   checkRuntimeVersions(
      obsConfig,
      kit.staged,
      [
         ["libcurl.dll", "30-curl.ps1"],
         ["zlib.dll", "10-zlib.ps1"],
         ["srt.dll", "60-srt.ps1"],
         ["librist.dll", "70-librist.ps1"],
         ["libx264-164.dll", "40-x264.ps1"],
         ["avutil-60.dll", "99-ffmpeg.ps1"],
      ].map(([file, recipe]) => {
         const input = dependency(recipe!);
         const version = kit.dependencyRecipeRefs?.find((ref) => ref.recipe === input.recipe)?.version;
         if (!version) throw new Error(`Dependency version is absent from the pinned recipe: ${recipe}`);
         return { file: file!, version, commit: input.resolvedRevision };
      })
   );
   const configFile = path.join(folder, "obs-ffmpeg-configuration.json");
   await writeFile(configFile, `${JSON.stringify(obsConfig, null, 2)}\n`);
   const obsConfiguration = await fileRecord(configFile);
   const recipeName = kit.dependencyRecipeRefs?.find((ref) => ref.recipe.endsWith("/99-ffmpeg.ps1"))?.recipe;
   if (!recipeName) throw new Error("OBS FFmpeg build recipe is missing.");
   const recipeText = execFileSync("tar", ["-xOf", path.join(directory, recipes.path), recipeName], { encoding: "utf8", windowsHide: true });
   const enableFlags = [...new Set(obsConfig.configuration.match(/--enable-[\w-]+/g) ?? [])];
   for (const flag of enableFlags) if (!recipeText.includes(flag)) throw new Error(`OBS configuration differs from the pinned recipe: ${flag}`);
   const compiled: Dependency[] = [];
   for (const flag of enableFlags) {
      const name = flag.substring("--enable-".length);
      if (obsLibraryRecipes[name]) compiled.push(dependency(obsLibraryRecipes[name]));
      else if (!["w32threads", "version3", "gpl", "shared"].includes(name)) throw new Error(`Unmapped OBS library: ${name}`);
   }
   // These are the dependency edges of the selected recipes, not the full
   // Windows SDK or unrelated dependency bundle. Librist vendors its own crypto
   // and cJSON sources. SRT links MbedTLS built from the separate pinned source.
   for (const name of [
      "30-libogg.ps1",
      "60-mbedtls.ps1",
      "70-nv-codec.ps1",
      "80-amf.ps1",
      "30-curl.ps1",
      "30-jansson.ps1",
      "60-simde.ps1",
      "60-uthash.ps1",
      "40-detours.ps1",
   ])
      compiled.push(dependency(name));
   const framework = source("Mbed-TLS/mbedtls-framework");
   const response = await fetch("https://api.github.com/repos/Mbed-TLS/mbedtls/git/trees/c765c831e5c2a0971410692f92f7a81d6ec65ec2", {
      signal: AbortSignal.timeout(30_000),
   });
   if (!response.ok) throw new Error(`Cannot verify MbedTLS gitlink: HTTP ${response.status}`);
   const tree = (await response.json()) as { tree: { path: string; mode: string; sha: string }[] };
   if (tree.tree.find((entry) => entry.path === "framework" && entry.mode === "160000")?.sha !== framework.commit)
      throw new Error("MbedTLS framework source differs from its pinned gitlink.");
   const gitlinkPath = path.join(folder, "mbedtls-framework-gitlink.json");
   await writeFile(gitlinkPath, `${JSON.stringify(tree, null, 2)}\n`);
   const gitlink = await fileRecord(gitlinkPath);
   const nvHeaders = dependency("70-nv-codec.ps1");
   const nvArchive = path.join(directory, nvHeaders.path);
   const nvMembers = execFileSync("tar", ["-tf", nvArchive], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
   const embeddedNotices: FileRecord[] = [];
   for (const member of nvMembers.filter((member) => /\/include\/ffnvcodec\/.*\.h$/.test(member))) {
      const text = execFileSync("tar", ["-xOf", nvArchive, member], { windowsHide: true });
      const target = path.join(folder, `LICENSE-nv-codec-${path.posix.basename(member)}.txt`);
      await writeFile(target, text);
      embeddedNotices.push(await fileRecord(target));
   }
   if (!embeddedNotices.length) throw new Error("NVIDIA header license evidence is missing.");
   const obsMembers = execFileSync("tar", ["-tf", path.join(directory, obs.path)], { encoding: "utf8", windowsHide: true })
      .trim()
      .split(/\r?\n/);
   const seenComments = new Set<string>();
   for (const member of obsMembers.filter((member) => /\/(?:libobs\/util|deps\/glad)\/.*\.(?:c|h|cpp|hpp)$/.test(member))) {
      const text = execFileSync("tar", ["-xOf", path.join(directory, obs.path), member], { encoding: "utf8", windowsHide: true });
      for (const match of text.slice(0, 8192).matchAll(/\/\*[\s\S]*?\*\//g)) {
         if (!/copyright/i.test(match[0]) || !/permission/i.test(match[0])) continue;
         const digest = createHash("sha256").update(match[0]).digest("hex");
         if (seenComments.has(digest)) continue;
         seenComments.add(digest);
         const target = path.join(folder, `LICENSE-obs-embedded-${digest.slice(0, 16)}.txt`);
         await writeFile(target, `${member}\n\n${match[0]}\n`);
         embeddedNotices.push(await fileRecord(target));
      }
   }
   const ristArchive = path.join(directory, dependency("70-librist.ps1").path);
   const ristMembers = execFileSync("tar", ["-tf", ristArchive], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
   // Librist vendors these sources without standalone license files. Preserve
   // each complete header so its original copyright and license stay intact.
   for (const member of ristMembers.filter((member) => /\/contrib\/(?:contrib_cJSON\/cjson\/cJSON\.h|lz4\/[^/]+\.h)$/.test(member))) {
      const text = execFileSync("tar", ["-xOf", ristArchive, member], { windowsHide: true });
      const target = path.join(folder, `LICENSE-librist-vendored-${path.posix.basename(member)}.txt`);
      await writeFile(target, text);
      embeddedNotices.push(await fileRecord(target));
   }
   const obsArchives = [obs, recipes, framework, dependency("99-ffmpeg.ps1"), ...compiled];
   const obsLicenses = [
      ...obs.licenses,
      ...recipes.licenses,
      ...framework.licenses,
      ...dependency("99-ffmpeg.ps1").licenses,
      ...compiled.flatMap((input) => input.licenses),
      ...embeddedNotices,
   ];
   // Preserve source paths and full copyright notices in the actual installer.
   // Source-archive licenses are separate from the app's own GPL text.
   await copyNativeLicenses(project, directory, [...obsLicenses, ...electronFfmpeg.licenseFiles]);
   add("obs-dependency-build-config", "OBS 32.2.2 / deps 2026-07-15", "GPL-2.0-or-later", obsArchives, obsLicenses, [
      recipes,
      obsConfiguration,
      nativeBuild,
      gitlink,
   ]);
   add("obs-ffmpeg-core-and-enabled-dependencies", "8.1.2", "GPL-3.0-or-later", obsArchives, obsLicenses, [recipes, obsConfiguration, gitlink]);
   for (const [name, recipe, license] of [
      ["zlib.dll", "10-zlib.ps1", "Zlib"],
      ["libcurl.dll", "30-curl.ps1", "curl"],
      ["librist.dll", "70-librist.ps1", "BSD-2-Clause"],
      ["srt.dll", "60-srt.ps1", "MPL-2.0"],
      ["libx264-164.dll", "40-x264.ps1", "GPL-2.0-or-later"],
   ]) {
      const input = dependency(recipe!);
      const refs: FileRecord[] = [input, recipes];
      const licenses = [...input.licenses];
      if (name === "srt.dll") {
         refs.push(dependency("60-mbedtls.ps1"), framework);
         licenses.push(...dependency("60-mbedtls.ps1").licenses, ...framework.licenses);
      }
      add(
         `obs-runtime:${name}`,
         kit.dependencyRecipeRefs?.find((ref) => ref.recipe === input.recipe)?.version || input.resolvedRevision,
         license!,
         refs,
         licenses,
         [recipes, gitlink]
      );
   }
   const pthreadLicenses = obs.licenses.filter((file) => file.path.includes("deps/w32-pthreads/"));
   add("obs-runtime:w32-pthreads.dll", obs.commit, "LGPL-2.1-or-later", [obs], pthreadLicenses, [obs, nativeBuild]);
   const controlledEvidence = path.join(folder, "controlled-media");
   await cp(path.join(project, "resources/media/controlled-build"), controlledEvidence, { recursive: true });
   const recordedFiles = await Promise.all(controlled.evidenceFiles.map((file) => fileRecord(path.join(controlledEvidence, file.path))));
   const buildInstructions = recordedFiles.filter((file) => /build-media-windows\.sh|mingw-cross\.ini|config|toolchain|build\.log|sha256/.test(file.path));
   const licenses = recordedFiles.filter((file) => /COPYING|LICENSE/.test(file.path));
   await copyNativeLicenses(project, directory, licenses);
   add("ffmpeg-core-build-config", "8.1.3-attaclip-local", "GPL-2.0-or-later", controlled.sourceArchives, licenses, buildInstructions);
   add(
      "ffmpeg-external:libx264",
      controlled.sourceCommits.x264,
      "GPL-2.0-or-later",
      controlled.sourceArchives.filter((file) => file.path.includes("x264")),
      licenses.filter((file) => file.path.includes("x264")),
      buildInstructions
   );
   add(
      "ffmpeg-external:libdav1d",
      controlled.sourceCommits.dav1d,
      "BSD-2-Clause",
      controlled.sourceArchives.filter((file) => file.path.includes("dav1d")),
      licenses.filter((file) => file.path.includes("dav1d")),
      buildInstructions
   );
   add(
      "ffmpeg-external:zlib",
      controlled.sourceCommits.zlib,
      "Zlib",
      controlled.sourceArchives.filter((file) => file.path.includes("zlib")),
      licenses.filter((file) => file.path.includes("zlib")),
      buildInstructions
   );
   const current = await releaseInventory(project);
   const evidence: Evidence = { stagedDigest: createHash("sha256").update(JSON.stringify(current)).digest("hex"), components };
   await writeFile(path.join(directory, "dependency-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
   // Collect again so the manifest uses the evidence just generated and checks
   // every current binary, source archive and build file rather than old blockers.
   const refreshed = await collectKit(project, directory, true);
   console.log(`Assembled ${components.length} component records. ${refreshed.blockers.length} remaining blockers.`);
   return refreshed;
}

if (import.meta.main) await assembleSourceEvidence(process.cwd());
