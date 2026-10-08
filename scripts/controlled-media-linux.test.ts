import { describe, expect, it } from "vitest";
import { linuxSystemRequirements } from "./controlled-media-linux";

describe("Linux media runtime baseline", () => {
   it("records only host OS dependencies and orders glibc versions numerically", () => {
      const baseline = linuxSystemRequirements(
         "0x1 (NEEDED) Shared library: [libm.so.6]\n0x1 (NEEDED) Shared library: [libc.so.6]",
         "Name: GLIBC_2.38\nName: GLIBC_2.9\nName: GLIBC_2.2.5\nName: GLIBC_2.38"
      );
      expect(baseline).toEqual({ sonames: ["libm.so.6", "libc.so.6"], glibcVersions: ["2.2.5", "2.9", "2.38"] });
   });
   it("rejects a codec or compression library that was accidentally dynamically linked", () => {
      for (const library of ["libx264.so.164", "libdav1d.so.7", "libz.so.1"])
         expect(() => linuxSystemRequirements(`0x1 (NEEDED) Shared library: [${library}]`, "")).toThrow("Unexpected shared media dependency");
   });
});
