# macOS source correspondence

The Mac capture tests and corresponding-source work are separate checks. Do not publish a Mac installer until both pass against the same frozen application commit and packaged bytes. The Windows release and the verified Linux packet do not approve Mac dependencies.

## Controlled command-line media

`scripts/build-media-macos.sh` compiles Apple Silicon FFmpeg from the same four immutable FFmpeg, x264, dav1d and zlib inputs used on Windows and Linux. It checks each complete uncompressed source tar before extraction. The build disables codec-library autodetection and networking. It keeps the built-in import decoders and filters, and statically links the selected codec libraries. Only macOS system libraries may remain dynamic dependencies.

The recipe captures compiler and SDK versions, configurations, imports, binary hashes and full license texts. `controlled-media-macos.ts` verifies those records and requires eight independent full-decode and pixel comparisons. Raw-video and floating-point PCM output support the native capture tests. Run37948147544 at adf1b19 passed actual compilation, all eight codec fixtures, native core and extra audio tests, and packaged capture and sharing.

## OBS inputs

OBS32.2.2 uses commit `ba2f32bdf791005443988a4955e963663e16b1ed`. Its checked Apple Silicon image has SHA-256 `920d6f26703d2df6e4085bd3c1cbed30488325084136c7a6e9e37021fbd6aaf7`. Its `CMakePresets.json` pins macOS dependency release2026-07-15. That release points to recipe commit `8683107a02300923abe4f293920f4b5edc8cb624` and universal archive SHA-256 `4ecb4c598dfa853168df6c2a0c4e0ffec8495a81fbd1ba051ef88ecd5e0f7e53`.

`macos-obs-sources.ts` reads the Mac declarations without executing upstream recipes. It captured17 exact dependency inputs locally, with zero remaining download failures. These include FFmpeg8.1.2, its Mac codec dependencies, the Mac-specific Theora1.1.1 tarball, MbedTLS, RIST, SRT, Jansson and the header libraries. The complete recipe archive retains the build commands, checksum files and Mac patches. The separately pinned MbedTLS framework source is included. A Windows source revision cannot substitute for a different Mac declaration.

Run on macOS or Linux with GNU tar or BSD tar supporting xz:

```sh
bun scripts/macos-obs-sources.ts
```

Inputs and full license texts go under `work/macos-release-sources`. The collector leaves `publicInstallerReady` false. Input collection does not establish that every enabled library is covered.

`probe-macos-source-runtime.py` compares actual staged Frameworks and PlugIns with the checked official OBS image on the Mac runner. It records Mach-O imports and the actual configuration exported by all seven FFmpeg libraries. The locally compiled helper and the mux modified for relative loading have separate build records. The complete source packet must match those reports and account for every bundled binary, including statically embedded dependencies.

That run's provider comparison passed. `macos-source-validation.ts` then passed against the downloaded report and the captured Mac sources. It checked all seven library versions against source headers, required one matching configuration, rejected uncaptured enabled codec libraries and checked all source and license hashes. On the actual Mac host it also rechecks staged provider hashes before copying the full native notices. The validator leaves final installer approval pending.

## Electron and the final packet

`collect-macos-electron.ts` gathers Electron44.7.0's exact Darwin arm64 Chromium FFmpeg sources, configuration, patches, Opus sources, build helpers and licenses. It compares the installed module with its member in the checksum-verified official Electron archive. Electron's MIT notice does not replace that module's LGPL source obligations.

The first run failed because the assumed installed distribution under `node_modules/electron/dist` was absent. The official Darwin arm64 ZIP does contain the expected separate `libffmpeg.dylib` member. Its verified SHA-256 is `e04e411b58a0a14375dd21b0ab4a378fd38930a702e4e20e322fee4849404c0b`. The collector now accepts an explicit actual module path, and the Mac wrapper targets the application tested under `release/mac-arm64/AttaClip.app`. The exact member-byte comparison remains mandatory. This fix still needs an actual Mac rerun, including checking whether packaging changed the module signature.

The current Mac workflow uploads source inputs, configurations, licenses and comparison reports. It excludes executables, provider binary archives and packaged apps. Those artifacts are evidence for completing the packet, not a public binary release.

The remaining gate must validate the actual Mac configurations against the captured dependency recipes, retain all full runtime notices, bind the application source to a frozen Git commit, create the complete source ZIP and compare the packaged application and updater metadata with that packet. Source collection or a successful capture test alone cannot pass that gate.
