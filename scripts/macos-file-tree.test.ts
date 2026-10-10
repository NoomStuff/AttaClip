import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { relativeMember, macTree, compareMacTrees } from "./macos-file-tree";

test("Mac package names reject path traversal and ambiguous separators", () => {
   for (const value of ["../app", "app/../x", "/app", "app\\x", "app:x", "app//x", "app/./x"]) expect(() => relativeMember(value)).toThrow();
   expect(relativeMember("AttaClip.app/Contents/MacOS/AttaClip")).toBe("AttaClip.app/Contents/MacOS/AttaClip");
});
test("Mac comparison rejects changed file, link, mode, and extra binary", () => {
   const file = { path: "Contents/MacOS/AttaClip", kind: "file" as const, sha256: "a".repeat(64), size: 12, executable: true };
   const link = { path: "Versions/Current", kind: "link" as const, target: "A" };
   compareMacTrees([file, link], [file, link], "app");
   for (const actual of [
      [{ ...file, sha256: "b".repeat(64) }, link],
      [{ ...file, executable: false }, link],
      [file, { ...link, target: "B" }],
      [file, link, { ...file, path: "shadow.dylib" }],
   ])
      expect(() => compareMacTrees([file, link], actual, "app")).toThrow();
});
test("Mac framework links preserve relative identities and reject outside targets", async () => {
   if (process.platform === "win32") return; // Windows developer mode is not required for source tooling tests.
   const root = await mkdtemp(path.join(os.tmpdir(), "mac-links-"));
   try {
      await mkdir(path.join(root, "Versions/A"), { recursive: true });
      await writeFile(path.join(root, "Versions/A/library"), "actual code");
      await symlink("A", path.join(root, "Versions/Current"));
      expect((await macTree(root)).find((entry) => entry.path === "Versions/Current")).toEqual({ path: "Versions/Current", kind: "link", target: "A" });
      await symlink(os.tmpdir(), path.join(root, "outside"));
      await expect(macTree(root)).rejects.toThrow("Unsafe package link");
   } finally {
      await rm(root, { recursive: true, force: true });
   }
});
