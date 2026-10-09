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
   });
   it("preserves ordinary screen and exact application capture on other backends", () => {
      expect(portalSources({ supported: true, hardwareEncoders: [], recommended: "low", message: "" })).toBeNull();
      expect(sourceChoices([]).every((choice) => !choice.disabled)).toBe(true);
   });
});
