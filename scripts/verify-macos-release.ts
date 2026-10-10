import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap";
import { z } from "zod";
import { hashFile } from "./release-sources";
import { checkMacSourceKit, parseMacTree } from "./macos-source-kit";
import { macTree, compareMacTrees, type MacTreeEntry } from "./macos-file-tree";
import { verifyAsar } from "./verify-release";

export async function verifyMacUpdater(archive: string, version: string, scratch: string): Promise<{ path: string; sha256: string; size: number }[]> {
   const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string, options: { schema: unknown }): unknown; JSON_SCHEMA: unknown };
   const metadataFile = path.join(path.dirname(archive), "latest-mac.yml");
   const metadata = z
      .object({
         version: z.string(),
         path: z.string(),
         sha512: z.string(),
         files: z.array(z.object({ url: z.string(), sha512: z.string(), size: z.number().int().positive() })).length(1),
      })
      .parse(yaml.load(await readFile(metadataFile, "utf8"), { schema: yaml.JSON_SCHEMA }));
   const digest = createHash("sha512");
   for await (const bytes of createReadStream(archive)) digest.update(bytes as Buffer);
   const sha512 = digest.digest("base64");
   const entry = metadata.files[0]!;
   if (
      metadata.version !== version ||
      metadata.path !== path.basename(archive) ||
      metadata.sha512 !== sha512 ||
      entry.url !== path.basename(archive) ||
      entry.sha512 !== sha512 ||
      entry.size !== (await stat(archive)).size
   )
      throw new Error("Mac update metadata differs from the verified application ZIP.");
   const regenerated = path.join(scratch, "regenerated.blockmap");
   await buildBlockMap(archive, "gzip", regenerated);
   const blockmap = `${archive}.blockmap`;
   if (!gunzipSync(await readFile(regenerated)).equals(gunzipSync(await readFile(blockmap))))
      throw new Error("Mac differential update blockmap differs from the actual ZIP.");
   return Promise.all(
      [metadataFile, blockmap].map(async (file) => ({ path: path.basename(file), sha256: await hashFile(file), size: (await stat(file)).size }))
   );
}

async function verifyMacPayload(project: string, app: string, expected: MacTreeEntry[], electronModule: { sha256: string; size: number }): Promise<void> {
   const resources = path.join(app, "Contents/Resources");
   await verifyAsar(project, path.join(resources, "app.asar"));
   for (const group of ["recorder", "media", "notices"]) {
      const entries = expected.filter((entry) => entry.path.startsWith(group + "/")).map((entry) => ({ ...entry, path: entry.path.slice(group.length + 1) }));
      if (!entries.length) throw new Error(`Missing source-bound ${group} files.`);
      compareMacTrees(entries, await macTree(path.join(resources, group)), `Packaged ${group}`);
   }
   for (const [source, target] of [
      ["LICENSE", "LICENSE"],
      ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
      ["licenses/AttaCut-MIT.txt", "LICENSE-AttaCut"],
      ["build/icon.png", "icons/icon.png"],
   ]) {
      if ((await hashFile(path.join(project, source!))) !== (await hashFile(path.join(resources, target!))))
         throw new Error(`Packaged notice or icon differs: ${target}`);
   }
   const module = path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib");
   if ((await hashFile(module)) !== electronModule.sha256 || (await stat(module)).size !== electronModule.size)
      throw new Error("Actual Electron LGPL module differs from its official source proof.");
}

/** Rebuild from the archived commit, independently repackage, then compare every byte and link. */
export async function verifyMacRelease(project: string, directory: string, sourceArchive: string, archive: string): Promise<string> {
   if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Verify the actual Apple Silicon application on macOS.");
   const kit = await checkMacSourceKit(directory, project);
   const archiveBefore = await hashFile(archive);
   const sourceBefore = await hashFile(sourceArchive);
   if ((await lstat(archive)).isSymbolicLink() || (await lstat(sourceArchive)).isSymbolicLink()) throw new Error("Release assets cannot be links.");
   const companion = z
      .object({
         platform: z.literal("darwin-arm64"),
         appCommit: z.string(),
         archive: z.object({ name: z.string(), sha256: z.string(), size: z.number().int().positive() }),
         staged: z.array(z.unknown()),
      })
      .parse(JSON.parse(await readFile(`${sourceArchive}.json`, "utf8")));
   if (
      companion.appCommit !== kit.appCommit ||
      companion.archive.name !== path.basename(sourceArchive) ||
      companion.archive.sha256 !== sourceBefore ||
      companion.archive.size !== (await stat(sourceArchive)).size
   )
      throw new Error("Mac source ZIP differs from its companion or staged runtime.");
   compareMacTrees(kit.staged, parseMacTree(companion.staged), "Source ZIP staged inputs");
   const scratch = await mkdtemp(path.join(project, ".cache/macos-release-check-"));
   const extractedSource = path.join(scratch, "sources");
   execFileSync("python3", [path.join(project, "scripts/package-macos-sources.py"), "--archive", sourceArchive, "--verify", "--extract", extractedSource], {
      stdio: "inherit",
   });
   const archivedKit = await checkMacSourceKit(extractedSource);
   if (JSON.stringify(archivedKit) !== JSON.stringify(kit)) throw new Error("Archived source manifest differs from the reviewed packet.");
   const freshArchive = path.join(scratch, "git-source.tar");
   execFileSync("git", ["archive", "--format=tar", "--prefix=attaclip/", "-o", freshArchive, kit.appCommit], { cwd: project });
   if ((await hashFile(freshArchive)) !== kit.applicationSource.sha256) throw new Error("Archived application differs from the immutable Git commit.");
   // The tar is now byte-identical to Git's own archive, before extracting it.
   const rebuilt = path.join(scratch, "rebuild");
   await mkdir(rebuilt);
   execFileSync("tar", ["-xf", freshArchive, "-C", rebuilt]);
   const appProject = path.join(rebuilt, "attaclip");
   execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: appProject, stdio: "inherit", timeout: 300000 });
   execFileSync("bun", ["run", "build"], { cwd: appProject, stdio: "inherit", timeout: 300000 });
   compareMacTrees(kit.compiled, await macTree(path.join(appProject, "out")), "Independent application rebuild");
   await cp(path.join(project, "resources"), path.join(appProject, "resources"), { recursive: true, verbatimSymlinks: true });
   compareMacTrees(kit.staged, await macTree(path.join(appProject, "resources")), "Independent package inputs");
   execFileSync("bun", ["run", "build:icons"], { cwd: appProject, stdio: "inherit", timeout: 180000 });
   execFileSync("bun", ["run", "build:notices"], { cwd: appProject, stdio: "inherit", timeout: 180000 });
   compareMacTrees(kit.staged, await macTree(path.join(appProject, "resources")), "Independently generated runtime notices");
   execFileSync("bunx", ["--no-install", "electron-builder", "--mac", "zip", "--arm64", "--publish", "never"], {
      cwd: appProject,
      stdio: "inherit",
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      timeout: 300000,
   });
   const actualFolder = path.join(scratch, "actual");
   execFileSync("python3", [path.join(project, "scripts/extract-macos-package.py"), "--archive", archive, "--destination", actualFolder], { stdio: "inherit" });
   const actualApp = path.join(actualFolder, "AttaClip.app");
   await verifyMacPayload(project, actualApp, kit.staged, kit.electronModule);
   const independentApp = path.join(appProject, "release/mac-arm64/AttaClip.app");
   const expected = await macTree(independentApp);
   const actual = await macTree(actualApp);
   const diagnostics = path.join(project, ".cache/macos-source");
   await mkdir(diagnostics, { recursive: true });
   await writeFile(path.join(diagnostics, "independent-application-tree.json"), `${JSON.stringify(expected, null, 2)}\n`);
   await writeFile(path.join(diagnostics, "actual-application-tree.json"), `${JSON.stringify(actual, null, 2)}\n`);
   // No signature fields, load commands, executable bytes or unknown files
   // are exempted. A signing difference needs a separate captured proof.
   compareMacTrees(expected, actual, "Complete independently packaged application");
   const version = (JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as { version: string }).version;
   const updater = await verifyMacUpdater(archive, version, scratch);
   await checkMacSourceKit(directory, project);
   if ((await hashFile(archive)) !== archiveBefore || (await hashFile(sourceArchive)) !== sourceBefore)
      throw new Error("Release asset changed while verifying.");
   const report = `${archive}.release.json`;
   await writeFile(
      report,
      `${JSON.stringify({ version: 1, platform: "darwin-arm64", appCommit: kit.appCommit, source: companion, asset: { path: path.basename(archive), sha256: archiveBefore, size: (await stat(archive)).size }, updater, application: actual, fullApplicationComparison: "exact-files-modes-and-relative-links", independentRebuild: true }, null, 2)}\n`
   );
   return report;
}

if (import.meta.main) {
   const [directory, sourceArchive, archive] = process.argv.slice(2);
   if (!directory || !sourceArchive || !archive) throw new Error("Pass Mac source packet directory, source ZIP and application ZIP.");
   console.log(await verifyMacRelease(process.cwd(), path.resolve(directory), path.resolve(sourceArchive), path.resolve(archive)));
}
