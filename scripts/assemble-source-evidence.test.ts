import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkRuntimeVersions, copyNativeLicenses } from "./assemble-source-evidence";

describe("controlled media notices in the runtime package", () => {
   const folders: string[] = [];
   afterEach(async () => {
      await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
   });
   it("retains a compiled dependency's full copyright and license in the installer notices", async () => {
      const project = await mkdtemp(path.join(os.tmpdir(), "attaclip-source-notices-"));
      folders.push(project);
      const directory = path.join(project, "work/release-sources");
      const licensePath = "evidence/controlled-media/licenses/dav1d/COPYING";
      const license = Buffer.from(
         "Copyright (c) 2018, VideoLAN and dav1d authors\nAll rights reserved.\nRedistribution and use in source and binary forms...\n"
      );
      const source = path.join(directory, licensePath);
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, license);
      await copyNativeLicenses(project, directory, [{ path: licensePath, sha256: createHash("sha256").update(license).digest("hex"), size: license.length }]);
      expect(await readFile(path.join(project, "resources/notices/native", licensePath))).toEqual(license);
      expect(await readFile(source)).toEqual(license);
   });
   it("rejects changed license text and paths outside the source kit", async () => {
      const project = await mkdtemp(path.join(os.tmpdir(), "attaclip-source-notices-"));
      folders.push(project);
      const directory = path.join(project, "work/release-sources");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "COPYING"), "changed");
      await expect(copyNativeLicenses(project, directory, [{ path: "COPYING", sha256: "original", size: 7 }])).rejects.toThrow("license changed");
      await expect(copyNativeLicenses(project, directory, [{ path: "../COPYING", sha256: "original", size: 7 }])).rejects.toThrow("path escapes");
   });
});

describe("actual OBS dependency identity", () => {
   const libraries = [
      { file: "libcurl.dll", sha256: "curl-sha", version: "libcurl/8.12.1-DEV Schannel" },
      { file: "librist.dll", sha256: "rist-sha", version: "v0.2.7-1-g809390b" },
      { file: "libx264-164.dll", sha256: "x264-sha", version: "r3106", commitPrefix: "eaa68fa" },
   ];
   const probe = { file: "avcodec-62.dll", sha256: "codec-sha", configuration: "", version: 0, libraries };
   const staged = libraries.map((library) => ({ path: `recorder/${library.file}`, sha256: library.sha256 }));
   const inputs = [
      { file: "libcurl.dll", version: "8.12.1", commit: "57495c64871d18905a0941db9196ef90bafe9a29" },
      { file: "librist.dll", version: "0.2.7", commit: "809390b3b75a259a704079d0fb4d8f1b5f7fa956" },
      { file: "libx264-164.dll", version: "r3106", commit: "eaa68fad9e5d201d42fde51665f2d137ae96baf0" },
   ];
   it("accepts staged hashes and actual embedded versions including development suffixes", () => {
      expect(() => checkRuntimeVersions(probe, staged, inputs)).not.toThrow();
   });
   it("rejects a changed DLL even when its version string still matches", () => {
      expect(() => checkRuntimeVersions(probe, [{ path: staged[0]!.path, sha256: "changed" }, ...staged.slice(1)], inputs)).toThrow("different library");
   });
   it("rejects an incorrect source commit for a DLL's embedded revision", () => {
      expect(() => checkRuntimeVersions(probe, staged, [...inputs.slice(0, 2), { ...inputs[2]!, commit: "0000000000000000000000000000000000000000" }])).toThrow(
         "source commit differs"
      );
   });
   it("rejects missing probes and a version mismatch", () => {
      expect(() => checkRuntimeVersions({ ...probe, libraries: libraries.slice(1) }, staged, inputs)).toThrow("probe is missing");
      expect(() => checkRuntimeVersions(probe, staged, [{ ...inputs[0]!, version: "8.11.0" }, ...inputs.slice(1)])).toThrow("version differs");
   });
});
