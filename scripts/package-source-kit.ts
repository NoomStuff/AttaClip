import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { hashFile, validateKit, type SourceKit } from "./release-sources";

type FileRecord = NonNullable<SourceKit["evidence"]>["components"][number]["sourceArchives"][number];

export function selectSourceKitFiles(kit: SourceKit): { kit: SourceKit; files: FileRecord[] } {
   if (!kit.evidence) throw new Error("Assemble source evidence before packaging it.");
   const references = kit.evidence.components.flatMap((component) => [...component.sourceArchives, ...component.licenseFiles, ...component.buildInstructions]);
   const wanted = new Set(references.map((file) => file.path));
   const dependencySources = (kit.dependencySources ?? []).filter((source) => wanted.has(source.path));
   const files = new Map<string, FileRecord>();
   for (const file of [
      ...references,
      ...kit.sources.flatMap((source) => [source, ...source.licenses]),
      ...dependencySources.flatMap((source) => [source, ...source.licenses]),
   ]) {
      const previous = files.get(file.path);
      if (previous && (previous.sha256 !== file.sha256 || previous.size !== file.size)) throw new Error(`Conflicting source-kit file records: ${file.path}`);
      files.set(file.path, { path: file.path, sha256: file.sha256, size: file.size });
   }
   return {
      kit: { ...kit, dependencySources, dependencyFailures: [] },
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
   };
}

export async function packageSourceKit(project: string): Promise<string> {
   const directory = path.join(project, "work/release-sources");
   const original = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as SourceKit;
   const blockers = await validateKit(original, directory, project);
   if (blockers.length || !original.publicInstallerReady) throw new Error(`Source kit is not ready:\n${blockers.join("\n")}`);
   const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8", windowsHide: true }).trim();
   const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8", windowsHide: true }).trim();
   if (dirty || currentCommit !== original.appCommit) throw new Error("Source kit does not cover the clean current release commit.");
   const { kit, files } = selectSourceKitFiles(original);
   const folder = await mkdtemp(path.join(project, "work/source-kit-"));
   const sourceRoot = await realpath(directory);
   for (const file of files) {
      const source = path.resolve(directory, file.path);
      const target = path.resolve(folder, file.path);
      if (!source.startsWith(`${path.resolve(directory)}${path.sep}`) || !target.startsWith(`${folder}${path.sep}`))
         throw new Error("Source-kit file path escapes its directory.");
      const attributes = await lstat(source);
      if (!attributes.isFile() || !(await realpath(source)).startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`Unsafe source-kit file: ${file.path}`);
      if (attributes.size !== file.size || (await hashFile(source)) !== file.sha256) throw new Error(`Source-kit file changed: ${file.path}`);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      if ((await hashFile(target)) !== file.sha256) throw new Error(`Source-kit copy changed: ${file.path}`);
   }
   await writeFile(path.join(folder, "manifest.json"), `${JSON.stringify(kit, null, 2)}\n`);
   await writeFile(path.join(folder, "dependency-evidence.json"), `${JSON.stringify(kit.evidence, null, 2)}\n`);
   const appFolder = `attaclip-${kit.appCommit}`;
   await writeFile(
      path.join(folder, "README.txt"),
      `AttaClip Windows source kit\nApplication commit: ${kit.appCommit}\n\nmanifest.json identifies the exact staged binary hashes. dependency-evidence.json links each bundled component to its source archives, license texts and build instructions. The controlled-media evidence includes the cross-build recipe, configuration and compiler records. OBS source and the pinned obs-deps archive include dependency build recipes and patches.\n\nExtracting the application and preparing captured media inputs, in Ubuntu or Git Bash:\n\ntar -xf evidence/${appFolder}.tar.gz\nmkdir -p ${appFolder}/work/release-sources\ncp manifest.json *.tar.gz ${appFolder}/work/release-sources/\ncp -R dependencies licenses evidence ${appFolder}/work/release-sources/\ncd ${appFolder}\n\nFollow README.md for Bun, Visual Studio, CMake and Ubuntu MinGW prerequisites. Run bun install --frozen-lockfile. In Ubuntu, run bash scripts/build-media-windows.sh using the copied archives. On Windows, run bun scripts/controlled-media.ts, then provision-media.ts and bundle:media with the printed binary paths. Build the native helper and app as described in README.md. Native provisioning downloads hash-pinned official OBS resources. The archived OBS and obs-deps trees retain their source, presets, dependency scripts and patches for rebuilding that runtime.\n\nThis kit covers the staged Windows binaries only. It does not clear Linux or macOS binaries.\n`
   );
   const packagedBlockers = await validateKit(kit, folder, project);
   if (packagedBlockers.length) throw new Error(`Pruned source kit is incomplete:\n${packagedBlockers.join("\n")}`);
   const version = (JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as { version: string }).version;
   if (!/^[\w.-]+$/.test(version)) throw new Error("Invalid release version.");
   const archive = path.join(project, "work", `AttaClip-${version}-windows-x64-sources-${kit.appCommit.slice(0, 8)}.zip`);
   execFileSync("tar", ["-a", "-cf", archive, "-C", folder, "."], { windowsHide: true, timeout: 180000 });
   const record = {
      path: path.basename(archive),
      sha256: await hashFile(archive),
      size: (await stat(archive)).size,
      appCommit: kit.appCommit,
      staged: kit.staged,
   };
   await writeFile(`${archive}.json`, `${JSON.stringify(record, null, 2)}\n`);
   console.log(`Source release asset: ${archive}\nSHA-256: ${record.sha256}\n${record.size} bytes, ${files.length} referenced files.`);
   return archive;
}

if (import.meta.main) await packageSourceKit(process.cwd());
