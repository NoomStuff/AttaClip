import { describe, it, expect } from "vitest";
import { selectSourceKitFiles } from "./package-source-kit";
import type { SourceKit } from "./release-sources";

describe("public source-kit selection", () => {
   const source = { path: "core.tar.gz", size: 3, sha256: "core", repository: "core", commit: "commit", url: "", licenses: [] };
   const selected = {
      path: "needed.tar.gz",
      size: 4,
      sha256: "needed",
      recipe: "recipe",
      origin: "origin",
      requestedRevision: "commit",
      resolvedRevision: "commit",
      downloadUrl: "",
      licenses: [{ path: "LICENSE-needed", size: 5, sha256: "license" }],
      review: [],
   };
   const kit: SourceKit = {
      version: 1,
      createdAt: "",
      platform: "win32-x64",
      appCommit: "",
      appDirty: false,
      publicInstallerReady: true,
      staged: [],
      sources: [source],
      blockers: [],
      dependencySources: [selected, { ...selected, path: "unused.tar.gz" }],
      evidence: {
         stagedDigest: "",
         components: [{ id: "fixture", version: "1", license: "MIT", sourceArchives: [selected], licenseFiles: selected.licenses, buildInstructions: [] }],
      },
   };
   it("retains referenced dependencies and licenses without the research overset", () => {
      const result = selectSourceKitFiles(kit);
      expect(result.kit.dependencySources).toEqual([selected]);
      expect(result.files.map((file) => file.path)).toEqual(["core.tar.gz", "LICENSE-needed", "needed.tar.gz"]);
      expect(kit.dependencySources).toHaveLength(2);
   });
   it("rejects conflicting hashes for one archive path", () => {
      expect(() => selectSourceKitFiles({ ...kit, sources: [{ ...source, path: selected.path }] })).toThrow("Conflicting");
   });
});
