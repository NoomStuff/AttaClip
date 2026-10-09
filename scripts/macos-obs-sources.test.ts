import { describe, expect, it } from "vitest";
import { macRecipe } from "./macos-obs-sources";

describe("Mac OBS dependency declarations", () => {
   it("selects the Mac pin rather than a Windows source", () => {
      const ref = macRecipe(
         'local -A urls=(\n macos https://example.com/source.tar.xz\n windows https://example.com/win.git\n)\nlocal -A hashes=(\n macos "${0:a:h}/checksums/source.tar.xz.sha256"\n windows abcdefabcdefabcdefabcdefabcdefabcdefabcd\n)\nlocal -A versions=(\n macos 1.1.1\n windows 1.2.0\n)',
         "deps/lib.zsh"
      );
      expect(ref).toMatchObject({ uri: "https://example.com/source.tar.xz", version: "1.1.1", revision: "${PSScriptRoot}/checksums/source.tar.xz.sha256" });
   });
   it("refuses mutable tags and executable declarations", () => {
      for (const hash of ["latest", "$(curl example.com)", "`git rev-parse HEAD`"])
         expect(() => macRecipe(`local url='https://example.com/source.git'\nlocal hash='${hash}'`, "deps/lib.zsh")).toThrow();
   });
});
