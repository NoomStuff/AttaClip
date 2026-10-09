import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./release-sources";
import { linuxPath, linuxPython, validateLinuxSourceKit } from "./linux-source-kit";

export async function packageLinuxSourceKit(project: string): Promise<string> {
   const directory = path.join(project, "work/linux-release-sources");
   const kit = await validateLinuxSourceKit(project, directory);
   const git = (...args: string[]): string => execFileSync("git", args, { cwd: project, windowsHide: true, encoding: "utf8" }).trim();
   if (git("rev-parse", "HEAD") !== kit.appCommit || git("status", "--porcelain"))
      throw new Error("Freeze the clean source commit before packaging its Linux source asset");
   const version = (JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as { version: string }).version;
   if (!/^[\w.-]+$/.test(version)) throw new Error("Invalid package version");
   const archive = path.join(project, "work", `AttaClip-${version}-linux-x64-sources-${kit.appCommit.slice(0, 8)}.zip`);
   await writeFile(
      path.join(directory, "README.txt"),
      `AttaClip Linux x64 source packet\nApplication commit ${kit.appCommit}\n\nlinux-kit.json records the actual staged file hashes. manifest.json links every Ubuntu/OBS ELF to an exact official .deb member and corresponding .dsc source set. static/ contains the actual static/header build input sources. history/ retains published build-info and version records. evidence/electron-ffmpeg-linux contains Electron's LGPL FFmpeg source, generated Linux configuration, build helpers, patches and full notices. controlled-cli contains the four exact CLI sources and the actual captured build configuration/recipe. runtime-notices contains complete license texts.\n\nVerify before rebuilding:\nExtract this ZIP into an empty folder. Extract application/attaclip-${kit.appCommit}.tar. With Bun, Python3 and Ubuntu's dpkg-deb installed, enter attaclip and run bun install --frozen-lockfile, then bun scripts/linux-source-kit.ts --check --directory .. . The checker runs without downloads and compares all archive bytes, exact .dsc dependencies, actual build-info versions, official .deb members, native source fingerprints and runtime notices.\n\nRebuild the application using the archived README instructions and bun.lock. The Ubuntu package sources retain debian/rules, patches, original source and exact build dependencies in history/*/binary.buildinfo. Use dpkg-source -x on a component's .dsc and follow its debian/rules with the recorded Noble dependency versions. OBS came from the recorded OBS PPA package, not a substituted current Git tag. From the packet folder, run python3 attaclip/scripts/prepare-linux-cli-inputs.py . attaclip. Enter attaclip, run bash scripts/build-media-linux.sh, then bun scripts/controlled-media-linux.ts. That script uses the four captured immutable inputs and prints toolchain requirements. Electron BUILD.txt gives the pinned module rebuild layout.\n\nThis packet covers the staged Linux payload only. The final AppImage release verifier must also validate the launcher/toolset and actual container bytes before publication. It does not clear macOS or change the immutable Windows0.1.0 release.\n`
   );
   linuxPython(project, "scripts/package-linux-sources.py", ["--directory", linuxPath(directory), "--archive", linuxPath(archive)]);
   const companion = {
      path: path.basename(archive),
      sha256: await hashFile(archive),
      size: (await stat(archive)).size,
      appCommit: kit.appCommit,
      staged: kit.staged,
   };
   if (companion.size >= 2_000_000_000) throw new Error("Source ZIP exceeds GitHub's per-asset size limit. Do not publish an incomplete split");
   await writeFile(`${archive}.json`, `${JSON.stringify(companion, null, 2)}\n`);
   if (git("rev-parse", "HEAD") !== kit.appCommit || git("status", "--porcelain")) throw new Error("Release source changed while packaging its source asset");
   return archive;
}
if (import.meta.main) console.log(await packageLinuxSourceKit(process.cwd()));
