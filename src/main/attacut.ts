import { access, readFile, rename, writeFile, stat, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AttaCutLocations {
   platform: NodeJS.Platform;
   home: string;
   appData: string;
   searchPath: string;
}

export function attaCutCandidates(locations: AttaCutLocations): string[] {
   const { platform, home, appData, searchPath } = locations;
   if (platform === "win32")
      return [path.join(appData, "../Local/Programs/AttaCut/AttaCut.exe"), path.join(home, "AppData/Local/Programs/attacut/AttaCut.exe")];
   if (platform === "darwin") return ["/Applications/AttaCut.app/Contents/MacOS/AttaCut", path.join(home, "Applications/AttaCut.app/Contents/MacOS/AttaCut")];
   return searchPath
      .split(path.delimiter)
      .filter((directory) => path.isAbsolute(directory))
      .flatMap((directory) => [path.join(directory, "attacut"), path.join(directory, "AttaCut")]);
}

export function attaCutExecutable(selection: string, platform: NodeJS.Platform): string {
   if (!path.isAbsolute(selection)) throw new Error("Choose an absolute AttaCut application path.");
   return platform === "darwin" && selection.endsWith(".app") ? path.join(selection, "Contents/MacOS/AttaCut") : selection;
}

async function executableExists(file: string, platform: NodeJS.Platform): Promise<boolean> {
   try {
      await access(file, platform === "win32" ? constants.F_OK : constants.X_OK);
      return (await stat(file)).isFile();
   } catch {
      return false;
   }
}

export async function findAttaCut(settings: string, locations: AttaCutLocations): Promise<string | null> {
   let remembered = "";
   try {
      const saved: unknown = JSON.parse(await readFile(settings, "utf8"));
      if (typeof saved === "object" && saved !== null && "executable" in saved && typeof saved.executable === "string" && path.isAbsolute(saved.executable))
         remembered = saved.executable;
   } catch {
      /* A missing or stale location does not affect the clips. */
   }
   for (const file of [...(remembered ? [remembered] : []), ...attaCutCandidates(locations)]) if (await executableExists(file, locations.platform)) return file;
   return null;
}

export async function rememberAttaCut(settings: string, selection: string, platform: NodeJS.Platform): Promise<string> {
   const executable = attaCutExecutable(selection, platform);
   if (!(await executableExists(executable, platform))) throw new Error("The selected AttaCut application cannot run.");
   const temporary = `${settings}.${randomUUID()}.tmp`;
   try {
      await writeFile(temporary, `${JSON.stringify({ executable })}\n`, { flag: "wx" });
      await rename(temporary, settings);
   } finally {
      await rm(temporary, { force: true });
   }
   return executable;
}
