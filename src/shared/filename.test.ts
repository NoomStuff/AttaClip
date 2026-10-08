import { describe, expect, it } from "vitest";
import { defaultPreferences } from "./defaults";
import { previewFilename, validFilenameTemplate } from "./filename";

describe("custom recording filenames", () => {
   it("rejects folder paths, unsupported tokens, and control characters", () => {
      for (const template of ["../{source}", "Clips\\{date}", "{unknown}", "{source", "Title\n{time}", " "])
         expect(validFilenameTemplate(template)).toBe(false);
      expect(validFilenameTemplate("{source} on {date} at {time}")).toBe(true);
   });
   it("sanitizes captured window titles and keeps same-time saves distinct", () => {
      const preferences = { ...defaultPreferences, filenamePreset: "custom" as const, filenameTemplate: "{date} - {source}" };
      const first = previewFilename(preferences, "../../Game: title", new Date("2026-10-08T12:00:00Z"), "first");
      const second = previewFilename(preferences, "../../Game: title", new Date("2026-10-08T12:00:00Z"), "second");
      expect(first).not.toContain("/");
      expect(first).not.toContain(":");
      expect(first).not.toEqual(second);
      expect(first).toMatch(/^2026-10-08 .*first\.mkv$/);
   });
});
