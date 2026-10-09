import { describe, expect, it } from "vitest";
import { macSystemRequirements } from "./controlled-media-macos";

describe("macOS controlled media imports", () => {
   it("keeps only operating system libraries", () => {
      expect(
         macSystemRequirements(
            "ffmpeg:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0)"
         )
      ).toEqual(["/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation", "/usr/lib/libSystem.B.dylib"]);
   });
   it("rejects build-machine and relocatable codec libraries", () => {
      for (const file of ["/opt/homebrew/lib/libx264.dylib", "@rpath/libdav1d.dylib", "/usr/libevil/libz.dylib"])
         expect(() => macSystemRequirements(`ffmpeg:\n\t${file} (compatibility version 1.0.0)`)).toThrow("Unexpected shared media dependency");
      expect(() => macSystemRequirements("ffmpeg:\n")).toThrow("Missing Mach-O");
   });
});
