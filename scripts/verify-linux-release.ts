import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap";
import { z } from "zod";
import { hashFile, inventory } from "./release-sources";
import { compareFiles } from "./verify-release";
import { linuxPython, packetPath, validateLinuxSourceKit, type LinuxSourceKit } from "./linux-source-kit";
import { verifyLinuxPayload } from "./verify-linux-payload";

type FileRecord = LinuxSourceKit["files"][number];
const fileSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f\d]{64}$/), size: z.number().int().nonnegative() });

export async function verifyAppImageLauncher(image: string, runtime: string, expected: FileRecord): Promise<void> {
   if ((await stat(runtime)).size !== expected.size || (await hashFile(runtime)) !== expected.sha256)
      throw new Error("AppImage launcher source proof differs from its official runtime bytes");
   const handle = await open(image, "r");
   try {
      const bytes = Buffer.alloc(expected.size);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== bytes.length || !bytes.equals(await readFile(runtime)))
         throw new Error("Actual AppImage launcher differs from the reviewed official runtime");
      const magic = Buffer.alloc(4);
      await handle.read(magic, 0, 4, expected.size);
      if (!magic.equals(Buffer.from("hsqs"))) throw new Error("AppImage payload does not start after the reviewed launcher");
   } finally {
      await handle.close();
   }
}

export async function verifyAppImageLibraries(extracted: string, expected: FileRecord[]): Promise<void> {
   if (expected.length !== 6 || expected.some((file) => !/^usr\/lib\/[^/]+$/.test(file.path)))
      throw new Error("AppImage injected library proof does not identify the exact six files");
   compareFiles(expected, await inventory(path.join(extracted, "usr/lib"), "usr/lib"), "AppImage injected libraries");
}

export async function verifyLinuxUpdater(image: string, version: string, scratch: string): Promise<FileRecord> {
   const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string, options: { schema: unknown }): unknown; JSON_SCHEMA: unknown };
   const metadataFile = path.join(path.dirname(image), "latest-linux.yml");
   const metadata = z
      .object({
         version: z.string(),
         path: z.string(),
         sha512: z.string(),
         files: z
            .array(z.object({ url: z.string(), sha512: z.string(), size: z.number().int().positive(), blockMapSize: z.number().int().positive() }))
            .length(1),
      })
      .parse(yaml.load(await readFile(metadataFile, "utf8"), { schema: yaml.JSON_SCHEMA }));
   const hash = createHash("sha512");
   for await (const bytes of createReadStream(image)) hash.update(bytes as Buffer);
   const sha512 = hash.digest("base64");
   const size = (await stat(image)).size;
   const entry = metadata.files[0]!;
   if (
      metadata.version !== version ||
      metadata.path !== path.basename(image) ||
      entry.url !== path.basename(image) ||
      metadata.sha512 !== sha512 ||
      entry.sha512 !== sha512 ||
      entry.size !== size
   )
      throw new Error("Linux update metadata does not identify the actual verified AppImage");
   const handle = await open(image, "r");
   let embedded: Buffer;
   let bodySize: number;
   try {
      const footer = Buffer.alloc(4);
      if (size < 4 || (await handle.read(footer, 0, 4, size - 4)).bytesRead !== 4) throw new Error("AppImage embedded blockmap is missing");
      const length = footer.readUInt32BE();
      if (length !== entry.blockMapSize || length > size - 4) throw new Error("AppImage embedded blockmap size differs from update metadata");
      embedded = Buffer.alloc(length);
      bodySize = size - length - 4;
      if ((await handle.read(embedded, 0, length, bodySize)).bytesRead !== length) throw new Error("AppImage embedded blockmap is incomplete");
   } finally {
      await handle.close();
   }
   const prefix = path.join(scratch, "appimage-before-blockmap");
   await pipeline(createReadStream(image, { end: bodySize - 1 }), createWriteStream(prefix, { flags: "wx" }));
   const regenerated = path.join(scratch, "regenerated-blockmap");
   await buildBlockMap(prefix, "deflate", regenerated);
   if (!inflateRawSync(embedded).equals(inflateRawSync(await readFile(regenerated))))
      throw new Error("AppImage differential update blockmap differs from its actual payload");
   return { path: "latest-linux.yml", sha256: await hashFile(metadataFile), size: (await stat(metadataFile)).size };
}

async function containerInventory(
   directory: string,
   appName: string,
   prefix = ""
): Promise<{ files: FileRecord[]; links: { path: string; target: string }[] }> {
   const files: FileRecord[] = [];
   const links: { path: string; target: string }[] = [];
   for (const item of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
      const relative = path.posix.join(prefix, item.name);
      const file = packetPath(directory, relative);
      if (item.isSymbolicLink()) {
         const target = await readlink(file);
         // These two icon links are generated by electron-builder. No link may
         // substitute a library, application file or runtime notice.
         if (![".DirIcon", `${appName}.png`].includes(relative) || target !== `usr/share/icons/hicolor/1024x1024/apps/${appName}.png`)
            throw new Error(`Unexpected link in AppImage: ${relative}`);
         links.push({ path: relative, target });
      } else if (item.isDirectory()) {
         const child = await containerInventory(directory, appName, relative);
         files.push(...child.files);
         links.push(...child.links);
      } else if (item.isFile()) files.push({ path: relative, sha256: await hashFile(file), size: (await stat(file)).size });
      else throw new Error(`Unexpected special file in AppImage: ${relative}`);
   }
   return { files: files.sort((a, b) => a.path.localeCompare(b.path)), links };
}

export async function verifyLinuxRelease(project: string, stage: string, sourceArchive: string, image: string, directory: string): Promise<string> {
   if (process.platform !== "linux") throw new Error("Run final AppImage verification on Linux or WSL");
   const git = (...args: string[]): string => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim();
   const appCommit = git("rev-parse", "HEAD");
   if (git("status", "--porcelain")) throw new Error("Freeze a clean release commit before verifying its AppImage");
   const kit = await validateLinuxSourceKit(project, directory);
   if (kit.appCommit !== appCommit) throw new Error("Linux source packet covers another application commit");
   const companion = fileSchema
      .extend({ appCommit: z.string(), staged: z.array(fileSchema).min(1) })
      .parse(JSON.parse(await readFile(`${sourceArchive}.json`, "utf8")));
   if (
      companion.path !== path.basename(sourceArchive) ||
      companion.appCommit !== appCommit ||
      companion.sha256 !== (await hashFile(sourceArchive)) ||
      companion.size !== (await stat(sourceArchive)).size
   )
      throw new Error("Linux source ZIP differs from its companion record");
   compareFiles(kit.staged, companion.staged, "Linux source ZIP staging");
   const scratch = await mkdtemp(path.join(stage, ".cache/linux-release-check-"));
   const sourceFolder = path.join(scratch, "sources");
   linuxPython(project, "scripts/package-linux-sources.py", ["--archive", sourceArchive, "--verify", "--extract", sourceFolder]);
   const archived = await validateLinuxSourceKit(project, sourceFolder);
   if (JSON.stringify(archived) !== JSON.stringify(kit)) throw new Error("Linux source ZIP manifest differs from the reviewed source kit");
   // Prove that the archived application is the immutable commit, rather than
   // trusting the self-reported commit field in the packet.
   const freshArchive = path.join(scratch, "application.tar");
   execFileSync("git", ["archive", "--format=tar", "--prefix=attaclip/", "--output", freshArchive, appCommit], { cwd: project });
   if ((await hashFile(freshArchive)) !== kit.applicationSource.sha256) throw new Error("Archived application source differs from the immutable Git commit");
   const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
   for (const relative of tracked.filter(
      (file) =>
         file.startsWith("src/") ||
         file.startsWith("build/") ||
         ["package.json", "bun.lock", "electron.vite.config.ts", "tsconfig.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/AttaCut-MIT.txt"].includes(
            file
         )
   )) {
      const bytes = execFileSync("tar", ["-xOf", packetPath(sourceFolder, kit.applicationSource.path), `attaclip/${relative}`], {
         maxBuffer: 32 * 1024 * 1024,
      });
      if (!bytes.equals(await readFile(packetPath(stage, relative))))
         throw new Error(`Linux build directory contains different application source: ${relative}`);
   }
   execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: stage, stdio: "inherit", timeout: 300000 });
   execFileSync("bun", ["run", "build"], { cwd: stage, stdio: "inherit", timeout: 180000 });
   compareFiles(
      kit.staged.filter((file) => file.path.startsWith("out/")),
      await inventory(path.join(stage, "out"), "out"),
      "Rebuilt archived application"
   );
   compareFiles(
      kit.staged.filter((file) => file.path.startsWith("resources/")),
      await inventory(path.join(stage, "resources"), "resources"),
      "Linux staged resources"
   );
   compareFiles(
      kit.staged.filter((file) => file.path.startsWith("electron/")),
      await inventory(path.join(stage, "node_modules/electron/dist"), "electron"),
      "Official staged Electron"
   );
   const imageBefore = await hashFile(image);
   await verifyAppImageLauncher(image, packetPath(sourceFolder, `toolset/${kit.appimage.runtime.path}`), kit.appimage.runtime);
   // The launcher has passed the official byte check before we execute its
   // extraction mode. This does not launch AppRun or Electron.
   const extractFolder = path.join(scratch, "container");
   await mkdir(extractFolder);
   execFileSync(path.resolve(image), ["--appimage-extract"], { cwd: extractFolder, stdio: "pipe", timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
   const extracted = path.join(extractFolder, "squashfs-root");
   await verifyAppImageLibraries(extracted, kit.appimage.libraries);
   const payload = await verifyLinuxPayload(stage, extracted);
   const pkg = JSON.parse(await readFile(path.join(stage, "package.json"), "utf8")) as { name: string; version: string };
   const require = createRequire(path.join(stage, "package.json"));
   const launcher = require("app-builder-lib/out/targets/appimage/appImageUtil") as {
      generateAppRunScript(config: { ExecutableName: string; ProductName: string; ProductFilename: string }): string;
   };
   if (
      (await readFile(path.join(extracted, "AppRun"), "utf8")) !==
      launcher.generateAppRunScript({ ExecutableName: pkg.name, ProductName: "AttaClip", ProductFilename: "AttaClip" })
   )
      throw new Error("Packaged AppRun differs from the locked builder's generated launcher");
   const knownElfs = new Set<string>([
      ...kit.nativeElfPaths,
      "resources/media/ffmpeg",
      "resources/media/ffprobe",
      ...kit.appimage.libraries.map((file) => file.path),
   ]);
   for (const file of kit.staged.filter((file) => file.path.startsWith("electron/"))) {
      const relative = file.path.slice("electron/".length);
      if (relative !== "resources/default_app.asar" && relative !== "version")
         knownElfs.add(relative === "electron" ? pkg.name : relative === "LICENSE" ? "LICENSE.electron.txt" : relative);
   }
   const { files: actualFiles, links } = await containerInventory(extracted, pkg.name);
   for (const file of actualFiles) {
      const handle = await open(packetPath(extracted, file.path), "r");
      try {
         const bytes = Buffer.alloc(4);
         await handle.read(bytes, 0, 4, 0);
         if (bytes.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && !knownElfs.has(file.path))
            throw new Error(`AppImage contains an ELF absent from its corresponding source inventory: ${file.path}`);
      } finally {
         await handle.close();
      }
   }
   const updater = await verifyLinuxUpdater(image, pkg.version, scratch);
   if ((await lstat(image)).isSymbolicLink() || (await hashFile(image)) !== imageBefore || (await hashFile(sourceArchive)) !== companion.sha256)
      throw new Error("Release artifact changed during verification");
   if (git("rev-parse", "HEAD") !== appCommit || git("status", "--porcelain")) throw new Error("Application commit changed during verification");
   const output = `${image}.release.json`;
   await writeFile(
      output,
      `${JSON.stringify({ version: 1, platform: "linux-x64", appCommit, source: companion, asset: { path: path.basename(image), sha256: imageBefore, size: (await stat(image)).size }, payload, updater, launcher: kit.appimage.runtime, libraries: kit.appimage.libraries, files: actualFiles, links }, null, 2)}\n`
   );
   return output;
}

if (import.meta.main) {
   const [project, stage, source, image, directory] = process.argv.slice(2);
   if (!project || !stage || !source || !image || !directory)
      throw new Error("Pass project, frozen Linux build directory, source ZIP, actual AppImage and source evidence directory");
   console.log(
      await verifyLinuxRelease(...([project, stage, source, image, directory].map((file) => path.resolve(file)) as [string, string, string, string, string]))
   );
}
