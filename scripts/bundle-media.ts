import { execFileSync } from "node:child_process";
import { mkdir, copyFile, writeFile, readdir, readFile, chmod, rm, realpath, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { checkMediaBinary } from "./check-media-binary.ts";
import { readControlledBuild, type ControlledMediaBuild } from "./controlled-media";

const destination = resolve("resources/media");
// This directory contains generated files only. Remove stale binaries from other platforms.
if (destination !== join(process.cwd(), "resources", "media")) throw new Error("Unexpected media destination");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const provenance: Record<string, { path: string; sha256: string; version: string } | ControlledMediaBuild> = {};
for (const name of ["ffmpeg", "ffprobe"] as const) {
   const binary = `${name}${process.platform === "win32" ? ".exe" : ""}`;
   const source = await realpath(
      process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] ||
         execFileSync(process.platform === "win32" ? "where.exe" : "which", [binary], { encoding: "utf8" })
            .trim()
            .split(/\r?\n/)[0]!
   );
   checkMediaBinary(source);
   if (process.platform === "win32" && existsSync(join(dirname(source), "build-manifest.json"))) {
      const controlled = await readControlledBuild(dirname(source));
      if (
         controlled.binaries[name].sha256 !==
         createHash("sha256")
            .update(await readFile(source))
            .digest("hex")
      )
         throw new Error("Controlled media source differs from its recorded build.");
      const previous = provenance["controlledBuild"];
      if (previous && JSON.stringify(previous) !== JSON.stringify(controlled)) throw new Error("FFmpeg and ffprobe come from different controlled builds.");
      provenance["controlledBuild"] = controlled;
      const evidence = join(destination, "controlled-build");
      await mkdir(evidence, { recursive: true });
      for (const entry of await readdir(dirname(source)))
         if (!entry.endsWith(".exe")) await cp(join(dirname(source), entry), join(evidence, entry), { recursive: true });
   }
   await copyFile(source, join(destination, binary));
   if (process.platform !== "win32") await chmod(join(destination, binary), 0o755);
   provenance[name] = {
      path: source,
      sha256: createHash("sha256")
         .update(await readFile(source))
         .digest("hex"),
      version: execFileSync(source, ["-version"], { encoding: "utf8" }),
   };
   if (process.platform === "win32")
      for (const entry of await readdir(dirname(source))) if (entry.endsWith(".dll")) await copyFile(join(dirname(source), entry), join(destination, entry));
   // Run the staged executable too, so missing bundled dependencies fail before packaging.
   execFileSync(join(destination, binary), ["-version"], { stdio: "pipe" });
   for (const candidate of ["LICENSE", "LICENSE.txt", "../LICENSE", "../LICENSE.txt"].map((file) => join(dirname(source), file))) {
      if (existsSync(candidate)) {
         await copyFile(candidate, join(destination, `${name}-LICENSE.txt`));
         break;
      }
   }
}
await writeFile(join(destination, "provenance.json"), JSON.stringify(provenance, null, 2));
await writeFile(
   join(destination, "README.txt"),
   "These FFmpeg/ffprobe binaries were copied from the build computer. See provenance.json for exact versions, configuration, and hashes. FFmpeg: https://ffmpeg.org/ . Preserve applicable source and license obligations before public redistribution.\n"
);
console.log("Bundled FFmpeg, ffprobe, and provenance.");
