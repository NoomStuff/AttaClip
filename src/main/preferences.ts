import { mkdir, readFile, rename, open, copyFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Preferences } from "../shared/types";
import { defaultPreferences } from "../shared/defaults";
import { preferencesSchema } from "../shared/validation";
export async function readPreferences(path: string, collection: string): Promise<Preferences> {
   for (const candidate of [path, `${path}.bak`]) {
      try {
         return preferencesSchema.parse({ ...defaultPreferences, collection, ...JSON.parse(await readFile(candidate, "utf8")) });
      } catch {
         /* Keep trying the last good backup. */
      }
   }
   return { ...defaultPreferences, collection };
}
export async function writePreferences(path: string, value: Preferences): Promise<void> {
   const parsed = preferencesSchema.parse(value);
   await mkdir(dirname(path), { recursive: true });
   const temporary = `${path}.${randomUUID()}.tmp`;
   try {
      const handle = await open(temporary, "wx");
      try {
         await handle.writeFile(JSON.stringify(parsed, null, 2));
         await handle.sync();
      } finally {
         await handle.close();
      }
      try {
         preferencesSchema.parse(JSON.parse(await readFile(path, "utf8")));
         await copyFile(path, `${path}.bak`);
      } catch (error) {
         if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError) && !(error instanceof Error && error.name === "ZodError"))
            throw error;
      }
      await rename(temporary, path);
   } finally {
      await rm(temporary, { force: true });
   }
}
export function requiresCaptureRestart(a: Preferences, b: Preferences): boolean {
   return (
      a.clipSeconds !== b.clipSeconds ||
      a.quality !== b.quality ||
      a.customWidth !== b.customWidth ||
      a.customHeight !== b.customHeight ||
      a.customFPS !== b.customFPS ||
      a.customCQ !== b.customCQ ||
      a.allowSoftwareEncoder !== b.allowSoftwareEncoder ||
      a.microphone !== b.microphone ||
      a.microphoneDevice !== b.microphoneDevice ||
      a.captureAudio !== b.captureAudio ||
      a.avoidOverlap !== b.avoidOverlap ||
      JSON.stringify(a.audioSources.map((source) => ({ ...source, volume: 1, muted: false }))) !==
         JSON.stringify(b.audioSources.map((source) => ({ ...source, volume: 1, muted: false })))
   );
}
