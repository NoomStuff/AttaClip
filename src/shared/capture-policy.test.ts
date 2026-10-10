import { describe, expect, it } from "vitest";
import { portalScreenId, portalSources, sourceChoices } from "./capture-policy";
import type { RecordingCapabilities } from "./types";

const ready: RecordingCapabilities = {
   supported: true,
   hardwareEncoders: [],
   recommended: "low",
   message: "",
   captureBackend: "wayland-portal",
   sourceKinds: ["screen"],
   portalPicker: true,
};
describe("system picker capture policy", () => {
   it("exposes only the native screen picker and prevents unsupported app or auto selection", () => {
      const sources = portalSources(ready)!;
      expect(sources.map((source) => source.id)).toEqual([portalScreenId]);
      expect(
         sourceChoices(sources)
            .filter((choice) => !choice.disabled)
            .map((choice) => choice.value)
      ).toEqual(["screen"]);
   });
   it("does not advertise a picker unless the native backend confirms it is available", () => {
      expect(portalSources({ ...ready, supported: false })).toEqual([]);
      expect(portalSources({ ...ready, portalPicker: false })).toEqual([]);
      expect(portalSources({ ...ready, sourceKinds: [] })).toEqual([]);
      expect(sourceChoices([], { ...ready, supported: false }).find((choice) => choice.value === "app")?.disabled).toBe(true);
   });
   it("preserves ordinary screen and exact application capture on other backends", () => {
      expect(portalSources({ supported: true, hardwareEncoders: [], recommended: "low", message: "" })).toBeNull();
      expect(sourceChoices([]).every((choice) => !choice.disabled)).toBe(true);
   });
   it("offers XWayland applications only with the native connection and capability", () => {
      const capability: RecordingCapabilities = { ...ready, applicationBackend: "xwayland", sourceKinds: ["screen", "app", "auto"] };
      const candidates = [
         { id: "window:123:0", pid: 42, name: "Game", executable: "game.exe", foreground: true, fullscreen: false },
         { id: "portal:window", pid: 43, name: "Unverifiable selection", executable: "other", foreground: false, fullscreen: false },
         { id: "window:0:0", pid: 44, name: "Invalid", executable: "other", foreground: false, fullscreen: false },
      ];
      const sources = portalSources(capability, candidates)!;
      expect(sources.map((source) => source.id)).toEqual([portalScreenId, "window:123:0"]);
      expect(sourceChoices(sources, capability).every((choice) => !choice.disabled)).toBe(true);
      expect(portalSources(ready, candidates)!.map((source) => source.id)).toEqual([portalScreenId]);
      expect(portalSources({ ...capability, sourceKinds: ["screen"] }, candidates)!.length).toBe(1);
   });
   it("keeps Auto available with no running XWayland game, without enabling it on screen-only sessions", () => {
      const capability: RecordingCapabilities = { ...ready, applicationBackend: "xwayland", sourceKinds: ["screen", "app", "auto"] };
      const sources = portalSources(capability)!;
      expect(sourceChoices(sources, capability).find((choice) => choice.value === "auto")?.disabled).toBe(false);
      expect(sourceChoices(sources).find((choice) => choice.value === "auto")?.disabled).toBe(true);
      expect(sourceChoices(sources, { ...capability, sourceKinds: ["screen", "app"] }).find((choice) => choice.value === "auto")?.disabled).toBe(true);
   });
});
