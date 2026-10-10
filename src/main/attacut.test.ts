import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { findAttaCut, rememberAttaCut } from "./attacut";

describe("AttaCut locations", () => {
   it("remembers an explicitly chosen executable with spaces and safely forgets a missing one", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-attacut-"));
      try {
         const executable = path.join(root, "Dave's portable AttaCut");
         const settings = path.join(root, "attacut.json");
         const locations = { platform: process.platform, home: root, appData: root, searchPath: "" };
         await writeFile(executable, "owned test file");
         await chmod(executable, 0o700);
         expect(await rememberAttaCut(settings, executable, process.platform)).toBe(executable);
         expect(await findAttaCut(settings, locations)).toBe(executable);
         const content = await readFile(settings, "utf8");
         await rm(executable);
         expect(await findAttaCut(settings, locations)).toBeNull();
         expect(await readFile(settings, "utf8")).toBe(content);
         await writeFile(settings, "damaged");
         expect(await findAttaCut(settings, locations)).toBeNull();
         await expect(rememberAttaCut(settings, root, process.platform)).rejects.toThrow("cannot run");
         await expect(rememberAttaCut(settings, "relative.exe", process.platform)).rejects.toThrow("absolute");
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });
});
