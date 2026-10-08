import { describe, it, expect } from "vitest";
import { audioTrackTitle } from "./media";

describe("imported audio track names", () => {
   it("uses ordinal names for generic MP4 handlers", () => {
      expect(audioTrackTitle({ handler_name: "SoundHandler" }, 0)).toBe("Master");
      expect(audioTrackTitle({ handler_name: "Sound Media Handler" }, 1)).toBe("Audio 2");
      expect(audioTrackTitle({ title: "", handler_name: "AudioHandler" }, 2)).toBe("Audio 3");
   });
   it("preserves real track titles and useful handler names", () => {
      expect(audioTrackTitle({ title: "Microphone", handler_name: "SoundHandler" }, 1)).toBe("Microphone");
      expect(audioTrackTitle({ handler_name: "Desktop audio" }, 0)).toBe("Desktop audio");
   });
});
