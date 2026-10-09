import { describe, expect, it } from "vitest";
import { checkMacFfmpegSources, ffmpegHeaderVersion } from "./macos-source-validation";

const names = ["avcodec", "avformat", "avutil", "avdevice", "avfilter", "swscale", "swresample"];
const headers = Object.fromEntries(
   names.map((name) => [name, ["MAJOR 62", "MINOR 1", "MICRO 100"].map((value) => `#define LIB${name.toUpperCase()}_VERSION_${value}`).join("\n")])
);
const libraries = () =>
   names.map((name) => ({
      file: `Frameworks/lib${name}.dylib`,
      version: 62 * 65536 + 256 + 100,
      configuration: "--enable-gpl --enable-version3 --enable-libx264 --enable-librist --enable-libsrt",
   }));

describe("Mac OBS source configuration proof", () => {
   it("checks the actual numeric library versions against source headers", () => {
      expect(ffmpegHeaderVersion(headers["avcodec"]!, "LIBAVCODEC")).toBe(62 * 65536 + 256 + 100);
      expect(() => checkMacFfmpegSources(libraries(), headers)).not.toThrow();
      const wrong = libraries();
      wrong[0]!.version++;
      expect(() => checkMacFfmpegSources(wrong, headers)).toThrow("differs from the captured source");
   });
   it("rejects mixed builds, missing libraries and uncaptured enabled codecs", () => {
      const mixed = libraries();
      mixed[1]!.configuration += " --enable-libfdk-aac";
      expect(() => checkMacFfmpegSources(mixed, headers)).toThrow("different configurations");
      expect(() => checkMacFfmpegSources(libraries().slice(1), headers)).toThrow("Missing or duplicate");
      expect(() =>
         checkMacFfmpegSources(
            libraries().map((library) => ({ ...library, configuration: library.configuration + " --enable-libfdk-aac" })),
            headers
         )
      ).toThrow("No captured Mac source");
   });
});
