import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap";
import { describe, expect, it } from "vitest";
import { archivePaths, compareFiles, verifyAsar, verifyPackagedResources, verifyUpdaterAssets } from "./verify-release";
import { inventory, type SourceKit } from "./release-sources";

describe("final release correspondence", () => {
   it("rejects stale updater hashes, sizes, names and differential blockmaps", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-release-updater-"));
      try {
         const bytes = Buffer.from("verified installer bytes".repeat(1000));
         const installer = path.join(root, "installer.exe");
         await writeFile(installer, bytes);
         await buildBlockMap(installer, "gzip", `${installer}.blockmap`);
         const sha512 = createHash("sha512").update(bytes).digest("base64");
         const metadata = { version: "0.1.0", path: "installer.exe", sha512, files: [{ url: "installer.exe", sha512, size: bytes.length }] };
         const latest = path.join(root, "latest.yml");
         await writeFile(latest, JSON.stringify(metadata));
         expect(await verifyUpdaterAssets(root, installer, "0.1.0", root)).toHaveLength(2);
         for (const change of [{ path: "old.exe" }, { sha512: "wrong" }, { files: [{ ...metadata.files[0]!, size: bytes.length - 1 }] }]) {
            await writeFile(latest, JSON.stringify({ ...metadata, ...change }));
            await expect(verifyUpdaterAssets(root, installer, "0.1.0", root)).rejects.toThrow("latest.yml");
         }
         await writeFile(latest, JSON.stringify(metadata));
         const unrelated = path.join(root, "old.exe");
         await writeFile(unrelated, Buffer.from("previous installer".repeat(1000)));
         await buildBlockMap(unrelated, "gzip", `${installer}.blockmap`);
         await expect(verifyUpdaterAssets(root, installer, "0.1.0", root)).rejects.toThrow("blockmap differs");
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });
   it("rejects missing, changed, extra, and duplicate installed files", () => {
      const expected = [{ path: "helper.exe", sha256: "build-a", size: 10 }];
      expect(() => compareFiles(expected, expected, "fixture")).not.toThrow();
      expect(() => compareFiles(expected, [], "fixture")).toThrow("missing or changed");
      expect(() => compareFiles(expected, [{ ...expected[0]!, sha256: "build-b" }], "fixture")).toThrow("changed");
      expect(() => compareFiles(expected, [...expected, { path: "unexpected.dll", sha256: "other", size: 1 }], "fixture")).toThrow("unexpected");
      expect(() => compareFiles(expected, [...expected, ...expected], "fixture")).toThrow("duplicate");
   });

   it("rejects unsafe archive paths and link entries before extraction", () => {
      const listing = (member: string) => `Path = archive.exe\n----------\nPath = ${member}\nSize = 1\n`;
      expect(archivePaths(listing("resources\\app.asar"))).toEqual(["resources/app.asar"]);
      for (const member of ["../outside", "resources/../../outside", "C:\\outside", "\\outside", "resources/file:stream"])
         expect(() => archivePaths(listing(member))).toThrow("Unsafe");
      expect(() => archivePaths(listing("safe") + "Symbolic Link = ../outside\n")).toThrow("links");
      expect(() => archivePaths(listing("File") + "Path = file\n")).toThrow("Duplicate");
   });

   it("rejects an old or incomplete app.asar even with unchanged Git sources", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-release-asar-"));
      try {
         const packageJson = { name: "attaclip", version: "0.1.0", main: "out/main/index.js" };
         await mkdir(path.join(root, "out/main"), { recursive: true });
         await writeFile(path.join(root, "package.json"), JSON.stringify(packageJson));
         await writeFile(path.join(root, "out/main/index.js"), "original app");
         const archive = path.join(root, "fixture.asar");
         const input = path.join(root, "input");
         await mkdir(path.join(input, "out/main"), { recursive: true });
         await writeFile(path.join(input, "out/main/index.js"), "original app");
         await writeFile(path.join(input, "package.json"), JSON.stringify(packageJson));
         await createPackage(input, archive);
         expect(await verifyAsar(root, archive)).toHaveLength(1);
         await writeFile(path.join(root, "out/main/index.js"), "new app code");
         await expect(verifyAsar(root, archive)).rejects.toThrow("missing or changed out/main/index.js");
         await writeFile(path.join(root, "out/main/index.js"), "original app");
         await writeFile(path.join(root, "out/main/new.js"), "new build module");
         await expect(verifyAsar(root, archive)).rejects.toThrow("new.js");
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it("rejects packaged native drift while the source-kit staging remains unchanged", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-release-native-"));
      try {
         await mkdir(path.join(root, "resources/recorder"), { recursive: true });
         await writeFile(path.join(root, "resources/recorder/helper.exe"), "verified build");
         const staged = await inventory(path.join(root, "resources/recorder"), "recorder");
         const kit: SourceKit = {
            version: 1,
            createdAt: "",
            platform: "win32-x64",
            appCommit: "commit",
            appDirty: false,
            publicInstallerReady: true,
            staged,
            sources: [],
            blockers: [],
         };
         const unpacked = path.join(root, "release/win-unpacked");
         await mkdir(path.join(unpacked, "resources/recorder"), { recursive: true });
         await writeFile(path.join(unpacked, "resources/recorder/helper.exe"), "old packaged build");
         await expect(verifyPackagedResources(root, unpacked, kit)).rejects.toThrow("Packaged recorder: missing or changed recorder/helper.exe");
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });
});
