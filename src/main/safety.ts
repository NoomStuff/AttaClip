import { join } from "node:path";
import type { Preferences } from "../shared/types";
import { previewFilename, safeFileStem } from "../shared/filename";
export { safeFileStem } from "../shared/filename";

export function recordingDestination(preferences: Preferences, source: string, unique: string, now = new Date()): string {
   const label = safeFileStem(source);
   const folder = preferences.folderLayout === "application" ? join(preferences.collection, label) : preferences.collection;
   return join(folder, previewFilename(preferences, source, now, unique));
}
export function samePath(a: string, b: string): boolean {
   return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
export function isValidShortcut(value: string): boolean {
   const parts = value.split("+");
   const key = parts.pop() ?? "";
   const modifiers = new Set(["Command", "Cmd", "Control", "Ctrl", "CommandOrControl", "CmdOrCtrl", "Alt", "Option", "AltGr", "Shift", "Super", "Meta"]);
   if (parts.some((part) => !modifiers.has(part)) || new Set(parts).size !== parts.length) return false;
   return (
      /^[A-Z0-9]$/i.test(key) ||
      /^F(?:[1-9]|1\d|2[0-4])$/.test(key) ||
      new Set([
         "Plus",
         "Space",
         "Tab",
         "Capslock",
         "Numlock",
         "Scrolllock",
         "Backspace",
         "Delete",
         "Insert",
         "Return",
         "Enter",
         "Up",
         "Down",
         "Left",
         "Right",
         "Home",
         "End",
         "PageUp",
         "PageDown",
         "Escape",
         "Esc",
         "VolumeUp",
         "VolumeDown",
         "VolumeMute",
         "MediaNextTrack",
         "MediaPreviousTrack",
         "MediaStop",
         "MediaPlayPause",
         "PrintScreen",
         "-",
         "=",
         "[",
         "]",
         "\\",
         ";",
         "'",
         ",",
         ".",
         "/",
         "`",
      ]).has(key)
   );
}
export function releaseIsNewer(candidate: string, current: string): boolean {
   const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(value)?.slice(1, 4).map(Number);
   const next = parse(candidate),
      previous = parse(current);
   if (!next || !previous) return false;
   for (let index = 0; index < 3; index++) {
      const a = next[index] ?? 0,
         b = previous[index] ?? 0;
      if (a !== b) return a > b;
   }
   return false;
}
export function recordingSourceLabel(preferences: Preferences, sources: Array<{ id: string; name: string }>): string {
   return sources.find((source) => source.id === preferences.sourceId)?.name ?? (preferences.sourceKind === "screen" ? "Screen" : "Application");
}
