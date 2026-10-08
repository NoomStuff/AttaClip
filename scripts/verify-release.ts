import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractFile, listPackage, statFile, uncache } from "@electron/asar";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap";
import { z } from "zod";
import { hashFile, inventory, validateKit, type SourceKit } from "./release-sources";
import { selectSourceKitFiles } from "./package-source-kit";

type FileRecord = SourceKit["staged"][number];

export function compareFiles(expected: FileRecord[], actual: FileRecord[], label: string): void {
   const wanted = new Map(expected.map((file) => [file.path, file]));
   const found = new Map(actual.map((file) => [file.path, file]));
   if (wanted.size !== expected.length || found.size !== actual.length) throw new Error(`${label}: duplicate file paths.`);
   for (const file of expected) {
      const other = found.get(file.path);
      if (!other || other.sha256 !== file.sha256 || other.size !== file.size) throw new Error(`${label}: missing or changed ${file.path}`);
   }
   for (const file of actual) if (!wanted.has(file.path)) throw new Error(`${label}: unexpected ${file.path}`);
}

export function archivePaths(listing: string): string[] {
   const separator = listing.indexOf("----------");
   if (separator < 0) throw new Error("Archive listing has no member section.");
   const section = listing.substring(separator);
   if (/^(?:Symbolic Link|Hard Link) = /m.test(section)) throw new Error("Release archives cannot contain links.");
   const paths = [...section.matchAll(/^Path = (.+)$/gm)].map((match) => match[1]!.replace(/\r$/, "").replaceAll("\\", "/"));
   if (!paths.length) throw new Error("Archive contains no files.");
   const names = new Set<string>();
   for (const member of paths) {
      if (member === "." || member === "./") continue;
      const relative = member.replace(/^\.\//, "");
      if (
         !relative ||
         relative.startsWith("/") ||
         /^[a-z]:/i.test(relative) ||
         relative.split("/").some((part) => part === ".." || part.includes(":") || /[. ]$/.test(part))
      )
         throw new Error(`Unsafe archive path: ${member}`);
      const key = relative.toLowerCase().replace(/\/$/, "");
      if (names.has(key)) throw new Error(`Duplicate archive path: ${member}`);
      names.add(key);
   }
   return paths;
}

export async function verifyAsar(project: string, archive: string): Promise<FileRecord[]> {
   uncache(archive);
   const expected = await inventory(path.join(project, "out"), "out");
   if (!expected.length) throw new Error("Build the application before verifying its package.");
   const actual: FileRecord[] = [];
   for (const name of listPackage(archive, { isPack: false })) {
      const relative = name.replace(/^[/\\]/, "").replaceAll("\\", "/");
      if (!relative.startsWith("out/")) continue;
      const entry = statFile(archive, path.normalize(relative), false);
      if ("link" in entry) throw new Error(`Linked app archive file: ${relative}`);
      if ("files" in entry) continue;
      const bytes = extractFile(archive, path.normalize(relative), false);
      actual.push({ path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
   }
   compareFiles(expected, actual, "Compiled application differs from app.asar");
   const packaged = JSON.parse(extractFile(archive, "package.json").toString("utf8")) as { name: string; version: string; main: string };
   const source = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as typeof packaged;
   if (packaged.name !== source.name || packaged.version !== source.version || packaged.main !== source.main)
      throw new Error("Packaged application identity differs from the release source.");
   return actual;
}

async function fileRecord(file: string, relative: string): Promise<FileRecord> {
   return { path: relative, sha256: await hashFile(file), size: (await stat(file)).size };
}

export async function verifyUpdaterAssets(release: string, installer: string, version: string, scratch: string): Promise<FileRecord[]> {
   const yaml = createRequire(import.meta.url)("js-yaml") as { load: (text: string, options: { schema: unknown }) => unknown; JSON_SCHEMA: unknown };
   const metadata = z
      .object({
         version: z.string(),
         path: z.string(),
         sha512: z.string(),
         files: z.array(z.object({ url: z.string(), sha512: z.string(), size: z.number().int().positive() })),
      })
      .parse(yaml.load(await readFile(path.join(release, "latest.yml"), "utf8"), { schema: yaml.JSON_SCHEMA }));
   const name = path.basename(installer);
   const bytes = await readFile(installer);
   const sha512 = createHash("sha512").update(bytes).digest("base64");
   if (
      metadata.version !== version ||
      metadata.path !== name ||
      metadata.sha512 !== sha512 ||
      metadata.files.length !== 1 ||
      metadata.files[0]!.url !== name ||
      metadata.files[0]!.sha512 !== sha512 ||
      metadata.files[0]!.size !== bytes.length
   )
      throw new Error("latest.yml does not identify the verified installer.");
   // A blockmap for a previous installer can break differential updates even
   // when latest.yml is correct. Regenerate it without changing the installer.
   const regenerated = path.join(scratch, "regenerated.blockmap");
   await buildBlockMap(installer, "gzip", regenerated);
   const blockmap = `${installer}.blockmap`;
   if (!gunzipSync(await readFile(regenerated)).equals(gunzipSync(await readFile(blockmap))))
      throw new Error("Installer blockmap differs from the verified installer.");
   return [await fileRecord(path.join(release, "latest.yml"), "latest.yml"), await fileRecord(blockmap, path.basename(blockmap))];
}

export async function verifyPackagedResources(project: string, unpacked: string, kit: SourceKit): Promise<void> {
   const resources = path.join(unpacked, "resources");
   for (const group of ["recorder", "media", "notices"]) {
      compareFiles(
         kit.staged.filter((file) => file.path.startsWith(`${group}/`)),
         await inventory(path.join(resources, group), group),
         `Packaged ${group}`
      );
   }
   const ffmpeg = kit.staged.find((file) => file.path === "electron/ffmpeg.dll");
   if (!ffmpeg) throw new Error("Source kit does not cover Electron's FFmpeg DLL.");
   compareFiles([ffmpeg], [await fileRecord(path.join(unpacked, "ffmpeg.dll"), ffmpeg.path)], "Packaged Electron FFmpeg");
   for (const [source, target] of [
      ["LICENSE", "LICENSE"],
      ["LICENSE-AttaCut", "LICENSE-AttaCut"],
      ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
      ["build/icon.png", "icons/icon.png"],
   ]) {
      compareFiles(
         [await fileRecord(path.join(project, source!), target!)],
         [await fileRecord(path.join(resources, target!), target!)],
         "Packaged license or icon"
      );
   }
   // electron-builder renames the Electron license and changes the executable's
   // product resources. All other official runtime files must remain identical.
   const electron = await inventory(path.join(project, "node_modules/electron/dist"));
   if (!electron.length) throw new Error("Installed Electron runtime is missing.");
   for (const file of electron) {
      if (["electron.exe", "version", "resources/default_app.asar"].includes(file.path)) continue;
      const target = file.path === "LICENSE" ? "LICENSE.electron.txt" : file.path;
      compareFiles([{ ...file, path: target }], [await fileRecord(path.join(unpacked, target), target)], "Packaged Electron runtime");
   }
}

async function findExtractor(project: string): Promise<string> {
   const explicit = process.env["ATTACLIP_7ZIP"];
   if (explicit) return path.resolve(explicit);
   const cache = path.join(process.env["LOCALAPPDATA"] || project, "electron-builder/Cache");
   if (existsSync(cache)) {
      const files = await readdir(cache, { recursive: true });
      const candidates = files.filter((file) => file.endsWith("7za.exe") && file.includes("7zip") && file.includes("win-x64"));
      if (candidates[0]) return path.join(cache, candidates[0]);
   }
   throw new Error("Set ATTACLIP_7ZIP to 7za.exe from electron-builder's cache before verifying installer payloads.");
}

async function extractChecked(extractor: string, archive: string, destination: string): Promise<void> {
   const before = await hashFile(archive);
   archivePaths(execFileSync(extractor, ["l", "-slt", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 }));
   execFileSync(extractor, ["x", "-y", `-o${destination}`, archive], { windowsHide: true, stdio: "pipe", timeout: 180000 });
   if ((await hashFile(archive)) !== before) throw new Error("Archive changed during verification.");
   await inventory(destination); // Reject extracted symlinks before hashing them.
}

export async function verifyRelease(project: string, sourceArchive: string): Promise<string> {
   if (process.platform !== "win32") throw new Error("This verifier covers Windows x64 releases only.");
   const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8", windowsHide: true }).trim();
   const appCommit = git("rev-parse", "HEAD");
   if (git("status", "--porcelain")) throw new Error("Commit the release source before verifying installers.");
   const kitDirectory = path.join(project, "work/release-sources");
   const kit = JSON.parse(await readFile(path.join(kitDirectory, "manifest.json"), "utf8")) as SourceKit;
   if (kit.appCommit !== appCommit || kit.appDirty || !kit.publicInstallerReady) throw new Error("Source kit does not cover the clean release commit.");
   const blockers = await validateKit(kit, kitDirectory, project);
   if (blockers.length) throw new Error(`Source kit is incomplete:\n${blockers.join("\n")}`);
   const source = path.resolve(sourceArchive);
   const companion = JSON.parse(await readFile(`${source}.json`, "utf8")) as FileRecord & { appCommit: string; staged: FileRecord[] };
   if (
      companion.appCommit !== appCommit ||
      companion.path !== path.basename(source) ||
      companion.sha256 !== (await hashFile(source)) ||
      companion.size !== (await stat(source)).size
   )
      throw new Error("Source asset differs from its companion record.");
   compareFiles(kit.staged, companion.staged, "Source companion staging");
   const extractor = await findExtractor(project);
   const scratch = await mkdtemp(path.join(project, "work/release-verification-"));
   const sourceFolder = path.join(scratch, "sources");
   await mkdir(sourceFolder);
   await extractChecked(extractor, source, sourceFolder);
   const archivedKit = JSON.parse(await readFile(path.join(sourceFolder, "manifest.json"), "utf8")) as SourceKit;
   if (archivedKit.appCommit !== appCommit || JSON.stringify(archivedKit) !== JSON.stringify(selectSourceKitFiles(kit).kit))
      throw new Error("Source ZIP manifest differs from the reviewed source kit.");
   const archivedBlockers = await validateKit(archivedKit, sourceFolder, project);
   if (archivedBlockers.length) throw new Error(`Source ZIP evidence is incomplete:\n${archivedBlockers.join("\n")}`);
   // A clean checkout alone says nothing about ignored out/. Recompile from the
   // archived commit before checking packaged JavaScript and renderer assets.
   execFileSync("bun", ["run", "build"], { cwd: project, windowsHide: true, stdio: "inherit", timeout: 180000 });
   const unpacked = path.join(project, "release/win-unpacked");
   const appFiles = await verifyAsar(project, path.join(unpacked, "resources/app.asar"));
   await verifyPackagedResources(project, unpacked, kit);
   const payload = await inventory(unpacked);
   const version = (JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as { version: string }).version;
   if (!/^[\w.-]+$/.test(version)) throw new Error("Invalid release version.");
   const assets: FileRecord[] = [];
   for (const name of [`AttaClip-${version}-win-x64-Installer.exe`, `AttaClip-${version}-win-x64.exe`]) {
      const file = path.join(project, "release", name);
      const folder = path.join(scratch, name.replace(/\.exe$/, ""));
      await mkdir(folder);
      await extractChecked(extractor, file, folder);
      compareFiles(payload, await inventory(folder), `Installer payload ${name}`);
      assets.push(await fileRecord(file, name));
   }
   assets.push(...(await verifyUpdaterAssets(path.join(project, "release"), path.join(project, "release", assets[0]!.path), version, scratch)));
   if (git("rev-parse", "HEAD") !== appCommit || git("status", "--porcelain")) throw new Error("Release source changed during verification.");
   const after = await validateKit(kit, kitDirectory, project);
   if (after.length) throw new Error(`Release staging changed during verification:\n${after.join("\n")}`);
   const output = path.join(project, "release", `AttaClip-${version}-windows-x64-release.json`);
   await writeFile(
      output,
      `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), appCommit, source: companion, assets, appFiles, payload }, null, 2)}\n`
   );
   const sums = [...assets, { path: path.basename(source), sha256: companion.sha256 }, await fileRecord(output, path.basename(output))];
   await writeFile(
      path.join(project, "release", `AttaClip-${version}-windows-x64-SHA256SUMS.txt`),
      sums.map((file) => `${file.sha256}  ${file.path}`).join("\n") + "\n"
   );
   console.log(`Verified both Windows installer payloads and source correspondence: ${output}`);
   return output;
}

if (import.meta.main) {
   const source = process.argv[2];
   if (!source) throw new Error("Usage: bun scripts/verify-release.ts <source-kit.zip>");
   await verifyRelease(process.cwd(), source);
}
