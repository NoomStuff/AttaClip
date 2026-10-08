import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile, inventory } from "./release-sources";
import { compareFiles, verifyAsar } from "./verify-release";
import type { ControlledLinuxMediaBuild } from "./controlled-media-linux";

/** Check extracted package bytes. Source closure is a separate required release gate. */
export async function verifyLinuxPayload(project: string, extracted: string): Promise<{ files: number; compiledFiles: number; digest: string }> {
   const resources = path.join(extracted, "resources");
   const compiled = await verifyAsar(project, path.join(resources, "app.asar"));
   let count = compiled.length;
   for (const name of ["recorder", "media", "notices"]) {
      const expected = await inventory(path.join(project, "resources", name), name);
      if (!expected.length) throw new Error(`No staged ${name} files`);
      const actual = await inventory(path.join(resources, name), name);
      compareFiles(expected, actual, `Packaged ${name}`);
      count += actual.length;
   }
   for (const [source, target] of [
      ["LICENSE", "LICENSE"],
      ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
      ["licenses/AttaCut-MIT.txt", "LICENSE-AttaCut"],
      ["build/icon.png", "icons/icon.png"],
   ]) {
      if ((await hashFile(path.join(project, source!))) !== (await hashFile(path.join(resources, target!))))
         throw new Error(`Packaged notice or icon changed: ${target}`);
      count++;
   }
   const electron = await inventory(path.join(project, "node_modules/electron/dist"));
   const appName = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as { name: string };
   for (const file of electron) {
      // electron-builder replaces this example application with our app.asar.
      if (file.path === "resources/default_app.asar" || file.path === "version") continue;
      const target = path.join(extracted, file.path === "electron" ? appName.name : file.path === "LICENSE" ? "LICENSE.electron.txt" : file.path);
      if ((await hashFile(target)) !== file.sha256 || (await stat(target)).size !== file.size)
         throw new Error(`Packaged Electron runtime differs from official staged runtime: ${file.path}`);
      count++;
   }
   const media = JSON.parse(await readFile(path.join(resources, "media/provenance.json"), "utf8")) as { controlledBuild?: ControlledLinuxMediaBuild };
   if (media.controlledBuild?.producer !== "attaclip-controlled-linux" || media.controlledBuild.target !== "linux-x64")
      throw new Error("Linux package does not contain the controlled Linux media build");
   for (const name of ["ffmpeg", "ffprobe"] as const)
      if ((await hashFile(path.join(resources, "media", name))) !== media.controlledBuild.binaries[name].sha256)
         throw new Error(`Packaged controlled ${name} differs from its build record`);
   for (const file of media.controlledBuild.evidenceFiles) {
      const base = path.resolve(resources, "media/controlled-build");
      const target = path.resolve(base, file.path);
      if (!target.startsWith(base + path.sep) || (await hashFile(target)) !== file.sha256 || (await stat(target)).size !== file.size)
         throw new Error(`Packaged controlled build evidence changed: ${file.path}`);
   }
   return {
      files: count,
      compiledFiles: compiled.length,
      digest: createHash("sha256")
         .update(JSON.stringify(await inventory(resources)))
         .digest("hex"),
   };
}

if (import.meta.main) {
   const [project, extracted, output] = process.argv.slice(2);
   if (!project || !extracted || !output) throw new Error("Pass project, extracted AppImage directory and output report paths.");
   const report = { kind: "linux-packaged-payload-check", ...(await verifyLinuxPayload(path.resolve(project), path.resolve(extracted))) };
   await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
   console.log(JSON.stringify(report));
}
