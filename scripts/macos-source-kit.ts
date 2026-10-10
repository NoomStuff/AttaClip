import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashFile, type SourceKit } from "./release-sources";
import { packetPath, verifyPacketFiles } from "./linux-source-kit";
import { readControlledMacBuild } from "./controlled-media-macos";
import { verifyMacObsSourceInputs } from "./macos-source-validation";
import { macTree, compareMacTrees, type MacTreeEntry } from "./macos-file-tree";

const fileSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f\d]{64}$/), size: z.number().int().nonnegative() });
export type MacSourceFile = z.infer<typeof fileSchema>;
const treeSchema = z.discriminatedUnion("kind", [
   fileSchema.extend({ kind: z.literal("file"), executable: z.boolean() }),
   z.object({ path: z.string(), kind: z.literal("link"), target: z.string() }),
]);
const kitSchema = z.object({
   version: z.literal(1),
   platform: z.literal("darwin-arm64"),
   appCommit: z.string().regex(/^[a-f\d]{40}$/),
   applicationSource: fileSchema,
   files: z.array(fileSchema).min(1),
   staged: z.array(treeSchema).min(1),
   compiled: z.array(treeSchema).min(1),
   electronModule: z.object({ sha256: z.string().regex(/^[a-f\d]{64}$/), size: z.number().int().positive() }),
});
export type MacSourceKit = z.infer<typeof kitSchema>;
export function parseMacTree(value: unknown): MacTreeEntry[] {
   return z.array(treeSchema).parse(value);
}

export async function assembleMacSourceKit(project: string, directory = path.join(project, "work/macos-release-sources")): Promise<MacSourceKit> {
   if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Assemble against the actual Apple Silicon runtime.");
   if (execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).trim())
      throw new Error("Freeze a clean application commit before assembling sources.");
   const appCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
   await mkdir(directory, { recursive: true });
   const records = new Map<string, MacSourceFile>();
   const record = async (relative: string, expected?: string): Promise<void> => {
      const file = packetPath(directory, relative);
      const attributes = await lstat(file);
      if (!attributes.isFile()) throw new Error(`Linked or missing source evidence: ${relative}`);
      const sha256 = await hashFile(file);
      if (expected && sha256 !== expected) throw new Error(`Source evidence changed: ${relative}`);
      const previous = records.get(relative);
      if (previous && previous.sha256 !== sha256) throw new Error(`Conflicting source evidence: ${relative}`);
      records.set(relative, { path: relative, sha256, size: attributes.size });
   };
   const copy = async (source: string, relative: string, expected?: string): Promise<void> => {
      const target = packetPath(directory, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      await record(relative, expected);
   };
   const runtime = path.join(project, "resources/recorder");
   const provenance = JSON.parse(await readFile(path.join(runtime, "provenance.json"), "utf8")) as {
      sourceCommit: string;
      runtimeArchive: { sha256: string };
      sourceHashes: Record<string, string>;
      providerFiles: { path: string; sha256: string }[];
   };
   if (
      provenance.sourceCommit !== "ba2f32bdf791005443988a4955e963663e16b1ed" ||
      provenance.runtimeArchive.sha256 !== "920d6f26703d2df6e4085bd3c1cbed30488325084136c7a6e9e37021fbd6aaf7"
   )
      throw new Error("Recorder provenance identifies another OBS release.");
   const required = [
      "native/recorder.cpp",
      "native/CMakeLists.txt",
      "native/macos/platform.hpp",
      "native/macos/platform.mm",
      "native/macos/main.mm",
      "native/macos/Info.plist",
      "scripts/build-recorder-macos.ts",
      "native/macos/notifier.swift",
      "native/macos/notifier-Info.plist",
      "native/vendor/json.hpp",
      "native/macos/input-health.hpp",
   ];
   for (const relative of required)
      if (provenance.sourceHashes[relative] !== (await hashFile(path.join(project, relative))))
         throw new Error(`Recorder was compiled from another application source: ${relative}`);
   if (Object.keys(provenance.sourceHashes).sort().join("\n") !== required.sort().join("\n"))
      throw new Error("Unknown or missing recorder source fingerprints.");
   for (const file of provenance.providerFiles)
      if ((await hashFile(packetPath(runtime, file.path))) !== file.sha256) throw new Error(`Recorder changed since build: ${file.path}`);
   const proof = JSON.parse(await readFile(path.join(project, ".cache/macos-source/runtime-proof.json"), "utf8")) as {
      provenanceSha256: string;
      providerFiles: { path: string }[];
      providerLinks: { path: string; target: string }[];
   };
   if (proof.provenanceSha256 !== (await hashFile(path.join(runtime, "provenance.json")))) throw new Error("Provider proof covers another native build.");
   const runtimeTree = await macTree(runtime);
   const links = runtimeTree
      .filter((file): file is Extract<MacTreeEntry, { kind: "link" }> => file.kind === "link" && /^(?:Frameworks|PlugIns)\//.test(file.path))
      .map((file) => ({ path: file.path, target: file.target }));
   if (
      !proof.providerLinks ||
      JSON.stringify(links.sort((a, b) => a.path.localeCompare(b.path))) !==
         JSON.stringify([...proof.providerLinks].sort((a, b) => a.path.localeCompare(b.path)))
   )
      throw new Error("Native framework links differ from their official provider proof.");
   const covered = new Set([...proof.providerFiles.map((file) => file.path), "attaclip-recorder", "attaclip-notifier", "obs-ffmpeg-mux"]);
   for (const file of runtimeTree.filter((entry): entry is Extract<MacTreeEntry, { kind: "file" }> => entry.kind === "file")) {
      const handle = await open(packetPath(runtime, file.path), "r");
      try {
         const magic = Buffer.alloc(4);
         if (
            (await handle.read(magic, 0, 4, 0)).bytesRead === 4 &&
            [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic.readUInt32BE()) &&
            !covered.has(file.path)
         )
            throw new Error(`Native package has an executable without matching source proof: ${file.path}`);
      } finally {
         await handle.close();
      }
   }
   await verifyMacObsSourceInputs(project, directory, path.join(project, ".cache/macos-source/runtime-proof.json"), {
      stageNotices: false,
      writeReport: false,
   });
   await copy(path.join(project, ".cache/macos-source/runtime-proof.json"), "runtime-proof.json");
   await copy(path.join(runtime, "provenance.json"), "recorder-provenance.json");
   await record("obs-inputs.json");
   const obs = JSON.parse(await readFile(path.join(directory, "obs-inputs.json"), "utf8")) as SourceKit;
   for (const source of [...obs.sources, ...(obs.dependencySources ?? [])])
      for (const file of [source, ...source.licenses]) await record(file.path, file.sha256);
   const build = await readControlledMacBuild(path.join(project, "work/controlled-media/macos-arm64"));
   if ((await hashFile(path.join(project, build.recipe.path))) !== build.recipe.sha256)
      throw new Error("Controlled media recipe differs from the frozen source.");
   for (const file of build.sourceArchives)
      await copy(path.join(project, "work/release-sources", file.path), `controlled-cli/sources/${file.path}`, file.sha256);
   for (const file of build.evidenceFiles)
      await copy(path.join(project, "work/controlled-media/macos-arm64", file.path), `controlled-cli/evidence/${file.path}`, file.sha256);
   await copy(path.join(project, "work/controlled-media/macos-arm64/build-manifest.json"), "controlled-cli/build-manifest.json");
   await record("electron-component.json");
   const component = z
      .object({
         id: z.literal("electron-ffmpeg-source"),
         sourceArchives: z.array(fileSchema).length(7),
         licenseFiles: z.array(fileSchema).min(1),
         buildInstructions: z.array(fileSchema).min(1),
      })
      .parse(JSON.parse(await readFile(path.join(directory, "electron-component.json"), "utf8")));
   for (const file of [...component.sourceArchives, ...component.licenseFiles, ...component.buildInstructions]) await record(file.path, file.sha256);
   const correspondence = z
      .object({
         comparison: z.literal("packaged-module-byte-equality"),
         platform: z.literal("darwin"),
         arch: z.literal("arm64"),
         officialArchive: z.object({ sha256: z.literal("e04e411b58a0a14375dd21b0ab4a378fd38930a702e4e20e322fee4849404c0b") }),
         ffmpegDll: z.object({ sha256: z.string().regex(/^[a-f\d]{64}$/), size: z.number().int().positive() }),
      })
      .parse(JSON.parse(await readFile(path.join(directory, "evidence/electron-ffmpeg-darwin-arm64/correspondence.json"), "utf8")));
   const sourceFile = packetPath(directory, "attaclip-source.tar");
   execFileSync("git", ["archive", "--format=tar", "--prefix=attaclip/", "-o", sourceFile, appCommit], { cwd: project });
   await record("attaclip-source.tar");
   const kit: MacSourceKit = {
      version: 1,
      platform: "darwin-arm64",
      appCommit,
      applicationSource: records.get("attaclip-source.tar")!,
      files: [...records.values()].sort((a, b) => a.path.localeCompare(b.path)),
      staged: await macTree(path.join(project, "resources")),
      compiled: await macTree(path.join(project, "out")),
      electronModule: correspondence.ffmpegDll,
   };
   await verifyPacketFiles(directory, kit.files);
   await writeFile(path.join(directory, "macos-kit.json"), `${JSON.stringify(kit, null, 2)}\n`);
   await checkMacSourceKit(directory, project);
   return kit;
}

export async function checkMacSourceKit(directory: string, project?: string): Promise<MacSourceKit> {
   const kit = kitSchema.parse(JSON.parse(await readFile(path.join(directory, "macos-kit.json"), "utf8")));
   if (!kit.files.some((file) => JSON.stringify(file) === JSON.stringify(kit.applicationSource)))
      throw new Error("Application source archive is not in the source packet.");
   await verifyPacketFiles(directory, kit.files);
   await verifyMacObsSourceInputs(project ?? directory, directory, path.join(directory, "runtime-proof.json"), { stageNotices: false, writeReport: false });
   if (project) {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
      if (head !== kit.appCommit || execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).trim())
         throw new Error("Source kit differs from the clean application commit.");
      compareMacTrees(kit.staged as MacTreeEntry[], await macTree(path.join(project, "resources")), "Staged runtime");
      compareMacTrees(kit.compiled as MacTreeEntry[], await macTree(path.join(project, "out")), "Compiled application");
   }
   return kit;
}

if (import.meta.main) {
   const directory = path.resolve(process.argv[2] ?? "work/macos-release-sources");
   const kit = process.argv.includes("--check") ? await checkMacSourceKit(directory, process.cwd()) : await assembleMacSourceKit(process.cwd(), directory);
   console.log(JSON.stringify({ platform: kit.platform, appCommit: kit.appCommit, sourceFiles: kit.files.length, stagedFiles: kit.staged.length }));
}
