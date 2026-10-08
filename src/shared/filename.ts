import type { Preferences } from "./types";

export function safeFileStem(value: string): string {
   const clean = value
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 100);
   const result = [...clean].filter((character) => character.charCodeAt(0) >= 32).join("");
   if (!result || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) return "Clip";
   return result;
}

export function validFilenameTemplate(template: string): boolean {
   if (!template.trim() || template.length > 160 || /[<>:"/\\|?*]/.test(template) || [...template].some((character) => character.charCodeAt(0) < 32))
      return false;
   return !/[{}]/.test(template.replace(/\{(?:source|date|time)\}/g, ""));
}

export function previewFilename(preferences: Pick<Preferences, "filenamePreset" | "filenameTemplate">, source: string, now: Date, unique = "a1b2c3d4"): string {
   const label = safeFileStem(source);
   const stamp = now
      .toISOString()
      .replaceAll(":", "-")
      .replace(/\.\d+Z$/, "");
   const values = { source: label, date: stamp.slice(0, 10), time: stamp.slice(11) };
   let name: string;
   if (preferences.filenamePreset === "custom") {
      if (!validFilenameTemplate(preferences.filenameTemplate)) throw new Error("Use {source}, {date}, or {time} in a filename without folder separators.");
      name = safeFileStem(preferences.filenameTemplate.replace(/\{(source|date|time)\}/g, (_token: string, key: string) => values[key as keyof typeof values]));
   } else name = preferences.filenamePreset === "date-source" ? `${stamp} ${label}` : `${label} ${stamp}`;
   return `${name}-${safeFileStem(unique)}.mkv`;
}
