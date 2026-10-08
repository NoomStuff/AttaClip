import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createGunzip } from "node:zlib";
import type { ControlledMediaBuild } from "./controlled-media";

interface SourcePin {
   name: string;
   repository: string;
   commit: string;
}
interface HashedFile {
   path: string;
   sha256: string;
   size: number;
}
interface SourceArchive extends HashedFile {
   repository: string;
   commit: string;
   url: string;
   licenses: HashedFile[];
}
interface DependencyEvidence {
   stagedDigest: string;
   components: {
      id: string;
      version: string;
      license: string;
      sourceArchives: HashedFile[];
      licenseFiles: HashedFile[];
      buildInstructions: HashedFile[];
   }[];
}
interface DependencyRecipeRef {
   provider: string;
   recipe: string;
   uri: string;
   revision: string;
   version: string;
   enabledFlags: string[];
   dependsOn?: string[];
}
interface DependencySource extends HashedFile {
   recipe: string;
   origin: string;
   requestedRevision: string;
   resolvedRevision: string;
   downloadUrl: string;
   licenses: HashedFile[];
   review: string[];
}
interface ArchiveExportOptions {
   prefix: string;
   crlf: boolean;
}
export interface SourceKit {
   version: 1;
   createdAt: string;
   platform: string;
   appCommit: string;
   appDirty: boolean;
   publicInstallerReady: boolean;
   staged: HashedFile[];
   sources: SourceArchive[];
   blockers: string[];
   collectionBlockers?: string[];
   requiredEvidence?: string[];
   evidence?: DependencyEvidence;
   dependencyRecipeRefs?: DependencyRecipeRef[];
   dependencySources?: DependencySource[];
   dependencyFailures?: { recipe: string; origin: string; reason: string }[];
}

// Immutable commits, resolved from upstream release tags. These collect known
// sources. They do not establish correspondence for every linked dependency.
export const sourcePins: SourcePin[] = [
   { name: "obs-studio", repository: "obsproject/obs-studio", commit: "ba2f32bdf791005443988a4955e963663e16b1ed" },
   { name: "obs-deps-recipes", repository: "obsproject/obs-deps", commit: "8683107a02300923abe4f293920f4b5edc8cb624" },
   { name: "libdshowcapture", repository: "obsproject/libdshowcapture", commit: "8878638324393815512f802640b0d5ce940161f1" },
   { name: "obs-browser", repository: "obsproject/obs-browser", commit: "3f0a2cdf378939ebe3c6f9ab36d4ea100c25aac2" },
   { name: "obs-websocket", repository: "obsproject/obs-websocket", commit: "1ef34bf48110c2a18184e50e41cd0b1a855e2147" },
   { name: "btbn-build-recipes", repository: "BtbN/FFmpeg-Builds", commit: "6c9aec5fc9a72ec3abedd1fa84db141fa18cf52b" },
   { name: "ffmpeg-btbn-core", repository: "FFmpeg/FFmpeg", commit: "29e619e767cde9045a75c29bc9a8278ae7b3a98b" },
   { name: "json", repository: "nlohmann/json", commit: "55f93686c01528224f448c19128836e7df245f72" },
   // Gitlink from the MbedTLS source used by OBS's SRT dependency.
   { name: "obs-mbedtls-framework", repository: "Mbed-TLS/mbedtls-framework", commit: "2a3e2c5ea053c14b745dbdf41f609b1edc6a72fa" },
];

export async function hashFile(file: string): Promise<string> {
   const hash = createHash("sha256");
   for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
   return hash.digest("hex");
}

export async function inventory(directory: string, prefix = ""): Promise<HashedFile[]> {
   if (!existsSync(directory)) return [];
   const files: HashedFile[] = [];
   for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Symlink in release inventory: ${path.join(directory, entry.name)}`);
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await inventory(absolute, relative)));
      else if (entry.isFile()) {
         files.push({ path: relative, sha256: await hashFile(absolute), size: (await stat(absolute)).size });
      }
   }
   return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function releaseInventory(project: string): Promise<HashedFile[]> {
   const files = [
      ...(await inventory(path.join(project, "resources", "recorder"), "recorder")),
      ...(await inventory(path.join(project, "resources", "media"), "media")),
      ...(await inventory(path.join(project, "resources", "notices"), "notices")),
   ];
   const electronFfmpeg = path.join(project, "node_modules/electron/dist/ffmpeg.dll");
   if (existsSync(electronFfmpeg)) files.push({ path: "electron/ffmpeg.dll", sha256: await hashFile(electronFfmpeg), size: (await stat(electronFfmpeg)).size });
   return files;
}

function run(command: string, args: string[], cwd?: string): string {
   const result = spawnSync(command, args, { ...(cwd ? { cwd } : {}), encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
   if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
   return result.stdout;
}

async function collectSource(pin: SourcePin, destination: string): Promise<SourceArchive> {
   const name = `${pin.name}-${pin.commit}.tar.gz`;
   const file = path.join(destination, name);
   const url = `https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`;
   // Codeload archives address the immutable commit. Record the downloaded digest
   // rather than pretending we have an independently published archive checksum.
   if (!existsSync(file)) {
      const temporary = `${file}.download`;
      run(process.platform === "win32" ? "curl.exe" : "curl", [
         "--fail",
         "--location",
         "--silent",
         "--show-error",
         "--retry",
         "3",
         "--max-time",
         "180",
         "--output",
         temporary,
         url,
      ]);
      await rename(temporary, file);
   }
   const members = run("tar", ["-tzf", file]).trim().split(/\r?\n/);
   if (!members.some((member) => member.startsWith(`${pin.repository.split("/")[1]}-${pin.commit}/`)))
      throw new Error(`Source archive does not identify ${pin.repository}@${pin.commit}`);
   const licenses: HashedFile[] = [];
   const licenseDirectory = path.join(destination, "licenses", pin.name);
   await mkdir(licenseDirectory, { recursive: true });
   // Keep each license's source path. A basename-only copy loses attribution when
   // repositories contain several vendored libraries with separate license files.
   for (const member of members.filter((member) => /\/(?:COPYING(?:\.[^/]*)?|LICENSE(?:\.[^/]*)?|UNLICENSE)$/i.test(member))) {
      const content = run("tar", ["-xOzf", file, member]);
      const relative = member.substring(member.indexOf("/") + 1);
      const target = path.join(licenseDirectory, relative);
      if (!path.resolve(target).startsWith(`${path.resolve(licenseDirectory)}${path.sep}`)) throw new Error("Unsafe license archive path.");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      licenses.push({ path: path.relative(destination, target).replaceAll("\\", "/"), sha256: await hashFile(target), size: Buffer.byteLength(content) });
   }
   return { path: name, repository: pin.repository, commit: pin.commit, url, sha256: await hashFile(file), size: (await stat(file)).size, licenses };
}

function recipeRefs(source: SourceArchive, directory: string): DependencyRecipeRef[] {
   const archive = path.join(directory, source.path);
   const members = run("tar", ["-tzf", archive]).trim().split(/\r?\n/);
   const selected = members.filter((member) =>
      source.repository === "BtbN/FFmpeg-Builds" ? /\/scripts\.d\/.*\.sh$/.test(member) : /\/deps\.(?:ffmpeg|windows)\/[^/]+\.ps1$/.test(member)
   );
   return selected.flatMap((recipe) => {
      const text = run("tar", ["-xOzf", archive, recipe]);
      const uri = /^SCRIPT_REPO=["']([^"']+)/m.exec(text)?.[1] ?? /\$Uri\s*=\s*["']([^"']+)/.exec(text)?.[1];
      const revision = /^SCRIPT_(?:COMMIT|REV)=["']([^"']+)/m.exec(text)?.[1] ?? /\$Hash\s*=\s*["']([^"']+)/.exec(text)?.[1];
      if (!uri) return [];
      return [
         {
            provider: source.repository,
            recipe,
            uri,
            revision: revision ?? "unresolved expression",
            version: /\$Version\s*=\s*["']([^"']+)/.exec(text)?.[1] ?? "",
            enabledFlags: [...new Set(text.match(/--enable-[\w-]+/g) ?? [])],
            dependsOn: [...(/ffbuild_depends\(\)\s*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "").matchAll(/^\s*echo\s+([\w-]+)\s*$/gm)].map((match) => match[1]!),
         },
      ];
   });
}

/** Read dependency declarations as data. Never execute an upstream shell recipe. */
export function dependencyClosure(refs: DependencyRecipeRef[], enabled: Set<string>): DependencyRecipeRef[] {
   const selected = new Set<DependencyRecipeRef>();
   const aliases = (ref: DependencyRecipeRef) => [
      path
         .basename(ref.recipe)
         .replace(/^\d+-/, "")
         .replace(/\.(sh|ps1)$/, ""),
      path.basename(path.dirname(ref.recipe)).replace(/^\d+-/, ""),
   ];
   const add = (ref: DependencyRecipeRef) => {
      if (selected.has(ref)) return;
      selected.add(ref);
      // A directory groups a library and its private build prerequisites.
      const parent = path.posix.dirname(ref.recipe);
      if (/\/scripts\.d\/[^/]+$/.test(parent)) for (const sibling of refs) if (path.posix.dirname(sibling.recipe) === parent) add(sibling);
      for (const dependency of ref.dependsOn ?? []) {
         if (dependency === "base") continue;
         for (const candidate of refs) if (candidate.provider === ref.provider && aliases(candidate).includes(dependency)) add(candidate);
      }
   };
   for (const ref of refs) {
      if (ref.provider === "BtbN/FFmpeg-Builds" && ref.enabledFlags.some((flag) => enabled.has(flag))) add(ref);
      // OBS's FFmpeg recipe set is deliberately small. Include its source inputs
      // and libraries linked into the staged runtime, excluding generic tools.
      if (
         ref.provider === "obsproject/obs-deps" &&
         ((/\/deps\.ffmpeg\//.test(ref.recipe) && !/gas-preprocessor/.test(ref.recipe)) || /\/deps\.windows\/30-curl\.ps1$/.test(ref.recipe))
      )
         add(ref);
   }
   return [...selected];
}

function runAsync(command: string, args: string[], timeoutMs = 120_000): Promise<string> {
   return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "",
         error = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on("data", (data: Buffer) => {
         output = (output + data.toString("utf8")).slice(-1024 * 1024);
      });
      child.stderr.on("data", (data: Buffer) => {
         error = (error + data.toString("utf8")).slice(-4000);
      });
      child.once("error", (failure) => {
         clearTimeout(timer);
         reject(failure);
      });
      child.once("close", (code) => {
         clearTimeout(timer);
         if (code === 0) resolve(output);
         else reject(new Error(`${command} failed: ${error || output || code}`));
      });
   });
}

async function exportRepository(ref: DependencyRecipeRef, file: string, directory: string, archiveOptions?: ArchiveExportOptions): Promise<string> {
   const uri = new URL(ref.uri);
   if (uri.protocol !== "https:" || uri.username || uri.password) throw new Error("Source exports require a public HTTPS repository.");
   const key = createHash("sha256").update(`${ref.uri}@${ref.revision}`).digest("hex").slice(0, 16);
   if (uri.hostname.startsWith("svn.")) {
      if (!/^\d+$/.test(ref.revision)) throw new Error("SVN source revision is not an integer.");
      const folder = path.join(directory, "svn-exports", key);
      await mkdir(path.dirname(folder), { recursive: true });
      await runAsync(
         process.env["ATTACLIP_SVN_PATH"] || "svn",
         [
            "export",
            "--non-interactive",
            "--no-auth-cache",
            "--force",
            "--username",
            "anonymous",
            "--password",
            "",
            "-r",
            ref.revision,
            `${ref.uri}@${ref.revision}`,
            folder,
         ],
         180_000
      );
      await runAsync("tar", ["-czf", file, "-C", folder, "."], 180_000);
      return `svn-r${ref.revision}`;
   }
   const git = path.join(directory, "git-exports", key);
   await mkdir(git, { recursive: true });
   await runAsync("git", ["init", "--bare", git]);
   await runAsync("git", ["-C", git, "config", "remote.origin.url", ref.uri]);
   await runAsync("git", ["-C", git, "config", "remote.origin.promisor", "true"]);
   await runAsync("git", ["-C", git, "config", "remote.origin.partialclonefilter", "blob:none"]);
   await runAsync("git", ["-c", "protocol.file.allow=never", "-C", git, "fetch", "--depth", "1", "--filter=blob:none", "origin", ref.revision], 180_000);
   const commit = (await runAsync("git", ["-C", git, "rev-parse", "FETCH_HEAD^{commit}"])).trim();
   if (/^[a-f\d]{7,40}$/i.test(ref.revision) && !commit.startsWith(ref.revision)) throw new Error("Fetched Git commit differs from recipe pin.");
   const subset: string[] = [];
   if (uri.pathname === "/GPUOpen-LibrariesAndSDKs/AMF.git") {
      // The recipe installs headers only. Exclude SDK sample executables and
      // media assets, which are not source used to build this FFmpeg binary.
      subset.push("amf/public/include");
      const names = (await runAsync("git", ["-C", git, "ls-tree", "--name-only", commit])).trim().split(/\r?\n/);
      subset.push(...names.filter((name) => /^licen[cs]e|^copying/i.test(name)));
   }
   // Text conversion and the archive prefix are part of the captured input.
   // Gzip compression itself may differ between Git builds, so controlled inputs
   // also pin the complete uncompressed tar below.
   await runAsync(
      "git",
      [
         "-c",
         `core.autocrlf=${archiveOptions?.crlf ?? true}`,
         "-C",
         git,
         "archive",
         "--format=tar.gz",
         `--prefix=${archiveOptions?.prefix ?? "source"}-${commit}/`,
         `--output=${file}`,
         commit,
         ...subset,
      ],
      180_000
   );
   return commit;
}

export async function collectDependency(
   ref: DependencyRecipeRef,
   kit: SourceKit,
   directory: string,
   forceRepositoryExport = false,
   archiveOptions?: ArchiveExportOptions
): Promise<DependencySource> {
   const recipeArchive = kit.sources.find((source) => source.repository === ref.provider);
   if (!recipeArchive) throw new Error("Pinned recipe archive missing.");
   const recipeText = run("tar", ["-xOzf", path.join(directory, recipeArchive.path), ref.recipe]);
   let expectedDigest: string | undefined;
   let revision = ref.revision;
   const uri = new URL(ref.uri);
   let url = ref.uri;
   let extension = ".tar.gz";
   let repositoryExport = forceRepositoryExport;
   let exportedRevision: string | undefined;
   if (uri.pathname === "/GPUOpen-LibrariesAndSDKs/AMF.git") repositoryExport = true;
   if (revision.startsWith("${PSScriptRoot}/")) {
      const checksumPath = path.posix.join(path.posix.dirname(ref.recipe), revision.substring("${PSScriptRoot}/".length));
      expectedDigest = /[a-f\d]{64}/i.exec(run("tar", ["-xOzf", path.join(directory, recipeArchive.path), checksumPath]))?.[0].toLowerCase();
      if (!expectedDigest) throw new Error("Upstream checksum file contains no SHA-256.");
      revision = expectedDigest;
      extension = path.extname(uri.pathname) || ".archive";
   } else if (uri.hostname === "github.com") {
      const repo = uri.pathname.replace(/^\//, "").replace(/\.git$/, "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Source URL is not a GitHub repository or a hash-pinned archive.");
      if (!/^[a-f\d]{7,40}$/i.test(revision)) {
         const response = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(revision)}`, { signal: AbortSignal.timeout(30_000) });
         if (!response.ok) throw new Error(`Cannot resolve GitHub source tag: HTTP ${response.status}`);
         const value = (await response.json()) as { sha?: string };
         if (!value.sha || !/^[a-f\d]{40}$/i.test(value.sha)) throw new Error("Source tag did not resolve to a commit.");
         revision = value.sha;
      }
      url = `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(revision)}`;
   } else if (uri.hostname.includes("gitlab") || uri.hostname === "code.videolan.org") {
      const repo = uri.pathname.replace(/\.git$/, "");
      const name = path.posix.basename(repo);
      url = `${uri.origin}${repo}/-/archive/${encodeURIComponent(revision)}/${name}-${encodeURIComponent(revision)}.tar.gz`;
   } else if (uri.hostname.endsWith("googlesource.com")) {
      url = `${ref.uri.replace(/\.git$/, "")}/+archive/${encodeURIComponent(revision)}.tar.gz`;
   } else if (uri.hostname.startsWith("svn.") || uri.hostname === "git.code.sf.net" || uri.hostname === "git.savannah.gnu.org") repositoryExport = true;
   else throw new Error(`No immutable archive adapter for ${uri.hostname}, revision ${revision}. Source requires a pinned Git or SVN export.`);
   if (revision === "unresolved expression") throw new Error("The recipe's exact source revision could not be read.");
   const name = `${createHash("sha256").update(`${ref.uri}@${revision}`).digest("hex").slice(0, 16)}-${path.posix
      .basename(uri.pathname)
      .replace(/\.git$/, "")
      .replace(/[^\w.-]/g, "_")}${extension}`;
   const folder = path.join(directory, "dependencies");
   await mkdir(folder, { recursive: true });
   const file = path.join(folder, name);
   if (repositoryExport) exportedRevision = await exportRepository(ref, file, directory, archiveOptions);
   else if (!existsSync(file)) {
      const temporary = `${file}.download`;
      await runAsync(process.platform === "win32" ? "curl.exe" : "curl", [
         "--fail",
         "--location",
         "--silent",
         "--show-error",
         "--retry",
         "1",
         "--connect-timeout",
         "15",
         "--max-time",
         "90",
         "--output",
         temporary,
         url,
      ]);
      await rename(temporary, file);
   }
   const digest = await hashFile(file);
   if (expectedDigest && expectedDigest !== digest) throw new Error(`Source archive checksum mismatch: ${ref.uri}`);
   let members: string[];
   try {
      members = run("tar", ["-tf", file]).trim().split(/\r?\n/);
   } catch (error) {
      if (expectedDigest || uri.hostname !== "code.videolan.org") throw error;
      exportedRevision = await exportRepository(ref, file, directory);
      members = run("tar", ["-tf", file]).trim().split(/\r?\n/);
   }
   let resolvedRevision = exportedRevision ?? revision;
   if (uri.hostname === "github.com" && !expectedDigest && !exportedRevision) {
      const resolved = /-([a-f\d]{40})\/$/i.exec(members[0] ?? "")?.[1];
      if (!resolved) throw new Error("GitHub source archive lacks an immutable commit prefix.");
      if (/^[a-f\d]{7,40}$/i.test(revision) && !resolved.startsWith(revision)) throw new Error("Source commit does not match the pinned revision.");
      resolvedRevision = resolved;
   }
   const licenses: HashedFile[] = [];
   const licenseRoot = path.join(directory, "licenses", "dependencies", name);
   for (const member of members.filter((member) => /(?:^|\/)(?:COPYING(?:\.[^/]*)?|LICEN[CS]E(?:\.[^/]*)?|UNLICENSE|COPYRIGHT)$/i.test(member))) {
      const target = path.resolve(licenseRoot, member);
      if (!target.startsWith(`${path.resolve(licenseRoot)}${path.sep}`)) throw new Error("Unsafe dependency license path.");
      const content = spawnSync("tar", ["-xOf", file, member], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (content.status !== 0) throw new Error(`Cannot extract dependency license: ${member}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content.stdout);
      licenses.push({ path: path.relative(directory, target).replaceAll("\\", "/"), sha256: await hashFile(target), size: content.stdout.length });
   }
   const review: string[] = [];
   if (/git submodule|git-sync-deps|fetch.*depend|cargo (?:update|cinstall)/.test(recipeText))
      review.push("Recipe fetches submodules or package dependencies. Archive those pinned source inputs before marking this component complete.");
   if (!licenses.length) review.push("No license file recognized in the source archive. Check the upstream source tree.");
   if (!expectedDigest && !/^[a-f\d]{7,40}$/i.test(ref.revision) && !resolvedRevision.startsWith("svn-r"))
      review.push("Recipe pins a tag, not a commit. The collected commit needs comparison with the release-time dependency input.");
   return {
      path: path.relative(directory, file).replaceAll("\\", "/"),
      sha256: await hashFile(file),
      size: (await stat(file)).size,
      recipe: ref.recipe,
      origin: ref.uri,
      requestedRevision: ref.revision,
      resolvedRevision,
      downloadUrl: exportedRevision ? `git-or-svn-export:${ref.uri}@${resolvedRevision}` : url,
      licenses,
      review,
   };
}

async function collectDependencies(kit: SourceKit, directory: string, project: string, retry = false): Promise<void> {
   const provenance = await readFile(path.join(project, "resources", "media", "provenance.json"), "utf8");
   const enabled = new Set(provenance.match(/--enable-[\w-]+/g) ?? []);
   const selected = dependencyClosure(kit.dependencyRecipeRefs ?? [], enabled).filter(
      (ref) => !retry || !(kit.dependencySources ?? []).some((source) => source.recipe === ref.recipe)
   );
   kit.dependencySources = retry ? (kit.dependencySources ?? []) : [];
   kit.dependencyFailures = [];
   let cursor = 0;
   // Four independent network downloads keep this bounded and avoid a large
   // sequential wait when one upstream archive host is unavailable.
   await Promise.all(
      Array.from({ length: 4 }, async () => {
         while (cursor < selected.length) {
            const ref = selected[cursor++]!;
            try {
               kit.dependencySources!.push(await collectDependency(ref, kit, directory));
               console.log(`Archived dependency: ${ref.uri}@${ref.revision}`);
            } catch (error) {
               kit.dependencyFailures!.push({ recipe: ref.recipe, origin: ref.uri, reason: error instanceof Error ? error.message : String(error) });
               console.error(`Dependency missing: ${ref.uri}: ${error instanceof Error ? error.message : String(error)}`);
            }
            await writeFile(
               path.join(directory, "dependency-progress.json"),
               `${JSON.stringify({ sources: kit.dependencySources, failures: kit.dependencyFailures }, null, 2)}\n`
            );
         }
      })
   );
   await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(kit, null, 2)}\n`);
}

export async function hashTarContents(file: string): Promise<string> {
   const hash = createHash("sha256");
   const input = createReadStream(file);
   const tar = createGunzip();
   input.on("error", (error) => tar.destroy(error));
   input.pipe(tar);
   try {
      for await (const chunk of tar) hash.update(chunk as Buffer);
      return hash.digest("hex");
   } finally {
      input.destroy();
      tar.destroy();
   }
}

export async function collectControlledInputs(kit: SourceKit, directory: string): Promise<void> {
   const inputs: { origin: string; commit: string; tarSha256: string; archiveOptions?: ArchiveExportOptions }[] = [
      {
         origin: "https://code.videolan.org/videolan/x264.git",
         commit: "0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee",
         tarSha256: "5686546d663e7520bd05cd47a31d615d0dc707c089cfcb5924a1bcfd3aea7be5",
         archiveOptions: { prefix: "x264", crlf: false },
      },
      {
         origin: "https://code.videolan.org/videolan/dav1d.git",
         commit: "9711965b60bb692ae24004659acf61f5c7d9ed61",
         tarSha256: "86f69f5dd9a63c9f6bd6ba7f3b0172c89cf936559ba396dda40eba7a4e31e7a9",
         archiveOptions: { prefix: "source", crlf: true },
      },
      {
         origin: "https://github.com/madler/zlib.git",
         commit: "51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf",
         tarSha256: "c26b1af0562377fe129e26be73e8adf50a2ac9250c2523fa5805bdbca47fabc7",
      },
   ];
   kit.dependencySources ??= [];
   for (const input of inputs) {
      let source = kit.dependencySources.find((item) => item.origin === input.origin && item.resolvedRevision === input.commit);
      if (!source) {
         const ref = kit.dependencyRecipeRefs?.find((item) => item.uri === input.origin && item.revision === input.commit);
         if (!ref) throw new Error(`Controlled input is absent from pinned recipes: ${input.origin}`);
         // Reproduce each captured tar's prefix and text conversion. HTTP archive
         // access differs between hosts, so these inputs always use Git exports.
         source = await collectDependency(ref, kit, directory, !!input.archiveOptions, input.archiveOptions);
         kit.dependencySources.push(source);
      }
      const file = path.join(directory, source.path);
      if ((await hashFile(file)) !== source.sha256) throw new Error(`Captured archive changed: ${input.origin}`);
      const tarDigest = await hashTarContents(file);
      if (tarDigest !== input.tarSha256)
         throw new Error(`Controlled source contents changed: ${input.origin}, expected ${input.tarSha256}, received ${tarDigest}`);
   }
   await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(kit, null, 2)}\n`);
}

export async function validateKit(kit: SourceKit, kitDirectory: string, project: string): Promise<string[]> {
   const blockers = [...(kit.collectionBlockers ?? kit.blockers)];
   const current = await releaseInventory(project);
   if (JSON.stringify(current) !== JSON.stringify(kit.staged)) blockers.push("Staged files changed after collecting this source kit. Collect a new manifest.");
   for (const source of kit.sources) {
      for (const file of [source, ...source.licenses]) {
         const absolute = path.resolve(kitDirectory, file.path);
         if (!absolute.startsWith(`${path.resolve(kitDirectory)}${path.sep}`)) throw new Error("Source kit path escapes its directory.");
         if (!existsSync(absolute) || (await hashFile(absolute)) !== file.sha256) blockers.push(`Missing or changed source-kit file: ${file.path}`);
      }
   }
   for (const pin of sourcePins)
      if (!kit.sources.some((source) => source.repository === pin.repository && source.commit === pin.commit))
         blockers.push(`Pinned source archive missing: ${pin.name}`);
   for (const source of kit.dependencySources ?? []) {
      for (const file of [source, ...source.licenses]) {
         const absolute = path.resolve(kitDirectory, file.path);
         if (!absolute.startsWith(`${path.resolve(kitDirectory)}${path.sep}`)) throw new Error("Dependency archive path escapes its directory.");
         if (!existsSync(absolute) || (await hashFile(absolute)) !== file.sha256) blockers.push(`Missing or changed dependency archive: ${file.path}`);
      }
   }
   const requiredEvidence = kit.requiredEvidence ?? ["dependency-source-coverage"];
   if (kit.evidence?.stagedDigest !== createHash("sha256").update(JSON.stringify(current)).digest("hex"))
      blockers.push("Dependency source evidence is absent or covers a different staged binary set.");
   for (const id of requiredEvidence) {
      const component = kit.evidence?.components.find((component) => component.id === id);
      if (!component) {
         blockers.push(`Missing dependency evidence: ${id}`);
         continue;
      }
      if (!component.version || !component.license || !component.licenseFiles.length) blockers.push(`Missing version or license evidence: ${id}`);
      const permissive = /^(MIT|BSD-2-Clause|BSD-3-Clause|ISC|Zlib|curl|Apache-2\.0|BSL-1\.0)$/.test(component.license);
      const knownCopyleft = [
         "attaclip-source",
         "ffmpeg-core-build-config",
         "obs-dependency-build-config",
         "obs-ffmpeg-core-and-enabled-dependencies",
         "obs-runtime:w32-pthreads.dll",
         "obs-runtime:libx264-164.dll",
      ];
      if ((!permissive || knownCopyleft.includes(id)) && (!component.sourceArchives.length || !component.buildInstructions.length))
         blockers.push(`Missing source archives or build instructions: ${id}`);
      for (const file of [...component.sourceArchives, ...component.licenseFiles, ...component.buildInstructions]) {
         const absolute = path.resolve(kitDirectory, file.path);
         if (!absolute.startsWith(`${path.resolve(kitDirectory)}${path.sep}`)) throw new Error("Dependency evidence path escapes its directory.");
         if (!existsSync(absolute) || (await hashFile(absolute)) !== file.sha256) blockers.push(`Missing or changed dependency evidence: ${id}/${file.path}`);
      }
   }
   return [...new Set(blockers)];
}

export async function collectKit(project: string, destination: string, downloadSources: boolean): Promise<SourceKit> {
   await mkdir(destination, { recursive: true });
   let previous: SourceKit | undefined;
   try {
      previous = JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8")) as SourceKit;
   } catch {
      /* A fresh kit does not require an earlier manifest. */
   }
   const staged = await releaseInventory(project);
   const sources: SourceArchive[] = [];
   const blockers: string[] = [];
   for (const pin of sourcePins) {
      if (downloadSources) {
         try {
            sources.push(await collectSource(pin, destination));
         } catch (error) {
            blockers.push(`Could not archive ${pin.name}: ${error instanceof Error ? error.message : String(error)}`);
         }
      }
   }
   const appDirty = run("git", ["status", "--porcelain"], project).trim() !== "";
   let appCommit = "";
   try {
      appCommit = run("git", ["rev-parse", "HEAD"], project).trim();
   } catch {
      blockers.push("The application repository has no release commit yet.");
   }
   if (appDirty) blockers.push("The application has uncommitted changes. A clean release commit and its complete source archive are required.");
   if (!staged.some((file) => file.path === "media/ffmpeg.exe" || file.path === "media/ffmpeg")) blockers.push("No staged FFmpeg binary.");
   const mediaProvenancePath = path.join(project, "resources", "media", "provenance.json");
   const mediaProvenance = existsSync(mediaProvenancePath) ? await readFile(mediaProvenancePath, "utf8") : "";
   let controlledBuild: ControlledMediaBuild | undefined;
   try {
      controlledBuild = (JSON.parse(mediaProvenance) as { controlledBuild?: ControlledMediaBuild }).controlledBuild;
   } catch {
      blockers.push("Media provenance is invalid.");
   }
   if (controlledBuild) {
      if (
         controlledBuild.producer !== "attaclip-controlled-windows" ||
         controlledBuild.sourceCommits.ffmpeg !== sourcePins.find((pin) => pin.name === "ffmpeg-btbn-core")?.commit
      )
         blockers.push("Controlled FFmpeg source identity is not recognized.");
      for (const name of ["ffmpeg", "ffprobe"] as const) {
         const binary = staged.find((file) => file.path === `media/${name}.exe`);
         if (!binary || binary.sha256 !== controlledBuild.binaries[name].sha256) blockers.push(`Controlled ${name} hash does not match staging.`);
      }
      for (const file of controlledBuild.evidenceFiles) {
         const absolute = path.resolve(project, "resources", "media", "controlled-build", file.path);
         if (!absolute.startsWith(`${path.resolve(project, "resources", "media", "controlled-build")}${path.sep}`))
            throw new Error("Controlled build path escapes staging.");
         if (!existsSync(absolute) || (await hashFile(absolute)) !== file.sha256)
            blockers.push(`Controlled build evidence is missing or changed: ${file.path}`);
      }
      for (const file of controlledBuild.sourceArchives) {
         const absolute = path.resolve(destination, file.path);
         if (!absolute.startsWith(`${path.resolve(destination)}${path.sep}`)) throw new Error("Controlled source path escapes the kit.");
         if (!existsSync(absolute) || (await hashFile(absolute)) !== file.sha256)
            blockers.push(`Controlled source archive is missing or changed: ${file.path}`);
      }
   }
   if (!mediaProvenance.includes("29e619e767"))
      blockers.push("Staged FFmpeg does not identify the pinned BtbN core commit. Local Gyan or other binaries need their own source records.");
   const obsArchive = path.join(project, ".cache", "OBS-Studio-32.2.2-Windows-x64.zip");
   const officialArchiveVerified =
      existsSync(obsArchive) && (await hashFile(obsArchive)) === "4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1";
   if (!officialArchiveVerified)
      blockers.push("The hash-verified official OBS runtime archive is absent. Installed OBS version strings are insufficient provenance.");
   const obsProvenancePath = path.join(project, "resources", "recorder", "provenance.json");
   const obsProvenance = existsSync(obsProvenancePath) ? await readFile(obsProvenancePath, "utf8") : "";
   try {
      const parsed = JSON.parse(obsProvenance) as {
         runtimeArchive?: { sha256?: string };
         sourceHashes?: Record<string, string>;
         binaryHashes?: Record<string, string>;
      };
      if (parsed.runtimeArchive?.sha256 !== "4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1")
         blockers.push("Recorder provenance does not identify the hash-verified official runtime archive.");
      for (const file of ["native/recorder.cpp", "native/CMakeLists.txt", "scripts/build-native.ts"]) {
         if (!existsSync(path.join(project, file)) || parsed.sourceHashes?.[file] !== (await hashFile(path.join(project, file))))
            blockers.push(`Recorder build-input hash absent or stale: ${file}`);
      }
      const helper = staged.find((file) => file.path === "recorder/attaclip-recorder.exe");
      if (!helper || parsed.binaryHashes?.["attaclip-recorder.exe"] !== helper.sha256) blockers.push("Recorder helper binary hash absent or stale.");
   } catch {
      blockers.push("Recorder provenance is missing or invalid.");
   }
   if (officialArchiveVerified) {
      const verifiedRuntime = path.join(destination, "verified-obs-runtime");
      await mkdir(verifiedRuntime, { recursive: true });
      run("tar", ["-xf", obsArchive, "-C", verifiedRuntime]);
      for (const file of staged.filter((file) => file.path.startsWith("recorder/"))) {
         const relative = file.path.substring("recorder/".length);
         if (relative === "attaclip-recorder.exe" || relative === "provenance.json" || relative.startsWith("LICENSE-")) continue;
         const official = path.join(verifiedRuntime, relative.includes("/") ? relative : path.posix.join("bin/64bit", relative));
         if (!existsSync(official) || (await hashFile(official)) !== file.sha256)
            blockers.push(`Staged OBS runtime file does not match the official archive: ${relative}`);
      }
   }
   const requiredEvidence = ["attaclip-source", "electron-notices"];
   if (staged.some((file) => file.path === "electron/ffmpeg.dll")) requiredEvidence.push("electron-ffmpeg-source");
   if (staged.some((file) => file.path.startsWith("recorder/") && /\.(dll|exe)$/i.test(file.path))) {
      requiredEvidence.push("obs-dependency-build-config");
      const external = ["w32-pthreads.dll", "zlib.dll", "libcurl.dll", "librist.dll", "srt.dll", "libx264-164.dll"];
      for (const name of external) if (staged.some((file) => file.path === `recorder/${name}`)) requiredEvidence.push(`obs-runtime:${name}`);
      if (staged.some((file) => /recorder\/avcodec-\d+\.dll$/.test(file.path))) requiredEvidence.push("obs-ffmpeg-core-and-enabled-dependencies");
   }
   // The static FFmpeg executable contains these enabled external libraries.
   // Record each separately rather than assuming the core source covers them.
   requiredEvidence.push("ffmpeg-core-build-config");
   const internalOrSystem = new Set([
      "gpl",
      "version3",
      "shared",
      "static",
      "debug",
      "pthreads",
      "w32threads",
      "schannel",
      "vaapi",
      "cuda-llvm",
      "cross-compile",
      "indev",
      "encoder",
      "protocol",
   ]);
   for (const flag of new Set(mediaProvenance.match(/--enable-[\w-]+/g) ?? [])) {
      const name = flag.substring("--enable-".length);
      if (!internalOrSystem.has(name)) requiredEvidence.push(`ffmpeg-external:${name}`);
   }
   let evidence: DependencyEvidence | undefined;
   try {
      evidence = JSON.parse(await readFile(path.join(destination, "dependency-evidence.json"), "utf8")) as DependencyEvidence;
   } catch {
      /* The missing per-component records remain explicit release blockers. */
   }
   const kit: SourceKit = {
      version: 1,
      createdAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      appCommit,
      appDirty,
      publicInstallerReady: false,
      staged,
      sources,
      blockers,
      collectionBlockers: [...blockers],
      requiredEvidence,
      ...(evidence ? { evidence } : {}),
      dependencyRecipeRefs: sources
         .filter((source) => source.repository === "BtbN/FFmpeg-Builds" || source.repository === "obsproject/obs-deps")
         .flatMap((source) => recipeRefs(source, destination)),
   };
   // Refreshing staging must not erase already collected immutable source records.
   // Their recipe paths include the pinned recipe commit; drop records only when
   // that pinned input actually changes, and validate every retained archive.
   if (previous?.dependencySources)
      kit.dependencySources = previous.dependencySources.filter((source) => kit.dependencyRecipeRefs?.some((ref) => source.recipe === ref.recipe));
   if (previous?.dependencyFailures)
      kit.dependencyFailures = previous.dependencyFailures.filter((failure) => kit.dependencyRecipeRefs?.some((ref) => failure.recipe === ref.recipe));
   kit.blockers = await validateKit(kit, destination, project);
   kit.publicInstallerReady = kit.blockers.length === 0;
   await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(kit, null, 2)}\n`);
   return kit;
}

if (import.meta.main) {
   const project = process.cwd();
   const destination = path.join(project, "work", "release-sources");
   const check = process.argv.includes("--check");
   let kit: SourceKit;
   if (check || process.argv.includes("--retry-dependencies")) {
      kit = JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8")) as SourceKit;
      kit.blockers = await validateKit(kit, destination, project);
      kit.publicInstallerReady = kit.blockers.length === 0;
   } else kit = await collectKit(project, destination, !process.argv.includes("--inventory-only"));
   if (!check && (process.argv.includes("--dependencies") || process.argv.includes("--retry-dependencies")))
      await collectDependencies(kit, destination, project, process.argv.includes("--retry-dependencies"));
   if (!check && process.argv.includes("--controlled-inputs")) await collectControlledInputs(kit, destination);
   console.log(`Source kit: ${destination}\n${kit.staged.length} staged files, ${kit.sources.length} source archives.`);
   for (const blocker of kit.blockers) console.error(`Blocked: ${blocker}`);
   // This flag only controls archival job exit status. Publication still needs
   // complete hashed evidence and a review of its actual source correspondence.
   if ((check || !process.argv.includes("--collect-only")) && kit.blockers.length) process.exitCode = 1;
}
