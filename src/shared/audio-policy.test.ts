import { describe, expect, it } from "vitest";
import { needsMicrophonePermission } from "./audio-policy";
import type { AdditionalAudioSource } from "./types";

describe("microphone permission for recording", () => {
   it("requires permission for the primary microphone", () => {
      expect(needsMicrophonePermission({ microphone: true, audioSources: [] })).toBe(true);
   });
   it("requires permission for an enabled additional input when the primary microphone is off", () => {
      expect(needsMicrophonePermission({ microphone: false, audioSources: [{ kind: "input", enabled: true }] })).toBe(true);
   });
   it("does not request microphone access for disabled inputs or application and system audio", () => {
      expect(
         needsMicrophonePermission({
            microphone: false,
            audioSources: [
               { kind: "input", enabled: false },
               { kind: "application", enabled: true },
               { kind: "output", enabled: true },
            ],
         })
      ).toBe(false);
      expect(needsMicrophonePermission({ microphone: false, audioSources: [] })).toBe(false);
   });
   it("still requires access when an enabled input is muted or has zero volume", () => {
      const input: AdditionalAudioSource = {
         id: "input",
         name: "USB microphone",
         kind: "input",
         deviceId: "selected",
         sourceId: "",
         executable: "",
         enabled: true,
         muted: true,
         volume: 0,
         includeInMaster: false,
      };
      expect(needsMicrophonePermission({ microphone: false, audioSources: [input] })).toBe(true);
   });
});
