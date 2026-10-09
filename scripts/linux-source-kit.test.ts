import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { packetPath, verifyPacketFiles } from "./linux-source-kit";
import { hashFile } from "./release-sources";

describe("Linux source packet ownership", () => {
   it("rejects traversal, aliases, absolute paths and Windows alternate streams", () => {
      const root = path.resolve("work/linux-source-fixture");
      expect(packetPath(root, "evidence/source.tar.gz")).toBe(path.join(root, "evidence/source.tar.gz"));
      for (const name of [
         "../private",
         "evidence/../private",
         "/etc/passwd",
         "C:/private",
         "evidence\\source",
         "./source",
         "source//copy",
         "source/",
         "source:stream",
      ])
         expect(() => packetPath(root, name)).toThrow("Unsafe");
   });
   it("rejects changed archive bytes and duplicate manifest references", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-source-check-"));
      await writeFile(path.join(root, "source.tar"), "actual source");
      const record = { path: "source.tar", sha256: await hashFile(path.join(root, "source.tar")), size: 13 };
      await expect(verifyPacketFiles(root, [record])).resolves.toBeUndefined();
      await expect(verifyPacketFiles(root, [record, record])).rejects.toThrow("Duplicate");
      await writeFile(path.join(root, "source.tar"), "edited source");
      await expect(verifyPacketFiles(root, [record])).rejects.toThrow("changed");
   });
});
