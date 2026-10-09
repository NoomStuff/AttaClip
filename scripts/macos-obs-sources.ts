import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { collectDependency, hashFile, type SourceKit } from "./release-sources";

type Recipe = NonNullable<SourceKit["dependencyRecipeRefs"]>[number];
type Dependency = NonNullable<SourceKit["dependencySources"]>[number];
const OBS_COMMIT = "ba2f32bdf791005443988a4955e963663e16b1ed";
const RECIPES_COMMIT = "8683107a02300923abe4f293920f4b5edc8cb624";

// Read declarations only. No upstream recipe runs during collection.
export function macRecipe(text: string, recipe: string): Recipe {
   const declaration = text.split(/## Build Steps|## Dependency Overrides/)[0]!;
   const value = (name: string): string => {
      const scalar = new RegExp(`^local ${name}=([^\\r\\n]+)$`, "m").exec(declaration)?.[1];
      const array = new RegExp(`local -A ${name === "hash" ? "hashes" : name + "s"}=\\(([\\s\\S]*?)\\n\\)`).exec(declaration)?.[1];
      const selected = scalar ?? /^\s*macos\s+(.+)$/m.exec(array ?? "")?.[1];
      if (!selected) throw new Error(`Missing macOS ${name} declaration: ${recipe}`);
      const result = selected.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
      if (/[`\n]|\$\(/.test(result)) throw new Error(`Executable expression in macOS declaration: ${recipe}`);
      return result;
   };
   const uri = value("url");
   if (!uri.startsWith("https://")) throw new Error(`Non-HTTPS source declaration: ${recipe}`);
   const hash = value("hash").replace("${0:a:h}/", "${PSScriptRoot}/");
   if (!/^[a-f\d]{40}$/.test(hash) && !/^\$\{PSScriptRoot\}\/checksums\/[\w.-]+\.sha256$/.test(hash)) throw new Error(`No immutable Mac source pin: ${recipe}`);
   let version = "";
   try {
      version = value("version");
   } catch {
      /* Some header and x264 recipes specify a commit without a version. */
   }
   return { provider: "obsproject/obs-deps", recipe, uri, revision: hash, version, enabledFlags: [] };
}

const recipes = [
   "deps.ffmpeg/10-zlib.zsh",
   "deps.ffmpeg/20-opus.zsh",
   "deps.ffmpeg/30-libogg.zsh",
   "deps.ffmpeg/30-libvorbis.zsh",
   "deps.ffmpeg/30-libvpx.zsh",
   "deps.ffmpeg/40-aom.zsh",
   "deps.ffmpeg/40-x264.zsh",
   "deps.ffmpeg/50-libtheora.zsh",
   "deps.ffmpeg/60-lame.zsh",
   "deps.ffmpeg/60-mbedtls.zsh",
   "deps.ffmpeg/60-srt.zsh",
   "deps.ffmpeg/70-librist.zsh",
   "deps.ffmpeg/99-ffmpeg.zsh",
   "deps.macos/30-jansson.zsh",
   "deps.macos/80-nlohmann-json.zsh",
   "deps.macos/80-simde.zsh",
   "deps.macos/80-uthash.zsh",
];

export async function collectMacObsSources(project: string): Promise<void> {
   const cache = path.join(project, "work/release-sources");
   const destination = path.join(project, "work/macos-release-sources");
   const original = JSON.parse(await readFile(path.join(cache, "manifest.json"), "utf8")) as SourceKit;
   const sources = original.sources.filter(
      (source) =>
         (source.repository === "obsproject/obs-studio" && source.commit === OBS_COMMIT) ||
         (source.repository === "obsproject/obs-deps" && source.commit === RECIPES_COMMIT) ||
         (source.repository === "Mbed-TLS/mbedtls-framework" && source.commit === "2a3e2c5ea053c14b745dbdf41f609b1edc6a72fa")
   );
   if (sources.length !== 3) throw new Error("Immutable OBS, recipe or MbedTLS framework source is missing.");
   const copy = async (relative: string, digest: string): Promise<void> => {
      const source = path.resolve(cache, relative);
      const target = path.resolve(destination, relative);
      if (!source.startsWith(`${cache}${path.sep}`) || !target.startsWith(`${destination}${path.sep}`)) throw new Error("Source cache path escapes its root.");
      if ((await hashFile(source)) !== digest) throw new Error(`Cached source changed: ${relative}`);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
   };
   for (const source of sources) {
      await copy(source.path, source.sha256);
      for (const license of source.licenses) await copy(license.path, license.sha256);
   }
   const kit: SourceKit = {
      version: 1,
      createdAt: new Date().toISOString(),
      platform: "darwin-arm64",
      appCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      appDirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
      publicInstallerReady: false,
      staged: [],
      sources,
      blockers: ["Actual provider configuration, packaged bytes and complete Mac release packet still require verification."],
      dependencySources: [],
   };
   const archive = sources.find((source) => source.repository === "obsproject/obs-deps")!;
   const root = `obs-deps-${RECIPES_COMMIT}`;
   const readMember = (member: string) => execFileSync("tar", ["-xOf", path.join(destination, archive.path), member], { encoding: "utf8", windowsHide: true });
   const refs = recipes.map((recipe) => macRecipe(readMember(`${root}/${recipe}`), `${root}/${recipe}`));
   kit.dependencyRecipeRefs = refs;
   const collected: Dependency[] = [];
   const failures: { recipe: string; origin: string; reason: string }[] = [];
   for (const ref of refs) {
      try {
         const revision = ref.revision.startsWith("${PSScriptRoot}/")
            ? /[a-f\d]{64}/i.exec(readMember(path.posix.join(path.posix.dirname(ref.recipe), ref.revision.slice("${PSScriptRoot}/".length))))?.[0]
            : ref.revision;
         if (!revision) throw new Error("Checksum declaration contains no digest.");
         const existing = original.dependencySources?.find((source) => source.origin === ref.uri && source.resolvedRevision === revision);
         let dependency: Dependency;
         if (existing) {
            await copy(existing.path, existing.sha256);
            for (const license of existing.licenses) await copy(license.path, license.sha256);
            dependency = { ...existing, recipe: ref.recipe, requestedRevision: ref.revision };
         } else dependency = await collectDependency(ref, kit, destination);
         if (dependency.resolvedRevision !== revision) throw new Error("Collected source does not match the Mac recipe's immutable pin.");
         collected.push(dependency);
         console.log(`Captured Mac OBS source: ${path.posix.basename(ref.recipe)}`);
      } catch (error) {
         failures.push({ recipe: ref.recipe, origin: ref.uri, reason: error instanceof Error ? error.message : String(error) });
      }
      kit.dependencySources = collected;
      kit.dependencyFailures = failures;
      await writeFile(path.join(destination, "obs-inputs.json"), `${JSON.stringify(kit, null, 2)}\n`);
   }
   if (failures.length) throw new Error(`${failures.length} immutable Mac dependency sources could not be captured. See obs-inputs.json.`);
   console.log(`Captured ${collected.length} Mac OBS dependency inputs with complete upstream recipes and patches. Release proof remains pending.`);
}

if (import.meta.main) await collectMacObsSources(process.cwd());
