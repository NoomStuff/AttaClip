import path from "node:path";
import { writeFile } from "node:fs/promises";
import { collectElectronFfmpeg } from "./electron-source-evidence";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Collect against the actual Apple Silicon Electron runtime.");
const directory = path.join(process.cwd(), "work/macos-release-sources");
const actualModule = path.join(
   process.cwd(),
   "release/mac-arm64/AttaClip.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib"
);
const component = await collectElectronFfmpeg(process.cwd(), directory, { platform: "darwin", arch: "arm64", actualModule });
await writeFile(path.join(directory, "electron-component.json"), `${JSON.stringify(component, null, 2)}\n`);
console.log("Captured matching macOS Electron FFmpeg sources, configuration, licenses and official module byte proof.");
