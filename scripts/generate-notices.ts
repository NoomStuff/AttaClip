import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";

interface PackageInfo {
   name: string;
   version: string;
   author?: string;
   license?: string;
   repository?: string | { url?: string };
   dependencies?: Record<string, string>;
   optionalDependencies?: Record<string, string>;
   peerDependencies?: Record<string, string>;
   peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
interface NoticePackage {
   name: string;
   version: string;
   license: string;
   repository: string;
   packageJsonSha256: string;
   files: { name: string; sha256: string; text: string }[];
}

function digest(text: string | Buffer): string {
   return createHash("sha256").update(text).digest("hex");
}

async function resolvePackage(name: string, parent: string): Promise<string> {
   if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`Invalid dependency name: ${name}`);
   let folder = path.resolve(parent);
   for (;;) {
      const file = path.join(folder, "node_modules", name, "package.json");
      if (existsSync(file)) return realpath(file);
      const next = path.dirname(folder);
      if (next === folder) throw new Error(`Missing production dependency: ${name}`);
      folder = next;
   }
}

export async function dependencyNotices(project: string): Promise<NoticePackage[]> {
   const root = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")) as PackageInfo;
   const packages = new Map<string, NoticePackage>();
   const visited = new Set<string>();
   const visit = async (file: string): Promise<void> => {
      if (visited.has(file)) return;
      visited.add(file);
      const bytes = await readFile(file);
      const info = JSON.parse(bytes.toString("utf8")) as PackageInfo;
      if (!info.name || !info.version) throw new Error(`Dependency lacks its name or version: ${file}`);
      const directory = path.dirname(file);
      const files: NoticePackage["files"] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
         if (entry.isFile() && /^(?:LICEN[CS]E(?:[._-].*)?|COPYING(?:[._-].*)?|NOTICE(?:[._-].*)?|COPYRIGHT)$/i.test(entry.name)) {
            const content = await readFile(path.join(directory, entry.name));
            files.push({ name: entry.name, sha256: digest(content), text: content.toString("utf8") });
         }
      }
      if (!files.length && info.name === "lazy-val" && info.version === "1.0.5" && info.license === "MIT" && info.author === "Vladimir Krivosheev") {
         // npm gitHead b69ad4119f1b19bdab13c61ee2fcc88d46b89071 declares MIT
         // but ships no license file. Retain that declaration and the standard
         // text, identifying this reconstruction rather than inventing an upstream
         // copyright year or claiming an upstream LICENSE file exists.
         const text = [
            "lazy-val@1.0.5 declares SPDX MIT in its published package.json. Its author is Vladimir Krivosheev.",
            "Upstream commit: b69ad4119f1b19bdab13c61ee2fcc88d46b89071. Upstream did not include a LICENSE file. The following is the standard MIT text with author attribution, reconstructed from that declaration.",
            'MIT License\n\nCopyright Vladimir Krivosheev\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
            `Published package metadata:\n${bytes.toString("utf8")}`,
         ].join("\n\n");
         files.push({ name: "MIT-declared-by-package.json.txt", sha256: digest(text), text });
      }
      if (!files.length) throw new Error(`No license text found for bundled dependency ${info.name}@${info.version}.`);
      const key = `${info.name}@${info.version}:${digest(bytes)}`;
      packages.set(key, {
         name: info.name,
         version: info.version,
         license: info.license ?? "See retained license text",
         repository: typeof info.repository === "string" ? info.repository : (info.repository?.url ?? ""),
         packageJsonSha256: digest(bytes),
         files,
      });
      for (const name of Object.keys(info.dependencies ?? {})) await visit(await resolvePackage(name, directory));
      for (const name of Object.keys(info.optionalDependencies ?? {})) {
         try {
            await visit(await resolvePackage(name, directory));
         } catch (error) {
            // Skip only absent platform optional packages. An installed package
            // without its license is still an error.
            if (!(error instanceof Error) || !error.message.startsWith("Missing production dependency:")) throw error;
         }
      }
      for (const name of Object.keys(info.peerDependencies ?? {})) {
         try {
            await visit(await resolvePackage(name, directory));
         } catch (error) {
            if (!info.peerDependenciesMeta?.[name]?.optional || !(error instanceof Error) || !error.message.startsWith("Missing production dependency:"))
               throw error;
         }
      }
   };
   for (const name of Object.keys(root.dependencies ?? {})) await visit(await resolvePackage(name, project));
   return [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

export async function generateNotices(project: string): Promise<void> {
   const packages = await dependencyNotices(project);
   const destination = path.join(project, "resources", "notices");
   await mkdir(destination, { recursive: true });
   const text = [
      "AttaClip bundled JavaScript dependencies",
      "Generated from the installed production dependency graph. Electron and Chromium retain their separate packaged notices.",
      ...packages.flatMap((dependency) => [
         `${dependency.name}@${dependency.version}\nLicense: ${dependency.license}\nUpstream: ${dependency.repository}`,
         ...dependency.files.map((file) => `${file.name}\n${file.text}`),
      ]),
   ].join("\n\n========================================\n\n");
   await writeFile(path.join(destination, "javascript.txt"), `${text}\n`);
   await writeFile(path.join(destination, "javascript.json"), `${JSON.stringify({ version: 1, packages }, null, 2)}\n`);
   console.log(`Retained full license texts for ${packages.length} bundled JavaScript dependencies.`);
}

if (import.meta.main) await generateNotices(process.cwd());
