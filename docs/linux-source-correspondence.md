# Linux source correspondence

The Windows 0.1.0 release packet is immutable. Linux collection uses `work/linux-release-sources` and does not rewrite it.

## What has passed

The captured Linux recorder runtime has 223 upstream ELF files. The collector matched every file to a member of an exact official Ubuntu or OBS PPA `.deb`. Its 200 package records include notice owners and common-license owners, not 200 independent runtime libraries. Source `.dsc` files identify the exact original archives and Debian patches.

Static inputs need separate checks because an ELF dependency list misses embedded libraries and generated header code. Actual Launchpad build-info supplied 316 installed static/header inputs. These include glslang, SPIR-V Tools and headers, Vulkan headers, nv-codec headers, SIMDe, nlohmann-json, uthash, rav1e's actual Rust dev packages and two exact Rust standard-library source versions. The rav1e selection also retains test/build crates. librsvg's exact Debian archive includes its vendored Rust sources under `debian/missing-sources`.

`scripts/linux-source-inputs.py` compares selected packages with actual build-info versions, official publication/build identities and each source `.dsc`. It checked 855 unique static source archives. Notice extraction produced 3412 references to 1467 distinct full texts. All 17 referenced common-license texts match bytes in their owning official package.

The combined source input inventory contains 5374 files and 1.34 GB before the application archive. These checks ran against actual files. No source packet or public AppImage has passed the final release gate yet.

## Package evidence

`scripts/collect-linux-sources.py` finds an identical installed file, obtains its exact binary package/version and compares the staged bytes with an official `.deb` member. It checks that binary's `Source` field before collecting its source version. Package scripts never run.

The collector uses isolated apt directories and signed repository indexes. Historical versions can disappear from those indexes. The fallback captures the exact Launchpad publication and build, the build's `.changes` digests and the source publication's `.dsc`. TLS protects those metadata downloads. The fallback does not claim detached OpenPGP signature verification.

`--check` reopens actual `.deb` files and source archives. It checks control identities, binary member bytes, copyright owners, source hashes and staged ELF coverage. `--refresh-provenance` can rebind a rebuilt helper's metadata only after every upstream ELF passes those same checks. It cannot adopt changed upstream library bytes.

```sh
python3 scripts/collect-linux-sources.py \
  --stage .cache/linux-app/resources/recorder \
  --output work/linux-release-sources --check
python3 scripts/linux-source-inputs.py \
  --sources work/linux-release-sources
python3 scripts/collect-linux-sources.test.py
python3 scripts/package-linux-sources.test.py
```

Use `--no-update` for any further collection against the captured indexes. Existing downloads still need matching digests. Do not repeat the broad collector after a helper-only rebuild. Use the checked provenance refresh instead.

## Electron and the controlled CLI

The Electron collector captured its pinned Chromium FFmpeg and Opus source, generated Linux x64 configuration, build helpers, Electron patches and full licenses. It compared `libffmpeg.so` byte for byte with the checksum-verified official Electron44.7.0 ZIP on Windows and WSL.

The official ZIP SHA-256 is `3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a`. Its `libffmpeg.so` SHA-256 is `c4c805e46f957356f6b80be31999459e5f07e8b0c351221544ad43a16c980638`.

The separate controlled Linux CLI has four pinned source inputs, 30 build evidence files, full licenses, binary hashes and actual codec tests. See [linux-controlled-media.md](linux-controlled-media.md). `prepare-linux-cli-inputs.py` restores those inputs from a source packet without overwriting an existing platform manifest. The archived build recipe verifies source contents before compiling.

## Assemble a matching payload source packet

First freeze a clean application commit. Create the Linux snapshot from that exact Git archive and rebuild its native helper. Native provenance must record the actual helper SHA-256 and size, plus every compiled source fingerprint. The assembler compares those fingerprints with archived Git bytes, not a mutable working tree.

After the fresh helper build, run from the repository root in WSL:

```sh
python3 scripts/collect-linux-sources.py \
  --stage .cache/linux-app/resources/recorder \
  --output work/linux-release-sources --check --refresh-provenance
python3 scripts/linux-source-inputs.py \
  --sources work/linux-release-sources \
  --notices work/linux-release-notices
bun scripts/linux-source-kit.ts .cache/linux-app --stage-notices
bun scripts/linux-source-kit.ts .cache/linux-app
bun scripts/linux-source-kit.ts --check
bun scripts/package-linux-source-kit.ts
```

The notice command writes only the Linux snapshot's `resources/notices/ubuntu`. Run it before packaging the app. The source checker independently checks archive hashes, exact package/source identities, static inputs, Electron and CLI hashes, native source fingerprints and the full runtime notice inventory. `--inputs-only` checks and copies dependency evidence without pretending that application source is frozen.

The ZIP packager includes exactly the referenced files. Its verifier rejects altered bytes, omitted or unexpected members, links, duplicate paths and traversal. The ZIP companion records the application commit, source ZIP digest/size and staged inventory. Extract the ZIP into an empty directory to run offline checks. The application archive retains build scripts and the lockfile. `README.txt` in the packet describes restoration and rebuild commands.

## The remaining AppImage packaging gap

`verify-linux-payload.ts` passed 683 payload checks on the earlier private AppImage. It compared the compiled app.asar, staged recorder/media/notices, official Electron files and controlled CLI evidence. Altering a media license caused rejection. Those results establish the checked payload, not the entire AppImage container.

Electron-builder's legacy toolset adds six libraries outside that inventory, under `usr/lib`:

- `libappindicator.so.1`
- `libgconf-2.so.4`
- `libindicator.so.7`
- `libnotify.so.4`
- `libXss.so.1`
- `libXtst.so.6`

The actual private image contains all six. They come from `appimage-12.0.1.7z`, whose pinned SHA-256 is `d12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4`. Its exact packager tag points to commit `57839c6516289c0412c1b0887a6718d71e1ac5c2` in electron-userland/electron-builder-binaries. The launcher embeds squashfuse0.1.100 and liblzma5.2.3 according to its binary strings. This is a version observation, not proof of complete source correspondence.

The [AppImageKit runtime source](https://github.com/AppImage/AppImageKit/blob/master/src/runtime.c) has an MIT notice. Do not invent a GPL source requirement for that runtime. Its included code still needs the correct notices. The six injected Ubuntu libraries need actual byte/source/license proof, or packaging must stop including them. Choosing a newer toolset does not clear its contents automatically.

Before any public AppImage, complete that toolset review, capture full notices and account for every extra file. The final artifact check must freshly extract the actual AppImage, bind its container hash to the source ZIP companion, verify launcher bytes and `usr/lib`, rebuild the archived application and compare the resulting app.asar. An old ignored `out/` directory must not pass merely because Git is clean. Current source packet tooling intentionally covers the staged payload and does not claim this final AppImage check is complete.

## macOS follow-up

Actual Mac staging is available under `.cache/macos-ci-6c88cfd/resources/recorder`. It records official OBS32.2.2 DMG SHA-256 `920d6f26703d2df6e4085bd3c1cbed30488325084136c7a6e9e37021fbd6aaf7`, OBS commit `ba2f32bdf791005443988a4955e963663e16b1ed` and SIMDe commit `71fd833d9666141edcd1d3c109a80e228303d8d7`. `providerFiles` records actual copied Frameworks and PlugIns. Modified mux RPATH/signatures have separate staged hashes.

The Electron collector supports `platform: "darwin", arch: "arm64"`. Its actual official release/member comparison still needs a matching Mac Electron snapshot. Mac OBS dependency sources and CLI sources need their own exact closure. Windows and Linux packets do not clear a Mac binary.
