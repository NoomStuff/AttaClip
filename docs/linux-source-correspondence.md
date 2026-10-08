# Linux source correspondence

The Windows 0.1.0 release packet is immutable. Linux collection uses `work/linux-release-sources` and does not rewrite that packet.

## What the collector proves

`scripts/collect-linux-sources.py` scans staged recorder ELF files. It finds an identical installed file, obtains its binary package and exact version, and compares the staged bytes with the matching member of the official `.deb`. It checks the binary's `Source` field before collecting that exact source version.

The collector creates an isolated apt directory. Apt verifies the repository indexes using the existing Ubuntu and OBS PPA keys. It downloads the source `.dsc`, original archives and Debian patches with the index's SHA-256 digests. It does not edit system apt configuration or run package scripts and build recipes.

Older installed versions may have disappeared from current indexes. The fallback records the exact Launchpad publication and build. The build's `.changes` file provides the binary archive digest. The exact source publication provides its `.dsc`, whose hashes identify the source archives. TLS protects these historical metadata downloads. This fallback does not claim that it verified the uploader's detached OpenPGP signature.

Package copyright texts must match bytes inside an official package. Shared copyright texts, such as GCC's runtime exceptions, retain their owning package. Full referenced common license texts are also retained. `--check` reopens the actual `.deb` files, checks their control fields and member bytes, and verifies that every staged ELF has evidence. Missing or changed inputs fail the check.

From Ubuntu WSL, at the repository root:

```sh
python3 scripts/collect-linux-sources.py \
  --stage .cache/linux-app/resources/recorder \
  --output work/linux-release-sources
python3 scripts/collect-linux-sources.py \
  --stage .cache/linux-app/resources/recorder \
  --output work/linux-release-sources --check
PYTHONPYCACHEPREFIX=/tmp/attaclip-source-tests \
  python3 scripts/collect-linux-sources.test.py
```

Use `--no-update` to reuse the already captured signed apt indexes. Cached downloads still need matching digests. The manifest records collection failures. It does not authorize publication.

## Static inputs need their own evidence

An ELF dependency list omits embedded static libraries and header-generated code. The actual Ubuntu FFmpeg build enables glslang and includes Rust-based rav1e and librsvg. Their sources cannot be inferred from the current package catalog or minimum build dependency versions.

The collector captures actual Launchpad build-info for FFmpeg, librsvg, rav1e, libplacebo and OBS. `scripts/collect-linux-static-sources.py` selects exact versions from an actual build-info file and captures their published source inputs. It treats upstream archives as data.

The captured FFmpeg build-info identifies glslang 14.0.0-2, SPIR-V Tools 2023.6~rc1-2, Vulkan headers 1.3.275.0-1 and nv-codec-headers 12.1.14.0-1. All four source sets downloaded with matching archive hashes. That result does not finish the separate Rust crate review.

```sh
python3 scripts/collect-linux-static-sources.py \
  --output work/linux-release-sources \
  --buildinfo work/linux-release-sources/history/632ad7f2a509a602/binary.buildinfo \
  --packages 'glslang-dev|spirv-tools|libvulkan-dev|libffmpeg-nvenc-dev'
```

## Electron and the controlled CLI

`collectElectronFfmpeg` accepts `platform: "linux"` and writes a separate `evidence/electron-ffmpeg-linux` folder. It checks Electron's pinned Chromium and FFmpeg commits, captures the Linux x64 generated configuration, complete FFmpeg and Opus source, build helpers, Electron patches and full licenses. It compares `libffmpeg.so` byte for byte with the checksum-verified official Electron release ZIP.

The checked Electron 44.7.0 Linux x64 ZIP has SHA-256 `3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a`. Its `libffmpeg.so` has SHA-256 `c4c805e46f957356f6b80be31999459e5f07e8b0c351221544ad43a16c980638`. Collection passed on both Windows and Ubuntu WSL. GNU tar does not read ZIP files, so the Linux collector uses `unzip` for the official ZIP member.

The separate CLI already has four pinned source inputs, captured configuration, recipe, full licenses, binary hashes and actual codec tests. See [linux-controlled-media.md](linux-controlled-media.md). Ubuntu's broad FFmpeg libraries used by libOBS still require their own source closure.

## Before publishing an AppImage

Finish package collection and the static Rust/header review. Capture all runtime notices. Freeze the application source and rebuild the recorder with matching source fingerprints. Package only that checked runtime and the controlled CLI. Compare the actual AppImage payload with the recorded staging inventory, its compiled app.asar and the official Electron runtime. Publish the matching source packet alongside that exact artifact.

The current collection is underway. Linux binary publication remains blocked until those checks pass. Existing private AppImage playback and capture tests establish application behavior, not source correspondence.

`scripts/verify-linux-payload.ts` now compares extracted package files with the compiled app.asar, all staged recorder/media/notices, the staged Electron runtime and controlled media evidence. It handles electron-builder's Linux license rename. It passed 683 file checks against the private AppImage. An altered media license in that isolated extracted fixture caused rejection. Restoring the original bytes restored the passing result.

```sh
bun scripts/verify-linux-payload.ts \
  .cache/linux-app \
  .cache/linux-app/.cache/linux-packaged/415e7a26-5b4a-4c9b-b577-0f182c01479e/squashfs-root \
  work/linux-payload-proof.json
```

That command checks payload bytes. It does not bind a clean application commit or package a complete source ZIP. The final release gate still needs those checks and the actual AppImage archive hash.

For the ongoing Rust collection, the exact rav1e build-info is `history/beb65370f8304c33/binary.buildinfo`. The selected dev packages are all actual installed build inputs, including some test and build helpers. This deliberately captures more sources than the final embedded crate set. The final review must also check rav1e's Cargo features and Debian patches. librsvg's Debian archive contains its separate vendored Rust sources. Preserve that archive instead of replacing it with an upstream tag.

```sh
python3 scripts/collect-linux-static-sources.py \
  --output work/linux-release-sources \
  --buildinfo work/linux-release-sources/history/beb65370f8304c33/binary.buildinfo \
  --packages 'librust-.*-dev'
```

After these collectors finish, rerun package collection once with the current script. It includes the owning package for shared common-license texts and the corrected librsvg build-info lookup. Then run `--check`, review static closure and copy verified notices into Linux staging. Do not stage those notices into the Windows release resources. Both collectors reuse checksum-verified downloads.
