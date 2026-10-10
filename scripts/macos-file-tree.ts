import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./release-sources";

export type MacTreeEntry = { path: string; kind: "file"; sha256: string; size: number; executable: boolean } | { path: string; kind: "link"; target: string };

export function relativeMember(name: string): string {
   if (!name || name.includes("\\") || name.includes(":") || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === ".."))
      throw new Error(`Unsafe package member: ${name}`);
   return name;
}

/** Preserve framework links while refusing links outside the application. */
export async function macTree(root: string): Promise<MacTreeEntry[]> {
   const canonical = await realpath(root);
   const records: MacTreeEntry[] = [];
   const seen = new Set<string>();
   const walk = async (directory: string, prefix = ""): Promise<void> => {
      for (const name of await readdir(directory)) {
         const relative = relativeMember(path.posix.join(prefix, name));
         if (seen.has(relative.toLowerCase())) throw new Error(`Case-colliding package member: ${relative}`);
         seen.add(relative.toLowerCase());
         const file = path.join(directory, name);
         const attributes = await lstat(file);
         if (attributes.isSymbolicLink()) {
            const target = await readlink(file);
            if (!target || path.posix.isAbsolute(target) || target.includes("\\") || target.includes(":")) throw new Error(`Unsafe package link: ${relative}`);
            const resolved = await realpath(file);
            if (!resolved.startsWith(canonical + path.sep)) throw new Error(`Package link escapes application: ${relative}`);
            records.push({ path: relative, kind: "link", target });
         } else if (attributes.isDirectory()) await walk(file, relative);
         else if (attributes.isFile())
            records.push({ path: relative, kind: "file", sha256: await hashFile(file), size: attributes.size, executable: !!(attributes.mode & 0o111) });
         else throw new Error(`Unsupported package member: ${relative}`);
      }
   };
   await walk(canonical);
   return records.sort((a, b) => a.path.localeCompare(b.path));
}

export function compareMacTrees(expected: MacTreeEntry[], actual: MacTreeEntry[], label: string): void {
   const left = new Map(expected.map((entry) => [entry.path, entry]));
   const right = new Map(actual.map((entry) => [entry.path, entry]));
   if (left.size !== expected.length || right.size !== actual.length) throw new Error(`${label}: duplicate files`);
   const missing = [...left.keys()].filter((name) => !right.has(name));
   const extra = [...right.keys()].filter((name) => !left.has(name));
   if (missing.length || extra.length) throw new Error(`${label}: missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`);
   for (const [name, value] of left) {
      const other = right.get(name);
      if (!other || value.kind !== other.kind) throw new Error(`${label}: changed member ${name}`);
      if (value.kind === "link" && other.kind === "link" && value.target !== other.target) throw new Error(`${label}: changed link ${name}`);
      if (
         value.kind === "file" &&
         other.kind === "file" &&
         (value.sha256 !== other.sha256 || value.size !== other.size || value.executable !== other.executable)
      )
         throw new Error(`${label}: changed member ${name}`);
   }
}
