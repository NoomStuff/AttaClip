import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hashFile, inventory, validateKit, sourcePins, type SourceKit } from "./release-sources.ts";

describe("release source evidence", () => {
   it("allows complete technical records and does not require source for permissive licenses", async () => {
      const folder = await mkdtemp(path.join(os.tmpdir(), "attaclip-source-kit-"));
      try {
         const archive = path.join(folder, "source.tar.gz");
         await writeFile(archive, "fixture evidence");
         const file = { path: "source.tar.gz", sha256: await hashFile(archive), size: 16 };
         const kit: SourceKit = {
            version: 1,
            createdAt: "",
            platform: "",
            appCommit: "",
            appDirty: false,
            publicInstallerReady: false,
            staged: [],
            blockers: [],
            requiredEvidence: ["permissive-fixture", "attaclip-source"],
            sources: sourcePins.map((pin) => ({ ...file, repository: pin.repository, commit: pin.commit, url: "", licenses: [] })),
            evidence: {
               stagedDigest: createHash("sha256").update("[]").digest("hex"),
               components: [
                  { id: "permissive-fixture", version: "1", license: "MIT", sourceArchives: [], licenseFiles: [file], buildInstructions: [] },
                  { id: "attaclip-source", version: "1", license: "GPL-3.0-or-later", sourceArchives: [file], licenseFiles: [file], buildInstructions: [file] },
               ],
            },
         };
         expect(await validateKit(kit, folder, folder)).toEqual([]);
         kit.evidence!.components[1]!.sourceArchives = [];
         expect((await validateKit(kit, folder, folder)).some((blocker) => blocker.includes("Missing source archives"))).toBe(true);
      } finally {
         await rm(folder, { recursive: true, force: true });
      }
   });
   it("rejects changed staged binaries and damaged archives, and cannot clear only core sources", async () => {
      const folder = await mkdtemp(path.join(os.tmpdir(), "attaclip-source-kit-"));
      try {
         await mkdir(path.join(folder, "resources", "media"), { recursive: true });
         const binary = path.join(folder, "resources", "media", "ffmpeg.exe");
         const archive = path.join(folder, "source.tar.gz");
         await writeFile(binary, "original binary");
         await writeFile(archive, "source fixture");
         const kit: SourceKit = {
            version: 1,
            createdAt: "",
            platform: "win32-x64",
            appCommit: "",
            appDirty: false,
            publicInstallerReady: false,
            staged: await inventory(path.join(folder, "resources", "media"), "media"),
            blockers: [],
            sources: [{ path: "source.tar.gz", sha256: await hashFile(archive), size: 14, repository: "test/test", commit: "abc", url: "", licenses: [] }],
         };
         expect((await validateKit(kit, folder, folder)).some((blocker) => blocker.includes("Missing dependency evidence"))).toBe(true);
         await writeFile(binary, "different binary");
         await writeFile(archive, "damaged source");
         const blockers = await validateKit(kit, folder, folder);
         expect(blockers.some((blocker) => blocker.includes("Staged files changed"))).toBe(true);
         expect(blockers.some((blocker) => blocker.includes("Missing or changed source-kit file"))).toBe(true);
      } finally {
         await rm(folder, { recursive: true, force: true });
      }
   });
   it("rejects a manifest path outside the kit", async () => {
      const folder = await mkdtemp(path.join(os.tmpdir(), "attaclip-source-kit-"));
      try {
         const kit: SourceKit = {
            version: 1,
            createdAt: "",
            platform: "",
            appCommit: "",
            appDirty: false,
            publicInstallerReady: false,
            staged: [],
            blockers: [],
            sources: [{ path: "../escape", sha256: "", size: 0, repository: "", commit: "", url: "", licenses: [] }],
         };
         await expect(validateKit(kit, folder, folder)).rejects.toThrow("escapes");
      } finally {
         await rm(folder, { recursive: true, force: true });
      }
   });
});
