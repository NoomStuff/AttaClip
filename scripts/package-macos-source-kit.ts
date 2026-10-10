import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./release-sources";
import { checkMacSourceKit } from "./macos-source-kit";

export async function packageMacSources(project: string, directory: string, archive: string): Promise<void> {
   const kit = await checkMacSourceKit(directory, project);
   await writeFile(
      path.join(directory, "README.txt"),
      `AttaClip Apple Silicon corresponding sources\n\nApplication commit ${kit.appCommit}. macos-kit.json records every included source archive, build input, full license and evidence file. Verify every SHA256 before building. This archive contains no application executable or upstream installer.\n\nExtract attaclip-source.tar and enter attaclip. Install Bun 1.4.2, Xcode command line tools, CMake, Meson, Ninja and pkg-config on Apple Silicon macOS 13 or newer. Run bun install --frozen-lockfile. The lockfile pins JavaScript build and runtime dependencies.\n\nFor the controlled CLI, copy controlled-cli/sources into work/release-sources, preserving relative paths. Read controlled-cli/build-manifest.json for the four immutable FFmpeg, x264, dav1d and zlib inputs. The captured scripts/build-media-macos.sh supplies all compiler/configure commands and verifies uncompressed input tar hashes. Run bash scripts/build-media-macos.sh after copying the four source archives. The recipe reads those fixed archive paths directly and performs no network downloads. Build configuration, logs, compiler versions, licenses and independent codec proof are in controlled-cli/evidence. Generic compiler binaries are not included.\n\nFor libOBS and its bundled libraries, obs-inputs.json identifies the official OBS commit, complete obs-deps recipe archive, exact dependency commits or checksums, patches and full licenses. Extract the OBS and recipe archives. Build dependencies with the captured Mac zsh recipes and CMake presets, then build OBS. The official runtime probe records configuration and original provider-member hashes. scripts/build-recorder-macos.ts records the actual native helper inputs and the mux helper RPATH/signature transformation. Replace its official provider extraction with the rebuilt equivalent runtime when rebuilding dependencies.\n\nElectron FFmpeg build and relinking instructions are in evidence/electron-ffmpeg-darwin-arm64/BUILD.txt. Its complete LGPL source, generated mac/arm64 configuration, Opus sources, immutable dependency records, GN scripts and Electron patches are included. Electron is a component build with a separate replaceable libffmpeg.dylib. The final packaged module matched the official checksum-verified Electron archive exactly.\n\nRun bun run build:icons, bun run build:notices and bun run build. Native OBS/Electron full notices must be staged before electron-builder packaging. Build the app with bunx electron-builder --mac zip --arm64 --publish never. Physical-device permissions, signing and notarization use the builder configuration and your own credentials. This packet does not grant signing credentials or make a source offer on anyone's behalf.\n`
   );
   execFileSync("python3", [path.join(project, "scripts/package-macos-sources.py"), "--directory", directory, "--archive", archive], { stdio: "inherit" });
   const version = (JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as { version: string }).version;
   await writeFile(
      `${archive}.json`,
      `${JSON.stringify({ version, platform: kit.platform, appCommit: kit.appCommit, archive: { name: path.basename(archive), sha256: await hashFile(archive), size: (await stat(archive)).size }, staged: kit.staged }, null, 2)}\n`
   );
}

if (import.meta.main) {
   const project = process.cwd();
   const directory = path.resolve(process.argv[2] ?? "work/macos-release-sources");
   const kit = await checkMacSourceKit(directory, project);
   const version = (JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as { version: string }).version;
   const archive = path.resolve(process.argv[3] ?? `work/AttaClip-${version}-darwin-arm64-sources-${kit.appCommit.slice(0, 8)}.zip`);
   await packageMacSources(project, directory, archive);
   console.log(`Packaged exact corresponding sources: ${archive}`);
}
