import path from "node:path";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { collectElectronFfmpeg } from "./electron-source-evidence";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Collect against the actual Apple Silicon Electron runtime.");
const directory = path.join(process.cwd(), "work/macos-release-sources");
const actualModule = path.join(
   process.cwd(),
   "release/mac-arm64/AttaClip.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib"
);
const referenceOnly = process.argv.includes("--prepare");
const component = await collectElectronFfmpeg(process.cwd(), directory, { platform: "darwin", arch: "arm64", actualModule, referenceOnly });
await writeFile(path.join(directory, "electron-component.json"), `${JSON.stringify(component, null, 2)}\n`);
for (const license of component.licenseFiles) {
   const root = path.resolve(process.cwd(), "resources/notices/electron-macos");
   const target = path.resolve(root, license.path);
   if (!target.startsWith(root + path.sep)) throw new Error("Electron notice escapes its directory.");
   await mkdir(path.dirname(target), { recursive: true });
   await copyFile(path.join(directory, license.path), target);
}
await copyFile(
   path.join(process.cwd(), "licenses/nlohmann-json-3.12.0-MIT.txt"),
   path.join(process.cwd(), "resources/notices/electron-macos/nlohmann-json-3.12.0-MIT.txt")
);
console.log(
   referenceOnly
      ? "Prepared Electron sources and full notices. Packaged module comparison is still required."
      : "Captured matching macOS Electron FFmpeg sources, full notices and actual packaged module byte proof."
);
