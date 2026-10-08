import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { defaultPreferences } from "../shared/defaults";
import { isValidShortcut, recordingDestination, releaseIsNewer, safeFileStem } from "./safety";
import { desktopExec } from "./startup";

describe("recording destination safety", () => {
   it("keeps application names from escaping the chosen recording folder", () => {
      const prefs = { ...defaultPreferences, collection: "/clips", folderLayout: "application" as const };
      const destination = recordingDestination(prefs, "../../App: title", "unique", new Date("2026-10-08T12:00:00Z"));
      expect(destination).toBe(join("/clips", ".._.._App_ title", ".._.._App_ title 2026-10-08T12-00-00-unique.mkv"));
      expect(safeFileStem("CON")).toBe("Clip");
      expect(safeFileStem("\u0000")).toBe("Clip");
   });
   it("distinguishes identical-time clip requests without changing filename preferences", () => {
      const prefs = { ...defaultPreferences, collection: "/clips" };
      const date = new Date("2026-10-08T12:00:00Z");
      expect(recordingDestination(prefs, "Game", "first", date)).not.toBe(recordingDestination(prefs, "Game", "second", date));
   });
});
describe("shortcut and update validation", () => {
   it("rejects malformed accelerators before Electron receives them", () => {
      expect(isValidShortcut("CommandOrControl+Shift+F8")).toBe(true);
      expect(isValidShortcut("Control+Shift+K")).toBe(true);
      expect(isValidShortcut("Control++")).toBe(false);
      expect(isValidShortcut("Control+Control+K")).toBe(false);
      expect(isValidShortcut("Meta+UnknownKey")).toBe(false);
   });
   it("compares stable version components, without offering malformed or prerelease tags", () => {
      expect(releaseIsNewer("v0.2.0", "0.1.9")).toBe(true);
      expect(releaseIsNewer("0.1.10", "0.1.9")).toBe(true);
      expect(releaseIsNewer("0.1.9", "0.2.0")).toBe(false);
      expect(releaseIsNewer("0.2.0-beta.1", "0.1.0")).toBe(false);
      expect(releaseIsNewer("nonsense", "0.1.0")).toBe(false);
   });
   it("quotes Linux executable paths and escapes desktop entry interpolation", () => {
      expect(desktopExec("/home/user/My App%/AttaClip", ["/project/path"])).toBe('"/home/user/My App%%/AttaClip" "/project/path"');
   });
});
