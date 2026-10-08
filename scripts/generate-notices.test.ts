import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyNotices } from "./generate-notices";

describe("production dependency notices", () => {
   it("follows installed dependencies and peers, retains exact text, and omits development packages", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-notices-"));
      const add = async (name: string, data: object) => {
         const folder = path.join(root, "node_modules", name);
         await mkdir(folder, { recursive: true });
         await writeFile(path.join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", license: "MIT", ...data }));
         await writeFile(path.join(folder, "LICENSE"), `Copyright ${name}\nPermission granted.\n`);
      };
      try {
         await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { app: "1" }, devDependencies: { tool: "1" } }));
         await add("app", { dependencies: { nested: "1" }, peerDependencies: { peer: "1" }, optionalDependencies: { absent: "1" } });
         await add("nested", { dependencies: { app: "1" } });
         await add("peer", {});
         await add("tool", {});
         const result = await dependencyNotices(root);
         expect(result.map((entry) => entry.name)).toEqual(["app", "nested", "peer"]);
         expect(result[0]!.files[0]!.text).toBe("Copyright app\nPermission granted.\n");
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });
   it("refuses to replace a missing license with only the package license identifier", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-notices-"));
      try {
         await mkdir(path.join(root, "node_modules", "app"), { recursive: true });
         await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { app: "1" } }));
         await writeFile(path.join(root, "node_modules", "app", "package.json"), JSON.stringify({ name: "app", version: "1", license: "MIT" }));
         await expect(dependencyNotices(root)).rejects.toThrow("No license text found");
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });
});
