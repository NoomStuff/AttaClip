import { test, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap";
import { verifyMacUpdater } from "./verify-macos-release";

test("Mac updater binds the actual archive, version and differential blockmap", async () => {
   const root = await mkdtemp(path.join(os.tmpdir(), "mac-updater-"));
   try {
      const archive = path.join(root, "AttaClip-0.1.0-mac-arm64.zip");
      const bytes = Buffer.from("independent package bytes\n".repeat(32768));
      await writeFile(archive, bytes);
      const sha512 = createHash("sha512").update(bytes).digest("base64");
      const metadata = `version: 0.1.0\npath: ${path.basename(archive)}\nsha512: ${sha512}\nfiles:\n  - url: ${path.basename(archive)}\n    sha512: ${sha512}\n    size: ${bytes.length}\n`;
      await writeFile(path.join(root, "latest-mac.yml"), metadata);
      await buildBlockMap(archive, "gzip", `${archive}.blockmap`);
      expect(await verifyMacUpdater(archive, "0.1.0", root)).toHaveLength(2);
      await expect(verifyMacUpdater(archive, "0.2.0", root)).rejects.toThrow("metadata differs");
      const blockmap = await readFile(`${archive}.blockmap`);
      await writeFile(`${archive}.blockmap`, Buffer.from("invalid blockmap"));
      await expect(verifyMacUpdater(archive, "0.1.0", root)).rejects.toThrow();
      await writeFile(`${archive}.blockmap`, blockmap);
      bytes[0] = 0;
      await writeFile(archive, bytes);
      await expect(verifyMacUpdater(archive, "0.1.0", root)).rejects.toThrow("metadata differs");
   } finally {
      await rm(root, { recursive: true, force: true });
   }
});
